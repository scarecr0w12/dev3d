/**
 * Screenshot the console in a *specific* UI state.
 *
 * `screenshot.ps1` captures the default view, which is enough for a first look
 * and useless for the part that matters: the inspector's other tabs, a resized
 * pane, or an overlay only reachable by a click. This drives headless Chrome
 * over the DevTools protocol, clicks what it is told to click, and then captures
 * the frame — so a layout claim can be checked instead of asserted.
 *
 * It launches its own Chrome rather than attaching to one, because the app
 * remembers its tab in localStorage and a fresh profile is what makes the
 * starting state deterministic.
 *
 * Usage:
 *   node scripts/shoot-state.mjs --out .screenshots/run-tab.png --script "click:Run"
 *   node scripts/shoot-state.mjs --out .screenshots/wide.png \
 *     --script "drag:left:260|click:Run"
 *
 * Steps are separated by `|` (see the note on step parsing below).
 *
 * Steps:
 *   click:<label>          click the first button whose text matches
 *   sel:<css selector>     click the first element matching a CSS selector
 *   type:<selector>:<text> set a field's value the way React will notice
 *   eval:<expression>      run an expression in the page
 *   drag:left:<pixels>     drag the inspector's inner edge left by N px
 *   wait:<milliseconds>    pause
 */

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);

function option(name, fallback) {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const values = [];
  for (let i = at + 1; i < args.length && !args[i].startsWith('--'); i += 1) values.push(args[i]);
  return values.length === 0 ? fallback : values.length === 1 ? values[0] : values;
}

const url = option('url', 'http://127.0.0.1:8787/');
const out = resolve(option('out', '.screenshots/state.png'));
const width = Number(option('width', '1600'));
const height = Number(option('height', '1000'));
const port = Number(option('port', '9333'));
const settleMs = Number(option('settle', '12000'));
const rawScript = String(option('script', ''));
// Steps are separated by `|` rather than by repeating --script. A quoted
// argument containing a colon loses its quotes on the way through a native
// Windows command line, so repetition cannot be distinguished from one step
// that happens to have a space in it.
const steps = rawScript.split('|').map((step) => step.trim()).filter((step) => step.length > 0);

const candidates = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
];
const chrome = candidates.find((path) => path && existsSync(path));
if (!chrome) throw new Error('No Chrome or Edge found.');

const profile = `${process.env.TEMP}\\dsh-shoot-${Math.random().toString(16).slice(2, 10)}`;

const child = spawn(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** Polls the DevTools endpoint until Chrome is listening. */
async function endpoint() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome never opened its debugging port.');
}

let nextId = 0;
const pending = new Map();

function send(socket, method, params = {}, sessionId) {
  nextId += 1;
  const id = nextId;
  socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function main() {
  const browserUrl = await endpoint();
  const socket = new WebSocket(browserUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  /** Console errors and uncaught exceptions, so a screenshot can prove silence. */
  const problems = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    // Notifications: no id. Only the ones that indicate a real fault.
    if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params?.exceptionDetails;
      problems.push(`uncaught: ${d?.exception?.description ?? d?.text ?? 'unknown'}`.split('\n')[0]);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args ?? [])
        .map((a) => a.value ?? a.description ?? '')
        .join(' ')
        .split('\n')[0];
      if (text.length > 0) problems.push(`console.error: ${text}`);
    }
  });

  const { targetId } = await send(socket, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(socket, 'Target.attachToTarget', { targetId, flatten: true });

  await send(socket, 'Page.enable', {}, sessionId);
  await send(socket, 'Runtime.enable', {}, sessionId);
  await send(socket, 'Log.enable', {}, sessionId);
  await send(socket, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send(socket, 'Page.navigate', { url }, sessionId);

  // A fixed settle rather than a load event: the inspector's state arrives over
  // a websocket after the document is already complete.
  await sleep(settleMs);

  for (const step of steps) {
    const [kind, ...rest] = String(step).split(':');
    if (kind === 'wait') {
      await sleep(Number(rest[0] ?? 500));
      continue;
    }

    let expression;
    if (kind === 'click') {
      const label = rest.join(':');
      expression = `(() => {
        const wanted = ${JSON.stringify(label)};
        const buttons = [...document.querySelectorAll('button')];
        const hit = buttons.find((b) => (b.textContent || '').trim() === wanted)
          || buttons.find((b) => (b.textContent || '').trim().startsWith(wanted));
        if (!hit) return 'no button: ' + wanted;
        hit.click();
        return 'clicked ' + wanted;
      })()`;
    } else if (kind === 'sel') {
      const selector = rest.join(':');
      expression = `(() => {
        const hit = document.querySelector(${JSON.stringify(selector)});
        if (!hit) return 'no element: ' + ${JSON.stringify(selector)};
        hit.click();
        return 'clicked ' + ${JSON.stringify(selector)};
      })()`;
    } else if (kind === 'drag') {
      const [edge, distance] = rest;
      expression = `(() => {
        const pane = document.querySelector('.popout-inspector');
        if (!pane) return 'no inspector';
        const handle = pane.querySelector(${JSON.stringify(edge === 'bottom' ? '.pane-handle-bottom' : '.pane-handle-left')});
        if (!handle) return 'no handle';
        const box = handle.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const opts = (cx, cy) => ({ bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
        handle.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
        const dx = ${edge === 'bottom' ? 0 : -Number(distance)};
        const dy = ${edge === 'bottom' ? Number(distance) : 0};
        window.dispatchEvent(new PointerEvent('pointermove', opts(x + dx, y + dy)));
        window.dispatchEvent(new PointerEvent('pointerup', opts(x + dx, y + dy)));
        return 'dragged ' + ${JSON.stringify(edge)};
      })()`;
    } else if (kind === 'type') {
      // `type:<css selector>:<text>` — sets the value through React's own
      // setter, because assigning `.value` directly does not notify React and
      // the state would never change.
      const selector = rest[0] ?? '';
      const text = rest.slice(1).join(':');
      expression = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'no element: ' + ${JSON.stringify(selector)};
        // Each control type carries its own value setter on its own prototype;
        // using the wrong one throws "Illegal invocation" rather than no-opping.
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        descriptor.set.call(el, ${JSON.stringify(text)});
        // React listens for a change event on a select and input on a text field.
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        return 'typed ' + ${JSON.stringify(text.length)} + ' chars into ' + ${JSON.stringify(selector)};
      })()`;
    } else if (kind === 'eval') {
      // Wrapped in a block so several eval steps can declare the same helper
      // names without colliding in the page's global scope.
      expression = `{ ${rest.join(':')} }`;
    } else {
      continue;
    }

    const result = await send(
      socket,
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    const value = result?.result?.value ?? result?.result?.description ?? '';
    console.log(`  ${kind}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    await sleep(Number(option('step-wait', '350')));
  }

  await sleep(400);

  const shot = await send(socket, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${out}`);

  // A screenshot cannot show a console error, and an audit that only looks at
  // pixels will happily pass a page that threw on the way to rendering.
  if (problems.length === 0) {
    console.log('console: clean (no errors, no uncaught exceptions)');
  } else {
    console.log(`console: ${problems.length} problem(s)`);
    for (const line of [...new Set(problems)]) console.log(`  ! ${line}`);
  }

  socket.close();
  child.kill();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    child.kill();
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => child.kill(), 200);
  });
