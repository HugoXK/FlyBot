import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDigest, formatCount, formatMs } from '../src/digest.js'

const make = (extra = {}) => ({
  version: 1, now: 100_000, from: 0, to: 100_000, windowMs: 100_000, live: true,
  lanes: [{ id: 'user', kind: 'user', name: 'You' }, { id: 'a', kind: 'bot', name: 'Chief', main: true }, { id: 'b', kind: 'bot', name: 'Writer' }],
  utilization: [
    { lane: 'a', windowMs: 100_000, busyMs: 62_000, turns: 4, errors: 1, running: false },
    { lane: 'b', windowMs: 100_000, busyMs: 0, turns: 0, errors: 0, running: false },
  ],
  usage: [{ lane: 'a', calls: 4, input: 12_345, output: 1_234, cacheRead: 8_000, cacheWrite: 0 }],
  toolUse: [{ lane: 'a', tools: [{ name: 'web_search', calls: 6, failed: 1 }, { name: 'read', calls: 2, failed: 0 }] }],
  edges: [{ from: 'b', to: 'a', unanswered: 1 }],
  exchanges: [{ id: 'x9', from: 'b', to: 'a', waiting: true, t: 100_000 - 720_000 }],
  ...extra,
})

test('formatCount and formatMs read at a glance', () => {
  assert.equal(formatCount(840), '840')
  assert.equal(formatCount(12_345), '12.3k')
  assert.equal(formatCount(1_234_567), '1.2M')
  assert.equal(formatMs(40_000), '40s')
  assert.equal(formatMs(720_000), '12m')
  assert.equal(formatMs(3_900_000), '1h05m')
  assert.equal(formatMs(undefined), '0s')
})

test('buildDigest: per-Bot sections, the team rollup and the longest wait', () => {
  const digest = buildDigest(make(), { now: 100_000 })
  assert.equal(digest.bots[0].name, 'Chief')
  assert.equal(digest.bots[0].main, true)
  assert.equal(digest.bots[0].turns, 4)
  assert.equal(digest.bots[0].waiting, 0)
  assert.equal(digest.bots[1].waiting, 1)
  assert.deepEqual(digest.bots[0].tools.map(tool => tool.name), ['web_search', 'read'])
  assert.equal(digest.team.turns, 4)
  assert.equal(digest.team.errors, 1)
  assert.equal(digest.team.tokens.input, 12_345)
  assert.deepEqual(digest.team.longestWait, { id: 'x9', from: 'b', to: 'a', waitedMs: 720_000 })
  assert.match(digest.markdown, /^# Team report\nWindow: 00:00–00:01 · live/)
  assert.match(digest.markdown, /## Chief \(main\)\n- 4 turns, 1 failed \(25%\)/)
  assert.match(digest.markdown, /- busy 62% of the window/)
  assert.match(digest.markdown, /- tokens: 12.3k in \/ 1.2k out \/ 8.0k cached/)
  assert.match(digest.markdown, /- 1 request\(s\) unanswered/)
  assert.match(digest.markdown, /- tools: web_search ×6 \(1 failed\), read ×2/)
  assert.match(digest.markdown, /## Writer\n- no turns in the window/)
  assert.match(digest.markdown, /## Team\n- 4 turns, 1 failed/)
  assert.match(digest.markdown, /- longest wait: b → a, 12m/)
  assert.match(digest.line, /4 turns, 1 failed, 12.3k tokens in over 00:00–00:01\./)
})

test('buildDigest: a window without the newer fields still builds', () => {
  const digest = buildDigest(make({ toolUse: undefined, stuck: undefined, exchanges: [] }), { now: 100_000 })
  assert.doesNotMatch(digest.markdown, /tools:/)
  assert.doesNotMatch(digest.markdown, /longest wait/)
  assert.equal(digest.team.longestWait, null)
})

test('buildDigest: an empty window is a short honest report', () => {
  const digest = buildDigest({})
  assert.equal(digest.bots.length, 0)
  assert.match(digest.markdown, /No activity in the window\./)
  assert.match(digest.line, /No Bot activity/)
})

test('buildDigest: a Bot that fails most turns is named as needing a look', () => {
  const digest = buildDigest(make({ utilization: [{ lane: 'a', windowMs: 100_000, busyMs: 1000, turns: 4, errors: 3, running: false }] }), { now: 100_000 })
  assert.deepEqual(digest.team.unhealthy, ['a'])
  assert.match(digest.markdown, /- needs a look: a/)
  assert.match(digest.markdown, /- look: 3 of 4 turns failed/)
})
