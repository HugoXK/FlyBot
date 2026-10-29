// #1611: a graph edit that drops a running node ends that run and archives it.
// The archived row is what the Runs tab later reads to say "superseded by" —
// but only a row that carries the ended run's id can be marked at all. This
// test takes the row the host actually wrote (never a hand-written id) and asks
// the client to mark it.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
  { id: 'bot-coder', name: 'Coder', role: '实现', remote: false },
]

// The Runs tab is a client module loaded into a browser window; this is the
// least of one that lets its plain functions run.
const documentStub = {
  listeners: [],
  getElementById() { return null },
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild() {} },
  querySelector() { return null },
  addEventListener(name, fn) { this.listeners.push({ name, fn }) },
  removeEventListener() {},
}
globalThis.document = documentStub

function loadClient() {
  const modules = new Map()
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useEffect() {},
    useRef: init => ({ current: init }),
  }
  const window = {
    __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? react : {}))) },
  }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/workflow')
}

const client = loadClient()

function harness() {
  let seq = 0
  // Two attempts happen at two moments; a fixed clock would put both rows on the
  // same second and hide the second one behind the first one's fallback key.
  let clock = 1_700_000_000_000
  const svc = createWorkflowService({
    persist: false,
    now: () => (clock += 60_000),
    bots: () => roster,
    spawn: async () => `eph-${++seq}`,
    release: async () => {},
    dispatch: async () => ({ ok: true }),
    // #1530 bounds every step with a deadline timer; this case asserts the row an
    // edit archives, not when a step expires, so the scheduler is a no-op.
    setTimer: () => 0,
    clearTimer: () => {},
  })
  return svc
}

async function defineTwoNodes(svc) {
  await svc.define({
    name: 'RetryProbe',
    nodes: [
      { id: 'a', name: 'A', prompt: 'Do A.' },
      { id: 'b', name: 'B', prompt: 'Do B.' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  })
  return svc.state().workflows.find(item => item.name === 'RetryProbe')
}

test('the attempt a graph edit stopped is marked superseded by the retry (#1611)', async () => {
  const svc = harness()
  const workflow = await defineTwoNodes(svc)
  const started = await svc.assign({ workflowId: workflow.id, taskId: 'task-retry', title: 'Retry me' })
  const beforeEdit = started.workflows.find(item => item.id === workflow.id)
  assert.equal(beforeEdit.run?.nodeStatus?.a, 'running', 'the first attempt is running node a')

  // Drop the running node: saveGraph ends the attempt and archives a row of its own.
  const edited = await svc.saveGraph({
    workflowId: workflow.id,
    nodes: [{ id: 'b', name: 'B', prompt: 'Do B.' }],
    edges: [],
  })
  assert.equal(edited.ok, true, JSON.stringify(edited))
  const editedView = edited.workflows.find(item => item.id === workflow.id)
  const stopped = (editedView.runs ?? []).find(run => run.task?.id === 'task-retry')
  assert.ok(stopped, 'the ended attempt is still shown: ' + JSON.stringify(editedView.runs))
  const hostRow = (editedView.history ?? []).find(row => row.task?.id === 'task-retry')
  assert.ok(hostRow, 'the edit archived the ended attempt: ' + JSON.stringify(editedView.history))

  // The owner hands the same task to the workflow again.
  const retried = await svc.assign({ workflowId: workflow.id, taskId: 'task-retry', title: 'Retry me' })
  const view = retried.workflows.find(item => item.id === workflow.id)
  const rows = client.runHistoryRows(view)
  const older = rows?.find(row => row.task?.id === 'task-retry' && row.status === 'failed')
  const newer = rows?.find(row => row.id === view.run?.id)
  assert.ok(older && newer, 'both attempts have a row: ' + JSON.stringify(rows))
  assert.equal(older.supersededBy, newer.id, 'the stopped attempt names the retry that replaced it')
  assert.equal(newer.retryOf, older.id, 'the retry names the attempt it replaced')
  assert.equal(hostRow.id, stopped.id, 'the archived row carries the id of the run it ended')
})

test('the demo-store migration never borrows the workflow id for a history row (#1611)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-history-row-1611-'))
  try {
    const graph = id => ({ id, name: id, nodes: [{ id: 'a', name: 'A', prompt: 'Do A.' }], edges: [], layers: [], triggers: [] })
    const task = { id: '#1611', title: 'Migrated demo' }
    const stored = {
      version: 1,
      workflows: [graph('wf-x'), graph('wf-x-legacy')],
      runs: {},
      lanes: {},
      logs: {},
      demos: {
        'wf-x': { id: 'run-demo', live: true, status: 'failed', task, updatedAt: 1_700_000_000_000 },
        'wf-x-legacy': { live: true, status: 'failed', task, updatedAt: 1_700_000_000_000 },
      },
    }
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(stored))
    const svc = createWorkflowService({ dir, persist: false, bots: () => roster })
    const state = svc.state()
    const historyOf = id => state.workflows.find(item => item.id === id)?.history ?? []

    const named = historyOf('wf-x')[0]
    assert.ok(named, 'the demo attempt is archived as history: ' + JSON.stringify(historyOf('wf-x')))
    assert.equal(named.status, 'failed')
    assert.equal(named.task?.id, '#1611')
    assert.equal(named.id, 'run-demo', 'the row carries the stored run id')
    assert.notEqual(named.id, 'wf-x', 'and never the lane key that stands beside it')

    // The map key names the lane, not a run. A record with no run id gets a row
    // with no id — markSuperseded skips it, exactly as it does today — and never a
    // fabricated one that would render as "retry of wf-x-legacy".
    const anonymous = historyOf('wf-x-legacy')[0]
    assert.ok(anonymous, 'the id-less demo attempt is archived too: ' + JSON.stringify(historyOf('wf-x-legacy')))
    assert.equal(anonymous.task?.id, '#1611')
    assert.equal(anonymous.id, undefined, 'no workflow id is borrowed as the run id')
    assert.notEqual(anonymous.id, 'wf-x-legacy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a legacy row with no id stays unmarked and never names a retry (#1611)', () => {
  // The row an older store wrote has no id to mark. That is the behaviour today,
  // and it stays: the anonymous attempt gets no marker, and the retry names the
  // newest attempt that does carry an id, never the anonymous one.
  const task = { id: '#1611', title: 'Legacy row' }
  const workflow = {
    activeCount: 1,
    queue: [],
    runs: [{ id: 'run-new', live: true, status: 'running', task, updatedAt: 1_700_000_600_000 }],
    run: { id: 'run-new', live: true, status: 'running', task, updatedAt: 1_700_000_600_000 },
    history: [
      { task, status: 'failed', at: 1_700_000_000_000 },
      { id: 'run-mid', task, status: 'failed', at: 1_700_000_300_000 },
    ],
  }
  const rows = client.runHistoryRows(workflow)
  const anonymous = rows.find(row => row.task?.id === '#1611' && !row.id)
  const mid = rows.find(row => row.id === 'run-mid')
  const newer = rows.find(row => row.id === 'run-new')
  assert.ok(anonymous && mid && newer, 'all three attempts have a row: ' + JSON.stringify(rows))
  assert.equal(anonymous.supersededBy, undefined, 'a row with no id is skipped, not marked')
  assert.equal(mid.supersededBy, 'run-new', 'the attempt that has an id is still marked')
  assert.equal(newer.retryOf, 'run-mid', 'the retry names the attempt that has an id')
})
