import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makePlan, planLine, reportPart } from '../src/plan.js'

test('makePlan validates, ids parts and cleans names', () => {
  const { plan } = makePlan({ goal: '  Ship   the launch ', parts: ['Research flights', { name: 'Book hotel', owner: 'Travel' }] })
  assert.equal(plan.goal, 'Ship the launch')
  assert.deepEqual(plan.parts.map(p => [p.id, p.name, p.status]), [['p1', 'Research flights', 'todo'], ['p2', 'Book hotel', 'todo']])
  assert.equal(plan.parts[1].owner, 'Travel')
  assert.match(makePlan({ goal: '', parts: ['x'] }).error, /goal/)
  assert.match(makePlan({ goal: 'g', parts: [] }).error, /at least one part/)
  assert.match(makePlan({ goal: 'g', parts: ['a', 'A'] }).error, /two parts are named/)
  assert.match(makePlan({ goal: 'g', parts: Array.from({ length: 13 }, () => 'x') }).error, /at most 12/)
})

test('reportPart matches a part by id or name and returns a copy, not a mutation', () => {
  const { plan } = makePlan({ goal: 'g', parts: ['Research', 'Book'] })
  const byId = reportPart(plan, { part: 'p2', status: 'doing', note: 'searching' })
  assert.equal(byId.part.status, 'doing')
  assert.equal(plan.parts[1].status, 'todo', 'the original plan is untouched')
  assert.equal(byId.plan.parts[1].note, 'searching')
  const byName = reportPart(byId.plan, { part: 'research', status: 'done' })
  assert.equal(byName.plan.parts[0].status, 'done')
  assert.match(reportPart(plan, { part: 'nope', status: 'done' }).error, /no part in the plan/)
  assert.match(reportPart(plan, { part: 'p1', status: 'nearly' }).error, /status must be one of/)
  assert.match(reportPart(undefined, { part: 'p1', status: 'done' }).error, /no plan to report on/)
})

test('planLine counts done and calls out blocked and open parts', () => {
  assert.equal(planLine(undefined), undefined)
  const { plan } = makePlan({ goal: 'Ship', parts: ['A', 'B'] })
  assert.match(planLine(plan), /Ship.* \(0\/2 done\).*Still open: A \[todo\]; B \[todo\]/)
  const done = reportPart(reportPart(plan, { part: 'A', status: 'done' }).plan, { part: 'B', status: 'blocked' }).plan
  assert.match(planLine(done), /\(1\/2 done\)/)
  assert.match(planLine(done), /Blocked: B/)
  const allDone = reportPart(done, { part: 'B', status: 'done' }).plan
  assert.match(planLine(allDone), /Every part is done/)
})
