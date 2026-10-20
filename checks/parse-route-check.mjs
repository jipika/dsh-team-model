/** Offline checks for lib/route.js (no Host needed): `node checks/parse-route-check.mjs`. */
import { parseModelRoute, buildAgentOptions, isRouteHonored } from '../lib/route.js'

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  } else {
    console.log(`ok ${label}`)
  }
}

check('basic route', parseModelRoute('openrouter/grok-4'), { provider: 'openrouter', model: 'grok-4' })
check('model with dots', parseModelRoute('deepseek/deepseek-chat-v3.1'), { provider: 'deepseek', model: 'deepseek-chat-v3.1' })
check('missing slash', parseModelRoute('grok-4'), undefined)
check('leading slash', parseModelRoute('/grok-4'), undefined)
check('trailing slash', parseModelRoute('openrouter/'), undefined)
check('empty', parseModelRoute(''), undefined)
check('non-string', parseModelRoute(undefined), undefined)
check('trims spaces', parseModelRoute('  openrouter / grok-4  '), { provider: 'openrouter', model: 'grok-4' })

check('options without effort', buildAgentOptions({ provider: 'p', model: 'm' }, undefined), { provider: 'p', model: 'm' })
check('options with effort', buildAgentOptions({ provider: 'p', model: 'm' }, 'high'), { provider: 'p', model: 'm', reasoningEffort: 'high' })

check('inherit honors', isRouteHonored(undefined, undefined), true)
check('inherit honors 2', isRouteHonored(undefined, 'lead-model'), true)
check('match honors', isRouteHonored('m', 'm'), true)
check('mismatch refuses', isRouteHonored('m-wanted', 'm-lead'), false)
check('missing effective refuses', isRouteHonored('m-wanted', undefined), false)

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all route checks passed')
