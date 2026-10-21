// Model-based clustering (#450 item 2). The tree's rules (src/roles.js) place a Bot by the
// words in its name, role label, description and recent tools. When those words say nothing
// (a role described in another language, a job title the small vocabulary does not hold, a
// one-line brief), the Bot fits no group and stays outside the tree. This asks the sanctioned
// plugin model call (#518) for a single category and remembers it, so the next reorganization
// can group the Bot by meaning instead of by keyword.
//
// Opt-in twice over: the tree must be configured for it (config.modelClassify: true) AND the
// host must allow-list this plugin in flybot.modelPlugins. With either missing, askModel
// answers { ok: false, code: 'no-api' | 'not-allowed' } and the Bot keeps its rules profile.
import { DOMAINS } from './roles.js'

export const CLASSIFY_FIELD = 'modelDomain'
const DOMAIN_IDS = DOMAINS.map(domain => domain.id)
const SYSTEM = `You label one assistant Bot for a team. Given its name, role label and description, reply with the single best category id from this list, or "none": ${DOMAIN_IDS.join(', ')}. Reply with the id only, no other words.`

// What the answer was derived from: re-ask only when this changes, so an unchanged Bot is
// classified once.
export const fingerprint = (info) => [info.name, info.role ?? '', info.treeRole ?? '', String(info.prompt ?? '').slice(0, 600)].join('\n')

/**
 * The category in a model answer, or `null` for an explicit "none", or `undefined` when the
 * answer names nothing we know (so a stray sentence never overwrites a good label).
 */
export function parseDomain(text) {
  const answer = String(text ?? '').trim().toLowerCase()
  if (answer === '') return undefined
  const hit = DOMAIN_IDS.find(id => answer === id || answer.startsWith(`${id}\n`) || answer.startsWith(`${id} `))
  if (hit !== undefined) return hit
  if (answer === 'none' || answer.startsWith('none ')) return null
  return undefined
}

/**
 * A classifier over fd (src/adapter.js). `classifyBot(id)` asks for a Bot's category when it is
 * a tree member whose role text changed since the last answer, stores it in the Bot's own
 * `modelDomain` field, and resolves the stored record (or undefined when nothing changed).
 * A failed or unparsable call keeps the previous record; it never clears a good label.
 */
export function createModelClassifier({ fb, now = Date.now }) {
  async function classifyBot(id) {
    const bot = fb.getBot(id)
    if (bot === undefined) return undefined
    const info = { name: bot.name, role: bot.role, treeRole: fb.getField(id, 'treeRole'), prompt: '' }
    const fp = fingerprint(info)
    const cached = fb.getField(id, CLASSIFY_FIELD)
    if (cached !== undefined && cached !== null && cached.fp === fp) return cached
    const asked = await fb.askModel({
      system: SYSTEM,
      prompt: `Name: ${info.name}\nRole: ${info.role ?? ''}\nDescription: ${info.treeRole ?? ''}`,
      maxTokens: 8,
    })
    if (asked?.ok !== true) return cached ?? undefined
    const domain = parseDomain(asked.text)
    if (domain === undefined) return cached ?? undefined
    const record = { domain, fp, at: now() }
    fb.setField(id, CLASSIFY_FIELD, record)
    return record
  }
  return { classifyBot }
}
