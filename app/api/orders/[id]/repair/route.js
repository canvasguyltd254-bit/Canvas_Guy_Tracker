/**
 * app/api/orders/[id]/repair/route.js
 *
 * POST /api/orders/:id/repair — create a linked repair or return order
 *
 * Body: {
 *   repair_type:   'repair' | 'return'
 *   repair_reason: string  (from REPAIR_REASONS enum, for audit)
 *   repair_desc:   string  (required — description of the issue)
 *   repair_cost:   number  (optional estimated cost)
 * }
 *
 * Security:
 *   - auth required: admin, production_manager only (ROLES_CAN_REPAIR)
 *   - parent order fields (client, contact_person, author, customer_type) are
 *     read from the DB — never trusted from the client body
 *   - new order status is always hardcoded to 'Reported'
 *   - payment_terms is always hardcoded to 'cash_before'
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

const ROLES_CAN_REPAIR = ['admin', 'production_manager'];
const VALID_REPAIR_TYPES = ['repair', 'return'];

export async function POST(request, { params }) {
  try {
    const parentOrderId = params.id;

    // 1. Auth — repair/return is privileged; admin + production_manager only
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ROLES_CAN_REPAIR);
    if (authError) return authError;

    // 2. Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { repair_type, repair_reason, repair_desc, repair_cost } = body;

    // 3. Validate inputs
    if (!VALID_REPAIR_TYPES.includes(repair_type)) {
      return NextResponse.json(
        { error: 'repair_type must be "repair" or "return"' },
        { status: 400 },
      );
    }
    if (!repair_desc || !String(repair_desc).trim()) {
      return NextResponse.json(
        { error: 'repair_desc is required' },
        { status: 400 },
      );
    }

    const desc = String(repair_desc).trim();
    const reason = repair_reason ? String(repair_reason).trim() : '';
    const cost = parseFloat(repair_cost) || 0;

    // 4. Fetch parent order — read privileged fields server-side
    const { data: parentOrder, error: fetchErr } = await serviceClient
      .from('orders')
      .select('id, client, contact_person, author, customer_type, order_num')
      .eq('id', parentOrderId)
      .single();

    if (fetchErr || !parentOrder) {
      return NextResponse.json({ error: 'Parent order not found' }, { status: 404 });
    }

    // 5. Build new order — server-side fields injected; pick() strips extras
    const label = repair_type === 'repair' ? 'Repair' : 'Return';
    const rawInsert = {
      // Fields copied from parent (from DB, not from body)
      client:         parentOrder.client,
      contact_person: parentOrder.contact_person,
      author:         parentOrder.author,
      customer_type:  parentOrder.customer_type,
      // Fields hardcoded server-side
      payment_terms:  'cash_before',
      status:         'Reported',
      // Fields from validated body
      order_type:      repair_type,
      parent_order_id: parentOrderId,
      notes:           reason ? `${reason} — ${desc}` : desc,
      total_value:     cost,
      items:           `${label}: ${desc}`,
    };

    const safeInsert = pick(rawInsert, ALLOWED_FIELDS.orders.insert);

    const { data: newOrder, error: insertErr } = await serviceClient
      .from('orders')
      .insert(safeInsert)
      .select('id, order_num')
      .single();

    if (insertErr || !newOrder) {
      console.error('POST /api/orders/[id]/repair — insert:', insertErr);
      return NextResponse.json({ error: 'Failed to create repair order' }, { status: 500 });
    }

    // 6. Log activity on the parent order (best-effort — don't fail the request if this errors)
    const activityInsert = pick(
      {
        order_id:      parentOrderId,
        activity_type: 'repair',
        description:   `${label} order ${newOrder.order_num} created. ${reason ? `${reason}: ` : ''}${desc}`,
      },
      ALLOWED_FIELDS.order_activities.insert,
    );

    await serviceClient.from('order_activities').insert(activityInsert).then(
      null,
      (err) => console.error('POST /api/orders/[id]/repair — activity log:', err),
    );

    return NextResponse.json({
      success:  true,
      order_id: newOrder.id,
      order_num: newOrder.order_num,
    }, { status: 201 });

  } catch (err) {
    console.error('POST /api/orders/[id]/repair:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
