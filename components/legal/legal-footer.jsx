import Link from 'next/link';

// Route paths intentionally match the URLs registered on the Vercel OAuth
// consent screen (including the /code-or-conduct spelling), so the links shown
// during "Sign in with Vercel" resolve to real pages.
export const LEGAL_LINKS = [
  { label: 'Terms of Service', href: '/terms' },
  { label: 'Privacy Policy', href: '/privacy' },
  { label: 'Code of Conduct', href: '/code-or-conduct' },
];

export function LegalFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <p>QIG Memory API — persistent memory + kernel mesh.</p>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {LEGAL_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="font-medium transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <p className="text-xs text-muted-foreground/80">
          The original REST API remains fully functional and unchanged.
        </p>
      </div>
    </footer>
  );
}
