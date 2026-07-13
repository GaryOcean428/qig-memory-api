import Link from 'next/link';
import { ArrowRight, MessageSquare, Sparkles } from 'lucide-react';
import { GridPattern } from '@/components/grid-pattern';

// Button-styled links (the BSuite Button has no `asChild`, so anchors are
// styled directly with the same tokens for navigation).
const btnBase =
  'inline-flex h-11 items-center justify-center gap-2 rounded-md px-6 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const btnPrimary = `${btnBase} bg-primary text-primary-foreground hover:bg-primary/90`;
const btnOutline = `${btnBase} border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground`;

export function HomeHero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <GridPattern
        size={44}
        className="text-border/70 [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,oklch(0.769_0.132_191.7/0.10),transparent_70%)] dark:bg-[radial-gradient(60%_55%_at_50%_0%,oklch(0.769_0.132_191.7/0.18),transparent_72%)]"
      />
      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium text-accent-text">
            <Sparkles className="h-3.5 w-3.5" />
            Persistent memory · Fisher-Rao kernel mesh
          </span>
          <h1 className="mt-6 text-balance text-4xl font-bold tracking-tight text-foreground sm:text-6xl">
            The{' '}
            <span className="bg-gradient-to-r from-neon-electric-blue via-neon-electric-cyan to-neon-electric-lavender bg-clip-text text-transparent">
              QIG Memory API
            </span>
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            Persistent key-value memory and a coordination mesh for the QIG / Pantheon agent
            council. Connect over REST, plug in via MCP, or chat with the built-in helper agent.
          </p>
          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <a href="#connect" className={btnPrimary}>
              Connect via MCP
              <ArrowRight className="h-4 w-4" />
            </a>
            <Link href="/chat" className={btnOutline}>
              <MessageSquare className="h-4 w-4" />
              Open helper agent
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
