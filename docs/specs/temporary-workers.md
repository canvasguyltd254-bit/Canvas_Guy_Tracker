# Temporary Workers — technical specification

Status: v2.1, approved subject to the three corrections below (now applied). Nothing in this document is built yet.
Prerequisites already done: payroll run-type guard (`5264fe7`), role-based payroll access (`87c221a`, `b2084c3`).
v2.1 adds: references required for advances and issued tools/materials, a terminal `cancelled` payout-sheet status, and complete status-consistency CHECKs. v2 incorporated the review amendments: fail-closed approval limit, mandatory payout evidence, paid-is-final, itemised operational deductions, and split-payment protection.

## 1. Purpose and decisions

Temporary workers are short-term, bulk-work labour paid in **cash** after a small number of approved working days. They must not enter the weekly payroll runs, and their labour must be costed exactly once.

| Decision | Value |
|---|---|
| Payment | Cash only |
| Statutory deductions | None. Statutory deduction types are blocked by a database constraint |
| Operational deductions | Allowed and fully itemised: `damage`, `cash_advance`, `tools_or_materials`, `other` |
| Who creates and approves | Head of sales and production manager (admin always) |
| Attendance approval | Admin and production manager only (unchanged). Head of sales cannot approve Production attendance |
| Settlement approval | Approver differs from the settlement preparer **and** from the recorder of every included attendance entry. Admin may override only with a mandatory reason, which is stored |
| Admin approval limit | KES 10,000 per settlement (on gross). **Fail-closed**: if the setting is missing or NULL, only an admin may approve |
| Who may mark paid | Admin, production manager or head of sales. The payer may be the approver but must **never** be the settlement preparer (no admin override) |
| Payout evidence | Mandatory: payout-sheet number, signed receipt attached to the sheet, receiver's full name, payer and timestamp, and a note for any payment above KES 10,000 |
| Paid settlements | **Final.** They can never be voided or edited; their lines stay active permanently |
| Payment trigger | 3.00 approved attendance units |
| Overtime / Sunday | Existing fixed rules: KES 200 overtime day, KES 1,000 Sunday (no overtime on a Sunday) |
| GL posting | None in release 1 (matches current payroll) |

Corrections after payment are out of scope for release 1. A future recovery/reversal record (a new document, never an edit of paid history) will handle them.

Statutory note: whether any statutory obligation applies to these workers was decided by management and was not confirmed with a payroll adviser. Separately, deductions from a worker's pay (especially for damage) are legally restricted in Kenya; confirm the damage-deduction rule with an adviser before that type is switched on in production (see §11).

## 2. Design principles

1. **One source of truth for actual labour: `production_time_entries`.** No second attendance table. Temporary workers are recorded, submitted and approved through the existing Production Time workflow.
2. **A settlement only decides what is payable and what has been paid.** It never creates labour cost; Order P&L keeps reading approved time entries.
3. **A temporary worker is an ordinary `employees` row** (normally `casual`) plus an engagement. There is no `temporary` employee type.
4. **Immutability.** Settlement lines are copies of immutable ledger facts. An entry in an active settlement cannot be voided; an entry in a *paid* settlement can never be freed.
5. **Paid is final.** Nothing in release 1 can reopen or void a paid settlement.
6. **All new tables are service-role only** (RLS on, REVOKE from anon/authenticated). The API decides who sees what.

## 3. What the existing ledger already gives us

From `production_v3a_labour_costing.sql` / `v3b`:

- Entries carry immutable rate snapshots and `actual_labour_cost`; facts cannot be edited, only voided and re-recorded.
- One worker's day across all jobs cannot exceed 1.00 (advisory lock per employee and date).
- A recorder cannot approve their own entry (admin may). Today only `admin` and `production_manager` may submit/approve entries; only `admin` may void.
- `production_labour_cost()` is the single cost formula.

Consequence: no change to `production_time_entries` is required. Settlement lines store `base_amount`, `overtime_amount` and `sunday_amount`, derived from the entry's own snapshots through one helper, with a CHECK that they sum to the entry's `actual_labour_cost`. A line that does not reconcile stops preparation and is reported.

## 4. Data model

### 4.1 `temporary_worker_settings` (single row)

| Column | Notes |
|---|---|
| `id boolean PK DEFAULT true` | single-row guard |
| `settlement_threshold_units numeric(5,2) DEFAULT 3.00` | trigger for "due" |
| `admin_approval_limit_kes numeric(12,2) DEFAULT 10000` | **NULL or missing row = only admin may approve** (fail-closed). Admin-editable |
| `rolling_window_days int DEFAULT 7` | for split-payment protection (§5.6) |
| `deduction_single_limit_kes numeric(12,2) DEFAULT 1000` | one deduction above this needs admin approval |
| `deduction_total_pct numeric(5,2) DEFAULT 25` | total deductions above this % of gross need admin approval |
| `updated_by`, `updated_at` | admin only |

### 4.2 `temporary_worker_engagements`

One agreement for one employee on one order.

| Column | Notes |
|---|---|
| `id`, `engagement_num` | `TE-YYYY-NNNN` from a sequence |
| `employee_id` → `employees` | must already exist (see §7 onboarding) |
| `order_id` → `orders` | project |
| `agreed_daily_rate numeric(10,2) CHECK > 0` | snapshot; later changes to the employee's rate never alter it |
| `start_date`, `expected_end_date` | used for the overlap guard |
| `max_days numeric(6,2) NULL` | optional ceiling; warning, not a hard block |
| `status` | `planned` / `active` / `completed` / `cancelled` |
| `version`, `supersedes_id` | a rate change closes this engagement and creates a new version |
| `notes`, `created_by`, `created_at`, `closed_by`, `closed_at`, `close_reason` | audit |

Constraints: at most one `active` engagement per (employee, order); dates ordered; completed/cancelled engagements immutable except notes.

### 4.3 Link to Production

`production_job_assignments.temporary_engagement_id uuid NULL`, set by `link_assignment_to_engagement()`, which:

- requires the assignment's order to equal the engagement's order and the employee to match;
- sets the assignment's `daily_rate_snapshot` to `agreed_daily_rate` **only if no live time entry exists** for that assignment;
- is refused once entries exist (a rate change needs a new engagement version and a new assignment).

### 4.4 `temporary_worker_settlements`

| Column | Notes |
|---|---|
| `id`, `settlement_num` | `TW-YYYY-NNNN` |
| `engagement_id`, `employee_id` | |
| `period_start`, `period_end`, `cutoff_date` | cutoff chosen at preparation |
| `units_included numeric(6,2)` | |
| `base_amount`, `overtime_amount`, `sunday_amount` | sums of line components |
| `gross_amount` | sum of line amounts |
| `deductions_total numeric(12,2) NOT NULL DEFAULT 0` | **maintained from active deduction rows only**; a trigger rejects any value that differs from their sum |
| `net_amount` | `CHECK (net_amount = gross_amount - deductions_total)` and `CHECK (deductions_total <= gross_amount)` |
| `kind` | `threshold` / `close_out` / `early` (early needs `reason`) |
| `status` | `draft` / `approved` / `paid` / `voided` |
| `prepared_by`, `prepared_at` | |
| `approved_by`, `approved_at`, `approved_by_role` | |
| `approval_override boolean`, `override_reason` | admin approving despite the separation rule; reason **mandatory** when `approval_override` |
| `payout_sheet_id` | set when added to a sheet; **NOT NULL when `status = 'paid'`** (CHECK) |
| `paid_by`, `paid_at` | payer; **`paid_by <> prepared_by`** (CHECK, no override) |
| `received_by_full_name` | required to pay; at least two name parts |
| `payment_note` | required when `gross_amount` or `net_amount` exceeds the limit |
| `voided_by`, `voided_at`, `void_reason` | only possible for `draft` and approved-unpaid; never for `paid` |

### 4.5 `temporary_worker_settlement_lines`

| Column | Notes |
|---|---|
| `settlement_id`, `time_entry_id` | |
| `work_date`, `job_id`, `stage_id` | copied for reporting |
| `attendance_units`, `base_amount`, `overtime_amount`, `sunday_amount`, `line_amount` | copied; CHECK components sum to `line_amount` |
| `active boolean` | false only when a **draft or approved-unpaid** settlement is voided. A trigger refuses to set it false, or to change/delete the row, once the settlement is `paid` |

`UNIQUE (time_entry_id) WHERE active` guarantees one day of work is never paid twice. Because paid lines can never become inactive, paid work can never be freed and paid again.

#### Status-consistency CHECKs (settlements)

Enforced by CHECK constraints, not only functions:

- `draft`: no approval, payment, sheet-payment or void fields set.
- `approved`: `approved_by`, `approved_at`, `approved_by_role` all set; no payment fields; no void fields.
- `paid`: approval fields set, `payout_sheet_id` set, `paid_by`, `paid_at`, `received_by_full_name` set, `paid_by <> prepared_by`; no void fields. The trigger additionally requires the sheet to be `signed`.
- `voided`: `voided_by`, `voided_at`, `void_reason` set; no payment fields (paid can never become voided).
- Any status other than `paid`: `paid_by`, `paid_at`, `received_by_full_name`, `payment_note` are all NULL.
- `approval_override` true requires `override_reason`; false requires it NULL.
- Status transitions allowed only: `draft→approved→paid`, `draft→voided`, `approved→voided`; trigger rejects everything else, including any move out of `paid` or `voided`.

Payout sheets: `printed` requires `printed_at`; `signed` requires `signed_receipt_path`, uploader and time; `cancelled` requires actor, time and reason and forbids a signed receipt; transitions `open→printed→signed`, any non-signed or signed-unpaid state `→cancelled`, nothing out of `cancelled`. A sheet with any paid settlement cannot be cancelled.

Engagements and deductions get the same treatment (closed/cancelled need actor, time and reason; voided deductions need actor, time and reason; `approved_by` set together with `approved_at`).

### 4.6 `temporary_worker_settlement_deductions`

Operational deductions only; empty until recorded.

| Column | Notes |
|---|---|
| `id`, `settlement_id` | |
| `deduction_type` | `CHECK IN ('damage','cash_advance','tools_or_materials','other')`. Statutory types (PAYE, NSSF, SHIF, housing levy …) are impossible |
| `amount numeric(12,2) CHECK > 0` | |
| `reason text NOT NULL` | mandatory for every deduction |
| `evidence_ref text`, `evidence_path text` | Required by type (CHECK): `damage` = evidence reference **or** attachment; `cash_advance` = advance voucher/reference (`evidence_ref` mandatory); `tools_or_materials` = issue-slip/reference (`evidence_ref` mandatory); `other` = detailed reason (at least 20 characters), attachment optional. References are trimmed and uppercased |
| `recorded_by`, `recorded_at` | |
| `approved_by`, `approved_at`, `approved_by_role` | `approved_by <> recorded_by` (CHECK) |
| `worker_acknowledged_at` | set when the signed payout sheet is attached (§5.4); the sheet lists every deduction |
| `active boolean DEFAULT true`, `voided_by`, `voided_at`, `void_reason` | only while the settlement is `draft` |

Rules:
- `deductions_total` = sum of `active` rows; total can never exceed `gross_amount`.
- Rows can be added, approved or voided only while the settlement is `draft`. After approval the figures are fixed; to change them an admin voids the unpaid settlement and it is prepared again.
- Once the settlement is `paid`, deduction rows are immutable (trigger).
- A deduction needs **admin approval** when a single deduction exceeds `deduction_single_limit_kes`, or total active deductions exceed `deduction_total_pct` of gross.

### 4.7 `temporary_worker_payout_sheets`

| Column | Notes |
|---|---|
| `id`, `sheet_num` | `PS-YYYY-NNNN` |
| `status` | `open` → `printed` → `signed`, with `cancelled` as a terminal alternative from any of them. A cancelled sheet is never reused, never marked signed and never receives settlements; its settlements return to approved-unpaid and can join a new sheet |
| `cancelled_by`, `cancelled_at`, `cancel_reason` | required when `cancelled` |
| `total_gross`, `total_deductions`, `total_net` | computed from member settlements |
| `admin_approved_by`, `admin_approved_at` | required when `total_net` exceeds the limit or the limit is missing |
| `printed_at` | |
| `signed_receipt_path`, `signed_receipt_uploaded_by`, `signed_receipt_uploaded_at` | scan/photo of the signed sheet |
| `created_by`, `created_at` | |

The sheet lists, per worker: gross, each deduction separately, and net cash received, with a signature column. A settlement can belong to one sheet only. An individual payment is a sheet containing one settlement.

### 4.8 Audit

Events go to the existing `payroll_activities` table with `entity_type` `temp_engagement` / `temp_settlement` / `temp_deduction` / `temp_sheet` (created, approved, paid, voided, override with reason).

## 5. Rules and functions

All `SECURITY DEFINER`, `search_path = public, pg_temp`, executable by `service_role` only.

### 5.1 Due calculation

Eligible entries: status `approved`, `actual_labour_cost` not null, belonging to an assignment linked to the engagement, not in an active settlement line.

A settlement is **due** when eligible units ≥ `settlement_threshold_units`, **or** the engagement is `completed`/`cancelled` and any eligible units remain (close-out). An early settlement below the threshold needs a reason.

### 5.2 `prepare_temporary_settlement(engagement, cutoff_date, kind, reason, actor)`

Atomic. Advisory locks on the engagement and the worker, row locks on eligible entries, then:

1. selects **every** eligible entry with `work_date <= cutoff_date`, oldest first. The caller cannot choose entries, so a disputed day cannot be skipped;
2. verifies threshold, close-out, or early-with-reason;
3. derives and reconciles components for each entry;
4. inserts the settlement and lines together;
5. logs the activity.

If total units are 3.50, all 3.50 are included and paid together. An entry is never split.

### 5.3 Deduction functions

`add_settlement_deduction(settlement, type, amount, reason, evidence_ref, evidence_path, actor)`, `approve_settlement_deduction(id, actor, actor_role)`, `void_settlement_deduction(id, reason, actor)`.

- all require the settlement to be `draft`;
- `add` rejects a total that would exceed gross, a missing reason, and a deduction lacking the reference its type requires (§4.6);
- `approve` requires a different person from the recorder, and admin when the §4.6 limits are crossed;
- every change recomputes `deductions_total` and `net_amount` inside the same transaction.

### 5.4 `approve_temporary_settlement(id, actor, actor_role)`

- Roles: `admin`, `production_manager`, `head_of_sales`.
- Approver must differ from `prepared_by` and from the `recorded_by` of every included entry. Admin may override, with a mandatory `override_reason`; the override is stored and logged.
- **Fail-closed limit:** if `admin_approval_limit_kes` is NULL/missing, or `gross_amount` exceeds it, only admin may approve.
- **Split-payment protection:** the same worker's gross in other approved or paid settlements within `rolling_window_days`, plus this one, is compared to the limit. Above it, only admin may approve. Several KES 9,000 settlements therefore cannot avoid review.
- Every active deduction must be approved, and any deduction that needed admin approval must carry `approved_by_role = 'admin'`.
- Re-checks that every line's entry is still approved and not voided.
- Release 1: statutory deductions cannot exist (type constraint), so approval never has to consider them.

### 5.5 Payout sheets and payment

- `create_payout_sheet(settlement_ids, actor)` creates a sheet for **exactly one** approved, unpaid settlement (Stage 1b; a partial unique index on `payout_sheet_id` also enforces it). If `total_net` exceeds the limit (or the limit is missing), the sheet needs `approve_payout_sheet(id, admin)`. *(Batch sheets were removed: see §15.)*
- `mark_sheet_printed(id)`; `attach_signed_receipt(id, path, actor)` sets the sheet `signed` and stamps `worker_acknowledged_at` on every deduction of its settlements.
- `pay_temporary_settlement(id, actor, received_by_full_name, payment_note)` requires:
  - settlement `approved`, on a sheet that is `signed` (and admin-approved if required);
  - `received_by_full_name` with at least two name parts;
  - `payment_note` when gross or net exceeds the limit;
  - payer `<> prepared_by`.
  It records payer and time. Method is always cash; no reference field.
- A typed name alone never marks a settlement paid: the signed sheet is mandatory.

### 5.6 `void_temporary_settlement(id, actor, reason)`

- `draft`: preparer, production manager, head of sales or admin.
- `approved` and unpaid: **admin only**, reason mandatory. Lines become inactive, freeing the entries. If the settlement is on a sheet, it leaves the sheet and the sheet total is recomputed (a signed sheet cannot lose a settlement; it is cancelled, which is terminal, and a new sheet is created). A settlement on a `signed` sheet that has been paid is never affected: paid is final.
- `paid`: **refused**, for everyone including admin.

### 5.7 Void guard on time entries

A `BEFORE UPDATE` trigger on `production_time_entries` refuses `status → 'voided'` while an active settlement line exists. The message names the settlement to void first. If that settlement is paid there is no way to void the entry. The ledger table and its existing guard are not modified.

### 5.8 Overlap with ordinary payroll (both directions)

- Creating or activating an engagement is refused if the employee is in a payroll run whose period overlaps the engagement dates.
- Adding the employee to a payroll run is refused (API check and DB trigger on `payroll_entries`, alongside the run-type guard) if an active engagement overlaps the run period.
- The Order P&L already suppresses payroll allocations for a worker with approved Production attendance on the order (matched by `employee_id`), so labour is not double-counted.

### 5.9 Engagement lifecycle

`planned → active → completed | cancelled`. Closing prompts a close-out settlement for any eligible units. Cancelling with unsettled approved units does the same.

## 6. Permissions

| Action | admin | production_manager | head_of_sales | production_staff |
|---|:-:|:-:|:-:|:-:|
| See engagements, rates, settlements | yes | yes | yes | no |
| Create / edit / close engagement | yes | yes | yes | no |
| Register a new worker (employee) | yes | no | no | no |
| Link assignment to engagement | yes | yes | no | no |
| Record / approve Production attendance | existing rules | existing rules | **no** | record only if allowed today |
| Prepare settlement | yes | yes | yes | no |
| Record a deduction | yes | yes | yes | no |
| Approve a deduction (within limits) | yes | yes* | yes* | no |
| Approve a deduction (above limits) | yes | no | no | no |
| Approve settlement (within limit, no fail-closed trigger) | yes | yes* | yes* | no |
| Approve settlement (above limit / setting missing / rolling total above limit) | yes | no | no | no |
| Create payout sheet | yes | yes | yes | no |
| Approve sheet above limit | yes | no | no | no |
| Mark paid | yes | yes** | yes** | no |
| Void draft settlement | yes | yes | yes | no |
| Void approved-unpaid settlement | yes | no | no | no |
| Void / edit a **paid** settlement or its deductions | **no one** | no | no | no |
| Change settings | yes | no | no | no |

\* different person from the preparer (and, for settlements, from every attendance recorder); a deduction approver differs from the deduction recorder. Admin may override the settlement separation rule only with a mandatory reason.
\** payer may be the approver, never the preparer.

Shop-floor users see that a temporary worker is assigned, but never rates, amounts, deductions or settlements.

## 7. UI

Payroll → **Temporary Workers** tab (admin, production manager, head of sales):

1. **Engagements** — active/planned/closed, worker, project, rate, approved units, amount due.
2. **Due for payment** — settlements ready to prepare.
3. **Settlements** — draft / approved / paid / voided; deductions panel (add, approve, void while draft); approve, void; paid rows read-only.
4. **Payout sheets** — build a sheet from approved settlements, print it, upload the signed copy, then mark each settlement paid. The pay button stays disabled until the signed sheet is attached.

**Onboarding:** an engagement needs an existing employee, and creating employees is admin-only. When the worker is not found, the picker shows: "Ask an administrator to register this worker." Production managers and head of sales are never left with a dead end.

Production assignment modal: "Temporary engagement" picker which calls `link_assignment_to_engagement`.

Attendance is recorded in the existing Production Time tab; there is no second attendance screen.

Signed-receipt upload uses the direct-to-storage signed-URL pattern already adopted for drawings (a photo of a signed sheet can exceed the 4.5 MB serverless body limit), into a private bucket, with signed URLs for viewing.

## 8. APIs

New routes under `/api/payroll/temporary/`: `engagements` (list, create, patch, close), `settlements` (list, prepare, approve, pay, void), `deductions` (add, approve, void), `due`, `payout-sheets` (create, approve, print, signed-receipt init/complete), `settings`. Each calls one database function; no multi-step logic in the API. Role gates use the shared access helpers, with explicit column lists (no `select('*')`).

The existing payroll employee and run routes are unchanged except for the overlap check on adding a worker to a run.

## 9. Build stages

| Stage | Contents | Done when |
|---|---|---|
| 1 | Migration: settings, engagements, settlements, lines, deductions, payout sheets, link column, void guard, overlap guards, paid-immutability triggers; functions in §5 | pglite tests pass; migration idempotent |
| 2 | API routes + shared access helper + route harness | harness proves role gates, column lists, 403s |
| 3 | Payroll Temporary Workers tab, assignment-modal link, onboarding message | UI compiles; manual walkthrough per role |
| 4 | Payout sheet print/PDF, signed-receipt upload, private bucket | sheet matches settlements; pay blocked until signed |
| 5 | Reports and cashflow obligations (approved-unpaid) | reconciles to ledger totals |

Stages 1–2 are the safety-critical part and are reviewed before UI work starts.

## 10. Test plan

Database (pglite, real migrations):

- **Paid is final:** a paid settlement cannot be voided by anyone including admin; its lines cannot be set inactive, edited or deleted; its entries cannot be voided; the same work cannot be included in a second settlement; deduction rows of a paid settlement cannot change.
- Voiding a draft or approved-unpaid settlement frees entries, and they can be settled once more.
- Threshold: 3.00 due, 2.99 not due; 3.50 included in full; close-out below threshold; early needs a reason.
- Cutoff includes every eligible entry oldest first, no skipping.
- Component reconciliation failure stops preparation.
- Approval: preparer ≠ approver; attendance recorder ≠ approver; admin override requires a reason and is logged; **limit missing/NULL → only admin**; limit exceeded → only admin; **rolling-window split payments → only admin**.
- Deductions: statutory types rejected; reason mandatory; damage needs evidence; total cannot exceed gross; `net = gross − deductions_total` always; recorder cannot approve; single > KES 1,000 or total > 25% needs admin; approval blocked while any active deduction is unapproved; editing after approval refused.
- Payout: pay refused without a sheet, without a signed receipt, without a full receiver name, with a missing note above the limit, and when payer = preparer; sheet total above the limit needs admin approval; a settlement cannot be on two sheets.
- Status consistency: every illegal status/field combination in §4.4 is rejected by CHECK (e.g. approved without approver, paid without sheet/receiver, non-paid with payment details, voided without reason); illegal transitions rejected.
- Payout sheets: cancelled is terminal, cannot be signed, cannot receive settlements; settlements on a cancelled sheet return to approved-unpaid and can join a new sheet; a sheet with a paid settlement cannot be cancelled.
- Deduction references: cash_advance without voucher, tools without issue slip, damage with neither reference nor attachment, `other` with a short reason are all rejected.
- Overlap guard both directions; engagement version change; link refused after entries exist.

Route harness: fixtures with rates, amounts and deductions; assert 403s per role, explicit columns, no money for production_staff.

Real Postgres, **two simultaneous connections** (cannot be proven in pglite): concurrent prepare for the same engagement, concurrent approve, concurrent void-entry versus prepare, concurrent pay of the same settlement. A script will be provided to run against a staging database.

## 11. Open items

1. **Damage deductions and Kenyan employment law.** Deductions from wages for damage are legally restricted. Confirm the rule with an adviser before the `damage` type is used in production. The type exists in the schema; it can be disabled in settings until confirmed.
2. ~~Reference for advances and tools~~ Decided: required (§4.6).
3. ~~Limit basis~~ Decided: settlement approval and the rolling check use gross (wage obligation); sheet approval and payment notes use net (cash leaving).
4. **Receipt strength.** A signed sheet photo proves a document exists, not that the worker received the cash. Witness name deferred; the mandatory signed sheet is sufficient for release 1.
5. **Payout sheet format.** Default: printable PDF through the existing report pipeline.

## 12. Differences from earlier proposals (and why)

- No new pay-component columns on `production_time_entries`; components are derived from immutable snapshots and reconciled to `actual_labour_cost` at preparation time, so the ledger table stays untouched.
- Deductions are a full table, not a single total. No statutory deductions exist; operational ones are allowed with an audit trail.
- No payment reference or uniqueness index; cash payments record payer, time, receiver, sheet and signed receipt instead.
- Paid settlements are final. The earlier draft allowed an admin void of a paid settlement; that would free the lines and allow double payment, so it was removed.
- No GL posting and no new employee type.

## 13. Stage 1 implementation notes (where the build refines this spec)

- **Files:** `supabase/migrations/temporary_workers_stage1.sql`; tests `supabase/tests/temporary_workers_stage1.pglite.mjs` (pglite, runs the real payroll and Production v3a/v3b migrations) and `supabase/tests/temporary_workers_concurrency.mjs` (real Postgres, two connections, scratch database only).
- **Cancelled sheets and the receipt path:** the `cancelled` CHECK forbids a stored receipt path, so cancelling a *signed* sheet clears `signed_receipt_path` on the row and writes the old path to the audit log (`cancelled_receipt_retained`). The storage object is not deleted. Stage 4 must not delete it either.
- **Damage deductions** originally defaulted to enabled. **Superseded by §15: the default is now off** until an adviser confirms (§11 item 1).
- **Engagement creation** takes an `activate` flag (planned or active). `revise_engagement_rate` closes the old version as `completed` with reason "Rate revised: …" and opens version n+1.
- **Rate on the settlement comes from the engagement.** `link_assignment_to_engagement` writes the agreed rate into the assignment snapshot, and the ledger costs from that snapshot. The employee's own `day_rate` is not used for temporary labour.
- **Component derivation:** overtime = `actual_labour_cost − round(units × daily_rate_snapshot, 2)` and must equal `units × overtime_rate_snapshot` within KES 0.01; Sunday amount = `actual_labour_cost` and must equal `units × sunday_rate_snapshot` within KES 0.01. Anything else stops preparation.
- **Lock order** (to avoid deadlocks): sheet before settlement in `pay`, `void`, `cancel`; engagement advisory lock then entry rows in `prepare`.
- **Database error prefixes for the API (Stage 2):** `TEMP_ENGAGEMENT_OVERLAP:` (payroll overlap, both directions). The existing payroll entries route must map this to a 422 like `RUN_TYPE_MISMATCH`.
- **Not in Stage 1:** API routes, UI (including the 20-character counter and validation message for `other` deductions), payout sheet PDF, storage bucket, reports, cashflow.

## 14. Stage 2–3 implementation notes (API and UI)

- **API:** `app/api/payroll/temporary/*` (engagements, settlements, deductions, payout-sheets, settings). Each route authenticates, allows only admin / production manager / head of sales, validates the request shape, then calls exactly one database function. The actor and role passed to the database always come from the session, never from the request body. Reads use explicit column lists (`shared/lib/payroll/temporaryAccess.js`); no route writes to a table directly. Database refusals are mapped to safe responses; constraint names and internals never reach the browser.
- **Payroll entries route:** the `TEMP_ENGAGEMENT_OVERLAP` trigger error now returns a clear 422 with its own code.
- **UI:** Payroll → **Temporary Workers** (admin, production manager, head of sales) with Engagements, Due for payment, Settlements, Payout sheets and (admin) Limits. Non-admins who cannot find a worker are told "Ask an administrator to register this worker." The "Other" deduction form shows a live character counter (n/20) and a specific validation message. Buttons are disabled with a reason where the user is the preparer, the amount is above the limit, or the sheet needs admin approval; the database remains the authority.
- **Printing (replaces the Stage 4 PDF):** the payout sheet prints from an HTML view in the browser (one row per worker: gross, each deduction with its reason and reference, cash received, signature). No PDF generator is involved. The signed copy is uploaded straight to the private `temporary-worker-receipts` bucket via a signed URL, created on first use.
- **Not built (by decision):** attaching a *file* to a deduction (the database supports `evidence_path`; the screen collects the reference only), witness name on the sheet, reports and cashflow obligations (Stage 5), and GL posting.
- **Tests:** `supabase/tests/temporary_workers_routes.harness.mjs` (71 checks) and `supabase/tests/temporary_workers_ui.harness.mjs` (41 checks, React 19 in jsdom, mutation-tested), plus unit tests in `shared/lib/__tests__/payrollTemporaryAccess.test.js`.

## 15. Stage 1b — corrective changes after external review

Migration `supabase/migrations/temporary_workers_stage1b.sql`, run after Stage 1. Stage 1 was already applied (no engagements existed), so it is corrected, not rewritten.

**Overlap race (P0).** One per-employee advisory lock (`tw_lock_employee`) is taken by: engagement creation, activation, rate revision, payroll-entry insert/move, payroll-run date change, and payroll-run approval. Payroll runs also take a run lock (shared for entry inserts, exclusive for date/approval changes). **Lock order everywhere: assignment row → run lock → employee locks (ascending employee id) → engagement row.** A run-date edit or approval locks every employee in the run in sorted order, so two such edits cannot deadlock. Overlap rule (`tw_engagement_overlap`): planned/active engagements protect their agreed span (open-ended while active); any engagement, including completed, cancelled or revised ones, protects the days with non-voided (draft/submitted/approved) attendance. A completed engagement therefore stops blocking payroll on days nothing was worked.

**Attendance.** A trigger on `production_time_entries` (INSERT only) refuses new attendance on an assignment linked to an engagement that is not active, or dated before its start. It also refuses a day that falls inside a payroll run the worker is already in. `expected_end_date` is a guide only. Existing entries can still be submitted, approved or rejected after closure and are settled by a close-out settlement. After a rate revision the old assignment refuses new days: link a new assignment to the new version.

**Revision.** The new version's expected end is carried over only if still in the future (otherwise open-ended), and the payroll overlap is re-checked under the lock.

**Planned cost.** Linking an assignment recomputes `planned_labour_cost` through Production's own `production_apply_labour_plan` from the new rate snapshot.

**One settlement per sheet.** The unique index plus a function check; the UI picks one settlement. This removes the half-paid batch sheet that could neither be cancelled nor voided. Batch sheets may return later only as all-or-nothing payment.

**API.** Detail routes use `maybeSingle()`; a database error goes through `dbError` (500/503), and only a genuine empty result is 404. A failing due-summary fails the request. The list uses one `temporary_engagements_due(ids[])` call. Dates use the app-wide strict `isIsoDate` (rejects 2026-02-30).

**Damage deductions** default to off. The existing settings row is switched off only if no damage deduction has ever been recorded.

**Tests.** pglite 225 checks; real-Postgres script 63 checks, including both directions of: create vs payroll insert, activate vs payroll insert, revise vs payroll insert, run-date edit vs create, run approval vs create, attendance vs payroll insert, attendance vs completion, and a deterministic proof of sorted lock order. Removing the employee lock from create, or from the run-date trigger, or reversing the lock order, each fails the tests.

**Known limits.** Two transactions that insert payroll entries for several employees in different orders in one statement could still deadlock; Postgres aborts one and the retry succeeds. Planned engagements already block overlapping payroll, so the activation race is defence in depth.

### 15.1 Stage 1c — review follow-ups

Migration `temporary_workers_stage1c.sql` (after stage1 and stage1b).

- **Cancelled engagements** are settleable. Approved days worked before a cancellation are still owed and are paid by a close-out settlement. The list API now asks for the due summary of every non-planned engagement, and the list row, the engagement modal and "Due for payment" all offer settlement for active, completed and cancelled engagements.
- **Maximum days** is a warning only. The due summaries return `total_units` (non-voided attendance: draft, submitted and approved; rejected and voided excluded; summed across the worker's rate versions on that project), `max_days` and `max_days_reached` (`total_units >= max_days`). It is the total, not the unsettled amount, so the warning stays after payment. The UI shows a "max days" badge and a banner in the engagement modal; nothing is blocked.
- The setup-incomplete message names stage1, stage1b and stage1c in order. The payout-sheet wording is singular.
- Tests: pglite 237, routes 93, UI 55, unit 500, real-Postgres 63.

### 15.2 Final UI audit (first-time users)

Findings fixed, all in `TemporaryWorkersTab.js`, `TemporarySettlements.js` and `payrollUi.js`:

- **No overview.** A "How temporary workers are paid (6 steps)" guide (a `<details>`, keyboard accessible) sits above the tabs, and each tab shows a one-sentence explanation of what it is.
- **Disabled buttons gave no reason.** "Create engagement" lists exactly what is still needed (worker, project, rate, start date), in the page and in the button tooltip.
- **Silent trap.** An active engagement with no linked Production assignment now warns that days will not appear or be paid until one is linked.
- **Browser pop-up.** Removing a deduction used `window.prompt`; it is now an inline reason form.
- **Dead ends.** Each settlement shows a plain "Next:" line for its status and role (check and approve, above the limit so an admin, you prepared it so someone else, create a payout sheet, and so on). An approved settlement has a "Create payout sheet" button that opens the new sheet, instead of a hunt through another tab.
- **Jargon and empty states.** "Units" became "Days". Empty lists now say what to do first.
- **Accessibility.** `Field` links each label to its control (`htmlFor`/`id`), marks required fields with `aria-required`, and attaches hints as descriptions; the worker and project search boxes have accessible names.

Not changed: small-button height (32 px) is below the 44 px touch guideline; this is a desktop admin screen, and the shared `Btn` is used elsewhere. Colour contrast was not measured. Layout was verified in a simulated DOM only, not in a real browser: please look at it once on Monday morning before the new users do.

Tests: UI harness 79 checks (was 55). Each guidance feature was removed in turn (pop-up, label wiring, guide) and the tests failed.

### 15.3 Stage 1d — assign from the engagement screen
Feedback from first use: an active engagement with no Production assignment was a dead end ("assign the worker in Production first").
`assign_engagement_worker(...)` (migration `temporary_workers_stage1d.sql`) adds ONE assignment for the engagement's worker on a chosen
job/stage/operation and links it in the same transaction (a refusal anywhere rolls the new assignment back).

- It deliberately does NOT call `assign_workers_to_stage()`: that function takes the whole group for an operation and marks every
  worker not listed as Removed, so a one-worker call would silently remove colleagues already on the stage.
- It respects the existing group: working-together groups need the same quantity; split groups must still add up to the job quantity.
- Same preconditions as linking: engagement active, job in the same project and not cancelled/completed, stage enabled, operation active
  for that stage, worker not already on that operation, dates not Sundays, hours 0–12. Admin and production manager only.
- API: `PATCH /engagements/:id { action: 'assign_worker', job_id, stage_id, operation_id, quantity, start, end, hours_per_day }`;
  `GET /engagements/:id/assignments` also returns `targets` (open jobs → enabled stages → active operations).
- UI: "Assign and link" form in the engagement modal (open by default when the worker has no assignment; preselects the only job /
  operation; dates never default to a Sunday). Projects with no production jobs still need the plan created in Production first.
- Tests: `temporary_workers_assign.pglite.mjs` (41), plus route and UI harness additions.
