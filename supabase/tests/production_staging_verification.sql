-- Canvas Guy Production — staging verification queries
-- Superseded for combined acceptance by full_staging_acceptance.sql.
-- READ ONLY. Performs no INSERT, UPDATE or DELETE.

-- 1. Test order and plan.
SELECT c.name customer, o.id order_id, o.order_num, o.status order_status,
       pp.id plan_id, pp.status plan_status
FROM public.customers c
JOIN public.orders o ON o.customer_id = c.id
LEFT JOIN public.production_plans pp ON pp.order_id = o.id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
ORDER BY o.created_at DESC;

-- 2. Product jobs only. Delivery/charge jobs must not appear.
SELECT pj.job_num, pj.category, pj.description, pj.planned_quantity,
       pj.status, oi.line_type
FROM public.production_jobs pj
LEFT JOIN public.order_items oi ON oi.id = pj.order_item_id
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
ORDER BY pj.created_at;

-- 3. Stage state and rework quantities.
SELECT pj.job_num, pjs.sort_order, pjs.stage_key, pjs.is_enabled, pjs.status,
       pjs.planned_quantity, pjs.completed_quantity,
       pjs.rework_received_quantity, pjs.rework_completed_quantity
FROM public.production_job_stages pjs
JOIN public.production_jobs pj ON pj.id = pjs.job_id
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
ORDER BY pj.job_num, pjs.sort_order;

-- 4. Assignment limits per operation.
SELECT pj.job_num, po.code, po.name operation,
       SUM(pja.assigned_quantity) assigned_quantity, pj.planned_quantity,
       SUM(pja.assigned_quantity) <= pj.planned_quantity AS within_limit
FROM public.production_job_assignments pja
JOIN public.production_jobs pj ON pj.id = pja.job_id
JOIN public.production_operations po ON po.id = pja.operation_id
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
GROUP BY pj.job_num, po.code, po.name, po.sort_order, pj.planned_quantity
ORDER BY pj.job_num, po.sort_order;

-- 5. BoQ costing completeness.
SELECT pj.job_num, COUNT(pme.id) boq_lines,
       COUNT(*) FILTER (
         WHERE pme.estimated_unit_cost IS NOT NULL
           AND pme.cost_source_type IS NOT NULL
           AND (pme.cost_source_type <> 'supplier' OR pme.preferred_supplier_id IS NOT NULL)
       ) fully_costed_lines,
       ROUND(COALESCE(SUM(pme.estimated_total_cost), 0), 2) estimated_job_cost
FROM public.production_jobs pj
LEFT JOIN public.production_material_estimates pme ON pme.job_id = pj.id
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
GROUP BY pj.job_num
ORDER BY pj.job_num;

-- 6. Cached quantity-bucket invariant.
SELECT pj.job_num, pj.planned_quantity, pj.in_production_qty,
       pj.awaiting_qc_qty, pj.rework_qty, pj.accepted_qty, pj.scrapped_qty,
       pj.status,
       (pj.accepted_qty + pj.in_production_qty + pj.awaiting_qc_qty + pj.rework_qty)
         <= pj.planned_quantity AS active_ceiling_valid
FROM public.production_jobs pj
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
ORDER BY pj.job_num;

-- 7. Immutable stage-event history.
SELECT pj.job_num, pspe.created_at, pspe.event_type, pspe.quantity,
       pspe.from_stage_key, pspe.to_stage_key, po.name operation,
       e.name employee, pspe.notes
FROM public.production_stage_progress_entries pspe
JOIN public.production_jobs pj ON pj.id = pspe.job_id
LEFT JOIN public.production_operations po ON po.id = pspe.operation_id
LEFT JOIN public.employees e ON e.id = pspe.employee_id
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%'
ORDER BY pspe.created_at;

-- 8. Final acceptance reconciliation.
SELECT SUM(pj.planned_quantity) planned_units,
       SUM(pj.accepted_qty) accepted_units,
       COUNT(*) FILTER (WHERE pj.status <> 'Completed') incomplete_jobs
FROM public.production_jobs pj
JOIN public.orders o ON o.id = pj.order_id
JOIN public.customers c ON c.id = o.customer_id
WHERE c.name LIKE '[PROD-STAGE-TEST]%';
