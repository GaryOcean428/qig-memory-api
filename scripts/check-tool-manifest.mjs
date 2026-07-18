#!/usr/bin/env node
// Fails CI when the MCP/agent tool surface drifts from the committed manifest.
//
// `lib/qig-tools.js` `toolDefs` is the SINGLE canonical list of tools the MCP
// server and the in-app agent expose; `READ_ONLY_TOOL_NAMES` is a second surface
// that classifies each. When a tool is added, renamed, or reclassified without
// updating `docs/tool-manifest.json`, this check fails — the forcing function
// that reminds the author the doc (references/mcp.md in the skills repo) and the
// manifest need to move together.
//
// It STATICALLY parses the source (regex over the export blocks) rather than
// importing the module: qig-tools.js pulls in the blob store and gateway
// clients, which must not be evaluated in CI with no credentials.
//
// Usage:
//   node scripts/check-tool-manifest.mjs           # verify (exit 1 on drift)
//   node scripts/check-tool-manifest.mjs --write    # regenerate the manifest

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_SRC = join(root, 'lib', 'qig-tools.js');
const MANIFEST = join(root, 'docs', 'tool-manifest.json');

// Slice `export const toolDefs = { ... }` up to the next top-level `export`, then
// take every 2-space-indented `name: {` — the tool entries. Nested keys sit at
// deeper indentation, so they are not matched.
function extractToolNames(src) {
  const start = src.indexOf('export const toolDefs = {');
  if (start === -1) throw new Error('toolDefs export not found in lib/qig-tools.js');
  const rest = src.slice(start + 'export const toolDefs = {'.length);
  const end = rest.indexOf('\nexport ');
  const block = end === -1 ? rest : rest.slice(0, end);
  const names = [];
  for (const line of block.split('\n')) {
    const m = /^ {2}([a-z_][a-z0-9_]*): \{/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

// Pull the quoted names out of `export const READ_ONLY_TOOL_NAMES = new Set([ ... ])`.
function extractReadOnly(src) {
  const start = src.indexOf('export const READ_ONLY_TOOL_NAMES = new Set([');
  if (start === -1) throw new Error('READ_ONLY_TOOL_NAMES export not found in lib/qig-tools.js');
  const rest = src.slice(start);
  const end = rest.indexOf(']);');
  if (end === -1) throw new Error('READ_ONLY_TOOL_NAMES set is not closed with ]);');
  const block = rest.slice(0, end);
  return new Set([...block.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]));
}

// read (in the read-only set) | admin (memory_delete) | write (everything else).
// Mirrors the scope the MCP route enforces per tool.
function classify(name, readOnly) {
  if (name === 'memory_delete') return 'admin';
  return readOnly.has(name) ? 'read' : 'write';
}

function buildManifest(src) {
  const names = extractToolNames(src);
  const readOnly = extractReadOnly(src);
  const tools = {};
  for (const name of [...names].sort()) tools[name] = classify(name, readOnly);
  return {
    _comment:
      'GENERATED from lib/qig-tools.js by scripts/check-tool-manifest.mjs. Do not edit by hand — run `npm run check:tools -- --write` and update references/mcp.md in the skills repo to match.',
    tool_count: names.length,
    tools,
  };
}

const src = readFileSync(TOOLS_SRC, 'utf8');
const expected = buildManifest(src);
const write = process.argv.includes('--write');

if (write) {
  writeFileSync(MANIFEST, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`Wrote ${MANIFEST} — ${expected.tool_count} tools.`);
  process.exit(0);
}

let current;
try {
  current = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (err) {
  console.error(`Could not read ${MANIFEST}: ${err.message}`);
  console.error('Run: npm run check:tools -- --write');
  process.exit(1);
}

const expectedStr = JSON.stringify(expected.tools);
const currentStr = JSON.stringify(current.tools || {});
if (expectedStr === currentStr && current.tool_count === expected.tool_count) {
  console.log(`tool manifest OK — ${expected.tool_count} tools in sync.`);
  process.exit(0);
}

// Report exactly what drifted so the fix is obvious.
const expNames = new Set(Object.keys(expected.tools));
const curNames = new Set(Object.keys(current.tools || {}));
const added = [...expNames].filter((n) => !curNames.has(n));
const removed = [...curNames].filter((n) => !expNames.has(n));
const reclassified = [...expNames]
  .filter((n) => curNames.has(n) && expected.tools[n] !== current.tools[n])
  .map((n) => `${n} (${current.tools[n]} -> ${expected.tools[n]})`);

console.error('Tool manifest is OUT OF DATE with lib/qig-tools.js.\n');
if (added.length) console.error(`  Added tools:        ${added.join(', ')}`);
if (removed.length) console.error(`  Removed tools:      ${removed.join(', ')}`);
if (reclassified.length) console.error(`  Reclassified:       ${reclassified.join(', ')}`);
console.error('\nRegenerate and update the docs:');
console.error('  npm run check:tools -- --write');
console.error('  # then update references/mcp.md in the qig-agent-comms skill to match.');
process.exit(1);
