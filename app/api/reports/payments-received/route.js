/**
 * app/api/reports/payments-received/route.js
 *
 * GET /api/reports/payments-received?from=YYYY-MM-DD&to=YYYY-MM-DD
 *       [&basis=received|banked][&customerId=<uuid>][&method=<text>]
 *
 * What customers paid between two dates. Read-only. Filtering happens in the
 * database (paged past the 1,000-row cap); classification and totals come from
 * shared/lib/reports/paymentsReceived.js, which is unit-tested.
 *
 * Roles: admin, head_of_sales (this exposes revenue and customer payments).
 *
 * Works before cashflow_r2_r5_support.sql is applied: without the
 * payment_method / banked_date columns the report still runs, with methods
 * shown as "Unspecified" and `columnsMissing: true` so the UI can say why the
 * banked basis is unavailable.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { fetchAllRows } from '@/shared/lib/reports/fetchAll';
import { buildPaymentsReport, BASES } from '@/shared/lib/reports/paymentsReceived';
import { validateQueryRange } from '@/shared/lib/reports/dateBounds';

const ROLES = ['admin', 'head_of_sales'];
const ORDER_FIELDS = 'client, customer_id, order_num, status, suspended_at, invoice_number';
const FULL = `id, order_id, amount, description, payment_date, payment_method, banked_date, reversed_at, orders(${ORDER_FIELDS})`;
const BASIC = `id, order_id, amount, description, payment_date, reversed_at, orders(${ORDER_FIELDS})`;

const UNDEFINED_COLUMN = '42703';

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ROLES);
    if (authError) return authError;

    const sp = new URL(request.url).searchParams;
    const from = sp.get('from') || null;
    const to = sp.get('to') || null;
    const basis = sp.get('basis') || 'received';
    const customerId = sp.get('customerId') || null;
    const method = sp.get('method') || null;

    if (!BASES.includes(basis)) return NextResponse.json({ error: 'Invalid basis.' }, { status: 400 });
    if (!from || !to) return NextResponse.json({ error: 'Both "from" and "to" are required.' }, { status: 400 });
    const rangeError = validateQueryRange({ from, to });
    if (rangeError) return NextResponse.json({ error: rangeError }, { status: 400 });

    const dateColumn = basis === 'banked' ? 'banked_date' : 'payment_date';

    const load = select => fetchAllRows(
      (a, b) => serviceClient
        .from('order_payments')
        .select(select)
        .gte(dateColumn, from)
        .lte(dateColumn, to)
        .order(dateColumn, { ascending: true })
        .order('id', { ascending: true })
        .range(a, b),
      { label: 'payments' },
    );

    let payments;
    let columnsMissing = false;
    try {
      payments = await load(FULL);
    } catch (e) {
      // Only the "column does not exist" case falls back; any other failure surfaces.
      if (!String(e.message).includes(UNDEFINED_COLUMN) && !/payment_method|banked_date/.test(e.message)) throw e;
      if (basis === 'banked') {
        return NextResponse.json(
          { error: 'Banked-date reporting needs the cashflow_r2_r5_support migration to be applied.' },
          { status: 409 },
        );
      }
      columnsMissing = true;
      payments = await load(BASIC);
    }

    const report = buildPaymentsReport(payments, { from, to, basis, customerId, method });
    return NextResponse.json({ success: true, data: { ...report, columnsMissing } });
  } catch (err) {
    console.error('GET /api/reports/payments-received:', err);
    return NextResponse.json({ error: 'Failed to build the payments report.' }, { status: 500 });
  }
}
