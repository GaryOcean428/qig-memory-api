import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { LegalFooter } from '@/components/legal/legal-footer';

/**
 * Shared shell for the Terms, Privacy and Code of Conduct pages.
 * Renders the site header, a titled prose container, and the legal footer so
 * every policy page stays visually consistent with the rest of the site.
 */
export function LegalPage({ title, updated, intro, children }) {
  return (
    <div className="min-h-dvh bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to home
        </Link>

        <header className="mt-6">
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {title}
          </h1>
          {updated ? (
            <p className="mt-2 text-sm text-muted-foreground">Last updated {updated}</p>
          ) : null}
          {intro ? (
            <p className="mt-5 text-pretty text-base leading-relaxed text-muted-foreground">
              {intro}
            </p>
          ) : null}
        </header>

        <div className="mt-10 flex flex-col gap-8">{children}</div>
      </main>
      <LegalFooter />
    </div>
  );
}

/** A titled section within a legal page. */
export function LegalSection({ heading, children }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
        {heading}
      </h2>
      <div className="flex flex-col gap-3 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-[0.95rem]">
        {children}
      </div>
    </section>
  );
}
