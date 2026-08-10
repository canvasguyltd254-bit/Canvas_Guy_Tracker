/**
 * app/(tracker)/layout.js — persistent protected-app layout
 *
 * All module pages live under this route group so AppShell mounts ONCE
 * and stays mounted as the user navigates between modules. Previously
 * every page wrapped itself in <AppShell>, which unmounted and remounted
 * the shell (and re-ran its effects) on every navigation.
 *
 * URL paths are unchanged — Next.js strips the (tracker) group segment.
 * /dashboard, /orders, /suppliers, /payroll, etc. all resolve as before.
 *
 * Pages under this layout should NOT import or render <AppShell> themselves.
 */

import AppShell from '@/shared/ui/AppShell';
import WorkspaceShell from '@/shared/ui/WorkspaceShell';
import { WorkspaceProvider } from '@/shared/context/WorkspaceContext';

/**
 * WorkspaceShell lives here — not inside AppShell — so AppShell stays
 * unaware of the workspace feature. The <main> wrapper also moves here
 * so WorkspaceShell can render its tab strip full-width before the
 * content container and still receive the page as its children.
 */
export default function TrackerLayout({ children }) {
  return (
    <WorkspaceProvider>
      <AppShell>
        <WorkspaceShell>
          <main style={{
            maxWidth: '1200px',
            margin: '0 auto',
            minHeight: 'calc(100vh - 56px)',
            paddingBottom: '32px',
          }}>
            {children}
          </main>
        </WorkspaceShell>
      </AppShell>
    </WorkspaceProvider>
  );
}
