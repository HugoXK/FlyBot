import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A human line posted to a Bot's own chat while a foreground tool or job wait is open
// (#1509). The composer queues the line, so it is claimed only after the wait ends — and a
// wait on a long `bash`/job is exactly the case the owner called stuck. Once that wait has
// lasted over a minute the turn is aborted the way Stop aborts it (`keepInbox`), and the
// line is queued behind the abort so its wake opens the next turn with the line in it.
const WAIT_MS = 60_000

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-wait-interrupt-'))
  const ctx = fakeContext()
  // cancel and prompt in arrival order, so a test can pin which one came first.
  const log = []
  const prompts = []
  const cancelled = []
  const agentOf = (sessionId) => {
    const agent = {
      session: { id: sessionId },
      status: 'running',
      followup() {},
      steer() {},
      inject() {},
      cancel(cause, options) {
        log.push('cancel')
        cancelled.push({ sessionId, cause, options })
      },
      inbox: { nextStep: [], nextTurn: [], remove() {} },
    }
    return agent
  }
  const agents = new Map()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async (path) => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async (sessionId) => {
        if (!agents.has(sessionId)) agents.set(sessionId, agentOf(sessionId))
        return { agent: agents.get(sessionId) }
      },
      selectModel: async () => {},
      prompt: async (request) => {
        log.push('prompt')
        prompts.push({ sessionId: request.sessionId, mode: request.mode, text: request.content.map(part => part.text).join('') })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  let seq = 0
  // What DSH publishes for a running Session: a turn, then the tool call it is blocked on.
  const emit = (sessionId, type, data, time) => ctx.emitArgs('session/event', { id: sessionId }, { type, seq: ++seq, time, data })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, ctx, emit, log, prompts, cancelled, rt, stop }
}

// A turn opened `startedAgoMs` ago whose `tool` call is still open (no `tool/result` yet).
function openWait(emit, sessionId, { tool = 'bash', startedAgoMs } = {}) {
  emit(sessionId, 'turn/start', { turn: 1 }, Date.now() - startedAgoMs)
  emit(sessionId, 'tool/call', { callId: 'call-1', name: tool, arguments: '{"command":"sleep 600"}' }, Date.now() - startedAgoMs)
}

test('#1509: a human line on a wait older than a minute aborts it the way Stop does, keeping the line', async (t) => {
  const { call, emit, log, prompts, cancelled, rt, stop } = start()
  t.after(stop)
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  openWait(emit, rt.chatOf(chief), { startedAgoMs: WAIT_MS + 5_000 })

  assert.equal((await call('send', { sessionId: chief, text: 'stop waiting and read this' })).ok, true)

  assert.equal(cancelled.length, 1, 'the foreground wait that has lasted over a minute is aborted')
  assert.deepEqual(cancelled[0].cause, { kind: 'user' }, 'the abort is the user Stop path, not a new cancellation')
  assert.deepEqual(cancelled[0].options, { keepInbox: true }, 'the human line must survive the abort')
  assert.deepEqual(log, ['cancel', 'prompt'], 'the wait is aborted first, so the queued line\'s own wake opens the next turn')
  assert.deepEqual(prompts.map(entry => entry.mode), ['queue'], 'the line still lands as a queued prompt, exactly as before')
})

test('#1509: a wait younger than a minute keeps running, and the line queues behind it', async (t) => {
  const { call, emit, prompts, cancelled, rt, stop } = start()
  t.after(stop)
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  openWait(emit, rt.chatOf(chief), { startedAgoMs: WAIT_MS - 5_000 })

  assert.equal((await call('send', { sessionId: chief, text: 'when you get to it' })).ok, true)

  assert.deepEqual(cancelled, [], 'a command that is still quick is not killed mid-flight')
  assert.equal(prompts.length, 1, 'the line waits its turn as before')
})

test('#1509: a running turn with no open tool call is left alone', async (t) => {
  const { call, emit, prompts, cancelled, rt, stop } = start()
  t.after(stop)
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  const chat = rt.chatOf(chief)
  emit(chat, 'turn/start', { turn: 1 }, Date.now() - 10 * WAIT_MS)

  assert.equal((await call('send', { sessionId: chief, text: 'plus one more thing' })).ok, true)

  assert.deepEqual(cancelled, [], 'the model is thinking, not blocked on a wait: nothing is aborted')
  assert.equal(prompts.length, 1)
})

test('#1509: a question the Bot is already waiting on is not a stuck wait', async (t) => {
  const { call, emit, prompts, cancelled, rt, stop } = start()
  t.after(stop)
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  openWait(emit, rt.chatOf(chief), { tool: 'ask_user', startedAgoMs: WAIT_MS * 3 })

  assert.equal((await call('send', { sessionId: chief, text: 'hold on' })).ok, true)

  assert.deepEqual(cancelled, [], 'a turn that already waits for the person is not aborted under them')
  assert.equal(prompts.length, 1)
})
