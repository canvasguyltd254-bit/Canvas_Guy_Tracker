-- Migration: add 'Quality Control' to delivery_batches status check constraint
-- and change the column default from 'Planned' to 'Quality Control'.
--
-- Background: the API route sets status = 'Quality Control' on every new batch
-- (task #60), but the original schema CHECK constraint didn't include that value,
-- causing every batch creation to fail with a constraint violation.

-- 1. Drop the old constraint (PostgreSQL requires drop + re-add to modify a CHECK)
ALTER TABLE public.delivery_batches
  DROP CONSTRAINT IF EXISTS delivery_batches_status_check;

-- 2. Re-add with 'Quality Control' included
ALTER TABLE public.delivery_batches
  ADD CONSTRAINT delivery_batches_status_check
  CHECK (status IN (
    'Quality Control',
    'Planned', 'Picking', 'Loaded',
    'Out for Delivery', 'Delivered', 'Signed',
    'Cancelled', 'Rejected', 'Returned'
  ));

-- 3. Update the column default to match what the API now inserts
ALTER TABLE public.delivery_batches
  ALTER COLUMN status SET DEFAULT 'Quality Control';
