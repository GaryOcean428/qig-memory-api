import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'QIG Memory API — Persistent Memory + Kernel Mesh',
  description:
    'Persistent key-value memory and Fisher-Rao kernel mesh for the QIG / Pantheon agent council. Connect over REST or MCP.',
};

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0e1a' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
};

// FOUC prevention — applies .dark / .light to <html> before first paint.
// Mirrors getThemeInitScript() from @bsuite/theme/ssr (default: dark).
const themeInitScript = `(function(){try{var s=localStorage.getItem('bsuite_theme');var t=s||'dark';var r=t;if(t==='system'){r=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var c=document.documentElement.classList;if(r==='dark'){c.add('dark');c.remove('light');}else{c.add('light');c.remove('dark');}}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
