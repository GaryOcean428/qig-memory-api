'use client';

import { Bot, User, Wrench, Check, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

// Compact chip describing a single tool call (part.type === "tool-<name>").
function ToolChip({ part }) {
  const name = part.type.replace(/^tool-/, '');
  const done = part.state === 'output-available';
  const errored = part.state === 'output-error';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-xs font-mono',
        errored && 'border-destructive/40',
      )}
    >
      {errored ? (
        <Wrench className="size-3.5 text-destructive" aria-hidden="true" />
      ) : done ? (
        <Check className="size-3.5 text-primary" aria-hidden="true" />
      ) : (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
      )}
      <span className="text-foreground">{name}</span>
      {part.input?.key ? <span className="text-muted-foreground">{`· ${part.input.key}`}</span> : null}
    </div>
  );
}

export function ChatMessage({ message }) {
  const isUser = message.role === 'user';
  const textParts = message.parts.filter((p) => p.type === 'text' && p.text);
  const toolParts = message.parts.filter((p) => typeof p.type === 'string' && p.type.startsWith('tool-'));

  return (
    <div className={cn('flex w-full gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full border border-border',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-card text-primary',
        )}
        aria-hidden="true"
      >
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </div>

      <div className={cn('flex min-w-0 max-w-[80%] flex-col gap-2', isUser ? 'items-end' : 'items-start')}>
        {toolParts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {toolParts.map((part, i) => (
              <ToolChip key={i} part={part} />
            ))}
          </div>
        )}

        {textParts.map((part, i) => (
          <div
            key={i}
            className={cn(
              'rounded-2xl px-4 py-2.5 text-sm leading-relaxed elev-card',
              isUser
                ? 'rounded-tr-sm bg-primary text-primary-foreground'
                : 'rounded-tl-sm border border-border bg-card text-card-foreground',
            )}
          >
            <p className="whitespace-pre-wrap text-pretty">{part.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
