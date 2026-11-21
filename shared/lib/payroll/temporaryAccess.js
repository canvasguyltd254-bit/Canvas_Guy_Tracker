/**
 * Temporary workers: roles, column allow-lists, input rules and DB-error mapping.
 * Pure and client-safe (its only import is another pure helper). The database functions are the authority; these
 * rules exist so the UI can guide users and the API can give clear errors early.
 * Spec: docs/specs/temporary-workers.md
 *
 *   admin               everything, including settings, approvals above the limit, voiding approved settlements
 *   production_manager  prepare/approve/pay within limits, link assignments
 *   head_of_sales       prepare/approve/pay within limits (no linking of Production assignments)
 *   anyone else         no access to rates, amounts, deductions or settlements
 */

import { isIsoDate } from '../customerReport.js';

export const TEMP_ROLES = Object.freeze(['admin', 'production_manager', 'head_of_sales']);
export const canUseTemporaryWorkers = (role) => TEMP_ROLES.includes(role);
export const canManageTemporarySettings = (role) => role === 'admin';
export const canVoidApprovedSettlement = (role) => role === 'admin';
export const canLinkAssignment = (role) => role === 'admin' || role === 'production_manager';
export const canApprovePayoutSheet = (role) => role === 'admin';

export const OTHER_REASON_MIN_CHARS = 20;
export const RECEIPT_BUCKET = 'temporary-worker-receipts';
export const RECEIPT_EXTENSIONS = Object.freeze(['.pdf', '.png', '.jpg', '.jpeg', '.heic']);
export const RECEIPT_MAX_BYTES = 15 * 1024 * 1024;

export const DEDUCTION_TYPES = Object.freeze([
  { value: 'cash_advance',       label: 'Cash advance',        refLabel: 'Advance voucher / reference', refRequired: true },
  { value: 'tools_or_materials', label: 'Tools or materials',  refLabel: 'Issue-slip / reference',      refRequired: true },
  { value: 'damage',             label: 'Damage',              refLabel: 'Evidence reference',          refRequired: true },
  { value: 'other',              label: 'Other',               refLabel: 'Reference (optional)',        refRequired: false },
]);

// ── Column allow-lists (explicit; never select('*')) ──────────────────────────
export const ENGAGEMENT_COLUMNS =
  'id, engagement_num, employee_id, order_id, agreed_daily_rate, start_date, expected_end_date, max_days, status, version, ' +
  'supersedes_id, notes, created_by, created_at, closed_by, closed_at, close_reason';
export const ENGAGEMENT_JOINS = 'employees(name, employee_num), orders(order_num, client)';
export const SETTLEMENT_COLUMNS =
  'id, settlement_num, engagement_id, employee_id, period_start, period_end, cutoff_date, units_included, base_amount, overtime_amount, ' +
  'sunday_amount, gross_amount, deductions_total, net_amount, kind, reason, status, prepared_by, prepared_at, approved_by, approved_at, ' +
  'approved_by_role, approval_override, override_reason, payout_sheet_id, paid_by, paid_at, received_by_full_name, payment_note, ' +
  'voided_by, voided_at, void_reason';
export const SETTLEMENT_JOINS = 'employees(name, employee_num), temporary_worker_engagements(engagement_num)';
export const LINE_COLUMNS =
  'id, settlement_id, time_entry_id, work_date, job_id, stage_id, attendance_units, base_amount, overtime_amount, sunday_amount, line_amount, active';
export const DEDUCTION_COLUMNS =
  'id, settlement_id, deduction_type, amount, reason, evidence_ref, recorded_by, recorded_at, approved_by, approved_at, ' +
  'approved_by_role, worker_acknowledged_at, active, voided_by, voided_at, void_reason';
export const SHEET_COLUMNS =
  'id, sheet_num, status, total_gross, total_deductions, total_net, admin_approved_by, admin_approved_at, printed_at, ' +
  'signed_receipt_uploaded_by, signed_receipt_uploaded_at, cancelled_by, cancelled_at, cancel_reason, created_by, created_at';
export const SETTINGS_COLUMNS =
  'settlement_threshold_units, admin_approval_limit_kes, rolling_window_days, deduction_single_limit_kes, deduction_total_pct, damage_deductions_enabled, updated_at';

// ── Input rules (mirrors the database; the database stays the authority) ──────
export const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
// The one strict calendar-date check used app-wide (UTC round trip: rejects 2026-02-30). Re-exported, not re-implemented.
export { isIsoDate };
export const isFullName = (v) => typeof v === 'string' && /^\S+(\s+\S+)+$/.test(v.trim());
export const positiveNumber = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** Returns an error message, or null when the deduction input is acceptable. */
export function validateDeductionInput({ type, amount, reason, ref }) {
  const t = DEDUCTION_TYPES.find(d => d.value === type);
  if (!t) return 'Choose a deduction type.';
  if (!positiveNumber(amount)) return 'Enter an amount above 0.';
  const r = String(reason || '').trim();
  if (!r) return 'A reason is required for every deduction.';
  if (type === 'other' && r.length < OTHER_REASON_MIN_CHARS) {
    return `For "Other", describe the reason in at least ${OTHER_REASON_MIN_CHARS} characters (${r.length}/${OTHER_REASON_MIN_CHARS}).`;
  }
  if (t.refRequired && !String(ref || '').trim()) return `${t.refLabel} is required for this deduction.`;
  return null;
}

/** Returns an error message, or null when the receiver name is acceptable. */
export const validateReceiverName = (v) => (isFullName(v) ? null : "Enter the receiver's full name (at least two names).");

// ── Database error mapping ────────────────────────────────────────────────────
// Our functions raise user-readable messages with SQLSTATE P0001; those are safe to show. Constraint
// violations (23xxx) and anything else get a generic message so internal names never reach the browser.
export function mapTemporaryDbError(error) {
  const code = error?.code || '';
  const message = String(error?.message || '');
  if (code === 'P0001') {
    if (/^Not allowed/.test(message)) return { status: 403, body: { error: 'You are not allowed to do that.', code: 'FORBIDDEN' } };
    if (/ not found$/i.test(message) || /^Worker not found/.test(message)) return { status: /Ask an administrator/.test(message) ? 422 : 404, body: { error: message, code: /Ask an administrator/.test(message) ? 'WORKER_NOT_REGISTERED' : 'NOT_FOUND' } };
    if (/^TEMP_ENGAGEMENT_OVERLAP:/.test(message)) return { status: 422, body: { error: message.replace(/^TEMP_ENGAGEMENT_OVERLAP:\s*/, ''), code: 'TEMP_ENGAGEMENT_OVERLAP' } };
    return { status: 422, body: { error: message, code: 'RULE' } };
  }
  // The migration has not been applied (or Supabase has not reloaded its schema cache since): say so plainly.
  if (['42P01', '42883', '42703', 'PGRST200', 'PGRST202', 'PGRST205'].includes(code)) {
    return { status: 503, body: { error: 'Temporary workers is not set up on this database yet. An administrator must run the temporary_workers_stage1 migration, then reload the Supabase schema cache.', code: 'SETUP_INCOMPLETE' } };
  }
  if (code === '23505') return { status: 409, body: { error: 'That already exists or was changed by someone else. Refresh and try again.', code: 'CONFLICT' } };
  if (code.startsWith('23')) return { status: 409, body: { error: 'That change is not allowed in the current state.', code: 'NOT_ALLOWED' } };
  if (code === '40P01' || code === '40001') return { status: 409, body: { error: 'Someone else was changing this at the same time. Try again.', code: 'RETRY' } };
  return { status: 500, body: { error: 'Something went wrong. Nothing was changed.', code: 'INTERNAL' } };
}

/** Map the DB error text raised by the payroll-entry overlap trigger (used by the payroll entries route). */
export const isTempOverlapError = (message) => /TEMP_ENGAGEMENT_OVERLAP/.test(String(message || ''));

/** True when an amount needs an admin: above the limit, or the limit/setting is missing (fail-closed). */
export function overApprovalLimit(settings, amount) {
  const limit = settings?.admin_approval_limit_kes;
  if (limit === null || limit === undefined) return true;
  return Number(amount) > Number(limit);
}

/** Same rule the database uses for deductions: a single one above the limit, or the total above a share of gross. */
export function deductionNeedsAdmin(settings, deduction, activeTotal, gross) {
  if (!settings) return true;
  return Number(deduction.amount) > Number(settings.deduction_single_limit_kes)
    || Number(activeTotal) > Number(gross) * Number(settings.deduction_total_pct) / 100;
}
