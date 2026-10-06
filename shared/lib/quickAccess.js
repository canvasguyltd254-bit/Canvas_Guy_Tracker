/**
 * Pure quick-access navigation helpers.
 *
 * Module metadata, routes and permissions remain owned by modules/registry.js.
 * This file only supplies presentation order and path matching so the client
 * component can stay small and the rules can be tested without React.
 */

export const QUICK_ACCESS_ORDER = [
  'orders',
  'crm',
  'production',
  'suppliers',
  'customers',
  'payroll',
  'cashflow',
  'accounting',
  'reports',
  'contacts',
];

export function isPathActive(pathname, modulePath) {
  if (!pathname || !modulePath) return false;
  if (modulePath === '/') return pathname === '/';
  return pathname === modulePath || pathname.startsWith(`${modulePath}/`);
}

export function getQuickAccessModules(moduleList, userRole) {
  if (!Array.isArray(moduleList) || !userRole) return [];

  const byId = new Map(moduleList.map(module => [module.id, module]));

  return QUICK_ACCESS_ORDER
    .map(id => byId.get(id))
    .filter(Boolean)
    .filter(module => module.allowedRoles?.includes(userRole))
    .filter(module => module.navItems?.[0]?.path)
    .map(module => ({
      ...module,
      path: module.navItems[0].path,
    }));
}

export function getAdminQuickAccess(moduleList, userRole) {
  if (!Array.isArray(moduleList) || !userRole) return null;
  const admin = moduleList.find(module => module.id === 'admin');
  if (!admin?.allowedRoles?.includes(userRole) || !admin.navItems?.[0]?.path) return null;
  return { ...admin, path: admin.navItems[0].path };
}
