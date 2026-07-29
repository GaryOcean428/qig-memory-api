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
//      passes, a credential explicitly allowed a namespace can write it, and
//      a MALFORMED restriction (non-null, non-array) fails CLOSED rather than
//      silently passing through as unrestricted.
//   3. Greps the tree for every sendInboxMessage( call site and asserts the
//      only two CREDENTIALED (HTTP-bearer-reachable) callers — the REST route
//      and the MCP inbox_send tool — pass allowedNamespaces, while the known
//      system-internal callers (council, task-runner, artifact-store,
//      daily-reviewer) intentionally do not.
//   4. lib/auth.js namespacesRestricted / namespacesPermit — the single
//      canonical predicate every INDIRECT-write guard (task creation/run,
//      council convene, artifact finalize) calls through to — is correct,
//      including fail-closed behavior on malformed input.
//   5. LIVE execution of the three guarded MCP tool `execute` functions
//      (task_create, council_convene, artifact_finalize): a namespaces:['general']
//      credential is denied by each BEFORE any heavy import/store write, and
//      (for task_create/artifact_finalize, which fail fast and deterministically
//      on the absent local Blob credentials rather than making a network call)
//      an unrestricted or explicitly-permitted credential is proved to get PAST
//      the guard — the resulting error is a downstream infra error, not the
//      guard's own. council_convene's ALLOW path is not executed live (it would
//      either make a real model-provider network call or require a Next.js
//      request context for its background after() path); its ALLOW behavior is
//      covered by the exhaustively-tested shared predicate (section 4) plus a
//      static proof the guard calls it (section 6).
//   6. Static-source audit that the REST route guards (POST /api/tasks, POST
//      /api/tasks/[id]/run, POST /api/council, POST /api/helper's canConvene,
//      POST /api/artifact/finalize) and the council_convene MCP guard are all
//      wired to the same lib/auth.js predicates tested in section 4.
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

// F4: a MALFORMED allowedNamespaces (non-null, non-array — a bug that hands
// the store a bad value, e.g. a stray string) must DENY, never silently
// behave like null/unrestricted.
await expectThrow(
  () => sendInboxMessage(baseMsg('qig'), { allowedNamespaces: 'qig' }),
  (e) => e?.code === 'namespace_forbidden' && e?.status === 403,
  'allowedNamespaces="qig" (malformed: a string, not an array) -> FAILS CLOSED, does not pass through as unrestricted',
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

// --- 4. namespacesRestricted / namespacesPermit contract (lib/auth.js) -----
//
// The single canonical predicate every INDIRECT-write guard calls through to
// (task creation/run, council convene, artifact finalize — none of these are
// the caller's own inbox_send, which section 2 already covers directly).

console.log('\n[4] namespacesRestricted / namespacesPermit contract (lib/auth.js)');
const { namespacesRestricted, namespacesPermit, isNamespaceRestricted, namespacePermits } = await import(
  pathToFileURL(join(root, 'lib', 'auth.js'))
);

ok('namespacesRestricted(null) === false (unrestricted)', namespacesRestricted(null) === false);
ok('namespacesRestricted(undefined) === false (unrestricted)', namespacesRestricted(undefined) === false);
ok("namespacesRestricted(['general']) === true", namespacesRestricted(['general']) === true);
ok('namespacesRestricted([]) === true (fail-closed empty allow-list is still a restriction)', namespacesRestricted([]) === true);
ok(
  'namespacesRestricted("qig") === true (malformed non-array non-null FAILS CLOSED as restricted, not treated as unrestricted)',
  namespacesRestricted('qig') === true,
);

ok('namespacesPermit(null, "qig") === true (unrestricted permits everything)', namespacesPermit(null, 'qig') === true);
ok("namespacesPermit(['qig','general'], 'qig') === true", namespacesPermit(['qig', 'general'], 'qig') === true);
ok("namespacesPermit(['general'], 'qig') === false", namespacesPermit(['general'], 'qig') === false);
ok('namespacesPermit([], "qig") === false (fail-closed empty allow-list permits nothing)', namespacesPermit([], 'qig') === false);
ok(
  'namespacesPermit("qig", "qig") === false (malformed non-array FAILS CLOSED even though the string literally equals the namespace)',
  namespacesPermit('qig', 'qig') === false,
);

// Principal-shaped wrappers used by the REST routes must delegate identically.
ok(
  'isNamespaceRestricted({namespaces:["general"]}) === true',
  isNamespaceRestricted({ namespaces: ['general'] }) === true,
);
ok('isNamespaceRestricted({namespaces:null}) === false', isNamespaceRestricted({ namespaces: null }) === false);
ok('isNamespaceRestricted({}) === false (no namespaces field at all -> unrestricted)', isNamespaceRestricted({}) === false);
ok(
  'namespacePermits({namespaces:["qig","general"]}, "qig") === true',
  namespacePermits({ namespaces: ['qig', 'general'] }, 'qig') === true,
);
ok(
  'namespacePermits({namespaces:["general"]}, "qig") === false',
  namespacePermits({ namespaces: ['general'] }, 'qig') === false,
);

// --- 5. Live execution of the guarded MCP tool `execute` functions ---------

console.log('\n[5] Live guard execution (lib/qig-tools.js toolDefs)');
const { toolDefs } = await import(pathToFileURL(join(root, 'lib', 'qig-tools.js')));

async function expectGuardThrow(execFn, args, ctx, guardTextMatch, label) {
  try {
    await execFn(args, ctx);
    ok(label, false, 'did not throw at all');
  } catch (error) {
    ok(label, guardTextMatch.test(String(error?.message || '')), `got: ${error?.message}`);
  }
}

async function expectPastGuard(execFn, args, ctx, guardTextMatch, label) {
  try {
    await execFn(args, ctx);
    // No local Blob credentials exist in this process, so a real success
    // (no throw at all) would be surprising, but is not itself proof of a
    // guard failure — only a GUARD-shaped error would be.
    ok(label, true, 'resolved (unexpected in this env, but proves the guard did not block it)');
  } catch (error) {
    const message = String(error?.message || '');
    ok(label, !guardTextMatch.test(message), `guard appears to have fired: ${message}`);
  }
}

// F1 — task_create: ANY restriction denies outright (the task runner's LLM
// loop holds an unrestricted inbox_send, so no allow-list can be trusted).
await expectGuardThrow(
  toolDefs.task_create.execute,
  { title: 't', instruction: 'i', schedule_kind: 'once' },
  { allowedNamespaces: ['general'] },
  /namespace-restricted credentials cannot create autonomous tasks/,
  'task_create: namespaces=["general"] -> DENIED (thrown before touching task-store)',
);
await expectPastGuard(
  toolDefs.task_create.execute,
  { title: 't', instruction: 'i', schedule_kind: 'once' },
  { allowedNamespaces: null },
  /namespace-restricted/,
  'task_create: namespaces=null -> PAST THE GUARD (fails downstream on the absent local Blob store, not on the namespace check)',
);

// Bonus finding (beyond the coordinator's F1-F4 list, closed in the same
// pass): task_update can rewrite an EXISTING task's instruction (or
// re-activate a cancelled one) with no guard, and the cron-driven runner that
// eventually executes it is unrestricted — the same class of bug as F1, via
// mutation instead of creation.
await expectGuardThrow(
  toolDefs.task_update.execute,
  { id: 'does-not-matter', instruction: 'rewritten' },
  { allowedNamespaces: ['general'] },
  /namespace-restricted credentials cannot update autonomous tasks/,
  'task_update: namespaces=["general"] -> DENIED (thrown before touching task-store)',
);
await expectPastGuard(
  toolDefs.task_update.execute,
  { id: 'does-not-matter', instruction: 'rewritten' },
  { allowedNamespaces: null },
  /namespace-restricted/,
  'task_update: namespaces=null -> PAST THE GUARD (fails downstream — not_found or the absent local Blob store, not the namespace check)',
);

// F2 — council_convene: DENIED live (throws before the heavy `./council`
// import, so this is safe/fast/no-network); ALLOW is proved via section 4's
// predicate tests + section 6's static wiring check below, NOT executed live
// (it would either make a real model-provider call or need a Next.js request
// context for its background after() path).
await expectGuardThrow(
  toolDefs.council_convene.execute,
  { question: 'q' },
  { allowedNamespaces: ['general'] },
  /namespace-restricted credentials without "qig" access cannot convene the council/,
  'council_convene: namespaces=["general"] -> DENIED (thrown before importing ./council at all)',
);

// F3 — artifact_finalize: same DENY/ALLOW-past-guard pattern as task_create.
await expectGuardThrow(
  toolDefs.artifact_finalize.execute,
  { name: 'verify-artifact', version: 'v1' },
  { allowedNamespaces: ['general'] },
  /namespace-restricted credentials without "qig" access cannot finalize artifacts/,
  'artifact_finalize: namespaces=["general"] -> DENIED (thrown before touching artifact-store)',
);
await expectPastGuard(
  toolDefs.artifact_finalize.execute,
  { name: 'verify-artifact', version: 'v1' },
  { allowedNamespaces: ['qig', 'general'] },
  /namespace-restricted/,
  'artifact_finalize: namespaces=["qig","general"] -> PAST THE GUARD (qig is allowed; fails downstream on the absent local Blob store)',
);

// --- 6. Static-source wiring audit: REST routes + the council MCP guard ----
//
// Proves each guard call site is wired to the SAME predicate exhaustively
// tested in section 4, not a local reimplementation that could drift.

console.log('\n[6] Static wiring audit (REST route guards + council_convene MCP guard)');

const tasksRouteSrc = readFileSync(join(root, 'app', 'api', 'tasks', 'route.js'), 'utf8');
ok(
  'POST /api/tasks denies via isNamespaceRestricted(principal)',
  /isNamespaceRestricted\(principal\)/.test(tasksRouteSrc),
);

const tasksRunRouteSrc = readFileSync(join(root, 'app', 'api', 'tasks', '[id]', 'run', 'route.js'), 'utf8');
ok(
  'POST /api/tasks/[id]/run denies via isNamespaceRestricted(auth.principal)',
  /isNamespaceRestricted\(auth\.principal\)/.test(tasksRunRouteSrc),
);

const tasksIdRouteSrc = readFileSync(join(root, 'app', 'api', 'tasks', '[id]', 'route.js'), 'utf8');
ok(
  'PATCH /api/tasks/[id] denies via isNamespaceRestricted(auth.principal) (bonus finding, closed alongside F1)',
  /isNamespaceRestricted\(auth\.principal\)/.test(tasksIdRouteSrc),
);
ok(
  'MCP task_update guard uses the shared namespacesRestricted(ctx.allowedNamespaces) predicate',
  (toolsSrc.match(/if \(namespacesRestricted\(ctx\.allowedNamespaces\)\)/g) || []).length === 2,
);

const councilRouteSrc = readFileSync(join(root, 'app', 'api', 'council', 'route.js'), 'utf8');
ok(
  'POST /api/council denies via namespacePermits(authorization.principal, "qig")',
  /!namespacePermits\(authorization\.principal,\s*'qig'\)/.test(councilRouteSrc),
);

const helperRouteSrc = readFileSync(join(root, 'app', 'api', 'helper', 'route.js'), 'utf8');
ok(
  'POST /api/helper gates canConvene on namespacePermits(writeCheck.principal, "qig")',
  /canConvene\s*=\s*!writeCheck\.error\s*&&\s*namespacePermits\(writeCheck\.principal,\s*'qig'\)/.test(helperRouteSrc),
);

const artifactFinalizeRouteSrc = readFileSync(join(root, 'app', 'api', 'artifact', 'finalize', 'route.js'), 'utf8');
ok(
  'POST /api/artifact/finalize denies via namespacePermits(authorization.principal, "qig")',
  /!namespacePermits\(authorization\.principal,\s*'qig'\)/.test(artifactFinalizeRouteSrc),
);

ok(
  'MCP council_convene guard uses the shared namespacesPermit(ctx.allowedNamespaces, "qig") predicate (same fn as section 4/5)',
  /if \(!namespacesPermit\(ctx\.allowedNamespaces, 'qig'\)\)/.test(toolsSrc),
);
ok(
  'MCP task_create guard uses the shared namespacesRestricted(ctx.allowedNamespaces) predicate',
  /if \(namespacesRestricted\(ctx\.allowedNamespaces\)\)/.test(toolsSrc),
);
ok(
  'MCP artifact_finalize guard uses the shared namespacesPermit(ctx.allowedNamespaces, "qig") predicate',
  (toolsSrc.match(/if \(!namespacesPermit\(ctx\.allowedNamespaces, 'qig'\)\)/g) || []).length === 2,
);

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
