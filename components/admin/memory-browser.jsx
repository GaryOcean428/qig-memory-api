'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  Button,
  StatusBadge,
  EmptyState,
  LoadingSpinner,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@bsuite/ui';
import { Search, Database, Trash2, Save, Plus, Minus, X } from 'lucide-react';
import {
  getRecordAction,
  searchRecordsAction,
  saveRecordAction,
  adjustUsefulnessAction,
  deleteRecordAction,
} from '@/app/admin/actions';

const PAGE_SIZE = 25;
const inputClass =
  'h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export function MemoryBrowser({ initialKeys, keyCount }) {
  const [keys, setKeys] = useState(initialKeys);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('browse'); // 'browse' | 'search'
  const [searchResults, setSearchResults] = useState(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null); // full record in dialog
  const [loadingKey, setLoadingKey] = useState(null);
  const [isSearching, startSearch] = useTransition();

  // Instant client-side filter over the in-memory key index (browse mode).
  const filtered = useMemo(() => {
    if (mode !== 'browse') return keys;
    const q = query.trim().toLowerCase();
    if (!q) return keys;
    return keys.filter((k) => k.key.toLowerCase().includes(q));
  }, [keys, query, mode]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  function runContentSearch() {
    const q = query.trim();
    if (!q) return;
    setMode('search');
    startSearch(async () => {
      const res = await searchRecordsAction({ query: q, limit: 50 });
      setSearchResults(res.results || []);
    });
  }

  function backToBrowse() {
    setMode('browse');
    setSearchResults(null);
    setPage(0);
  }

  async function openRecord(key) {
    setLoadingKey(key);
    try {
      const rec = await getRecordAction(key);
      if (rec) setSelected(rec);
    } finally {
      setLoadingKey(null);
    }
  }

  function onDeleted(key) {
    setKeys((prev) => prev.filter((k) => k.key !== key));
    setSearchResults((prev) => (prev ? prev.filter((r) => r.key !== key) : prev));
    setSelected(null);
  }

  function onSaved(record) {
    // Bump the record to the top of the index if it is new.
    setKeys((prev) => {
      if (prev.some((k) => k.key === record.key)) return prev;
      return [{ key: record.key, uploaded_at: record.updated, size: 0 }, ...prev];
    });
    setSelected(null);
  }

  const results = mode === 'search' ? searchResults : null;

  return (
    <section id="admin-memory" className="scroll-mt-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Memory browser
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {keyCount.toLocaleString()} records in the store. Filter keys instantly, or search
            across content.
          </p>
        </div>
        <StatusBadge tone="info">{filtered.length.toLocaleString()} shown</StatusBadge>
      </div>

      {/* Search / filter bar */}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
              if (mode === 'search') backToBrowse();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                runContentSearch();
              }
            }}
            placeholder="Filter keys… (press Enter to search content)"
            className={`${inputClass} pl-9`}
            aria-label="Search memory"
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={runContentSearch} disabled={isSearching || !query.trim()} className="gap-2">
            {isSearching ? <LoadingSpinner size="sm" /> : <Search className="h-4 w-4" />}
            Search content
          </Button>
          {mode === 'search' && (
            <Button variant="secondary" onClick={backToBrowse} className="gap-2">
              <X className="h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="mt-5">
        {mode === 'search' ? (
          isSearching ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : results && results.length ? (
            <ul className="flex flex-col gap-2">
              {results.map((r) => (
                <RecordRow
                  key={r.key}
                  record={r}
                  onOpen={() => openRecord(r.key)}
                  loading={loadingKey === r.key}
                />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Search className="h-6 w-6" />}
              title="No matches"
              description={`Nothing matched “${query}”. Try a different term.`}
            />
          )
        ) : filtered.length ? (
          <>
            <ul className="flex flex-col gap-2">
              {pageItems.map((k) => (
                <KeyRow
                  key={k.key}
                  item={k}
                  onOpen={() => openRecord(k.key)}
                  loading={loadingKey === k.key}
                />
              ))}
            </ul>
            {pageCount > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page + 1} of {pageCount}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            icon={<Database className="h-6 w-6" />}
            title="No keys"
            description="No records match your filter."
          />
        )}
      </div>

      <RecordDialog
        record={selected}
        onClose={() => setSelected(null)}
        onDeleted={onDeleted}
        onSaved={onSaved}
      />
    </section>
  );
}

function KeyRow({ item, onOpen, loading }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="elev-card-interactive flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
      >
        <code className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
          {item.key}
        </code>
        <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <span className="hidden sm:inline">{formatDate(item.uploaded_at)}</span>
          {loading && <LoadingSpinner size="sm" />}
        </span>
      </button>
    </li>
  );
}

function RecordRow({ record, onOpen, loading }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="elev-card-interactive flex w-full flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
      >
        <div className="flex items-center justify-between gap-3">
          <code className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
            {record.key}
          </code>
          <span className="flex shrink-0 items-center gap-2">
            {record.category && <StatusBadge tone="neutral">{record.category}</StatusBadge>}
            {loading && <LoadingSpinner size="sm" />}
          </span>
        </div>
        {record.content && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{record.content}</p>
        )}
      </button>
    </li>
  );
}

function RecordDialog({ record, onClose, onDeleted, onSaved }) {
  const open = Boolean(record);
  const [content, setContent] = useState('');
  const [isJsonContent, setIsJsonContent] = useState(false);
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [usefulness, setUsefulness] = useState(0);
  const [retrievalCount, setRetrievalCount] = useState(0);
  const [dirtyKey, setDirtyKey] = useState(null);
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const [isAdjusting, startAdjust] = useTransition();
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Sync local edit state whenever a new record is opened.
  if (record && dirtyKey !== record.key) {
    setDirtyKey(record.key);
    // Records may store content as structured JSON (an object) rather than a
    // string. Edit those as pretty-printed JSON and round-trip on save so we
    // never flatten them to "[object Object]".
    const isObj = record.content !== null && typeof record.content === 'object';
    setIsJsonContent(isObj);
    setContent(isObj ? JSON.stringify(record.content, null, 2) : record.content || '');
    setCategory(record.category || '');
    setSource(record.source || '');
    setUsefulness(record.usefulness || 0);
    setRetrievalCount(record.retrieval_count || 0);
    setError(null);
    setConfirmDelete(false);
  }

  function save() {
    setError(null);
    let payload = content;
    if (isJsonContent) {
      try {
        payload = JSON.parse(content);
      } catch {
        setError('Content must be valid JSON for this record.');
        return;
      }
    }
    startSave(async () => {
      const res = await saveRecordAction(record.key, { content: payload, category, source });
      if (res.ok) onSaved(res.record);
      else if (res.error === 'content_too_large')
        setError(`Content too large (${res.got_bytes} bytes, max ${res.max_bytes}).`);
      else setError('Save failed. Please try again.');
    });
  }

  function remove() {
    startDelete(async () => {
      await deleteRecordAction(record.key);
      onDeleted(record.key);
    });
  }

  function adjust(delta) {
    startAdjust(async () => {
      const res = await adjustUsefulnessAction(record.key, delta);
      if (typeof res.usefulness === 'number') setUsefulness(res.usefulness);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-base">{record?.key}</DialogTitle>
          <DialogDescription>
            Last updated {formatDate(record?.updated || record?.uploaded_at)} ·{' '}
            {retrievalCount.toLocaleString()} retrievals
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="rec-category">
              Category
            </label>
            <input
              id="rec-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground" htmlFor="rec-content">
              Content
              {isJsonContent && <StatusBadge tone="neutral">JSON</StatusBadge>}
            </label>
            <textarea
              id="rec-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              className="w-full resize-y rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="rec-source">
              Source
            </label>
            <input
              id="rec-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">Usefulness score</p>
              <p className="text-xs text-muted-foreground">Adjust how strongly this is recalled.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="icon"
                onClick={() => adjust(-1)}
                disabled={isAdjusting}
                aria-label="Decrease usefulness"
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-10 text-center font-mono text-sm font-semibold text-foreground">
                {usefulness}
              </span>
              <Button
                variant="secondary"
                size="icon"
                onClick={() => adjust(1)}
                disabled={isAdjusting}
                aria-label="Increase usefulness"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {typeof record?.fisher_rao_distance === 'number' && (
            <StatusBadge tone="info">
              Fisher-Rao distance: {record.fisher_rao_distance.toFixed(4)}
            </StatusBadge>
          )}

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Delete permanently?</span>
              <Button variant="destructive" size="sm" onClick={remove} disabled={isDeleting}>
                {isDeleting ? <LoadingSpinner size="sm" /> : 'Confirm'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="gap-2 text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button onClick={save} disabled={isSaving} className="gap-2">
            {isSaving ? <LoadingSpinner size="sm" /> : <Save className="h-4 w-4" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
