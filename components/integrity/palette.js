// The SOLE colour source for the integrity dashboard.
//
// Braden is colourblind. The palette is deliberately OFF the red-green axis:
//   purple = CERTIFIED   blue = OPEN   amber = RETIRED
// and every status ALSO carries a TEXT label, so colour is never the only
// signal. Tailwind v4's default palette is oklch, so these classes are
// oklch-backed. Do NOT use @bsuite/ui StatusBadge tones `success`/`destructive`
// on this surface (the red-green trap the sibling frozen-facts dashboard falls
// into) — nothing outside this module sets an integrity colour.

export const KINDS = {
  certified: {
    label: 'CERTIFIED',
    text: 'text-purple-700 dark:text-purple-300',
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/30',
    dot: 'bg-purple-500',
  },
  open: {
    label: 'OPEN',
    text: 'text-blue-700 dark:text-blue-300',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30',
    dot: 'bg-blue-500',
  },
  retired: {
    label: 'RETIRED',
    text: 'text-amber-700 dark:text-amber-300',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    dot: 'bg-amber-500',
  },
  // In-flight / dormant / neutral facts render grey — never green, never red.
  neutral: {
    label: '',
    text: 'text-muted-foreground',
    bg: 'bg-muted/40',
    border: 'border-border',
    dot: 'bg-muted-foreground',
  },
};

// A status chip that renders colour AND text. `label` overrides the kind's
// default word (e.g. an in-flight class like "planned"); the colour is decided
// only by `kind`, so a caller can never accidentally introduce a new colour.
export function StatusPill({ kind = 'neutral', label, className = '', mono = false }) {
  const k = KINDS[kind] || KINDS.neutral;
  const text = label ?? k.label;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${k.border} ${k.bg} ${k.text} ${mono ? 'font-mono' : ''} ${className}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${k.dot}`} aria-hidden="true" />
      {text}
    </span>
  );
}
