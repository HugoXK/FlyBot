// The delegation plan (#TBD): a coordinator Bot's split of a task into parts, and the
// progress its children report back. It lives in the coordinator's own field
// `flybot-tree/plan`, so the tree view and the coordinator's prompt can show it, and a child
// reports through its parent edge without any new messaging.
//
// Pure: makePlan validates and normalizes, reportPart applies one report, planLine words the
// one-line view that goes into the coordinator's prompt. Nothing here touches storage.
export const PLAN_KEY = 'plan'
export const PLAN_MAX_PARTS = 12
const STATUSES = ['todo', 'doing', 'done', 'blocked']
export const PLAN_STATUSES = Object.freeze(STATUSES)
const GOAL_MAX = 300
const NAME_MAX = 60
const NOTE_MAX = 200

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const norm = value => clean(value).toLowerCase()
const statusOf = value => (STATUSES.includes(String(value ?? '').toLowerCase()) ? String(value).toLowerCase() : undefined)

/**
 * A new plan from the model's arguments. `parts` is a list of names, or `{ name, owner? }`.
 * Resolves `{ plan }` or `{ error }`. Each part gets a stable id `p1`… so a report can name it.
 */
export function makePlan({ goal, parts }, now = Date.now) {
  const cleanGoal = clean(goal).slice(0, GOAL_MAX)
  if (cleanGoal === '') return { error: 'a plan needs a goal' }
  if (!Array.isArray(parts) || parts.length === 0) return { error: 'a plan needs at least one part' }
  if (parts.length > PLAN_MAX_PARTS) return { error: `a plan holds at most ${PLAN_MAX_PARTS} parts` }
  const seen = new Set()
  const out = []
  for (const [index, raw] of parts.entries()) {
    const name = clean(typeof raw === 'string' ? raw : raw?.name).slice(0, NAME_MAX)
    const owner = clean(typeof raw === 'object' ? raw?.owner : '').slice(0, NAME_MAX)
    if (name === '') return { error: `part ${index + 1} needs a name` }
    if (seen.has(norm(name))) return { error: `two parts are named "${name}"` }
    seen.add(norm(name))
    out.push({ id: `p${index + 1}`, name, ...(owner ? { owner } : {}), status: 'todo' })
  }
  return { plan: { goal: cleanGoal, parts: out, at: now() } }
}

/**
 * Applies one report to a plan. `part` matches a part id (`p2`) or its name. Resolves
 * `{ plan, part }` or `{ error }`. The plan is copied, never mutated in place.
 */
export function reportPart(plan, { part, status, note }, now = Date.now) {
  if (plan === undefined || plan === null || !Array.isArray(plan.parts)) return { error: 'there is no plan to report on' }
  const wanted = norm(part)
  if (wanted === '') return { error: 'name the part to report on (its id or its name)' }
  const at = plan.parts.find(item => item.id === String(part).trim() || norm(item.name) === wanted)
  if (at === undefined) return { error: `no part in the plan is "${clean(part)}"` }
  const next = statusOf(status)
  if (next === undefined) return { error: `status must be one of ${STATUSES.join(', ')}` }
  const cleanNote = clean(note).slice(0, NOTE_MAX)
  const updated = { ...at, status: next, ...(cleanNote ? { note: cleanNote } : {}), at: now() }
  const parts = plan.parts.map(item => (item === at ? updated : item))
  return { plan: { ...plan, parts, at: now() }, part: updated }
}

/**
 * The one-line prompt view: how far the plan is, and what is still open. Undefined when
 * there is no plan. `blocked` parts are called out so a stuck part is not missed.
 */
export function planLine(plan) {
  if (plan === undefined || plan === null || !Array.isArray(plan.parts) || plan.parts.length === 0) return undefined
  const done = plan.parts.filter(item => item.status === 'done').length
  const blocked = plan.parts.filter(item => item.status === 'blocked')
  const open = plan.parts.filter(item => item.status !== 'done')
  const head = `Your delegation plan for "${plan.goal}" (${done}/${plan.parts.length} done).`
  if (open.length === 0) return `${head} Every part is done; combine their results.`
  const shown = open.slice(0, PLAN_MAX_PARTS).map(item => `${item.name} [${item.status}${item.owner ? ` · ${item.owner}` : ''}]`).join('; ')
  const stuck = blocked.length > 0 ? ` Blocked: ${blocked.map(item => item.name).join(', ')}.` : ''
  return `${head} Still open: ${shown}.${stuck}`
}
