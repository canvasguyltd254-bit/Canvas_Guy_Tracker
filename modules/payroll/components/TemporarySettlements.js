'use client';

/**
 * Temporary workers: settlements, deductions, payout sheets and payment.
 * The screen guides; the database decides. Every button maps to one database function behind /api/payroll/temporary.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { C } from '@/shared/ui/ds';
import { createClient } from '@/shared/supabase/client';
import {
  canVoidApprovedSettlement, canApprovePayoutSheet, overApprovalLimit, deductionNeedsAdmin,
  validateDeductionInput, validateReceiverName, DEDUCTION_TYPES, OTHER_REASON_MIN_CHARS,
} from '@/shared/lib/payroll/temporaryAccess';
import {
  api, fmt, fmtD, fmtDT, inputStyle, Badge, AdminBadge, Spinner, Banner, Empty, Modal, Field, Btn, th, td, num, Table,
} from './payrollUi';

const supabase = createClient();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ════════════════════════════════════════════════════════════════
// Settlements list
// ════════════════════════════════════════════════════════════════
export function SettlementsPanel({ role, userId, settings, refreshKey, onChanged, focusId, onFocusDone, onOpenSheet }) {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api('GET', `/api/payroll/temporary/settlements${status ? `?status=${status}` : ''}`);
    if (r.ok) setRows(r.data.settlements); else setError(r.error);
    setLoading(false);
  }, [status]);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => { if (focusId) { setOpenId(focusId); onFocusDone?.(); } }, [focusId, onFocusDone]);

  return (
    <div>
      <Banner message={error} onDismiss={() => setError('')} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...inputStyle, width: 180 }} aria-label="Filter by status">
          <option value="">All statuses</option>
          {['draft', 'approved', 'paid', 'voided'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={{ fontSize: 12, color: C.muted }}>A settlement pays every marked, unsettled day up to its cutoff. Paid settlements are final.</span>
      </div>
      {loading ? <Spinner /> : rows.length === 0 ? <Empty>No settlements yet. When a worker is due, open “Due for payment” and choose “Prepare settlement”.</Empty> : (
        <Table>
          <thead><tr><th style={th}>Settlement</th><th style={th}>Worker</th><th style={th}>Period</th><th style={{ ...th, ...num }}>Days</th><th style={{ ...th, ...num }}>Gross</th><th style={{ ...th, ...num }}>Deductions</th><th style={{ ...th, ...num }}>Net cash</th><th style={th}>Status</th><th style={th} /></tr></thead>
          <tbody>
            {rows.map(s => (
              <tr key={s.id}>
                <td style={td}><strong>{s.settlement_num}</strong><div style={{ fontSize: 11, color: C.muted }}>{s.temporary_worker_engagements?.engagement_num}</div></td>
                <td style={td}>{s.employees?.name}<div style={{ fontSize: 11, color: C.muted }}>{s.employees?.employee_num}</div></td>
                <td style={td}>{fmtD(s.period_start)} – {fmtD(s.period_end)}</td>
                <td style={{ ...td, ...num }}>{fmt(s.units_included)}</td>
                <td style={{ ...td, ...num }}>{fmt(s.gross_amount)}</td>
                <td style={{ ...td, ...num }}>{Number(s.deductions_total) ? fmt(s.deductions_total) : '—'}</td>
                <td style={{ ...td, ...num }}><strong>{fmt(s.net_amount)}</strong></td>
                <td style={td}><Badge label={s.status} />{s.status === 'draft' && overApprovalLimit(settings, s.gross_amount) && <div style={{ marginTop: 4 }}><AdminBadge /></div>}</td>
                <td style={td}><Btn small variant="secondary" onClick={() => setOpenId(s.id)}>Open</Btn></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {openId && <SettlementModal id={openId} role={role} userId={userId} settings={settings} onOpenSheet={onOpenSheet ? (sid) => { setOpenId(null); onOpenSheet(sid); } : undefined} onClose={() => setOpenId(null)} onChanged={() => { load(); onChanged?.(); }} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// One settlement: lines, deductions, approve / void
// ════════════════════════════════════════════════════════════════
// One plain sentence saying what to do next, for whoever is looking at this settlement.
function nextStep(s, { unapproved, canApprove, isAdmin, needsAdmin, iPrepared }) {
  if (s.status === 'draft') {
    if (unapproved > 0) return `${unapproved} deduction${unapproved > 1 ? 's' : ''} need approving by someone other than the person who recorded ${unapproved > 1 ? 'them' : 'it'}.`;
    if (isAdmin) return iPrepared ? 'Check the days and deductions, then approve it. You prepared it, so an override reason is needed.' : 'Check the days and deductions, then approve it.';
    if (needsAdmin) return 'This is above the approval limit, so an admin must approve it. Add any deductions first.';
    if (iPrepared) return 'You prepared this, so someone else must approve it. Add any deductions first.';
    return canApprove ? 'Check the days and deductions, then approve it.' : 'Add any deductions, then have it approved.';
  }
  if (s.status === 'approved') return s.payout_sheet_id ? 'Continue in “Payout sheets”: print, get the worker’s signature, upload it, then mark paid.' : 'Create a payout sheet for this settlement.';
  if (s.status === 'paid') return 'Nothing. This settlement is paid and final.';
  return 'Nothing. This settlement was voided and its days can be settled again.';
}

function SettlementModal({ id, role, userId, settings, onClose, onChanged, onOpenSheet }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [override, setOverride] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [showVoid, setShowVoid] = useState(false);
  const [removing, setRemoving] = useState(null);      // deduction id being removed (inline reason form, no browser pop-up)
  const [removeReason, setRemoveReason] = useState('');

  const load = useCallback(async () => {
    const r = await api('GET', `/api/payroll/temporary/settlements/${id}`);
    if (r.ok) setD(r.data); else setError(r.error);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (key, fn) => {
    setBusy(key); setError('');
    const r = await fn();
    setBusy('');
    if (!r.ok) { setError(r.error); return false; }
    await load(); onChanged?.(); return true;
  };

  if (!d) return <Modal title="Settlement" onClose={onClose}>{error ? <Banner message={error} /> : <Spinner />}</Modal>;
  const s = d.settlement;
  const isAdmin = role === 'admin';
  const needsAdmin = overApprovalLimit(settings, s.gross_amount);
  const activeDeds = d.deductions.filter(x => x.active);
  const dedTotal = activeDeds.reduce((a, x) => a + Number(x.amount), 0);
  const iPrepared = s.prepared_by === userId;
  const canApprove = s.status === 'draft' && (isAdmin || (!needsAdmin && !iPrepared));
  const approveBlock = s.status !== 'draft' ? '' : (!isAdmin && needsAdmin)
    ? (settings ? `Above KES ${fmt(settings.admin_approval_limit_kes ?? 0)} — an admin must approve.` : 'The approval limit is not set — an admin must approve.')
    : (!isAdmin && iPrepared) ? 'You prepared this settlement — someone else must approve it.' : '';
  const unapproved = activeDeds.filter(x => !x.approved_by).length;

  return (
    <Modal title={`${s.settlement_num} · ${s.employees?.name || ''}`} onClose={onClose} width={760}>
      <Banner message={error} onDismiss={() => setError('')} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <Badge label={s.status} />
        <Badge label={s.kind.replace('_', '-')} tone={['#f3f4f6', '#374151']} />
        {needsAdmin && s.status === 'draft' && <AdminBadge />}
        {s.approval_override && <Badge label="admin override" tone={['#fff5d9', '#96620a']} />}
        <span style={{ fontSize: 12, color: C.muted }}>{fmtD(s.period_start)} – {fmtD(s.period_end)} · cutoff {fmtD(s.cutoff_date)} · prepared {fmtDT(s.prepared_at)}</span>
      </div>
      <div data-testid="next-step" style={{ fontSize: 12, color: C.ink, background: C.bg, borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
        <strong>Next:</strong> {nextStep(s, { unapproved, canApprove, isAdmin, needsAdmin, iPrepared })}
      </div>
      {s.reason && <Banner tone="info" message={`Reason: ${s.reason}`} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
        {[['Days', fmt(s.units_included)], ['Gross', `KES ${fmt(s.gross_amount)}`], ['Deductions', `KES ${fmt(s.deductions_total)}`], ['Net cash', `KES ${fmt(s.net_amount)}`]].map(([k, v]) => (
          <div key={k} style={{ background: C.bg, borderRadius: 9, padding: '10px 12px' }}><div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase' }}>{k}</div><div style={{ fontSize: 16, fontWeight: 800 }}>{v}</div></div>
        ))}
      </div>

      <h4 style={{ margin: '4px 0 6px', fontSize: 13 }}>Days included ({d.lines.filter(l => l.active).length})</h4>
      <Table>
        <thead><tr><th style={th}>Date</th><th style={{ ...th, ...num }}>Days</th><th style={{ ...th, ...num }}>Amount</th></tr></thead>
        <tbody>{d.lines.map(l => (
          <tr key={l.id} style={{ opacity: l.active ? 1 : 0.45 }}>
            <td style={td}>{fmtD(l.work_date)}</td><td style={{ ...td, ...num }}>{fmt(l.attendance_units)}</td><td style={{ ...td, ...num }}>{fmt(l.line_amount)}</td>
          </tr>))}</tbody>
      </Table>

      <h4 style={{ margin: '16px 0 6px', fontSize: 13 }}>Deductions</h4>
      {d.deductions.length === 0 ? <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>No deductions. Only operational deductions are allowed; statutory deductions do not apply to temporary workers.</div> : (
        <Table>
          <thead><tr><th style={th}>Type</th><th style={{ ...th, ...num }}>Amount</th><th style={th}>Reason / reference</th><th style={th}>Approval</th><th style={th} /></tr></thead>
          <tbody>{d.deductions.map(x => {
            const admin = deductionNeedsAdmin(settings, x, dedTotal, s.gross_amount);
            return (
              <tr key={x.id} style={{ opacity: x.active ? 1 : 0.45, textDecoration: x.active ? 'none' : 'line-through' }}>
                <td style={td}>{x.deduction_type.replace(/_/g, ' ')}</td>
                <td style={{ ...td, ...num }}>{fmt(x.amount)}</td>
                <td style={td}>{x.reason}{x.evidence_ref && <div style={{ fontSize: 11, color: C.muted }}>Ref: {x.evidence_ref}</div>}{!x.active && <div style={{ fontSize: 11 }}>Voided: {x.void_reason}</div>}</td>
                <td style={td}>{!x.active ? '—' : x.approved_by ? <Badge label={`approved · ${x.approved_by_role.replace(/_/g, ' ')}`} tone={['#dcfce7', '#166534']} /> : <Badge label="pending" tone={['#fef9c3', '#854d0e']} />}
                  {x.active && admin && (!x.approved_by || x.approved_by_role !== 'admin') && <div style={{ marginTop: 4 }}><AdminBadge /></div>}
                  {x.worker_acknowledged_at && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Acknowledged on signed sheet</div>}</td>
                <td style={td}>{s.status === 'draft' && x.active && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(!x.approved_by || (isAdmin && x.approved_by_role !== 'admin' && admin)) && (
                      <Btn small variant="success" loading={busy === `a${x.id}`} disabled={x.recorded_by === userId || (admin && !isAdmin)}
                        title={x.recorded_by === userId ? 'You recorded this — someone else must approve it' : admin && !isAdmin ? 'Needs an admin' : ''}
                        onClick={() => act(`a${x.id}`, () => api('PATCH', `/api/payroll/temporary/deductions/${x.id}`, { action: 'approve' }))}>Approve</Btn>)}
                    <Btn small variant="danger" onClick={() => { setRemoving(removing === x.id ? null : x.id); setRemoveReason(''); }}>Remove…</Btn>
                  </div>)}</td>
              </tr>);
          })}</tbody>
        </Table>
      )}
      {removing && s.status === 'draft' && (
        <div style={{ marginTop: 10, background: C.redBg, border: `1px solid ${C.redBd}`, borderRadius: 9, padding: 12 }}>
          <Field label="Why is this deduction being removed?" required><input style={inputStyle} value={removeReason} onChange={(e) => setRemoveReason(e.target.value)} /></Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="danger" disabled={!removeReason.trim()} loading={busy === `v${removing}`}
              onClick={async () => { if (await act(`v${removing}`, () => api('PATCH', `/api/payroll/temporary/deductions/${removing}`, { action: 'void', reason: removeReason }))) { setRemoving(null); setRemoveReason(''); } }}>Remove deduction</Btn>
            <Btn variant="secondary" onClick={() => { setRemoving(null); setRemoveReason(''); }}>Keep it</Btn>
          </div>
        </div>)}
      {s.status === 'draft' && <AddDeduction settlementId={id} settings={settings} onAdded={async () => { await load(); onChanged?.(); }} setError={setError} />}

      {s.status === 'draft' && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
          {unapproved > 0 && <Banner tone="warn" message={`${unapproved} deduction${unapproved > 1 ? 's' : ''} still need approval before the settlement can be approved.`} />}
          {approveBlock && <Banner tone="warn" message={approveBlock} />}
          {isAdmin && (
            <Field label="Admin override reason" hint="Only needed if you prepared this settlement or marked any of its days. It is stored and logged.">
              <input style={inputStyle} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Why are you approving your own work?" />
            </Field>)}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="success" disabled={!canApprove || unapproved > 0} loading={busy === 'approve'}
              onClick={() => act('approve', () => api('PATCH', `/api/payroll/temporary/settlements/${id}`, { action: 'approve', override_reason: override || undefined }))}>Approve settlement</Btn>
            <Btn variant="danger" onClick={() => setShowVoid(v => !v)}>Void…</Btn>
          </div>
        </div>)}

      {s.status === 'approved' && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
          <Banner tone="info" message={s.payout_sheet_id ? 'This settlement is on a payout sheet. Continue in “Payout sheets”.' : `Approved by ${s.approved_by_role?.replace(/_/g, ' ')} on ${fmtDT(s.approved_at)}. Add it to a payout sheet to pay it.`} />
          {s.approval_override && <Banner tone="warn" message={`Admin override: ${s.override_reason}`} />}
          {!s.payout_sheet_id && (
            <div style={{ marginBottom: 10 }}>
              <Btn loading={busy === 'sheet'} onClick={async () => {
                setBusy('sheet'); setError('');
                const r = await api('POST', '/api/payroll/temporary/payout-sheets', { settlement_ids: [id] });
                setBusy('');
                if (!r.ok) { setError(r.error); return; }
                onChanged?.(); if (onOpenSheet) onOpenSheet(r.data.data); else await load();
              }}>Create payout sheet</Btn>
            </div>)}
          {canVoidApprovedSettlement(role) ? <Btn variant="danger" onClick={() => setShowVoid(v => !v)}>Void…</Btn> : <div style={{ fontSize: 12, color: C.muted }}>Only an admin can void an approved settlement.</div>}
        </div>)}

      {s.status === 'paid' && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
          <Banner tone="info" message={`Paid in cash — KES ${fmt(s.net_amount)} to ${s.received_by_full_name} on ${fmtDT(s.paid_at)}.${s.payment_note ? ` Note: ${s.payment_note}` : ''}`} />
          <div style={{ fontSize: 12, color: C.muted }}>Paid settlements are final: they cannot be voided or edited, and their days cannot be paid again.</div>
        </div>)}
      {s.status === 'voided' && <Banner tone="info" message={`Voided ${fmtDT(s.voided_at)}: ${s.void_reason}. The days are free to be settled again.`} />}

      {showVoid && (s.status === 'draft' || (s.status === 'approved' && canVoidApprovedSettlement(role))) && (
        <div style={{ marginTop: 12, background: C.redBg, border: `1px solid ${C.redBd}`, borderRadius: 9, padding: 12 }}>
          <Field label="Reason for voiding" required><input style={inputStyle} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /></Field>
          <Btn variant="danger" disabled={!voidReason.trim()} loading={busy === 'void'}
            onClick={async () => { if (await act('void', () => api('PATCH', `/api/payroll/temporary/settlements/${id}`, { action: 'void', reason: voidReason }))) { setShowVoid(false); setVoidReason(''); } }}>Void settlement</Btn>
        </div>)}
    </Modal>
  );
}

function AddDeduction({ settlementId, settings, onAdded, setError }) {
  const [open, setOpen] = useState(false);
  const blank = { deduction_type: 'cash_advance', amount: '', reason: '', evidence_ref: '' };
  const [f, setF] = useState(blank);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const meta = DEDUCTION_TYPES.find(t => t.value === f.deduction_type);
  const err = validateDeductionInput({ type: f.deduction_type, amount: f.amount, reason: f.reason, ref: f.evidence_ref });
  const len = f.reason.trim().length;
  const damageOff = f.deduction_type === 'damage' && settings && settings.damage_deductions_enabled === false;
  if (!open) return <Btn small variant="secondary" onClick={() => setOpen(true)}>+ Add deduction</Btn>;
  return (
    <div style={{ background: C.bg, borderRadius: 10, padding: 14, marginTop: 8 }}>
      <Field label="Type" required>
        <select style={inputStyle} value={f.deduction_type} onChange={(e) => setF({ ...f, deduction_type: e.target.value })}>
          {DEDUCTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>
      {damageOff && <Banner tone="warn" message="Damage deductions are switched off in settings." />}
      <Field label="Amount (KES)" required><input style={inputStyle} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      <Field label="Reason" required hint={f.deduction_type === 'other' ? `${len}/${OTHER_REASON_MIN_CHARS} characters minimum` : undefined}>
        <textarea style={{ ...inputStyle, minHeight: 60 }} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        {f.deduction_type === 'other' && (
          <div aria-live="polite" style={{ fontSize: 12, marginTop: 4, color: len >= OTHER_REASON_MIN_CHARS ? C.green : C.amber, fontWeight: 600 }}>
            {len}/{OTHER_REASON_MIN_CHARS}{len < OTHER_REASON_MIN_CHARS ? ` — add ${OTHER_REASON_MIN_CHARS - len} more character${OTHER_REASON_MIN_CHARS - len === 1 ? '' : 's'} so the reason is specific` : ' ✓'}
          </div>)}
      </Field>
      <Field label={meta.refLabel} required={meta.refRequired}><input style={inputStyle} value={f.evidence_ref} onChange={(e) => setF({ ...f, evidence_ref: e.target.value })} /></Field>
      {touched && err && <Banner message={err} />}
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn loading={saving} disabled={!!damageOff} onClick={async () => {
          setTouched(true); if (err) return;
          setSaving(true); const r = await api('POST', `/api/payroll/temporary/settlements/${settlementId}/deductions`, f); setSaving(false);
          if (!r.ok) { setError(r.error); return; }
          setF(blank); setTouched(false); setOpen(false); onAdded();
        }}>Add deduction</Btn>
        <Btn variant="secondary" onClick={() => { setOpen(false); setF(blank); setTouched(false); }}>Cancel</Btn>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>A different person must approve each deduction. Over KES {fmt(settings?.deduction_single_limit_kes ?? 1000)} on its own, or over {settings?.deduction_total_pct ?? 25}% of gross in total, needs an admin.</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Payout sheets
// ════════════════════════════════════════════════════════════════
export function SheetsPanel({ role, userId, settings, refreshKey, onChanged, focusId, onFocusDone }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api('GET', '/api/payroll/temporary/payout-sheets');
    if (r.ok) setRows(r.data.sheets); else setError(r.error);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => { if (focusId) { setOpenId(focusId); onFocusDone?.(); } }, [focusId, onFocusDone]);

  return (
    <div>
      <Banner message={error} onDismiss={() => setError('')} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: C.muted, maxWidth: 560 }}>Cash is paid from a payout sheet: create it for one settlement, print it, have the worker sign, upload the signed copy, then mark the settlement paid.</span>
        <Btn onClick={() => setShowNew(true)}>+ New payout sheet</Btn>
      </div>
      {loading ? <Spinner /> : rows.length === 0 ? <Empty>No payout sheets yet. Approve a settlement first, then create its sheet from the settlement or with “+ New payout sheet”.</Empty> : (
        <Table>
          <thead><tr><th style={th}>Sheet</th><th style={th}>Created</th><th style={{ ...th, ...num }}>Gross</th><th style={{ ...th, ...num }}>Deductions</th><th style={{ ...th, ...num }}>Net cash</th><th style={th}>Status</th><th style={th} /></tr></thead>
          <tbody>{rows.map(sh => (
            <tr key={sh.id}>
              <td style={td}><strong>{sh.sheet_num}</strong></td><td style={td}>{fmtD(sh.created_at)}</td>
              <td style={{ ...td, ...num }}>{fmt(sh.total_gross)}</td><td style={{ ...td, ...num }}>{fmt(sh.total_deductions)}</td><td style={{ ...td, ...num }}><strong>{fmt(sh.total_net)}</strong></td>
              <td style={td}><Badge label={sh.status} />{['open', 'printed'].includes(sh.status) && overApprovalLimit(settings, sh.total_net) && !sh.admin_approved_by && <div style={{ marginTop: 4 }}><AdminBadge /></div>}</td>
              <td style={td}><Btn small variant="secondary" onClick={() => setOpenId(sh.id)}>Open</Btn></td>
            </tr>))}</tbody>
        </Table>)}
      {showNew && <NewSheetModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); load(); onChanged?.(); setOpenId(id); }} />}
      {openId && <SheetModal id={openId} role={role} userId={userId} settings={settings} onClose={() => setOpenId(null)} onChanged={() => { load(); onChanged?.(); }} />}
    </div>
  );
}

function NewSheetModal({ onClose, onCreated }) {
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(null);      // one settlement per sheet
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { (async () => {
    const r = await api('GET', '/api/payroll/temporary/settlements?status=approved');
    if (r.ok) setRows(r.data.settlements.filter(s => !s.payout_sheet_id)); else setError(r.error);
  })(); }, []);
  const chosen = (rows || []).find(s => s.id === picked);
  return (
    <Modal title="New payout sheet" onClose={onClose} width={640}>
      <Banner message={error} />
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>One sheet covers one worker’s settlement, so the signed copy matches exactly one payment. Create a separate sheet for each worker.</div>
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty>No approved settlements are waiting for a sheet.</Empty> : (
        <>
          <Table>
            <thead><tr><th style={th} /><th style={th}>Settlement</th><th style={th}>Worker</th><th style={{ ...th, ...num }}>Net cash</th></tr></thead>
            <tbody>{rows.map(s => (
              <tr key={s.id}><td style={td}><input type="radio" name="sheet-settlement" aria-label={`Select ${s.settlement_num}`} checked={picked === s.id} onChange={() => setPicked(s.id)} /></td>
                <td style={td}>{s.settlement_num}</td><td style={td}>{s.employees?.name}</td><td style={{ ...td, ...num }}>{fmt(s.net_amount)}</td></tr>))}</tbody>
          </Table>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <strong>{chosen ? `${chosen.employees?.name} · KES ${fmt(chosen.net_amount)}` : 'Choose a settlement'}</strong>
            <Btn loading={saving} disabled={!chosen} onClick={async () => {
              setSaving(true); const r = await api('POST', '/api/payroll/temporary/payout-sheets', { settlement_ids: [picked] }); setSaving(false);
              if (!r.ok) setError(r.error); else onCreated(r.data.data);
            }}>Create sheet</Btn>
          </div>
        </>)}
    </Modal>
  );
}

function printSheet(d) {
  const { sheet, settlements, deductions } = d;
  const byS = {}; deductions.forEach(x => { (byS[x.settlement_id] ||= []).push(x); });
  const rows = settlements.map(s => `
    <tr><td>${esc(s.employees?.name)}<br><small>${esc(s.employees?.employee_num)} · ${esc(s.settlement_num)}</small></td>
    <td class="n">${fmt(s.units_included)}</td><td class="n">${fmt(s.gross_amount)}</td>
    <td>${(byS[s.id] || []).map(x => `${esc(x.deduction_type.replace(/_/g, ' '))}: ${fmt(x.amount)}<br><small>${esc(x.reason)}${x.evidence_ref ? ' · ' + esc(x.evidence_ref) : ''}</small>`).join('<br>') || '—'}</td>
    <td class="n"><strong>${fmt(s.net_amount)}</strong></td><td class="sig"></td></tr>`).join('');
  const w = window.open('', '_blank', 'width=1000,height=800');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><title>${esc(sheet.sheet_num)}</title><style>
    body{font-family:Arial,sans-serif;margin:24px;color:#111} h1{font-size:20px;margin:0} .sub{color:#555;font-size:12px;margin:4px 0 16px}
    table{width:100%;border-collapse:collapse;font-size:12px} th,td{border:1px solid #999;padding:7px;vertical-align:top;text-align:left}
    th{background:#eee} .n{text-align:right;white-space:nowrap} .sig{width:170px;height:46px} small{color:#555}
    .tot td{font-weight:bold;background:#f6f6f6} .note{font-size:11px;margin-top:14px;color:#333}
    @media print{button{display:none}}
  </style></head><body>
    <button onclick="window.print()">Print</button>
    <h1>Canvas Guy Limited — Cash payout sheet ${esc(sheet.sheet_num)}</h1>
    <div class="sub">Temporary workers · cash payment · printed ${esc(new Date().toLocaleString('en-KE'))}</div>
    <table><thead><tr><th>Worker</th><th class="n">Days</th><th class="n">Gross (KES)</th><th>Deductions (KES)</th><th class="n">Cash received (KES)</th><th>Signature</th></tr></thead>
    <tbody>${rows}<tr class="tot"><td>Total</td><td></td><td class="n">${fmt(sheet.total_gross)}</td><td class="n">${fmt(sheet.total_deductions)}</td><td class="n">${fmt(sheet.total_net)}</td><td></td></tr></tbody></table>
    <p class="note">By signing, the worker confirms the days worked, the deductions listed, and receipt of the cash shown. Paid by: ____________________ Date: ____________</p>
  </body></html>`);
  w.document.close();
  return true;
}

function SheetModal({ id, role, userId, settings, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [payFor, setPayFor] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);

  const load = useCallback(async () => {
    const r = await api('GET', `/api/payroll/temporary/payout-sheets/${id}`);
    if (r.ok) setD(r.data); else setError(r.error);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const patch = (body) => api('PATCH', `/api/payroll/temporary/payout-sheets/${id}`, body);
  const act = async (key, fn) => { setBusy(key); setError(''); const r = await fn(); setBusy(''); if (!r.ok) { setError(r.error); return false; } await load(); onChanged?.(); return true; };

  if (!d) return <Modal title="Payout sheet" onClose={onClose}>{error ? <Banner message={error} /> : <Spinner />}</Modal>;
  const { sheet, settlements } = d;
  const needsAdmin = overApprovalLimit(settings, sheet.total_net);
  const adminOk = !needsAdmin || !!sheet.admin_approved_by;
  const isAdmin = canApprovePayoutSheet(role);
  const anyPaid = settlements.some(s => s.status === 'paid');
  const canCancel = !anyPaid && sheet.status !== 'cancelled' && (sheet.status !== 'signed' || isAdmin);

  const upload = async (file) => {
    if (!file) return;
    setBusy('upload'); setError('');
    const init = await patch({ action: 'receipt_init', file_name: file.name, file_size: file.size });
    if (!init.ok) { setBusy(''); setError(init.error); return; }
    const up = await supabase.storage.from(init.data.bucket).uploadToSignedUrl(init.data.path, init.data.token, file);
    if (up.error) { setBusy(''); setError('The upload failed. Check your connection and try again.'); return; }
    const done = await patch({ action: 'receipt_complete', path: init.data.path });
    setBusy('');
    if (!done.ok) { setError(done.error); return; }
    await load(); onChanged?.();
  };

  return (
    <Modal title={`Payout sheet ${sheet.sheet_num}`} onClose={onClose} width={820}>
      <Banner message={error} onDismiss={() => setError('')} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Badge label={sheet.status} />
        {needsAdmin && !sheet.admin_approved_by && sheet.status !== 'cancelled' && <AdminBadge text="Admin approval needed (sheet above limit)" />}
        {sheet.admin_approved_by && <Badge label="admin approved" tone={['#dcfce7', '#166534']} />}
        <span style={{ fontSize: 13 }}>Gross KES {fmt(sheet.total_gross)} · Deductions KES {fmt(sheet.total_deductions)} · <strong>Cash KES {fmt(sheet.total_net)}</strong></span>
      </div>

      <ol style={{ fontSize: 12, color: C.muted, paddingLeft: 18, margin: '0 0 14px' }}>
        <li style={{ fontWeight: sheet.status === 'open' ? 700 : 400, color: sheet.status === 'open' ? C.ink : undefined }}>Create the sheet {needsAdmin ? '(an admin approves it because it is above the limit)' : ''}</li>
        <li style={{ fontWeight: sheet.status === 'printed' ? 700 : 400, color: sheet.status === 'printed' ? C.ink : undefined }}>Print it and have the worker sign next to their cash</li>
        <li style={{ fontWeight: sheet.status === 'signed' ? 700 : 400, color: sheet.status === 'signed' ? C.ink : undefined }}>Upload a photo or scan of the signed sheet</li>
        <li>Mark the settlement paid (receiver’s full name; a different person from the preparer)</li>
      </ol>

      <Table>
        <thead><tr><th style={th}>Worker</th><th style={{ ...th, ...num }}>Gross</th><th style={{ ...th, ...num }}>Deductions</th><th style={{ ...th, ...num }}>Cash</th><th style={th}>Status</th><th style={th} /></tr></thead>
        <tbody>{settlements.map(s => {
          const sameUser = s.prepared_by === userId;
          return (
            <tr key={s.id}>
              <td style={td}>{s.employees?.name}<div style={{ fontSize: 11, color: C.muted }}>{s.settlement_num}</div></td>
              <td style={{ ...td, ...num }}>{fmt(s.gross_amount)}</td><td style={{ ...td, ...num }}>{Number(s.deductions_total) ? fmt(s.deductions_total) : '—'}</td><td style={{ ...td, ...num }}><strong>{fmt(s.net_amount)}</strong></td>
              <td style={td}><Badge label={s.status} />{s.status === 'paid' && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Received by {s.received_by_full_name}<br />{fmtDT(s.paid_at)}</div>}</td>
              <td style={td}>{s.status === 'approved' && sheet.status === 'signed' && adminOk && (
                <Btn small variant="success" disabled={sameUser} title={sameUser ? 'You prepared this settlement — someone else must pay it' : ''} onClick={() => setPayFor(s)}>Mark paid</Btn>)}</td>
            </tr>);
        })}</tbody>
      </Table>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
        {['open', 'printed'].includes(sheet.status) && isAdmin && needsAdmin && !sheet.admin_approved_by && (
          <Btn variant="success" loading={busy === 'approve'} onClick={() => act('approve', () => patch({ action: 'approve' }))}>Approve sheet (admin)</Btn>)}
        {['open', 'printed', 'signed'].includes(sheet.status) && (
          <Btn variant={sheet.status === 'open' ? 'primary' : 'secondary'} loading={busy === 'print'} disabled={sheet.status === 'open' && !adminOk}
            title={sheet.status === 'open' && !adminOk ? 'An admin must approve this sheet first' : ''}
            onClick={async () => {
              if (!printSheet(d)) { setError('Your browser blocked the print window. Allow pop-ups for this site and try again.'); return; }
              if (sheet.status === 'open') await act('print', () => patch({ action: 'print' }));
            }}>{sheet.status === 'open' ? 'Print sheet' : 'Reprint'}</Btn>)}
        {sheet.status === 'printed' && (
          <label style={{ display: 'inline-flex' }}>
            <input type="file" accept=".pdf,.png,.jpg,.jpeg,.heic,image/*" style={{ display: 'none' }} disabled={busy === 'upload'} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
            <span style={{ padding: '9px 15px', borderRadius: 8, background: C.coral, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: busy === 'upload' ? 0.5 : 1 }}>{busy === 'upload' ? 'Uploading…' : 'Upload signed copy'}</span>
          </label>)}
        {sheet.status === 'signed' && (
          <Btn variant="secondary" onClick={async () => { const r = await patch({ action: 'receipt_url' }); if (r.ok) window.open(r.data.url, '_blank', 'noopener'); else setError(r.error); }}>View signed copy</Btn>)}
        {canCancel && <Btn variant="danger" onClick={() => setShowCancel(v => !v)}>Cancel sheet…</Btn>}
      </div>
      {sheet.status === 'signed' && !anyPaid && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>The signed copy shows the worker acknowledged the deductions. It proves a signed document exists; counting the cash in front of a witness is still good practice.</div>}
      {sheet.status === 'cancelled' && <Banner tone="info" message={`Cancelled ${fmtDT(sheet.cancelled_at)}: ${sheet.cancel_reason}. A cancelled sheet is never reused; its settlements are free to join a new sheet.`} />}
      {sheet.status === 'signed' && !isAdmin && <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>Only an admin can cancel a signed sheet.</div>}

      {showCancel && canCancel && (
        <div style={{ marginTop: 12, background: C.redBg, border: `1px solid ${C.redBd}`, borderRadius: 9, padding: 12 }}>
          <Field label="Reason for cancelling" required><input style={inputStyle} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></Field>
          <Btn variant="danger" disabled={!cancelReason.trim()} loading={busy === 'cancel'}
            onClick={async () => { if (await act('cancel', () => patch({ action: 'cancel', reason: cancelReason }))) { setShowCancel(false); setCancelReason(''); } }}>Cancel sheet</Btn>
        </div>)}

      {payFor && <PayModal s={payFor} sheet={sheet} settings={settings} onClose={() => setPayFor(null)}
        onPay={async (name, note) => {
          const r = await api('PATCH', `/api/payroll/temporary/settlements/${payFor.id}`, { action: 'pay', received_by_full_name: name, payment_note: note || undefined });
          if (!r.ok) return r.error;
          setPayFor(null); await load(); onChanged?.(); return null;
        }} />}
    </Modal>
  );
}

function PayModal({ s, settings, onClose, onPay }) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const noteRequired = overApprovalLimit(settings, s.gross_amount) || overApprovalLimit(settings, s.net_amount);
  const nameErr = name ? validateReceiverName(name) : null;
  const valid = !validateReceiverName(name) && (!noteRequired || note.trim());
  return (
    <Modal title={`Mark ${s.employees?.name} paid`} onClose={onClose} width={460}>
      <Banner message={err} />
      <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>KES {fmt(s.net_amount)} <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>cash</span></div>
      <Field label="Receiver's full name" required error={nameErr}><input style={inputStyle} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="As written on the signed sheet" /></Field>
      <Field label="Payment note" required={noteRequired} hint={noteRequired ? 'Required: this payment is above the approval limit. Say how the cash was counted and handed over.' : 'Optional'}>
        <textarea style={{ ...inputStyle, minHeight: 56 }} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn variant="success" disabled={!valid} loading={saving} onClick={async () => { setSaving(true); const e = await onPay(name.trim(), note.trim()); setSaving(false); if (e) setErr(e); }}>Confirm — cash handed over</Btn>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>This cannot be undone: paid settlements are final.</div>
    </Modal>
  );
}
