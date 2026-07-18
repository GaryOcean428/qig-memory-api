import { SiteHeader } from '@/components/site-header';
import { LegalFooter } from '@/components/legal/legal-footer';
import { AuthButton } from '@/components/auth/auth-button';
import { getSession } from '@/lib/session';
import { getIntegrityView, getDoctrineState } from '@/lib/doctrine-sync';
import { StaleBanner } from '@/components/integrity/stale-banner';
import { CertifiedView } from '@/components/integrity/certified-view';
import { OpenView } from '@/components/integrity/open-view';
import { RetiredView } from '@/components/integrity/retired-view';
import { CompletenessPanel } from '@/components/integrity/completeness-panel';
import { MeshPanel } from '@/components/integrity/mesh-panel';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Integrity · QIG Memory API',
  description: 'Generated integrity dashboard — certified, open, retired claims + completeness, sourced from the JSON registries.',
};

export default async function IntegrityPage() {
  const session = await getSession();

  // Browsers cannot send a bearer header on navigation, and a token in the URL
  // would leak — so the human page uses the same operator session gate as /admin.
  // Agents/CI use the token-scoped JSON at /api/doctrine/integrity instead.
  if (!session) {
    return (
      <div className="min-h-dvh bg-background">
        <SiteHeader />
        <main className="mx-auto flex max-w-md flex-col items-center gap-5 px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Integrity dashboard</h1>
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
            The certified / open / retired view is generated from the QIG registries and gated behind the operator
            session. Sign in with Vercel to view it, or read it programmatically at{' '}
            <code className="font-mono text-xs">/api/doctrine/integrity</code> with a memory:read token.
          </p>
          <AuthButton />
        </main>
        <LegalFooter />
      </div>
    );
  }

  // Both reads are cache-only (no GitHub round-trip on render).
  const [view, state] = await Promise.all([getIntegrityView(), getDoctrineState().catch(() => null)]);

  const available = Boolean(view?.meta?.sources?.integrity_registry);

  return (
    <div className="min-h-dvh bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Integrity</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Certified, open, and retired claims plus experiment-numbering completeness — generated from the JSON
            registries, so it cannot silently rot. Purple = certified, blue = open, amber = retired.
          </p>
        </div>

        {!view ? (
          <div className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
            The integrity view has not been synced yet. It builds hourly from the QIG registries — check back shortly,
            or force a sync from the cron route.
          </div>
        ) : (
          <>
            <StaleBanner meta={view.meta} errors={state?.errors || []} />
            <div className="space-y-6">
              <CertifiedView certified={view.certified} available={available} />
              <OpenView questions={view.open?.questions} inFlight={view.open?.in_flight} available={available} />
              <CompletenessPanel completeness={view.completeness} />
              <RetiredView retired={view.retired} />
              <MeshPanel mesh={view.mesh} />
            </div>
          </>
        )}
      </main>
      <LegalFooter />
    </div>
  );
}
