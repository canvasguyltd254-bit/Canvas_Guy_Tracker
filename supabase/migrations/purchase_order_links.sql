-- supabase/migrations/purchase_order_links.sql
--
-- Replaces the single order_id FK on supplier_purchases with a
-- many-to-many junction table, so one purchase can be linked to
-- multiple customer orders.
--
-- Run order:
--   1. Create junction table
--   2. Migrate existing data
--   3. Drop old column

-- ── 1. Junction table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS purchase_order_links (
  purchase_id uuid NOT NULL REFERENCES supplier_purchases(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES orders(id)             ON DELETE CASCADE,
  PRIMARY KEY (purchase_id, order_id)
);

ALTER TABLE purchase_order_links ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read
CREATE POLICY "pol_pol_select" ON purchase_order_links
  FOR SELECT USING (auth.role() = 'authenticated');

-- Only privileged roles can insert
CREATE POLICY "pol_pol_insert" ON purchase_order_links
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

-- Only privileged roles can delete (used by PATCH to replace links)
CREATE POLICY "pol_pol_delete" ON purchase_order_links
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE INDEX IF NOT EXISTS idx_pol_purchase ON purchase_order_links(purchase_id);
CREATE INDEX IF NOT EXISTS idx_pol_order    ON purchase_order_links(order_id);

-- ── 2. Migrate existing data ───────────────────────────────────────────────────

INSERT INTO purchase_order_links (purchase_id, order_id)
SELECT id, order_id
FROM supplier_purchases
WHERE order_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 3. Drop old column ─────────────────────────────────────────────────────────

ALTER TABLE supplier_purchases DROP COLUMN IF EXISTS order_id;
