/** Offline checks for the activation patch (no host needed).
 *
 * Run: node checks/activation-patch-check.mjs
 */

import assert from 'node:assert/strict'
import { installActivationPatch, routeFromPrompt, routeMarker } from '../lib/activation-patch.js'

class FakeRuntime {
  constructor() {
    this.calls = []
  }

  async startActivation(spec) {
    this.calls.push(spec)
    return { messageId: 'm1' }
  }
}

const route = { provider: 'qoder', model: 'qfmodel' }
const promptFor = (marker = '') => [
  { type: 'text', text: `<system-reminder>\nYou are teammate "probe".\n</system-reminder>\n${marker}\n` },
  { type: 'text', text: 'do the thing' },
]

// 1. marker round-trip
assert.equal(routeMarker(undefined), '')
assert.deepEqual(routeFromPrompt(promptFor(routeMarker(route))), route)
assert.equal(routeFromPrompt(promptFor('')), undefined)
assert.equal(routeFromPrompt(undefined), undefined)
assert.equal(routeFromPrompt([{ type: 'text', text: '<!--dsh-team-model:route:{bad json}-->' }]), undefined)
assert.equal(routeFromPrompt([{ type: 'text', text: '<!--dsh-team-model:route:{"model":"x"}-->' }]), undefined)

// 2. reference-counted install: two generations, one wrapper, last release restores
{
  const runtime = new FakeRuntime()
  const ctx = { subagents: runtime }
  const native = runtime.startActivation

  const first = installActivationPatch(ctx)
  assert.equal(first.applied, true)
  assert.equal(first.layer, 'instance')
  assert.equal(runtime.startActivation.__teamModelPatch, true)
  assert.equal(runtime.startActivation.__teamModelRefs, 1)

  const second = installActivationPatch(ctx)
  assert.equal(second.applied, true)
  assert.equal(runtime.startActivation.__teamModelRefs, 2, 'second generation adds a reference')

  // native/unmarked call passes through with no agentOptions
  await runtime.startActivation({
    delivery: 'parent',
    provider: 'spawn',
    label: 'native',
    request: { prompt: [{ type: 'text', text: 'native prompt' }], parent: {} },
  })
  assert.equal(runtime.calls.at(-1).request.agentOptions, undefined)

  // marked route reaches the request
  await runtime.startActivation({
    delivery: 'parent',
    provider: 'spawn',
    label: 'probe',
    request: { prompt: promptFor(routeMarker(route)), parent: {} },
  })
  assert.deepEqual(runtime.calls.at(-1).request.agentOptions, route)

  // incapable provider is never touched
  await runtime.startActivation({
    delivery: 'parent',
    provider: 'acp',
    label: 'probe-acp',
    request: { prompt: promptFor(routeMarker(route)), parent: {} },
  })
  assert.equal(runtime.calls.at(-1).request.agentOptions, undefined)

  // a generation disposing early must not remove the wrapper the next one uses
  first.dispose()
  assert.equal(runtime.startActivation.__teamModelPatch, true, 'wrapper survives a partial release')
  await runtime.startActivation({
    delivery: 'parent',
    provider: 'spawn',
    request: { prompt: promptFor(routeMarker(route)), parent: {} },
  })
  assert.deepEqual(runtime.calls.at(-1).request.agentOptions, route)

  second.dispose()
  assert.equal(runtime.startActivation, native, 'last release restores the native method')
}

// 3. frozen instance falls back to the prototype surface
{
  class FrozenRuntime {
    async startActivation(spec) {
      return { spec }
    }
  }
  const runtime = new FrozenRuntime()
  Object.freeze(runtime)
  const ctx = { subagents: runtime }
  const patch = installActivationPatch(ctx)
  assert.equal(patch.applied, true)
  assert.equal(patch.layer, 'prototype')
  const result = await runtime.startActivation({
    delivery: 'parent',
    provider: 'spawn',
    request: { prompt: promptFor(routeMarker({ provider: 'company', model: 'deepseek-v4.1-flash' })), parent: {} },
  })
  assert.deepEqual(result.spec.request.agentOptions, { provider: 'company', model: 'deepseek-v4.1-flash' })
  patch.dispose()
  const after = await runtime.startActivation({
    delivery: 'parent',
    provider: 'spawn',
    request: { prompt: promptFor(routeMarker(route)), parent: {} },
  })
  assert.equal(after.spec.request.agentOptions, undefined, 'prototype restored after release')
}

console.log('activation-patch checks passed')
