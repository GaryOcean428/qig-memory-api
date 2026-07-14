'use client';

import { Fragment } from 'react';
import { Bot, User, Wrench, Check, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

// Render inline markdown emphasis (**bold**, *italic*, `code`) as React nodes.
function renderInline(text) {
  const nodes = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let match;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={i++} className="font-semibold text-foreground">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={i++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-primary">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={i++}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Split a GFM table row `| a | b |` into trimmed cells.
function splitRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

const isTableSeparator = (line) => /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
const isTableRow = (line) => line.includes('|') && line.trim().length > 1;

// Minimal block renderer: paragraphs, lists, and GFM-style tables.
function Markdown({ text }) {
  const lines = text.split('\n');
  const blocks = [];
  let list = null;

  const flush = () => {
    if (list) {
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="my-1 ml-4 list-disc space-y-1">
          {list.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table: a header row immediately followed by a separator row.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      blocks.push(
        <div key={`t-${blocks.length}`} className="my-1 overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                {header.map((h, hi) => (
                  <th key={hi} className="px-3 py-1.5 text-left font-semibold text-foreground">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b border-border/50 last:border-0">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-1.5 align-top text-muted-foreground">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      if (!list) list = [];
      list.push(bullet[1]);
    } else if (line.trim() === '') {
      flush();
    } else {
      flush();
      blocks.push(
        <p key={`p-${blocks.length}`} className="text-pretty">
          {renderInline(line)}
        </p>,
      );
    }
  }
  flush();

  return <div className="space-y-2">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
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
            {isUser ? (
              <p className="whitespace-pre-wrap text-pretty">{part.text}</p>
            ) : (
              <Markdown text={part.text} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
