// Database tests for supabase/migrations/invoice_customer_snapshot.sql
//
// Runs the REAL migration against a minimal stub of customers/orders in an
// in-process Postgres (pglite). It tests the trigger, constraints and legacy
// backfill — not the full issuing RPCs (they need the whole GL schema);
// the RPCs are covered by the staging procedure in invoice_customer_snapshot.md.
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   node supabase/tests/invoice_customer_snapshot.pglite.mjs   (PGLITE_DIR=/tmp/pg if needed)

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire((process.env.PGLITE_DIR || '/tmp/pg') + '/');
const { PGlite } = require('@electric-sql/pglite');

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '../migrations/invoice_customer_snapshot.sql'), 'utf8');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const throws = async (name, fn, re) => {
  try { await fn(); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, re.test(e.message), e.message); }
};
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

await db.exec(`
  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, contact_person text,
    phone text, email text, address text, kra_pin text);
  CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_num text, client text, contact_person text,
    customer_id uuid REFERENCES customers(id), notes text,
    invoice_number text, invoice_issued_at timestamptz, invoice_journal_entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now());
`);

// ── pre-migration data ──────────────────────────────────────────────────────
const cust = await one(`INSERT INTO customers (name, contact_person, phone, email, address, kra_pin)
  VALUES ('Rolaine Njoki','R. Njoki','0700000001','r@example.com','Nairobi','A001') RETURNING id`);
// Legacy issued order whose customer has SINCE been renamed (the drift case)
const legacyCust = await one(`INSERT INTO customers (name, address) VALUES ('RENAMED TODAY','Today St') RETURNING id`);
const legacy = await one(`INSERT INTO orders (order_num, client, customer_id, invoice_number, invoice_issued_at, invoice_journal_entry_id)
  VALUES ('ORD-1','Old Name Ltd',$1,'INV-2026-0001','2026-03-01T10:00:00Z',gen_random_uuid()) RETURNING id`, [legacyCust.id]);
const manualLegacy = await one(`INSERT INTO orders (order_num, client, invoice_number, created_at)
  VALUES ('ORD-2','Manual Co','INV-MANUAL-9','2026-02-01T00:00:00Z') RETURNING id`);

await db.exec(migration);
await db.exec(migration);   // re-runnable

// ── legacy backfill ─────────────────────────────────────────────────────────
let r = await one(`SELECT * FROM orders WHERE id=$1`, [legacy.id]);
ok('legacy: name comes from orders.client, not the current customer', r.invoice_customer_name_snapshot === 'Old Name Ltd', r.invoice_customer_name_snapshot);
ok('legacy: source is legacy_order_snapshot', r.invoice_customer_snapshot_source === 'legacy_order_snapshot');
ok('legacy: captured_at is invoice_issued_at', new Date(r.invoice_customer_snapshot_at).toISOString() === '2026-03-01T10:00:00.000Z');
ok('legacy: unavailable details stay NULL (current address NOT copied)', r.invoice_customer_address_snapshot === null && r.invoice_customer_id_snapshot === null);
r = await one(`SELECT * FROM orders WHERE id=$1`, [manualLegacy.id]);
ok('legacy manual-number order: captured_at falls back to created_at', new Date(r.invoice_customer_snapshot_at).toISOString() === '2026-02-01T00:00:00.000Z');

// ── issuance captures the current customer identity ─────────────────────────
const o = await one(`INSERT INTO orders (order_num, client, customer_id) VALUES ('ORD-3','Rolaine Njoki',$1) RETURNING id`, [cust.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [o.id]);
ok('unissued order has no snapshot', r.invoice_customer_snapshot_at === null && r.invoice_customer_snapshot_source === null);

await db.query(`UPDATE orders SET notes='edit while unissued' WHERE id=$1`, [o.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [o.id]);
ok('ordinary edit of an unissued order leaves it unsnapshotted', r.invoice_customer_snapshot_at === null);

// Customer is renamed BEFORE issue → the invoice must carry the name at issue time
await db.query(`UPDATE customers SET name='LORRAINE WAIGANJO' WHERE id=$1`, [cust.id]);
await db.query(`UPDATE orders SET invoice_number='INV-2026-0100', invoice_issued_at=now(), invoice_journal_entry_id=gen_random_uuid() WHERE id=$1`, [o.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [o.id]);
ok('issuance captures the current customer identity', r.invoice_customer_name_snapshot === 'LORRAINE WAIGANJO' && r.invoice_customer_address_snapshot === 'Nairobi' && r.invoice_customer_tax_id_snapshot === 'A001' && r.invoice_customer_email_snapshot === 'r@example.com' && r.invoice_customer_phone_snapshot === '0700000001' && r.invoice_customer_contact_person_snapshot === 'R. Njoki');
ok('issuance records customer id + source + timestamp', r.invoice_customer_id_snapshot === cust.id && r.invoice_customer_snapshot_source === 'customer_at_issue' && r.invoice_customer_snapshot_at !== null);

// ── immutability ────────────────────────────────────────────────────────────
await db.query(`UPDATE customers SET name='SECOND RENAME', address='Elsewhere' WHERE id=$1`, [cust.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [o.id]);
ok('renaming the customer after issue does not alter the issued invoice', r.invoice_customer_name_snapshot === 'LORRAINE WAIGANJO' && r.invoice_customer_address_snapshot === 'Nairobi');

await throws('direct snapshot name update is rejected', () => db.query(`UPDATE orders SET invoice_customer_name_snapshot='Forged' WHERE id=$1`, [o.id]), /INVOICE_SNAPSHOT_IMMUTABLE/);
await throws('clearing the snapshot is rejected', () => db.query(`UPDATE orders SET invoice_customer_snapshot_at=NULL, invoice_customer_snapshot_source=NULL, invoice_customer_name_snapshot=NULL WHERE id=$1`, [o.id]), /INVOICE_SNAPSHOT_IMMUTABLE|check/i);
await throws('changing the snapshot source is rejected', () => db.query(`UPDATE orders SET invoice_customer_snapshot_source='legacy_order_snapshot' WHERE id=$1`, [o.id]), /INVOICE_SNAPSHOT_IMMUTABLE/);

// re-issuing / re-running the issuing update must not refresh it
await db.query(`UPDATE orders SET invoice_issued_at=now(), invoice_journal_entry_id=gen_random_uuid() WHERE id=$1`, [o.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [o.id]);
ok('re-running issuance does not refresh the snapshot', r.invoice_customer_name_snapshot === 'LORRAINE WAIGANJO' && r.invoice_customer_address_snapshot === 'Nairobi');

await db.query(`UPDATE orders SET notes='post-issue edit', customer_id=NULL WHERE id=$1`, [o.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [o.id]);
ok('ordinary post-issue edits (and unlinking the customer) leave the snapshot alone', r.invoice_customer_name_snapshot === 'LORRAINE WAIGANJO' && r.notes === 'post-issue edit');

// ── atomicity ───────────────────────────────────────────────────────────────
const a = await one(`INSERT INTO orders (order_num, client, customer_id) VALUES ('ORD-4','Atomic Co',$1) RETURNING id`, [legacyCust.id]);
await throws('issuance + a later failure in the same transaction', () => db.transaction(async tx => {
  await tx.query(`UPDATE orders SET invoice_number='INV-2026-0200', invoice_issued_at=now(), invoice_journal_entry_id=gen_random_uuid() WHERE id=$1`, [a.id]);
  const mid = (await tx.query(`SELECT invoice_customer_snapshot_at FROM orders WHERE id=$1`, [a.id])).rows[0];
  if (!mid.invoice_customer_snapshot_at) throw new Error('snapshot missing inside tx');
  throw new Error('journal post failed');
}), /journal post failed/);
r = await one(`SELECT * FROM orders WHERE id=$1`, [a.id]);
ok('failed issuance leaves no invoice number and no snapshot', r.invoice_number === null && r.invoice_customer_snapshot_at === null && r.invoice_customer_name_snapshot === null);

// ── caller-supplied snapshot is ignored at first issue ──────────────────────
const f = await one(`INSERT INTO orders (order_num, client, customer_id) VALUES ('ORD-5','Forge Co',$1) RETURNING id`, [legacyCust.id]);
await db.query(`UPDATE orders SET invoice_number='INV-2026-0300', invoice_issued_at=now(), invoice_journal_entry_id=gen_random_uuid(),
  invoice_customer_name_snapshot='Attacker Ltd', invoice_customer_snapshot_source='legacy_order_snapshot', invoice_customer_snapshot_at='2000-01-01' WHERE id=$1`, [f.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [f.id]);
ok('snapshot values supplied by the caller are ignored', r.invoice_customer_name_snapshot === 'RENAMED TODAY' && r.invoice_customer_snapshot_source === 'customer_at_issue' && new Date(r.invoice_customer_snapshot_at).getFullYear() >= 2026);

// ── walk-in & manual number ─────────────────────────────────────────────────
const w = await one(`INSERT INTO orders (order_num, client, contact_person) VALUES ('ORD-6','Walk-in Joe','Joe') RETURNING id`);
await db.query(`UPDATE orders SET invoice_number='INV-2026-0400', invoice_issued_at=now(), invoice_journal_entry_id=gen_random_uuid() WHERE id=$1`, [w.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [w.id]);
ok('walk-in invoice snapshots the order name', r.invoice_customer_name_snapshot === 'Walk-in Joe' && r.invoice_customer_snapshot_source === 'order_snapshot_at_issue' && r.invoice_customer_id_snapshot === null);

const m = await one(`INSERT INTO orders (order_num, client, customer_id) VALUES ('ORD-7','Manual Linked',$1) RETURNING id`, [legacyCust.id]);
await db.query(`UPDATE orders SET invoice_number='HAND-001' WHERE id=$1`, [m.id]);
r = await one(`SELECT * FROM orders WHERE id=$1`, [m.id]);
ok('a hand-entered invoice number also captures the snapshot', r.invoice_customer_snapshot_source === 'customer_at_issue' && r.invoice_customer_name_snapshot === 'RENAMED TODAY');

const ins = await one(`INSERT INTO orders (order_num, client, customer_id, invoice_number) VALUES ('ORD-8','Born Invoiced',$1,'INV-BORN-1') RETURNING *`, [cust.id]);
ok('an order inserted with an invoice number is snapshotted at insert', ins.invoice_customer_snapshot_at !== null);

// ── constraint ──────────────────────────────────────────────────────────────
await throws('snapshot must be all-or-nothing (source without name)', () => db.query(`INSERT INTO orders (order_num, client) VALUES ('ORD-9','x') RETURNING id`).then(async ({ rows }) => {
  await db.query(`ALTER TABLE orders DISABLE TRIGGER trg_orders_invoice_customer_snapshot`);
  try { await db.query(`UPDATE orders SET invoice_customer_snapshot_source='legacy_order_snapshot' WHERE id=$1`, [rows[0].id]); }
  finally { await db.query(`ALTER TABLE orders ENABLE TRIGGER trg_orders_invoice_customer_snapshot`); }
}), /orders_invoice_snapshot_complete_check|check/i);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
