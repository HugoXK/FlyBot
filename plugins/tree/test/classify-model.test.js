import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelClassifier, fingerprint, parseDomain } from '../src/classify-model.js'
import { profileOf } from '../src/roles.js'

function fakeFb({ answer = 'dev', ok = true, bot = { id: 'b', name: 'Atlas', role: '负责采购' }, fields = {} } = {}) {
  const store = new Map(Object.entries(fields))
  const asks = []
  return {
    asks,
    store,
    getBot: id => (bot && bot.id === id ? bot : undefined),
    getField: (id, key) => store.get(`${id}/${key}`),
    setField: (id, key, value) => store.set(`${id}/${key}`, value),
    askModel: async input => { asks.push(input); return ok ? { ok: true, text: answer } : { ok: false, code: 'not-allowed' } },
  }
}

test('parseDomain reads a category id, "none" as null, and anything else as unknown', () => {
  assert.equal(parseDomain('dev'), 'dev')
  assert.equal(parseDomain('Life\n'), 'life')
  assert.equal(parseDomain('finance'), 'finance')
  assert.equal(parseDomain('none'), null)
  assert.equal(parseDomain('I would say dev'), undefined)
  assert.equal(parseDomain(''), undefined)
})

test('the classifier stores one category per Bot and re-asks only when the role text changes', async () => {
  const fb = fakeFb({ answer: 'business', bot: { id: 'b', name: 'Atlas', role: '负责采购' } })
  const { classifyBot } = createModelClassifier({ fb, now: () => 7 })
  const first = await classifyBot('b')
  assert.deepEqual({ ...first, at: 7 }, { domain: 'business', fp: fingerprint({ name: 'Atlas', role: '负责采购', treeRole: undefined, prompt: '' }), at: 7 })
  assert.equal(fb.asks.length, 1)
  assert.equal((await classifyBot('b')).domain, 'business')
  assert.equal(fb.asks.length, 1, 'an unchanged Bot is not asked again')
  fb.getBot = () => ({ id: 'b', name: 'Atlas Renamed', role: '负责采购' })
  await classifyBot('b')
  assert.equal(fb.asks.length, 2, 'a renamed Bot is asked again')
})

test('a refused or unparsable call stores nothing and never clears a good label', async () => {
  const refused = fakeFb({ ok: false })
  assert.equal(await createModelClassifier({ fb: refused }).classifyBot('b'), undefined)
  assert.equal(refused.store.size, 0)
  const vague = fakeFb({ answer: 'I am not sure' })
  assert.equal(await createModelClassifier({ fb: vague }).classifyBot('b'), undefined)
  assert.equal(vague.store.size, 0, 'a stray sentence does not overwrite anything')
})

test('an unknown Bot is skipped', async () => {
  const fb = fakeFb({ bot: null })
  assert.equal(await createModelClassifier({ fb }).classifyBot('gone'), undefined)
})

test('a stored model category fills a domain the rules cannot, but never overrides the rules', () => {
  const bare = profileOf({ id: 'b', name: 'Zorblax', role: 'tends the flux capacitor', treeRole: 'flux systems' })
  assert.equal(bare.domain, null, 'the vocabulary holds none of these words')
  const modeled = profileOf({ id: 'b', name: 'Zorblax', role: 'tends the flux capacitor', treeRole: 'flux systems', modelDomain: 'business' })
  assert.equal(modeled.domain, 'business')
  assert.equal(modeled.area, 'work')
  // Rules win where they already found a category.
  const ruled = profileOf({ id: 'c', name: 'Dev', role: 'writes code', modelDomain: 'life' })
  assert.equal(ruled.domain, 'dev')
})
