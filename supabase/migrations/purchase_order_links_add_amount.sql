-- Migration: add amount column to purchase_order_links
--
-- Enables Option B split-cost job costing: each link between a supplier
-- purchase and a customer order carries its own allocated cost amount.
--
-- If amount IS NULL the link is informational only (legacy behaviour).
-- If amount IS SET it represents the portion of the purchase cost attributed
-- to that order — P&L and reports use this figure instead of the full
-- purchase total_amount.
--
-- Safe to run on a live database; the column is nullable so all
-- existing rows remain valid without a data migration.

ALTER TABLE public.purchase_order_links
  ADD COLUMN IF NOT EXISTS amount numeric(12,2);

-- Also add an UPDATE policy so privileged roles can edit the amount
-- on existing links (if RLS is enforced).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'purchase_order_links'
      AND policyname = 'pol_pol_update'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "pol_pol_update" ON public.purchase_order_links
        FOR UPDATE USING (
          EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id   = auth.uid()
              AND role IN ('admin', 'production_manager', 'head_of_sales')
          )
        );
    $p$;
  END IF;
END;
$$;
