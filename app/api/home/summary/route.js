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
 *     production: {
 *       in_production: number,       — orders currently in PRODUCTION_STATUSES (order-level, unchanged)
 *       jobsBlocked: number,         — production_jobs blocked: status 'Awaiting Materials',
 *                                      or 'Paused' with a blocker_reason recorded (job-level, new)
 *       unitsInProduction: number,   — sum(production_jobs.in_production_qty) over non-terminal jobs (new)
 *       unitsAwaitingQc: number,     — sum(production_jobs.awaiting_qc_qty) over non-terminal jobs (new)
 *     }
 *     customers:  {
 *       overdue: number,             — orders past payment_due_date, delivered but unpaid (unchanged)
 *       overdueAmount: number,       — sum of remaining balance across those overdue orders (new)
 *       dueThisWeek: number,         — delivered, unpaid orders due within the next 7 days, not yet overdue (new)
 *     }
 *     suppliers:  { unmatched: number }        — chatpesa txns not fully matched
 *     contacts:   { total: number }
 *     accounting: { unposted: number }         — purchases + manual payments without journal entry
 *     admin:      { total_users: number }
 *     cashflow:   { connected: true, thisWeekPlanned: number, shortfallWeeks: number,
 *                   openingCash: number, isProvisional: boolean }
 *                 | { connected: false, reason: string }
 *               — connected:false only when the caller lacks CAN_SEE_CASHFLOW
 *                 or the forecast engine itself throws (e.g. cashflow_settings
 *                 missing). Never a fabricated 0 in place of a real failure.
 *   }
 *
 * Modules with no useful badge (dashboard, reports) are omitted.
 * Role-restricted modules return null when the caller doesn't have access,
 * but the middleware guarantees only authenticated users reach this endpoint.
 */

export const runtime = 'nodejs';

import { NextResponse }            from 'next/server';
import { getAuthContext, serviceClient } from '@/shared/lib/api-auth';
import {
  PRODUCTION_STATUSES, DELIVERED_STATUSES,
  CAN_SEE_PRODUCTION, CAN_SEE_CUSTOMERS, CAN_SEE_SUPPLIERS, CAN_SEE_ACCOUNTING, CAN_SEE_ADMIN,
  CAN_SEE_CASHFLOW,
} from '@/shared/lib/homeAccess';
import { buildCashflowSnapshot } from '@/shared/lib/cashflow/buildSnapshot';
import { projectCashflow } from '@/shared/lib/cashflow/projectCashflow';

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

    // Production — order-level count unchanged; job-level fields are new and
    // read from production_jobs directly (a different status vocabulary from
    // orders.status — the two are never conflated).
    if (CAN_SEE_PRODUCTION.includes(role)) {
      queries.production = Promise.all([
        serviceClient
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .in('status', PRODUCTION_STATUSES),
        serviceClient
          .from('production_jobs')
          .select('status, in_production_qty, awaiting_qc_qty, blocker_reason')
          .not('status', 'in', '(Completed,Cancelled)'),
      ]).then(([orderCountRes, jobsRes]) => {
        if (orderCountRes.error) console.error('home/summary production orders:', orderCountRes.error.message);
        if (jobsRes.error)       console.error('home/summary production jobs:',   jobsRes.error.message);
        const jobs = jobsRes.data || [];
        const jobsBlocked = jobs.filter(j =>
          j.status === 'Awaiting Materials' ||
          (j.status === 'Paused' && !!j.blocker_reason)
        ).length;
        const unitsInProduction = jobs.reduce((s, j) => s + (j.in_production_qty || 0), 0);
        const unitsAwaitingQc   = jobs.reduce((s, j) => s + (j.awaiting_qc_qty   || 0), 0);
        return {
          in_production: orderCountRes.count ?? 0,
          jobsBlocked,
          unitsInProduction,
          unitsAwaitingQc,
        };
      });
    }

    // Customers — delivered orders with a payment_due_date, still carrying an
    // outstanding balance. Fetches both overdue AND due-this-week in one pass
    // (a superset query filtered client-side) so "overdue" stays numerically
    // identical to before while adding the two new fields.
    if (CAN_SEE_CUSTOMERS.includes(role)) {
      const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      queries.customers = serviceClient
        .from('orders')
        .select('id, total_value, payment_due_date, order_payments(amount, reversed_at)')
        .in('status', DELIVERED_STATUSES)
        .not('payment_due_date', 'is', null)
        .lt('payment_due_date', weekFromNow)
        .then(({ data, error }) => {
          if (error) { console.error('home/summary customers:', error.message); return null; }
          let overdue = 0, overdueAmount = 0, dueThisWeek = 0;
          for (const order of (data || [])) {
            // Reversed payments no longer count as paid — the reversal journal
            // already backs the receipt out in the GL.
            const paid = (order.order_payments || [])
              .filter(p => !p.reversed_at)
              .reduce((s, p) => s + parseFloat(p.amount || 0), 0);
            const remaining = parseFloat(order.total_value || 0) - paid;
            if (remaining <= 0.01) continue; // fully paid — not a collection concern
            if (order.payment_due_date < today) {
              overdue += 1;
              overdueAmount += remaining;
            } else {
              dueThisWeek += 1;
            }
          }
          return { overdue, overdueAmount, dueThisWeek };
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

    // Cashflow — real Stage 2 forecast, built and projected fresh on every
    // request (buildCashflowSnapshot does the Supabase reads; projectCashflow
    // is pure). Narrower role gate than accounting — see CAN_SEE_CASHFLOW.
    if (CAN_SEE_CASHFLOW.includes(role)) {
      queries.cashflow = buildCashflowSnapshot(serviceClient)
        .then((snapshot) => projectCashflow(snapshot))
        .then((projection) => ({
          connected: true,
          thisWeekPlanned: projection.weeks[0]?.money_out?.total_planned ?? 0,
          shortfallWeeks: projection.counts.shortfall_weeks,
          openingCash: projection.opening_cash,
          isProvisional: projection.ledger_health.is_provisional,
          provisionalReasons: projection.warnings
            .filter((warning) => ['provisional_opening_cash', 'unresolved_posting_errors', 'sha_remittance_status_untracked'].includes(warning.code))
            .map((warning) => warning.code),
        }))
        .catch((err) => {
          console.error('home/summary cashflow:', err.message);
          return { connected: false, reason: 'Cashflow forecast could not be computed — see server logs.' };
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

    // Caller has no cashflow visibility at all (role not in CAN_SEE_CASHFLOW)
    // — honestly "not connected", never a fabricated number.
    if (!result.cashflow) {
      result.cashflow = {
        connected: false,
        reason: 'Cashflow is only visible to admin and head of sales in this phase.',
      };
    }

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/home/summary:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
