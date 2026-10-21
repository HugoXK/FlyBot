import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAlertTracker } from '../src/alerts.js'

const win = (utilization, extra = {}) => ({
  lanes: [{ id: 'a', kind: 'bot', name: 'Chief', main: true }, { id: 'b', kind: 'bot', name: 'Writer' }],
  utilization, edges: [], exchanges: [], ...extra,
})
const failing = [{ lane: 'a', windowMs: 1000, busyMs: 100, turns: 4, errors: 3, running: false }]

test('an alert opens once, is not repeated while it holds, and resolves when the condition clears', () => {
  const tracker = createAlertTracker({ now: () => 1000 })
  const first = tracker.evaluate(win(failing))
  assert.deepEqual(first.changed.map(change => [change.event, change.kind, change.botId]), [['open', 'errors', 'a']])
  assert.equal(first.open.length, 1)
  assert.deepEqual(first.open[0], { id: 'a\u0000errors', kind: 'errors', botId: 'a', name: 'Chief', since: 1000, detail: '3 of 4 turns failed' })
  // The same condition on the next window is not re-announced.
  const second = tracker.evaluate(win(failing))
  assert.deepEqual(second.changed, [])
  assert.equal(second.open.length, 1)
  // Cleared: it resolves and moves to the recent list.
  const cleared = tracker.evaluate(win([{ lane: 'a', windowMs: 1000, busyMs: 100, turns: 4, errors: 0, running: false }]))
  assert.deepEqual(cleared.changed.map(change => [change.event, change.kind]), [['resolve', 'errors']])
  assert.equal(cleared.open.length, 0)
  assert.equal(cleared.resolved.length, 1)
  assert.equal(cleared.resolved[0].botId, 'a')
})

test('a changed detail updates the alert without reopening it', () => {
  const tracker = createAlertTracker({ now: () => 1000 })
  tracker.evaluate(win(failing))
  const worse = tracker.evaluate(win([{ lane: 'a', windowMs: 1000, busyMs: 100, turns: 6, errors: 5, running: false }]))
  assert.deepEqual(worse.changed.map(change => [change.event, change.detail]), [['update', '5 of 6 turns failed']])
  assert.equal(worse.open.length, 1)
})

test('an unanswered request and a too-long wait each raise their own alert', () => {
  const clock = 1_000_000
  const tracker = createAlertTracker({ now: () => clock, stuckMs: 300_000 })
  const opened = tracker.evaluate(win([
    { lane: 'a', windowMs: 1000, busyMs: 100, turns: 4, errors: 3, running: false },
    { lane: 'b', windowMs: 1000, busyMs: 0, turns: 0, errors: 0, running: false },
  ], {
    edges: [{ from: 'b', to: 'a', unanswered: 2 }],
    exchanges: [{ id: 'x1', from: 'a', to: 'b', waiting: true, t: clock - 600_000 }],
  }))
  const kinds = opened.open.map(alert => `${alert.botId}:${alert.kind}`).sort()
  assert.deepEqual(kinds, ['a:errors', 'a:stuck', 'b:stuck', 'b:waiting'])
  const stuck = opened.open.find(alert => alert.kind === 'stuck')
  assert.equal(stuck.detail, 'a request has waited 10m')
})

test('a short wait is not an alert', () => {
  const clock = 1_000_000
  const tracker = createAlertTracker({ now: () => clock, stuckMs: 300_000 })
  const result = tracker.evaluate(win([{ lane: 'a', windowMs: 1000, busyMs: 0, turns: 0, errors: 0, running: false }], { exchanges: [{ id: 'x1', from: 'a', to: 'b', waiting: true, t: clock - 60_000 }] }))
  assert.deepEqual(result.open, [])
})

test('an empty window opens nothing and resolves what it held', () => {
  const tracker = createAlertTracker({ now: () => 1000 })
  tracker.evaluate(win(failing))
  const empty = tracker.evaluate({})
  assert.deepEqual(empty.open, [])
  assert.equal(empty.resolved.length, 1)
})
