/** Pure helpers for <provider>/<model> route handling (no deps, shared by index.js and checks/). */

/**
 * Split one `<provider>/<model>` route. Provider names and model ids never
 * contain a slash, so the first slash is the separator.
 * @param {string} route
 * @returns {{ provider: string, model: string } | undefined} undefined on bad shape.
 */
export function parseModelRoute(route) {
  if (typeof route !== 'string') return undefined
  const separator = route.indexOf('/')
  if (separator <= 0 || separator === route.length - 1) return undefined
  const provider = route.slice(0, separator).trim()
  const model = route.slice(separator + 1).trim()
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Build the AgentOptions override for a parsed route.
 * @param {{ provider: string, model: string }} parsed
 * @param {string | undefined} reasoningEffort
 * @returns {{ provider: string, model: string, reasoningEffort?: string }}
 */
export function buildAgentOptions(parsed, reasoningEffort) {
  const options = { provider: parsed.provider, model: parsed.model }
  if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort
  return options
}

/**
 * Decide whether the roster's effective model honors the request.
 * @param {string | undefined} requestedModelId model id from the requested route.
 * @param {string | undefined} effectiveModelId roster-reported model id.
 * @returns {boolean} true when nothing was requested, or when they match.
 */
export function isRouteHonored(requestedModelId, effectiveModelId) {
  if (requestedModelId === undefined) return true
  return effectiveModelId === requestedModelId
}

/**
 * Compare two model selections with `model/selection` semantics: absent and
 * present `reasoningEffort` are different values (matches core `sameModelSelection`).
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null | undefined} a
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null | undefined} b
 * @returns {boolean} true when both name the identical selection.
 */
export function isSameSelection(a, b) {
	if (a === b) return true;
	if (a === null || a === undefined || b === null || b === undefined) return false;
	return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
}

/**
 * Render one selection for operator-facing text.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null | undefined} sel
 * @returns {string}
 */
export function selectionText(sel) {
	if (sel === null || sel === undefined) return "（无记录）";
	const route = `${sel.provider}/${sel.model}`;
	return sel.reasoningEffort === undefined ? route : `${route} @${sel.reasoningEffort}`;
}
