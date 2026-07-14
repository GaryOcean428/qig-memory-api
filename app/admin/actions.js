'use server';

import { requireSession } from '../../lib/session';
import {
  getMemory,
  putMemory,
  postMemory,
  listMemory,
  searchMemory,
  deleteMemory,
  syncKernel,
  listKernelAgents,
  ContentTooLargeError,
  MAX_CONTENT_BYTES,
} from '../../lib/memory-store';
import { listApiKeys, createApiKey, revokeApiKey } from '../../lib/api-keys';
import { listOAuthClients, setClientAccess } from '../../lib/mcp-oauth-store';
import { getReviewerConfig, saveReviewerConfig, getLatestReport } from '../../lib/reviewer-config';
import { runDailyReview } from '../../lib/daily-reviewer';

// Every action authenticates via the OAuth session before touching the store.
// These run server-side, so they use the shared lib directly — no public REST
// round-trip and no bearer token in the browser.

export async function loadKeyIndexAction() {
  await requireSession();
  const { records, key_count, complete } = await listMemory({ keysOnly: true });
  // Sort newest-first for a sensible default browse order.
  const keys = records
    .slice()
    .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  return { keys, key_count, complete };
}

export async function getRecordAction(key) {
  await requireSession();
  const record = await getMemory(key);
  return record ? { key, ...record } : null;
}

export async function searchRecordsAction({ query, category, limit = 50 } = {}) {
  await requireSession();
  return searchMemory({ query, category, limit });
}

export async function saveRecordAction(key, { content, category, source }) {
  await requireSession();
  try {
    const rec = await putMemory(key, { content, category, source });
    return { ok: true, record: rec };
  } catch (err) {
    if (err instanceof ContentTooLargeError) {
      return { ok: false, error: 'content_too_large', max_bytes: MAX_CONTENT_BYTES, got_bytes: err.bytes };
    }
    console.log('[v0] saveRecordAction error:', err?.message);
    return { ok: false, error: 'save_failed' };
  }
}

export async function adjustUsefulnessAction(key, delta) {
  await requireSession();
  const rec = await postMemory(key, { usefulness_delta: delta });
  return rec ?? { error: 'not_found', key };
}

export async function deleteRecordAction(key) {
  await requireSession();
  const deleted = await deleteMemory(key);
  return { deleted, key };
}

export async function loadKernelMeshAction(agentId) {
  await requireSession();
  const [agents, sync] = await Promise.all([listKernelAgents(), syncKernel(agentId)]);
  return { agent_ids: Object.keys(agents), ...sync };
}

// --- API key management (session-gated) --------------------------------------
// The plaintext token is returned to the browser ONLY here, at creation, and is
// never persisted — the store keeps just a SHA-256 hash. The caller must show
// it once and let the admin copy it.

export async function listApiKeysAction() {
  await requireSession();
  return listApiKeys();
}

export async function createApiKeyAction(label) {
  const session = await requireSession();
  const createdBy = session.user?.username || session.user?.email || session.user?.name || null;
  return createApiKey({ label, createdBy });
}

export async function revokeApiKeyAction(id) {
  await requireSession();
  const revoked = await revokeApiKey(id);
  return { revoked, id };
}

export async function listOAuthClientsAction() {
  await requireSession();
  return listOAuthClients();
}

export async function setOAuthClientAccessAction(clientId, mode) {
  const session = await requireSession();
  const approvedBy = session.user?.username || session.user?.email || session.user?.name || null;
  return setClientAccess(clientId, mode, approvedBy);
}

// --- Daily reviewer (session-gated) ------------------------------------------
// Config (nominated repos + science topics) and the latest report are loaded for
// the admin panel; saves are validated in saveReviewerConfig. A manual run reuses
// the exact same orchestrator the cron uses, so behavior can't drift between them.

export async function loadReviewerAction() {
  await requireSession();
  const [config, latestReport] = await Promise.all([getReviewerConfig(), getLatestReport()]);
  return { config, latestReport };
}

export async function saveReviewerConfigAction(patch) {
  await requireSession();
  try {
    const config = await saveReviewerConfig(patch);
    return { ok: true, config };
  } catch (err) {
    console.log('[v0] saveReviewerConfigAction error:', err?.message);
    return { ok: false, error: 'invalid_config' };
  }
}

export async function runDailyReviewNowAction() {
  await requireSession();
  try {
    const result = await runDailyReview({ trigger: 'manual' });
    return result;
  } catch (err) {
    console.log('[v0] runDailyReviewNowAction error:', err?.message);
    return { ok: false, error: err?.message || 'run_failed' };
  }
}

// --- Doctrine management (session-gated) --------------------------------------
// The council and agents read doctrine from fixed memory keys, so uploading a
// newer UCP / principles / council-prompt version through the UI takes effect
// immediately — no redeploy. Only these three slots are writable here; general
// record edits go through the memory browser.

const DOCTRINE_KEYS = new Set(['qig_doctrine_ucp', 'qig_doctrine_principles', 'qig_doctrine_council']);

export async function loadDoctrineAction() {
  await requireSession();
  const entries = await Promise.all(
    [...DOCTRINE_KEYS].map(async (key) => {
      const record = await getMemory(key);
      if (!record) return [key, null];
      const content = typeof record.content === 'string' ? record.content : JSON.stringify(record.content);
      return [key, {
        source: record.source || null,
        updated: record.updated || null,
        bytes: Buffer.byteLength(content, 'utf8'),
        preview: content.slice(0, 400),
      }];
    }),
  );
  return Object.fromEntries(entries);
}

export async function saveDoctrineAction(key, { content, versionNote } = {}) {
  const session = await requireSession();
  if (!DOCTRINE_KEYS.has(key)) return { ok: false, error: 'invalid_doctrine_key' };
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) return { ok: false, error: 'empty_content' };
  const uploadedBy = session.user?.username || session.user?.email || session.user?.name || 'admin';
  const note = String(versionNote || '').trim().slice(0, 300);
  try {
    const record = await putMemory(key, {
      category: 'doctrine',
      content: text,
      source: `${note || 'updated via admin UI'} — uploaded by ${uploadedBy} ${new Date().toISOString().slice(0, 10)}`,
      usefulness: 5,
    });
    return { ok: true, updated: record.updated, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (err) {
    if (err instanceof ContentTooLargeError) {
      return { ok: false, error: 'content_too_large', max_bytes: MAX_CONTENT_BYTES, got_bytes: err.bytes };
    }
    console.log('[v0] saveDoctrineAction error:', err?.message);
    return { ok: false, error: 'save_failed' };
  }
}
