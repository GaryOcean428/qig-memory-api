'use client';

import { useState } from 'react';
import { ListTodo, X } from 'lucide-react';
import { ChatSidebar } from './chat-sidebar';
import { ChatPanel } from './chat-panel';
import { ChatTaskPanel } from '../tasks/chat-task-panel';
import { useChatHistory } from '../../lib/use-chat-history';
import { cn } from '../../lib/utils';

export function ChatWorkspace() {
  const { conversations, activeId, active, hydrated, newChat, selectChat, deleteChat, saveMessages } =
    useChatHistory();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);

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
            onToggleTasks={() => setTasksOpen((v) => !v)}
            tasksOpen={tasksOpen}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <span className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
          </div>
        )}
      </main>

      {/* Task side panel: overlay drawer on small screens, docked column on xl+ */}
      {tasksOpen ? (
        <button
          type="button"
          aria-label="Close tasks panel"
          onClick={() => setTasksOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 xl:hidden"
        />
      ) : null}
      <aside
        className={cn(
          'fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-background transition-transform duration-200',
          'xl:static xl:z-0 xl:w-96 xl:max-w-none',
          tasksOpen ? 'translate-x-0' : 'translate-x-full xl:hidden',
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 xl:hidden">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <ListTodo className="size-4 text-primary" aria-hidden="true" />
            Tasks
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setTasksOpen(false)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ChatTaskPanel />
        </div>
      </aside>
    </div>
  );
}
