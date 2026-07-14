'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, Wrench, Check, Loader2, Copy, Pencil, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';

// Markdown component overrides tuned to the chat bubble type scale.
const MD_COMPONENTS = {
  h1: ({ children }) => <h3 className="mt-3 text-base font-semibold text-foreground first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-3 text-sm font-semibold text-foreground first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-2 text-sm font-semibold text-foreground first:mt-0">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-2 text-sm font-medium text-foreground first:mt-0">{children}</h6>,
  h5: ({ children }) => <h6 className="mt-2 text-sm font-medium text-foreground first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-2 text-sm font-medium text-foreground first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="text-pretty">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="[&>p]:inline">{children}</li>,
  hr: () => <hr className="my-3 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-primary/40 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  code: ({ inline, className, children }) =>
    inline ? (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-primary">{children}</code>
    ) : (
      <code className={cn('font-mono text-xs', className)}>{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="my-1 overflow-x-auto rounded-lg border border-border bg-muted/50 p-3">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border bg-muted/50">{children}</thead>,
  th: ({ children }) => <th className="px-3 py-1.5 text-left font-semibold text-foreground">{children}</th>,
  tr: ({ children }) => <tr className="border-b border-border/50 last:border-0">{children}</tr>,
  td: ({ children }) => <td className="px-3 py-1.5 align-top text-muted-foreground">{children}</td>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
};

function Markdown({ text }) {
  return (
    <div className="space-y-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

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

function ActionButton({ label, onClick, icon: Icon, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        active && 'text-primary',
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
}

export function ChatMessage({ message, busy, onEdit, onResend }) {
  const isUser = message.role === 'user';
  const textParts = message.parts.filter((p) => p.type === 'text' && p.text);
  const toolParts = message.parts.filter((p) => typeof p.type === 'string' && p.type.startsWith('tool-'));
  const [copied, setCopied] = useState(false);

  const fullText = textParts.map((p) => p.text).join('\n\n');

  async function copyText() {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — nothing to do.
    }
  }

  return (
    <div className={cn('group flex w-full gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
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
            {isUser ? (
              <p className="whitespace-pre-wrap text-pretty">{part.text}</p>
            ) : (
              <Markdown text={part.text} />
            )}
          </div>
        ))}

        {/* Message actions — visible on hover/focus, always reachable by keyboard */}
        {fullText && (
          <div
            className={cn(
              'flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
              isUser ? 'flex-row-reverse' : 'flex-row',
            )}
          >
            <ActionButton
              label={copied ? 'Copied' : 'Copy message'}
              onClick={copyText}
              icon={copied ? Check : Copy}
              active={copied}
            />
            {isUser && onEdit ? (
              <ActionButton label="Edit message" onClick={() => onEdit(fullText)} icon={Pencil} />
            ) : null}
            {isUser && onResend ? (
              <ActionButton
                label={busy ? 'Wait for the current reply to finish' : 'Resend message'}
                onClick={() => !busy && onResend(fullText)}
                icon={RotateCcw}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
