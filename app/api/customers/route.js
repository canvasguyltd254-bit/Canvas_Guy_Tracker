/**
 * app/api/customers/route.js
 *
 * GET  /api/customers  — list all customers with basic stats
 * POST /api/customers  — create a new customer
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { calcCustomerStats } from '@/shared/lib/customerBalance';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales', 'sales'];

// Credit terms → days offset
const TERMS_DAYS = { 'COD': 0, '7 Days': 7, '30 Days': 30, '60 Days': 60 };

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || '';

    let query = serviceClient
      .from('customers')
      .select('*')
      .order('name', { ascending: true });

    if (search) {
      query = query.or(`name.ilike.%${search}%,contact_person.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data: customers, error } = await query;
    if (error) {
      console.error('GET /api/customers:', error);
      return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 });
    }

    if (!customers?.length) return NextResponse.json({ success: true, data: [] });

    // Fetch lightweight order stats for all customers in one query.
    // `id` must be included — it is the key used to map payments per order.
    const customerIds = customers.map(c => c.id);

    const [{ data: orders }, { data: payments }] = await Promise.all([
      serviceClient
        .from('orders')
        .select('id, customer_id, total_value, status, payment_due_date, created_at')
        .in('customer_id', customerIds)
        .not('status', 'eq', 'Cancelled / Refunded'),
      serviceClient
        .from('order_payments')
        .select('order_id, amount, orders!inner(customer_id)')
        .in('orders.customer_id', customerIds),
    ]);

    const today = new Date().toISOString().split('T')[0];

    // Build per-customer order index
    const ordersByCustomer = {};
    for (const o of orders || []) {
      if (!ordersByCustomer[o.customer_id]) ordersByCustomer[o.customer_id] = [];
      ordersByCustomer[o.customer_id].push(o);
    }

    // Build payment totals keyed by order_id
    const paymentsByOrder = {};
    for (const p of payments || []) {
      if (!paymentsByOrder[p.order_id]) paymentsByOrder[p.order_id] = 0;
      paymentsByOrder[p.order_id] += parseFloat(p.amount || 0);
    }

    // NOTE: the orders query already excludes 'Cancelled / Refunded', so
    // every order in cOrders is non-cancelled — pass directly to calcCustomerStats.
    const enriched = customers.map(c => {
      const cOrders = ordersByCustomer[c.id] || [];
      const { totalSales, totalPaid, outstanding, overdue, activeWorkValue, activeOrders } =
        calcCustomerStats(c, cOrders, paymentsByOrder, today);
      const lastOrder = [...cOrders].sort((a, b) => b.created_at > a.created_at ? 1 : -1)[0];

      return {
        ...c,
        _stats: {
          total_orders:      cOrders.length,
          total_sales:       totalSales,
          total_paid:        totalPaid,
          outstanding,
          overdue,
          active_orders:     activeOrders,
          active_work_value: activeWorkValue,
          last_order_date:   lastOrder?.created_at?.split('T')[0] || null,
        },
      };
    });

    return NextResponse.json({ success: true, data: enriched });
  } catch (err) {
    console.error('GET /api/customers:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'Customer name is required' }, { status: 400 });
    }

    const VALID_TERMS = ['COD', '7 Days', '30 Days', '60 Days'];
    if (body.credit_terms && !VALID_TERMS.includes(body.credit_terms)) {
      return NextResponse.json({ error: `credit_terms must be one of: ${VALID_TERMS.join(', ')}` }, { status: 400 });
    }

    const safe = {
      name:                 body.name.trim(),
      contact_person:       body.contact_person?.trim()  || null,
      phone:                body.phone?.trim()            || null,
      email:                body.email?.trim()            || null,
      address:              body.address?.trim()          || null,
      kra_pin:              body.kra_pin?.trim()          || null,
      credit_limit:         parseFloat(body.credit_limit) || 0,
      credit_terms:         body.credit_terms             || 'COD',
      opening_balance:      parseFloat(body.opening_balance) || 0,
      opening_balance_date: body.opening_balance_date     || null,
      notes:                body.notes?.trim()            || null,
      created_by:           user.id,
    };

    const { data, error } = await serviceClient
      .from('customers')
      .insert(safe)
      .select()
      .single();

    if (error) {
      console.error('POST /api/customers:', error);
      return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    console.error('POST /api/customers:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
