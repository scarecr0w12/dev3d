/**
 * Which link targets are safe to render.
 *
 * The renderer's entire input is untrusted model output — transcripts, artifact
 * bodies, stage summaries — and a link is the one place that text becomes a
 * clickable navigation target. The markdown tokenizer accepts any run of
 * non-parenthesis, non-whitespace characters as a URL, so `javascript:` reached
 * `<a href>` unchecked, and there is no CSP to catch it.
 *
 * An **allow-list**, not a deny-list: an unknown scheme fails closed, because a
 * deny-list only ever covers the attacks somebody thought of. Everything else in
 * the renderer is safe by construction (React elements, no
 * `dangerouslySetInnerHTML`), which makes this the single hole rather than one of
 * many.
 *
 * Lives outside `markdown.tsx` so the verification harness can import it — Node
 * strips types but cannot parse `.tsx`.
 */

/** A link target that is safe to put in an `href`, or null when it is not a link. */
export function safeHref(href: string): string | null {
  // A control character inside a scheme — `java\nscript:` — is a real evasion, and
  // trimming only the ends would leave it intact.
  // eslint-disable-next-line no-control-regex
  const trimmed = href.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (trimmed === '') return null;
  // A relative path, an in-page anchor, or a protocol-relative URL: nothing to
  // execute.
  if (/^[/#]/.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:[^\s]+@/i.test(trimmed)) return trimmed;
  return null;
}
