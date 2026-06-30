# V7 Client-Side Security Audit

**Date:** 2026-06-29  
**Scope:** All client components (`app/` and `modules/`) that call Supabase directly for writes (`.insert`, `.update`, `.delete`, `.upsert`), bypassing server-side API routes.  
**Auditor:** Automated sprint — canvas-guy-security-hardening

---

## Summary

Every entry below is a write that goes directly from the browser to Supabase using the **anon key**. Protection relies entirely on Supabase RLS policies. Where RLS is misconfigured or absent, an authenticated user can write arbitrary values — including `status`, `role`, `credit_limit`, and other privileged fields.

**Risk legend:**
- **LOW** — RLS policies fully cover this. No fields bypass column-level checks.
- **MEDIUM** — RLS provides row-level isolation, but column-level checks are absent. A user with the correct role could write unexpected field values (e.g. injecting `status` via an update that should only touch `notes`).
- **HIGH** — Fields are not protected by RLS column checks, or the operation itself has no server-side role validation, meaning a determined user can manipulate privileged data.

---

## app/orders/new/page.js

### 1. `orders.insert` — Line ~263
```js
supabase.from('orders').insert({ client, contact_person, author, ..., status: 'Inquiry', ... })
```
- **Table:** orders
- **Risk:** MEDIUM
- **Issue:** `status` is passed from the client. A user could change `'Inquiry'` to any status string before the request fires. The `author` field is also user-editable in the form — any value is accepted.
- **Fix:** Migrate to `POST /api/orders`. Server hardcodes `status: 'Inquiry'` and resolves `author` from the session.

### 2. `order_items.insert` — Line ~308
```js
supabase.from('order_items').insert(allRows)
```
- **Table:** order_items
- **Risk:** MEDIUM
- **Issue:** `order_id` is set client-side. RLS should enforce that the inserting user owns the parent order, but field values (unit_price, category) are fully user-controlled with no server-side validation.
- **Fix:** Covered by `POST /api/orders` (items sent in `body.items`, `order_id` injected server-side).

### 3. `order_activities.insert` — Line ~313
```js
supabase.from('order_activities').insert({ order_id, activity_type: 'created', description })
```
- **Table:** order_activities
- **Risk:** LOW
- **Issue:** Activity logs are append-only. A user could inject arbitrary `activity_type` strings, which could pollute audit logs but not cause data corruption.
- **Fix:** Low priority. Server-side route already fires this log; client call will be removed when migrated to `/api/orders`.

### 4. `client_profiles.insert` — Line ~326
```js
supabase.from('client_profiles').insert({ client_name, customer_type, credit_limit: 0 })
```
- **Table:** client_profiles
- **Risk:** MEDIUM
- **Issue:** `credit_limit` is hardcoded to 0 here, but a user could tamper the payload before send. RLS likely restricts inserts to certain roles, but column-level checks on `credit_limit` are probably absent.
- **Fix:** Migrate to `/api/orders` POST handler (already included). Server enforces `credit_limit: 0` on auto-create.

---

## app/orders/[id]/form/page.js

### 5. `order_notes.insert` — Line 97
```js
supabase.from('order_notes').insert({ order_id: orderId, content, author_name: authorName })
```
- **Table:** order_notes
- **Risk:** MEDIUM
- **Issue:** `author_name` is resolved from the client-side session, but it's then sent in the payload. A user could intercept and overwrite it with any name. The anon key relies on RLS to scope by `order_id`, but `author_name` is unprotected.
- **Fix:** Migrate to `POST /api/orders/[id]/notes`. Server resolves `displayName` from the verified session and ignores `author_name` in the body entirely.

### 6. `order_documents.insert` — Line 189
```js
supabase.from('order_documents').insert({ order_id: orderId, name: file.name, doc_type: docType, file_path: filePath, file_size: file.size })
```
- **Table:** order_documents
- **Risk:** MEDIUM
- **Issue:** `file_path` is constructed client-side (could point to any storage path, including paths belonging to other orders). No server validates the path is scoped to the correct order.
- **Fix:** Migrate to `POST /api/orders/[id]/documents`. Server handles storage upload and constructs `file_path` from `orderId`, eliminating path injection.

### 7. `order_documents.delete` — Line 204
```js
supabase.from('order_documents').delete().eq('id', doc.id)
```
- **Table:** order_documents
- **Risk:** MEDIUM
- **Issue:** No role check on the client side — any authenticated user who can reach this UI path can delete. RLS may restrict this, but it's not verified. The storage object is also deleted from the browser side using the anon key.
- **Fix:** Migrate to `DELETE /api/orders/[id]/documents?document_id=...`. Server enforces `DELETE_ROLES` and scopes deletion to the correct order.

### 8. `order_payments.insert` — Line 313
```js
supabase.from('order_payments').insert({ order_id: orderId, amount: a, description: desc, payment_date: payDate })
```
- **Table:** order_payments
- **Risk:** HIGH
- **Issue:** Financial record created with no server-side validation. Amount, date, and description are entirely user-controlled. No server-side audit trail injection. RLS likely allows any authenticated write on the user's orders.
- **Fix:** Migrate to `POST /api/orders/[id]/payments`.

### 9. `order_payments.delete` — Line 321
```js
supabase.from('order_payments').delete().eq('id', p.id)
```
- **Table:** order_payments
- **Risk:** HIGH
- **Issue:** Financial record deleted without admin-only role check. Any user who can see this order can delete payment records, corrupting the financial audit trail.
- **Fix:** Migrate to `DELETE /api/orders/[id]/payments?payment_id=...`. Server enforces `['admin']` only.

### 10. `orders.update` (metadata) — Line 586
```js
supabase.from('orders').update({ notes, due_date, total_value }).eq('id', id)
```
- **Table:** orders
- **Risk:** MEDIUM
- **Issue:** `total_value` is user-computed (from items subtotal) and then sent directly. A user could tamper this to any value before the call fires.
- **Fix:** Migrate to `PATCH /api/orders/[id]`. Server recomputes `total_value` from the authoritative items in the DB, or at minimum validates it.

### 11. `order_items.delete` — Line 591
```js
supabase.from('order_items').delete().in('id', deletedItemIds)
```
- **Table:** order_items
- **Risk:** HIGH
- **Issue:** `deletedItemIds` is a client-side array. There is no scoping to the current `order_id` in this call — a user could pass IDs belonging to any order. If RLS doesn't scope deletes by `order_id`, this is a cross-order data leak vector.
- **Fix:** Migrate to `PATCH /api/orders/[id]`. Server scopes all item deletes with `.eq('order_id', orderId)`.

### 12. `order_items.insert` — Line 608
```js
supabase.from('order_items').insert(rows)
```
- **Table:** order_items
- **Risk:** MEDIUM
- **Issue:** Row data is fully client-controlled. No field whitelisting.
- **Fix:** Migrate to `PATCH /api/orders/[id]` (items without id → server inserts them).

### 13. `order_items.update` — Lines 620, 637
```js
supabase.from('order_items').update({ category, description, quantity, ... }).eq('id', item.id)
```
- **Table:** order_items
- **Risk:** MEDIUM
- **Issue:** No scoping to `order_id` in the update call — a user could potentially update an item from a different order if they know its UUID.
- **Fix:** Migrate to `PATCH /api/orders/[id]`. Server scopes updates with `.eq('order_id', orderId)`.

### 14. `orders.update` (status + extras) — Line 688
```js
supabase.from('orders').update({ status: newStatus, refund_reference, credit_approval_ref }).eq('id', id)
```
- **Table:** orders
- **Risk:** HIGH
- **Issue:** Status is a workflow field controlling production flow and financial gating. Writing it directly from the browser means the client-side role checks (ROLES_CAN_ADVANCE, ROLES_CAN_REWORK, etc.) are the only protection — an attacker can call the Supabase API directly with the anon key and skip them entirely.
- **Fix:** Migrate to `POST /api/orders/[id]/status`. Server validates the role, direction, and status value.

### 15. `order_activities.insert` — Lines 692, 759, 778, 816
```js
supabase.from('order_activities').insert({ order_id, activity_type, description })
```
- **Table:** order_activities
- **Risk:** LOW
- **Issue:** Activity log is append-only. Client can inject arbitrary `activity_type` strings.
- **Fix:** Activity logs should be written server-side only as a side-effect of the relevant route. Remove all client-side activity writes when migrating parent operations.

### 16. `orders.insert` (repair/return) — Line 801
```js
supabase.from('orders').insert({ client, status: 'Reported', order_type: repairType, ... })
```
- **Table:** orders
- **Risk:** HIGH
- **Issue:** A new order is created entirely client-side with no field whitelisting. Fields like `parent_order_id`, `order_type`, and `status` are set from the browser. Role check is client-side only (ROLES_CAN_REPAIR).
- **Fix:** Add `POST /api/orders/repair` (not yet created). Server validates the parent order exists, enforces allowed repair fields, and hardcodes `status: 'Reported'`.

### 17. `client_profiles.update` (credit exposure) — Line 852
```js
supabase.from('client_profiles').update({ current_exposure: newExposure }).eq('client_name', order.client)
```
- **Table:** client_profiles
- **Risk:** HIGH
- **Issue:** `current_exposure` is a financial control field used for credit limit enforcement. It is set here using client-computed arithmetic. A user could tamper the value. This is also scoped by `client_name` (a string) rather than a UUID, which is fragile.
- **Fix:** Exposure update must move server-side, co-located with the status transition that triggers it.

### 18. `orders.update` (quote number inline) — Line 862
```js
supabase.from('orders').update({ quote_number: quoteNum.trim() }).eq('id', id)
```
- **Table:** orders
- **Risk:** LOW
- **Issue:** Quote number is a reference string. Low sensitivity. RLS should prevent cross-order writes.
- **Fix:** Can migrate to `PATCH /api/orders/[id]` as part of broader cleanup. Not urgent.

---

## modules/contacts/components/ContactsDirectory.js

### 19. `contacts.update` — Line 90
```js
sb.from("contacts").update({ ...form, company_name: form.company_name.trim() }).eq("id", editing)
```
- **Table:** contacts
- **Risk:** MEDIUM
- **Issue:** Entire form spread into update with no field whitelist. Any additional keys on `form` would be written to the DB.
- **Fix:** Add `contacts` to `ALLOWED_FIELDS` in whitelist.js and migrate to an API route (`PATCH /api/contacts/[id]`).

### 20. `contacts.insert` — Line 93
```js
sb.from("contacts").insert({ ...form, company_name: form.company_name.trim() })
```
- **Table:** contacts
- **Risk:** MEDIUM
- **Issue:** Same form-spread issue — no field whitelist.
- **Fix:** Migrate to `POST /api/contacts`.

### 21. `contacts.delete` — Line 107
```js
sb.from("contacts").delete().eq("id", deleteTarget)
```
- **Table:** contacts
- **Risk:** LOW
- **Issue:** Role check is client-side only. RLS should prevent cross-user deletes.
- **Fix:** Migrate to `DELETE /api/contacts/[id]` with an admin-only gate.

---

## modules/admin/components/UserAdmin.js

### 22. `client_profiles.update` (credit_limit) — Line 97
```js
sb.from("client_profiles").update({ credit_limit: parseFloat(newLimit) }).eq("client_name", clientName)
```
- **Table:** client_profiles
- **Risk:** HIGH
- **Issue:** Credit limit is a financial control field. It's set from the admin UI with a direct client write. Any authenticated user who can hit this Supabase endpoint with the anon key can set any client's credit limit to any value. RLS must be verified to restrict this to admin-only.
- **Fix:** Migrate to `PATCH /api/admin/clients/[name]/credit-limit` with `['admin']` gate.

### 23. `client_profiles.insert` — Lines 101, 131
```js
sb.from("client_profiles").insert({ client_name, customer_type, credit_limit, current_exposure })
```
- **Table:** client_profiles
- **Risk:** HIGH
- **Issue:** `credit_limit` and `current_exposure` are injected from the browser with no server-side validation. An attacker could pre-set a high credit limit on a new client profile.
- **Fix:** Migrate to a server-side route. Enforce `credit_limit: 0` and `current_exposure: 0` on create; subsequent limit changes go through the admin route above.

---

## modules/production/components/ProductionBoard.js

### 24. `orders.update` (status) — Lines 34, 42
```js
sb.from("orders").update({ status: nextStatus }).eq("id", order.id)
```
- **Table:** orders
- **Risk:** HIGH
- **Issue:** Status change with no server-side role validation. The Production Board is a standalone component that performs status advances (Production → QC, QC → Ready) via the anon key. An attacker with an authenticated session could call this directly.
- **Fix:** Migrate to `POST /api/orders/[id]/status`.

### 25. `order_notes.insert` (QC notes) — Line 44
```js
sb.from("order_notes").insert({ order_id: order.id, content, author_name: qcBy })
```
- **Table:** order_notes
- **Risk:** MEDIUM
- **Issue:** `author_name` is set from user input (`qcBy` field), not from the session. Any string can be injected.
- **Fix:** Migrate to `POST /api/orders/[id]/notes`. Server resolves `author_name` from session.

---

## modules/orders/components/OrderTracker.js

> OrderTracker.js is the legacy component (V7). It contains the most extensive set of direct client writes. These are flagged for full migration in V8. Key HIGH-risk items are called out; the remainder are MEDIUM.

### 26. `orders.insert` (new order) — Line 188
- **Table:** orders — **Risk:** HIGH — Same issues as new/page.js entry #1.

### 27. `orders.update` (status) — Lines 232, 244, 252, 258
- **Table:** orders — **Risk:** HIGH — Direct client-side status transitions without server-side role or sequence validation.

### 28. `order_deliveries.insert` / `.update` — Lines 50–51
- **Table:** order_deliveries — **Risk:** HIGH
- **Issue:** `admin_authorized`, `admin_auth_reason`, `payment_status_at_delivery` are client-controlled. An attacker could set `admin_authorized: true` without actually being an admin.
- **Fix:** Add `POST /api/orders/[id]/deliveries` with server-injected `admin_authorized`.

### 29. `order_payments.insert` / `.delete` — Lines 64–65
- **Table:** order_payments — **Risk:** HIGH — Same as form/page.js entries #8–9.

### 30. `order_documents` (storage upload + DB insert + delete) — Lines 77–78
- **Table:** order_documents, storage — **Risk:** MEDIUM — Path constructed client-side (no `orderId` scoping in storage path on line 77).

### 31. `order_items.delete` + `.insert` (save items) — Line 182
- **Table:** order_items — **Risk:** HIGH — `delete().eq('order_id', oid)` wipes all items; insert is a full replace. No per-row validation or scoping guard beyond the `order_id` filter.

---

## Priority Summary

| Priority | Count | Key items |
|----------|-------|-----------|
| HIGH     | 11    | status writes, credit_limit, current_exposure, payment delete, admin_authorized, repair order create |
| MEDIUM   | 13    | author_name injection, file_path injection, form spreads, cross-order item updates |
| LOW      | 4     | activity logs, quote number, contacts delete |

## Recommended Migration Order

1. **Status transitions** (entries 14, 24, 27) — highest blast radius; any authenticated user can skip the workflow.
2. **Financial fields** (entries 8, 9, 17, 22, 23, 28, 29) — direct revenue/credit impact.
3. **Repair order create** (entry 16) — creates unvalidated orders with privileged initial state.
4. **Field injection** (entries 5, 25, 11, 12, 13) — author spoofing, cross-order item operations.
5. **Contacts + admin profiles** (entries 19–21) — lower blast radius but still unguarded form spreads.
6. **Activity logs + quote number** (entries 3, 15, 18) — low priority, clean up as parent routes migrate.
