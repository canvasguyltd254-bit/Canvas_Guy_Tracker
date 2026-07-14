-- Migration: replace_purchase_order_links RPC
-- Replaces the non-atomic delete-then-insert pattern in the PATCH /api/purchases/:id
-- route with a single PostgreSQL function that runs both operations inside one implicit
-- transaction. If the INSERT fails, the DELETE is automatically rolled back.
--
-- Arguments:
--   p_purchase_id  uuid   — the purchase whose links are being replaced
--   p_links        jsonb  — array of {order_id: uuid, amount: number|null}
--                           empty array = clear all links

CREATE OR REPLACE FUNCTION public.replace_purchase_order_links(
  p_purchase_id uuid,
  p_links       jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  -- Step 1: remove all existing links for this purchase
  DELETE FROM public.purchase_order_links
  WHERE purchase_id = p_purchase_id;

  -- Step 2: insert the new set (empty array = clear only, no inserts)
  IF jsonb_array_length(p_links) > 0 THEN
    INSERT INTO public.purchase_order_links (purchase_id, order_id, amount)
    SELECT
      p_purchase_id,
      (link->>'order_id')::uuid,
      CASE
        WHEN (link->>'amount') IS NOT NULL AND (link->>'amount') <> ''
        THEN (link->>'amount')::numeric(12,2)
        ELSE NULL
      END
    FROM jsonb_array_elements(p_links) AS link;
  END IF;
END;
$$;
