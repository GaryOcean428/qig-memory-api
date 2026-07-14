'use client';

import { useState } from 'react';
import { ChatSidebar } from './chat-sidebar';
import { ChatPanel } from './chat-panel';
import { useChatHistory } from '../../lib/use-chat-history';

export function ChatWorkspace() {
  const { conversations, activeId, active, hydrated, newChat, selectChat, deleteChat, saveMessages } =
    useChatHistory();
  const [mobileOpen, setMobileOpen] = useState(false);

  function handleSelect(id) {
    selectChat(id);
    setMobileOpen(false);
  }

  function handleNewChat() {
    newChat();
    setMobileOpen(false);
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] overflow-hidden">
      <ChatSidebar
        conversations={conversations}
        activeId={activeId}
        onNewChat={handleNewChat}
        onSelect={handleSelect}
        onDelete={deleteChat}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      <main className="min-w-0 flex-1">
        {hydrated && active ? (
          // Remounting per conversation gives each thread its own useChat state.
          <ChatPanel
            key={active.id}
            conversationId={active.id}
            initialMessages={active.messages}
            onMessagesChange={saveMessages}
            onOpenSidebar={() => setMobileOpen(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <span className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
          </div>
        )}
      </main>
    </div>
  );
}
