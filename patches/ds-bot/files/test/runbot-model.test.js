// #1582: a run Bot must not take the model of the Bot that started the run. `createdBy` is how the
// roster says "a Bot made this Bot, so with no model named it starts on its maker's model" (#410);
// a run Bot is not a Bot's child, so the field must never reach that rule. The profile default is
// what the board, the canvas and the API already use for a node that names no model.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 1, mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, model: 'deepseek/deepseek-v4-pro' } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

function start(teamState, { models = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-runbot-model-'))
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(teamState))
  const ctx = fakeContext()
  const sent = []
  let sessions = 0
  ctx.logger.warn = () => {}
  Object.assign(ctx, {
    llm: {
      listProviders: () => (models.length > 0 ? [{ id: 'deepseek', name: 'DeepSeek' }] : []),
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: m => sent.push({ sessionId, message: m }) } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.path.endsWith('bot')) route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { rt, ctx, stop, call }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30))

test('#1582: a run Bot with a caller and no model takes the profile default, not the caller model', async (t) => {
  const { rt, ctx, stop, call } = start(team(), { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  const teamView = (await call('state', {})).value
  const chiefId = teamView.mainBotId ?? 'a'
  await call('update-bot', { id: chiefId, model: 'deepseek/deepseek-v4-pro' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await rt.desiredModel(rt.botOf('a')), 'deepseek/deepseek-v4-pro', 'the caller really is on the other model')
  assert.equal(await rt.defaultModel(), 'deepseek/deepseek-v4-flash')
  await settle()

  const createRunBot = async (name, extra) => ctx.flybot.bot.create({
    name, role: 'Run', instructions: 'Work.', hidden: true,
    ephemeral: true, tools: ['github'],
    ...extra,
  })
  const withCaller = await createRunBot('Probe WithCaller', { createdBy: 'a' })
  const without = await createRunBot('Probe NoCaller', {})
  const explicit = await createRunBot('Probe Explicit', { createdBy: 'a', model: 'deepseek/deepseek-v4-flash' })
  assert.equal(rt.botOf(withCaller)?.model, 'deepseek/deepseek-v4-flash', 'a run Bot must not take the caller model')
  assert.equal(rt.botOf(without)?.model, 'deepseek/deepseek-v4-flash')
  assert.equal(rt.botOf(explicit)?.model, 'deepseek/deepseek-v4-flash', 'an explicit model still wins')
})
