/**
 * shared/lib/cashflow/projectCashflow.js
 *
 * The Stage 2 forecast engine's single entry point. Takes one pre-built
 * CashflowSnapshot (see types.js) and returns one complete CashflowProjection
 * — no Supabase imports, no I/O, no stored state. Everything else in this
 * directory (isoWeeks, classifyWeek, confidence, resolveDueDate) is a pure
 * helper this file composes; nothing here re-derives what those files
 * already decide.
 *
 * ── Judgment calls made in this file, flagged for review ───────────────────
 * The spec's outflow-planning rules, warning categories, and the corrected
 * downside-chaining formula were all given precisely. The items below are
 * mechanical decisions the spec described at a level this file had to turn
 * into exact code, and are the ones most worth checking:
 *
 * 1. Cash pools: `is_enabled === false` excludes a pool's balance from
 *    opening_cash (an explicit, deliberate setting), but the pool still
 *    appears in the output `cash_pools[]` list, flagged with the
 *    provisional_reasons entry 'disabled_excluded_from_total' — so a
 *    disabled account is never silently invisible, only silently summed.
 *    A pool's own data-quality problems (stale reconciliation, unresolved
 *    posting errors) mark it `is_provisional` but do NOT exclude an
 *    *enabled* pool's balance from the total — provisional means "shown,
 *    with a caveat," never "silently dropped."
 *
 * 2. Two distinct staleness settings exist
 *    (`override_stale_after_days`, `schedule_review_stale_after_days`) but
 *    only one named warning category exists for either
 *    ("stale schedule overrides"). This file uses
 *    `override_stale_after_days` for that one category (a schedule's
 *    confidence_override is "stale" when last_reviewed_at is null or older
 *    than this many days) since its name is the literal, unambiguous match.
 *    `schedule_review_stale_after_days` is accepted on the settings object
 *    but intentionally left unused — there is no warning category in the
 *    given spec that names general (non-override) schedule review
 *    staleness, and inventing a second warning mechanism for it would be
 *    fabricating a rule the spec never stated.
 *
 * 3. "Uncategorised budget-related spend" is one of the ten named warning
 *    categories, but CashflowSnapshot (as given, verbatim, complete) carries
 *    no budget data at all — no `budgets` array anywhere in the snapshot
 *    contract. This category cannot be produced from this snapshot and is
 *    deliberately NOT implemented; a `code: 'uncategorised_budget_spend'`
 *    warning is never emitted. The other nine categories are all implemented.
 *
 * 4. Regular payroll (PayrollObligationSnapshot) defaults to 'must_pay' but
 *    a schedule CAN override that default if one is attached — unlike true
 *    statutory obligations (payroll_sha, and any manual obligation with
 *    is_statutory === true), where 'must_pay' is a hard floor a schedule can
 *    never downgrade ("a malformed schedule must not downgrade it" — stated
 *    for statutory items specifically). Payroll has no `is_statutory` flag
 *    of its own in the snapshot, so it is treated as a strong default, not
 *    an unoverridable one.
 *
 * 5. Regular payroll has no explicit due-date field in its snapshot
 *    (`PayrollObligationSnapshot` has `period_end`, not `due_date`) — this
 *    file uses `period_end` as the natural fallback date when no schedule
 *    or installments exist for a payroll run.
 *
 * 6. When a source has installments that only partially cover its
 *    outstanding balance, the uncovered gap is surfaced as its own visible
 *    outflow item (`planned_amount: 0`, `unplanned_amount: <gap>`), anchored
 *    on the source's own fallback date (due-date resolution for supplier
 *    purchases, period_end/due_date for payroll, the occurrence date for
 *    manual obligations) rather than any one installment's date — the gap
 *    has no installment date of its own to inherit.
 *
 * 7. Warnings for categories that could otherwise fire once per affected row
 *    (assumed supplier dates, unplanned obligation balances) are emitted as
 *    ONE aggregate warning per category with a `metadata.count` and
 *    `metadata.ids` list, rather than one warning per row — bounding the
 *    warnings list instead of flooding it when dozens of rows qualify.
 */

import { isValidIsoDate, diffInDays, addDaysToIsoDate, compareIsoDates } from '../isoDate.js';
import { buildIsoWeeks, bucketDateIntoWeek, generateObligationOccurrences } from './isoWeeks.js';
import { classifyWeek } from './classifyWeek.js';
import { calculateCustomerPaymentHistory, deriveReceiptConfidence, confidenceWeight } from './confidence.js';
import { resolveSupplierPurchaseDueDate, resolveCustomerReceiptDate } from './resolveDueDate.js';

// ── small shared helpers ────────────────────────────────────────────────────

function isStale(lastDoneAt, asOf, staleAfterDays) {
  if (lastDoneAt == null) return true;
  if (!isValidIsoDate(lastDoneAt)) return true; // malformed timestamp is treated as unknown -> stale, never silently "fine"
  return diffInDays(lastDoneAt, asOf) > staleAfterDays;
}

function daysOverdueAgainst(date, asOf) {
  return diffInDays(date, asOf) < 0 ? diffInDays(date, asOf) * -1 : 0;
}

/**
 * Builds the outflow item(s) for one obligation source, following the
 * spec's fixed tier order: installments (when any are active) > a schedule
 * with no installments > neither.
 */
function buildOutflowItemsForSource({
  sourceType, sourceId, label, payee,
  schedule, installments, outstandingAmount,
  fallbackDate, fallbackPriority, forceMustPay,
}) {
  const items = [];
  const activeInstallments = (installments || []).filter((i) => i.status === 'planned');

  const resolvePriority = (schedulePriority) => {
    const p = forceMustPay ? 'must_pay' : (schedulePriority ?? fallbackPriority);
    return p;
  };

  if (activeInstallments.length > 0) {
    let plannedSum = 0;
    for (const inst of activeInstallments) {
      if (!isValidIsoDate(inst.planned_date)) {
        throw new RangeError(`buildOutflowItemsForSource: installment ${inst.id} on ${sourceType} ${sourceId} has an invalid planned_date`);
      }
      plannedSum += inst.planned_amount;
      const priority = resolvePriority(schedule?.priority);
      if (priority === 'on_hold' && !schedule?.hold_reason) {
        throw new RangeError(`buildOutflowItemsForSource: ${sourceType} ${sourceId}'s schedule is on_hold with no hold_reason`);
      }
      items.push({
        source_type: sourceType,
        source_id: sourceId,
        label,
        payee: payee ?? null,
        planned_date: inst.planned_date,
        planned_amount: inst.planned_amount,
        outstanding_amount: inst.planned_amount,
        unplanned_amount: 0,
        priority,
        is_held: priority === 'on_hold',
        hold_reason: schedule?.hold_reason ?? null,
        date_resolution: null,
        schedule_id: schedule?.id ?? null,
        installment_id: inst.id,
      });
    }
    const gap = Math.max(0, outstandingAmount - plannedSum);
    if (gap > 0) {
      const priority = resolvePriority(schedule?.priority);
      items.push({
        source_type: sourceType,
        source_id: sourceId,
        label: `${label} — unplanned balance`,
        payee: payee ?? null,
        planned_date: fallbackDate.date,
        planned_amount: 0,
        outstanding_amount: gap,
        unplanned_amount: gap,
        priority,
        is_held: priority === 'on_hold',
        hold_reason: schedule?.hold_reason ?? null,
        date_resolution: null,
        schedule_id: schedule?.id ?? null,
        installment_id: null,
      });
    }
    return items;
  }

  if (schedule) {
    if (!isValidIsoDate(schedule.planned_date)) {
      throw new RangeError(`buildOutflowItemsForSource: ${sourceType} ${sourceId}'s schedule has an invalid planned_date`);
    }
    const plannedAmount = schedule.planned_amount ?? outstandingAmount;
    const unplanned = Math.max(0, outstandingAmount - plannedAmount);
    const priority = resolvePriority(schedule.priority);
    if (priority === 'on_hold' && !schedule.hold_reason) {
      throw new RangeError(`buildOutflowItemsForSource: ${sourceType} ${sourceId}'s schedule is on_hold with no hold_reason`);
    }
    items.push({
      source_type: sourceType,
      source_id: sourceId,
      label,
      payee: payee ?? null,
      planned_date: schedule.planned_date,
      planned_amount: plannedAmount,
      outstanding_amount: outstandingAmount,
      unplanned_amount: unplanned,
      priority,
      is_held: priority === 'on_hold',
      hold_reason: schedule.hold_reason ?? null,
      date_resolution: null,
      schedule_id: schedule.id,
      installment_id: null,
    });
    return items;
  }

  // Neither installments nor a schedule: full outstanding, derived date.
  items.push({
    source_type: sourceType,
    source_id: sourceId,
    label,
    payee: payee ?? null,
    planned_date: fallbackDate.date,
    planned_amount: outstandingAmount,
    outstanding_amount: outstandingAmount,
    unplanned_amount: 0,
    priority: resolvePriority(null),
    is_held: false,
    hold_reason: null,
    date_resolution: fallbackDate.resolution ?? null,
    schedule_id: null,
    installment_id: null,
  });
  return items;
}

function supplierPurchasePriority(dateStr, asOf) {
  const diff = diffInDays(asOf, dateStr); // positive = in the future
  if (diff < 0) return 'important';        // overdue
  if (diff <= 7) return 'important';       // due within 7 days
  return 'can_wait';                       // due later
}

/**
 * @param {import('./types.js').CashflowSnapshot} snapshot
 * @returns {import('./types.js').CashflowProjection}
 */
export function projectCashflow(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new RangeError('projectCashflow: snapshot is required');
  }
  const { as_of, settings, ledger_health, cash_pools, receipts, customer_histories,
    supplier_purchases, payroll_obligations, payroll_statutory_obligations,
    manual_obligations, committed_boq, draft_boq_pipeline, receipt_methods } = snapshot;

  if (!isValidIsoDate(as_of)) {
    throw new RangeError(`projectCashflow: invalid as_of "${as_of}"`);
  }
  if (!settings || !Number.isInteger(settings.horizon_weeks) || settings.horizon_weeks < 1) {
    throw new RangeError('projectCashflow: settings.horizon_weeks must be a positive integer');
  }
  if (typeof settings.cash_reserve_threshold !== 'number' || !Number.isFinite(settings.cash_reserve_threshold)) {
    throw new RangeError('projectCashflow: settings.cash_reserve_threshold must be a finite number');
  }

  const weeks = buildIsoWeeks(as_of, settings.horizon_weeks);
  const warnings = [];

  // ── cash pools & opening cash ──────────────────────────────────────────
  const projectedCashPools = [];
  let openingCash = 0;
  const provisionalAccountIds = [];

  for (const pool of (cash_pools || [])) {
    const reasons = [];
    if (pool.unresolved_posting_errors > 0) reasons.push('unresolved_posting_errors');
    if (isStale(pool.last_reconciled_at, as_of, settings.reconciliation_stale_after_days)) {
      reasons.push('stale_reconciliation');
    }
    if (pool.is_enabled === false) {
      reasons.push('disabled_excluded_from_total');
    } else {
      openingCash += pool.balance;
      if (reasons.length > 0) provisionalAccountIds.push(pool.account_id);
    }
    projectedCashPools.push({
      account_id: pool.account_id,
      account_code: pool.account_code,
      name: pool.name,
      balance: pool.balance,
      is_provisional: reasons.length > 0,
      provisional_reasons: reasons,
    });
  }

  if (provisionalAccountIds.length > 0) {
    warnings.push({
      code: 'provisional_opening_cash',
      severity: 'warning',
      message: `Opening cash includes ${provisionalAccountIds.length} account(s) with unresolved posting errors or stale reconciliation.`,
      week_start: null,
      source_type: null,
      source_id: null,
      metadata: { account_ids: provisionalAccountIds },
    });
  }

  const hasUntrackedSha = (payroll_statutory_obligations || []).length > 0;
  const ledgerIsProvisional = (ledger_health?.unposted_count ?? 0) > 0
    || (ledger_health?.unresolved_error_count ?? 0) > 0
    || hasUntrackedSha;
  const projectedLedgerHealth = {
    unposted_count: ledger_health?.unposted_count ?? 0,
    oldest_unposted_days: ledger_health?.oldest_unposted_days ?? null,
    unresolved_error_count: ledger_health?.unresolved_error_count ?? 0,
    is_provisional: ledgerIsProvisional,
  };
  if ((ledger_health?.unresolved_error_count ?? 0) > 0) {
    warnings.push({
      code: 'unresolved_posting_errors',
      severity: 'critical',
      message: `${ledger_health.unresolved_error_count} unresolved posting error(s) affect ledger reliability.`,
      week_start: null,
      source_type: null,
      source_id: null,
      metadata: null,
    });
  }
  if (hasUntrackedSha) {
    warnings.push({
      code: 'sha_remittance_status_untracked',
      severity: 'warning',
      message: `${payroll_statutory_obligations.length} SHA obligation(s) are included as outstanding because remittance payments are not tracked yet.`,
      week_start: null,
      source_type: 'payroll_sha',
      source_id: null,
      metadata: { count: payroll_statutory_obligations.length },
    });
  }

  // ── per-week accumulators ──────────────────────────────────────────────
  const weekAccumulators = weeks.map((w) => ({
    index: w.index,
    week_start: w.week_start,
    week_end: w.week_end,
    money_in: { gross: 0, weighted: 0, unplanned: 0, items: [] },
    money_out: { must_pay: 0, important: 0, can_wait: 0, total_planned: 0, held: 0, unplanned: 0, items: [] },
    committed_boq: { gross: 0, linked: 0, net: 0, items: [] },
  }));

  const staleOverrideIds = [];
  const assumedSupplierPurchaseIds = [];
  const unplannedBalanceSourceIds = [];

  // ── receipts (money in) ────────────────────────────────────────────────
  for (const receipt of (receipts || [])) {
    const customerHistoryRaw = customer_histories?.[receipt.customer_id];
    const historySummary = calculateCustomerPaymentHistory(customerHistoryRaw?.settled_orders ?? []);
    const resolved = resolveCustomerReceiptDate(receipt, historySummary);
    const confidenceResult = deriveReceiptConfidence(receipt, historySummary, receipt.schedule, as_of);
    const weight = confidenceWeight(confidenceResult.confidence);

    if (receipt.schedule?.confidence_override != null
      && isStale(receipt.schedule.last_reviewed_at, as_of, settings.override_stale_after_days)) {
      staleOverrideIds.push(receipt.schedule.id);
    }

    const activeInstallments = (receipt.installments || []).filter((i) => i.status === 'planned');
    const plannedParts = [];
    if (activeInstallments.length > 0) {
      const plannedTotal = activeInstallments.reduce((sum, i) => sum + Number(i.planned_amount), 0);
      if (plannedTotal > receipt.outstanding_amount + 0.01) {
        throw new RangeError(`projectCashflow: receipt installments exceed outstanding amount for order ${receipt.order_id}`);
      }
      for (const inst of activeInstallments) {
        plannedParts.push({
          amount: Number(inst.planned_amount), date: inst.planned_date,
          installment_id: inst.id, schedule_id: receipt.schedule?.id ?? null,
          is_unplanned: false, date_resolution: null,
        });
      }
      const gap = Math.max(0, receipt.outstanding_amount - plannedTotal);
      if (gap > 0.01) plannedParts.push({ amount: gap, date: resolved.date, installment_id: null, schedule_id: receipt.schedule?.id ?? null, is_unplanned: true, date_resolution: resolved });
    } else if (receipt.schedule) {
      const amount = receipt.schedule.planned_amount ?? receipt.outstanding_amount;
      if (amount > receipt.outstanding_amount + 0.01) {
        throw new RangeError(`projectCashflow: receipt schedule exceeds outstanding amount for order ${receipt.order_id}`);
      }
      plannedParts.push({ amount, date: receipt.schedule.planned_date, installment_id: null, schedule_id: receipt.schedule.id, is_unplanned: false, date_resolution: resolved });
      const gap = Math.max(0, receipt.outstanding_amount - amount);
      if (gap > 0.01) plannedParts.push({ amount: gap, date: resolved.date, installment_id: null, schedule_id: receipt.schedule.id, is_unplanned: true, date_resolution: resolved });
    } else {
      plannedParts.push({ amount: receipt.outstanding_amount, date: resolved.date, installment_id: null, schedule_id: null, is_unplanned: false, date_resolution: resolved });
    }

    for (const part of plannedParts) {
      if (!isValidIsoDate(part.date)) throw new RangeError(`projectCashflow: receipt plan for order ${receipt.order_id} has an invalid date`);
      const bucket = bucketDateIntoWeek(part.date, weeks);
      if (bucket == null) continue;
      const weightedAmount = part.is_unplanned ? 0 : part.amount * weight;
      const item = {
        order_id: receipt.order_id, order_num: receipt.order_num,
        customer_id: receipt.customer_id, customer_name: receipt.customer_name,
        outstanding_amount: part.amount, weighted_amount: weightedAmount,
        expected_date: part.date, date_resolution: part.date_resolution,
        confidence: confidenceResult.confidence, confidence_weight: weight,
        confidence_reason: {
          source: confidenceResult.source, derived_confidence: confidenceResult.derived_confidence,
          settled_order_count: historySummary.settled_order_count,
          median_lag_days: historySummary.median_lag_days, sample_label: historySummary.sample_label,
        },
        is_overdue: bucket.is_overdue,
        days_overdue: bucket.is_overdue ? daysOverdueAgainst(part.date, as_of) : 0,
        is_unplanned: part.is_unplanned,
        schedule_id: part.schedule_id,
        installment_id: part.installment_id,
      };
      const wk = weekAccumulators[bucket.index];
      if (part.is_unplanned) {
        wk.money_in.unplanned = (wk.money_in.unplanned || 0) + part.amount;
      } else {
        wk.money_in.gross += part.amount;
        wk.money_in.weighted += weightedAmount;
      }
      wk.money_in.items.push(item);
    }
  }

  // ── supplier purchases (money out) ─────────────────────────────────────
  for (const purchase of (supplier_purchases || [])) {
    const resolved = resolveSupplierPurchaseDueDate(purchase, settings);
    if (resolved.assumed) assumedSupplierPurchaseIds.push(purchase.purchase_id);

    const items = buildOutflowItemsForSource({
      sourceType: 'supplier_purchase',
      sourceId: purchase.purchase_id,
      label: purchase.supplier_name,
      payee: purchase.supplier_name,
      schedule: purchase.schedule,
      installments: purchase.installments,
      outstandingAmount: purchase.outstanding_amount,
      fallbackDate: { date: resolved.date, resolution: resolved },
      fallbackPriority: supplierPurchasePriority(resolved.date, as_of),
      forceMustPay: false,
    });

    for (const item of items) {
      if (item.unplanned_amount > 0) unplannedBalanceSourceIds.push(purchase.purchase_id);
      placeOutflowItem(item, weeks, weekAccumulators, as_of);
    }
  }

  // ── regular payroll (money out) ─────────────────────────────────────────
  for (const payroll of (payroll_obligations || [])) {
    if (!isValidIsoDate(payroll.period_end)) {
      throw new RangeError(`projectCashflow: payroll_run ${payroll.payroll_run_id} has an invalid period_end`);
    }
    const items = buildOutflowItemsForSource({
      sourceType: 'payroll',
      sourceId: payroll.payroll_run_id,
      label: payroll.label,
      payee: null,
      schedule: payroll.schedule,
      installments: payroll.installments,
      outstandingAmount: payroll.outstanding_amount,
      fallbackDate: { date: payroll.period_end, resolution: null },
      fallbackPriority: 'must_pay',
      forceMustPay: false,
    });
    for (const item of items) {
      if (item.unplanned_amount > 0) unplannedBalanceSourceIds.push(payroll.payroll_run_id);
      placeOutflowItem(item, weeks, weekAccumulators, as_of);
    }
  }

  // ── payroll statutory (SHA) obligations (money out) ─────────────────────
  for (const statutory of (payroll_statutory_obligations || [])) {
    if (!isValidIsoDate(statutory.due_date)) {
      throw new RangeError(`projectCashflow: payroll statutory obligation ${statutory.payroll_run_id} has an invalid due_date`);
    }
    if (statutory.schedule?.priority && statutory.schedule.priority !== 'must_pay') {
      warnings.push({
        code: 'schedule_conflicts_with_statutory_priority',
        severity: 'warning',
        message: `A schedule set priority "${statutory.schedule.priority}" on a statutory obligation; must_pay was kept.`,
        week_start: null,
        source_type: 'payroll_sha',
        source_id: statutory.payroll_run_id,
        metadata: null,
      });
    }
    const items = buildOutflowItemsForSource({
      sourceType: 'payroll_sha',
      sourceId: statutory.payroll_run_id,
      label: statutory.label,
      payee: null,
      schedule: statutory.schedule,
      installments: statutory.installments,
      outstandingAmount: statutory.outstanding_amount,
      fallbackDate: { date: statutory.due_date, resolution: null },
      fallbackPriority: 'must_pay',
      forceMustPay: true,
    });
    for (const item of items) {
      if (item.unplanned_amount > 0) unplannedBalanceSourceIds.push(statutory.payroll_run_id);
      placeOutflowItem(item, weeks, weekAccumulators, as_of);
    }
  }

  // ── manual obligations (money out), expanded into dated occurrences ─────
  const horizonStart = weeks[0].week_start;
  const horizonEnd = weeks[weeks.length - 1].week_end;
  for (const obligation of (manual_obligations || [])) {
    const occurrenceDates = generateObligationOccurrences(obligation, horizonStart, horizonEnd);
    for (const occDate of occurrenceDates) {
      const occSchedule = obligation.occurrence_schedules?.[occDate] ?? null;
      if (occSchedule?.priority && obligation.is_statutory && occSchedule.priority !== 'must_pay') {
        warnings.push({
          code: 'schedule_conflicts_with_statutory_priority',
          severity: 'warning',
          message: `A schedule set priority "${occSchedule.priority}" on a statutory obligation occurrence; must_pay was kept.`,
          week_start: null,
          source_type: 'manual_obligation',
          source_id: obligation.obligation_id,
          metadata: { occurrence_date: occDate },
        });
      }
      const items = buildOutflowItemsForSource({
        sourceType: 'manual_obligation',
        sourceId: obligation.obligation_id,
        label: obligation.name,
        payee: obligation.payee,
        schedule: occSchedule,
        installments: occSchedule?.installments ?? [],
        outstandingAmount: obligation.amount,
        fallbackDate: { date: occDate, resolution: null },
        fallbackPriority: obligation.default_priority,
        forceMustPay: obligation.is_statutory === true,
      });
      for (const item of items) {
        if (item.unplanned_amount > 0) unplannedBalanceSourceIds.push(obligation.obligation_id);
        if (obligation.is_statutory === true) {
          // R4: manual statutory lines are human-maintained figures, never a
          // payroll-computed amount — always labelled Estimated.
          item.statutory_type = obligation.statutory_type ?? null;
          item.is_estimated = true;
          item.paying_account_id = obligation.paying_account_id ?? null;
        }
        placeOutflowItem(item, weeks, weekAccumulators, as_of);
      }
    }
  }

  // ── committed / draft BoQ ────────────────────────────────────────────────
  for (const row of (committed_boq || [])) {
    const bucket = bucketDateIntoWeek(row.needed_by, weeks);
    if (bucket == null) continue;
    const wk = weekAccumulators[bucket.index];
    wk.committed_boq.gross += row.gross_commitment;
    wk.committed_boq.linked += row.linked_purchase_amount;
    wk.committed_boq.net += row.net_commitment;
    wk.committed_boq.items.push({
      material_estimate_id: row.material_estimate_id,
      job_id: row.job_id,
      order_id: row.order_id,
      supplier_id: row.supplier_id ?? null,
      needed_by: row.needed_by,
      gross_commitment: row.gross_commitment,
      linked_amount: row.linked_purchase_amount,
      net_commitment: row.net_commitment,
    });
  }

  const boqGrossTotal = (committed_boq || []).reduce((sum, r) => sum + r.gross_commitment, 0);
  const boqLinkedTotal = (committed_boq || []).reduce((sum, r) => sum + r.linked_purchase_amount, 0);
  const boqNetTotal = (committed_boq || []).reduce((sum, r) => sum + r.net_commitment, 0);
  const draftPipelineTotal = (draft_boq_pipeline || []).reduce((sum, r) => sum + r.net_commitment, 0);
  const linkCoveragePercent = boqGrossTotal === 0 ? 0 : (boqLinkedTotal / boqGrossTotal) * 100;

  if (boqGrossTotal > 0 && linkCoveragePercent < 100) {
    warnings.push({
      code: 'incomplete_boq_link_coverage',
      severity: 'info',
      message: `${linkCoveragePercent.toFixed(1)}% of committed BoQ is linked to actual purchases.`,
      week_start: null,
      source_type: null,
      source_id: null,
      metadata: { gross_commitment: boqGrossTotal, linked_amount: boqLinkedTotal },
    });
  }

  // ── daily replay (R3) ────────────────────────────────────────────────────
  // Official chain: weighted receipts − planned (non-held) outflows.
  // Downside chain (R5): the same, minus committed-BoQ net commitment on its
  // needed_by date. A week's state is driven by the LOWEST day of whichever
  // chain is worse — never by the weekly closing balance alone.
  const dailyInflows = [];
  const dailyOutflows = [];
  const dailyBoq = [];
  for (const acc of weekAccumulators) {
    for (const i of acc.money_in.items) {
      if (!i.is_unplanned && i.weighted_amount > 0) dailyInflows.push({ date: i.expected_date, amount: i.weighted_amount });
    }
    for (const o of acc.money_out.items) {
      if (!o.is_held && o.planned_amount > 0) dailyOutflows.push({ date: o.planned_date, amount: o.planned_amount, item: o });
    }
    for (const b of acc.committed_boq.items) {
      if (b.net_commitment > 0) dailyBoq.push({ date: b.needed_by, amount: b.net_commitment });
    }
  }
  const horizonFirstDay = weeks[0].week_start;
  const officialDaily = replayDaily({
    start: horizonFirstDay, end: horizonEnd, opening: openingCash,
    inflows: dailyInflows, outflows: dailyOutflows,
  });
  const downsideDaily = replayDaily({
    start: horizonFirstDay, end: horizonEnd, opening: openingCash,
    inflows: dailyInflows, outflows: dailyOutflows, extraOutflows: dailyBoq,
  });

  // ── chain the weeks: official and downside series each chain independently ─
  const projectedWeeks = [];
  let officialOpening = openingCash;
  let downsideOpening = openingCash; // corrected: week 0's downside_opening is opening_cash, not week 0's official closing
  let normalWeeks = 0, lowCashWeeks = 0, shortfallWeeks = 0;
  let firstShortfallWeek = null;

  for (const acc of weekAccumulators) {
    const closing = officialOpening + acc.money_in.weighted - acc.money_out.total_planned;
    const downsideClosing = downsideOpening + acc.money_in.weighted - acc.money_out.total_planned - acc.committed_boq.net;

    const officialLow = lowestDayInRange(officialDaily.days, acc.week_start, acc.week_end);
    const downsideLow = lowestDayInRange(downsideDaily.days, acc.week_start, acc.week_end);
    // Worst day across both chains decides the state. Fall back to the
    // closing balances only if the week has no days (cannot happen for a
    // valid horizon, but never classify on nothing).
    const candidates = [officialLow, downsideLow].filter(Boolean);
    const driver = candidates.length > 0
      ? candidates.reduce((a, b) => (b.close < a.close ? b : a))
      : { date: acc.week_end, close: Math.min(closing, downsideClosing) };
    const driverChain = downsideLow && driver === downsideLow && (!officialLow || downsideLow.close < officialLow.close)
      ? 'downside' : 'official';
    const classification = classifyWeek(driver.close, settings.cash_reserve_threshold);

    if (classification.state === 'normal') normalWeeks++;
    else if (classification.state === 'low_cash') lowCashWeeks++;
    else shortfallWeeks++;

    if (classification.state === 'shortfall' && firstShortfallWeek == null) {
      const candidates = acc.money_out.items.filter((i) => i.priority !== 'must_pay' && !i.is_held);
      let largest = null;
      for (const c of candidates) {
        if (largest == null || c.planned_amount > largest.planned_amount) largest = c;
      }
      firstShortfallWeek = {
        week_start: acc.week_start,
        amount: classification.shortfall_amount,
        largest_deferrable_item: largest,
      };
    }

    projectedWeeks.push({
      index: acc.index,
      week_start: acc.week_start,
      week_end: acc.week_end,
      opening: officialOpening,
      money_in: acc.money_in,
      money_out: acc.money_out,
      committed_boq: acc.committed_boq,
      closing,
      downside_opening: downsideOpening,
      downside_closing: downsideClosing,
      low_balance: officialLow ? officialLow.close : null,
      low_date: officialLow ? officialLow.date : null,
      downside_low_balance: downsideLow ? downsideLow.close : null,
      downside_low_date: downsideLow ? downsideLow.date : null,
      state_basis: { chain: driverChain, date: driver.date, balance: driver.close },
      state: classification.state,
      state_label: classification.label,
      reserve_gap: classification.reserve_gap,
      shortfall_amount: classification.shortfall_amount,
    });

    officialOpening = closing;
    downsideOpening = downsideClosing;
  }

  // ── R3: any scheduled outflow larger than the balance available on its day ─
  const breachList = [...officialDaily.breaches]
    .sort((a, b) => compareIsoDates(a.date, b.date));
  const MAX_BREACH_WARNINGS = 25;
  for (const b of breachList.slice(0, MAX_BREACH_WARNINGS)) {
    warnings.push({
      code: 'outflow_exceeds_balance',
      severity: 'critical',
      message: `${b.item.label || b.item.source_type}: ${Math.round(b.amount).toLocaleString('en-KE')} is due ${b.date} but only ${Math.round(Math.max(b.balance_available, 0)).toLocaleString('en-KE')} is projected to be available.`,
      week_start: null,
      source_type: b.item.source_type ?? null,
      source_id: b.item.source_id ?? null,
      metadata: {
        due_date: b.date,
        days_until: diffInDays(as_of, b.date),
        amount: b.amount,
        projected_balance: b.balance_available,
        shortfall: b.amount - Math.max(b.balance_available, 0),
      },
    });
  }
  if (breachList.length > MAX_BREACH_WARNINGS) {
    warnings.push({
      code: 'outflow_exceeds_balance_truncated',
      severity: 'warning',
      message: `${breachList.length - MAX_BREACH_WARNINGS} further outflow(s) also exceed the projected balance on their due date.`,
      week_start: null, source_type: null, source_id: null,
      metadata: { total: breachList.length, shown: MAX_BREACH_WARNINGS },
    });
  }

  if (lowCashWeeks > 0) {
    warnings.push({
      code: 'weeks_below_reserve',
      severity: 'warning',
      message: `${lowCashWeeks} week(s) fall below the cash reserve threshold.`,
      week_start: null,
      source_type: null,
      source_id: null,
      metadata: null,
    });
  }
  if (firstShortfallWeek != null) {
    warnings.push({
      code: 'first_official_shortfall',
      severity: 'critical',
      message: `First projected shortfall in the week of ${firstShortfallWeek.week_start}.`,
      week_start: firstShortfallWeek.week_start,
      source_type: null,
      source_id: null,
      metadata: { amount: firstShortfallWeek.amount },
    });
  }
  if (staleOverrideIds.length > 0) {
    warnings.push({
      code: 'stale_schedule_overrides',
      severity: 'warning',
      message: `${staleOverrideIds.length} confidence override(s) have not been reviewed recently.`,
      week_start: null,
      source_type: null,
      source_id: null,
      metadata: { schedule_ids: staleOverrideIds },
    });
  }
  if (assumedSupplierPurchaseIds.length > 0) {
    warnings.push({
      code: 'assumed_supplier_dates',
      severity: 'info',
      message: `${assumedSupplierPurchaseIds.length} supplier purchase(s) have an assumed (not recorded) due date.`,
      week_start: null,
      source_type: 'supplier_purchase',
      source_id: null,
      metadata: { purchase_ids: assumedSupplierPurchaseIds },
    });
  }
  if (unplannedBalanceSourceIds.length > 0) {
    warnings.push({
      code: 'unplanned_obligation_balances',
      severity: 'warning',
      message: `${unplannedBalanceSourceIds.length} obligation(s) have a balance not covered by any planned schedule or installment.`,
      week_start: null,
      source_type: null,
      source_id: null,
      metadata: { source_ids: unplannedBalanceSourceIds },
    });
  }

  // ── R5: receipt concentration ───────────────────────────────────────────
  // A single planned receipt above N% of its calendar month's planned
  // inflow is flagged. Uses gross planned amounts (not confidence-weighted)
  // so the flag reflects how much of the month rests on ONE payment.
  const concentrationPct = Number.isFinite(settings.concentration_threshold_pct)
    ? settings.concentration_threshold_pct : 25;
  const monthTotals = new Map();
  const monthOf = (d) => (compareIsoDates(d, horizonStart) < 0 ? horizonStart : d).slice(0, 7);
  for (const acc of weekAccumulators) {
    for (const i of acc.money_in.items) {
      if (i.is_unplanned) continue;
      const m = monthOf(i.expected_date);
      monthTotals.set(m, (monthTotals.get(m) || 0) + i.outstanding_amount);
    }
  }
  const concentrationFlags = [];
  for (const acc of weekAccumulators) {
    for (const i of acc.money_in.items) {
      if (i.is_unplanned) continue;
      const m = monthOf(i.expected_date);
      const total = monthTotals.get(m) || 0;
      const share = total > 0 ? (i.outstanding_amount / total) * 100 : 0;
      i.concentration_share_pct = share;
      i.is_concentration_risk = share > concentrationPct;
      if (i.is_concentration_risk) {
        concentrationFlags.push({ order_id: i.order_id, order_num: i.order_num, customer_name: i.customer_name, month: m, amount: i.outstanding_amount, share_pct: share });
      }
    }
  }
  if (concentrationFlags.length > 0) {
    warnings.push({
      code: 'receipt_concentration',
      severity: 'warning',
      message: `${concentrationFlags.length} planned receipt(s) each exceed ${concentrationPct}% of their month's forecast inflow — the month depends on a single payment.`,
      week_start: null, source_type: null, source_id: null,
      metadata: { threshold_pct: concentrationPct, receipts: concentrationFlags },
    });
  }

  // ── R4: statutory coverage ──────────────────────────────────────────────
  // Matching is by the explicit statutory_type tag only (never by name).
  // Nothing is ever shown as a silent zero: a type with no line is reported
  // as 'missing' (payroll exists) or 'not_tracked' (nothing forces it).
  const activeStatutory = (manual_obligations || []).filter((o) => o.is_active !== false && o.is_statutory === true);
  const taggedTypes = new Set(activeStatutory.map((o) => o.statutory_type).filter(Boolean));
  const hasPayroll = (payroll_obligations || []).length > 0;
  const coverage = {};
  for (const t of ['paye', 'nssf', 'ahl', 'sha', 'vat', 'wht']) {
    const fromPayroll = t === 'sha' && (payroll_statutory_obligations || []).length > 0;
    const fromManual = taggedTypes.has(t);
    const requiredByPayroll = hasPayroll && ['paye', 'nssf', 'ahl', 'sha'].includes(t);
    coverage[t] = {
      status: fromPayroll || fromManual ? 'tracked' : (requiredByPayroll ? 'missing' : 'not_tracked'),
      basis: fromPayroll ? 'payroll_computed' : (fromManual ? 'manual_estimate' : null),
    };
  }
  const missingStatutory = Object.entries(coverage).filter(([, v]) => v.status === 'missing').map(([k]) => k);
  if (missingStatutory.length > 0) {
    warnings.push({
      code: 'payroll_without_statutory_line',
      severity: 'critical',
      message: `Payroll exists but no ${missingStatutory.map((t) => t.toUpperCase()).join(', ')} statutory outflow is recorded — the forecast understates cash out.`,
      week_start: null, source_type: 'payroll', source_id: null,
      metadata: { missing: missingStatutory, payroll_run_ids: (payroll_obligations || []).map((p) => p.payroll_run_id) },
    });
  }
  const noPayingAccount = activeStatutory.filter((o) => !o.paying_account_id);
  if (noPayingAccount.length > 0) {
    warnings.push({
      code: 'statutory_paying_account_unrecorded',
      severity: 'warning',
      message: `${noPayingAccount.length} statutory obligation(s) have no paying account recorded, so the cash pool they draw from is unknown.`,
      week_start: null, source_type: 'manual_obligation', source_id: null,
      metadata: { obligation_ids: noPayingAccount.map((o) => o.obligation_id) },
    });
  }
  if (activeStatutory.some((o) => !o.statutory_type)) {
    warnings.push({
      code: 'statutory_type_untagged',
      severity: 'info',
      message: 'Some statutory obligations have no type (PAYE/NSSF/AHL/SHA/VAT/WHT), so they cannot count toward statutory coverage.',
      week_start: null, source_type: 'manual_obligation', source_id: null,
      metadata: { obligation_ids: activeStatutory.filter((o) => !o.statutory_type).map((o) => o.obligation_id) },
    });
  }

  // ── R2: unbanked customer receipts ──────────────────────────────────────
  // Cash and M-PESA taken but not yet banked. Reported separately: this is
  // money that exists but is NOT in the bank balance, and the module cannot
  // (and must not) move it between ledger accounts.
  const rm = receipt_methods ?? { available: false, unbanked: [], unknown_method_count: 0, unknown_method_amount: 0 };
  const warnAfter = Number.isFinite(settings.unbanked_warn_after_days) ? settings.unbanked_warn_after_days : 3;
  const unbankedItems = (rm.unbanked || []).map((u) => ({ ...u, days_unbanked: Math.max(0, diffInDays(u.payment_date, as_of)) }))
    .sort((a, b) => b.days_unbanked - a.days_unbanked);
  const unbankedOverdue = unbankedItems.filter((u) => u.days_unbanked >= warnAfter);
  const unbankedTotal = unbankedItems.reduce((sum, u) => sum + u.amount, 0);
  if (!rm.available) {
    warnings.push({
      code: 'receipt_method_data_unavailable',
      severity: 'info',
      message: 'Payment method / banked-date data is not available yet (cashflow_r2_r5_support.sql not applied) — unbanked cash cannot be assessed.',
      week_start: null, source_type: null, source_id: null, metadata: null,
    });
  } else {
    if (unbankedOverdue.length > 0) {
      const overdueTotal = unbankedOverdue.reduce((sum, u) => sum + u.amount, 0);
      warnings.push({
        code: 'unbanked_receipts',
        severity: 'warning',
        message: `${unbankedOverdue.length} cash/M-PESA receipt(s) totalling ${Math.round(overdueTotal).toLocaleString('en-KE')} have been unbanked for ${warnAfter}+ days (oldest ${unbankedOverdue[0].days_unbanked} days).`,
        week_start: null, source_type: null, source_id: null,
        metadata: { warn_after_days: warnAfter, total: overdueTotal, payment_ids: unbankedOverdue.map((u) => u.payment_id) },
      });
    }
    if (rm.unknown_method_count > 0) {
      warnings.push({
        code: 'receipt_method_unrecorded',
        severity: 'info',
        message: `${rm.unknown_method_count} customer payment(s) have no payment method recorded, so they cannot be classed as banked or unbanked.`,
        week_start: null, source_type: null, source_id: null,
        metadata: { count: rm.unknown_method_count, amount: rm.unknown_method_amount },
      });
    }
  }

  return {
    as_of,
    horizon: {
      weeks: weeks.length,
      first_week_start: weeks[0].week_start,
      last_week_end: weeks[weeks.length - 1].week_end,
    },
    ledger_health: projectedLedgerHealth,
    cash_pools: projectedCashPools,
    opening_cash: openingCash,
    weeks: projectedWeeks,
    first_shortfall_week: firstShortfallWeek,
    counts: { normal_weeks: normalWeeks, low_cash_weeks: lowCashWeeks, shortfall_weeks: shortfallWeeks },
    boq_summary: {
      gross_commitment: boqGrossTotal,
      linked_amount: boqLinkedTotal,
      net_commitment: boqNetTotal,
      link_coverage_percent: linkCoveragePercent,
      draft_pipeline: draftPipelineTotal,
    },
    statutory_coverage: coverage,
    receipt_methods: {
      available: rm.available === true,
      unbanked_total: unbankedTotal,
      unbanked_count: unbankedItems.length,
      unbanked_overdue_count: unbankedOverdue.length,
      warn_after_days: warnAfter,
      unbanked: unbankedItems,
      unknown_method_count: rm.unknown_method_count || 0,
      unknown_method_amount: rm.unknown_method_amount || 0,
    },
    warnings,
  };
}


/**
 * R3 — daily running balance. Replays every dated inflow/outflow across the
 * horizon, one calendar day at a time, so a week's state can use its LOWEST
 * day instead of its closing balance (cash here is spent the day it arrives).
 *
 * Dates before the first horizon day (overdue items) are clamped onto day 1.
 * Within a day, inflows are applied before outflows — the optimistic
 * ordering; the same-day "outflow exceeds balance" check below uses the
 * balance available AFTER that day's inflows and EARLIER outflows.
 *
 * @param {{start:string,end:string,opening:number,
 *          inflows:{date:string,amount:number}[],
 *          outflows:{date:string,amount:number,item:object}[],
 *          extraOutflows?:{date:string,amount:number}[]}} p
 * @returns {{days:{date:string,close:number}[], breaches:object[]}}
 */
function replayDaily({ start, end, opening, inflows, outflows, extraOutflows = [] }) {
  const clamp = (d) => (compareIsoDates(d, start) < 0 ? start : d);
  const inByDay = new Map();
  const outByDay = new Map();
  for (const i of inflows) {
    const d = clamp(i.date);
    inByDay.set(d, (inByDay.get(d) || 0) + i.amount);
  }
  for (const o of outflows) {
    const d = clamp(o.date);
    if (!outByDay.has(d)) outByDay.set(d, []);
    outByDay.get(d).push(o);
  }
  const extraByDay = new Map();
  for (const o of extraOutflows) {
    const d = clamp(o.date);
    extraByDay.set(d, (extraByDay.get(d) || 0) + o.amount);
  }

  const days = [];
  const breaches = [];
  let balance = opening;
  for (let d = start; compareIsoDates(d, end) <= 0; d = addDaysToIsoDate(d, 1)) {
    balance += inByDay.get(d) || 0;
    for (const o of (outByDay.get(d) || [])) {
      if (o.amount > balance + 0.005) {
        breaches.push({ date: d, amount: o.amount, balance_available: balance, item: o.item });
      }
      balance -= o.amount;
    }
    balance -= extraByDay.get(d) || 0;
    days.push({ date: d, close: balance });
  }
  return { days, breaches };
}

function lowestDayInRange(days, from, to) {
  let low = null;
  for (const day of days) {
    if (compareIsoDates(day.date, from) < 0 || compareIsoDates(day.date, to) > 0) continue;
    if (low == null || day.close < low.close) low = day;
  }
  return low;
}

/**
 * Buckets one outflow item into its week, fills in is_overdue/days_overdue,
 * and rolls it into that week's money_out totals. Held items are visible in
 * `items` and counted in `held`, but never in must_pay/important/can_wait or
 * total_planned. unplanned_amount always rolls into `unplanned`, regardless
 * of held status.
 */
function placeOutflowItem(item, weeks, weekAccumulators, asOf) {
  const bucket = bucketDateIntoWeek(item.planned_date, weeks);
  if (bucket == null) return; // beyond the horizon — not reported

  const isOverdue = bucket.is_overdue;
  const daysOverdue = isOverdue ? daysOverdueAgainst(item.planned_date, asOf) : 0;
  const fullItem = { ...item, is_overdue: isOverdue, days_overdue: daysOverdue };

  const wk = weekAccumulators[bucket.index];
  wk.money_out.items.push(fullItem);
  wk.money_out.unplanned += item.unplanned_amount;

  if (item.is_held) {
    wk.money_out.held += item.planned_amount;
    return;
  }
  wk.money_out.total_planned += item.planned_amount;
  if (item.priority === 'must_pay') wk.money_out.must_pay += item.planned_amount;
  else if (item.priority === 'important') wk.money_out.important += item.planned_amount;
  else if (item.priority === 'can_wait') wk.money_out.can_wait += item.planned_amount;
}
