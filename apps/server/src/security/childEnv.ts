/**
 * The environment a spawned child is allowed to see.
 *
 * Every child this office starts — a `run_shell` command, a vendor harness, an
 * MCP server — used to inherit `process.env` wholesale. `config.ts` loads every
 * assignment in `.env` into `process.env` at boot (`config.ts:60-63`), so that
 * included `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 * `OPENROUTER_API_KEY` and the pooled-quality key. A one-line shell command, a
 * third-party agent harness, or a downloaded MCP server could therefore read the
 * operator's provider credentials out of its own environment and send them
 * anywhere — with no approval prompt that mentions it, because the prompt is
 * about the command, not about what the command can see.
 *
 * ## Why an editing pass and not an allow-list
 *
 * A strict allow-list is the stronger design and the wrong one here: these
 * children are real developer processes, and `PATH`, `HOME`, `TMPDIR`,
 * `SystemRoot`, proxy settings, language runtimes and toolchain variables all
 * matter to them. An allow-list would break working behaviour in ways nobody
 * would attribute to this file. So the environment is passed through **minus the
 * names known to be secret**, which is a narrow, auditable rule.
 *
 * ## What counts as a secret here, and what does not
 *
 * The line is **the variable's own name says credential**: a value that *is* a
 * credential (`AWS_ACCESS_KEY_ID`, `GH_TOKEN`, `MYSQL_PWD`) and also a name that ends
 * in a credential word whatever it holds (`GOOGLE_APPLICATION_CREDENTIALS` is a path,
 * `AZURE_CREDENTIALS` is a JSON blob, and a rule that tried to tell them apart would
 * be the kind that fails open). The indirections that stay are the ones with their own
 * names and no credential suffix: `KUBECONFIG`, `SSH_AUTH_SOCK`, `SSH_KEY_PATH`,
 * `GPG_KEY`, `PASSWORD_STORE_DIR`.
 *
 * That is not because those are harmless. It is because withholding the pointer while
 * the target stays readable is theatre: `run_shell` is unconfined, so a child that
 * wanted the file could read it directly. What it would buy is a broken `git push`
 * over the ssh agent, which is exactly the working behaviour this file exists not to
 * break.
 *
 * That also bounds what this file is for. For a third-party program — an MCP server,
 * a vendor harness — it is the difference between "your key is in its environment and
 * in whatever it logs or sends" and not. For `run_shell` it removes the *easy* path,
 * which matters more than it sounds: the model writes that command, and the approval
 * prompt describes the command rather than what the command can read.
 *
 * ## Why a registry rather than a pattern match
 *
 * Matching `*_KEY`/`*_TOKEN` by name is tempted, and it is both too broad
 * (breaking harmless variables) and too narrow (missing `DEV3D_LOCAL_API_KEY`
 * only if the pattern is wrong). The provider registry already knows exactly
 * which environment variable name holds each credential, so those names are
 * registered explicitly. A generic suffix sweep is added on top as a backstop,
 * because a plugin can name its own key variable and operators do keep
 * credentials in conventionally-named variables.
 */

/** Names known to hold a credential, registered by the config layer. */
const registeredSecretNames = new Set<string>();

/**
 * Suffixes that mark a variable as a credential.
 *
 * The rule is deliberately about *conventional credential spellings*, not about
 * the word "key": `_KEY` alone would swallow `SSH_KEY_PATH` and `GPG_KEY`, which are
 * useful to a build, while `_ACCESS_KEY` and `_KEY_ID` are the halves of an AWS-style
 * credential pair and were being passed through. `_TOKEN` and `_PASS` are included
 * for the same reason — `NPM_TOKEN`, `GH_TOKEN`, `MYSQL_PWD`'s cousins — and the cost
 * of being wrong in that direction is a build that says an environment variable is
 * missing rather than a key that quietly reaches a third-party process.
 */
const SECRET_SUFFIXES = [
  '_API_KEY',
  '_ACCESS_KEY',
  '_ACCESS_KEY_ID',
  '_KEY_ID',
  '_SECRET_KEY',
  '_PRIVATE_KEY',
  '_ACCESS_TOKEN',
  '_AUTH_TOKEN',
  '_SESSION_TOKEN',
  '_TOKEN',
  '_SECRET',
  '_CREDENTIALS',
  '_PASSWORD',
  '_PASSWD',
  '_PASS',
];

/**
 * Credentials whose names carry no separator to match on.
 *
 * `PGPASSWORD` and `MYSQL_PWD` are the two conventional ones; the AWS pair is
 * spelled out because it is the single most valuable credential a developer machine
 * holds and it matches no suffix rule by accident of word order.
 */
const SECRET_EXACT = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'PGPASSWORD',
  'MYSQL_PWD',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'CI_JOB_TOKEN',
]);

function looksSecret(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_EXACT.has(upper)) return true;
  return SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/**
 * Declare an environment variable name as a credential.
 *
 * Called by the config layer for every provider's `keyEnvVar` and for the
 * pooled-quality key. Idempotent, so a provider rebuild can call it freely.
 */
export function registerSecretEnvName(name: string): void {
  const trimmed = name.trim();
  if (trimmed !== '') registeredSecretNames.add(trimmed);
  // The environment is case-insensitive on Windows and case-sensitive
  // elsewhere, so both spellings are recorded and both are removed.
  if (trimmed !== '') registeredSecretNames.add(trimmed.toUpperCase());
}

/** The names currently withheld from children. Exposed for the console and tests. */
export function secretEnvNames(): string[] {
  const names = new Set<string>(registeredSecretNames);
  for (const name of Object.keys(process.env)) {
    if (looksSecret(name)) names.add(name);
  }
  return [...names].sort();
}

/**
 * The environment to hand a child process: the parent's, minus credentials.
 *
 * Returns a fresh object, so a caller cannot mutate `process.env` through it.
 */
export function childEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const withheld = new Set(secretEnvNames().map((n) => n.toUpperCase()));
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (withheld.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      // `extra` cannot resurrect a credential: it is a convenience for passing
      // vendor- or server-specific settings, not a way around the filter. A
      // caller that genuinely must hand a secret to one program should do it in
      // that program's own configuration, where it is visible.
      if (withheld.has(name.toUpperCase())) continue;
      out[name] = value;
    }
  }
  return out;
}

/**
 * Whether a name would be withheld. Used by the UI to explain why a command
 * cannot see a key, and by tests.
 */
export function isSecretEnvName(name: string): boolean {
  return looksSecret(name) || registeredSecretNames.has(name) || registeredSecretNames.has(name.toUpperCase());
}

/** Test seam: forget everything registered so far. */
export function resetRegisteredSecretEnvNames(): void {
  registeredSecretNames.clear();
}
