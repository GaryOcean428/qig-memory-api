import { useId } from 'react';

/**
 * GridPattern — fine line-grid background for "outside" surfaces (landing/marketing).
 * Single native SVG <pattern> tile (~1 DOM node); stroke uses currentColor so it
 * themes via any text-* class (defaults to the theme-reactive text-border).
 */
export function GridPattern({ size = 40, strokeWidth = 1, className, ...props }) {
  const id = useId();
  const classes = ['pointer-events-none absolute inset-0 h-full w-full text-border', className]
    .filter(Boolean)
    .join(' ');

  return (
    <svg aria-hidden="true" className={classes} {...props}>
      <defs>
        <pattern id={`${id}-grid`} width={size} height={size} patternUnits="userSpaceOnUse">
          <path
            d={`M ${size} 0 L 0 0 0 ${size}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id}-grid)`} />
    </svg>
  );
}
