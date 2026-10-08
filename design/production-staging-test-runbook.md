# Canvas Guy Production — Staging End-to-End Test

> **Superseded for combined acceptance:** use `full-staging-acceptance-runbook.md` when testing Production and Cashflow together.

> **Environment:** staging only. Do not create these records in production.
>
> **Test prefix:** `[PROD-STAGE-TEST]`

## Purpose

Exercise the complete Production workflow through the application and its RPCs:

- Product-only plan creation and charge exclusion
- BoQ templates, costing and supplier/in-house rules
- Stage configuration and multi-operation assignments
- Materials preparation, partial progress, QC, rework and packaging
- Dashboards, printable assignment sheets, cut lists and history

## Preconditions

Confirm staging contains an admin/production manager, two active employees, active operations, active Wall Decoration and Custom Frame BoQ templates, and one staging supplier.

Record the test manager, workers, supplier, order number, plan ID and both job numbers.

## 1. Create dummy commercial data through the UI

Customer: `[PROD-STAGE-TEST] Workshop Client`, credit terms COD, notes `[PROD-STAGE-TEST] Safe to archive after verification`.

Create an order with:

1. **Wall Decoration — Minimal Mirror**, quantity 6, 120 × 100 cm, Custom Color / Matte Black, Pine, line type Product.
2. **Custom Frame — Gallery Frame**, quantity 4, 80 × 60 cm, Clear / Natural, Pine, line type Product.
3. **Delivery Fee**, quantity 1, line type Delivery.

Move the order to **Deposit Paid**.

Expected: the order is eligible for Production; Delivery remains commercial only.

## 2. Create the plan

Open Production → Production plans → New production plan. Select the test order and create the Draft.

Expected: exactly 2 jobs, no Delivery Fee job, five stage rows per job, and the six-step readiness checklist.

## 3. Configure stages

- Mirror: keep all stages enabled.
- Frame: disable Sanding before any quantity movement.

Expected: Frame Sanding is Skipped; Assembly, Finishing and Packaging cannot be disabled; configuration locks once movement starts.

## 4. Apply and cost BoQs

- Mirror: apply Wall Decoration template in Replace mode.
- Frame: apply Custom Frame template in Replace mode.
- External materials: source Supplier, select the staging supplier, enter unit costs.
- Machine time/internal labour: source In-house, no supplier.
- Cost packaging lines and add one positive adjustment to a material line.

Expected: both jobs Fully costed; source constraints enforced; job/order totals recalculate; checklist advances.

## 5. Assign the team

Mirror:

- Worker A: Cutting 6; Sanding 6
- Worker B: Assembly 6; Finishing 6; Packaging 6

Frame:

- Worker A: Cutting 4; Assembly 4
- Worker B: Finishing 4; Packaging 4

Expected: multiple operations per employee; per-operation totals cannot exceed planned quantity; Today's Work and both print modes show specifications and Production due dates.

## 6. Activate

Activate only after stages, BoQ, costing and assignments are complete.

Expected: Activate remains disabled until ready; both products appear in Orders in Progress.

## 7. Mirror — full flow with rework

1. Confirm Materials Prepared: 6
2. Advance Assembly: 6 with a valid Assembly/Cutting operation and worker
3. Advance Sanding: 6
4. Advance Finishing: 6
5. QC Accept: 4
6. QC Send to Rework: 2 → Sanding; note `Surface marks — staging rework test`
7. Complete Sanding rework: 2
8. Advance Finishing again: 2
9. QC Accept: 2
10. Advance Packaging: 6

Expected: Awaiting QC becomes 6; partial accept leaves 2; rework records its stage without changing original planned quantity; final Accepted is 6; Packaging completes the job; history contains every event.

## 8. Frame — skipped-stage flow

1. Confirm Materials Prepared: 4
2. Advance Assembly: 4
3. Confirm Sanding stays Skipped
4. Advance Finishing: 4
5. QC Accept: 4
6. Advance Packaging: 4

Expected: no Sanding action is offered; Packaging completes the job.

## 9. Complete the plan

Complete the plan after both jobs complete.

Expected: completion is blocked while any non-cancelled job is incomplete; final totals are 10 planned / 10 accepted; Delivery Fee never appears in Production; plan remains available historically.

## 10. Cut list and documents

For one job, load/create a cut-list template, print the Materials Preparation Sheet, link one staging drawing, verify it appears, then unlink it.

Expected: cut-list replacement is atomic; printed sheet contains product specifications and quantities; same-order drawing rules are enforced.

## 11. Permission checks

As `production_staff`, record permitted stage work, then attempt QC Accept, Rework and Scrap.

Expected: permitted work succeeds; QC decisions return 403; manager/admin succeeds; direct API calls cannot bypass SQL role guards.

## 12. Cleanup

Do not hard-delete production history. Archive the completed plan and clearly retain/archive the test order and customer with the prefix. Remove test attachments through the UI. Keep the immutable event ledger for audit checks.

Run `supabase/tests/production_staging_verification.sql` before, during and after the workflow.
