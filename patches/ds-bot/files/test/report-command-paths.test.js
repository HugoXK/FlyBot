import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPORT = join(ROOT, 'docs', 'reports', '2026-10-26-turn-input-split.md')

// Every `node <script> ...` token a report prints, with the line it sits on, so a
// reader who copies a command gets one the tree can actually run.
function nodeCommands(text) {
  const found = []
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\bnode\s+([\w./-]+\.(?:mjs|cjs|js))\b/g)) {
      found.push({ line: index + 1, path: match[1] })
    }
  })
  return found
}

test('the node-command reader finds a script and its line', () => {
  assert.deepEqual(nodeCommands('run: node dev/x.mjs --flag'), [{ line: 1, path: 'dev/x.mjs' }])
  // A bare interpreter invocation with no script after it is not a command path.
  assert.deepEqual(nodeCommands('node --version'), [])
})

test('every node command in the turn-split report names a script that exists at the tree root', () => {
  const commands = nodeCommands(readFileSync(REPORT, 'utf8'))
  assert.ok(commands.length > 0, 'the report prints at least one node command; finding none proves nothing')

  const missing = commands
    .filter((command) => !existsSync(join(ROOT, command.path)) || !statSync(join(ROOT, command.path)).isFile())
    .map((command) => `line ${command.line}: node ${command.path}`)
  assert.deepEqual(missing, [], `commands the report prints but the tree cannot run:\n${missing.join('\n')}`)
})
