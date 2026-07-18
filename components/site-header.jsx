'use client';

import Link from 'next/link';
import { D2CDefaultLogo } from '@bsuite/ui';
import { ThemeToggle } from '@/components/theme-toggle';
import { AuthButton } from '@/components/auth/auth-button';

const NAV = [
  { label: 'Connect', href: '/#connect' },
  { label: 'REST API', href: '/#rest' },
  { label: 'Kernel Mesh', href: '/#kernel' },
];

export function SiteHeader() {
  return (
    <header className="elev-nav sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <D2CDefaultLogo width={30} height={30} className="shrink-0" />
          <span className="text-sm font-semibold tracking-tight text-foreground">
            QIG Memory API
          </span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/admin"
            className="hidden rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
          >
            Admin
          </Link>
          <Link
            href="/integrity"
            className="hidden rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
          >
            Integrity
          </Link>
          <Link
            href="/chat"
            className="hidden rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
          >
            Helper agent
          </Link>
          <ThemeToggle />
          <AuthButton />
        </div>
      </div>
    </header>
  );
}
