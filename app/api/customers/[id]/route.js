/**
 * app/api/customers/[id]/route.js
 *
 * GET    /api/customers/:id  — full profile with computed stats
 * PATCH  /api/customers/:id  — update customer
 * DELETE /api/customers/:id  — delete (blocked if customer has orders)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales', 'sales'];
const VALID_TERMS = ['COD', '7 Days', '30 Days', '60 Days'];
const ACTIVE_STATUSES    = ['Inquiry','Quoted','Quote Approved','Deposit Paid','In Production','Quality Check','Ready for Delivery','Out for Delivery'];
const QUOTE_STATUSES     = ['Inquiry','Quoted','Quote Approved'];
const DELIVERED_STATUSES = ['Partially Delivered', 'Delivered', 'Closed'];

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data: customer, error } = await serviceClient
      .from('customers')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !customer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    }

    const today = new Date().toISOString().split('T')[0];

    // Fetch orders + payments for this customer
    const [{ data: orders }, { data: activities }] = await Promise.all([
      serviceClient
        .from('orders')
        .select(`
          id, order_num, client, status, total_value, payment_due_date,
          created_at, due_date, author, contact_person,
          order_payments(id, amount, payment_date, description)
        `)
        .eq('customer_id', params.id)
        .order('created_at', { ascending: false }),
      serviceClient
        .from('order_activities')
        .select('id, order_id, activity_type, description, created_at, orders!inner(customer_id, order_num)')
        .eq('orders.customer_id', params.id)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);

    const allOrders = orders || [];

    // Compute stats
    const nonCancelled = allOrders.filter(o => !['Cancelled','Cancelled/Refunded','Refunded'].includes(o.status));
    const totalSales   = nonCancelled.reduce((s, o) => s + parseFloat(o.total_value || 0), 0);
    const totalPaid    = nonCancelled.reduce((s, o) => {
      return s + (o.order_payments || []).reduce((ps, p) => ps + parseFloat(p.amount || 0), 0);
    }, 0);
    const outstanding  = parseFloat(customer.opening_balance || 0) + totalSales - totalPaid;
    const overdue      = nonCancelled
      .filter(o => o.payment_due_date && o.payment_due_date < today && DELIVERED_STATUSES.includes(o.status))
      .reduce((s, o) => {
        const paid = (o.order_payments || []).reduce((ps, p) => ps + parseFloat(p.amount || 0), 0);
        return s + Math.max(0, parseFloat(o.total_value || 0) - paid);
      }, 0);
    const activeOrders  = nonCancelled.filter(o => ACTIVE_STATUSES.includes(o.status)).length;
    const activeQuotes  = nonCancelled.filter(o => QUOTE_STATUSES.includes(o.status)).length;
    const lastOrderDate = allOrders[0]?.created_at?.split('T')[0] || null;
    const firstOrder    = [...allOrders].sort((a, b) => a.created_at > b.created_at ? 1 : -1)[0];
    const customerSince = firstOrder?.created_at?.split('T')[0] || customer.created_at?.split('T')[0];
    const creditAvail   = Math.max(0, parseFloat(customer.credit_limit || 0) - outstanding);

    // Build statement entries (chronological ledger)
    const statementEntries = [];

    if (parseFloat(customer.opening_balance || 0) !== 0) {
      statementEntries.push({
        date:        customer.opening_balance_date || customer.created_at?.split('T')[0],
        type:        'Opening Balance',
        description: 'Opening balance',
        debit:       0,
        credit:      parseFloat(customer.opening_balance) > 0 ? parseFloat(customer.opening_balance) : 0,
        amount:      parseFloat(customer.opening_balance),
        reference:   null,
        order_num:   null,
      });
    }

    for (const o of [...nonCancelled].sort((a, b) => a.created_at > b.created_at ? 1 : -1)) {
      // Invoice entry (order total)
      statementEntries.push({
        date:        o.created_at.split('T')[0],
        type:        'Invoice',
        description: `Order ${o.order_num}`,
        debit:       parseFloat(o.total_value || 0),
        credit:      0,
        amount:      parseFloat(o.total_value || 0),
        reference:   o.order_num,
        order_id:    o.id,
        order_num:   o.order_num,
      });
      // Payment entries
      for (const p of [...(o.order_payments || [])].sort((a, b) => a.payment_date > b.payment_date ? 1 : -1)) {
        statementEntries.push({
          date:        p.payment_date,
          type:        'Payment',
          description: p.description || `Payment for ${o.order_num}`,
          debit:       0,
          credit:      parseFloat(p.amount || 0),
          amount:      parseFloat(p.amount || 0),
          reference:   o.order_num,
          order_id:    o.id,
          order_num:   o.order_num,
        });
      }
    }

    // Sort statement chronologically and add running balance
    statementEntries.sort((a, b) => (a.date || '') > (b.date || '') ? 1 : -1);
    let runningBalance = 0;
    for (const entry of statementEntries) {
      runningBalance += entry.debit - entry.credit;
      entry.balance = runningBalance;
    }

    // Build timeline (merge order activities + payment events)
    const timeline = [];
    timeline.push({
      date:        customer.created_at,
      type:        'customer_created',
      description: 'Customer created',
      order_num:   null,
    });
    for (const o of [...allOrders].sort((a, b) => a.created_at > b.created_at ? 1 : -1)) {
      timeline.push({ date: o.created_at, type: 'order_created', description: `Order ${o.order_num} created`, order_num: o.order_num, order_id: o.id });
      for (const p of o.order_payments || []) {
        timeline.push({ date: p.payment_date + 'T00:00:00', type: 'payment', description: `Payment of KSh ${Number(p.amount).toLocaleString()} received`, order_num: o.order_num, order_id: o.id });
      }
    }
    for (const a of activities || []) {
      timeline.push({ date: a.created_at, type: a.activity_type, description: a.description, order_num: a.orders?.order_num, order_id: a.order_id });
    }
    timeline.sort((a, b) => b.date > a.date ? 1 : -1);

    return NextResponse.json({
      success: true,
      data: {
        ...customer,
        _stats: {
          total_orders:    allOrders.length,
          total_sales:     totalSales,
          total_paid:      totalPaid,
          outstanding,
          overdue,
          active_orders:   activeOrders,
          active_quotes:   activeQuotes,
          last_order_date: lastOrderDate,
          customer_since:  customerSince,
          credit_available: creditAvail,
        },
        orders:    allOrders,
        statement: statementEntries,
        timeline:  timeline.slice(0, 200),
      },
    });
  } catch (err) {
    console.error('GET /api/customers/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (body.credit_terms && !VALID_TERMS.includes(body.credit_terms)) {
      return NextResponse.json({ error: `credit_terms must be one of: ${VALID_TERMS.join(', ')}` }, { status: 400 });
    }

    const allowed = ['name','contact_person','phone','email','address','kra_pin','credit_limit','credit_terms','opening_balance','opening_balance_date','notes'];
    const update = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, key)) update[key] = body[key];
    }
    if (!Object.keys(update).length) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }
    if (update.name !== undefined && !update.name?.trim()) {
      return NextResponse.json({ error: 'Customer name cannot be empty' }, { status: 400 });
    }

    const { data, error } = await serviceClient
      .from('customers')
      .update(update)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      console.error('PATCH /api/customers/[id]:', error);
      return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('PATCH /api/customers/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    // Block delete if customer has orders
    const { count } = await serviceClient
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', params.id);

    if (count > 0) {
      return NextResponse.json({
        error: `Cannot delete customer — they have ${count} order(s) on record.`,
      }, { status: 409 });
    }

    const { error } = await serviceClient.from('customers').delete().eq('id', params.id);
    if (error) return NextResponse.json({ error: 'Failed to delete customer' }, { status: 500 });

    return NextResponse.json({ success: true, message: 'Customer deleted' });
  } catch (err) {
    console.error('DELETE /api/customers/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
