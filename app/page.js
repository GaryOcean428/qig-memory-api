import { SiteHeader } from '@/components/site-header';
import { HomeHero } from '@/components/home-hero';
import { McpConnector } from '@/components/mcp-connector';
import { RestEndpoints } from '@/components/rest-endpoints';
import { KernelSection } from '@/components/kernel-section';

export default function Page() {
  return (
    <div className="min-h-dvh bg-background">
      <SiteHeader />
      <main>
        <HomeHero />
        <div className="mx-auto flex max-w-4xl flex-col gap-16 px-4 py-14 sm:px-6 sm:py-20">
          <McpConnector />
          <RestEndpoints />
          <KernelSection />
        </div>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-4xl flex-col items-center justify-between gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <p>QIG Memory API — persistent memory + kernel mesh.</p>
          <p>The original REST API remains fully functional and unchanged.</p>
        </div>
      </footer>
    </div>
  );
}
