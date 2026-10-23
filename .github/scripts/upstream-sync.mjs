// Is the fork's `main` on upstream's `main`, and is upstream's `main` ruleset still on? (#815)
//
//   node .github/scripts/upstream-sync.mjs --check
//   node .github/scripts/upstream-sync.mjs --commits
//
// `--check` answers "would the push be a fast-forward, and did the ruleset come back exactly as it
// was?". `--commits` lists what the fast-forward would carry, which is the preflight's third read:
// the window is one action, so the run that opens it has to be able to name the commits it moves.
//
// Read-only by construction: every request is a `GET`, and nothing here writes to either repository.
// The fast-forward itself is an agent step in [docs/release-runbook.md](../../docs/release-runbook.md).
//
// Exit 0 only when both `main` refs are the same commit and the ruleset is `active` with an empty
// `bypass_actors`. Anything else exits nonzero and names the condition that failed. Usage and read
// errors exit 2, so a caller can tell "the repository says no" from "I could not ask".
//
// The numbers are printed, not only the verdict (#815 acceptance 8): `ahead_by` is how far the
// fast-forward would move upstream, and a boolean throws that away. They print on the unreadable-
// ruleset path too, because that is the moment an operator most needs to know how far ahead the
// fork is.
//
// The token comes from the first of `GITHUB_TOKEN`, `GH_TOKEN`, `DSH_SECRET_GITHUB_TOKEN` that is
// set: the release window runs on a Bot box where the secret is only the last of those, and a
// `Bearer $GITHUB_TOKEN` there sends an empty string. Whichever variable answers has to carry admin
// on the upstream repository — a CI token reads the ruleset as 404.
//
// The ruleset id and both repositories are defaults with an environment override, because the
// runbook has to work from a Bot box where nothing is checked in about which fork is in use.
//
// Why a 404 from the ruleset endpoint is not "there is no ruleset": GitHub answers 404 for a
// resource the token may not administer, so a token without admin reads the same as a deleted
// ruleset. The message therefore names the id and says which read failed.

import { fileURLToPath } from 'node:url'

const API = 'https://api.github.com'

export const DEFAULTS = { upstream: 'ThinkFlowLab/FlyBot', fork: 'Birfy/FlyBot', rulesetId: '25173372' }

const short = (s) => String(s ?? '').slice(0, 12)
const tokenOf = (env) => env.GITHUB_TOKEN || env.GH_TOKEN || env.DSH_SECRET_GITHUB_TOKEN

// One read of everything both commands need: the two refs, the comparison, the ruleset.
async function load({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const upstream = env.UPSTREAM_REPO || DEFAULTS.upstream
  const fork = env.FORK_REPO || DEFAULTS.fork
  const rulesetId = env.RULESET_ID || DEFAULTS.rulesetId
  const token = tokenOf(env)
  if (!token) {
    return { code: 2, message: 'no GITHUB_TOKEN, GH_TOKEN or DSH_SECRET_GITHUB_TOKEN — this check only reads, but reads still need a token' }
  }
  const get = async (path) => {
    const res = await fetchImpl(API + path, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'upstream-sync' },
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json }
  }
  const refSha = async (repo) => {
    const r = await get(`/repos/${repo}/git/ref/heads/main`)
    if (r.status !== 200 || !r.json?.object?.sha) throw new Error(`cannot read ${repo} main: HTTP ${r.status}`)
    return r.json.object.sha
  }

  let upstreamSha, forkSha
  try {
    upstreamSha = await refSha(upstream)
    forkSha = await refSha(fork)
  } catch (e) {
    return { code: 2, message: String(e.message || e) }
  }

  // A comparison needs both commits to exist; a fork descendant of upstream always does.
  let aheadBy = 'unknown', behindBy = 'unknown', status = 'unknown', commits = null
  const compareUrl = `/repos/${upstream}/compare/${upstreamSha}...${forkSha}`
  const cmp = await get(compareUrl)
  const compareOk = cmp.status === 200 && cmp.json !== null
  if (compareOk) {
    aheadBy = cmp.json.ahead_by ?? 'unknown'
    behindBy = cmp.json.behind_by ?? 'unknown'
    status = cmp.json.status ?? 'unknown'
    commits = (cmp.json.commits || []).map((c) => ({ sha: c.sha, subject: String(c.commit?.message || '').split('\n')[0] }))
  }

  const r = await get(`/repos/${upstream}/rulesets/${rulesetId}`)
  const ruleset = r.status === 200
    ? {
        readFailed: false,
        enforcement: r.json.enforcement,
        bypassActors: (r.json.bypass_actors || []).map((a) => a.actor_type + (a.actor_id ? `:${a.actor_id}` : '')),
        canBypass: r.json.current_user_can_bypass ?? 'unknown',
      }
    : { readFailed: true, httpStatus: r.status }

  return { code: null, upstreamSha, forkSha, aheadBy, behindBy, status, commits, compareOk, compareStatus: cmp.status, compareUrl, ruleset, rulesetId }
}

export async function check({ fetchImpl = globalThis.fetch, env = process.env, log = console.log, argv = [] } = {}) {
  if (!argv.includes('--check')) {
    log('usage: node .github/scripts/upstream-sync.mjs --check | --commits')
    return 2
  }
  const s = await load({ fetchImpl, env })
  if (s.code) { log(s.message); return s.code }

  // The three lines every caller needs, printed before any branch can skip them: an unreadable
  // ruleset must not hide how far the fork is ahead.
  log(`upstream main : ${s.upstreamSha}`)
  log(`fork main     : ${s.forkSha}`)
  log(`ahead_by: ${s.aheadBy}  behind_by: ${s.behindBy}  status: ${s.status}`)

  const problems = []
  // An unreadable comparison is not an absent problem: when the two mains are already equal it is the
  // exactly wrong moment to report a clean finish without having asked how far apart they are (#826).
  if (!s.compareOk) {
    log(`comparison ${short(s.upstreamSha)}...${short(s.forkSha)}: unreadable (HTTP ${s.compareStatus})`)
    problems.push(`the comparison ${short(s.upstreamSha)}...${short(s.forkSha)} could not be read: HTTP ${s.compareStatus} from ${s.compareUrl}`)
  }
  if (s.ruleset.readFailed) {
    log(`ruleset ${s.rulesetId}: unreadable (HTTP ${s.ruleset.httpStatus})`)
    problems.push(`ruleset ${s.rulesetId} cannot be read: HTTP ${s.ruleset.httpStatus}`)
  } else {
    log(`ruleset ${s.rulesetId}: enforcement=${s.ruleset.enforcement} bypass_actors=${JSON.stringify(s.ruleset.bypassActors)} current_user_can_bypass=${s.ruleset.canBypass}`)
    if (s.ruleset.enforcement !== 'active') problems.push(`ruleset ${s.rulesetId} is ${s.ruleset.enforcement}, not active — main is unprotected`)
    if (s.ruleset.bypassActors.length) problems.push(`ruleset ${s.rulesetId} has bypass actors (${s.ruleset.bypassActors.join(', ')}), not the empty list the owner decided on`)
  }

  if (s.upstreamSha !== s.forkSha) {
    // Both directions are a failure: a fork behind upstream means the tree the release would be
    // built on is not upstream's, and a fork ahead is the normal state between a merge and the next
    // window. The numbers say which one it is, so the message carries them.
    problems.push(`fork main ${short(s.forkSha)} is not upstream main ${short(s.upstreamSha)} (ahead_by ${s.aheadBy}, behind_by ${s.behindBy}) — the fast-forward has not run, or the fork moved again after it`)
  }

  if (!problems.length) {
    log(`CHECK ok — both mains are ${short(s.upstreamSha)}, ruleset ${s.rulesetId} is active with no bypass actor`)
    return 0
  }
  for (const p of problems) log(`CHECK FAILED — ${p}`)
  return 1
}

// `--commits` is the preflight's third read (#815 acceptance 1): the window is one action, so the
// run that opens it names the commits it is about to move, not only a count.
export async function commits({ fetchImpl = globalThis.fetch, env = process.env, log = console.log, argv = [] } = {}) {
  if (!argv.includes('--commits')) {
    log('usage: node .github/scripts/upstream-sync.mjs --check | --commits')
    return 2
  }
  const s = await load({ fetchImpl, env })
  if (s.code) { log(s.message); return s.code }
  if (!s.commits) {
    log(`the comparison ${short(s.upstreamSha)}...${short(s.forkSha)} could not be read`)
    return 2
  }
  log(`upstream main : ${s.upstreamSha}`)
  log(`fork main     : ${s.forkSha}`)
  log(`ahead_by: ${s.aheadBy}  behind_by: ${s.behindBy}  status: ${s.status}`)
  if (s.upstreamSha === s.forkSha) {
    log('nothing to push — the two mains are the same commit')
    return 0
  }
  log(`the fast-forward would carry ${s.commits.length} commit(s), oldest first:`)
  for (const c of s.commits) log(`  ${short(c.sha)}  ${c.subject}`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  process.exit(argv.includes('--commits') ? await commits({ argv }) : await check({ argv }))
}
