'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import useSWR from 'swr';
import { Button, LoadingSpinner } from '@bsuite/ui';
import { LogOut, ChevronDown, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';

const fetcher = (url) => fetch(url).then((r) => r.json());

function VercelMark({ className }) {
  return (
    <svg viewBox="0 0 76 65" aria-hidden="true" className={className} fill="currentColor">
      <path d="M37.53 0 75.06 65H0L37.53 0Z" />
    </svg>
  );
}

function initialsFor(user) {
  const source = user?.name || user?.username || user?.email || '?';
  return source.trim().slice(0, 2).toUpperCase();
}

export function AuthButton() {
  const pathname = usePathname();
  const { data, isLoading } = useSWR('/api/auth/session', fetcher, {
    revalidateOnFocus: true,
  });
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/vercel/logout', { method: 'POST' });
      window.location.reload();
    } finally {
      setSigningOut(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-10 w-10 items-center justify-center" aria-hidden="true">
        <LoadingSpinner size="sm" />
      </div>
    );
  }

  if (!data?.authenticated) {
    const returnTo = encodeURIComponent(pathname || '/');
    return (
      <div className="flex items-center gap-2">
        <a
          href={`/api/auth/vercel/login?returnTo=${returnTo}`}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <VercelMark className="h-3.5 w-3.5" />
          Sign in with Vercel
        </a>
        {data?.devLogin && (
          <a
            href={`/api/auth/dev-login?returnTo=${returnTo}`}
            title="Dev-only: mint a local session without OAuth. Disabled on every deployment."
            className="inline-flex h-10 items-center gap-2 rounded-md border border-dashed border-warning/60 bg-warning/10 px-3 text-sm font-medium text-foreground transition-colors hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FlaskConical className="h-3.5 w-3.5" />
            Dev sign-in
          </a>
        )}
      </div>
    );
  }

  const user = data.user;

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-card px-2 pr-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {user?.picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.picture} alt="" className="h-full w-full object-cover" />
          ) : (
            initialsFor(user)
          )}
        </span>
        <span className="hidden max-w-[10rem] truncate sm:inline">
          {user?.username || user?.name || user?.email}
        </span>
        <ChevronDown
          className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="elev-card absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-lg border border-border bg-card p-1.5"
        >
          <div className="flex items-center gap-3 rounded-md px-2.5 py-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {user?.picture ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.picture} alt="" className="h-full w-full object-cover" />
              ) : (
                initialsFor(user)
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {user?.name || user?.username || 'Vercel user'}
              </p>
              {user?.email && (
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              )}
            </div>
          </div>
          <div className="my-1 h-px bg-border" />
          <div className="px-1 pb-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={signOut}
              disabled={signingOut}
              className="w-full justify-start gap-2"
              role="menuitem"
            >
              {signingOut ? <LoadingSpinner size="sm" /> : <LogOut className="h-4 w-4" />}
              Sign out
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
