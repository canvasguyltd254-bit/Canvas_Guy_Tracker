'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/shared/ui/AppShell';
import { createClient } from '@/shared/supabase/client';
import {
  CATEGORIES, CHARGE_TYPES, FINISH_TYPES, WOOD_TYPES,
  CUSTOMER_TYPES, PAYMENT_TERMS, CREDIT_TERMS,
  ROLES_CAN_CREATE, HEAD_OF_SALES_CREDIT_LIMIT,
} from '@/modules/orders/components/constants';

const newCharge = () => ({
  _id: `${Date.now()}-${Math.random()}`,
  label: 'Delivery Fee',
  amount: '',
});

const supabase = createClient();

const newItem = () => ({
  _id: `${Date.now()}-${Math.random()}`,
  category: 'Wall Decoration Canvas',
  description: '',
  quantity: 1,
  size: '',
  finish_type: 'None',
  finish_color: '',
  wood_type: '',
  unit_price: '',
});

// ── Styles ────────────────────────────────────────────────────────────────────
const inp = {
  width: '100%', padding: '8px 10px',
  border: '1.5px solid #e0e0e0', borderRadius: '7px',
  fontSize: '13px', outline: 'none', background: '#fafafa',
  boxSizing: 'border-box',
};
const smInp = { ...inp, padding: '6px 8px', fontSize: '12px', background: '#fff' };
const lbl = {
  display: 'block', fontSize: '10px', fontWeight: 700, color: '#9ca3af',
  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
};

// ── Line Items Builder ────────────────────────────────────────────────────────
function ItemsBuilder({ items, onChange }) {
  const add = () => onChange([...items, newItem()]);
  const upd = (_id, field, val) => onChange(items.map(i => i._id === _id ? { ...i, [field]: val } : i));
  const del = (_id) => onChange(items.filter(i => i._id !== _id));

  const subtotal = items.reduce((s, i) => s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <span style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Line Items ({items.length})
        </span>
        <button type="button" onClick={add} style={{
          padding: '6px 14px', borderRadius: '6px', border: 'none',
          background: '#1a1a1a', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
        }}>
          + Add Item
        </button>
      </div>

      {items.length === 0 && (
        <div style={{ padding: '20px', textAlign: 'center', color: '#bbb', background: '#fafafa', borderRadius: '8px', border: '1px dashed #e0e0e0', fontSize: '13px' }}>
          No items yet — click "+ Add Item" to start
        </div>
      )}

      {items.map((item, idx) => (
        <div key={item._id} style={{
          background: '#fafafa', border: '1.5px solid #e8e5e0',
          borderRadius: '10px', padding: '14px', marginBottom: '10px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: '#9ca3af' }}>Item {idx + 1}</span>
            <button type="button" onClick={() => del(item._id)} style={{
              background: 'none', border: 'none', color: '#ef4444',
              cursor: 'pointer', fontSize: '12px', fontWeight: 700,
            }}>Remove</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
            <div>
              <label style={lbl}>Category</label>
              <select value={item.category} onChange={e => upd(item._id, 'category', e.target.value)} style={smInp}>
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Qty</label>
              <input type="number" min="1" value={item.quantity}
                onChange={e => upd(item._id, 'quantity', e.target.value)} style={smInp} />
            </div>
            <div>
              <label style={lbl}>Size</label>
              <input type="text" value={item.size} placeholder="e.g. 60×40cm"
                onChange={e => upd(item._id, 'size', e.target.value)} style={smInp} />
            </div>
            <div>
              <label style={lbl}>Finish Type</label>
              <select value={item.finish_type} onChange={e => upd(item._id, 'finish_type', e.target.value)} style={smInp}>
                {FINISH_TYPES.map(f => <option key={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Finish Color</label>
              <input type="text" value={item.finish_color} placeholder="e.g. Dark Walnut"
                onChange={e => upd(item._id, 'finish_color', e.target.value)} style={smInp} />
            </div>
            <div>
              <label style={lbl}>Wood Type</label>
              <select value={item.wood_type} onChange={e => upd(item._id, 'wood_type', e.target.value)} style={smInp}>
                <option value="">—</option>
                {WOOD_TYPES.map(w => <option key={w}>{w}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Unit Price (KES)</label>
              <input type="number" min="0" value={item.unit_price} placeholder="0"
                onChange={e => upd(item._id, 'unit_price', e.target.value)} style={smInp} />
            </div>
            <div style={{ gridColumn: '2 / -1' }}>
              <label style={lbl}>Description / Notes</label>
              <input type="text" value={item.description} placeholder="Additional details"
                onChange={e => upd(item._id, 'description', e.target.value)} style={smInp} />
            </div>
          </div>
          {parseFloat(item.unit_price) > 0 && (
            <div style={{ textAlign: 'right', fontSize: '12px', fontWeight: 700, color: '#374151', marginTop: '8px', fontFamily: 'monospace' }}>
              Line total: KES {((parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1)).toLocaleString()}
            </div>
          )}
        </div>
      ))}

      {subtotal > 0 && (
        <div style={{
          textAlign: 'right', fontSize: '13px', fontWeight: 800,
          color: '#111', padding: '8px 4px', fontFamily: 'monospace',
          borderTop: '2px solid #e5e7eb', marginTop: '4px',
        }}>
          Items Subtotal: KES {subtotal.toLocaleString()}
        </div>
      )}
    </div>
  );
}

// ── Additional Charges Builder ────────────────────────────────────────────────
function ChargesBuilder({ charges, onChange }) {
  const add = () => onChange([...charges, newCharge()]);
  const upd = (_id, field, val) => onChange(charges.map(c => c._id === _id ? { ...c, [field]: val } : c));
  const del = (_id) => onChange(charges.filter(c => c._id !== _id));
  const total = charges.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <span style={{ fontSize: '11px', color: '#6b7280' }}>Delivery fees, design fees, installation — stored as line items, no DB changes needed.</span>
        <button type="button" onClick={add} style={{
          padding: '6px 14px', borderRadius: '6px', border: 'none',
          background: '#1a1a1a', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
        }}>+ Add Charge</button>
      </div>

      {charges.length === 0 && (
        <div style={{ padding: '16px', textAlign: 'center', color: '#bbb', background: '#fafafa', borderRadius: '8px', border: '1px dashed #e0e0e0', fontSize: '13px' }}>
          No additional charges — click "+ Add Charge" if needed
        </div>
      )}

      {charges.map(c => (
        <div key={c._id} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
          <select value={c.label} onChange={e => upd(c._id, 'label', e.target.value)} style={{ flex: '0 0 180px', padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', background: '#fafafa' }}>
            {CHARGE_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
          <input type="number" min="0" value={c.amount} placeholder="Amount (KES)"
            onChange={e => upd(c._id, 'amount', e.target.value)}
            style={{ flex: 1, padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', background: '#fafafa' }} />
          {parseFloat(c.amount) > 0 && (
            <span style={{ fontSize: '12px', fontWeight: 700, color: '#374151', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
              KES {parseFloat(c.amount).toLocaleString()}
            </span>
          )}
          <button type="button" onClick={() => del(c._id)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '16px', fontWeight: 700, padding: '0 4px', flexShrink: 0 }}>×</button>
        </div>
      ))}

      {total > 0 && (
        <div style={{ textAlign: 'right', fontSize: '13px', fontWeight: 800, color: '#111', padding: '8px 4px', fontFamily: 'monospace', borderTop: '2px solid #e5e7eb', marginTop: '4px' }}>
          Charges Total: KES {total.toLocaleString()}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function NewOrderPage() {
  const router = useRouter();
  const [userRole, setUserRole] = useState('viewer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([newItem()]);
  const [charges, setCharges] = useState([]);
  const [form, setForm] = useState({
    client: '',
    contact_person: '',
    author: '',
    due_date: '',
    quote_number: '',
    invoice_number: '',
    customer_type: 'retail',
    payment_terms: 'cash_before',
    batch_delivery: false,
    notes: '',
  });

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles').select('role, display_name').eq('id', user.id).single();
        if (profile) {
          setUserRole(profile.role);
          setForm(f => ({ ...f, author: f.author || profile.display_name || user.email?.split('@')[0] || '' }));
        }
      }
    })();
  }, []);

  const set = (field) => (e) =>
    setForm(f => ({ ...f, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const itemsSubtotal = items.reduce(
    (s, i) => s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0,
  );
  const chargesTotal = charges.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
  const contractTotal = itemsSubtotal + chargesTotal;

  const isCredit = ['reseller', 'commercial'].includes(form.customer_type)
    && CREDIT_TERMS.includes(form.payment_terms);

  const canCreate = ROLES_CAN_CREATE.includes(userRole);
  const canSubmit = form.client.trim() && items.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSubmit || !canCreate) return;
    setSaving(true);
    setError(null);
    try {
      const summary = items
        .map(i => `${i.quantity}x ${i.category}${i.size ? ' - ' + i.size : ''}`)
        .join('\n');

      const { data: created, error: insertErr } = await supabase
        .from('orders')
        .insert({
          client: form.client.trim(),
          contact_person: form.contact_person.trim() || null,
          author: form.author.trim() || null,
          due_date: form.due_date || null,
          total_value: contractTotal,
          quote_number: form.quote_number.trim() || null,
          invoice_number: form.invoice_number.trim() || null,
          customer_type: form.customer_type,
          payment_terms: form.payment_terms,
          batch_delivery: form.batch_delivery,
          notes: form.notes.trim() || null,
          status: 'Inquiry',
          items: summary,
        })
        .select()
        .single();

      if (insertErr) throw insertErr;

      // Insert line items + additional charges (charges stored as line items)
      const allRows = [
        ...items.map((item, idx) => ({
          order_id: created.id,
          category: item.category,
          description: item.description || null,
          quantity: parseInt(item.quantity) || 1,
          size: item.size || null,
          finish_type: item.finish_type || null,
          finish_color: item.finish_color || null,
          wood_type: item.wood_type || null,
          unit_price: parseFloat(item.unit_price) || 0,
          sort_order: idx,
        })),
        ...charges.filter(c => parseFloat(c.amount) > 0).map((c, idx) => ({
          order_id: created.id,
          category: c.label,
          description: c.label,
          quantity: 1,
          unit_price: parseFloat(c.amount) || 0,
          sort_order: items.length + idx,
        })),
      ];
      if (allRows.length > 0) {
        const { error: itemsErr } = await supabase.from('order_items').insert(allRows);
        if (itemsErr) console.error('Items error:', itemsErr);
      }

      // Activity log
      await supabase.from('order_activities').insert({
        order_id: created.id,
        activity_type: 'created',
        description: `Order ${created.order_num} created for ${form.client.trim()}`,
      }).then(null, () => {});

      // Auto-create client_profiles for credit clients
      if (isCredit) {
        const { data: existing } = await supabase
          .from('client_profiles').select('id')
          .eq('client_name', form.client.trim())
          .maybeSingle();
        if (!existing) {
          await supabase.from('client_profiles').insert({
            client_name: form.client.trim(),
            customer_type: form.customer_type,
            credit_limit: 0,
          }).then(null, () => {});
        }
      }

      router.push(`/orders/${created.id}/form`);
    } catch (err) {
      setError(err.message || 'Failed to create order');
      setSaving(false);
    }
  };

  if (userRole !== 'viewer' && !canCreate) {
    return (
      <AppShell>
        <div style={{ padding: '60px', textAlign: 'center' }}>
          <p style={{ color: '#9ca3af', marginBottom: '16px' }}>You don't have permission to create orders.</p>
          <Link href="/orders" style={{ color: '#E8512A', fontWeight: 600, textDecoration: 'none' }}>← Back to Orders</Link>
        </div>
      </AppShell>
    );
  }

  const card = {
    background: '#fff', border: '1px solid #e5e7eb',
    borderRadius: '10px', padding: '20px', marginBottom: '24px',
  };
  const sectionLabel = {
    fontSize: '10px', fontWeight: 700, color: '#6b7280',
    textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px',
  };

  return (
    <AppShell>
      <div style={{ background: '#f9fafb', minHeight: 'calc(100vh - 56px)' }}>

        {/* Header */}
        <div style={{ background: '#111827', color: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderBottom: '1px solid #374151' }}>
            <Link href="/orders" style={{ color: '#9ca3af', fontSize: '13px', fontWeight: 600, textDecoration: 'none' }}>
              ← Back to Orders
            </Link>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Link href="/orders" style={{
                padding: '8px 16px', borderRadius: '7px',
                border: '1px solid #4b5563', color: '#d1d5db',
                fontSize: '13px', fontWeight: 600, textDecoration: 'none',
              }}>
                Cancel
              </Link>
              <button
                onClick={handleSave}
                disabled={!canSubmit}
                style={{
                  padding: '8px 20px', borderRadius: '7px', border: 'none',
                  background: canSubmit ? '#E8512A' : '#6b7280',
                  color: '#fff', fontWeight: 700, fontSize: '13px',
                  cursor: canSubmit ? 'pointer' : 'default',
                }}
              >
                {saving ? 'Creating...' : 'Create Order →'}
              </button>
            </div>
          </div>
          <div style={{ padding: '20px 24px 24px' }}>
            <div style={{ fontSize: '28px', fontWeight: 800 }}>New Order</div>
            <div style={{ fontSize: '13px', color: '#9ca3af', marginTop: '4px' }}>
              Starts at Inquiry — advance through the workflow once saved
            </div>
          </div>
        </div>

        <main style={{ maxWidth: '860px', margin: '0 auto', padding: '28px 20px' }}>

          {error && (
            <div style={{
              padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca',
              borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '20px',
            }}>
              ⚠ {error}
            </div>
          )}

          {/* Section 1 — Client + Order Info */}
          <div style={sectionLabel}>📋 Order Details</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>

            {/* Client card */}
            <div style={card}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#111', textTransform: 'uppercase', marginBottom: '14px' }}>Client</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label style={lbl}>Client / Company *</label>
                  <input type="text" value={form.client} onChange={set('client')}
                    placeholder="Client name or company" style={inp} autoFocus />
                </div>
                <div>
                  <label style={lbl}>Contact Person</label>
                  <input type="text" value={form.contact_person} onChange={set('contact_person')}
                    placeholder="Name / phone / email" style={inp} />
                </div>
                <div>
                  <label style={lbl}>Order Author / Sales Rep</label>
                  <input type="text" value={form.author} onChange={set('author')}
                    placeholder="Who owns this order?" style={inp} />
                </div>
                <div>
                  <label style={lbl}>Customer Type</label>
                  <select value={form.customer_type} onChange={set('customer_type')} style={inp}>
                    {CUSTOMER_TYPES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Payment Terms</label>
                  <select value={form.payment_terms} onChange={set('payment_terms')} style={inp}>
                    {PAYMENT_TERMS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  {isCredit && (
                    <div style={{
                      marginTop: '8px', padding: '8px 12px', background: '#EDE7F6',
                      borderRadius: '6px', fontSize: '11px', color: '#512DA8', fontWeight: 600,
                    }}>
                      🔒 Credit client — deposit gate bypassed. Credit approval required when advancing from Quote Approved.
                      {form.customer_type === 'reseller' && ` Head of Sales can approve up to KES ${HEAD_OF_SALES_CREDIT_LIMIT.toLocaleString()}.`}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* General Info card */}
            <div style={card}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#111', textTransform: 'uppercase', marginBottom: '14px' }}>General Info</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label style={lbl}>Due Date</label>
                  <input type="date" value={form.due_date} onChange={set('due_date')} style={inp} />
                </div>
                <div>
                  <label style={lbl}>Contract Total (KES)</label>
                  <div style={{
                    padding: '10px 12px', background: contractTotal > 0 ? '#f0fdf4' : '#fafafa',
                    border: `1.5px solid ${contractTotal > 0 ? '#86efac' : '#e0e0e0'}`,
                    borderRadius: '7px', fontFamily: 'monospace',
                    fontSize: contractTotal > 0 ? '16px' : '13px',
                    fontWeight: contractTotal > 0 ? 800 : 400,
                    color: contractTotal > 0 ? '#15803d' : '#9ca3af',
                  }}>
                    {contractTotal > 0 ? `KES ${contractTotal.toLocaleString()}` : 'Auto-computed from items + charges'}
                  </div>
                  {contractTotal > 0 && (
                    <div style={{ marginTop: '5px', fontSize: '11px', color: '#9ca3af' }}>
                      Items: KES {itemsSubtotal.toLocaleString()}
                      {chargesTotal > 0 && ` · Charges: KES ${chargesTotal.toLocaleString()}`}
                    </div>
                  )}
                </div>
                <div>
                  <label style={lbl}>Quote Number</label>
                  <input type="text" value={form.quote_number} onChange={set('quote_number')}
                    placeholder="e.g. QT-001234" style={inp} />
                </div>
                <div>
                  <label style={lbl}>Invoice Number</label>
                  <input type="text" value={form.invoice_number} onChange={set('invoice_number')}
                    placeholder="e.g. INV-001234" style={inp} />
                </div>
                <div>
                  <label style={lbl}>Batch Delivery</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                      type="button"
                      onClick={() => setForm(f => ({ ...f, batch_delivery: !f.batch_delivery }))}
                      style={{
                        padding: '6px 14px', borderRadius: '6px', cursor: 'pointer',
                        border: `1.5px solid ${form.batch_delivery ? '#16a34a' : '#e0e0e0'}`,
                        background: form.batch_delivery ? '#dcfce7' : '#fff',
                        color: form.batch_delivery ? '#16a34a' : '#9ca3af',
                        fontSize: '12px', fontWeight: 700,
                      }}
                    >
                      {form.batch_delivery ? '✓ Enabled' : 'Disabled'}
                    </button>
                    <span style={{ fontSize: '11px', color: '#bbb' }}>For phased / multi-drop deliveries</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2 — Line Items */}
          <div style={sectionLabel}>📦 Line Items</div>
          <div style={card}>
            <ItemsBuilder items={items} onChange={setItems} />
          </div>

          {/* Section 3 — Additional Charges */}
          <div style={sectionLabel}>💸 Additional Charges</div>
          <div style={card}>
            <ChargesBuilder charges={charges} onChange={setCharges} />
          </div>

          {/* Contract Total summary */}
          {contractTotal > 0 && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '14px 20px', marginBottom: '24px',
              background: '#f0fdf4', border: '2px solid #86efac', borderRadius: '10px',
            }}>
              <div style={{ fontSize: '12px', color: '#166534' }}>
                {itemsSubtotal > 0 && <span>Items KES {itemsSubtotal.toLocaleString()}</span>}
                {chargesTotal > 0 && <span> + Charges KES {chargesTotal.toLocaleString()}</span>}
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', color: '#15803d' }}>
                Contract Total: KES {contractTotal.toLocaleString()}
              </div>
            </div>
          )}

          {/* Section 4 — Notes */}
          <div style={sectionLabel}>📝 Notes</div>
          <div style={{ ...card, marginBottom: '32px' }}>
            <textarea
              value={form.notes}
              onChange={set('notes')}
              rows={3}
              placeholder="Delivery address, special instructions, client requirements..."
              style={{ ...inp, resize: 'vertical' }}
            />
          </div>

          {/* Bottom save */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', paddingBottom: '40px' }}>
            <Link href="/orders" style={{
              padding: '10px 20px', borderRadius: '7px',
              border: '1px solid #e0e0e0', color: '#6b7280',
              fontSize: '13px', fontWeight: 600, textDecoration: 'none',
            }}>
              Cancel
            </Link>
            <button
              onClick={handleSave}
              disabled={!canSubmit}
              style={{
                padding: '10px 28px', borderRadius: '7px', border: 'none',
                background: canSubmit ? '#E8512A' : '#d1d5db',
                color: canSubmit ? '#fff' : '#9ca3af',
                fontWeight: 700, fontSize: '13px',
                cursor: canSubmit ? 'pointer' : 'default',
              }}
            >
              {saving ? 'Creating order...' : 'Create Order →'}
            </button>
          </div>
        </main>
      </div>
    </AppShell>
  );
}
