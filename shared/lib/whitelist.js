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
      'customer_id',      // nullable FK to customers table
      'payment_due_date', // calculated from customer credit terms at order creation
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
      'delivery_address',
      'delivery_contact',
      'delivery_instructions',
      'batch_delivery',        // one-way toggle (false → true) via Enable Batch Delivery
      // Workflow fields — only set via applyStatus or specific modal actions
      'status',
      'credit_approval_ref',
      'refund_reference',
      // Customer linking — assign/reassign a customer profile to an existing order
      'customer_id',
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

  // Superseded by delivery_batches + delivery_batch_items (V8).
  // Kept for backward compatibility — do not write new code against this table.
  order_deliveries: {
    insert: [
      'order_id',
      'batch_number',
      'quantity',
      'description',
      'delivery_date',
      'delivery_location',
      'delivered_by',
      'received_by',
      'notes',
      'payment_status_at_delivery',
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

  // ── Delivery Batch (V8) ───────────────────────────────────────────────────
  //
  // Role rules enforced in API routes (not just RLS):
  //   insert              → production_manager / admin
  //   update logistics    → any authenticated user (driver, vehicle, status advances)
  //   update admin fields → admin only (cancelled_at, signed_copy_path)

  delivery_batches: {
    insert: [
      'order_id',          // injected from URL param server-side
      'batch_number',      // set by DB trigger — pass null or omit from client
      'status',            // defaults to 'Planned'
      'planned_date',
      'driver',
      'vehicle',
      'delivery_location',
      'notes',
      'created_by',        // injected from session server-side
    ],
    update: [
      'status',
      'planned_date',
      'actual_delivery_date',
      'driver',
      'vehicle',
      'delivery_location',
      'notes',
      // Admin-only — API route must check role before allowing:
      'cancelled_at',
      'cancelled_reason',
      'signed_copy_path',
    ],
  },

  delivery_batch_items: {
    insert: [
      'batch_id',
      'order_item_id',
      'quantity_planned',
      // quantity_delivered + quantity_rejected default to 0
    ],
    update: [
      'quantity_delivered',
      'quantity_rejected',
      'rejection_reason',
      'quantity_planned',   // PM / Admin can correct before batch leaves
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

  // ── Customers module ───────────────────────────────────────────────────────

  customers: {
    insert: [
      'name',
      'contact_person',
      'phone',
      'email',
      'address',
      'kra_pin',
      'credit_limit',
      'credit_terms',
      'opening_balance',
      'opening_balance_date',
      'notes',
    ],
    update: [
      'name',
      'contact_person',
      'phone',
      'email',
      'address',
      'kra_pin',
      'credit_limit',
      'credit_terms',
      'opening_balance',
      'opening_balance_date',
      'notes',
    ],
  },

  customer_notes: {
    insert: [
      'customer_id',
      'content',
      'author_name',
      'created_by',
    ],
    // Notes are immutable — no update.
  },

  contacts: {
    insert: [
      'contact_type',
      'name',
      'company',
      'phone',
      'email',
      'address',
      'notes',
      'created_by',
    ],
    update: [
      'contact_type',
      'name',
      'company',
      'phone',
      'email',
      'address',
      'notes',
    ],
  },

  // ── Payments module ────────────────────────────────────────────────────────

  purchase_order_links: {
    insert: [
      'purchase_id',
      'order_id',
    ],
    // Delete is handled by RLS (no update — replace by delete + re-insert)
  },

  supplier_purchases: {
    insert: [
      'supplier_id',
      'purchase_date',
      'items_bought',
      'total_amount',
      'amount_paid',
      'payment_status',
      'invoice_path',
      'invoice_name',
      'notes',
    ],
    update: [
      'purchase_date',
      'items_bought',
      'total_amount',
      'amount_paid',
      'payment_status',
      'invoice_path',
      'invoice_name',
      'notes',
    ],
  },

  chatpesa_imports: {
    insert: [
      'uploaded_by',
      'uploaded_at',
      'statement_from',
      'statement_to',
      'account_ref',
      'account_name',
      'reconciliation_week',
      'row_count',
      'debit_count',
      'credit_count',
      'refund_count',
      'duplicate_count',
      'total_debits',
    ],
    // Imports are immutable — no update.
  },

  chatpesa_transactions: {
    // Inserted in bulk by the import API — no individual insert whitelist needed
    update: [
      'match_status',
      'matched_at',
      'matched_by',
      'ignored_at',
      'ignored_by',
      'suggested_supplier_id',
      'suggested_confidence',
    ],
  },

  chatpesa_payment_allocations: {
    insert: [
      'transaction_id',
      'allocation_type',
      'supplier_purchase_id',
      'supplier_id',
      'petty_cash_category',
      'amount',
      'note',
      'created_by',
    ],
    // Allocations are immutable — delete and re-add to correct.
  },

  manual_supplier_payments: {
    insert: [
      'supplier_id',
      'supplier_purchase_id',
      'payment_date',
      'amount',
      'payment_method',
      'reference',
      'note',
      'created_by',
    ],
    // Manual payments are immutable — delete and re-add to correct.
  },

};
