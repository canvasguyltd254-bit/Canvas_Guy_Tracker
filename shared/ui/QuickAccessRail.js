'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  BarChart3,
  BookOpen,
  ClipboardList,
  ContactRound,
  Factory,
  Handshake,
  House,
  Landmark,
  ShieldCheck,
  Truck,
  Users,
  WalletCards,
} from 'lucide-react';
import {
  getAdminQuickAccess,
  getQuickAccessModules,
  isPathActive,
} from '@/shared/lib/quickAccess';

const ICONS = {
  orders: ClipboardList,
  crm: Handshake,
  production: Factory,
  suppliers: Truck,
  customers: Users,
  payroll: WalletCards,
  cashflow: Landmark,
  accounting: BookOpen,
  reports: BarChart3,
  contacts: ContactRound,
  admin: ShieldCheck,
};

function RailLink({ href, label, active, icon: Icon, onShowTooltip, onHideTooltip }) {
  return (
    <Link
      href={href}
      className={`quick-access-link${active ? ' is-active' : ''}`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={event => onShowTooltip(event.currentTarget, label)}
      onMouseLeave={onHideTooltip}
      onFocus={event => onShowTooltip(event.currentTarget, label)}
      onBlur={onHideTooltip}
    >
      <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
    </Link>
  );
}

export default function QuickAccessRail({ modules, userRole, loaded }) {
  const pathname = usePathname();
  const [tooltip, setTooltip] = useState(null);

  const showTooltip = (element, label) => {
    const rect = element.getBoundingClientRect();
    setTooltip({ label, left: rect.right + 10, top: rect.top + rect.height / 2 });
  };

  if (!loaded) {
    return <aside className="quick-access-rail is-loading" aria-hidden="true" />;
  }

  const shortcuts = getQuickAccessModules(modules, userRole);
  const admin = getAdminQuickAccess(modules, userRole);

  return (
    <aside className="quick-access-rail" aria-label="Quick access">
      <nav className="quick-access-nav" aria-label="Modules">
        <RailLink
          href="/"
          label="Home"
          active={isPathActive(pathname, '/')}
          icon={House}
          onShowTooltip={showTooltip}
          onHideTooltip={() => setTooltip(null)}
        />

        <div className="quick-access-divider" aria-hidden="true" />

        {shortcuts.map(module => {
          const Icon = ICONS[module.id];
          if (!Icon) return null;
          return (
            <RailLink
              key={module.id}
              href={module.path}
              label={module.name}
              active={isPathActive(pathname, module.path)}
              icon={Icon}
              onShowTooltip={showTooltip}
              onHideTooltip={() => setTooltip(null)}
            />
          );
        })}

        {admin && (
          <div className="quick-access-admin">
            <div className="quick-access-divider" aria-hidden="true" />
            <RailLink
              href={admin.path}
              label={admin.name}
              active={isPathActive(pathname, admin.path)}
              icon={ICONS.admin}
              onShowTooltip={showTooltip}
              onHideTooltip={() => setTooltip(null)}
            />
          </div>
        )}
      </nav>
      {tooltip && (
        <span
          className="quick-access-tooltip"
          role="tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          {tooltip.label}
        </span>
      )}
    </aside>
  );
}
