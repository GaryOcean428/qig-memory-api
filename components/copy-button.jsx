'use client';

import { useCallback, useRef, useState } from 'react';
import { Button } from '@bsuite/ui';
import { Check, Copy } from 'lucide-react';

/**
 * Copy-to-clipboard button with inline success feedback (no blocking alert).
 * Falls back to a hidden textarea + execCommand when the async Clipboard API
 * is unavailable (e.g. non-secure contexts / older embedded webviews).
 */
export function CopyButton({ value, label = 'Copy', copiedLabel = 'Copied', className, variant = 'primary', size = 'md' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [value]);

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={copy}
      className={className}
      aria-label={copied ? copiedLabel : label}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      <span>{copied ? copiedLabel : label}</span>
    </Button>
  );
}
