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
import { getDoctrineState } from '@/lib/doctrine-sync';

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
  const [index, agentMap, apiKeys, oauthClients, reviewerConfig, reviewerReport, doctrine, tasks, doctrineState, needsAction] =
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
