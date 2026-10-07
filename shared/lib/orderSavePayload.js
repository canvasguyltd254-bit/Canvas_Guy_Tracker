/**
 * Payload for an ordinary order-form save (PATCH /api/orders/[id]).
 *
 * `client` is deliberately NOT part of it: orders.client is the order-time
 * customer-name snapshot. The Company field on the form shows the customer's
 * CURRENT name, and that display value must never be written back. Snapshot
 * corrections go through a separate, audited action — not an ordinary save.
 */
export function buildOrderSavePayload({ notes, dueDate, deliveryAddress, deliveryContact, deliveryInstructions }) {
  return {
    notes,
    due_date: dueDate || null,
    delivery_address: deliveryAddress || null,
    delivery_contact: deliveryContact || null,
    delivery_instructions: deliveryInstructions || null,
  };
}
