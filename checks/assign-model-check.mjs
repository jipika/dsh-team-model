/** Offline checks for lib/route.js selection helpers (no Host needed). */
import { isSameSelection, selectionText } from '../lib/route.js'

let failures = 0
function check(label, actual, expected) {
	const ok = actual === expected
	if (!ok) {
		failures += 1
		console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
	} else {
		console.log(`ok ${label}`)
	}
}

check('identical same', isSameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }), true)
check('same ref same', isSameSelection(Object.freeze({ provider: 'p', model: 'm' }), Object.freeze({ provider: 'p', model: 'm' })), true)
check('effort differs', isSameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }), false)
check('effort both same', isSameSelection({ provider: 'p', model: 'm', reasoningEffort: 'low' }, { provider: 'p', model: 'm', reasoningEffort: 'low' }), true)
check('effort differs value', isSameSelection({ provider: 'p', model: 'm', reasoningEffort: 'low' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }), false)
check('model differs', isSameSelection({ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }), false)
check('provider differs', isSameSelection({ provider: 'p1', model: 'm' }, { provider: 'p2', model: 'm' }), false)
check('null vs sel', isSameSelection(null, { provider: 'p', model: 'm' }), false)
check('undefined vs sel', isSameSelection(undefined, { provider: 'p', model: 'm' }), false)
check('null vs null', isSameSelection(null, null), true)

check('text none', selectionText(undefined), '（无记录）')
check('text null', selectionText(null), '（无记录）')
check('text route', selectionText({ provider: 'p', model: 'm' }), 'p/m')
check('text effort', selectionText({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m @high')

if (failures > 0) {
	console.error(`${failures} check(s) failed`)
	process.exit(1)
}
console.log('all selection checks passed')
