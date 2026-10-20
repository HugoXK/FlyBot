import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODEL_LIMITS, createPluginModel } from '../src/host/plugin-model.js'

function fakeRt({ reply = 'An answer', finish = { kind: 'stop' }, fail, readOnly = false, model = 'deepseek/v4' } = {}) {
  const requests = []
  const rt = {
    readOnly: () => (readOnly ? 'another host holds the team' : undefined),
    defaultModel: async () => model,
    ctx: {
      llm: {
        async* stream(request) {
          requests.push(request)
          if (fail) throw fail
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'finish', reason: finish }
        },
      },
    },
  }
  return { rt, requests }
}

test('a plugin that is not allow-listed is refused, and the allow-list is the only key', async () => {
  const { rt, requests } = fakeRt()
  const ask = createPluginModel(rt, { allow: [] })
  assert.deepEqual(await ask('flybot-tree', { prompt: 'hi' }), { ok: false, code: 'not-allowed' })
  assert.equal(requests.length, 0, 'no model call is made')
})

test('a read-only host, an empty prompt and an over-long prompt are refused before any call', async () => {
  const { rt } = fakeRt({ readOnly: true })
  assert.deepEqual(await createPluginModel(rt, { allow: ['p'] })('p', { prompt: 'hi' }), { ok: false, code: 'read-only' })
  const live = fakeRt()
  const ask = createPluginModel(live.rt, { allow: ['p'] })
  assert.deepEqual(await ask('p', { prompt: '   ' }), { ok: false, code: 'empty-prompt' })
  assert.deepEqual(await ask('p', { prompt: 'x'.repeat(MODEL_LIMITS.maxPromptChars + 1) }), { ok: false, code: 'prompt-too-long' })
  assert.equal(live.requests.length, 0)
})

test('an allowed plugin gets text only, with the output clamped to the host ceiling', async () => {
  const { rt, requests } = fakeRt({ reply: 'Hangzhou' })
  const ask = createPluginModel(rt, { allow: ['flybot-tree'] })
  assert.deepEqual(await ask('flybot-tree', { prompt: 'City?', maxTokens: 99999 }), { ok: true, text: 'Hangzhou' })
  assert.equal(requests[0].maxTokens, MODEL_LIMITS.maxTokens, 'maxTokens is clamped')
  assert.equal(requests[0].provider, 'deepseek')
  assert.equal(requests[0].model, 'v4')
})

test('a provider error is a short code, never the provider message', async () => {
  const { rt } = fakeRt({ fail: Object.assign(new Error('401: key sk-live-SECRET rejected'), { code: 'AUTH' }) })
  const answer = await createPluginModel(rt, { allow: ['p'] })('p', { prompt: 'hi' })
  assert.deepEqual(answer, { ok: false, code: 'AUTH' })
  assert.equal(JSON.stringify(answer).includes('SECRET'), false)
})

test('an empty reply is a failure, and a model-less team is refused', async () => {
  const blank = fakeRt({ reply: '' })
  assert.deepEqual(await createPluginModel(blank.rt, { allow: ['p'] })('p', { prompt: 'hi' }), { ok: false, code: 'empty-reply' })
  const none = fakeRt({ model: null })
  assert.deepEqual(await createPluginModel(none.rt, { allow: ['p'] })('p', { prompt: 'hi' }), { ok: false, code: 'no-model' })
})

test('calls are rate limited per plugin inside a minute', async () => {
  const { rt } = fakeRt()
  let clock = 0
  const ask = createPluginModel(rt, { allow: ['p'], now: () => clock, limits: { perMinute: 3 } })
  assert.equal((await ask('p', { prompt: 'a' })).ok, true)
  assert.equal((await ask('p', { prompt: 'b' })).ok, true)
  assert.equal((await ask('p', { prompt: 'c' })).ok, true)
  assert.deepEqual(await ask('p', { prompt: 'd' }), { ok: false, code: 'rate-limited' })
  clock = 61_000
  assert.equal((await ask('p', { prompt: 'e' })).ok, true, 'the window slides')
})

test('a stream that ends with an error finish maps to a short code', async () => {
  const { rt } = fakeRt({ reply: '', finish: { kind: 'error', failure: { code: 'RATE_LIMIT' } } })
  assert.deepEqual(await createPluginModel(rt, { allow: ['p'] })('p', { prompt: 'hi' }), { ok: false, code: 'RATE_LIMIT' })
})
