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
