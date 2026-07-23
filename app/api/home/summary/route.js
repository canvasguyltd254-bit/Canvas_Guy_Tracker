/**
 * app/api/home/summary/route.js
 *
 * GET /api/home/summary
 *
 * Returns role-aware alert counts for every module the current user can access.
 * All permitted queries run in parallel via Promise.all.
 *
 * Response shape:
 *   {
 *     orders:     { active: number }           — non-terminal orders
 *     production: { in_production: number }    — Material Check → Ready for Delivery
 *     customers:  { overdue: number }          — orders past payment_due_date, delivered but unpaid
 *     suppliers:  { unmatched: number }        — chatpesa txns not fully matched
 *     contacts:   { total: number }
 *     accounting: { unposted: number }         — purchases + manual payments without journal entry
 *     admin:      { total_users: number }
 *   }
 *
 * Modules with no useful badge (dashboard, reports) are omitted.
 * Role-restricted modules return null when the caller doesn't have access,
 * but the middleware guarantees only authenticated users reach this endpoint.
 */

export const runtime = 'nodejs';

import { NextResponse }            from 'next/server';
import { getAuthContext, serviceClient } from '@/shared/lib/api-auth';

const PRODUCTION_STATUSES = ['Material Check', 'Production', 'Quality Control', 'Ready for Delivery', 'Partially Delivered'];
const DELIVERED_STATUSES  = ['Partially Delivered', 'Delivered'];

// Roles that can see each restricted module
const CAN_SEE_PRODUCTION  = ['admin', 'production_manager', 'head_of_sales', 'production_staff'];
const CAN_SEE_CUSTOMERS   = ['admin', 'production_manager', 'head_of_sales', 'sales'];
const CAN_SEE_SUPPLIERS   = ['admin', 'production_manager', 'head_of_sales'];
const CAN_SEE_ACCOUNTING  = ['admin', 'production_manager', 'head_of_sales'];
const CAN_SEE_ADMIN       = ['admin'];

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const today = new Date().toISOString().split('T')[0];

    // Build the set of queries to run in parallel based on role
    const queries = {};

    // Orders — everyone (exclude terminal statuses via chained neq — avoids string-escaping issues)
    queries.orders = serviceClient
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'Closed')
      .neq('status', 'Cancelled / Refunded')
      .then(({ count, error }) => {
        if (error) { console.error('home/summary orders:', error.message); return null; }
        return { active: count ?? 0 };
      });

    // Production — no sales/viewer
    if (CAN_SEE_PRODUCTION.includes(role)) {
      queries.production = serviceClient
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .in('status', PRODUCTION_STATUSES)
        .then(({ count, error }) => {
          if (error) { console.error('home/summary production:', error.message); return null; }
          return { in_production: count ?? 0 };
        });
    }

    // Customers — delivered orders past due date AND still carrying an outstanding balance.
    // We must fetch rows (not HEAD) to compute remaining = total_value − sum(payments).
    // This set is typically small: only delivered orders past their payment_due_date.
    if (CAN_SEE_CUSTOMERS.includes(role)) {
      queries.customers = serviceClient
        .from('orders')
        .select('id, total_value, order_payments(amount)')
        .in('status', DELIVERED_STATUSES)
        .not('payment_due_date', 'is', null)
        .lt('payment_due_date', today)
        .then(({ data, error }) => {
          if (error) { console.error('home/summary customers:', error.message); return null; }
          const overdue = (data || []).filter(order => {
            const paid = (order.order_payments || [])
              .reduce((s, p) => s + parseFloat(p.amount || 0), 0);
            return paid < parseFloat(order.total_value || 0) - 0.01;
          }).length;
          return { overdue };
        });
    }

    // Suppliers — unmatched / partial chatpesa transactions
    if (CAN_SEE_SUPPLIERS.includes(role)) {
      queries.suppliers = serviceClient
        .from('chatpesa_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('tx_type', 'debit')
        .in('match_status', ['unmatched', 'partial'])
        .then(({ count, error }) => {
          if (error) { console.error('home/summary suppliers:', error.message); return null; }
          return { unmatched: count ?? 0 };
        });
    }

    // Contacts — unified directory total: contacts + customers + suppliers
    if (CAN_SEE_CUSTOMERS.includes(role)) {   // same gate as customers
      queries.contacts = Promise.all([
        serviceClient.from('contacts').select('id', { count: 'exact', head: true }),
        serviceClient.from('customers').select('id', { count: 'exact', head: true }),
        serviceClient.from('suppliers').select('id', { count: 'exact', head: true }),
      ]).then(([contactsRes, customersRes, suppliersRes]) => {
        if (contactsRes.error)  console.error('home/summary contacts contacts:',  contactsRes.error.message);
        if (customersRes.error) console.error('home/summary contacts customers:', customersRes.error.message);
        if (suppliersRes.error) console.error('home/summary contacts suppliers:', suppliersRes.error.message);
        return {
          total: (contactsRes.count ?? 0) + (customersRes.count ?? 0) + (suppliersRes.count ?? 0),
        };
      });
    }

    // Accounting — unposted records across all 4 sources:
    //   1. supplier_purchases             (journal_entry_id IS NULL)
    //   2. manual_supplier_payments       (journal_entry_id IS NULL)
    //   3. chatpesa_payment_allocations   (journal_entry_id IS NULL)
    //   4. suppliers with opening_balance (opening_balance_journal_entry_id IS NULL)
    // Kept as a single chained Promise so it joins the outer Promise.all
    // and all queries (incl. admin below) start in true parallel.
    if (CAN_SEE_ACCOUNTING.includes(role)) {
      queries.accounting = Promise.all([
        serviceClient
          .from('supplier_purchases')
          .select('id', { count: 'exact', head: true })
          .is('journal_entry_id', null),
        serviceClient
          .from('manual_supplier_payments')
          .select('id', { count: 'exact', head: true })
          .is('journal_entry_id', null),
        serviceClient
          .from('chatpesa_payment_allocations')
          .select('id', { count: 'exact', head: true })
          .is('journal_entry_id', null),
        serviceClient
          .from('suppliers')
          .select('id', { count: 'exact', head: true })
          .is('opening_balance_journal_entry_id', null)
          .gt('opening_balance', 0),
      ]).then(([purchasesRes, manualsRes, chatpesaRes, obRes]) => {
        if (purchasesRes.error) console.error('home/summary accounting purchases:', purchasesRes.error.message);
        if (manualsRes.error)   console.error('home/summary accounting manuals:',   manualsRes.error.message);
        if (chatpesaRes.error)  console.error('home/summary accounting chatpesa:',  chatpesaRes.error.message);
        if (obRes.error)        console.error('home/summary accounting ob:',         obRes.error.message);
        return {
          unposted: (purchasesRes.count ?? 0) + (manualsRes.count  ?? 0) +
                    (chatpesaRes.count  ?? 0) + (obRes.count        ?? 0),
        };
      });
    }

    // Admin — total users
    if (CAN_SEE_ADMIN.includes(role)) {
      queries.admin = serviceClient
        .from('user_profiles')
        .select('id', { count: 'exact', head: true })
        .then(({ count, error }) => {
          if (error) { console.error('home/summary admin:', error.message); return null; }
          return { total_users: count ?? 0 };
        });
    }

    // Run all pending queries in parallel
    const keys   = Object.keys(queries);
    const values = await Promise.all(Object.values(queries));
    const result = {};
    keys.forEach((k, i) => { result[k] = values[i]; });

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/home/summary:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
