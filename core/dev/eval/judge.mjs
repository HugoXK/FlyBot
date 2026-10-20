// The optional model half of the scenario runner (#358). Deterministic `rubric.js` answers
// pass/fail; a judge answers "does this run actually satisfy the journey", which no substring
// can. It is off by default: a run makes no network call unless a judge model is configured, and
// the caller passes its own `ask` (so this module needs no model client of its own).
import { check } from './rubric.mjs'

export const JUDGE_SYSTEM = 'You grade one recorded run of a Bot team against a journey. Answer with JSON only: {"pass": true|false, "reasons": ["…"]}. Be strict: a run that misses a step, or that shows an error, fails.'

/** The prompt a judge model receives for one spec and its run text (capped). */
export function judgePrompt(spec, text) {
  const checklist = [
    ...(spec.rubric.must ?? []).map(item => `- must show: ${item}`),
    ...(spec.rubric.mustNot ?? []).map(item => `- must not show: ${item}`),
  ].join('\n')
  return {
    system: JUDGE_SYSTEM,
    prompt: `Journey: ${spec.title}\nChecklist:\n${checklist}\n\nRun:\n${String(text).slice(0, 6000)}\n\nDid the run satisfy the journey?`,
  }
}

/** A judge's answer as `{ pass, reasons }`, or undefined when it is not well formed. */
export function parseVerdict(text) {
  const start = String(text ?? '').indexOf('{')
  const end = String(text ?? '').lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let value
  try { value = JSON.parse(String(text).slice(start, end + 1)) } catch { return undefined }
  if (value === null || typeof value !== 'object' || typeof value.pass !== 'boolean') return undefined
  const reasons = Array.isArray(value.reasons) ? value.reasons.filter(r => typeof r === 'string').slice(0, 8) : []
  return { pass: value.pass, reasons }
}

/**
 * Grades one run: the deterministic check first, then — only if `ask` is given — the judge.
 * Resolves `{ id, title, pass, failures, judged }`. A missing or unclear judge answer never turns
 * a failing deterministic check into a pass.
 */
export async function grade(spec, text, { ask } = {}) {
  const deterministic = check(text, spec.rubric)
  let judged
  if (typeof ask === 'function') {
    const verdict = parseVerdict((await ask(judgePrompt(spec, text)))?.text)
    if (verdict !== undefined) judged = verdict
  }
  const pass = deterministic.pass && (judged === undefined || judged.pass)
  return { id: spec.id, title: spec.title, pass, failures: deterministic.failures, ...(judged ? { judged } : {}) }
}
