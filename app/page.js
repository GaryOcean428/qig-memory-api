import { Suspense } from 'react';
import { SiteHeader } from '@/components/site-header';
import { AuthNotice } from '@/components/auth/auth-notice';
import { HomeHero } from '@/components/home-hero';
import { McpConnector } from '@/components/mcp-connector';
import { RestEndpoints } from '@/components/rest-endpoints';
import { KernelSection } from '@/components/kernel-section';
import { LegalFooter } from '@/components/legal/legal-footer';

export default function Page() {
  return (
    <div className="min-h-dvh bg-background">
      <SiteHeader />
      <main>
        <Suspense fallback={null}>
          <AuthNotice />
        </Suspense>
        <HomeHero />
        <div className="mx-auto flex max-w-4xl flex-col gap-16 px-4 py-14 sm:px-6 sm:py-20">
          <McpConnector />
          <RestEndpoints />
          <KernelSection />
        </div>
      </main>
      <LegalFooter />
    </div>
  );
}
