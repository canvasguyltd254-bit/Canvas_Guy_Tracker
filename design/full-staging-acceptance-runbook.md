# Canvas Guy — Combined Production + Cashflow Staging Acceptance Test

> **Staging only. Never run the setup SQL against production.**
>
> One shared marker: `[PROD-STAGE-TEST]`
>
> One SQL file: `supabase/tests/full_staging_acceptance.sql`

This combines the Production and Cashflow tests into one coherent business scenario. The same order, production jobs, BoQ costs, supplier purchase and customer balance feed both modules.

## Phase A — Create the shared business scenario through the UI

### Customer and order

Create customer `[PROD-STAGE-TEST] Workshop Client`, COD, with notes `[PROD-STAGE-TEST] Safe to archive after verification`.

Create one order containing:

1. Wall Decoration — Minimal Mirror, quantity 6, 120 × 100 cm, Matte Black, Pine, Product.
2. Custom Frame — Gallery Frame, quantity 4, 80 × 60 cm, Natural, Pine, Product.
3. Delivery Fee, quantity 1, Delivery.

Move it to Deposit Paid. Leave a positive customer balance so Cashflow has a receipt to forecast.

### Supplier purchase

Create one Part Paid or Unpaid supplier purchase:

- Notes: `[PROD-STAGE-TEST] BoQ-linked purchase`
- Link it to the test order where the Suppliers UI permits.
- Total must be greater than KES 1,000.
- Record supplier terms or an explicit due date.

### Payroll/SHA

Through Payroll, create and approve a staging run whose period end makes SHA due on the ninth of the following month. Ensure at least one entry has a positive SHA deduction. Do not fabricate a remittance payment—the purpose is to confirm the forecast flags payment status as untracked and provisional.

## Phase B — Run the Production workflow

1. Create the Draft production plan. Confirm exactly two jobs; Delivery Fee must be absent.
2. Keep all Mirror stages enabled. Disable Sanding on the Frame before progress starts.
3. Apply Wall Decoration and Custom Frame BoQ templates in Replace mode.
4. Cost every line. Supplier lines require the staging supplier; internal labour/machine time must remain In-house with no supplier.
5. Assign two workers across multiple operations without exceeding planned quantity per operation.
6. Activate the plan only after all checklist prerequisites pass.

Mirror flow:

1. Materials 6
2. Assembly 6
3. Sanding 6
4. Finishing 6
5. QC Accept 4
6. QC Rework 2 → Sanding (`Surface marks — staging rework test`)
7. Complete Sanding rework 2
8. Finishing 2
9. QC Accept 2
10. Packaging 6

Frame flow:

1. Materials 4
2. Assembly 4
3. Sanding remains Skipped
4. Finishing 4
5. QC Accept 4
6. Packaging 4

Complete the plan. Final Production expectation: 10 planned, 10 accepted, 0 incomplete jobs.

Also test one cut list, one preparation-sheet print, one linked drawing, Today's Work, individual/all-worker assignment sheets, and production_staff QC denial.

## Phase C — Run the single SQL file once

Open `supabase/tests/full_staging_acceptance.sql`.

1. Change `v_confirm_staging boolean := false` to `true`.
2. Run the entire file once in the staging SQL Editor.

The file:

- Finds the shared test order.
- Creates a partial customer-receipt schedule with two installments (70% planned, 30% visibly unplanned).
- Creates a one-off KES 50,000 manual obligation with two installments.
- Links KES 1,000 of the tagged supplier purchase to a costed BoQ line.
- Returns Production, costing, stage-history, Cashflow schedule and BoQ-link reconciliation result sets.
- Is idempotent for this marker; rerunning does not duplicate test records.

## Phase D — Verify the Cashflow UI

Refresh `/cashflow`.

Expected:

- Two receipt installments land in their own weeks.
- Only 70% of the customer balance enters expected collections; 30% remains unplanned.
- Manual obligation installments show KES 20,000 and KES 30,000 separately; the KES 50,000 header is not double-counted.
- The supplier purchase appears using its recorded/derived due-date provenance.
- The linked KES 1,000 reduces committed BoQ downside once, without suppressing the remainder.
- SHA appears as must-pay and triggers `sha_remittance_status_untracked`.
- Available Cash reads provisional (review required).
- Every week reconciles: Closing = Opening + Weighted In − Planned Out.

## Cleanup

Do not hard-delete Production history. Archive the plan/order/customer and remove test attachments through the UI.

The combined SQL includes a commented cleanup section for Cashflow-only test planning rows. Uncomment it only in staging after screenshots and reconciliation are complete. Remove the payroll test through Payroll's normal workflow rather than direct SQL deletion.
