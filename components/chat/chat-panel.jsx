'use client';

import { useState, useRef, useEffect } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { Button } from '@bsuite/ui';
import { Send, Bot, Sparkles } from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { ChatMessage } from './chat-message';
import { cn } from '../../lib/utils';

const SUGGESTIONS = [
  'List all memory keys',
  'What agents are on the kernel mesh?',
  'Show the kernel_registry record',
  'Explain the Fisher-Rao distance used here',
];

export function ChatPanel() {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  const [input, setInput] = useState('');
  const viewportRef = useRef(null);

  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    const vp = viewportRef.current;
    if (vp) vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  function submit(text) {
    const value = (text ?? input).trim();
    if (!value || busy) return;
    sendMessage({ text: value });
    setInput('');
  }

  return (
    <div className="flex h-[640px] flex-col overflow-hidden rounded-2xl border border-border bg-card elev-card">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Helper Agent</h2>
          <p className="truncate text-xs text-muted-foreground">
            Operates memory + kernel mesh · claude-sonnet-4.6
          </p>
        </div>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', busy ? 'bg-primary animate-pulse' : 'bg-primary/60')} />
          {busy ? 'Working' : 'Ready'}
        </span>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1" viewportRef={viewportRef}>
        <div className="flex flex-col gap-5 px-5 py-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="size-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Ask the QIG helper agent</p>
                <p className="mx-auto max-w-sm text-xs text-muted-foreground text-pretty">
                  It can read and write the memory store and inspect the kernel mesh in real time.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <ChatMessage key={m.id} message={m} />)
          )}

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
              {error.message || 'Something went wrong talking to the agent.'}
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {/* Composer */}
      <form
        className="flex items-end gap-2 border-t border-border bg-card px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Message the helper agent…"
          className="max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/30"
        />
        <Button type="submit" disabled={busy || !input.trim()} className="h-[42px] shrink-0 gap-1.5">
          <Send className="size-4" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Send</span>
        </Button>
      </form>
    </div>
  );
}
