import { Suspense } from 'react';
import { SiteHeader } from '@/components/site-header';
import { LegalFooter } from '@/components/legal/legal-footer';
import { MemoryBrowser } from '@/components/admin/memory-browser';
import { KernelMeshViewer } from '@/components/admin/kernel-mesh-viewer';
import { ApiKeysManager } from '@/components/admin/api-keys-manager';
import { OAuthClientsManager } from '@/components/admin/oauth-clients-manager';
import { DailyReviewerManager } from '@/components/admin/daily-reviewer-manager';
import { DoctrineManager } from '@/components/admin/doctrine-manager';
import { TaskManager } from '@/components/admin/task-manager';
import { FrozenFactsDashboard } from '@/components/admin/frozen-facts-dashboard';
import { TodosDashboard } from '@/components/admin/todos-dashboard';
import { loadDoctrineAction, listInboxNeedsActionAction } from '@/app/admin/actions';
import { listTasks, withDerived } from '@/lib/task-store';
import { AuthButton } from '@/components/auth/auth-button';
import { getSession } from '@/lib/session';
import { listMemory, listKernelAgents, syncKernel } from '@/lib/memory-store';
import { listApiKeys } from '@/lib/api-keys';
import { listOAuthClients } from '@/lib/mcp-oauth-store';
import { getReviewerConfig, getLatestReport } from '@/lib/reviewer-config';
import { getDoctrineState, getIntegrityView } from '@/lib/doctrine-sync';
import { BadgeCheck } from 'lucide-react';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Admin · QIG Memory API',
  description: 'Browse and edit the memory store and inspect the kernel mesh.',
};

export default async function AdminPage() {
  const session = await getSession();

  if (!session) {
    return (
      <div className="min-h-dvh bg-background">
        <SiteHeader />
        <main className="mx-auto flex max-w-md flex-col items-center gap-5 px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Admin access
          </h1>
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
            The memory browser and kernel-mesh viewer are protected. Sign in with Vercel to
            manage the store — your session authorizes every action server-side, so no API key is
            ever exposed to the browser.
          </p>
          <AuthButton />
        </main>
        <LegalFooter />
      </div>
    );
  }

  // Authenticated: load initial data directly through the shared lib (server-side).
  const [index, agentMap, apiKeys, oauthClients, reviewerConfig, reviewerReport, doctrine, tasks, doctrineState, needsAction, integrityView] =
    await Promise.all([
      listMemory({ keysOnly: true }),
      listKernelAgents(),
      listApiKeys(),
      listOAuthClients(),
      getReviewerConfig(),
      getLatestReport(),
      loadDoctrineAction(),
      listTasks(),
      // Cached canon snapshot — never fetches GitHub on a page render.
      getDoctrineState().catch(() => null),
      // Unacked inbox mail for the work board (best-effort).
      listInboxNeedsActionAction().catch(() => []),
      // Cached integrity view for the summary card (best-effort).
      getIntegrityView().catch(() => null),
    ]);
  const initialTasks = tasks.map((t) => withDerived(t));
  const keys = index.records
    .slice()
    .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  const agentIds = Object.keys(agentMap);
  const initialMesh = agentIds.length ? await syncKernel(agentIds[0]) : { peers: {}, peer_count: 0 };

  return (
    <div className="min-h-dvh bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
        <Suspense fallback={null}>
          <TodosDashboard tasks={initialTasks} doctrine={doctrineState} inbox={needsAction} />
          <a
            href="/integrity"
            className="elev-card mb-6 flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-muted/40"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <BadgeCheck className="size-4 shrink-0 text-purple-500" aria-hidden="true" />
                <span className="text-sm font-semibold text-foreground">Integrity dashboard</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {integrityView
                  ? `${integrityView.certified?.length ?? 0} certified · ${integrityView.open?.questions?.length ?? 0} open · ${integrityView.retired?.length ?? 0} retired${integrityView.meta?.stale ? ' · STALE' : ''} — generated from the registries`
                  : 'Not synced yet — generated from the JSON registries'}
              </p>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">View →</span>
          </a>
          <FrozenFactsDashboard state={doctrineState} />
          <MemoryBrowser initialKeys={keys} keyCount={index.key_count ?? keys.length} />
          <KernelMeshViewer initialAgentIds={agentIds} initialMesh={initialMesh} />
          <ApiKeysManager initialKeys={apiKeys} />
          <OAuthClientsManager initialClients={oauthClients} />
          <DailyReviewerManager initialConfig={reviewerConfig} initialReport={reviewerReport} />
          <TaskManager initialTasks={initialTasks} />
          <DoctrineManager initialDoctrine={doctrine} />
        </Suspense>
      </main>
      <LegalFooter />
    </div>
  );
}
