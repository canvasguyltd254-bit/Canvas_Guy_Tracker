'use client';

/**
 * Temporary workers: settlements, deductions, payout sheets and payment.
 * The screen guides; the database decides. Every button maps to one database function behind /api/payroll/temporary.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { C } from '@/shared/ui/ds';
import {
  canVoidApprovedSettlement, canApprovePayoutSheet, canExportPayoutSheet, canReleasePayoutRows, overApprovalLimit, deductionNeedsAdmin,
  validateDeductionInput, DEDUCTION_TYPES, OTHER_REASON_MIN_CHARS,
} from '@/shared/lib/payroll/temporaryAccess';
import {
  api, fmt, fmtD, fmtDT, inputStyle, Badge, AdminBadge, Spinner, Banner, Empty, Modal, Field, Btn, th, td, num, Table,
} from './payrollUi';

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
          <thead><tr><th style={th}>Settlement</th><th style={th}>Worker</th><th style={th}>Period</th><th style={{ ...th, ...num }}>Days</th><th style={{ ...th, ...num }}>Gross</th><th style={{ ...th, ...num }}>Deductions</th><th style={{ ...th, ...num }}>Net pay</th><th style={th}>Status</th><th style={th} /></tr></thead>
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
  if (s.status === 'approved') return s.payout_sheet_id ? 'Continue in “Payout sheets”: download the ChatPesa file, upload it in ChatPesa, then match the payments.' : 'Put it on a payout sheet (the worker needs an M-Pesa number on their employee record).';
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
        {[['Days', fmt(s.units_included)], ['Gross', `KES ${fmt(s.gross_amount)}`], ['Deductions', `KES ${fmt(s.deductions_total)}`], ['Net pay', `KES ${fmt(s.net_amount)}`]].map(([k, v]) => (
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
</td>
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
          <Banner tone="info" message={s.received_by_full_name
            ? `Paid in cash — KES ${fmt(s.net_amount)} to ${s.received_by_full_name} on ${fmtDT(s.paid_at)}.${s.payment_note ? ` Note: ${s.payment_note}` : ''}`
            : `Paid by M-Pesa through ChatPesa — KES ${fmt(s.net_amount)} on ${fmtDT(s.paid_at)}.${s.payment_note ? ` ${s.payment_note}.` : ''}`} />
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
// Payout sheets: paid through ChatPesa (M-Pesa). No cash.
// ════════════════════════════════════════════════════════════════
const SHEET_TONE = { open: ['#f3f4f6', '#374151'], exported: ['#fff5d9', '#96620a'], paid: ['#dcfce7', '#166534'], cancelled: ['#fee2e2', '#991b1b'] };

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
        <span style={{ fontSize: 12, color: C.muted, maxWidth: 600 }}>Workers are paid by M-Pesa through ChatPesa. A sheet gathers approved settlements into one ChatPesa file; a settlement is only marked paid once its payment shows up in the imported ChatPesa statement.</span>
        <Btn onClick={() => setShowNew(true)}>+ New payout sheet</Btn>
      </div>
      {loading ? <Spinner /> : rows.length === 0 ? <Empty>No payout sheets yet. Approve a settlement first, then create its sheet from the settlement or with “+ New payout sheet”.</Empty> : (
        <Table>
          <thead><tr><th style={th}>Sheet</th><th style={th}>Created</th><th style={{ ...th, ...num }}>Gross</th><th style={{ ...th, ...num }}>Deductions</th><th style={{ ...th, ...num }}>Net pay</th><th style={th}>Status</th><th style={th} /></tr></thead>
          <tbody>{rows.map(sh => (
            <tr key={sh.id}>
              <td style={td}><strong>{sh.sheet_num}</strong></td><td style={td}>{fmtD(sh.created_at)}</td>
              <td style={{ ...td, ...num }}>{fmt(sh.total_gross)}</td><td style={{ ...td, ...num }}>{fmt(sh.total_deductions)}</td><td style={{ ...td, ...num }}><strong>{fmt(sh.total_net)}</strong></td>
              <td style={td}><Badge label={sh.status} tone={SHEET_TONE[sh.status]} />{sh.status === 'open' && overApprovalLimit(settings, sh.total_net) && !sh.admin_approved_by && <div style={{ marginTop: 4 }}><AdminBadge /></div>}</td>
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
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { (async () => {
    const r = await api('GET', '/api/payroll/temporary/settlements?status=approved');
    if (r.ok) setRows(r.data.settlements.filter(s => !s.payout_sheet_id)); else setError(r.error);
  })(); }, []);
  const chosen = (rows || []).filter(s => picked.includes(s.id));
  const total = chosen.reduce((a, s) => a + Number(s.net_amount), 0);
  const toggle = (id) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  return (
    <Modal title="New payout sheet" onClose={onClose} width={640}>
      <Banner message={error} />
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>Tick every worker you want to pay in the same ChatPesa upload. Each worker needs an M-Pesa number on their employee record.</div>
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty>No approved settlements are waiting for a sheet.</Empty> : (
        <>
          <Table>
            <thead><tr><th style={th} /><th style={th}>Settlement</th><th style={th}>Worker</th><th style={{ ...th, ...num }}>Net pay</th></tr></thead>
            <tbody>{rows.map(s => (
              <tr key={s.id}><td style={td}><input type="checkbox" aria-label={`Select ${s.settlement_num}`} checked={picked.includes(s.id)} onChange={() => toggle(s.id)} /></td>
                <td style={td}>{s.settlement_num}</td><td style={td}>{s.employees?.name}</td><td style={{ ...td, ...num }}>{fmt(s.net_amount)}</td></tr>))}</tbody>
          </Table>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <strong>{chosen.length ? `${chosen.length} worker${chosen.length > 1 ? 's' : ''} · KES ${fmt(total)}` : 'Choose at least one settlement'}</strong>
            <Btn loading={saving} disabled={!chosen.length} onClick={async () => {
              setSaving(true); const r = await api('POST', '/api/payroll/temporary/payout-sheets', { settlement_ids: picked }); setSaving(false);
              if (!r.ok) setError(r.error); else onCreated(r.data.data);
            }}>Create sheet</Btn>
          </div>
        </>)}
    </Modal>
  );
}

// The ChatPesa file: POST (it changes state), then hand the response to the browser as a download.
async function downloadChatpesaFile(sheetId) {
  let res;
  try { res = await fetch(`/api/payroll/temporary/payout-sheets/${sheetId}/export`, { method: 'POST' }); }
  catch { return { ok: false, error: 'Could not reach the server. Nothing was changed.' }; }
  if (!res.ok) { const j = await res.json().catch(() => ({})); return { ok: false, error: j.error || 'The export failed. Nothing was changed.' }; }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'chatpesa.csv';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { ok: true, first: res.headers.get('X-First-Export') === '1' };
}

function rowState(r) {
  if (r.chatpesa_transaction_id) return { label: 'paid', tone: ['#dcfce7', '#166534'], note: `${r.confirm_code ? `M-Pesa ${r.confirm_code} · ` : ''}${fmtDT(r.matched_at)}${r.match_method === 'phone_amount' ? ' · matched by phone and amount' : ''}` };
  if (r.released_at) return { label: 'released', tone: ['#f3f4f6', '#374151'], note: r.release_reason };
  return { label: 'waiting for statement', tone: ['#fef9c3', '#854d0e'], note: 'Not in an imported ChatPesa statement yet.' };
}

function SheetModal({ id, role, userId, settings, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);
  const [releaseReason, setReleaseReason] = useState('');
  const [showRelease, setShowRelease] = useState(false);
  const [confirmAgain, setConfirmAgain] = useState(false);

  const load = useCallback(async () => {
    const r = await api('GET', `/api/payroll/temporary/payout-sheets/${id}`);
    if (r.ok) setD(r.data); else setError(r.error);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const patch = (body) => api('PATCH', `/api/payroll/temporary/payout-sheets/${id}`, body);
  const act = async (key, fn) => { setBusy(key); setError(''); const r = await fn(); setBusy(''); if (!r.ok) { setError(r.error); return false; } await load(); onChanged?.(); return true; };

  if (!d) return <Modal title="Payout sheet" onClose={onClose}>{error ? <Banner message={error} /> : <Spinner />}</Modal>;
  const { sheet, settlements, rows } = d;
  const byS = Object.fromEntries(settlements.map(s => [s.id, s]));
  const needsAdmin = overApprovalLimit(settings, sheet.total_net);
  const adminOk = !needsAdmin || !!sheet.admin_approved_by;
  const isAdmin = canApprovePayoutSheet(role);
  const iPrepared = settlements.some(s => s.prepared_by === userId);
  const waiting = rows.filter(r => !r.chatpesa_transaction_id && !r.released_at);
  const canExport = canExportPayoutSheet(role) && !iPrepared && adminOk;
  const exportBlock = !canExportPayoutSheet(role) ? 'Only an admin can release the payment file.'
    : iPrepared ? 'You prepared a settlement on this sheet, so someone else must release its payment.'
    : !adminOk ? 'This sheet is above the approval limit: an admin must approve it first.' : '';

  const doDownload = async () => {
    setBusy('export'); setError(''); setInfo('');
    const r = await downloadChatpesaFile(id);
    setBusy(''); setConfirmAgain(false);
    if (!r.ok) { setError(r.error); return; }
    setInfo(r.first ? 'The ChatPesa file was downloaded and the sheet is now exported. Upload it in ChatPesa, then import the statement and match the payments.' : 'Downloaded again. It contains only payments that are still unpaid.');
    await load(); onChanged?.();
  };
  const doMatch = async () => {
    setBusy('match'); setError(''); setInfo('');
    const r = await patch({ action: 'match' });
    setBusy('');
    if (!r.ok) { setError(r.error); return; }
    const m = r.data.data;
    const bits = [`${m.matched} payment${m.matched === 1 ? '' : 's'} matched`];
    if (m.pending) bits.push(`${m.pending} still not in the statement`);
    if (m.ambiguous?.length) bits.push(`${m.ambiguous.length} ambiguous (${m.ambiguous.join(', ')}): more than one statement line fits, check them in Suppliers → Payments`);
    setInfo(bits.join(' · ') + (m.pending ? '. Import a newer ChatPesa statement and match again; rows ChatPesa rejected will never appear.' : '.'));
    await load(); onChanged?.();
  };

  return (
    <Modal title={`Payout sheet ${sheet.sheet_num}`} onClose={onClose} width={860}>
      <Banner message={error} onDismiss={() => setError('')} />
      {info && <Banner tone="info" message={info} onDismiss={() => setInfo('')} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Badge label={sheet.status} tone={SHEET_TONE[sheet.status]} />
        {needsAdmin && !sheet.admin_approved_by && sheet.status === 'open' && <AdminBadge text="Admin approval needed (sheet above limit)" />}
        {sheet.admin_approved_by && <Badge label="admin approved" tone={['#dcfce7', '#166534']} />}
        <span style={{ fontSize: 13 }}>Gross KES {fmt(sheet.total_gross)} · Deductions KES {fmt(sheet.total_deductions)} · <strong>Net pay KES {fmt(sheet.total_net)}</strong></span>
      </div>

      <ol data-testid="sheet-steps" style={{ fontSize: 12, color: C.muted, paddingLeft: 18, margin: '0 0 14px' }}>
        {[
          ['open', `Create the sheet${needsAdmin ? ' (an admin approves it because it is above the limit)' : ''}`],
          ['open', 'An admin downloads the ChatPesa file (someone other than the person who prepared the settlements)'],
          ['exported', 'Upload that file in ChatPesa to send the M-Pesa payments'],
          ['exported', 'Import the ChatPesa statement (Suppliers → Payments), then press “Match payments”'],
          ['exported', 'Anything ChatPesa rejected stays unpaid. An admin releases it so it can go on a new sheet'],
        ].map(([when, text], i) => (
          <li key={i} style={{ fontWeight: sheet.status === when ? 700 : 400, color: sheet.status === when ? C.ink : undefined }}>{text}</li>))}
      </ol>

      <Table>
        <thead><tr><th style={th}>Worker</th><th style={th}>M-Pesa number</th><th style={{ ...th, ...num }}>Amount sent</th><th style={th}>Payment</th></tr></thead>
        <tbody>
          {sheet.status === 'open'
            ? settlements.map(s => (
              <tr key={s.id}><td style={td}>{s.employees?.name}<div style={{ fontSize: 11, color: C.muted }}>{s.settlement_num}</div></td>
                <td style={td}>—</td><td style={{ ...td, ...num }}><strong>{fmt(Math.round(Number(s.net_amount)))}</strong></td>
                <td style={td}><Badge label="not exported" tone={['#f3f4f6', '#374151']} /></td></tr>))
            : rows.map(r => {
              const s = byS[r.settlement_id]; const st = rowState(r);
              return (
                <tr key={r.id} data-testid="payout-row">
                  <td style={td}>{s?.employees?.name}<div style={{ fontSize: 11, color: C.muted }}>{s?.settlement_num}</div></td>
                  <td style={td}>{r.phone_masked}</td>
                  <td style={{ ...td, ...num }}><strong>{fmt(r.amount)}</strong></td>
                  <td style={td}><Badge label={st.label} tone={st.tone} /><div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{st.note}</div></td>
                </tr>);
            })}
        </tbody>
      </Table>
      {sheet.status === 'open' && <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Amounts are rounded to whole shillings in the ChatPesa file. Numbers are shown masked once the file is made.</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
        {sheet.status === 'open' && isAdmin && needsAdmin && !sheet.admin_approved_by && (
          <Btn variant="success" loading={busy === 'approve'} onClick={() => act('approve', () => patch({ action: 'approve' }))}>Approve sheet (admin)</Btn>)}
        {sheet.status === 'open' && (
          <Btn loading={busy === 'export'} disabled={!canExport} title={exportBlock} onClick={doDownload}>Download ChatPesa file</Btn>)}
        {sheet.status === 'exported' && waiting.length > 0 && canExportPayoutSheet(role) && !confirmAgain && (
          <Btn variant="secondary" disabled={!canExport} title={exportBlock} onClick={() => setConfirmAgain(true)}>Download again…</Btn>)}
        {sheet.status === 'exported' && (
          <Btn variant="success" loading={busy === 'match'} onClick={doMatch}>Match payments</Btn>)}
        {sheet.status === 'exported' && waiting.length > 0 && canReleasePayoutRows(role) && (
          <Btn variant="danger" onClick={() => setShowRelease(v => !v)}>Release unpaid…</Btn>)}
        {sheet.status === 'open' && <Btn variant="danger" onClick={() => setShowCancel(v => !v)}>Cancel sheet…</Btn>}
      </div>
      {(sheet.status === 'open' || (sheet.status === 'exported' && waiting.length > 0)) && exportBlock && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{exportBlock}</div>}
      {sheet.status === 'exported' && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>The file was generated {fmtDT(sheet.exported_at)} ({sheet.export_downloads} download{sheet.export_downloads === 1 ? '' : 's'}). Do not upload it to ChatPesa twice: that pays the workers twice.</div>}
      {sheet.status === 'paid' && <Banner tone="info" message="Every payment on this sheet was matched to a real ChatPesa payment. Paid settlements are final." />}
      {sheet.status === 'cancelled' && <Banner tone="info" message={`Cancelled ${fmtDT(sheet.cancelled_at)}: ${sheet.cancel_reason}. A cancelled sheet is never reused; its settlements are free to join a new sheet.`} />}

      {confirmAgain && (
        <div style={{ marginTop: 12, background: C.redBg, border: `1px solid ${C.redBd}`, borderRadius: 9, padding: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>Only download again if the first file was <strong>not</strong> uploaded to ChatPesa (or you lost it). The new file lists only the {waiting.length} payment{waiting.length === 1 ? '' : 's'} still unpaid. Uploading a file that ChatPesa already processed pays those workers twice.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="danger" loading={busy === 'export'} onClick={doDownload}>Yes, download the unpaid rows</Btn>
            <Btn variant="secondary" onClick={() => setConfirmAgain(false)}>No</Btn>
          </div>
        </div>)}

      {showRelease && (
        <div style={{ marginTop: 12, background: C.redBg, border: `1px solid ${C.redBd}`, borderRadius: 9, padding: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>Release only after importing a fresh ChatPesa statement and pressing “Match payments”. A payment that already left ChatPesa but is not in your statement yet would be paid a second time on a new sheet.</div>
          <Field label="Why are these payments being released?" required><input style={inputStyle} value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} placeholder="e.g. ChatPesa rejected the row: number not registered" /></Field>
          <Btn variant="danger" disabled={!releaseReason.trim()} loading={busy === 'release'}
            onClick={async () => { if (await act('release', () => patch({ action: 'release', reason: releaseReason }))) { setShowRelease(false); setReleaseReason(''); } }}>Release {waiting.length} unpaid payment{waiting.length === 1 ? '' : 's'}</Btn>
        </div>)}

      {showCancel && sheet.status === 'open' && (
        <div style={{ marginTop: 12, background: C.redBg, border: `1px solid ${C.redBd}`, borderRadius: 9, padding: 12 }}>
          <Field label="Reason for cancelling" required><input style={inputStyle} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></Field>
          <Btn variant="danger" disabled={!cancelReason.trim()} loading={busy === 'cancel'}
            onClick={async () => { if (await act('cancel', () => patch({ action: 'cancel', reason: cancelReason }))) { setShowCancel(false); setCancelReason(''); } }}>Cancel sheet</Btn>
        </div>)}
    </Modal>
  );
}
