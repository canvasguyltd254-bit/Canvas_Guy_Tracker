-- Migration: soft-delete for delivery_batches
-- Adds deleted_at + deleted_by columns so accidental deletes are recoverable.
-- GET queries must filter WHERE deleted_at IS NULL.
-- Hard deletes from the app are no longer possible — only admin can restore.

ALTER TABLE delivery_batches
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by  UUID REFERENCES auth.users(id);

-- Partial index: only non-deleted rows participate in uniqueness / normal lookups
CREATE INDEX IF NOT EXISTS idx_delivery_batches_active
  ON delivery_batches (order_id, batch_number)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN delivery_batches.deleted_at IS
  'NULL = active. Set to now() on soft-delete. Restore by setting back to NULL.';
COMMENT ON COLUMN delivery_batches.deleted_by IS
  'User who performed the soft-delete.';
