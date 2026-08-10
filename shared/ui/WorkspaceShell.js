'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  useWorkspace,
  useWorkspaceDispatch,
  WORKSPACE_MODULES,
  WORKSPACE_PATHS,
} from '@/shared/context/WorkspaceContext';
import { useAuth } from '@/shared/context/AuthContext';

// Feature flag is now runtime-driven: set via admin_settings table,
// key = 'workspace_tabs_enabled', value = 'true' to enable for all users.
// No hardcoded roles — change the DB row to enable/disable without a deploy.

// ─── Lazy module components ───────────────────────────────────────────────────
// ssr:false — all modules are 'use client' with browser-only Supabase fetching.
// Only the bundle for the first module a user opens is downloaded immediately;
// the rest load on demand and are then cached by the browser.
const MODULE_COMPONENTS = {
  orders:     dynamic(() => import('@/modules/orders/components/OrdersModule'),          { ssr: false }),
  crm:        dynamic(() => import('@/modules/crm/components/CrmModule'),               { ssr: false }),
  suppliers:  dynamic(() => import('@/modules/suppliers/components/SuppliersModule'),   { ssr: false }),
  dashboard:  dynamic(() => import('@/modules/dashboard/components/Dashboard'),          { ssr: false }),
  customers:  dynamic(() => import('@/modules/customers/components/CustomersModule'),    { ssr: false }),
  payroll:    dynamic(() => import('@/modules/payroll/components/PayrollModule'),        { ssr: false }),
  reports:    dynamic(() => import('@/modules/reports/components/Reports'),              { ssr: false }),
  contacts:   dynamic(() => import('@/modules/contacts/components/ContactsModule'),      { ssr: false }),
  accounting: dynamic(() => import('@/modules/accounting/components/AccountingReview'), { ssr: false }),
};

// ─── Per-module URL param extraction ─────────────────────────────────────────
// Maps module IDs to functions that pull relevant search params and return
// them as the `props` object forwarded to the module component.
// This replaces the defaultAction / prefill processing that previously lived
// in each module's page.js wrapper.
function extractModuleProps(moduleId, searchParams) {
  if (moduleId === 'crm') {
    const newParam   = searchParams.get('new');
    const customerId = searchParams.get('customer_id');
    const enquiryId  = searchParams.get('enquiry_id');
    const props      = {};
    if (newParam === 'enquiry' || newParam === 'quote') props.defaultAction = newParam;
    if (customerId) props.defaultCustomerId = customerId;
    if (enquiryId)  props.defaultEnquiryId  = enquiryId;
    return props;
  }
  if (moduleId === 'customers') {
    const newParam     = searchParams.get('new');
    const prospectName = searchParams.get('prospect_name');
    const phone        = searchParams.get('phone');
    const props        = {};
    if (newParam)      props.defaultAction       = newParam;
    if (prospectName)  props.defaultProspectName = prospectName;
    if (phone)         props.defaultPhone        = phone;
    return props;
  }
  return {};
}

// ─── WorkspaceShellInner (needs useSearchParams — wrapped in Suspense below) ─
function WorkspaceShellInner({ children }) {
  const { tabs, activeTabId, limitReached } = useWorkspace();
  const dispatch                             = useWorkspaceDispatch();
  const router                               = useRouter();
  const pathname                             = usePathname();
  const searchParams                         = useSearchParams();
  const { userRole }                         = useAuth();

  // Local visited Set: gates lazy-mounting (a module only renders after its
  // tab has been activated at least once). Separate from the reducer's
  // `mounted` flag — visited drives rendering, mounted drives stale-marking.
  const [visited,    setVisited]    = useState(() => new Set());
  const [showPicker, setShowPicker] = useState(false);

  // ── Helper: can the current user access a module? ────────────────────────
  function canAccess(mod) {
    return mod.allowedRoles.includes(userRole);
  }

  // ── Auto-open / switch tab when navigating to a workspace path ────────────
  // Observes both pathname AND searchParams so that navigating to
  // /crm?new=quote while the CRM tab is already active (pathname unchanged)
  // still triggers and opens the quote form.
  useEffect(() => {
    const mod = WORKSPACE_MODULES.find(m => m.path === pathname);
    if (!mod || !canAccess(mod)) return;

    const rawProps = extractModuleProps(mod.id, searchParams);

    // Add a unique nonce whenever an action prop is present. This ensures the
    // module's useEffect([defaultAction, actionNonce]) re-fires even when the
    // same action (e.g. 'quote') is triggered twice in a row.
    const hasAction = Object.keys(rawProps).length > 0;
    const extraProps = hasAction
      ? { ...rawProps, actionNonce: Date.now() }
      : rawProps;

    const existing = tabs.find(t => t.moduleId === mod.id);
    if (existing) {
      if (existing.id !== activeTabId) {
        dispatch({ type: 'SWITCH_TAB', id: existing.id });
      }
      // Forward any URL action to the already-open tab.
      if (hasAction) {
        dispatch({ type: 'SET_TAB_PROPS', id: existing.id, props: extraProps });
      }
    } else {
      // Only navigate + open if we're under the 4-tab limit.
      if (tabs.length >= 4) {
        dispatch({ type: 'OPEN_TAB', moduleId: mod.id, extraProps }); // sets limitReached
        // Restore the URL to the currently active tab so the address bar does
        // not show the blocked module's path while its content never appears.
        const currentTab = tabs.find(t => t.id === activeTabId);
        const currentMod = WORKSPACE_MODULES.find(m => m.id === currentTab?.moduleId);
        if (currentMod) router.replace(currentMod.path, { scroll: false });
        return;
      }
      dispatch({ type: 'OPEN_TAB', moduleId: mod.id, extraProps });
    }

    // Strip the action params from the URL so Back doesn't re-trigger the form.
    if (hasAction) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('new');
      params.delete('customer_id');
      params.delete('enquiry_id');
      params.delete('prospect_name');
      params.delete('phone');
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams.toString()]);

  // ── Lazy-mount + staleness tracking when active tab changes ──────────────
  // Staleness is TIME-BASED (15 min), not switch-based.
  // alwaysFresh modules (Dashboard, Reports) always bump refreshKey on activation.
  const STALE_THRESHOLD_MS = 15 * 60 * 1000;

  useEffect(() => {
    if (!activeTabId) return;

    // Mark the tab as visited so its module slot renders.
    setVisited(prev => {
      if (prev.has(activeTabId)) return prev;
      const next = new Set(prev);
      next.add(activeTabId);
      return next;
    });

    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    const mod = WORKSPACE_MODULES.find(m => m.id === tab.moduleId);

    if (!tab.mounted) {
      // First-ever activation — module mounts fresh. MARK_MOUNTED sets lastFetchedAt
      // so the staleness clock starts from this initial data load.
      dispatch({ type: 'MARK_MOUNTED', id: activeTabId });
    } else if (mod?.alwaysFresh) {
      // Dashboard / Reports: always re-fetch on every activation.
      // BUMP_REFRESH also resets lastFetchedAt.
      dispatch({ type: 'BUMP_REFRESH', id: activeTabId });
    } else if (tab.stale) {
      // Explicit cross-module invalidation via MARK_SIBLINGS_STALE.
      dispatch({ type: 'BUMP_REFRESH', id: activeTabId });
    } else if (tab.lastFetchedAt && Date.now() - tab.lastFetchedAt > STALE_THRESHOLD_MS) {
      // Data was loaded more than 15 minutes ago — refresh silently on return.
      // lastFetchedAt only advances when data is actually fetched (MARK_MOUNTED /
      // BUMP_REFRESH), so repeated visits without a fetch cannot reset the clock.
      dispatch({ type: 'BUMP_REFRESH', id: activeTabId });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // ── Switch tab: update context + push canonical URL ───────────────────────
  function switchTab(id) {
    if (id === activeTabId) return;
    dispatch({ type: 'SWITCH_TAB', id });
    const tab = tabs.find(t => t.id === id);
    const mod = WORKSPACE_MODULES.find(m => m.id === tab?.moduleId);
    if (mod) router.push(mod.path, { scroll: false });
  }

  // ── Close tab: update context + navigate to the fallback tab / home ───────
  function closeTab(e, id) {
    e.stopPropagation();
    const idx      = tabs.findIndex(t => t.id === id);
    const isActive = id === activeTabId;
    dispatch({ type: 'CLOSE_TAB', id });
    if (isActive) {
      const remaining = tabs.filter(t => t.id !== id);
      const fallback  = remaining[Math.min(idx, remaining.length - 1)];
      if (fallback) {
        const mod = WORKSPACE_MODULES.find(m => m.id === fallback.moduleId);
        router.push(mod ? mod.path : '/', { scroll: false });
      } else {
        router.push('/', { scroll: false });
      }
    }
  }

  // ── Open a module from the picker ─────────────────────────────────────────
  function openFromPicker(moduleId) {
    setShowPicker(false);
    const mod = WORKSPACE_MODULES.find(m => m.id === moduleId);
    if (!mod) return;

    const alreadyOpen = tabs.some(t => t.moduleId === moduleId);

    // If at the limit and the module is NOT already open, dispatch (sets
    // limitReached=true and shows the prompt) but do NOT navigate — the
    // address bar must not show a path whose content isn't visible.
    if (!alreadyOpen && tabs.length >= 4) {
      dispatch({ type: 'OPEN_TAB', moduleId });
      return;
    }

    dispatch({ type: 'OPEN_TAB', moduleId });
    router.push(mod.path, { scroll: false });
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  // Show workspace module content only when there is an active tab AND the
  // current URL is a workspace root path. For deep routes (/orders/123,
  // /customers/456, /) children are always shown regardless of open tabs.
  const isWorkspacePath      = WORKSPACE_PATHS.has(pathname);
  const showWorkspaceContent = activeTabId !== null && isWorkspacePath;

  // Modules the current user is allowed to open.
  const accessibleMods = WORKSPACE_MODULES.filter(canAccess);

  return (
    <>
      {/* ── Tab strip ────────────────────────────────────────────────────── */}
      {/* Only shown on workspace paths — regular nav pages (/orders etc.) render
          without the tab strip so they don't appear to "render inside" the workspace. */}
      {tabs.length > 0 && isWorkspacePath && (
        <div
          role="tablist"
          aria-label="Open modules"
          style={{
            background: '#111',
            borderBottom: '1px solid #222',
            display: 'flex',
            alignItems: 'stretch',
            padding: '0 4px',
            gap: '2px',
            height: '36px',
            position: 'sticky',
            top: '56px',          // flush below the 56px AppShell header
            zIndex: 90,
            overflowX: 'auto',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          {tabs.map(tab => {
            const mod      = WORKSPACE_MODULES.find(m => m.id === tab.moduleId);
            const isActive = tab.id === activeTabId;
            const color    = mod?.color || '#E8512A';

            // ── Fix #8: outer element is a div[role=tab], not a <button>.
            // This prevents the invalid nested-button HTML that was previously
            // caused by having a close <button> inside a tab <button>.
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                aria-label={mod?.label || tab.moduleId}
                onClick={() => switchTab(tab.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    switchTab(tab.id);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '0 6px 0 10px',
                  background: isActive ? '#1e1e1e' : 'transparent',
                  borderBottom: isActive ? `2px solid ${color}` : '2px solid transparent',
                  borderTop: '2px solid transparent',
                  color: isActive ? '#fff' : '#666',
                  fontSize: '12px',
                  fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'color .15s, background .15s',
                  userSelect: 'none',
                  letterSpacing: '0.01em',
                }}
              >
                {/* colour dot */}
                <span style={{
                  width: '6px', height: '6px', borderRadius: '50%',
                  background: color, flexShrink: 0,
                  opacity: isActive ? 1 : 0.45,
                  transition: 'opacity .15s',
                }} />

                {mod?.label || tab.moduleId}

                {/* amber dot = data older than 15 min (shown on background mounted tabs) */}
                {tab.mounted && !isActive && tab.lastFetchedAt &&
                  Date.now() - tab.lastFetchedAt > 15 * 60 * 1000 && (
                  <span
                    title="Data may be outdated — will refresh when you switch to this tab"
                    style={{
                      width: '5px', height: '5px', borderRadius: '50%',
                      background: '#F59E0B', flexShrink: 0,
                    }}
                  />
                )}

                {/* close button — the only <button> inside this tab item */}
                <button
                  onClick={e => closeTab(e, tab.id)}
                  aria-label={`Close ${mod?.label || tab.moduleId} tab`}
                  title={`Close ${mod?.label || tab.moduleId}`}
                  style={{
                    background: 'none', border: 'none',
                    color: isActive ? '#777' : '#444',
                    fontSize: '11px', lineHeight: 1,
                    cursor: 'pointer', padding: '2px 4px',
                    borderRadius: '3px',
                    fontFamily: 'inherit',
                    transition: 'color .1s, background .1s',
                    flexShrink: 0,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#333'; e.currentTarget.style.color = '#fff'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = isActive ? '#777' : '#444'; }}
                >
                  ✕
                </button>
              </div>
            );
          })}

          {/* + open-another-module button */}
          <button
            onClick={() => setShowPicker(p => !p)}
            aria-label="Open another module"
            aria-expanded={showPicker}
            title="Open another module"
            style={{
              background: 'none', border: 'none',
              color: showPicker ? '#fff' : '#444',
              fontSize: '20px', lineHeight: '32px',
              cursor: 'pointer', padding: '0 12px',
              alignSelf: 'center',
              fontFamily: 'inherit',
              transition: 'color .1s',
            }}
          >
            +
          </button>
        </div>
      )}

      {/* ── 4-tab limit prompt ───────────────────────────────────────────── */}
      {limitReached && isWorkspacePath && (
        <div style={{
          background: '#2a1a0a',
          borderBottom: '1px solid #5a3a1a',
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontSize: '12px',
          color: '#F59E0B',
        }}>
          <span>You have 4 tabs open — the maximum. Close a tab to open another module.</span>
          <button
            onClick={() => dispatch({ type: 'CLEAR_LIMIT_REACHED' })}
            aria-label="Dismiss"
            style={{
              marginLeft: 'auto', background: 'none', border: 'none',
              color: '#F59E0B', cursor: 'pointer', fontSize: '14px',
              padding: '2px 6px', borderRadius: '3px', fontFamily: 'inherit',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Module picker dropdown ───────────────────────────────────────── */}
      {showPicker && (
        <>
          <div
            aria-hidden="true"
            style={{ position: 'fixed', inset: 0, zIndex: 149 }}
            onClick={() => setShowPicker(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Open module"
            style={{
              position: 'fixed',
              top: tabs.length > 0 ? '96px' : '60px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: '#1a1a1a',
              border: '1px solid #2a2a2a',
              borderRadius: '10px',
              padding: '12px',
              zIndex: 150,
              minWidth: '300px',
              boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{
              fontSize: '10px', color: '#555', marginBottom: '10px',
              padding: '0 2px', letterSpacing: '.08em', textTransform: 'uppercase',
            }}>
              Open module
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
              {accessibleMods.map(mod => {
                const alreadyOpen = tabs.some(t => t.moduleId === mod.id);
                return (
                  <button
                    key={mod.id}
                    onClick={() => openFromPicker(mod.id)}
                    style={{
                      padding: '10px 6px', borderRadius: '8px',
                      border: `1px solid ${alreadyOpen ? mod.color + '55' : '#2a2a2a'}`,
                      background: alreadyOpen ? mod.color + '18' : '#111',
                      color: alreadyOpen ? mod.color : '#999',
                      fontSize: '11px', cursor: 'pointer',
                      textAlign: 'center', fontFamily: 'inherit',
                      transition: 'all .12s', lineHeight: 1.4,
                    }}
                  >
                    <div style={{ fontSize: '18px', marginBottom: '4px' }}>{mod.icon}</div>
                    {mod.label}
                    {alreadyOpen && (
                      <div style={{ fontSize: '9px', opacity: 0.55, marginTop: '2px', letterSpacing: '.06em' }}>
                        OPEN
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Keep-mounted module slots ────────────────────────────────────── */}
      {/* display toggling keeps React trees alive so filters, scroll, and
          open forms survive tab switches. Only the active slot is visible. */}
      {tabs.map(tab => {
        const isActive     = tab.id === activeTabId;
        const hasVisited   = visited.has(tab.id);
        const ModComponent = MODULE_COMPONENTS[tab.moduleId];
        return (
          <div
            key={tab.id}
            role="tabpanel"
            aria-label={WORKSPACE_MODULES.find(m => m.id === tab.moduleId)?.label}
            style={{
              display: showWorkspaceContent && isActive ? 'block' : 'none',
              minHeight: 'calc(100vh - 92px)',   // 56px header + 36px tab strip
            }}
          >
            {/* Lazy-mount: only render after the first activation */}
            {hasVisited && ModComponent && (
              <ModComponent
                workspaceActive={showWorkspaceContent && isActive}
                refreshKey={tab.refreshKey}
                {...tab.props}
              />
            )}
          </div>
        );
      })}

      {/* ── Next.js page content ─────────────────────────────────────────── */}
      {/* Fix #2: on workspace root paths with an active tab, children is NOT
          rendered at all — not even hidden. This eliminates the double-mount
          of CrmModule (once from WorkspaceShell, once from /crm/page.js).
          On deep routes (/orders/123, /customers/456, home) or when no
          workspace tab covers the current path, children renders normally. */}
      {!showWorkspaceContent && children}
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────
// Renders nothing until auth has fully resolved (loaded=true) to prevent the
// startup double-mount: before auth resolves, userRole defaults to 'viewer'
// which would cause children to render, then unmount when workspace activates.
//
// workspaceEnabled is derived from admin_settings in AuthContext — no code
// deploy needed to enable/disable per user.
export default function WorkspaceShell({ children }) {
  const { loaded, workspaceEnabled } = useAuth();

  // While auth is still loading, render nothing — not children. This prevents
  // the brief "viewer sees children" → "admin sees workspace" double-mount.
  if (!loaded) return null;

  // Feature disabled for this user: transparent pass-through.
  if (!workspaceEnabled) return children;

  // useSearchParams() requires a Suspense boundary in the Next.js App Router.
  // fallback=null (not children) to avoid mounting the page component twice
  // while the inner shell hydrates.
  return (
    <Suspense fallback={null}>
      <WorkspaceShellInner>{children}</WorkspaceShellInner>
    </Suspense>
  );
}
