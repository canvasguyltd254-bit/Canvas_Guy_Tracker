/**
 * app/api/suppliers/route.js
 *
 * GET  /api/suppliers  — list all suppliers (any authenticated user)
 * POST /api/suppliers  — create supplier (admin, production_manager, head_of_sales)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data: suppliers, error } = await serviceClient
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('GET /api/suppliers:', error);
      return NextResponse.json({ error: 'Failed to fetch suppliers' }, { status: 500 });
    }

    if (!suppliers?.length) return NextResponse.json({ success: true, data: [] });

    // Fetch purchase stats for all suppliers in one query
    const supplierIds = suppliers.map(s => s.id);
    const { data: purchases } = await serviceClient
      .from('purchases')
      .select('supplier_id, total_amount, amount_paid, payment_status, purchase_date')
      .in('supplier_id', supplierIds);

    // Group purchases by supplier
    const bySupplier = {};
    for (const p of purchases || []) {
      if (!bySupplier[p.supplier_id]) bySupplier[p.supplier_id] = [];
      bySupplier[p.supplier_id].push(p);
    }

    const thisMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"

    const enriched = suppliers.map(s => {
      const sp = bySupplier[s.id] || [];
      const totalPurchased  = sp.reduce((sum, p) => sum + parseFloat(p.total_amount || 0), 0);
      const totalPaid       = sp.reduce((sum, p) => sum + parseFloat(p.amount_paid  || 0), 0);
      const balanceOwed     = Math.max(0, parseFloat(s.opening_balance || 0) + totalPurchased - totalPaid);
      const unpaidCount     = sp.filter(p => p.payment_status !== 'Paid').length;
      const thisMonthSpend  = sp
        .filter(p => p.purchase_date && p.purchase_date.startsWith(thisMonth))
        .reduce((sum, p) => sum + parseFloat(p.total_amount || 0), 0);

      return {
        ...s,
        _stats: {
          purchase_count:   sp.length,
          total_purchased:  totalPurchased,
          total_paid:       totalPaid,
          balance_owed:     balanceOwed,
          unpaid_count:     unpaidCount,
          this_month_spend: thisMonthSpend,
        },
      };
    });

    return NextResponse.json({ success: true, data: enriched });
  } catch (err) {
    console.error('GET /api/suppliers:', err);
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
      return NextResponse.json({ error: 'Supplier name is required' }, { status: 400 });
    }

    const safe = {
      name:               body.name.trim(),
      contact_person:     body.contact_person?.trim() || null,
      phone:              body.phone?.trim() || null,
      email:              body.email?.trim() || null,
      materials_supplied: body.materials_supplied?.trim() || null,
      notes:              body.notes?.trim() || null,
      created_by:         user.id,
    };

    const { data, error } = await serviceClient
      .from('suppliers')
      .insert(safe)
      .select()
      .single();

    if (error) {
      console.error('POST /api/suppliers:', error);
      return NextResponse.json({ error: 'Failed to create supplier' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    console.error('POST /api/suppliers:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
