'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, ArrowUp, Square, AudioLines } from 'lucide-react';
import { useSpeechRecognition } from '../../lib/use-speech-recognition';
import { cn } from '../../lib/utils';

// Rich chat composer: auto-resizing textarea, integrated speech-to-text mic
// (Web Speech API), and a send control. Final speech chunks are appended to the
// draft; interim words render as a live ghost preview inside the field.
export function ChatComposer({ onSubmit, busy, placeholder = 'Message the helper agent…' }) {
  const [input, setInput] = useState('');
  const textareaRef = useRef(null);

  const { isSupported, isListening, interim, error, toggle, stop } = useSpeechRecognition({
    onResult: (finalText) => {
      setInput((prev) => {
        const sep = prev && !prev.endsWith(' ') ? ' ' : '';
        return (prev + sep + finalText).trimStart();
      });
    },
  });

  // Auto-grow the textarea up to a max height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input, interim]);

  function submit() {
    const value = input.trim();
    if (!value || busy) return;
    if (isListening) stop();
    onSubmit(value);
    setInput('');
  }

  const canSend = input.trim().length > 0 && !busy;

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className={cn(
          'group relative flex flex-col rounded-2xl border border-border bg-background transition-shadow',
          'focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/30',
          isListening && 'border-primary/60 ring-2 ring-primary/25',
        )}
      >
        {/* Listening banner */}
        {isListening && (
          <div className="flex items-center gap-2 border-b border-border/60 px-4 pt-3 text-xs font-medium text-primary">
            <AudioLines className="size-3.5 animate-pulse" aria-hidden="true" />
            Listening…
            <span className="ml-1 flex items-end gap-0.5" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className="w-0.5 rounded-full bg-primary animate-eq"
                  style={{ height: '10px', animationDelay: `${i * 120}ms` }}
                />
              ))}
            </span>
          </div>
        )}

        <label htmlFor="chat-input" className="sr-only">
          Message the helper agent
        </label>
        <textarea
          id="chat-input"
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="max-h-40 min-h-[48px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />

        {/* Interim transcript preview */}
        {isListening && interim ? (
          <p className="px-4 pb-1 text-sm italic text-muted-foreground">{interim}</p>
        ) : null}

        {/* Action bar */}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <div className="flex min-w-0 items-center gap-1.5 pl-1.5 text-[11px] text-muted-foreground">
            {error ? (
              <span className="text-destructive">Mic error: {error}</span>
            ) : isSupported ? (
              <span className="hidden sm:inline">Enter to send · Shift+Enter for newline</span>
            ) : (
              <span className="hidden sm:inline">Speech input not supported in this browser</span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {isSupported && (
              <button
                type="button"
                onClick={toggle}
                aria-pressed={isListening}
                aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
                title={isListening ? 'Stop voice input' : 'Start voice input'}
                className={cn(
                  'relative flex size-9 items-center justify-center rounded-full border transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isListening
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
                )}
              >
                {isListening && (
                  <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" aria-hidden="true" />
                )}
                {isListening ? <Square className="size-4 fill-current" /> : <Mic className="size-4" />}
              </button>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send message"
              title="Send message"
              className={cn(
                'flex size-9 items-center justify-center rounded-full transition-all',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                canSend
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'cursor-not-allowed bg-muted text-muted-foreground',
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
