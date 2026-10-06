/**
 * shared/lib/cashflow/buildSnapshot.js
 *
 * The ONLY place that queries Supabase to assemble a CashflowSnapshot (see
 * types.js). Everything else in shared/lib/cashflow/ (isoWeeks, resolveDueDate,
 * confidence, classifyWeek, projectCashflow) is pure and does zero I/O — this
 * file is the one seam where the forecast engine touches the database.
 *
 * Per the Cashflow module's standing rules (unchanged since Stage 0):
 *   - Read-only. This file never writes a payment, journal entry, or any
 *     other transactional row. It only shapes existing data into the
 *     snapshot contract.
 *   - Nothing here is stored. buildCashflowSnapshot() is called fresh on
 *     every request; there is no cached/materialized snapshot table.
 *   - A missing value stays visibly unknown (null / excluded), never coerced
 *     to zero or a guessed default. Every place that excludes a row instead
 *     of fabricating a fact is called out in a comment below.
 *   - BoQ-to-purchase links are read from purchase_boq_links only — never
 *     inferred from name/supplier/job matching.
 *
 * ── Known, disclosed gaps this file does NOT paper over ───────────────────
 * 1. Cash-pool posting errors: accounting_posting_errors has no account-level
 *    attribution (only source_type/source_id of the failed transaction), so
 *    CashPoolSnapshot.unresolved_posting_errors is always 0 here. The real,
 *    global count still surfaces via ledger_health.unresolved_error_count.
 * 2. SHA remittance has no "has this actually been paid" table anywhere in
 *    the schema. Every computed SHA amount is reported 100% outstanding,
 *    always — this is a real limitation, not a bug, and is unrelated to (3).
 * 3. A payroll run's `cashflow_schedules` row (via payroll_run_id, unique per
 *    run) is understood to belong to the REGULAR payroll obligation only.
 *    There is no separate source column for a run's SHA remittance, so a SHA
 *    obligation's `schedule` is always null — a human override cannot be
 *    attached to just the SHA portion of a run in this schema.
 */

import { isValidIsoDate, diffInDays } from '../isoDate.js';
import { CANCELLED_STATUS, QUOTE_STATUSES } from '../customerBalance.js';

// ── small shaping helpers ───────────────────────────────────────────────────

function shapeSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    planned_date: row.planned_date,
    planned_amount: row.planned_amount ?? null,
    minimum_amount: row.minimum_amount ?? null,
    priority: row.priority,
    confidence_override: row.confidence_override ?? null,
    hold_reason: row.hold_reason ?? null,
    notes: row.notes ?? null,
    last_reviewed_at: row.last_reviewed_at ?? null,
    updated_at: row.updated_at,
  };
}

function shapeInstallment(row) {
  return {
    id: row.id,
    installment_number: row.installment_number,
    planned_date: row.planned_date,
    planned_amount: Number(row.planned_amount),
    status: row.status,
  };
}

/**
 * Loads cashflow_schedules (keyed by a single-source column: supplier_purchase_id,
 * order_id, or payroll_run_id — each has its own one-schedule-per-source
 * partial unique index) plus their installments, and returns a map keyed by
 * that source id: { [id]: { schedule, installments } }.
 */
async function loadSchedulesAndInstallments(db, sourceColumn, ids) {
  if (!ids || ids.length === 0) return {};

  const { data: schedules, error } = await db
    .from('cashflow_schedules')
    .select(`id, ${sourceColumn}, planned_date, planned_amount, minimum_amount, priority, confidence_override, hold_reason, notes, last_reviewed_at, updated_at`)
    .in(sourceColumn, ids);
  if (error) {
    throw new Error(`buildCashflowSnapshot: failed to load cashflow_schedules (${sourceColumn}): ${error.message}`);
  }

  const byKey = {};
  const scheduleIdToKey = {};
  for (const s of (schedules || [])) {
    const key = s[sourceColumn];
    byKey[key] = { schedule: shapeSchedule(s), installments: [] };
    scheduleIdToKey[s.id] = key;
  }

  const scheduleIds = Object.keys(scheduleIdToKey);
  if (scheduleIds.length > 0) {
    const { data: insts, error: instErr } = await db
      .from('cashflow_schedule_installments')
      .select('id, schedule_id, installment_number, planned_date, planned_amount, status')
      .in('schedule_id', scheduleIds);
    if (instErr) {
      throw new Error(`buildCashflowSnapshot: failed to load cashflow_schedule_installments: ${instErr.message}`);
    }
    for (const inst of (insts || [])) {
      const key = scheduleIdToKey[inst.schedule_id];
      if (key == null) continue;
      byKey[key].installments.push(shapeInstallment(inst));
    }
  }

  return byKey;
}

// ── 1. settings ──────────────────────────────────────────────────────────

async function loadSettingsRow(db) {
  const { data, error } = await db
    .from('cashflow_settings')
    .select('id, horizon_weeks, week_starts_on, default_supplier_terms_days, cash_reserve_threshold, override_stale_after_days, schedule_review_stale_after_days, reconciliation_stale_after_days')
    .eq('singleton_key', true)
    .maybeSingle();
  if (error) {
    throw new Error(`buildCashflowSnapshot: failed to load cashflow_settings: ${error.message}`);
  }
  if (!data) {
    throw new Error('buildCashflowSnapshot: cashflow_settings has no singleton row — run cashflow_v1_schema.sql');
  }
  return data;
}

// R2/R5 threshold columns come from cashflow_r2_r5_support.sql. A separate
// query so the forecast keeps working (with documented defaults) until that
// migration has been run, instead of failing the whole snapshot.
async function loadSettingsExtras(db, settingsId) {
  const { data, error } = await db
    .from('cashflow_settings')
    .select('unbanked_warn_after_days, concentration_threshold_pct')
    .eq('id', settingsId)
    .maybeSingle();
  if (error || !data) {
    return { unbanked_warn_after_days: 3, concentration_threshold_pct: 25, migration_applied: false };
  }
  return {
    unbanked_warn_after_days: data.unbanked_warn_after_days,
    concentration_threshold_pct: data.concentration_threshold_pct,
    migration_applied: true,
  };
}

// ── R2: receipts by method / banked date ─────────────────────────────────
// Returns { available, unbanked[], unknown_method_count }. NULL method on a
// legacy row is counted as UNKNOWN — never assumed to be bank or cash.
async function loadReceiptMethods(db) {
  const { data, error } = await db
    .from('order_payments')
    .select('id, order_id, amount, payment_date, payment_method, banked_date, reversed_at, orders(order_num, customers(name))')
    .is('reversed_at', null);
  if (error) {
    return { available: false, unbanked: [], unknown_method_count: 0, unknown_method_amount: 0 };
  }
  const unbanked = [];
  let unknownCount = 0;
  let unknownAmount = 0;
  for (const p of (data || [])) {
    const amount = Number(p.amount);
    if (p.payment_method == null) { unknownCount++; unknownAmount += amount; continue; }
    if ((p.payment_method === 'cash' || p.payment_method === 'mpesa') && p.banked_date == null) {
      unbanked.push({
        payment_id: p.id,
        order_id: p.order_id,
        order_num: p.orders?.order_num ?? null,
        customer_name: p.orders?.customers?.name ?? null,
        amount,
        payment_method: p.payment_method,
        payment_date: p.payment_date,
      });
    }
  }
  return { available: true, unbanked, unknown_method_count: unknownCount, unknown_method_amount: unknownAmount };
}

// ── 2. cash pools ────────────────────────────────────────────────────────

async function loadCashPools(db, settingsId) {
  const { data: rows, error } = await db
    .from('cashflow_setting_accounts')
    .select('account_id, is_enabled, last_reconciled_at, reconciled_balance, accounting_accounts(code, name)')
    .eq('settings_id', settingsId);
  if (error) {
    throw new Error(`buildCashflowSnapshot: failed to load cashflow_setting_accounts: ${error.message}`);
  }

  const accountIds = (rows || []).map((r) => r.account_id);
  const balanceByAccount = {};

  if (accountIds.length > 0) {
    // Real balances are derived from the ledger, never a stored column —
    // accounting_accounts has no balance field of its own.
    const { data: lines, error: linesErr } = await db
      .from('journal_lines')
      .select('account_id, amount, journal_entries!inner(status)')
      .in('account_id', accountIds)
      .eq('journal_entries.status', 'active');
    if (linesErr) {
      throw new Error(`buildCashflowSnapshot: failed to load journal_lines for cash pools: ${linesErr.message}`);
    }
    for (const line of (lines || [])) {
      balanceByAccount[line.account_id] = (balanceByAccount[line.account_id] || 0) + Number(line.amount);
    }
  }

  return (rows || []).map((r) => ({
    account_id: r.account_id,
    account_code: r.accounting_accounts?.code ?? '',
    name: r.accounting_accounts?.name ?? '',
    balance: balanceByAccount[r.account_id] || 0,
    is_enabled: r.is_enabled,
    last_reconciled_at: r.last_reconciled_at ?? null,
    reconciled_balance: r.reconciled_balance ?? null,
    // See file header, gap (1): no account-level attribution exists for
    // accounting_posting_errors. Always 0 here — never fabricated as
    // "resolved". The real, global count is ledger_health.unresolved_error_count.
    unresolved_posting_errors: 0,
  }));
}

// ── 3. ledger health ─────────────────────────────────────────────────────
// Reuses the exact 4-source "unposted" definition established in
// GET /api/home/summary's accounting section, plus the oldest-unposted-days
// computation that route doesn't need.

async function loadLedgerHealth(db, asOf) {
  const [errRes, purchasesRes, manualsRes, chatpesaRes, obRes] = await Promise.all([
    db.from('accounting_posting_errors').select('id', { count: 'exact', head: true }).eq('resolved', false),
    db.from('supplier_purchases').select('created_at').is('journal_entry_id', null),
    db.from('manual_supplier_payments').select('created_at').is('journal_entry_id', null),
    db.from('chatpesa_payment_allocations').select('created_at').is('journal_entry_id', null),
    // A supplier's opening-balance "unposted since" has no timestamp of its
    // own — created_at (supplier record creation) is used as a proxy, same
    // as the other three sources' own created_at.
    db.from('suppliers').select('created_at').is('opening_balance_journal_entry_id', null).gt('opening_balance', 0),
  ]);

  for (const [label, res] of [
    ['posting errors', errRes], ['supplier_purchases', purchasesRes],
    ['manual_supplier_payments', manualsRes], ['chatpesa_payment_allocations', chatpesaRes],
    ['suppliers opening balances', obRes],
  ]) {
    if (res.error) {
      throw new Error(`buildCashflowSnapshot: ledger health query (${label}) failed: ${res.error.message}`);
    }
  }

  const unpostedRows = [
    ...(purchasesRes.data || []),
    ...(manualsRes.data || []),
    ...(chatpesaRes.data || []),
    ...(obRes.data || []),
  ];

  const unposted_count = unpostedRows.length;
  let oldest_unposted_days = null;
  if (unposted_count > 0) {
    const oldestCreatedAt = unpostedRows.reduce(
      (min, r) => (r.created_at < min ? r.created_at : min),
      unpostedRows[0].created_at,
    );
    oldest_unposted_days = diffInDays(oldestCreatedAt.slice(0, 10), asOf);
  }

  return {
    unposted_count,
    oldest_unposted_days,
    unresolved_error_count: errRes.count ?? 0,
  };
}

// ── 4. receipts + customer histories ────────────────────────────────────
//
// Judgment call: which orders are forecastable receivables? Not every
// order.status counts. 'Inquiry' and 'Quote Approved' (QUOTE_STATUSES) are
// not yet a locked commitment — total_value on a quote is not a receivable.
// 'Cancelled / Refunded' has no remaining receivable by definition. Every
// other status (Deposit Paid onward, including fully delivered/closed) is a
// real order and is included regardless of whether it has been invoiced yet
// or has a recorded payment_due_date — resolveCustomerReceiptDate's tier 3/4
// fallbacks exist precisely to forecast these without either field.

async function loadReceiptsAndCustomerHistories(db) {
  const { data: orders, error } = await db
    .from('orders')
    .select('id, order_num, customer_id, total_value, payment_due_date, invoice_issued_at, created_at, status, customers(name), order_payments(amount, payment_date, reversed_at)')
    .not('customer_id', 'is', null)
    .neq('status', QUOTE_STATUSES[0])
    .neq('status', QUOTE_STATUSES[1])
    .neq('status', CANCELLED_STATUS);
  if (error) {
    throw new Error(`buildCashflowSnapshot: failed to load orders for receipts: ${error.message}`);
  }

  const receipts = [];
  const settledOrdersByCustomer = {};

  for (const order of (orders || [])) {
    const nonReversedPayments = (order.order_payments || []).filter((p) => !p.reversed_at);
    const paid = nonReversedPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const totalValue = Number(order.total_value || 0);
    const outstanding = totalValue - paid;

    if (outstanding > 0.01) {
      receipts.push({
        order_id: order.id,
        customer_id: order.customer_id,
        customer_name: order.customers?.name ?? '',
        order_num: order.order_num,
        total_value: totalValue,
        non_reversed_paid: paid,
        outstanding_amount: outstanding,
        payment_due_date: order.payment_due_date ?? null,
        invoice_issued_at: order.invoice_issued_at ?? null,
        created_at: order.created_at,
        schedule: null,
        installments: [],
      });
      continue; // an order is either a current receivable or settled history, never both
    }

    // customer_histories eligibility, per confidence.js's own documented
    // rule: same customer; valid payment_due_date; positive order value;
    // non-reversed payments that fully settle the order; a final settlement
    // date available. Cancelled/refunded orders are already excluded above.
    if (order.payment_due_date && totalValue > 0 && paid >= totalValue - 0.01 && nonReversedPayments.length > 0) {
      const finalPaymentDate = nonReversedPayments.reduce(
        (max, p) => (p.payment_date > max ? p.payment_date : max),
        nonReversedPayments[0].payment_date,
      );
      (settledOrdersByCustomer[order.customer_id] ??= []).push({
        order_id: order.id,
        payment_due_date: order.payment_due_date,
        final_payment_date: finalPaymentDate,
      });
    }
  }

  const orderIds = receipts.map((r) => r.order_id);
  const scheduleMap = await loadSchedulesAndInstallments(db, 'order_id', orderIds);
  for (const r of receipts) {
    r.schedule = scheduleMap[r.order_id]?.schedule ?? null;
    r.installments = scheduleMap[r.order_id]?.installments ?? [];
  }

  const customer_histories = {};
  for (const [customerId, settledOrders] of Object.entries(settledOrdersByCustomer)) {
    customer_histories[customerId] = { settled_orders: settledOrders };
  }

  return { receipts, customer_histories };
}

// ── 5. supplier purchases ────────────────────────────────────────────────

async function loadSupplierPurchases(db) {
  const { data, error } = await db
    .from('supplier_purchases')
    .select('id, supplier_id, purchase_date, due_date, due_date_source, due_date_terms_days, total_amount, amount_paid, suppliers(name, payment_terms_days)')
    .neq('payment_status', 'Paid');
  if (error) {
    throw new Error(`buildCashflowSnapshot: failed to load supplier_purchases: ${error.message}`);
  }

  const rows = (data || [])
    .map((p) => {
      const totalAmount = Number(p.total_amount || 0);
      const paidAmount = Number(p.amount_paid || 0);
      return {
        purchase_id: p.id,
        supplier_id: p.supplier_id,
        supplier_name: p.suppliers?.name ?? '',
        purchase_date: p.purchase_date,
        due_date: p.due_date ?? null,
        due_date_source: p.due_date_source ?? null,
        due_date_terms_days: p.due_date_terms_days ?? null,
        current_supplier_terms_days: p.suppliers?.payment_terms_days ?? null,
        total_amount: totalAmount,
        paid_amount: paidAmount,
        outstanding_amount: totalAmount - paidAmount,
        schedule: null,
        installments: [],
      };
    })
    .filter((p) => p.outstanding_amount > 0.01);

  const scheduleMap = await loadSchedulesAndInstallments(db, 'supplier_purchase_id', rows.map((r) => r.purchase_id));
  for (const r of rows) {
    const m = scheduleMap[r.purchase_id];
    r.schedule = m?.schedule ?? null;
    r.installments = m?.installments ?? [];
  }

  return rows;
}

// ── 6. payroll obligations + SHA statutory ──────────────────────────────
//
// Only 'approved' and 'closed' runs represent a committed obligation — a
// 'draft' run's totals are not yet snapshotted (per payroll_runs' own
// comment: "Totals... computed and snapshotted on approval").
//
// SHA is sourced from payroll_entries.sha_deduction, summed per run — NOT
// from payroll_statutory_deductions, which this codebase defines but never
// writes to (verified: no route inserts into it). sha_deduction is the real,
// populated field every payroll route actually computes and stores.

function shaRemittanceDueDate(periodEnd) {
  const [y, m] = periodEnd.split('-').map(Number);
  // m (1-based "this month") used as a 0-based month index lands on "next
  // month" — Date.UTC handles the December -> January year rollover itself.
  const dt = new Date(Date.UTC(y, m, 9));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function loadPayrollObligationsAndStatutory(db) {
  const { data: runs, error } = await db
    .from('payroll_runs')
    .select('id, run_num, period_end, status, payroll_entries(net_pay, amount_paid, sha_deduction)')
    .in('status', ['approved', 'closed']);
  if (error) {
    throw new Error(`buildCashflowSnapshot: failed to load payroll_runs: ${error.message}`);
  }

  const payroll_obligations = [];
  const payroll_statutory_obligations = [];

  for (const run of (runs || [])) {
    const entries = run.payroll_entries || [];
    const netPay = entries.reduce((s, e) => s + Number(e.net_pay || 0), 0);
    const paidAmount = entries.reduce((s, e) => s + Number(e.amount_paid || 0), 0);
    const outstanding = netPay - paidAmount;

    if (outstanding > 0.01) {
      payroll_obligations.push({
        payroll_run_id: run.id,
        label: `Payroll — ${run.run_num}`,
        period_end: run.period_end,
        net_pay: netPay,
        paid_amount: paidAmount,
        outstanding_amount: outstanding,
        schedule: null,
        installments: [],
      });
    }

    const shaTotal = entries.reduce((s, e) => s + Number(e.sha_deduction || 0), 0);
    if (shaTotal > 0.01) {
      payroll_statutory_obligations.push({
        source: 'payroll_sha',
        payroll_run_id: run.id,
        label: `SHA remittance — ${run.run_num}`,
        due_date: shaRemittanceDueDate(run.period_end),
        // See file header, gap (2): always fully outstanding — no remittance-
        // payment table exists yet to know otherwise.
        outstanding_amount: shaTotal,
        priority: 'must_pay',
        // See file header, gap (3): a run's cashflow_schedules row belongs to
        // the regular payroll obligation, not the SHA portion.
        schedule: null,
        installments: [],
      });
    }
  }

  const scheduleMap = await loadSchedulesAndInstallments(
    db, 'payroll_run_id', payroll_obligations.map((p) => p.payroll_run_id),
  );
  for (const p of payroll_obligations) {
    const m = scheduleMap[p.payroll_run_id];
    p.schedule = m?.schedule ?? null;
    p.installments = m?.installments ?? [];
  }

  return { payroll_obligations, payroll_statutory_obligations };
}

// ── 7. manual obligations ────────────────────────────────────────────────
// Every row is passed through as-is, active or not — generateObligationOccurrences
// (isoWeeks.js) already treats is_active === false as "no occurrences, ever".
// Duplicating that check here would be a second implementation of the same rule.

async function loadManualObligations(db) {
  const { data, error } = await db
    .from('cashflow_manual_obligations')
    .select('id, name, payee, amount, is_statutory, recurrence, day_of_month, first_due_date, ends_on, is_active, default_priority');
  if (error) {
    throw new Error(`buildCashflowSnapshot: failed to load cashflow_manual_obligations: ${error.message}`);
  }

  const obligationIds = (data || []).map((o) => o.id);
  const occurrenceSchedulesByObligation = {};

  if (obligationIds.length > 0) {
    const { data: schedules, error: schedErr } = await db
      .from('cashflow_schedules')
      .select('id, obligation_id, obligation_occurrence_date, planned_date, planned_amount, minimum_amount, priority, confidence_override, hold_reason, notes, last_reviewed_at, updated_at')
      .in('obligation_id', obligationIds);
    if (schedErr) {
      throw new Error(`buildCashflowSnapshot: failed to load cashflow_schedules for manual obligations: ${schedErr.message}`);
    }
    const scheduleById = {};
    for (const s of (schedules || [])) {
      const shaped = { ...shapeSchedule(s), installments: [] };
      (occurrenceSchedulesByObligation[s.obligation_id] ??= {})[s.obligation_occurrence_date] = shaped;
      scheduleById[s.id] = shaped;
    }

    const scheduleIds = Object.keys(scheduleById);
    if (scheduleIds.length > 0) {
      const { data: installments, error: instErr } = await db
        .from('cashflow_schedule_installments')
        .select('id, schedule_id, installment_number, planned_date, planned_amount, status')
        .in('schedule_id', scheduleIds);
      if (instErr) {
        throw new Error(`buildCashflowSnapshot: failed to load manual-obligation installments: ${instErr.message}`);
      }
      for (const inst of (installments || [])) {
        scheduleById[inst.schedule_id]?.installments.push(shapeInstallment(inst));
      }
    }
  }

  // R4 columns (cashflow_r2_r5_support.sql) — separate query, tolerant of the
  // migration not having run yet (then every statutory tag is simply unknown).
  const statutoryMeta = {};
  {
    const { data: extra, error: extraErr } = await db
      .from('cashflow_manual_obligations')
      .select('id, statutory_type, paying_account_id');
    if (!extraErr) for (const r of (extra || [])) statutoryMeta[r.id] = r;
  }

  return (data || []).map((o) => ({
    statutory_type: statutoryMeta[o.id]?.statutory_type ?? null,
    paying_account_id: statutoryMeta[o.id]?.paying_account_id ?? null,
    obligation_id: o.id,
    name: o.name,
    payee: o.payee ?? null,
    amount: Number(o.amount),
    is_statutory: o.is_statutory,
    recurrence: o.recurrence,
    day_of_month: o.day_of_month ?? null,
    first_due_date: o.first_due_date,
    ends_on: o.ends_on ?? null,
    is_active: o.is_active,
    default_priority: o.default_priority,
    occurrence_schedules: occurrenceSchedulesByObligation[o.id] ?? {},
  }));
}

// ── 8. committed / draft BoQ ─────────────────────────────────────────────

async function loadBoq(db) {
  const { data: estimates, error } = await db
    .from('production_material_estimates')
    .select('id, job_id, preferred_supplier_id, estimated_total_cost, production_jobs(id, order_id, status, planned_start, production_plans(status))');
  if (error) {
    throw new Error(`buildCashflowSnapshot: failed to load production_material_estimates: ${error.message}`);
  }

  const rows = [];
  for (const est of (estimates || [])) {
    // Uncosted line (no estimated_unit_cost -> estimated_total_cost is NULL):
    // no known amount to forecast. Excluded, not fabricated as 0 — see
    // production_v1g_boq_classification.sql, cost_source_type NULL = "row is
    // uncosted".
    if (est.estimated_total_cost == null) continue;

    const job = est.production_jobs;
    if (!job) continue;

    // A cancelled job's material will never be purchased. Every other job
    // status (including Completed) stays in — a Completed job whose material
    // was never linked to a real purchase is genuine, disclosable
    // information (incomplete_boq_link_coverage), not something to hide.
    if (job.status === 'Cancelled') continue;

    // needed_by has no dedicated column — planned_start is the best proxy
    // for "when this job's materials are needed". Excluded (not fabricated)
    // when absent.
    if (!job.planned_start) continue;

    const planStatus = job.production_plans?.status;
    if (planStatus !== 'Active' && planStatus !== 'Draft') continue; // Paused/Completed/Cancelled plans are neither committed nor pipeline

    rows.push({
      material_estimate_id: est.id,
      job_id: job.id,
      order_id: job.order_id,
      supplier_id: est.preferred_supplier_id ?? null,
      plan_status: planStatus,
      needed_by: job.planned_start,
      gross_commitment: Number(est.estimated_total_cost),
      linked_purchase_amount: 0,
      net_commitment: 0,
    });
  }

  const estimateIds = rows.map((r) => r.material_estimate_id);
  const linkedByEstimate = {};
  if (estimateIds.length > 0) {
    const { data: links, error: linkErr } = await db
      .from('purchase_boq_links')
      .select('material_estimate_id, amount_fulfilled')
      .in('material_estimate_id', estimateIds);
    if (linkErr) {
      throw new Error(`buildCashflowSnapshot: failed to load purchase_boq_links: ${linkErr.message}`);
    }
    for (const link of (links || [])) {
      linkedByEstimate[link.material_estimate_id] =
        (linkedByEstimate[link.material_estimate_id] || 0) + Number(link.amount_fulfilled);
    }
  }

  for (const r of rows) {
    const linked = linkedByEstimate[r.material_estimate_id] || 0;
    r.linked_purchase_amount = linked;
    r.net_commitment = Math.max(0, r.gross_commitment - linked); // per types.js's own documented rule
  }

  return {
    committed_boq: rows.filter((r) => r.plan_status === 'Active'),
    draft_boq_pipeline: rows.filter((r) => r.plan_status === 'Draft'),
  };
}

// ── orchestrator ─────────────────────────────────────────────────────────

/**
 * Assembles one CashflowSnapshot (types.js) by querying Supabase. Read-only,
 * computed fresh on every call — nothing here is cached or persisted.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  a service-role client
 * @param {{ asOf?: string }} [options]  override the as_of date (tests only)
 * @returns {Promise<import('./types.js').CashflowSnapshot>}
 */
export async function buildCashflowSnapshot(db, { asOf } = {}) {
  const as_of = asOf ?? new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(as_of)) {
    throw new RangeError(`buildCashflowSnapshot: invalid asOf "${as_of}"`);
  }

  const settingsRow = await loadSettingsRow(db);
  const settings = {
    horizon_weeks: settingsRow.horizon_weeks,
    week_starts_on: settingsRow.week_starts_on,
    default_supplier_terms_days: settingsRow.default_supplier_terms_days,
    cash_reserve_threshold: Number(settingsRow.cash_reserve_threshold),
    override_stale_after_days: settingsRow.override_stale_after_days,
    schedule_review_stale_after_days: settingsRow.schedule_review_stale_after_days,
    reconciliation_stale_after_days: settingsRow.reconciliation_stale_after_days,
  };

  const [
    cash_pools,
    ledger_health,
    receiptsResult,
    supplier_purchases,
    payrollResult,
    manual_obligations,
    boqResult,
    settingsExtras,
    receiptMethods,
  ] = await Promise.all([
    loadCashPools(db, settingsRow.id),
    loadLedgerHealth(db, as_of),
    loadReceiptsAndCustomerHistories(db),
    loadSupplierPurchases(db),
    loadPayrollObligationsAndStatutory(db),
    loadManualObligations(db),
    loadBoq(db),
    loadSettingsExtras(db, settingsRow.id),
    loadReceiptMethods(db),
  ]);
  settings.unbanked_warn_after_days = settingsExtras.unbanked_warn_after_days;
  settings.concentration_threshold_pct = settingsExtras.concentration_threshold_pct;

  return {
    as_of,
    settings,
    ledger_health,
    cash_pools,
    receipts: receiptsResult.receipts,
    customer_histories: receiptsResult.customer_histories,
    supplier_purchases,
    payroll_obligations: payrollResult.payroll_obligations,
    payroll_statutory_obligations: payrollResult.payroll_statutory_obligations,
    manual_obligations,
    committed_boq: boqResult.committed_boq,
    draft_boq_pipeline: boqResult.draft_boq_pipeline,
    receipt_methods: {
      available: receiptMethods.available && settingsExtras.migration_applied,
      unbanked: receiptMethods.unbanked,
      unknown_method_count: receiptMethods.unknown_method_count,
      unknown_method_amount: receiptMethods.unknown_method_amount,
    },
  };
}
