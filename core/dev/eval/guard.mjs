// Grader isolation for the scenario runner (#398). An evaluation is only trustworthy if the Bot
// under test cannot read or change the grader, the specs, or the evidence. This hashes those
// files before and after a run and reports what changed, so a run whose rubric or fixtures were
// touched is marked invalid instead of believed. Pure file reads and a hash; no network.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const sha = buffer => createHash('sha256').update(buffer).digest('hex')

/** A `{ path: sha256 }` map for the files a run must not modify (rubrics, specs, fixtures). */
export function hashes(paths) {
  return Object.fromEntries(paths.map(path => [path, sha(readFileSync(path))]))
}

/** Compares two `hashes` maps. `{ ok, changed }`; `ok` is false when any file changed or vanished. */
export function unchanged(before, after) {
  const changed = []
  for (const [path, digest] of Object.entries(before)) {
    if (!(path in after)) changed.push(path)
    else if (after[path] !== digest) changed.push(path)
  }
  for (const path of Object.keys(after)) if (!(path in before)) changed.push(path)
  return { ok: changed.length === 0, changed }
}
