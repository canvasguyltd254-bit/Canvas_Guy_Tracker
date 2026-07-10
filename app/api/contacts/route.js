/**
 * app/api/contacts/route.js
 *
 * GET  /api/contacts  — unified directory (customers + suppliers + contacts)
 *   ?type=Customer|Supplier|General|Transporter|all
 *   ?search=text
 *
 * POST /api/contacts  — create General or Transporter contact only
 *   (Customers and Suppliers are created via their own modules)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const CONTACT_TYPES = ['General', 'Transporter'];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const typeFilter = searchParams.get('type') || 'all';
    const search     = (searchParams.get('search') || '').toLowerCase();

    const results = [];

    // Fetch from each source based on filter
    const fetchCustomers = typeFilter === 'all' || typeFilter === 'Customer';
    const fetchSuppliers = typeFilter === 'all' || typeFilter === 'Supplier';
    const fetchContacts  = typeFilter === 'all' || ['General','Transporter'].includes(typeFilter);

    const fetches = await Promise.all([
      fetchCustomers
        ? serviceClient.from('customers').select('id, name, contact_person, phone, email, address, notes, created_at')
        : Promise.resolve({ data: [] }),
      fetchSuppliers
        ? serviceClient.from('suppliers').select('id, name, contact_person, phone, email, notes, created_at')
        : Promise.resolve({ data: [] }),
      fetchContacts
        ? (() => {
            let q = serviceClient.from('contacts').select('*');
            if (typeFilter !== 'all') q = q.eq('contact_type', typeFilter);
            return q;
          })()
        : Promise.resolve({ data: [] }),
    ]);

    const [{ data: customers }, { data: suppliers }, { data: contacts }] = fetches;

    for (const c of customers || []) {
      results.push({
        id:           c.id,
        source:       'customers',
        contact_type: 'Customer',
        name:         c.name,
        company:      null,
        contact_person: c.contact_person,
        phone:        c.phone,
        email:        c.email,
        address:      c.address,
        notes:        c.notes,
        created_at:   c.created_at,
      });
    }

    for (const s of suppliers || []) {
      results.push({
        id:           s.id,
        source:       'suppliers',
        contact_type: 'Supplier',
        name:         s.name,
        company:      null,
        contact_person: s.contact_person,
        phone:        s.phone,
        email:        s.email,
        address:      null,
        notes:        s.notes,
        created_at:   s.created_at,
      });
    }

    for (const c of contacts || []) {
      results.push({
        id:           c.id,
        source:       'contacts',
        contact_type: c.contact_type,
        name:         c.name,
        company:      c.company,
        contact_person: null,
        phone:        c.phone,
        email:        c.email,
        address:      c.address,
        notes:        c.notes,
        created_at:   c.created_at,
      });
    }

    // Search filter
    const filtered = search
      ? results.filter(r =>
          [r.name, r.company, r.contact_person, r.phone, r.email]
            .filter(Boolean).join(' ').toLowerCase().includes(search)
        )
      : results;

    // Sort alphabetically by name
    filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    return NextResponse.json({ success: true, data: filtered, total: filtered.length });
  } catch (err) {
    console.error('GET /api/contacts:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }
    if (!CONTACT_TYPES.includes(body.contact_type)) {
      return NextResponse.json({ error: `contact_type must be one of: ${CONTACT_TYPES.join(', ')}` }, { status: 400 });
    }

    const safe = {
      contact_type: body.contact_type,
      name:         body.name.trim(),
      company:      body.company?.trim()  || null,
      phone:        body.phone?.trim()    || null,
      email:        body.email?.trim()    || null,
      address:      body.address?.trim()  || null,
      notes:        body.notes?.trim()    || null,
      created_by:   user.id,
    };

    const { data, error } = await serviceClient
      .from('contacts')
      .insert(safe)
      .select()
      .single();

    if (error) {
      console.error('POST /api/contacts:', error);
      return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    console.error('POST /api/contacts:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
