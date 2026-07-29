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

export default function TrackerLayout({ children }) {
  return <AppShell>{children}</AppShell>;
}
