// upstream-sync (#815): the read-only check that says whether the fork's main is on upstream's main
// and whether the ruleset that protects it came back, and the `--commits` read that names what a
// fast-forward would carry. Each case pins one exit code from the issue's acceptance list, and the
// fake transport refuses anything that is not a GET, so "read-only" is enforced rather than promised.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, commits, DEFAULTS } from './upstream-sync.mjs'

const UP = '6f9b60c7f9f2ffd07fa1387eece36756fbd49dbb'
const FORK = 'f20cfa37f9f2ffd07fa1387eece36756fbd49dbb'
const RULESET = { enforcement: 'active', bypass_actors: [], current_user_can_bypass: 'never' }
const PUSHED = [
  { sha: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', commit: { message: 'test(ci): pin the live-e2e key gates\n\nbody' } },
  { sha: '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', commit: { message: 'Add the RSI baseline reporter' } },
]

// A transport that answers the four reads this script makes and refuses anything else — including a
// non-GET on a URL it knows, so a future write reddens every case instead of one.
function transport({ upstreamSha = UP, forkSha = FORK, aheadBy = 0, behindBy = 0, status = 'identical', ruleset = RULESET, rulesetStatus = 200, compareStatus = 200, commits: list = [] } = {}) {
  const seen = []
  const json = (body) => ({ status: 200, text: async () => JSON.stringify(body) })
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    seen.push({ url, method })
    if (method !== 'GET') throw new Error(`refused a ${method}: this check never writes (${url})`)
    if (url.endsWith(`/repos/${DEFAULTS.upstream}/git/ref/heads/main`)) return json({ object: { sha: upstreamSha } })
    if (url.endsWith(`/repos/${DEFAULTS.fork}/git/ref/heads/main`)) return json({ object: { sha: forkSha } })
    if (url.includes(`/repos/${DEFAULTS.upstream}/compare/`)) {
      if (compareStatus !== 200) return { status: compareStatus, text: async () => JSON.stringify({ message: 'Bad Gateway' }) }
      return json({ ahead_by: aheadBy, behind_by: behindBy, status, commits: list })
    }
    if (url.endsWith(`/repos/${DEFAULTS.upstream}/rulesets/${DEFAULTS.rulesetId}`)) {
      if (rulesetStatus !== 200) return { status: rulesetStatus, text: async () => JSON.stringify({ message: 'Not Found' }) }
      return json({ id: Number(DEFAULTS.rulesetId), ...ruleset })
    }
    throw new Error(`unexpected request: ${url}`)
  }
  return { fetchImpl, seen }
}

const run = async (options = {}, env = { GITHUB_TOKEN: 'test-token' }) => {
  const { fetchImpl, seen } = transport(options)
  const lines = []
  const code = await check({ fetchImpl, env, log: (line) => lines.push(String(line)), argv: ['--check'] })
  return { code, out: lines.join('\n'), seen }
}
const runCommits = async (options = {}) => {
  const { fetchImpl, seen } = transport(options)
  const lines = []
  const code = await commits({ fetchImpl, env: { GITHUB_TOKEN: 'test-token' }, log: (line) => lines.push(String(line)), argv: ['--commits'] })
  return { code, out: lines.join('\n'), seen }
}

test('equal mains and an active ruleset with no bypass actor: exit 0', async () => {
  const { code, out } = await run({ forkSha: UP })
  assert.equal(code, 0)
  assert.match(out, new RegExp(`upstream main : ${UP}`))
  assert.match(out, new RegExp(`fork main     : ${UP}`))
  assert.match(out, /CHECK ok/)
})

test('a comparison that cannot be read fails the check, and the numbers still print', async () => {
  // #826 acceptance 1: an unreadable read is not an absent problem. The post-check runs right after
  // the two mains became the same commit, so a 5xx there must not read as a clean finish.
  const { code, out } = await run({ forkSha: UP, compareStatus: 502 })
  assert.equal(code, 1)
  assert.match(out, new RegExp(`upstream main : ${UP}`))
  assert.match(out, new RegExp(`fork main     : ${UP}`))
  assert.match(out, /ahead_by: unknown {2}behind_by: unknown {2}status: unknown/)
  assert.match(out, /CHECK FAILED — the comparison .*could not be read: HTTP 502/)
  assert.equal((out.match(/CHECK FAILED —/g) || []).length, 1)
})

test('a readable identical comparison keeps the equal-mains path green', async () => {
  // #826 acceptance 2: the negative control against "fail whenever status is unknown".
  const { code, out } = await run({ forkSha: UP, aheadBy: 0, behindBy: 0, status: 'identical' })
  assert.equal(code, 0)
  assert.match(out, /ahead_by: 0 {2}behind_by: 0 {2}status: identical/)
  assert.match(out, /CHECK ok/)
})

test('--commits exits 2 on a comparison it could not read, and --check fails the same fake', async () => {
  // #826 acceptance 3: the two commands keep their 0/1/2 contract on one and the same failure.
  const c = await runCommits({ forkSha: UP, compareStatus: 502 })
  assert.equal(c.code, 2)
  assert.match(c.out, /the comparison .*could not be read/)
  const k = await run({ forkSha: UP, compareStatus: 502 })
  assert.equal(k.code, 1)
})

test('the numbers are printed, not only the verdict', async () => {
  // #815 acceptance 8: ahead_by/behind_by have to be readable from the output. A run that reports
  // only "not equal" cannot say how far the fast-forward would move upstream.
  const { code, out } = await run({ forkSha: 'a'.repeat(40), aheadBy: 7, behindBy: 0, status: 'ahead' })
  assert.notEqual(code, 0)
  assert.match(out, /ahead_by: 7 {2}behind_by: 0 {2}status: ahead/)
})

test('a fork behind upstream is a failure: exit nonzero', async () => {
  const { code, out } = await run({ forkSha: 'b'.repeat(40), aheadBy: 0, behindBy: 2, status: 'behind' })
  assert.notEqual(code, 0)
  assert.match(out, /behind_by: 2/)
  assert.match(out, /CHECK FAILED/)
})

test('a ruleset that is not active is a failure: exit nonzero', async () => {
  const { code, out } = await run({ ruleset: { ...RULESET, enforcement: 'disabled' } })
  assert.notEqual(code, 0)
  assert.match(out, /enforcement=disabled/)
  assert.match(out, /not active/)
})

test('a ruleset with a bypass actor is a failure: exit nonzero', async () => {
  const { code, out } = await run({ ruleset: { ...RULESET, bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole' }] } })
  assert.notEqual(code, 0)
  assert.match(out, /bypass_actors=\["RepositoryRole:5"\]/)
  assert.match(out, /bypass actors/)
})

test('a ruleset read that answers 404 names the id and fails, and still prints the numbers', async () => {
  // The unreadable-ruleset path is where an operator most needs ahead_by: it must not be the one
  // path that drops the two SHAs (review of #37).
  const { code, out } = await run({ forkSha: 'c'.repeat(40), aheadBy: 4, behindBy: 0, rulesetStatus: 404 })
  assert.notEqual(code, 0)
  assert.match(out, new RegExp(`upstream main : ${UP}`))
  assert.match(out, /ahead_by: 4 {2}behind_by: 0/)
  assert.match(out, new RegExp(`ruleset ${DEFAULTS.rulesetId} cannot be read: HTTP 404`))
  assert.match(out, new RegExp(`ruleset ${DEFAULTS.rulesetId}: unreadable \\(HTTP 404\\)`))
  // One prefix, not two: the row says "unreadable", the failure line says which read failed.
  assert.doesNotMatch(out, new RegExp(`ruleset ${DEFAULTS.rulesetId}: ruleset ${DEFAULTS.rulesetId}`))
})

test('every request is a GET, and nothing goes anywhere but api.github.com', async () => {
  // #815 kill condition: automation that can push while the ruleset is off. The transport refuses a
  // non-GET outright, and the record is asserted here too.
  const { code, seen } = await run({ forkSha: UP })
  assert.equal(code, 0)
  assert.equal(seen.length, 4)
  for (const { url, method } of seen) {
    assert.equal(method, 'GET', `${method} ${url}`)
    assert.ok(url.startsWith('https://api.github.com/'), url)
  }
})

test('the box token variable is enough: DSH_SECRET_GITHUB_TOKEN alone', async () => {
  // The release window runs on a Bot box where GITHUB_TOKEN and GH_TOKEN are unset and only
  // DSH_SECRET_GITHUB_TOKEN carries the token. `--check` is what that window runs.
  const { code, out } = await run({ forkSha: UP }, { DSH_SECRET_GITHUB_TOKEN: 'box-token' })
  assert.equal(code, 0)
  assert.match(out, /CHECK ok/)
})

test('no token at all is a usage error, not a pass', async () => {
  const { fetchImpl } = transport({})
  const lines = []
  const code = await check({ fetchImpl, env: {}, log: (line) => lines.push(String(line)), argv: ['--check'] })
  assert.equal(code, 2)
  assert.match(lines.join('\n'), /no GITHUB_TOKEN, GH_TOKEN or DSH_SECRET_GITHUB_TOKEN/)
})

test('without a flag it prints usage and exits 2 without reading anything', async () => {
  const { fetchImpl, seen } = transport({})
  const lines = []
  const code = await check({ fetchImpl, env: { GITHUB_TOKEN: 't' }, log: (line) => lines.push(String(line)), argv: [] })
  assert.equal(code, 2)
  assert.equal(seen.length, 0)
  assert.match(lines.join('\n'), /usage:/)
})

test('--commits names what the fast-forward would carry, oldest first (#815 acceptance 1)', async () => {
  const { code, out } = await runCommits({ forkSha: 'd'.repeat(40), aheadBy: 2, behindBy: 0, status: 'ahead', commits: PUSHED })
  assert.equal(code, 0)
  assert.match(out, /ahead_by: 2 {2}behind_by: 0 {2}status: ahead/)
  assert.match(out, /the fast-forward would carry 2 commit\(s\), oldest first:/)
  const i = out.indexOf('1111111a')
  const j = out.indexOf('2222222b')
  assert.ok(i > 0 && j > i, 'the commits are listed in the order the comparison returned them')
  assert.match(out, /test\(ci\): pin the live-e2e key gates/)
  assert.match(out, /Add the RSI baseline reporter/)
})

test('--commits on two equal mains says there is nothing to push', async () => {
  const { code, out } = await runCommits({ forkSha: UP })
  assert.equal(code, 0)
  assert.match(out, /nothing to push/)
})
