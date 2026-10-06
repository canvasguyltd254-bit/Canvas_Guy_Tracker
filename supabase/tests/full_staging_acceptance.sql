-- Canvas Guy — combined Production + Cashflow staging acceptance
-- ONE FILE: creates only Cashflow planning/link records, then returns all
-- Production and Cashflow verification result sets.
--
-- REQUIRED: first create the tagged customer/order, production workflow,
-- supplier purchase and payroll/SHA scenario through the normal staging UI.
-- NEVER enable the guard in production.

BEGIN;

DO $$
DECLARE
  v_confirm_staging boolean := false; -- CHANGE TO true ONLY IN STAGING
  v_order_id uuid;
  v_outstanding numeric;
  v_schedule_id uuid;
  v_obligation_id uuid;
  v_obligation_schedule_id uuid;
  v_purchase_id uuid;
  v_estimate_id uuid;
  v_link_amount numeric;
BEGIN
  IF NOT v_confirm_staging THEN
    RAISE EXCEPTION 'STAGING GUARD: change v_confirm_staging to true only in the staging project';
  END IF;

  SELECT o.id,
         o.total_value - COALESCE(SUM(op.amount) FILTER (WHERE op.reversed_at IS NULL), 0)
  INTO v_order_id, v_outstanding
  FROM public.orders o
  JOIN public.customers c ON c.id = o.customer_id
  LEFT JOIN public.order_payments op ON op.order_id = o.id
  WHERE c.name LIKE '[PROD-STAGE-TEST]%'
  GROUP BY o.id, o.total_value, o.created_at
  ORDER BY o.created_at DESC
  LIMIT 1;

  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'No [PROD-STAGE-TEST] order found. Create it through the staging UI first.';
  END IF;
  IF v_outstanding <= 1000 THEN
    RAISE EXCEPTION 'Test order needs an outstanding customer balance greater than KES 1,000; current balance %', v_outstanding;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.production_plans WHERE order_id = v_order_id) THEN
    RAISE EXCEPTION 'Test order has no production plan. Complete Phase B first.';
  END IF;

  -- Refuse to overwrite a real schedule accidentally.
  SELECT id INTO v_schedule_id
  FROM public.cashflow_schedules
  WHERE order_id = v_order_id;

  IF v_schedule_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cashflow_schedules
    WHERE id = v_schedule_id AND notes = '[PROD-STAGE-TEST] Partial customer receipt'
  ) THEN
    RAISE EXCEPTION 'The test order already has a non-test Cashflow schedule; refusing to overwrite it.';
  END IF;

  IF v_schedule_id IS NULL THEN
    INSERT INTO public.cashflow_schedules (
      order_id, planned_date, planned_amount, priority,
      confidence_override, notes, last_reviewed_at
    ) VALUES (
      v_order_id, current_date + 7, v_outstanding,
      'important', 'likely', '[PROD-STAGE-TEST] Partial customer receipt', now()
    ) RETURNING id INTO v_schedule_id;
  END IF;

  INSERT INTO public.cashflow_schedule_installments
    (schedule_id, installment_number, planned_date, planned_amount, status, notes)
  VALUES
    (v_schedule_id, 1, current_date + 7,  ROUND(v_outstanding * 0.30, 2), 'planned', '[PROD-STAGE-TEST] Receipt part 1'),
    (v_schedule_id, 2, current_date + 21, ROUND(v_outstanding * 0.40, 2), 'planned', '[PROD-STAGE-TEST] Receipt part 2')
  ON CONFLICT (schedule_id, installment_number) DO UPDATE SET
    planned_date = EXCLUDED.planned_date,
    planned_amount = EXCLUDED.planned_amount,
    status = EXCLUDED.status,
    notes = EXCLUDED.notes,
    updated_at = now();

  -- One-off manual obligation and its two-part schedule.
  SELECT id INTO v_obligation_id
  FROM public.cashflow_manual_obligations
  WHERE name = '[PROD-STAGE-TEST] Workshop rent'
  ORDER BY created_at DESC LIMIT 1;

  IF v_obligation_id IS NULL THEN
    INSERT INTO public.cashflow_manual_obligations
      (name, payee, amount, is_statutory, recurrence, first_due_date, default_priority, notes)
    VALUES
      ('[PROD-STAGE-TEST] Workshop rent', '[PROD-STAGE-TEST] Landlord', 50000,
       false, 'once', current_date + 10, 'must_pay', '[PROD-STAGE-TEST] Two-part obligation')
    RETURNING id INTO v_obligation_id;
  END IF;

  SELECT id INTO v_obligation_schedule_id
  FROM public.cashflow_schedules
  WHERE obligation_id = v_obligation_id
    AND obligation_occurrence_date = current_date + 10;

  IF v_obligation_schedule_id IS NULL THEN
    INSERT INTO public.cashflow_schedules
      (obligation_id, obligation_occurrence_date, planned_date, planned_amount, priority, notes, last_reviewed_at)
    VALUES
      (v_obligation_id, current_date + 10, current_date + 10, 50000,
       'important', '[PROD-STAGE-TEST] Split workshop rent', now())
    RETURNING id INTO v_obligation_schedule_id;
  END IF;

  INSERT INTO public.cashflow_schedule_installments
    (schedule_id, installment_number, planned_date, planned_amount, status, notes)
  VALUES
    (v_obligation_schedule_id, 1, current_date + 10, 20000, 'planned', '[PROD-STAGE-TEST] Rent part 1'),
    (v_obligation_schedule_id, 2, current_date + 24, 30000, 'planned', '[PROD-STAGE-TEST] Rent part 2')
  ON CONFLICT (schedule_id, installment_number) DO UPDATE SET
    planned_date = EXCLUDED.planned_date,
    planned_amount = EXCLUDED.planned_amount,
    status = EXCLUDED.status,
    notes = EXCLUDED.notes,
    updated_at = now();

  -- Link a tagged purchase to one costed BoQ line. Never infer by name alone:
  -- both the purchase and order were explicitly created for this test.
  SELECT sp.id INTO v_purchase_id
  FROM public.supplier_purchases sp
  LEFT JOIN public.purchase_order_links pol ON pol.purchase_id = sp.id
  WHERE sp.notes = '[PROD-STAGE-TEST] BoQ-linked purchase'
    AND (pol.order_id = v_order_id OR NOT EXISTS (
      SELECT 1 FROM public.purchase_order_links x WHERE x.purchase_id = sp.id
    ))
  ORDER BY sp.created_at DESC LIMIT 1;

  SELECT pme.id INTO v_estimate_id
  FROM public.production_material_estimates pme
  JOIN public.production_jobs pj ON pj.id = pme.job_id
  WHERE pj.order_id = v_order_id
    AND pme.estimated_total_cost > 0
  ORDER BY pme.created_at LIMIT 1;

  IF v_purchase_id IS NULL THEN
    RAISE EXCEPTION 'No supplier purchase with notes [PROD-STAGE-TEST] BoQ-linked purchase found.';
  END IF;
  IF v_estimate_id IS NULL THEN
    RAISE EXCEPTION 'No costed BoQ estimate found for the test production jobs.';
  END IF;

  SELECT LEAST(1000, sp.total_amount, pme.estimated_total_cost)
  INTO v_link_amount
  FROM public.supplier_purchases sp
  CROSS JOIN public.production_material_estimates pme
  WHERE sp.id = v_purchase_id AND pme.id = v_estimate_id;

  IF v_link_amount <= 0 THEN
    RAISE EXCEPTION 'Cannot create positive BoQ link amount.';
  END IF;

  INSERT INTO public.purchase_boq_links
    (purchase_id, material_estimate_id, amount_fulfilled)
  VALUES (v_purchase_id, v_estimate_id, v_link_amount)
  ON CONFLICT (purchase_id, material_estimate_id) DO UPDATE SET
    amount_fulfilled = EXCLUDED.amount_fulfilled,
    updated_at = now();

  RAISE NOTICE 'Combined staging setup complete. Order %, outstanding %, receipt schedule %, obligation %, BoQ link %',
    v_order_id, v_outstanding, v_schedule_id, v_obligation_id, v_link_amount;
END $$;

COMMIT;

-- ── Combined verification result sets ───────────────────────────────────────

-- A. Plan and product-only jobs.
SELECT c.name customer, o.order_num, o.status order_status, pp.status plan_status,
       COUNT(pj.id) job_count,
       COUNT(pj.id) FILTER (WHERE COALESCE(oi.line_type, 'product') <> 'product') non_product_jobs
FROM public.customers c
JOIN public.orders o ON o.customer_id = c.id
JOIN public.production_plans pp ON pp.order_id = o.id
LEFT JOIN public.production_jobs pj ON pj.plan_id = pp.id
LEFT JOIN public.order_items oi ON oi.id = pj.order_item_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
GROUP BY c.name, o.order_num, o.status, pp.status, o.created_at
ORDER BY o.created_at DESC;

-- B. Stage progress and rework.
SELECT pj.job_num, pjs.sort_order, pjs.stage_key, pjs.is_enabled, pjs.status,
       pjs.planned_quantity, pjs.completed_quantity,
       pjs.rework_received_quantity, pjs.rework_completed_quantity
FROM public.production_job_stages pjs
JOIN public.production_jobs pj ON pj.id = pjs.job_id
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
ORDER BY pj.job_num, pjs.sort_order;

-- C. Final quantity invariant.
SELECT SUM(pj.planned_quantity) planned_units,
       SUM(pj.accepted_qty) accepted_units,
       COUNT(*) FILTER (WHERE pj.status <> 'Completed') incomplete_jobs,
       BOOL_AND((pj.accepted_qty + pj.in_production_qty + pj.awaiting_qc_qty + pj.rework_qty) <= pj.planned_quantity) active_ceilings_valid
FROM public.production_jobs pj
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%';

-- D. BoQ completeness and total cost.
SELECT pj.job_num, COUNT(pme.id) boq_lines,
       COUNT(*) FILTER (WHERE pme.estimated_unit_cost IS NOT NULL AND pme.cost_source_type IS NOT NULL
         AND (pme.cost_source_type <> 'supplier' OR pme.preferred_supplier_id IS NOT NULL)) fully_costed_lines,
       ROUND(COALESCE(SUM(pme.estimated_total_cost), 0), 2) estimated_job_cost
FROM public.production_jobs pj
LEFT JOIN public.production_material_estimates pme ON pme.job_id = pj.id
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
GROUP BY pj.job_num ORDER BY pj.job_num;

-- E. Customer receipt schedule: 70% planned, 30% unplanned.
SELECT o.order_num, s.id schedule_id,
       ROUND(o.total_value - COALESCE(SUM(op.amount) FILTER (WHERE op.reversed_at IS NULL), 0), 2) outstanding,
       ROUND(COALESCE((SELECT SUM(i.planned_amount) FROM public.cashflow_schedule_installments i WHERE i.schedule_id = s.id AND i.status = 'planned'), 0), 2) planned,
       ROUND((o.total_value - COALESCE(SUM(op.amount) FILTER (WHERE op.reversed_at IS NULL), 0))
         - COALESCE((SELECT SUM(i.planned_amount) FROM public.cashflow_schedule_installments i WHERE i.schedule_id = s.id AND i.status = 'planned'), 0), 2) unplanned
FROM public.orders o
JOIN public.customers c ON c.id = o.customer_id
JOIN public.cashflow_schedules s ON s.order_id = o.id
LEFT JOIN public.order_payments op ON op.order_id = o.id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
GROUP BY o.order_num, o.total_value, s.id;

-- F. Manual obligation must split exactly to KES 50,000.
SELECT mo.name, mo.amount,
       COUNT(i.id) FILTER (WHERE i.status = 'planned') installment_count,
       COALESCE(SUM(i.planned_amount) FILTER (WHERE i.status = 'planned'), 0) installment_total
FROM public.cashflow_manual_obligations mo
JOIN public.cashflow_schedules s ON s.obligation_id = mo.id
LEFT JOIN public.cashflow_schedule_installments i ON i.schedule_id = s.id
WHERE mo.name = '[PROD-STAGE-TEST] Workshop rent'
GROUP BY mo.name, mo.amount;

-- G. Explicit BoQ link and remaining commitment.
SELECT pj.job_num, pme.material_name, pme.estimated_total_cost gross_commitment,
       COALESCE(SUM(pbl.amount_fulfilled), 0) linked_amount,
       GREATEST(0, pme.estimated_total_cost - COALESCE(SUM(pbl.amount_fulfilled), 0)) remaining_commitment
FROM public.production_material_estimates pme
JOIN public.production_jobs pj ON pj.id = pme.job_id
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
LEFT JOIN public.purchase_boq_links pbl ON pbl.material_estimate_id = pme.id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
GROUP BY pj.job_num, pme.id, pme.material_name, pme.estimated_total_cost
HAVING COALESCE(SUM(pbl.amount_fulfilled), 0) > 0;

-- H. SHA rows that should make the forecast provisional.
SELECT pr.run_num, pr.period_end, pr.status, SUM(pe.sha_deduction) sha_amount
FROM public.payroll_runs pr
JOIN public.payroll_entries pe ON pe.run_id = pr.id
WHERE pr.status IN ('approved', 'closed')
GROUP BY pr.id
HAVING SUM(pe.sha_deduction) > 0
ORDER BY pr.period_end DESC;

-- ── Optional staging cleanup (leave commented until testing is signed off) ──
-- DELETE FROM public.cashflow_schedules
-- WHERE notes IN ('[PROD-STAGE-TEST] Partial customer receipt', '[PROD-STAGE-TEST] Split workshop rent');
-- DELETE FROM public.cashflow_manual_obligations
-- WHERE name = '[PROD-STAGE-TEST] Workshop rent';
-- DELETE FROM public.purchase_boq_links pbl
-- USING public.supplier_purchases sp
-- WHERE pbl.purchase_id = sp.id
--   AND sp.notes = '[PROD-STAGE-TEST] BoQ-linked purchase';

