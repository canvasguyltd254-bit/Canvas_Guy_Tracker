'use client';

/**
 * shared/context/AuthContext.js
 *
 * Fetches auth (session + role) exactly ONCE per browser session and
 * shares the result via React Context.
 *
 * Why this matters for performance:
 *   Before: AppShell lives inside every page component. Each navigation
 *   unmounts + remounts AppShell, triggering two sequential Supabase calls
 *   (getUser() — a network round-trip — then a user_profiles query). That
 *   costs 300–700 ms of nav-bar flash on every route change.
 *
 *   After: AuthProvider sits in app/layout.js and never unmounts. Auth is
 *   resolved once; subsequent AppShell renders call useAuth() and get cached
 *   values synchronously — the nav bar renders correct and instantly on every
 *   navigation.
 *
 * getSession() vs getUser():
 *   getUser()    — validates the JWT with Supabase's auth server (network).
 *   getSession() — reads the session from the browser cookie (local, instant).
 *   For an internal tool behind login, getSession() is appropriate.
 *   The onAuthStateChange listener keeps the session in sync with sign-out.
 */

import { createContext, useContext, useState, useEffect } from 'react';
import { createClient } from '@/shared/supabase/client';

const AuthContext = createContext({
  user:        null,
  userRole:    'viewer',
  displayName: '',
  loaded:      false,
});

export function AuthProvider({ children }) {
  const [user,        setUser]        = useState(null);
  const [userRole,    setUserRole]    = useState('viewer');
  const [displayName, setDisplayName] = useState('');
  const [loaded,      setLoaded]      = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // Read session from local cookie — no network round-trip.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const u = session?.user ?? null;
      setUser(u);

      if (u) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role, display_name')
          .eq('id', u.id)
          .single();

        if (profile) {
          setUserRole(profile.role || 'viewer');
          setDisplayName(profile.display_name || '');
        }
      }

      setLoaded(true);
    });

    // Keep context in sync when the user signs out in another tab or the
    // session expires — fires without a network call for local state changes.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        const u = session?.user ?? null;
        setUser(u);
        if (!u) {
          setUserRole('viewer');
          setDisplayName('');
          setLoaded(true);
        }
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ user, userRole, displayName, loaded }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
