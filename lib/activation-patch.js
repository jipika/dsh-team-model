/** Patch layer: forward the per-teammate AgentOptions that the roster drops.
 *
 * The official `agent-team` roster calls
 *   ctx.subagents.startActivation({ delivery, childId, provider, label, request: { prompt, parent }, signal })
 * and never forwards `agentOptions`, so `resolveChildAgentOptions(parent, undefined, depth)`
 * inherits the Lead route. This module wraps the live service method and injects the
 * route carried inside the spawned prompt.
 *
 * Why the route travels in the prompt: HMR re-creates this module (and every closure
 * state it owns) on reload, while the wrapper installed on the host service may
 * outlive the module generation. The prompt is the one thing that travels from the
 * tool call into `startActivation` unchanged, so it is the reliable carrier.
 *
 * Why this works without touching `app.asar`:
 *  - `roster.ts:264` calls `this.ctx.subagents.startActivation(...)`: a property lookup on
 *    the live service instance, not a captured reference, so an instance-level wrapper runs.
 *  - `manager.ts:390` reads `request.agentOptions`: putting it on the request is enough.
 *  - the `spawn` / `fork` in-process providers both declare `capabilities.agentOptions: true`,
 *    so `assertCapabilities` accepts the override instead of rejecting it.
 *
 * Safety: only teammate prompts this plugin wrote carry the marker, and only the
 * in-process delegation providers honour `agentOptions`. Every other call -- native
 * spawns, one-shot subagents, out-of-process backends -- is forwarded untouched.
 */

/** Route marker written into the first prompt block of a teammate. */
const ROUTE_MARKER = /<!--dsh-team-model:route:(\{[\s\S]*?\})-->/

/** Providers whose `capabilities.agentOptions` is true (in-process delegation). */
const ROUTE_CAPABLE_PROVIDERS = new Set(['spawn', 'fork'])

/** Wrapper contract version: a stale generation's wrapper must be replaced. */
const PATCH_VERSION = 2

/**
 * Serialize one route override into the prompt marker.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} agentOptions
 * @returns {string} marker text, or an empty string when there is no route.
 */
export function routeMarker(agentOptions) {
  if (agentOptions === undefined) return ''
  return `<!--dsh-team-model:route:${JSON.stringify(agentOptions)}-->`
}

/**
 * Read the route marker back out of the prompt our tool assembled.
 * @param {unknown} prompt - ContentBlock[] handed to startActivation.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function routeFromPrompt(prompt) {
  if (!Array.isArray(prompt)) return undefined
  for (const block of prompt) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const match = ROUTE_MARKER.exec(block.text)
    if (match === null) continue
    try {
      const parsed = JSON.parse(match[1])
      if (typeof parsed?.provider !== 'string' || typeof parsed?.model !== 'string') return undefined
      return parsed
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Wrap `ctx.subagents.startActivation` so a marked teammate route reaches the
 * child agent. Every other call is forwarded untouched.
 *
 * Install/dispose are reference counted: HMR may apply the next generation before
 * disposing the previous one, and the previous dispose must not remove the wrapper
 * the next generation is already using.
 * @param {any} ctx - plugin context with `subagents` injected.
 * @returns {{ dispose: () => void, applied: boolean, layer: string }} teardown,
 *   whether the live instance accepted the override, and which surface was used.
 */
export function installActivationPatch(ctx) {
  const runtime = ctx.subagents
  const notApplied = { dispose: () => {}, applied: false, layer: 'none' }
  if (runtime === undefined || runtime === null) return notApplied
  const current = runtime.startActivation
  if (typeof current !== 'function') return notApplied

  // Reuse the wrapper already installed by the SAME generation (HMR double-apply).
  // A wrapper from an older generation carries a different contract and is replaced.
  if (current.__teamModelPatch === true && current.__teamModelVersion === PATCH_VERSION) {
    current.__teamModelRefs = (current.__teamModelRefs ?? 1) + 1
    return {
      applied: true,
      layer: current.__teamModelLayer ?? 'instance',
      dispose: () => release(current),
    }
  }

  /** Shared wrapper body: inject only for capable providers with a marked route. */
  const dispatch = async function dispatchWithRoute(original, self, spec) {
    const capable = ROUTE_CAPABLE_PROVIDERS.has(spec?.provider)
    const agentOptions = capable ? routeFromPrompt(spec?.request?.prompt) : undefined
    if (agentOptions === undefined) return original.call(self, spec)
    return original.call(self, {
      ...spec,
      request: { ...spec.request, agentOptions },
    })
  }

  const original = current
  const patched = async function startActivationWithRoute(spec) {
    return dispatch.call(runtime, original, this ?? runtime, spec)
  }
  patched.__teamModelPatch = true
  patched.__teamModelVersion = PATCH_VERSION
  patched.__teamModelLayer = 'instance'
  patched.__teamModelRefs = 1
  patched.__teamModelOriginal = original
  patched.__teamModelOwner = runtime
  patched.__teamModelRelease = () => release(patched)

  try {
    runtime.startActivation = patched
    if (runtime.startActivation === patched) {
      return { dispose: () => release(patched), applied: true, layer: 'instance' }
    }
  } catch {
    // fall through to the prototype surface
  }

  // Fallback: a frozen or non-writable instance is bypassed at the prototype level.
  const proto = Object.getPrototypeOf(runtime)
  if (proto === null || typeof proto.startActivation !== 'function') return notApplied
  const protoCurrent = proto.startActivation
  if (protoCurrent.__teamModelPatch === true) {
    protoCurrent.__teamModelRefs = (protoCurrent.__teamModelRefs ?? 1) + 1
    return { applied: true, layer: 'prototype', dispose: () => release(protoCurrent) }
  }
  const protoOriginal = protoCurrent
  const protoPatched = async function startActivationWithRoute(spec) {
    return dispatch.call(runtime, protoOriginal, this ?? runtime, spec)
  }
  protoPatched.__teamModelPatch = true
  protoPatched.__teamModelVersion = PATCH_VERSION
  protoPatched.__teamModelLayer = 'prototype'
  protoPatched.__teamModelRefs = 1
  protoPatched.__teamModelOriginal = protoOriginal
  protoPatched.__teamModelOwner = proto
  try {
    proto.startActivation = protoPatched
    if (proto.startActivation === protoPatched) {
      return { dispose: () => release(protoPatched), applied: true, layer: 'prototype' }
    }
  } catch {
    // restore the instance surface we may have already touched
    if (runtime.startActivation === patched) runtime.startActivation = original
  }
  return notApplied
}

/**
 * Make sure the live service still carries the wrapper. HMR can apply the next
 * generation before disposing the previous one, and a previous dispose then
 * removes the wrapper the next generation is already using; re-checking right
 * before a spawn keeps that race from silently downgrading a route.
 * @param {any} ctx - plugin context with `subagents` injected.
 * @returns {boolean} whether the wrapper is installed now.
 */
export function ensureActivationPatch(ctx) {
  const runtime = ctx.subagents
  const current = runtime?.startActivation
  if (current?.__teamModelPatch === true && current.__teamModelVersion === PATCH_VERSION) return true
  return installActivationPatch(ctx).applied
}

/**
 * Drop one reference to a wrapper; the last holder restores the original method.
 * @param {any} wrapper - installed wrapper carrying its own bookkeeping.
 */
function release(wrapper) {
  if (wrapper.__teamModelPatch !== true) return
  wrapper.__teamModelRefs = (wrapper.__teamModelRefs ?? 1) - 1
  if (wrapper.__teamModelRefs > 0) return
  const owner = wrapper.__teamModelOwner
  if (owner !== undefined && owner.startActivation === wrapper) {
    owner.startActivation = wrapper.__teamModelOriginal
  }
  wrapper.__teamModelPatch = false
}
