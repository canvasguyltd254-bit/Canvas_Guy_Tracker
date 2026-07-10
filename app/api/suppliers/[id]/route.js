/**
 * app/api/suppliers/[id]/route.js
 *
 * GET    /api/suppliers/:id  — fetch single supplier + their purchases
 * PATCH  /api/suppliers/:id  — update supplier fields
 * DELETE /api/suppliers/:id  — delete supplier (admin only)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data: supplier, error } = await serviceClient
      .from('suppliers')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !supplier) {
      return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });
    }

    // Also fetch their purchases
    const { data: purchases } = await serviceClient
      .from('supplier_purchases')
      .select('*, orders(order_num, client)')
      .eq('supplier_id', params.id)
      .order('purchase_date', { ascending: false });

    return NextResponse.json({ success: true, data: { ...supplier, purchases: purchases || [] } });
  } catch (err) {
    console.error('GET /api/suppliers/[id]:', err);
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

    const safe = {};
    if (body.name !== undefined)               safe.name               = body.name.trim();
    if (body.contact_person !== undefined)     safe.contact_person     = body.contact_person?.trim() || null;
    if (body.phone !== undefined)              safe.phone              = body.phone?.trim() || null;
    if (body.email !== undefined)              safe.email              = body.email?.trim() || null;
    if (body.materials_supplied !== undefined) safe.materials_supplied = body.materials_supplied?.trim() || null;
    if (body.notes !== undefined)              safe.notes              = body.notes?.trim() || null;

    if (Object.keys(safe).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await serviceClient
      .from('suppliers')
      .update(safe)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      console.error('PATCH /api/suppliers/[id]:', error);
      return NextResponse.json({ error: 'Failed to update supplier' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('PATCH /api/suppliers/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    // Check if supplier has purchases — prevent orphan delete
    const { count } = await serviceClient
      .from('supplier_purchases')
      .select('id', { count: 'exact', head: true })
      .eq('supplier_id', params.id);

    if (count > 0) {
      return NextResponse.json(
        { error: `Cannot delete: supplier has ${count} purchase record(s). Delete purchases first.` },
        { status: 409 }
      );
    }

    const { error } = await serviceClient
      .from('suppliers')
      .delete()
      .eq('id', params.id);

    if (error) {
      console.error('DELETE /api/suppliers/[id]:', error);
      return NextResponse.json({ error: 'Failed to delete supplier' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Supplier deleted' });
  } catch (err) {
    console.error('DELETE /api/suppliers/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
