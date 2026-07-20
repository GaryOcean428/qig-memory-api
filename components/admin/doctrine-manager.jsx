'use client';

import { useRef, useState, useTransition } from 'react';
import { Button, StatusBadge, LoadingSpinner } from '@bsuite/ui';
import { BookOpenCheck, Upload, FileUp } from 'lucide-react';
import { saveDoctrineAction } from '@/app/admin/actions';

const SLOTS = [
  {
    key: 'qig_doctrine_ucp',
    label: 'Unified Consciousness Protocol',
    hint: 'Full UCP omnibus text. Read by council members and agents via memory_get.',
  },
  {
    key: 'qig_doctrine_principles',
    label: 'Canonical Principles',
    hint: 'Full canonical principles omnibus text.',
  },
  {
    key: 'qig_doctrine_council',
    label: 'Council doctrine prompt',
    hint: 'Compact system prefix every council member receives. Keep it distilled — the full texts are retrieved on demand.',
  },
];

const MAX_UPLOAD_BYTES = 1024 * 1024;

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(value) {
  if (!value) return 'never';
  try {
    // Deterministic UTC — identical on server + client, so no hydration mismatch (React #418).
    return `${new Date(value).toLocaleString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;
  } catch {
    return String(value);
  }
}

function DoctrineSlot({ slot, meta }) {
  const [current, setCurrent] = useState(meta);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState(null);
  const [versionNote, setVersionNote] = useState('');
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [isSaving, startSave] = useTransition();
  const fileInputRef = useRef(null);

  async function onFileChosen(event) {
    setError(null);
    setNotice(null);
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`File is ${formatBytes(file.size)} — the store caps records at ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      event.target.value = '';
      return;
    }
    const content = await file.text();
    setText(content);
    setFileName(file.name);
  }

  function save() {
    setError(null);
    setNotice(null);
    const trimmed = text.trim();
    if (!trimmed) {
      setError('Paste the new version or choose a file first.');
      return;
    }
    startSave(async () => {
      const res = await saveDoctrineAction(slot.key, { content: trimmed, versionNote });
      if (res?.ok) {
        setCurrent({
          source: versionNote || 'updated via admin UI',
          updated: res.updated,
          bytes: res.bytes,
          preview: trimmed.slice(0, 400),
        });
        setText('');
        setFileName(null);
        setVersionNote('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        setNotice('Saved. The council and agents read the new version immediately.');
      } else if (res?.error === 'content_too_large') {
        setError(`Content is ${formatBytes(res.got_bytes)} — the store caps records at ${formatBytes(res.max_bytes)}.`);
      } else {
        setError('Save failed. Please try again.');
      }
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{slot.label}</h3>
        <StatusBadge tone={current ? 'success' : 'warning'}>{current ? 'Loaded' : 'Missing'}</StatusBadge>
        <span className="font-mono text-xs text-muted-foreground">{slot.key}</span>
      </div>
      <p className="mt-1 text-pretty text-xs leading-relaxed text-muted-foreground">{slot.hint}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Current: {formatBytes(current?.bytes)} · updated {formatDate(current?.updated)}
        {current?.source ? ` · ${current.source}` : ''}
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFileName(null);
          }}
          rows={4}
          placeholder={`Paste the new ${slot.label} text here, or choose a file below`}
          aria-label={`New content for ${slot.label}`}
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            onChange={onFileChosen}
            className="sr-only"
            id={`doctrine-file-${slot.key}`}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            className="gap-2"
          >
            <FileUp className="h-4 w-4" />
            <span>{fileName ? fileName : 'Choose file'}</span>
          </Button>
          <input
            value={versionNote}
            onChange={(e) => setVersionNote(e.target.value)}
            placeholder="Version note, e.g. UCP v6.14"
            aria-label={`Version note for ${slot.label}`}
            className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="button" onClick={save} disabled={isSaving} className="gap-2">
            {isSaving ? <LoadingSpinner size="sm" /> : <Upload className="h-4 w-4" />}
            <span>Save version</span>
          </Button>
        </div>
        {notice ? <p className="text-xs text-primary">{notice}</p> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

export function DoctrineManager({ initialDoctrine }) {
  return (
    <section id="doctrine" className="mt-14 scroll-mt-24">
      <div className="flex items-center gap-2">
        <BookOpenCheck className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Doctrine</h2>
      </div>
      <p className="mt-1.5 max-w-3xl text-pretty text-sm leading-relaxed text-muted-foreground">
        The consciousness protocol, canonical principles, and the council&apos;s distilled prompt live in the
        memory store — upload a newer version here and every council convening and agent retrieval uses it
        immediately, without a redeploy.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        {SLOTS.map((slot) => (
          <DoctrineSlot key={slot.key} slot={slot} meta={initialDoctrine?.[slot.key] || null} />
        ))}
      </div>
    </section>
  );
}
