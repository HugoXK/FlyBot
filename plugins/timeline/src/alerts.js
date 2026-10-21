// Durable alerts over the timeline window (#357/#469): a condition that stays true raises ONE
// alert (opened once, not every poll), and the alert resolves when the condition clears. The
// tracker is a small state machine the caller feeds each window; a panel or a routine reads the
// open set to see what is wrong and since when, instead of re-deriving it from the drawing on
// every request. Pure state over a window answer; it writes nothing and touches no Session.
const RESOLVED_KEPT = 50

/** The conditions a window is checked for. Each entry: a Bot predicate, kind and a detail line. */
const RULES = [
  {
    kind: 'errors',
    // A Bot that fails most of its turns (enough of them to mean something).
    of(bot) { return bot.turns >= 3 && bot.errors / bot.turns >= 0.5 ? `${bot.errors} of ${bot.turns} turns failed` : undefined },
  },
  {
    kind: 'waiting',
    // A Bot whose sent request has not been answered.
    of(bot) { return bot.waiting > 0 ? `${bot.waiting} request(s) unanswered` : undefined },
  },
  {
    kind: 'stuck',
    // A Bot involved in a request that has waited too long (from the longest open wait per side).
    of(bot, context) { const waited = context.stuckBy.get(bot.id); return waited !== undefined ? `a request has waited ${Math.round(waited / 60000)}m` : undefined },
  },
]

const keyOf = (botId, kind) => `${botId}\u0000${kind}`

/**
 * Builds the tracker. `evaluate(window)` folds one window into the alert set and resolves
 * `{ open, resolved, changed }`; `changed` names the alerts that opened or resolved this call.
 * A resolved alert is kept for a short while so a reader sees it cleared.
 */
export function createAlertTracker({ now = Date.now, stuckMs = 300_000 } = {}) {
  /** @type {Map<string, {id:string, kind:string, botId:string, name:string, since:number, detail:string}>} */
  const active = new Map()
  /** @type {{id:string, kind:string, botId:string, name:string, since:number, detail:string, at:number}[]} */
  const resolved = []

  const conditionsOf = (window) => {
    const lanes = new Map((window.lanes ?? []).map(lane => [lane.id, lane]))
    const waitingBy = new Map()
    for (const edge of window.edges ?? []) {
      if (edge?.unanswered > 0 && typeof edge.from === 'string') waitingBy.set(edge.from, (waitingBy.get(edge.from) ?? 0) + edge.unanswered)
    }
    const stuckBy = new Map()
    for (const arrow of window.exchanges ?? []) {
      if (arrow?.waiting !== true) continue
      const waited = Math.max(0, now() - (arrow.t ?? now()))
      if (waited < stuckMs) continue
      for (const side of [arrow.from, arrow.to]) if (typeof side === 'string') stuckBy.set(side, Math.max(stuckBy.get(side) ?? 0, waited))
    }
    const bots = (window.utilization ?? []).map(use => ({
      id: use.lane,
      name: lanes.get(use.lane)?.name ?? use.lane,
      turns: use.turns ?? 0,
      errors: use.errors ?? 0,
      running: use.running === true,
      waiting: waitingBy.get(use.lane) ?? 0,
    }))
    return { bots, context: { stuckBy } }
  }

  function evaluate(window = {}) {
    const { bots, context } = conditionsOf(window)
    const seen = new Set()
    const changed = []
    const at = now()
    for (const bot of bots) {
      for (const rule of RULES) {
        const detail = rule.of(bot, context)
        if (detail === undefined) continue
        const id = keyOf(bot.id, rule.kind)
        seen.add(id)
        const found = active.get(id)
        if (found === undefined) {
          const alert = { id, kind: rule.kind, botId: bot.id, name: bot.name, since: at, detail }
          active.set(id, alert)
          changed.push({ event: 'open', ...alert })
        } else if (found.detail !== detail || found.name !== bot.name) {
          active.set(id, { ...found, detail, name: bot.name })
          changed.push({ event: 'update', ...active.get(id) })
        }
      }
    }
    for (const [id, alert] of [...active]) {
      if (seen.has(id)) continue
      active.delete(id)
      const record = { ...alert, at }
      resolved.unshift(record)
      if (resolved.length > RESOLVED_KEPT) resolved.length = RESOLVED_KEPT
      changed.push({ event: 'resolve', ...record })
    }
    return { open: [...active.values()], resolved: resolved.slice(0, RESOLVED_KEPT), changed }
  }

  return { evaluate, open: () => [...active.values()] }
}
