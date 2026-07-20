'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  StatusBadge,
  EmptyState,
  LoadingSpinner,
} from '@bsuite/ui';
import {
  Sparkles,
  Plus,
  Trash2,
  FolderGit2,
  FlaskConical,
  Play,
  TriangleAlert,
  ExternalLink,
} from 'lucide-react';
import {
  saveReviewerConfigAction,
  runDailyReviewNowAction,
} from '@/app/admin/actions';

const inputClass =
  'h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const severityTone = { high: 'error', medium: 'warning', low: 'neutral' };

function formatDate(value) {
  if (!value) return 'never';
  try {
    // Deterministic UTC — identical on server + client, so no hydration mismatch (React #418).
    return `${new Date(value).toLocaleString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;
  } catch {
    return String(value);
  }
}

export function DailyReviewerManager({ initialConfig, initialReport }) {
  const [config, setConfig] = useState(initialConfig);
  const [report, setReport] = useState(initialReport);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [topicsText, setTopicsText] = useState((initialConfig.scienceTopics || []).join(', '));
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [isSaving, startSave] = useTransition();
  const [isRunning, startRun] = useTransition();

  function persist(patch, successNote) {
    setError(null);
    setNotice(null);
    startSave(async () => {
      const res = await saveReviewerConfigAction(patch);
      if (res?.ok) {
        setConfig(res.config);
        setTopicsText((res.config.scienceTopics || []).join(', '));
        if (successNote) setNotice(successNote);
      } else {
        setError('Could not save configuration. Check repo owner/name format.');
      }
    });
  }

  function toggleEnabled() {
    persist({ enabled: !config.enabled });
  }

  function addRepo() {
    const trimmedOwner = owner.trim();
    const trimmedName = name.trim();
    if (!trimmedOwner || !trimmedName) return;
    const exists = config.repos.some((r) => r.owner === trimmedOwner && r.name === trimmedName);
    const repos = exists ? config.repos : [...config.repos, { owner: trimmedOwner, name: trimmedName, note: '' }];
    persist({ repos }, exists ? null : `Added ${trimmedOwner}/${trimmedName}`);
    setOwner('');
    setName('');
  }

  function removeRepo(target) {
    persist({ repos: config.repos.filter((r) => !(r.owner === target.owner && r.name === target.name)) });
  }

  function saveTopics() {
    const scienceTopics = topicsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
    persist({ scienceTopics }, 'Science topics updated');
  }

  function runNow() {
    setError(null);
    setNotice(null);
    startRun(async () => {
      const res = await runDailyReviewNowAction();
      if (res?.ok) {
        setReport(res.report);
        setConfig((prev) => ({
          ...prev,
          lastRunAt: res.report.generated_at,
          lastRunStatus: `ok: ${res.report.patterns.length} patterns`,
        }));
        setNotice('Review complete. Findings broadcast to the qig inbox.');
      } else if (res?.skipped) {
        setNotice(`Skipped: ${res.reason.replace(/_/g, ' ')}.`);
      } else {
        setError(res?.error || 'Review run failed. Please try again.');
      }
    });
  }

  return (
    <section id="daily-reviewer" className="mt-14 scroll-mt-24">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Daily reviewer</h2>
        <StatusBadge tone={config.enabled ? 'success' : 'neutral'}>
          {config.enabled ? 'Enabled' : 'Disabled'}
        </StatusBadge>
      </div>
      <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
        Once a day, Grok reviews the memory corpus for recurring mistakes and bugs, scans the GitHub repos you
        nominate below, and pulls related science. It broadcasts consolidated suggestions to the{' '}
        <code className="font-mono text-xs">qig</code> inbox for connected agents — one model call per run to stay
        credit-frugal.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={toggleEnabled} disabled={isSaving} className="gap-2">
          {config.enabled ? 'Disable schedule' : 'Enable schedule'}
        </Button>
        <Button type="button" onClick={runNow} disabled={isRunning} className="gap-2">
          {isRunning ? <LoadingSpinner size="sm" /> : <Play className="h-4 w-4" />}
          <span>Run now</span>
        </Button>
        <span className="text-xs text-muted-foreground">
          Last run: {formatDate(config.lastRunAt)}
          {config.lastRunStatus ? ` · ${config.lastRunStatus}` : ''}
        </span>
      </div>

      {error && (
        <p className="mt-3 flex items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="h-4 w-4" />
          {error}
        </p>
      )}
      {notice && <p className="mt-3 text-sm text-muted-foreground">{notice}</p>}

      {/* Nominated repos */}
      <div className="mt-8">
        <div className="flex items-center gap-2">
          <FolderGit2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Nominated GitHub repositories</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Repos related to the codebases your memories describe. Public repos work with no token; set
          <code className="mx-1 font-mono">GITHUB_TOKEN</code>for private repos and higher rate limits.
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            className={inputClass}
            placeholder="owner (e.g. vercel)"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) addRepo();
            }}
            aria-label="Repository owner"
          />
          <input
            className={inputClass}
            placeholder="repo (e.g. next.js)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) addRepo();
            }}
            aria-label="Repository name"
          />
          <Button type="button" onClick={addRepo} disabled={isSaving} className="shrink-0 gap-2">
            <Plus className="h-4 w-4" />
            <span>Add repo</span>
          </Button>
        </div>

        <div className="mt-4">
          {config.repos.length === 0 ? (
            <EmptyState
              icon={<FolderGit2 className="h-6 w-6" />}
              title="No repositories nominated"
              description="Add a repo above so the reviewer can correlate memory patterns with live code activity."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {config.repos.map((r) => (
                <li
                  key={`${r.owner}/${r.name}`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3"
                >
                  <a
                    href={`https://github.com/${r.owner}/${r.name}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 items-center gap-2 font-medium text-foreground hover:underline"
                  >
                    <span className="truncate">{r.owner}/{r.name}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </a>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRepo(r)}
                    className="shrink-0 gap-2 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="sr-only sm:not-sr-only">Remove</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Science topics */}
      <div className="mt-8">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Science topics (arXiv)</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Comma-separated topics. Recent arXiv preprints for these feed the reviewer, which links the most relevant
          discoveries for agents to consider.
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            className={inputClass}
            value={topicsText}
            onChange={(e) => setTopicsText(e.target.value)}
            placeholder="information geometry, Fisher-Rao metric, ..."
            aria-label="Science topics"
          />
          <Button type="button" variant="secondary" onClick={saveTopics} disabled={isSaving} className="shrink-0">
            Save topics
          </Button>
        </div>
      </div>

      {/* Latest report */}
      <div className="mt-10">
        <h3 className="text-sm font-semibold text-foreground">Latest report</h3>
        {!report ? (
          <div className="mt-3">
            <EmptyState
              icon={<Sparkles className="h-6 w-6" />}
              title="No report yet"
              description="Run the reviewer to generate the first set of insights."
            />
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-5 rounded-xl border border-border bg-card p-4">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge tone="neutral">{report.model}</StatusBadge>
                <span>{formatDate(report.generated_at)}</span>
                <span>· {report.inputs?.memory_records_reviewed ?? 0} memories reviewed</span>
              </div>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-foreground">{report.summary}</p>
            </div>

            {report.patterns?.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patterns</h4>
                <ul className="mt-2 flex flex-col gap-2">
                  {report.patterns.map((p, i) => (
                    <li key={i} className="rounded-lg border border-border bg-muted/30 p-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge tone={severityTone[p.severity] || 'neutral'}>{p.severity}</StatusBadge>
                        <span className="font-medium text-foreground">{p.title}</span>
                        <span className="text-xs text-muted-foreground">· {p.category}</span>
                      </div>
                      <p className="mt-1.5 text-sm text-muted-foreground">{p.evidence}</p>
                      <p className="mt-1 text-sm text-foreground">
                        <span className="font-medium">Suggestion:</span> {p.recommendation}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.repo_suggestions?.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Repository suggestions
                </h4>
                <ul className="mt-2 flex flex-col gap-2">
                  {report.repo_suggestions.map((s, i) => (
                    <li key={i} className="rounded-lg border border-border bg-muted/30 p-3">
                      <span className="font-mono text-xs text-foreground">{s.repo}</span>
                      <p className="mt-1 text-sm text-muted-foreground">{s.observation}</p>
                      <p className="mt-1 text-sm text-foreground">
                        <span className="font-medium">Suggestion:</span> {s.suggestion}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.science_links?.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Science links</h4>
                <ul className="mt-2 flex flex-col gap-2">
                  {report.science_links.map((l, i) => (
                    <li key={i} className="rounded-lg border border-border bg-muted/30 p-3">
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 font-medium text-foreground hover:underline"
                      >
                        <span>{l.title}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </a>
                      <p className="mt-1 text-sm text-muted-foreground">{l.relevance}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
