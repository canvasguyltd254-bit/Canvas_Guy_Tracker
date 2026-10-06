import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAdminQuickAccess,
  getQuickAccessModules,
  isPathActive,
} from '../quickAccess.js';

const roles = {
  broad: ['admin', 'production_manager', 'head_of_sales', 'sales', 'production_staff', 'viewer'],
  sales: ['admin', 'head_of_sales', 'sales'],
};

const modules = [
  { id: 'dashboard', allowedRoles: roles.broad, navItems: [{ path: '/dashboard' }] },
  { id: 'orders', allowedRoles: roles.broad, navItems: [{ path: '/orders' }] },
  { id: 'crm', allowedRoles: roles.sales, navItems: [{ path: '/crm' }] },
  { id: 'production', allowedRoles: ['admin', 'production_manager', 'production_staff'], navItems: [{ path: '/production' }] },
  { id: 'suppliers', allowedRoles: ['admin', 'production_manager', 'head_of_sales'], navItems: [{ path: '/suppliers' }] },
  { id: 'customers', allowedRoles: roles.sales, navItems: [{ path: '/customers' }] },
  { id: 'payroll', allowedRoles: ['admin', 'production_manager', 'head_of_sales'], navItems: [{ path: '/payroll' }] },
  { id: 'accounting', allowedRoles: ['admin', 'production_manager', 'head_of_sales'], navItems: [{ path: '/accounting' }] },
  { id: 'reports', allowedRoles: ['admin', 'production_manager', 'head_of_sales'], navItems: [{ path: '/reports' }] },
  { id: 'contacts', allowedRoles: roles.sales, navItems: [{ path: '/contacts' }] },
  { id: 'admin', allowedRoles: ['admin'], navItems: [{ path: '/admin' }] },
  { id: 'unconfigured', navItems: [{ path: '/unsafe' }] },
  { id: 'cashflow', allowedRoles: ['admin', 'head_of_sales'], navItems: [{ path: '/cashflow' }] },
];

test('quick access permissions and ordering', async t => {
  await t.test('admin gets all ordered shortcuts and separate Admin shortcut', () => {
    assert.deepEqual(getQuickAccessModules(modules, 'admin').map(m => m.id), [
      'orders', 'crm', 'production', 'suppliers', 'customers', 'payroll',
      'cashflow', 'accounting', 'reports', 'contacts',
    ]);
    assert.equal(getAdminQuickAccess(modules, 'admin')?.id, 'admin');
  });

  await t.test('sales cannot see protected production or finance shortcuts', () => {
    assert.deepEqual(getQuickAccessModules(modules, 'sales').map(m => m.id), [
      'orders', 'crm', 'customers', 'contacts',
    ]);
    assert.equal(getAdminQuickAccess(modules, 'sales'), null);
  });

  await t.test('production staff sees Orders and Production only', () => {
    assert.deepEqual(getQuickAccessModules(modules, 'production_staff').map(m => m.id), [
      'orders', 'production',
    ]);
  });

  await t.test('unconfigured modules and legacy Dashboard are absent while registered Cashflow is present', () => {
    const ids = getQuickAccessModules(modules, 'admin').map(m => m.id);
    assert.equal(ids.includes('unconfigured'), false);
    assert.equal(ids.includes('dashboard'), false);
    assert.equal(ids.includes('cashflow'), true);
  });
});

test('active path matching is segment-aware', () => {
  assert.equal(isPathActive('/', '/'), true);
  assert.equal(isPathActive('/orders', '/'), false);
  assert.equal(isPathActive('/orders', '/orders'), true);
  assert.equal(isPathActive('/orders/abc', '/orders'), true);
  assert.equal(isPathActive('/orders-new', '/orders'), false);
  assert.equal(isPathActive('/order', '/orders'), false);
});
