'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Persistent chat history for the (unauthenticated) helper agent. Conversations
// live in localStorage so a user's threads survive reloads. Shape:
//   { id, title, messages, createdAt, updatedAt }
const STORAGE_KEY = 'qig_chat_history_v1';

function uid() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

export function useChatHistory() {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const persistRef = useRef(null);

  // Always-current snapshot of conversations so mutators can read the latest
  // list without stale closures — and without calling setState inside another
  // setState updater (which StrictMode double-invokes, corrupting ids).
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // Hydrate from storage on mount, seeding an empty conversation if needed.
  useEffect(() => {
    const stored = load();
    if (stored.length > 0) {
      setConversations(stored);
      setActiveId(stored[0].id);
    } else {
      const seed = { id: uid(), title: null, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      setConversations([seed]);
      setActiveId(seed.id);
    }
    setHydrated(true);
  }, []);

  // Debounced persist whenever conversations change (after hydration).
  useEffect(() => {
    if (!hydrated) return;
    clearTimeout(persistRef.current);
    persistRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
      } catch {
        /* quota / unavailable — ignore */
      }
    }, 250);
    return () => clearTimeout(persistRef.current);
  }, [conversations, hydrated]);

  const newChat = useCallback(() => {
    // Reuse an existing empty conversation instead of stacking blanks.
    const blank = conversationsRef.current.find((c) => c.messages.length === 0);
    if (blank) {
      setActiveId(blank.id);
      return;
    }
    const conv = { id: uid(), title: null, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
  }, []);

  const selectChat = useCallback((id) => setActiveId(id), []);

  const deleteChat = useCallback((id) => {
    const next = conversationsRef.current.filter((c) => c.id !== id);
    if (next.length === 0) {
      const conv = { id: uid(), title: null, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      setConversations([conv]);
      setActiveId(conv.id);
      return;
    }
    setConversations(next);
    setActiveId((cur) => (cur === id ? next[0].id : cur));
  }, []);

  // Persist the live message list for a conversation, keeping it sorted by recency.
  const saveMessages = useCallback((id, messages) => {
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
  }, []);

  const active = conversations.find((c) => c.id === activeId) || null;

  return { conversations, activeId, active, hydrated, newChat, selectChat, deleteChat, saveMessages };
}
