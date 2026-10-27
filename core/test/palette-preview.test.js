// The command palette's message rows are read by a person, like every other preview row (#1347):
// the header and a delegation trace are routing, and an untrusted fence is data. A search matches
// the words of the line, never the marker's attributes.
//
// The invariant each case pins is not a hand-written string but the live `previewOf` read of the same
// stored shape: a row is what a preview shows, or the palette has a second reading of stored text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { botNames, previewOf, readableLine } from '../src/client/text.js'

const { outputFiles } = await build({
  stdin: { contents: "export { CommandPalette } from './src/client/palette.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat() } })
const react = {
  createElement: h, Fragment: Symbol('F'),
  useEffect() {}, useLayoutEffect() {},
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useRef: (current) => ({ current }),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: false }, window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: () => null, MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { CommandPalette } = module.exports

// The conversation's real Bot names: only these can make a prefix a delegation trace (#1408).
const BOTS = [
  { id: 's1', sessionId: 's1', name: 'Chief' },
  { id: 's2', sessionId: 's2', name: '助手' },
  { id: 's3', sessionId: 's3', name: 'Dev Lead' },
  { id: 's4', sessionId: 's4', name: 'Dev-1' },
  { id: 's5', sessionId: 's5', name: 'Product' },
]
const ROSTER = { bots: BOTS, byId: Object.fromEntries(BOTS.map(bot => [bot.id, bot])), rooms: [], roomsById: {}, agents: [], exchangeTurns: {} }
const NAMES = botNames(ROSTER)

// The same stored line as the Session outline holds it, so `previewOf` is asked the question a
// sidebar row asks.
const outlineOf = (raw) => ({ projectionsBySession: { s1: { values: { turnOutline: [{ turn: 1, prompt: raw }] } } }, byId: {} })

// What the palette's message section found for `query` over that session's outline: [[session, turn, row]].
function hits(query, raw) {
  let found
  const useSessions = (selector) => { found = selector(outlineOf(raw)); return found }
  CommandPalette({ start: query, token: 't', roster: ROSTER, actions: { closePalette() {}, openSession() {} }, useSessions })
  return JSON.parse(found)
}

// One stored shape, one row: the rendered row text must be byte-for-byte what `previewOf` reads of the
// same line, and `readableLine(text, names)` must be the same read as `previewOf(list, id, …, names)`.
function rowIsPreview(query, raw, message) {
  const expected = previewOf(outlineOf(raw), 's1', [], [], NAMES)
  const found = hits(query, raw)
  assert.equal(found.length, 1, `the words of "${message}" are found`)
  assert.equal(found[0][2], expected, `the row is what previewOf reads for "${message}"`)
  assert.equal(expected, readableLine(raw, NAMES), `readableLine(text, names) is previewOf(list, id) for "${message}"`)
  return found[0][2]
}

// The outline flattens a reply to one line, so a flattened trace can carry its own spacing (#1347).
test('#1347: a trace indented with spaces is read as previewOf reads it', () => {
  rowIsPreview('hi', '  Chief → 助手 Hi there', 'a space-indented trace')
})

test('#1347: a trace split by tabs is read as previewOf reads it', () => {
  rowIsPreview('hi', 'Chief\t→\t助手 Hi there', 'a tab-separated trace')
})

test('#1347: a trace with doubled spaces is read as previewOf reads it', () => {
  rowIsPreview('hi', 'Chief  →  助手 Hi there', 'a double-spaced trace')
})

test('#1347: a trace with mixed indentation is read as previewOf reads it', () => {
  rowIsPreview('hi', ' Chief \t → \t 助手  Hi there', 'a mixed-whitespace trace')
})

test('#1347: a trace after a header is read as previewOf reads it', () => {
  rowIsPreview('hi', '[Reply from 助手]\n  Chief → 助手 Hi there', 'a header then an indented trace')
})

test('#1347: a wrapped multi-line line is read as previewOf reads it', () => {
  rowIsPreview('hi', '  Chief → 助手 Hi, there\nsecond line', 'a wrapped line with a flattened trace')
})

test('#1347: a fence fragment after a trace is read as previewOf reads it', () => {
  const row = rowIsPreview('hi', 'Chief\t→\t助手 Hi </untrusted-message>', 'a trace then a fence fragment')
  assert.doesNotMatch(row, /untrusted-message|from="/)

  // A complete wrap reads the same way: only the words, and the marker's own words find nothing.
  const wrapped = '[Message from User (user@friend)]\n<untrusted-message from="User">\nB踢后测4\n</untrusted-message>'
  assert.equal(previewOf(outlineOf(wrapped), 's1', [], [], NAMES), readableLine(wrapped, NAMES))
  assert.equal(hits('b踢', wrapped)[0][2], readableLine(wrapped, NAMES))
  for (const attribute of ['from', 'user', 'untrusted']) assert.deepEqual(hits(attribute, wrapped), [], `"${attribute}" belongs to the marker, not the line`)
})

// #1408 shape 1: the fence is taken before the trace, so a trace the fence wrapped is still routing.
test('#1408: a trace inside a fence reads as its words', () => {
  const raw = '<untrusted-message from="User">\nChief → 助手\n\nHi there\n</untrusted-message>'
  assert.equal(readableLine(raw, NAMES), 'Hi there')
  assert.equal(previewOf(outlineOf(raw), 's1', [], [], NAMES), 'Hi there')
})

// #1408 shape 2: a name is what makes the prefix a trace — an ordinary arrow line keeps every word,
// and stays findable by any of them.
test('#1408: an ordinary arrow line is not a trace', () => {
  const raw = '[Message from Chief]\nSettings → Models 页面'
  const expected = readableLine(raw, NAMES)
  assert.equal(expected, 'Settings → Models 页面')
  for (const query of ['Settings', 'Models', '页面']) {
    const found = hits(query, raw)
    assert.equal(found.length, 1, `"${query}" is found`)
    assert.equal(found[0][2], expected, `the row keeps its words for "${query}"`)
  }
  assert.equal(readableLine('a → b c', NAMES), 'a → b c')
})

// #1408 shape 2, the other edge: a real trace loses its routing, whole names only, and a clock on its
// tail is routing too — never content, and never a row of its own.
test('#1408: a known-name trace loses its routing, whole names only', () => {
  const cases = [
    ['Chief → Product，03:16Z 审计。**defect 无**', '审计。**defect 无**'],
    ['Chief → Product 03:16Z 审计', '审计'],
    ['Chief → Dev Lead → Dev-1 点头', '点头'],
    ['Chief → Dev Lead 点头', '点头'],
    ['Dev Lead → Chief. Base note is up', 'Base note is up'],
    ['Chief → 助手 Hi there', 'Hi there'],
    ['Chief → Product，03:16Z', ''],
    ['Dev → Lead 点头', 'Dev → Lead 点头'],
    ['Chief → 助手们 Hi there', 'Chief → 助手们 Hi there'],
  ]
  for (const [raw, expected] of cases) assert.equal(readableLine(raw, NAMES), expected)
})

// Without names nothing that only looks like a trace is removed: a caller that has no roster reads
// the line as before (#1408).
test('#1408: no names, no trace removal', () => {
  assert.equal(readableLine('Chief → 助手 Hi there'), 'Chief → 助手 Hi there')
  assert.equal(readableLine('Settings → Models 页面'), 'Settings → Models 页面')
})

// An empty turn is no line at all: the walk keeps going to an older turn, as a sidebar row does.
// #1408 shape 3: the back-fill `previewOf` did before `break` made it unreachable.
test('previewOf falls back to an older turn when the newest turn is empty', () => {
  const outline = (turns) => ({ projectionsBySession: { s1: { values: { turnOutline: turns } } } })
  const empty = outline([{ turn: 1, response: 'older reply', prompt: 'q1' }, { turn: 2, response: '', prompt: '' }])
  assert.equal(previewOf(empty, 's1'), 'older reply')
  assert.equal(previewOf(empty, 's1', [], [], NAMES), 'older reply')

  // An unsent turn still shows its prompt; the fallback must not swallow it.
  const unsent = outline([{ turn: 1, response: 'older reply', prompt: 'q1' }, { turn: 2, response: 'held reply', prompt: 'What is 2+2?' }])
  assert.equal(previewOf(unsent, 's1', [], [2]), 'What is 2+2?')
})
