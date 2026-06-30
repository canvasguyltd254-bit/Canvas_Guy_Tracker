/**
 * shared/lib/whitelist.js
 *
 * Field allow-lists for every table Canvas Guy Tracker writes to.
 * Purpose: prevent mass assignment — only explicitly listed fields
 * are ever written to the database through an API route.
 *
 * Usage:
 *   import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
 *   const safe = pick(body, ALLOWED_FIELDS.orders.update);
 *   await serviceClient.from('orders').update(safe).eq('id', id);
 *
 * Rules:
 *   - NEVER include: id, created_at, order_num, created_by (DB-generated)
 *   - status is in update only for applyStatus — all other updates exclude it
 *   - customer_type is insert-only (cannot be changed post-creation)
 *   - client (company name) is insert-only (changing it breaks audit trail)
 */

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Pick only the keys in allowedKeys from obj.
 * Unknown keys are silently dropped. Missing allowed keys are also omitted
 * (not set to undefined), so partial updates work naturally.
 */
export function pick(obj, allowedKeys) {
  const result = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Like pick(), but throws if any key in obj is NOT in allowedKeys.
 * Use for strict endpoints where unexpected fields should be an error.
 */
export function pickStrict(obj, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`Field not allowed: "${key}"`);
    }
  }
  return pick(obj, allowedKeys);
}

// ── V7 Tables ─────────────────────────────────────────────────────────────────

export const ALLOWED_FIELDS = {

  orders: {
    insert: [
      'client',           // set on create, never changed
      'contact_person',
      'author',
      'due_date',
      'total_value',
      'quote_number',
      'invoice_number',
      'customer_type',    // set on create, never changed
      'payment_terms',
      'batch_delivery',
      'notes',
      'order_type',       // 'standard' | 'repair' | 'return'
      'status',           // initial status (Inquiry / Reported)
      'items',            // denormalized summary string
      'parent_order_id',  // repair/return link to original order
    ],
    update: [
      // Editable metadata
      'contact_person',
      'author',
      'due_date',
      'total_value',
      'quote_number',
      'invoice_number',
      'payment_terms',
      'batch_delivery',
      'notes',
      'items',
      // Workflow fields — only set via applyStatus or specific modal actions
      'status',
      'credit_approval_ref',
      'refund_reference',
    ],
    // BLOCKED from update: id, order_num, created_at, created_by, client, customer_type, order_type
  },

  order_items: {
    insert: [
      'order_id',
      'category',
      'description',
      'quantity',
      'size',
      'finish_type',
      'finish_color',
      'wood_type',
      'unit_price',
      'sort_order',
    ],
    update: [
      // id and order_id are never changed
      'category',
      'description',
      'quantity',
      'size',
      'finish_type',
      'finish_color',
      'wood_type',
      'unit_price',
      'sort_order',
    ],
  },

  order_payments: {
    insert: [
      'order_id',
      'amount',
      'description',
      'payment_date',
    ],
    // Payments are immutable — no update allowed. Delete + re-add only.
  },

  order_notes: {
    insert: [
      'order_id',
      'content',
      'author_name',  // resolved server-side from session, not from body
    ],
  },

  order_activities: {
    insert: [
      'order_id',
      'activity_type',
      'description',
    ],
  },

  order_documents: {
    insert: [
      'order_id',
      'name',
      'doc_type',
      'file_path',
      'file_size',
    ],
  },

  order_deliveries: {
    insert: [
      'order_id',           // injected server-side from URL
      'batch_number',       // computed server-side (max + 1)
      'quantity',
      'description',
      'delivery_date',
      'delivery_location',
      'delivered_by',
      'received_by',
      'notes',
      'payment_status_at_delivery', // computed server-side from DB payments
      // admin_authorized / admin_auth_reason — server-injected, never from body
    ],
    update: [
      'quantity',
      'description',
      'delivery_date',
      'delivery_location',
      'delivered_by',
      'received_by',
      'notes',
      'payment_status_at_delivery',
    ],
  },

  drawings: {
    insert: [
      'order_id',
      'file_name',
      'file_path',
      'file_size',
      'mime_type',
      'drawing_type',
      'uploaded_by',  // always set from verified session, never from body
      'uploaded_at',
    ],
    update: [
      'deleted_at',   // soft delete only
    ],
  },

  client_profiles: {
    insert: [
      'client_name',
      'customer_type',
      'credit_limit',
      'current_exposure',
    ],
    update: [
      'credit_limit',
      'current_exposure',
    ],
    // BLOCKED from update: id, client_name, customer_type
  },

  user_profiles: {
    update: [
      'display_name',   // users can only change their own display name
      // BLOCKED: id, role, email — role changes are admin-only via a separate endpoint
    ],
    adminUpdate: [
      'display_name',
      'role',
    ],
  },

  // ── V8 Tables (add as each module is built) ────────────────────────────────

  suppliers: {
    insert: [
      'name',
      'contact_person',
      'phone',
      'email',
      'address',
      'payment_terms',
      'notes',
    ],
    update: [
      'name',
      'contact_person',
      'phone',
      'email',
      'address',
      'payment_terms',
      'notes',
    ],
  },

  bills: {
    insert: [
      'supplier_id',
      'bill_number',
      'bill_date',
      'due_date',
      'total_amount',
      'tax_amount',
      'notes',
      'status',       // draft | approved | paid | overdue
      'order_id',     // optional PO link
    ],
    update: [
      'bill_number',
      'bill_date',
      'due_date',
      'total_amount',
      'tax_amount',
      'notes',
      'status',
    ],
  },

  materials: {
    insert: [
      'sku',
      'name',
      'unit',
      'category',
      'reorder_level',
      'warehouse_location',
      'notes',
    ],
    update: [
      'name',
      'unit',
      'category',
      'reorder_level',
      'warehouse_location',
      'notes',
    ],
    // BLOCKED from update: sku (primary identifier)
  },

  stock_movements: {
    insert: [
      'material_id',
      'movement_type',  // inbound | outbound | transfer | adjustment
      'quantity',
      'unit_cost',
      'reference',      // bill_id or order_id depending on type
      'notes',
      'moved_by',       // set from session
      'moved_at',
    ],
    // Stock movements are immutable — no update. Add a reversal movement instead.
  },

};
