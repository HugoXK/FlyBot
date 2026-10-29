// A run that ended early (needs-human / already-claimed / tip-unchanged / open-pr)
// is not a failure: the log says why it stopped, not that it stopped on the node.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linesFor } from '../src/narrate.js'
import { normalizeGraph } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'

const roster = [
  { id: 'bot-claim', name: 'Claim', role: 'Claim', remote: false },
  { id: 'bot-verify', name: 'Verify', role: 'Verify', remote: false },
  { id: 'bot-land', name: 'Land', role: 'Land', remote: false },
]

function graph() {
  return normalizeGraph({
    id: 'claim-verify-land',
    name: 'Claim Verify Land',
    nodes: [
      { id: 'claim', name: 'Claim', role: 'Claim', outputs: [{ name: 'claimed', type: 'text' }] },
      { id: 'verify', name: 'Verify', role: 'Verify', inputs: [{ name: 'claimed', type: 'text' }], outputs: [{ name: 'status', type: 'text' }] },
      { id: 'land', name: 'Land', role: 'Land', inputs: [{ name: 'status', type: 'text' }] },
    ],
    edges: [
      { from: 'claim', to: 'verify' },
      { from: 'verify', to: 'land' },
    ],
  })
}

const task = { id: '#1577', title: 'Early end' }

function failEvent(extra = {}) {
  return { type: 'fail', nodeId: 'verify', started: [], joined: false, finished: true, layerSize: 0, live: true, text: '', recovered: false, ...extra }
}

test('live fail with earlyEnd and no reply says early end, never failure', () => {
  const lines = linesFor(graph(), task, failEvent({ earlyEnd: 'tip-unchanged' }))
  assert.equal(lines.some(line => String(line.text).includes('失败')), false, JSON.stringify(lines))
  const end = lines.find(line => String(line.text).includes('提前结束'))
  assert.ok(end, JSON.stringify(lines))
  assert.equal(end.kind, 'system')
  assert.match(end.text, /tip-unchanged/)
  assert.equal(end.key, '⏹ Ended early · {reason}', 'the shell translates the key, the stored text is the fallback')
  assert.deepEqual(end.params, { reason: 'tip-unchanged' })
  assert.notEqual(end.tone, 'bad')
})

test('live fail with earlyEnd keeps the Bot reply and adds the early-end line', () => {
  const lines = linesFor(graph(), task, failEvent({ earlyEnd: 'open-pr', text: 'PR #1533 is already open for this issue.' }))
  const bot = lines.find(line => line.kind === 'bot')
  assert.equal(bot?.text, 'PR #1533 is already open for this issue.')
  assert.equal(lines.some(line => String(line.text).includes('失败')), false, JSON.stringify(lines))
  assert.ok(lines.some(line => String(line.text).includes('提前结束') && String(line.text).includes('open-pr')))
})

test('complete with earlyEnd still ends on the ok finish line and adds no early-end line', () => {
  const lines = linesFor(graph(), task, {
    type: 'complete', nodeId: 'land', started: [], joined: false, finished: true, layerSize: 1, live: true, text: '', earlyEnd: 'already-claimed',
  })
  assert.ok(lines.some(line => String(line.text).startsWith('✓ 完成')))
  assert.equal(lines.some(line => String(line.text).includes('提前结束')), false, JSON.stringify(lines))
})

test('a plain live failure still says the run stopped on this node', () => {
  const lines = linesFor(graph(), task, failEvent())
  assert.ok(lines.some(line => String(line.text).includes('停在本节点')), JSON.stringify(lines))
  assert.equal(lines.some(line => String(line.text).includes('提前结束')), false)
})

test('a recovered live failure still says it recovered', () => {
  const lines = linesFor(graph(), task, failEvent({ recovered: true, started: ['claim'] }))
  assert.ok(lines.some(line => String(line.text).includes('失败恢复')))
  assert.equal(lines.some(line => String(line.text).includes('提前结束')), false)
})

test('non-live fail with earlyEnd says early end, never failure', () => {
  const lines = linesFor(graph(), task, { ...failEvent({ earlyEnd: 'needs-human' }), live: false })
  assert.equal(lines.some(line => String(line.text).includes('失败')), false, JSON.stringify(lines))
  assert.ok(lines.some(line => String(line.text).includes('提前结束') && String(line.text).includes('needs-human')))
})

test('service: a Verify reply that marks tip-unchanged narrates the early end', () => {
  const svc = createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => roster })
  const base = graph()
  const created = svc.create({ name: base.name, nodes: base.nodes, edges: base.edges })
  const workflowId = created.workflows.find(workflow => workflow.name === base.name).id
  svc.assign({ workflowId, taskId: '#1577', title: 'Early end' })
  svc.advance({ workflowId, nodeId: 'claim', outcome: 'done', outputs: { claimed: 'ok' }, text: 'Claimed.' })

  const result = svc.advance({
    workflowId,
    nodeId: 'verify',
    outcome: 'failed',
    text: 'Suite green at this tip; tip unchanged from the previous pass.',
  })
  const workflow = result.workflows.find(item => item.id === workflowId)
  const texts = workflow.messages.map(line => String(line.text))
  assert.equal(workflow.run.status, 'done')
  assert.equal(workflow.run.earlyEnd, 'tip-unchanged')
  assert.equal(texts.some(text => text.includes('失败')), false, texts.join(' | '))
  assert.ok(texts.some(text => text.includes('提前结束') && text.includes('tip-unchanged')), texts.join(' | '))
})
