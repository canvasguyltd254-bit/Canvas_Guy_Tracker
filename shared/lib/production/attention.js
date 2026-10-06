/**
 * shared/lib/production/attention.js
 *
 * ONE place that decides why a production job needs attention. Pure: callers
 * pass in everything (including `today`), so it is deterministic and testable.
 * Every result carries an explicit code and a human sentence — nothing is a
 * bare flag. The Gantt, the Workshop control view and the prints must all read
 * from this, never re-derive their own rules.
 *
 * Severity: 'critical' = production is stuck or already late; 'warning' = will
 * become a problem or data is missing.
 */

export const DEFAULT_QC_WAITING_DAYS = 3;

const toMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const DAY = 86400000;
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
const fmt = (iso) => {
  const d = new Date(toMs(iso));
  return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`;
};

/**
 * @param {object} job
 *   { status, production_due_date, customer_due_date, awaiting_qc_qty,
 *     stages:[{stage_key,stage_label,start,end,status}], job_planned_start, job_planned_finish }
 * @param {object} ctx
 *   today: 'YYYY-MM-DD'
 *   blockers: [{id,reason,owner_name,expected_resolution_date,supplier_po_ref,stage_label}]  (open only)
 *   conflicts: [{employee_name,date,job_nums,allocated_hours,available_hours}]  (this job only)
 *   short_lines: [{material_name}]  materials marked short by the workshop
 *   qc_since: 'YYYY-MM-DD' | null   (when units last entered QC)
 *   qc_waiting_days: number         (setting; default 3)
 * @returns {Array<{code:string, severity:'critical'|'warning', message:string}>}
 */
export function jobAttention(job, ctx) {
  const out = [];
  const today = ctx.today;
  const add = (code, severity, message) => out.push({ code, severity, message });
  const stages = job.stages || [];
  const dated = stages.filter((s) => s.start && s.end);
  const lastEnd = dated.length ? dated.reduce((m, s) => (s.end > m ? s.end : m), dated[0].end) : null;
  const finished = job.status === 'Completed' || job.status === 'Cancelled';
  if (finished) return out;

  // ── Blockers (explicit: reason, owner, date) ───────────────────────────────
  for (const b of ctx.blockers || []) {
    const who = b.owner_name ? `owner ${b.owner_name}` : 'no owner';
    const when = b.expected_resolution_date ? `expected ${fmt(b.expected_resolution_date)}` : 'no expected date';
    add('blocked', 'critical', `Blocked: ${b.reason} (${who}, ${when}${b.supplier_po_ref ? `, ref ${b.supplier_po_ref}` : ''})`);
    if (!b.owner_name) add('blocker_no_owner', 'warning', `Blocker "${b.reason}" has no owner`);
    if (!b.expected_resolution_date) add('blocker_no_date', 'warning', `Blocker "${b.reason}" has no expected resolution date`);
    else if (b.expected_resolution_date < today) {
      add('blocker_overdue', 'critical', `Blocker "${b.reason}" was expected ${fmt(b.expected_resolution_date)} — ${daysBetween(b.expected_resolution_date, today)} day(s) overdue`);
    }
  }

  // ── Materials marked short ────────────────────────────────────────────────
  const shorts = ctx.short_lines || [];
  if (shorts.length) {
    const names = shorts.slice(0, 3).map((m) => m.material_name).join(', ') + (shorts.length > 3 ? `, +${shorts.length - 3} more` : '');
    const hasBlocker = (ctx.blockers || []).length > 0;
    add('material_short', hasBlocker ? 'warning' : 'critical',
      `${shorts.length} material line(s) short: ${names}${hasBlocker ? '' : ' — no blocker raised (moving dates will not fix a shortage)'}`);
  }

  // ── Dates ──────────────────────────────────────────────────────────────────
  if (!job.production_due_date) {
    add('no_production_due', 'warning', 'No production due date set');
  } else {
    if (job.production_due_date < today) {
      add('past_production_due', 'critical', `Production due ${fmt(job.production_due_date)} has passed and the job is not finished`);
    }
    if (lastEnd && lastEnd > job.production_due_date) {
      add('late_vs_production_due', 'critical', `Schedule ends ${fmt(lastEnd)}, after production due ${fmt(job.production_due_date)}`);
    }
    if (job.customer_due_date && job.production_due_date > job.customer_due_date) {
      add('production_due_after_customer', 'critical', `Production due ${fmt(job.production_due_date)} is after customer delivery ${fmt(job.customer_due_date)}`);
    }
  }
  if (!dated.length) {
    add('not_scheduled', 'warning', 'No stage is scheduled');
  } else {
    const sorted = [...dated].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) {
        add('stage_overlap', 'warning', `${sorted[i].stage_label || sorted[i].stage_key} starts before ${sorted[i - 1].stage_label || sorted[i - 1].stage_key} ends`);
      }
    }
  }

  // ── Scheduled stage with nobody assigned ───────────────────────────────────
  for (const st of dated) {
    if (st.status === 'completed' || (st.planned_quantity ?? 1) <= 0) continue;
    if ((st.workers || []).length) continue;
    const started = st.start <= today;
    add('scheduled_stage_unassigned', started ? 'critical' : 'warning',
      `${st.stage_label || st.stage_key} is scheduled ${fmt(st.start)} – ${fmt(st.end)} with no workers assigned${started ? ' — it should already have started' : ''}`);
  }

  // ── Rework waiting ─────────────────────────────────────────────────────────
  if ((job.rework_qty || 0) > 0) {
    add('rework_pending', 'warning', `${job.rework_qty} unit(s) failed QC and are waiting for rework`);
  }

  // ── Worker capacity (explicit employee / date / jobs / hours) ──────────────
  for (const c of ctx.conflicts || []) {
    add('worker_conflict', 'warning',
      `${c.employee_name || 'Worker'} on ${fmt(c.date)}: ${c.allocated_hours}h allocated of ${c.available_hours}h (${(c.job_nums || []).join(', ')})`);
  }

  // ── QC waiting ─────────────────────────────────────────────────────────────
  const limit = ctx.qc_waiting_days ?? DEFAULT_QC_WAITING_DAYS;
  if ((job.awaiting_qc_qty || 0) > 0) {
    if (!ctx.qc_since) {
      add('qc_waiting_unknown', 'warning', `${job.awaiting_qc_qty} unit(s) awaiting QC — waiting time unknown`);
    } else {
      const waited = daysBetween(ctx.qc_since, today);
      if (waited > limit) {
        add('qc_waiting', 'warning', `${job.awaiting_qc_qty} unit(s) waiting for QC ${waited} days (limit ${limit})`);
      }
    }
  }
  return out;
}

export function worstSeverity(reasons) {
  if (reasons.some((r) => r.severity === 'critical')) return 'critical';
  if (reasons.length) return 'warning';
  return null;
}
