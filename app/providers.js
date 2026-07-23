'use client';

/**
 * app/providers.js
 *
 * Client-component wrapper that holds all React context providers.
 * Kept separate from app/layout.js so the root layout can remain a
 * server component (Next.js requirement) while still supplying context.
 */

import { AuthProvider } from '@/shared/context/AuthContext';

export default function Providers({ children }) {
  return (
    <AuthProvider>
      {children}
    </AuthProvider>
  );
}
