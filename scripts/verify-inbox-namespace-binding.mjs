#!/usr/bin/env node
// Standalone proof for the inbox-namespace-to-credential binding (no test
// framework in this repo — see other scripts/ entries for the convention).
//
// Proves:
//   1. lib/api-keys.js normalizeNamespaces has the same null-means-unrestricted /
//      []-means-fail-closed contract as normalizeScopes.
//   2. lib/inbox-store.js sendInboxMessage enforces allowedNamespaces
//      server-side: a restricted credential cannot write outside its allowed
//      set (403 namespace_forbidden), an unrestricted one (null) always
//      passes, and a credential explicitly allowed a namespace can write it.
//   3. Greps the tree for every sendInboxMessage( call site and asserts the
//      only two CREDENTIALED (HTTP-bearer-reachable) callers — the REST route
//      and the MCP inbox_send tool — pass allowedNamespaces, while the known
//      system-internal callers (council, task-runner, artifact-store,
//      daily-reviewer) intentionally do not.
//
// Usage: node scripts/verify-inbox-namespace-binding.mjs

import { register } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Registered up-front (not just before section [2]): lib/api-keys.js itself
// imports lib/inbox-store.js (for INBOX_NAMESPACES) which imports
// ./private-blob with no extension — plain Node ESM needs the loader's
// extension-fallback hook for ANY dynamic import of this repo's lib/*.js
// files, not only the ones under direct test.
register('./verify-inbox-namespace-binding.loader.mjs', import.meta.url);

let failures = 0;
let passes = 0;

function ok(label, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectThrow(fn, matcher, label) {
  try {
    await fn();
    ok(label, false, 'did not throw');
  } catch (error) {
    ok(label, matcher(error), `got ${error?.code || error?.message}`);
  }
}

async function expectResolve(fn, label) {
  try {
    const result = await fn();
    ok(label, Boolean(result?.id), 'resolved without an envelope');
    return result;
  } catch (error) {
    ok(label, false, `threw ${error?.code || error?.message}`);
    return null;
  }
}

// --- 1. normalizeNamespaces ------------------------------------------------

console.log('\n[1] normalizeNamespaces contract (lib/api-keys.js)');
const { normalizeNamespaces } = await import(pathToFileURL(join(root, 'lib', 'api-keys.js')));

ok('undefined -> null (unrestricted, legacy-compatible)', normalizeNamespaces(undefined) === null);
ok('null -> null', normalizeNamespaces(null) === null);
ok(
  "['qig','bogus'] -> ['qig'] (invalid entries filtered)",
  JSON.stringify(normalizeNamespaces(['qig', 'bogus'])) === JSON.stringify(['qig']),
);
ok(
  '[] -> [] NOT null (fail-closed, explicit empty is not the same as omitted)',
  Array.isArray(normalizeNamespaces([])) && normalizeNamespaces([]).length === 0,
);
ok(
  "['qig','qig'] -> ['qig'] (deduped)",
  JSON.stringify(normalizeNamespaces(['qig', 'qig'])) === JSON.stringify(['qig']),
);
ok(
  "['bogus'] -> [] (all-invalid array still fails closed, not null)",
  Array.isArray(normalizeNamespaces(['bogus'])) && normalizeNamespaces(['bogus']).length === 0,
);

// --- 2. sendInboxMessage enforcement --------------------------------------

console.log('\n[2] sendInboxMessage server-side enforcement (lib/inbox-store.js)');
const { sendInboxMessage } = await import(pathToFileURL(join(root, 'lib', 'inbox-store.js')));

const baseMsg = (namespace) => ({
  from: 'verify-script',
  to: 'verify-target',
  namespace,
  type: 'test',
  subject: 'namespace binding proof',
  payload: { ok: true },
});

await expectThrow(
  () => sendInboxMessage(baseMsg('qig'), { allowedNamespaces: ['general'] }),
  (e) => e?.code === 'namespace_forbidden' && e?.status === 403,
  'allowedNamespaces=["general"] + namespace="qig" -> throws namespace_forbidden (403)',
);

await expectResolve(
  () => sendInboxMessage(baseMsg('qig'), { allowedNamespaces: null }),
  'allowedNamespaces=null (unrestricted) + namespace="qig" -> succeeds (calls through to the store)',
);

await expectResolve(
  () => sendInboxMessage(baseMsg('qig'), { allowedNamespaces: ['qig'] }),
  'allowedNamespaces=["qig"] + namespace="qig" -> succeeds',
);

await expectResolve(
  () => sendInboxMessage(baseMsg('general')),
  'no options arg at all (system-internal call shape) -> succeeds, unrestricted',
);

await expectThrow(
  () => sendInboxMessage(baseMsg('bsuite'), { allowedNamespaces: [] }),
  (e) => e?.code === 'namespace_forbidden' && e?.status === 403,
  'allowedNamespaces=[] (fail-closed key) + any namespace -> throws namespace_forbidden',
);

// Each successful send performs exactly 3 writes (ts-index, message, index —
// see lib/inbox-store.js sendInboxMessage). 3 sends succeeded above (qig/null,
// qig/["qig"], general/no-options) and 2 were rejected (qig/["general"],
// bsuite/[]) — the rejected ones must throw BEFORE touching the stub store at
// all, so the write count proves the check runs first, not just that it
// eventually rejects.
const writes = globalThis.__PRIVATE_BLOB_STUB__?.writes || [];
const messageWrites = writes.filter((w) => w.pathname.startsWith('inbox/') && !w.pathname.startsWith('inbox-'));
ok(
  'exactly the 3 successful sends reached the store; the 2 rejected sends wrote nothing (fail-BEFORE-write, not fail-after)',
  writes.length === 9 && messageWrites.length === 3 && !writes.some((w) => w.pathname.includes('/bsuite/')),
  `total writes=${writes.length}, message writes=${messageWrites.length}, pathnames=${JSON.stringify(writes.map((w) => w.pathname))}`,
);

// --- 3. Call-site audit -----------------------------------------------------

console.log('\n[3] sendInboxMessage( call-site audit (grep-proved, not asserted)');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git' || entry === 'scripts') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

// scripts/ is excluded from the walk (it would otherwise match this very
// script's own source text), but app/ and lib/ — every real call-site
// location — are covered.
const files = walk(root);
const siteRe = /sendInboxMessage\(/g;
const callSites = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!siteRe.test(src)) continue;
  siteRe.lastIndex = 0;
  let match;
  while ((match = siteRe.exec(src))) {
    const upto = src.slice(0, match.index + match[0].length);
    const line = upto.split('\n').length;
    // Skip the function's own definition/declaration line.
    const lineText = src.split('\n')[line - 1];
    if (/^export async function sendInboxMessage/.test(lineText.trim())) continue;
    callSites.push({ file: file.replace(root + '/', ''), line });
  }
}

const credentialedExpected = new Set(['app/api/inbox/route.js', 'lib/qig-tools.js']);
const systemInternalExpected = new Set(['lib/council.js', 'lib/task-runner.js', 'lib/artifact-store.js', 'lib/daily-reviewer.js']);

let siteFailures = 0;
for (const { file, line } of callSites) {
  const label = `${file}:${line}`;
  if (credentialedExpected.has(file)) {
    console.log(`  CREDENTIALED  ${label}  (must pass allowedNamespaces)`);
  } else if (systemInternalExpected.has(file)) {
    console.log(`  SYSTEM        ${label}  (intentionally unrestricted)`);
  } else {
    console.log(`  UNKNOWN       ${label}  <-- not in the reviewed set, inspect manually`);
    siteFailures += 1;
  }
}
ok(
  'every sendInboxMessage( call site is accounted for (credentialed or reviewed system-internal)',
  siteFailures === 0,
  `${siteFailures} unreviewed site(s)`,
);

// Static-source proof that the two credentialed sites actually pass the option
// (the audit above only proves file location, not that the option is wired).
const restRouteSrc = readFileSync(join(root, 'app', 'api', 'inbox', 'route.js'), 'utf8');
ok(
  'app/api/inbox/route.js POST passes allowedNamespaces from the resolved principal',
  /sendInboxMessage\(await req\.json\(\),\s*\{\s*allowedNamespaces:\s*authorization\.principal\?\.namespaces/.test(
    restRouteSrc.replace(/\n\s*/g, ' '),
  ),
);
const toolsSrc = readFileSync(join(root, 'lib', 'qig-tools.js'), 'utf8');
ok(
  'lib/qig-tools.js inbox_send.execute passes ctx.allowedNamespaces into sendInboxMessage',
  /sendOptions = \{ allowedNamespaces: ctx\?\.allowedNamespaces \}/.test(toolsSrc) &&
    (toolsSrc.match(/sendInboxMessage\([^)]*sendOptions\)/g) || []).length === 2,
);
const mcpRouteSrc = readFileSync(join(root, 'app', 'api', 'mcp', 'route.js'), 'utf8');
ok(
  'app/api/mcp/route.js forwards principal.namespaces into the tool execute ctx',
  /allowedNamespaces:\s*principal\?\.namespaces/.test(mcpRouteSrc),
);

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
