// A scenario rubric and its check over a run's text (#358). Pure: no I/O, no model, no network.
// A rubric says what the text must contain, what it must not, and what must come before what.
// `check` is the deterministic half of the user-scenario runner; `judge.mjs` adds an optional
// model opinion on top, and `guard.mjs` keeps the rubric itself out of the Bot under test's reach
// (#398).

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A matcher is a RegExp, or a plain string read as a case-insensitive substring.
const matcherOf = (item) => (item instanceof RegExp ? item : new RegExp(escape(String(item)), 'i'))
const label = (item) => (item instanceof RegExp ? String(item) : String(item))
const matches = (hay, item) => matcherOf(item).test(hay)
const at = (hay, item) => hay.search(matcherOf(item))

/**
 * Checks `text` against a rubric `{ must?, mustNot?, order? }`.
 * - `must`: each has to appear (string = case-insensitive substring, or a RegExp).
 * - `mustNot`: none may appear.
 * - `order`: a list of `[first, second]` pairs; the first must appear before the second.
 * Resolves `{ pass, failures }`, failures a short human list. An empty rubric always passes.
 */
export function check(text, rubric = {}) {
  const hay = String(text ?? '')
  const failures = []
  for (const item of rubric.must ?? []) if (!matches(hay, item)) failures.push(`missing: ${label(item)}`)
  for (const item of rubric.mustNot ?? []) if (matches(hay, item)) failures.push(`forbidden: ${label(item)}`)
  for (const [first, second] of rubric.order ?? []) {
    const a = at(hay, first)
    const b = at(hay, second)
    if (a === -1) failures.push(`missing: ${label(first)}`)
    else if (b === -1) failures.push(`missing: ${label(second)}`)
    else if (a > b) failures.push(`out of order: ${label(first)} before ${label(second)}`)
  }
  return { pass: failures.length === 0, failures }
}
