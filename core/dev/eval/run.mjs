// Scenario runner (#358). Scores one run's text against one spec from `specs.mjs`.
//
//   node core/dev/eval/run.mjs --list
//   node core/dev/eval/run.mjs --spec P3-tree-split --text run.txt [--json results.json]
//
// With no judge model configured, grading is the deterministic rubric only and no network call
// is made. The spec file's hash is recorded with the result, so a grader the run could have
// touched is visible in the evidence (#398).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { check } from './rubric.mjs'
import { SPECS, specById } from './specs.mjs'
import { hashes } from './guard.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

export function run({ spec, text }) {
  const result = check(text, spec.rubric)
  return { spec: { id: spec.id, title: spec.title, journey: spec.journey }, ...result, specHash: hashes([`${HERE}specs.mjs`]) }
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    list: { type: 'boolean' }, spec: { type: 'string' }, text: { type: 'string' }, json: { type: 'string' },
  } })
  if (values.list) { for (const spec of SPECS) console.log(`${spec.id}\t${spec.title}`); return 0 }
  if (!values.spec || !values.text) { console.error('usage: node core/dev/eval/run.mjs --spec <id> --text <file> [--json out.json]'); return 2 }
  const spec = specById(values.spec)
  if (spec === null) { console.error(`unknown spec ${values.spec}; --list shows them`); return 2 }
  const result = run({ spec, text: readFileSync(values.text, 'utf8') })
  if (values.json) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.spec.id} ${result.spec.title}`)
  for (const failure of result.failures) console.log(`  - ${failure}`)
  return result.pass ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))
