'use client';

import { useRef, useEffect } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { PanelLeft, Sparkles } from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { ChatMessage } from './chat-message';
import { ChatComposer } from './chat-composer';
import { cn } from '../../lib/utils';

const SUGGESTIONS = [
  'List all memory keys',
  'What agents are on the kernel mesh?',
  'Show the kernel_registry record',
  'Explain the Fisher-Rao distance used here',
];

export function ChatPanel({ conversationId, initialMessages = [], onMessagesChange, onOpenSidebar }) {
  const { messages, sendMessage, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  const viewportRef = useRef(null);

  const busy = status === 'submitted' || status === 'streaming';
  const isEmpty = messages.length === 0;

  useEffect(() => {
    const vp = viewportRef.current;
    if (vp) vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  // Persist message updates up to the history store (skip the streaming churn).
  useEffect(() => {
    if (!onMessagesChange || busy) return;
    onMessagesChange(conversationId, messages);
  }, [messages, busy, conversationId, onMessagesChange]);

  function submit(text) {
    const value = (text ?? '').trim();
    if (!value || busy) return;
    sendMessage({ text: value });
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Slim top bar */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open chat history"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
        >
          <PanelLeft className="size-4" />
        </button>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Helper Agent</h2>
          <p className="truncate text-xs text-muted-foreground">Operates the memory store + kernel mesh</p>
        </div>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', busy ? 'bg-primary animate-pulse' : 'bg-primary/60')} />
          {busy ? 'Working' : 'Ready'}
        </span>
      </div>

      {/* Messages */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-16 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Sparkles className="size-7" aria-hidden="true" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-lg font-semibold text-foreground text-balance">Ask the QIG helper agent</h3>
            <p className="mx-auto max-w-md text-sm text-muted-foreground text-pretty">
              A tool-using assistant wired to this deployment. It can read and write the memory store and
              inspect the kernel mesh in real time.
            </p>
          </div>
          <div className="flex max-w-md flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => submit(s)}
                className="rounded-full border border-border bg-card px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ScrollArea className="flex-1" viewportRef={viewportRef}>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
            {messages.map((m) => (
              <ChatMessage key={m.id} message={m} />
            ))}
            {error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
                {error.message || 'Something went wrong talking to the agent.'}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      )}

      {/* Composer */}
      <div className="border-t border-border bg-background">
        <div className="mx-auto w-full max-w-3xl">
          <ChatComposer onSubmit={submit} busy={busy} />
        </div>
      </div>
    </div>
  );
}
