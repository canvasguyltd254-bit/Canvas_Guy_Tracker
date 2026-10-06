# Production module: full audit (6 Oct 2026)

Scope: 45 API routes under `app/api/production`, the order costing route, 17 production migrations, the Production components (about 7,100 lines), the job page, and the shared libs.
Method: static review, route/role inventory, SQL convention scan, the pglite migration suite, `npm test`, and a UI code review. Not done: a real build (the sandbox cannot download the Linux SWC binary or reach the network) and any real-browser pass.

## Verified this session

| Check | Result |
|---|---|
| `npm test` | 302 pass, 0 fail |
| pglite run of v1 to v3a (59 checks) | 59 pass, 0 fail |
| Production routes with auth and try/catch | 45 of 45 |
| `npm run build` | Not run (sandbox limit). Must be run by you. |
| Real-browser testing | Not done |
| API route tests | None exist. Logic is tested only through the pure libs and through SQL. |

## A. Must fix before any staff see it

**A1. Material costs are readable through the API by floor staff (security).**
`GET /jobs/:id/materials`, `GET /plans/:id` and `GET /materials-summary` allow `production_staff` and `head_of_sales`. They return `estimated_unit_cost`, `estimated_total_cost`, `cost_source_type` and the supplier name. The job page hides costs in the UI, but that is not access control. Anyone with a login can read them from the network tab.
Fix: select columns by role. Staff get quantities, spec, readiness and notes only. Add a test per route for each role.

**A2. Day-cap race in time entries (fixed in this session).**
The 1.00-per-day cap per worker was checked per job. Two simultaneous entries on different jobs could both pass and exceed one day, so overtime or Sunday money could be paid twice. I added a per-worker-per-date advisory lock in `record_time_entry` (`production_v3a_labour_costing.sql`). pglite still passes. Rerun the migration on staging.

**A3. 87 uncommitted files, on the Next 15 upgrade branch.**
Scheduling, labour costing, order P&L, print, and the framework upgrade all sit in one working tree, with nothing committed. One bad command loses weeks of work, and the work can't be reviewed or reverted in parts. You chose a split by hunk. Do that first, before anything else is built.

**A4. Never built, never browser-tested.**
Run `npm run build` on your machine. Then walk the scenarios in your guideline section 1 as admin and as production manager. Most UI paths were tested only with jsdom harnesses I wrote, and the order costing route has not touched a real database.

## B. Correctness gaps

**B1. Actual labour uses the rate from plan time, not work time.**
`record_time_entry` uses the assignment's rate snapshot, taken when the team was first saved. A plan made on 1 Oct, with a raise on 15 Oct, prices work on 20 Oct at the old rate. The snapshot is also never refreshed.
Proper fix: an employee rate history table (effective-dated rates), with each time entry resolving the rate in force on its work date. Keep the assignment snapshot only for the planned figure.

**B2. Only materials and labour have real actuals.**
- Machine time: no actual source, so the estimate is used (labelled Provisional).
- Outsourced services: no actual source. Supplier purchases carry no category, so I can't tell which are outsourced.
- Delivery/installation: has an actual but no budget, so no variance.
So the "Actual" column is partly estimates. Call it that on screen until the sources exist.

**B3. Two profit numbers.**
The existing Profit Summary tab works on supplier purchases plus payroll allocations. The new Production costing tab works on issued materials plus approved attendance. They will disagree. Decide which is the official one, and relabel or retire the other.

**B4. Material actual is an editable latest value.**
`issued_quantity` and `actual_unit_cost` can be overwritten. There is no returns, waste or correction trail. This is your guideline item 7, and it is a precondition for trusting job margin.

**B5. Payroll reconciliation is not built.**
Unallocated labour and unallocated attendance are invisible. The attendance cap against payroll attendance and the pack's labour source depend on it. The internal print pack still takes labour from payroll allocations, not attendance.

**B6. Two capacity models.**
Conflict warnings still use hours per day (8 h/day), while costing uses attendance days. A planner can see "overloaded" on a day when the costing says 0.5 attendance. Pick one concept, preferably attendance days, and derive the other.

**B7. Employees have no link to a login.**
Start/complete actions are recorded under the logged-in user, not the worker. The worker-facing screen and accountability for actions cannot be built until `employees.user_id` exists.

## C. UI and flow (detail in the earlier review)

- 8 top-level tabs, three of which (Workshop, Record progress, Today's work) overlap. Target: 4 groups.
- Two progress paths: the legacy `RecordProgressModal` and the stage action modal. Two print paths: the header "Print assignments" and the Workshop chooser.
- Dead code: `ShopFloorTab` and `PeopleTab` (about 300 lines, never rendered), an unused `matTotal`.
- `ProductionBoard.js` is 5,619 lines in one file.
- 118 text sizes of 11px or less. Touch targets of 44px are enforced in only a few places, none on the Workshop screens.
- 8 `alert()` or `confirm()` calls remain. The Gantt has no aria labels and no keyboard alternative to its mouse actions. There are 9 `div` elements with `onClick` and no role.
- Vocabulary is inconsistent: stage, operation, step, team, assignment, attendance, time entry.
- Managers have no notification of waiting approvals except opening the Time tab.

## D. Housekeeping

- `production_labour_cost` is SECURITY DEFINER with no REVOKE or GRANT. It is a pure calculation, so risk is low, but make it match the module convention.
- v3a was rewritten in place. If the old hours-based version ever ran on any database, its guard stops the migration when time entries exist. Confirm which version staging has.
- pglite differs from Supabase (no row-level-security behaviour, stubbed `auth.users`). Run the diagnostics on staging itself.

## E. Do it in this order

1. Back up, then split the work into reviewable commits (A3). Keep the framework upgrade separate.
2. Fix A1 (role-based columns), with route tests.
3. Apply migrations to staging in order, rerun v3a for the A2 fix, run `npm run build`, and run the scenario list in a browser.
4. Decide B3 (which profit is official) and B6 (capacity concept).
5. Build the employee rate history (B1) and the material movement ledger (B4).
6. Build payroll reconciliation (B5), then switch the internal pack to attendance labour.
7. Clean up the UI (section C): remove dead code and legacy paths, restructure the tabs, add role-based defaults.
8. Link employees to logins (B7) and build the worker view.
9. Pilot with one real order and one manager, then the floor.

Items 1 to 3 are blockers for any rollout. Items 5 and 6 are needed before the margin figures can be trusted. Item 7 is what shortens staff learning time.
