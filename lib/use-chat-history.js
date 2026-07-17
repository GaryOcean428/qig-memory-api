'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Chat history for the session-gated helper agent. Threads live SERVER-SIDE
// (chat/<user>/<threadId>.json in the private store) so a conversation started
// on a phone is there on a laptop. Shape:
//   { id, title, messages, createdAt, updatedAt }
//
// localStorage still has two jobs, neither of them authoritative:
//   1. the one-time migration source for threads written before this existed —
//      they were per-device by definition and would otherwise be stranded;
//   2. an offline mirror, so a failed fetch shows the last known threads rather
//      than an empty sidebar.
//
// Writes are PER THREAD. Sending the whole list would let two devices
// last-write-wins over each other and silently delete threads.
const STORAGE_KEY = 'qig_chat_history_v1';
const MIGRATED_KEY = 'qig_chat_migrated_v1';
const HISTORY_API = '/api/chat/history';
const PERSIST_DEBOUNCE_MS = 600;

function uid() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mirrorLocal(conversations) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    /* quota / unavailable — the server copy is authoritative anyway */
  }
}

// Derive a short title from the first user message's text parts.
function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return null;
  const text = (firstUser.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim();
  if (!text) return null;
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function blankConversation() {
  return { id: uid(), title: null, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

export function useChatHistory() {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  // False when the history API is unreachable: the UI keeps working from the
  // local mirror instead of pretending threads vanished.
  const [synced, setSynced] = useState(true);

  const persistTimerRef = useRef(null);
  const pendingRef = useRef(new Set());
  const syncedRef = useRef(true);
  syncedRef.current = synced;

  // Always-current snapshot so mutators read the latest list without stale
  // closures — and without setState inside another setState updater (which
  // StrictMode double-invokes, corrupting ids).
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // Hydrate from the server, migrating any device-local threads exactly once.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const local = loadLocal();
      let threads = null;

      try {
        const res = await fetch(HISTORY_API, { cache: 'no-store' });
        if (res.ok) {
          threads = (await res.json()).threads || [];

          // One-time migration: push up threads this browser wrote before
          // history was server-backed. The server merges by id and keeps the
          // newer copy, so running this on a second device cannot roll back the
          // first. Empty scratch threads are not worth migrating.
          const pending = local.filter((c) => Array.isArray(c.messages) && c.messages.length > 0);
          if (!localStorage.getItem(MIGRATED_KEY) && pending.length) {
            const merged = await fetch(HISTORY_API, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ migrate: pending }),
            });
            if (merged.ok) {
              threads = (await merged.json()).threads || threads;
              localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
            }
          }
        }
      } catch {
        /* offline or unreachable — fall through to the local mirror */
      }

      if (cancelled) return;

      if (threads === null) {
        // Server unavailable: show what this device knows rather than nothing.
        setSynced(false);
        threads = local;
      } else {
        setSynced(true);
        mirrorLocal(threads);
      }

      if (threads.length > 0) {
        setConversations(threads);
        setActiveId(threads[0].id);
      } else {
        const seed = blankConversation();
        setConversations([seed]);
        setActiveId(seed.id);
      }
      setHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Flush queued threads one PUT at a time. A blank conversation is never
  // persisted — it would create an empty record on every visit.
  const flush = useCallback(async () => {
    const ids = [...pendingRef.current];
    pendingRef.current.clear();
    for (const id of ids) {
      const conv = conversationsRef.current.find((c) => c.id === id);
      if (!conv || conv.messages.length === 0) continue;
      try {
        const res = await fetch(HISTORY_API, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ thread: conv }),
        });
        setSynced(res.ok);
      } catch {
        setSynced(false);
      }
    }
    mirrorLocal(conversationsRef.current);
  }, []);

  const schedulePersist = useCallback(
    (id) => {
      pendingRef.current.add(id);
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(flush, PERSIST_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(() => () => clearTimeout(persistTimerRef.current), []);

  const newChat = useCallback(() => {
    // Reuse an existing empty conversation instead of stacking blanks.
    const blank = conversationsRef.current.find((c) => c.messages.length === 0);
    if (blank) {
      setActiveId(blank.id);
      return;
    }
    const conv = blankConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
  }, []);

  const selectChat = useCallback((id) => setActiveId(id), []);

  const deleteChat = useCallback((id) => {
    const next = conversationsRef.current.filter((c) => c.id !== id);
    // Delete server-side too, or it would reappear on the next hydrate.
    fetch(`${HISTORY_API}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    if (next.length === 0) {
      const conv = blankConversation();
      setConversations([conv]);
      setActiveId(conv.id);
      mirrorLocal([conv]);
      return;
    }
    setConversations(next);
    setActiveId((cur) => (cur === id ? next[0].id : cur));
    mirrorLocal(next);
  }, []);

  // Persist the live message list for a conversation, keeping it sorted by recency.
  const saveMessages = useCallback(
    (id, messages) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === id);
        if (idx === -1) return prev;
        const existing = prev[idx];
        const updated = {
          ...existing,
          messages,
          title: existing.title || deriveTitle(messages),
          updatedAt: Date.now(),
        };
        const rest = prev.filter((c) => c.id !== id);
        return [updated, ...rest];
      });
      schedulePersist(id);
    },
    [schedulePersist],
  );

  const active = conversations.find((c) => c.id === activeId) || null;

  return { conversations, activeId, active, hydrated, synced, newChat, selectChat, deleteChat, saveMessages };
}
