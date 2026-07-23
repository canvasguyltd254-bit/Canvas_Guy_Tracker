/**
 * app/layout.js — root layout (server component)
 *
 * next/font self-hosts DM Sans, DM Mono and Space Grotesk from
 * /_next/static/media/ instead of fetching from fonts.googleapis.com.
 * Benefits vs the old @import approach:
 *   • No external DNS lookup or TCP connection on every page load
 *   • Fonts declared with <link rel="preload"> in <head> automatically
 *   • font-display: swap built in — text visible immediately in fallback font
 *   • Zero layout shift from font swap (size-adjust applied by Next.js)
 */

import './globals.css';
import { DM_Sans, DM_Mono, Space_Grotesk } from 'next/font/google';
import Providers from './providers';

const dmSans = DM_Sans({
  subsets:  ['latin'],
  weight:   ['400', '500', '600', '700', '800'],
  display:  'swap',
  variable: '--font-dm-sans',
});

const dmMono = DM_Mono({
  subsets:  ['latin'],
  weight:   ['400', '500'],
  display:  'swap',
  variable: '--font-dm-mono',
});

const spaceGrotesk = Space_Grotesk({
  subsets:  ['latin'],
  weight:   ['400', '500', '600', '700'],
  display:  'swap',
  variable: '--font-space-grotesk',
});

export const metadata = {
  title:       'Canvas Guy Limited — Production Tracker',
  description: 'Internal order and production management system',
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${dmMono.variable} ${spaceGrotesk.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
