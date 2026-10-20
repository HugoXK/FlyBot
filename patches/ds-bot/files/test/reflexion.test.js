import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReflexionTracker, lessonText } from '../src/host/reflexion.js'

test('the tracker notes a signature at the threshold, then stays quiet for the cooldown', () => {
  let now = 0
  const tracker = createReflexionTracker({ now: () => now, threshold: 3, windowMs: 1_000, cooldownMs: 5_000 })
  const hit = () => tracker.hit('b', 'tool:bash')
  assert.deepEqual([hit(), hit(), hit()], [false, false, true])
  assert.equal(hit(), false, 'a note is not repeated inside the cooldown')
  now = 6_000
  assert.deepEqual([hit(), hit(), hit()], [false, false, true], 'a fresh burst after the cooldown notes again')
})

test('failures spread beyond the window do not accumulate', () => {
  let now = 0
  const tracker = createReflexionTracker({ now: () => now, threshold: 2, windowMs: 100, cooldownMs: 10_000 })
  assert.equal(tracker.hit('b', 'tool:y'), false)
  now = 200
  assert.equal(tracker.hit('b', 'tool:y'), false, 'the first failure fell out of the window')
  now = 250
  assert.equal(tracker.hit('b', 'tool:y'), true)
})

test('empty ids or signatures are ignored, and Bots are tracked apart', () => {
  const tracker = createReflexionTracker({ threshold: 2 })
  assert.equal(tracker.hit('', 'tool:x'), false)
  assert.equal(tracker.hit('b', ''), false)
  assert.equal(tracker.hit('b', 'tool:x'), false)
  assert.equal(tracker.hit('b', 'tool:x'), true)
  assert.equal(tracker.hit('c', 'tool:x'), false, 'another Bot starts its own count')
})

test('lessonText words a known signature and ignores an unknown one', () => {
  assert.match(lessonText('tool:bash'), /The tool "bash" has failed several times/)
  assert.match(lessonText('model:RATE_LIMIT'), /A model call has failed repeatedly \(RATE_LIMIT\)/)
  assert.equal(lessonText('tool:'), undefined)
  assert.equal(lessonText('something:x'), undefined)
})
