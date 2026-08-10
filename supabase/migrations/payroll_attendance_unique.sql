-- ── Fix: payroll_attendance missing UNIQUE constraint ────────────────────────
-- Root cause of inflated OT (e.g. 400 KES appearing as 80,000 KES):
-- Without a DB-level UNIQUE constraint on (run_id, employee_id, work_date),
-- Supabase upsert falls back to INSERT, creating duplicate rows on every save.
-- The recompute then sums overtime_hours across all duplicates.

-- Step 1: Delete duplicates — keep the LATEST row per (run_id, employee_id, work_date)
DELETE FROM public.payroll_attendance
WHERE id NOT IN (
  SELECT DISTINCT ON (run_id, employee_id, work_date) id
  FROM public.payroll_attendance
  ORDER BY run_id, employee_id, work_date, created_at DESC, id DESC
);

-- Step 2: Add the UNIQUE constraint the CREATE TABLE should have had
ALTER TABLE public.payroll_attendance
  ADD CONSTRAINT payroll_attendance_run_emp_date_unique
  UNIQUE (run_id, employee_id, work_date);
