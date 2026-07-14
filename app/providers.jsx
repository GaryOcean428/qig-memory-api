'use client';

import { ThemeProvider } from '@bsuite/theme/react';

export function Providers({ children }) {
  return <ThemeProvider defaultTheme="dark">{children}</ThemeProvider>;
}
