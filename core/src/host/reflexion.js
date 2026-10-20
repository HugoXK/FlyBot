// Reflexion (#TBD): a Bot learns from a failure that repeats. The feed and turns.js already
// see every failed tool call and every failed model turn; this module decides when such a
// failure has happened often enough to become a lasting note, and words that note.
//
// It is process-local and pure: nothing is persisted here. The note goes through the ordinary
// memory path (src/host/memory.js), so it is size-capped, secret-scanned, visible in the panel
// and removable with forget — the same rules as any other memory entry.
//
// A note is written at most once per signature per cooldown: a Bot stuck retrying a broken
// tool must not fill its memory with the same line.
export const DEFAULT_REFLEXION = Object.freeze({ threshold: 3, windowMs: 10 * 60 * 1000, cooldownMs: 24 * 60 * 60 * 1000, maxBots: 200 })

/**
 * Tracks failures per Bot and signature. `hit(botId, signature)` records one failure at `now`
 * and resolves true when it is the one that crosses `threshold` inside `windowMs` and no note
 * for that signature was produced within `cooldownMs`.
 */
export function createReflexionTracker({ now = Date.now, ...options } = {}) {
  const { threshold, windowMs, cooldownMs, maxBots } = { ...DEFAULT_REFLEXION, ...options }
  /** @type {Map<string, Map<string, number[]>>} */
  const failures = new Map()
  /** @type {Map<string, number>} */
  const noted = new Map()
  return {
    hit(botId, signature) {
      if (typeof botId !== 'string' || botId === '' || typeof signature !== 'string' || signature === '') return false
      const time = now()
      let bySignature = failures.get(botId)
      if (bySignature === undefined) {
        failures.set(botId, bySignature = new Map())
        if (failures.size > maxBots) failures.delete(failures.keys().next().value)
      }
      const recent = (bySignature.get(signature) ?? []).filter(at => time - at < windowMs)
      recent.push(time)
      if (recent.length < threshold) { bySignature.set(signature, recent); return false }
      const key = `${botId}\u0000${signature}`
      if (time - (noted.get(key) ?? -Infinity) < cooldownMs) { bySignature.set(signature, recent); return false }
      noted.set(key, time)
      bySignature.delete(signature)
      return true
    },
  }
}

/**
 * The note a signature becomes, or undefined for one it does not know. Kept short and
 * actionable: it tells the Bot what to do differently, not what went wrong.
 */
export function lessonText(signature) {
  if (signature.startsWith('tool:')) {
    const tool = signature.slice('tool:'.length).trim().slice(0, 60)
    if (tool === '') return undefined
    return `The tool "${tool}" has failed several times in a row. When it fails, stop retrying it in a loop: tell the user what happened and try a different way, or ask.`
  }
  if (signature.startsWith('model:')) {
    const code = signature.slice('model:'.length).trim().slice(0, 40)
    return `A model call has failed repeatedly${code ? ` (${code})` : ''}. When that happens, tell the user plainly and wait instead of retrying in a loop.`
  }
  return undefined
}
