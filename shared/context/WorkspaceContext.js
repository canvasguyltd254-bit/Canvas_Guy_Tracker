'use client';
import React, { createContext, useContext, useReducer } from 'react';

// ─── Module registry (roles pulled from module configs — single source of truth)
// We import the registry at module load time so roles never drift from the real
// permission definitions in each module's config.js.
import * as moduleRegistry from '@/modules/registry';

// Visual / path metadata lives here; permissions come from the registry above.
// alwaysFresh: true  — module re-fetches every time its tab is activated
//                      (Dashboard and Reports show live aggregates; stale is meaningless).
const MODULE_META = [
  { id: 'orders',     label: 'Orders',     path: '/orders',     color: '#E8512A', icon: '📦' },
  { id: 'crm',        label: 'CRM',        path: '/crm',        color: '#D44A25', icon: '🤝' },
  { id: 'suppliers',  label: 'Suppliers',  path: '/suppliers',  color: '#1D9E75', icon: '🚚' },
  { id: 'dashboard',  label: 'Dashboard',  path: '/dashboard',  color: '#378ADD', icon: '📊', alwaysFresh: true },
  { id: 'customers',  label: 'Customers',  path: '/customers',  color: '#7C3AED', icon: '👥' },
  { id: 'payroll',    label: 'Payroll',    path: '/payroll',    color: '#7F77DD', icon: '💰' },
  { id: 'reports',    label: 'Reports',    path: '/reports',    color: '#BA7517', icon: '📈', alwaysFresh: true },
  { id: 'contacts',   label: 'Contacts',   path: '/contacts',   color: '#0F6E56', icon: '📋' },
  { id: 'accounting', label: 'Accounting', path: '/accounting', color: '#993C1D', icon: '🧾' },
];

// Merge visual metadata with canonical allowedRoles from module configs.
export const WORKSPACE_MODULES = MODULE_META.map(m => ({
  ...m,
  allowedRoles: moduleRegistry[m.id]?.allowedRoles ?? [],
}));

export const WORKSPACE_PATHS = new Set(WORKSPACE_MODULES.map(m => m.path));

// ─── State shape ─────────────────────────────────────────────────────────────
//
// tabs: Array<{
//   id:              string        — stable key (never changes after creation)
//   moduleId:        string        — e.g. 'crm'
//   refreshKey:      number        — bumped to signal a re-fetch (module's useEffect dep)
//   stale:           boolean       — cross-module invalidation via MARK_SIBLINGS_STALE only;
//                                    normal switch-based staleness is now time-based
//   mounted:         boolean       — true after the module has rendered at least once
//   lastFetchedAt:   number|null   — Date.now() when the module last loaded its data
//                                    (set on MARK_MOUNTED and BUMP_REFRESH, not on visit);
//                                    used to compute 15-minute time-based staleness
//   props:           object        — extra props forwarded to the module (e.g. defaultAction)
// }>
// activeTabId:  string | null
// limitReached: boolean       — true when OPEN_TAB was blocked by the 4-tab limit;
//                               WorkspaceShell renders a close-one prompt instead of
//                               silently evicting a tab.

const MAX_TABS = 4;

function makeId(moduleId) {
  return `ws-${moduleId}-${Date.now()}`;
}

const INITIAL_STATE = { tabs: [], activeTabId: null, limitReached: false };

function reducer(state, action) {
  const { tabs, activeTabId } = state;

  switch (action.type) {

    // ── Open a tab ────────────────────────────────────────────────────────────
    // If the module is already open, switch to it (and optionally update props).
    // If the 4-tab limit is reached, set limitReached=true and do NOT evict.
    case 'OPEN_TAB': {
      const { moduleId, extraProps = {} } = action;

      // Already open → switch + merge any new props (e.g. from URL params).
      const existing = tabs.find(t => t.moduleId === moduleId);
      if (existing) {
        const updatedTabs = Object.keys(extraProps).length
          ? tabs.map(t => t.id === existing.id
              ? { ...t, props: { ...t.props, ...extraProps } }
              : t)
          : tabs;
        return { tabs: updatedTabs, activeTabId: existing.id, limitReached: false };
      }

      // At limit → prompt the user instead of silently destroying work.
      if (tabs.length >= MAX_TABS) {
        return { ...state, limitReached: true };
      }

      const newTab = {
        id:              makeId(moduleId),
        moduleId,
        refreshKey:      0,
        stale:           false,
        mounted:         false,        // set true by MARK_MOUNTED once the module renders
        lastFetchedAt:   null,         // set by MARK_MOUNTED + BUMP_REFRESH; drives 15-min staleness
        props:           extraProps,
      };
      return { tabs: [...tabs, newTab], activeTabId: newTab.id, limitReached: false };
    }

    // ── Close a tab ───────────────────────────────────────────────────────────
    case 'CLOSE_TAB': {
      const { id } = action;
      const nextTabs  = tabs.filter(t => t.id !== id);
      let newActive   = activeTabId;
      if (activeTabId === id) {
        const idx     = tabs.findIndex(t => t.id === id);
        const fallback = nextTabs[Math.min(idx, nextTabs.length - 1)];
        newActive     = fallback ? fallback.id : null;
      }
      return { tabs: nextTabs, activeTabId: newActive, limitReached: false };
    }

    // ── Switch to an existing tab ─────────────────────────────────────────────
    // Does NOT immediately mark siblings stale — staleness is now time-based
    // (15 minutes, checked in WorkspaceShell's activeTabId effect). This
    // eliminates the "every switch triggers a re-fetch" behaviour.
    case 'SWITCH_TAB': {
      const { id } = action;
      return { ...state, activeTabId: id, limitReached: false };
    }

    // ── Mark a tab as mounted ─────────────────────────────────────────────────
    // Dispatched by WorkspaceShell on first activation. Records the initial
    // fetch time so the 15-minute staleness clock starts from first data load,
    // not from when the user returns to the tab.
    case 'MARK_MOUNTED': {
      const { id } = action;
      return {
        ...state,
        tabs: tabs.map(t =>
          t.id === id ? { ...t, mounted: true, lastFetchedAt: Date.now() } : t
        ),
      };
    }

    // ── Bump refreshKey when a stale tab becomes active ───────────────────────
    // The module's data-fetching useEffect depends on refreshKey, so bumping
    // it triggers a re-fetch without unmounting the component.
    case 'BUMP_REFRESH': {
      const { id } = action;
      return {
        ...state,
        tabs: tabs.map(t =>
          t.id === id
            ? { ...t, refreshKey: t.refreshKey + 1, stale: false, lastFetchedAt: Date.now() }
            : t
        ),
      };
    }

    // ── Update a tab's extra props ─────────────────────────────────────────────
    // Used when a URL action arrives for a tab that is already open
    // (e.g. /crm?new=quote while CRM tab is already mounted).
    case 'SET_TAB_PROPS': {
      const { id, props } = action;
      return {
        ...state,
        tabs: tabs.map(t => t.id === id ? { ...t, props: { ...t.props, ...props } } : t),
      };
    }

    // ── Explicitly stale-mark sibling tabs ────────────────────────────────────
    // Dispatched by a module after it mutates shared data (e.g. creates a quote
    // from CRM which should invalidate Customers tab data).
    case 'MARK_SIBLINGS_STALE': {
      const { exceptId } = action;
      return {
        ...state,
        tabs: tabs.map(t =>
          t.id !== exceptId && t.mounted ? { ...t, stale: true } : t
        ),
      };
    }

    // ── Clear the limit-reached prompt ────────────────────────────────────────
    case 'CLEAR_LIMIT_REACHED':
      return { ...state, limitReached: false };

    default:
      return state;
  }
}

// ─── Contexts ─────────────────────────────────────────────────────────────────
const WorkspaceContext         = createContext(INITIAL_STATE);
const WorkspaceDispatchContext = createContext(null);

// ─── Provider ─────────────────────────────────────────────────────────────────
export function WorkspaceProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  return (
    <WorkspaceContext.Provider value={state}>
      <WorkspaceDispatchContext.Provider value={dispatch}>
        {children}
      </WorkspaceDispatchContext.Provider>
    </WorkspaceContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────
export function useWorkspace()         { return useContext(WorkspaceContext); }
export function useWorkspaceDispatch() { return useContext(WorkspaceDispatchContext); }
