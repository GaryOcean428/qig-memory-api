import { GitBranch, Radio, Ruler } from 'lucide-react';

const FEATURES = [
  {
    icon: GitBranch,
    title: 'Register & sync',
    body: 'Agents register a substrate + capabilities, then heartbeat their 64D basin coordinates into a shared registry.',
  },
  {
    icon: Ruler,
    title: 'Fisher-Rao geometry',
    body: 'Peer distances are geodesics on the simplex — not Euclidean cosine. Coordinates must be non-negative and sum to ~1.',
  },
  {
    icon: Radio,
    title: 'Bidirectional mesh',
    body: 'Every heartbeat returns peers\u2019 coordinates, so the council converges toward a shared basin over time.',
  },
];

export function KernelSection() {
  return (
    <div id="kernel" className="scroll-mt-24">
      <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
        Kernel Mesh
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        A lightweight coordination layer that lets any agent join the QIG / Pantheon council and
        measure how close its representation sits to its peers.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <div key={title} className="elev-card rounded-xl border border-border bg-card p-5">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent-text">
              <Icon className="h-5 w-5" />
            </span>
            <h3 className="mt-4 text-sm font-semibold text-foreground">{title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-border bg-muted/50 p-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Distance metric
        </span>
        <pre className="mt-2 overflow-x-auto font-mono text-sm text-foreground">
          <code>{'d_FR(p, q) = 2 \u00b7 arccos( \u03a3\u1d62 \u221a(p\u1d62 \u00b7 q\u1d62) )'}</code>
        </pre>
      </div>
    </div>
  );
}
