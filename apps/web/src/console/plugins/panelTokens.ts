/**
 * A plugin panel's requested colours, turned into CSS custom properties.
 *
 * The host already validated both the names and the values of a token before it
 * ever reached the socket — but this code re-checks the *names*, and that is not
 * belt-and-braces for its own sake. `tokens` arrives in a socket payload, and a
 * property name that reached `style` unvetted (`--x: url(...)`, a property that
 * overrides a console variable, an `onerror`-shaped name) would be a style
 * injection primitive running in every operator's console. The allow-list here
 * is the console's own, not the host's, so the two have to agree on purpose
 * rather than by convention.
 *
 * It lives in a `.ts` module rather than inside `PluginPanels.tsx` for one
 * practical reason: the verify harness runs under plain `node` and cannot import
 * a `.tsx` file, so anything worth pinning with a regression test has to be
 * importable without JSX.
 */

/** The tokens the console paints with, and the property each one sets. */
export const PANEL_TOKEN_PROPERTIES = {
  accent: '--plugin-panel-accent',
  surface: '--plugin-panel-surface',
  text: '--plugin-panel-text',
} as const;

export type PanelTokenName = keyof typeof PANEL_TOKEN_PROPERTIES;

/**
 * The custom properties for one panel, or `undefined` when it asked for none —
 * so an untokened panel gets no `style` attribute at all rather than an empty one.
 */
export function panelTokenStyle(
  tokens: Partial<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (tokens === undefined) return undefined;
  const style: Record<string, string> = {};
  for (const [name, property] of Object.entries(PANEL_TOKEN_PROPERTIES)) {
    const value = tokens[name];
    // A socket payload is not the host's manifest: only a non-empty string is
    // written, and the property name comes from the table above, never from the
    // payload's own keys.
    if (typeof value === 'string' && value !== '') style[property] = value;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}
