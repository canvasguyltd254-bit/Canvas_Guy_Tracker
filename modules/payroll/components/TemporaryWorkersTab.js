'use client';

/**
 * Payroll → Temporary Workers (admin, production manager, head of sales).
 * Cash-paid short-term labour, settled after approved Production attendance. Spec: docs/specs/temporary-workers.md
 *
 * Attendance is recorded and approved in the existing Production Time tab; nothing here creates labour cost.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/shared/context/AuthContext';
import { C, TabBar } from '@/shared/ui/ds';
import { createClient } from '@/shared/supabase/client';
import {
  canUseTemporaryWorkers, canManageTemporarySettings, canLinkAssignment,
} from '@/shared/lib/payroll/temporaryAccess';
import {
  api, fmt, fmtD, todayISO, inputStyle, Badge, Spinner, Banner, Empty, Card, Modal, Field, Btn, th, td, num, Table,
} from './payrollUi';
import { SettlementsPanel, SheetsPanel } from './TemporarySettlements';

const supabase = createClient();

export default function TemporaryWorkersTab() {
  const { user, userRole } = useAuth();
  const [sub, setSub] = useState('engagements');
  const [settings, setSettings] = useState(undefined);      // undefined = loading, null = row missing (fail-closed)
  const [tick, setTick] = useState(0);
  const [focusSettlement, setFocusSettlement] = useState(null);
  const bump = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => { (async () => {
    const r = await api('GET', '/api/payroll/temporary/settings');
    setSettings(r.ok ? r.data.settings : null);
  })(); }, [tick]);

  if (!canUseTemporaryWorkers(userRole)) return <Empty>You don’t have access to temporary workers.</Empty>;

  const tabs = [
    { key: 'engagements', label: 'Engagements' },
    { key: 'due', label: 'Due for payment' },
    { key: 'settlements', label: 'Settlements' },
    { key: 'sheets', label: 'Payout sheets' },
    ...(canManageTemporarySettings(userRole) ? [{ key: 'settings', label: 'Limits' }] : []),
  ];

  return (
    <div>
      {settings === null && (
        <Banner tone="warn" message="The approval limit is not set, so only an admin can approve settlements and payout sheets until an admin sets it under “Limits”." />
      )}
      <Banner tone="info" message="Temporary workers are paid in cash after approved attendance. Record and approve their days in Production → Time; this screen settles and pays them. No statutory deductions apply." />
      <TabBar tabs={tabs} active={sub} onSelect={setSub} style={{ marginBottom: 18 }} />
      {sub === 'engagements' && <EngagementsPanel role={userRole} settings={settings} refreshKey={tick} onChanged={bump}
        onPrepared={(id) => { setFocusSettlement(id); setSub('settlements'); }} />}
      {sub === 'due' && <DuePanel role={userRole} refreshKey={tick} onChanged={bump} onPrepared={(id) => { setFocusSettlement(id); setSub('settlements'); }} />}
      {sub === 'settlements' && <SettlementsPanel role={userRole} userId={user?.id} settings={settings} refreshKey={tick} onChanged={bump}
        focusId={focusSettlement} onFocusDone={() => setFocusSettlement(null)} />}
      {sub === 'sheets' && <SheetsPanel role={userRole} userId={user?.id} settings={settings} refreshKey={tick} onChanged={bump} />}
      {sub === 'settings' && <LimitsPanel settings={settings} onSaved={bump} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Engagements
// ════════════════════════════════════════════════════════════════
function EngagementsPanel({ role, refreshKey, onChanged, onPrepared }) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState(null);
  const [prepare, setPrepare] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api('GET', `/api/payroll/temporary/engagements${filter ? `?status=${filter}` : ''}`);
    if (r.ok) setRows(r.data.engagements); else setError(r.error);
    setLoading(false);
  }, [filter]);
  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div>
      <Banner message={error} onDismiss={() => setError('')} />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...inputStyle, width: 180 }} aria-label="Filter by status">
          <option value="">All engagements</option>
          {['planned', 'active', 'completed', 'cancelled'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <Btn onClick={() => setShowNew(true)}>+ New engagement</Btn>
      </div>
      {loading ? <Spinner /> : rows.length === 0 ? <Empty>No engagements yet. Create one for each temporary worker on a project.</Empty> : (
        <Table>
          <thead><tr><th style={th}>Engagement</th><th style={th}>Worker</th><th style={th}>Project</th><th style={{ ...th, ...num }}>Daily rate</th><th style={{ ...th, ...num }}>Unsettled days</th><th style={{ ...th, ...num }}>Unsettled KES</th><th style={th}>Status</th><th style={th} /></tr></thead>
          <tbody>{rows.map(e => (
            <tr key={e.id}>
              <td style={td}><strong>{e.engagement_num}</strong>{e.version > 1 && <div style={{ fontSize: 11, color: C.muted }}>v{e.version}</div>}</td>
              <td style={td}>{e.employees?.name}<div style={{ fontSize: 11, color: C.muted }}>{e.employees?.employee_num}</div></td>
              <td style={td}>{e.orders?.order_num}<div style={{ fontSize: 11, color: C.muted }}>{e.orders?.client}</div></td>
              <td style={{ ...td, ...num }}>{fmt(e.agreed_daily_rate)}</td>
              <td style={{ ...td, ...num }}>{e.due ? fmt(e.due.eligible_units) : '—'}{e.due?.due && <div><Badge label="due" tone={['#dcfce7', '#166534']} /></div>}</td>
              <td style={{ ...td, ...num }}>{e.due ? fmt(e.due.eligible_gross) : '—'}</td>
              <td style={td}><Badge label={e.status} /></td>
              <td style={td}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Btn small variant="secondary" onClick={() => setDetail(e)}>Open</Btn>
                {['active', 'completed'].includes(e.status) && e.due && Number(e.due.eligible_units) > 0 && <Btn small onClick={() => setPrepare(e)}>Settle</Btn>}
              </div></td>
            </tr>))}</tbody>
        </Table>)}
      {showNew && <NewEngagementModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); onChanged(); }} role={role} />}
      {detail && <EngagementModal e={detail} role={role} onClose={() => setDetail(null)} onChanged={() => { load(); onChanged(); }} onSettle={(e) => { setDetail(null); setPrepare(e); }} />}
      {prepare && <PrepareModal e={prepare} onClose={() => setPrepare(null)} onPrepared={(id) => { setPrepare(null); load(); onChanged(); onPrepared(id); }} />}
    </div>
  );
}

function NewEngagementModal({ onClose, onCreated, role }) {
  const [workers, setWorkers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [wq, setWq] = useState('');
  const [oq, setOq] = useState('');
  const [f, setF] = useState({ employee_id: '', order_id: '', agreed_daily_rate: '', start_date: todayISO(), expected_end_date: '', max_days: '', notes: '', activate: true });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { const t = setTimeout(async () => {
    const r = await api('GET', `/api/payroll/employees?active=true${wq ? `&search=${encodeURIComponent(wq)}` : ''}`);
    if (r.ok) setWorkers((r.data.employees || []).slice(0, 80));
  }, 250); return () => clearTimeout(t); }, [wq]);
  useEffect(() => { (async () => {
    const { data } = await supabase.from('orders').select('id, order_num, client, status').order('created_at', { ascending: false }).limit(300);
    setOrders((data || []).filter(o => !['Cancelled', 'Delivered', 'Completed'].includes(o.status)));
  })(); }, []);
  const shownOrders = orders.filter(o => !oq || `${o.order_num} ${o.client}`.toLowerCase().includes(oq.toLowerCase())).slice(0, 80);
  const ready = f.employee_id && f.order_id && Number(f.agreed_daily_rate) > 0 && f.start_date;

  return (
    <Modal title="New temporary engagement" onClose={onClose} width={560}>
      <Banner message={error} onDismiss={() => setError('')} />
      <Field label="Worker" required hint={role === 'admin' ? 'Not listed? Register the worker under Payroll → Employees first.' : undefined}>
        <input style={{ ...inputStyle, marginBottom: 6 }} placeholder="Search by name or number" value={wq} onChange={(e) => setWq(e.target.value)} />
        <select style={inputStyle} value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
          <option value="">Select a worker…</option>
          {workers.map(w => <option key={w.id} value={w.id}>{w.name} · {w.employee_num}</option>)}
        </select>
        {role !== 'admin' && <div style={{ fontSize: 12, color: C.amber, marginTop: 6, fontWeight: 600 }}>Can’t find the worker? Ask an administrator to register this worker.</div>}
      </Field>
      <Field label="Project" required>
        <input style={{ ...inputStyle, marginBottom: 6 }} placeholder="Search order number or client" value={oq} onChange={(e) => setOq(e.target.value)} />
        <select style={inputStyle} value={f.order_id} onChange={(e) => setF({ ...f, order_id: e.target.value })}>
          <option value="">Select a project…</option>
          {shownOrders.map(o => <option key={o.id} value={o.id}>{o.order_num} — {o.client}</option>)}
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Agreed daily rate (KES)" required hint="Fixed for this engagement. A new rate means a new version."><input style={inputStyle} inputMode="decimal" value={f.agreed_daily_rate} onChange={(e) => setF({ ...f, agreed_daily_rate: e.target.value })} /></Field>
        <Field label="Maximum days" hint="Optional guide"><input style={inputStyle} inputMode="decimal" value={f.max_days} onChange={(e) => setF({ ...f, max_days: e.target.value })} /></Field>
        <Field label="Start date" required><input type="date" style={inputStyle} value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
        <Field label="Expected end"><input type="date" style={inputStyle} value={f.expected_end_date} onChange={(e) => setF({ ...f, expected_end_date: e.target.value })} /></Field>
      </div>
      <Field label="Notes"><input style={inputStyle} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={f.activate} onChange={(e) => setF({ ...f, activate: e.target.checked })} /> Activate now (a worker cannot be in an overlapping payroll run while engaged)
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn loading={saving} disabled={!ready} onClick={async () => {
          setSaving(true); const r = await api('POST', '/api/payroll/temporary/engagements', f); setSaving(false);
          if (!r.ok) setError(r.error); else onCreated();
        }}>Create engagement</Btn>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}

function EngagementModal({ e, role, onClose, onChanged, onSettle }) {
  const [asg, setAsg] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState('');          // '', 'close', 'cancel', 'rate'
  const [reason, setReason] = useState('');
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState('');

  const loadAsg = useCallback(async () => {
    if (e.status !== 'active') { setAsg([]); return; }
    const r = await api('GET', `/api/payroll/temporary/engagements/${e.id}/assignments`);
    if (r.ok) setAsg(r.data.assignments); else { setAsg([]); setError(r.error); }
  }, [e.id, e.status]);
  useEffect(() => { loadAsg(); }, [loadAsg]);

  const patch = async (key, body, after) => {
    setBusy(key); setError(''); setMsg('');
    const r = await api('PATCH', `/api/payroll/temporary/engagements/${e.id}`, body);
    setBusy('');
    if (!r.ok) { setError(r.error); return; }
    onChanged(); await loadAsg(); after?.(r.data.data);
  };

  return (
    <Modal title={`${e.engagement_num} · ${e.employees?.name}`} onClose={onClose} width={640}>
      <Banner message={error} onDismiss={() => setError('')} />
      <Banner tone="info" message={msg} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge label={e.status} />
        <span style={{ fontSize: 13 }}>{e.orders?.order_num} — {e.orders?.client} · KES {fmt(e.agreed_daily_rate)}/day · from {fmtD(e.start_date)}{e.expected_end_date ? ` to ${fmtD(e.expected_end_date)}` : ''}</span>
      </div>
      {e.close_reason && <Banner tone="info" message={`Closed ${fmtD(e.closed_at)}: ${e.close_reason}`} />}
      {e.due && <div style={{ fontSize: 13, marginBottom: 12 }}>Approved, unsettled: <strong>{fmt(e.due.eligible_units)}</strong> day(s) · KES <strong>{fmt(e.due.eligible_gross)}</strong>{e.due.due ? ' — due for payment' : ''}</div>}

      {e.status === 'active' && (
        <>
          <h4 style={{ margin: '8px 0 6px', fontSize: 13 }}>Production assignments</h4>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Attendance only counts once the worker’s Production assignment is linked to this engagement. Linking sets the assignment’s rate to the agreed rate and is refused once time has been recorded on it.</div>
          {!asg ? <Spinner /> : asg.length === 0 ? <Empty>No active Production assignments for this worker on this project. Assign the worker to a stage in Production first.</Empty> : (
            <Table><tbody>{asg.map(a => (
              <tr key={a.id}><td style={td}><strong>{a.job_num}</strong><div style={{ fontSize: 11, color: C.muted }}>{a.description}</div></td>
                <td style={td}>{a.linked ? <Badge label="linked" tone={['#dcfce7', '#166534']} /> : a.linked_elsewhere ? <Badge label="linked to another engagement" /> : <Badge label="not linked" tone={['#fef9c3', '#854d0e']} />}</td>
                <td style={td}>{!a.linked && !a.linked_elsewhere && (canLinkAssignment(role)
                  ? <Btn small loading={busy === a.id} onClick={() => patch(a.id, { action: 'link_assignment', assignment_id: a.id }, () => setMsg('Assignment linked.'))}>Link</Btn>
                  : <span style={{ fontSize: 11, color: C.muted }}>Ask the production manager to link this</span>)}</td></tr>))}</tbody></Table>)}
        </>)}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
        {e.status === 'planned' && <Btn variant="success" loading={busy === 'activate'} onClick={() => patch('activate', { action: 'activate' })}>Activate</Btn>}
        {['active', 'completed'].includes(e.status) && e.due && Number(e.due.eligible_units) > 0 && <Btn onClick={() => onSettle(e)}>Prepare settlement</Btn>}
        {e.status === 'active' && <Btn variant="secondary" onClick={() => setMode(mode === 'rate' ? '' : 'rate')}>Change rate…</Btn>}
        {e.status === 'active' && <Btn variant="secondary" onClick={() => setMode(mode === 'close' ? '' : 'close')}>Complete…</Btn>}
        {['planned', 'active'].includes(e.status) && <Btn variant="danger" onClick={() => setMode(mode === 'cancel' ? '' : 'cancel')}>Cancel…</Btn>}
      </div>

      {mode === 'rate' && (
        <div style={{ marginTop: 12, background: C.bg, borderRadius: 9, padding: 12 }}>
          <Field label="New daily rate (KES)" required hint="Closes this version and opens a new one. Existing assignments keep the old rate; link a new assignment for the new rate."><input style={inputStyle} inputMode="decimal" value={rate} onChange={(x) => setRate(x.target.value)} /></Field>
          <Field label="Reason" required><input style={inputStyle} value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
          <Btn loading={busy === 'rate'} disabled={!(Number(rate) > 0) || !reason.trim()} onClick={() => patch('rate', { action: 'revise_rate', new_rate: Number(rate), reason }, () => { onClose(); })}>Create new version</Btn>
        </div>)}
      {(mode === 'close' || mode === 'cancel') && (
        <div style={{ marginTop: 12, background: C.bg, borderRadius: 9, padding: 12 }}>
          <Field label={mode === 'close' ? 'Reason for completing' : 'Reason for cancelling'} required><input style={inputStyle} value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
          <Btn variant={mode === 'cancel' ? 'danger' : 'primary'} loading={busy === mode} disabled={!reason.trim()} onClick={() => patch(mode, { action: mode === 'close' ? 'complete' : 'cancel', reason }, (due) => {
            if (due?.close_out_due) setMsg(`${fmt(due.eligible_units)} day(s) are still unsettled — prepare a close-out settlement.`); else onClose();
          })}>{mode === 'close' ? 'Complete engagement' : 'Cancel engagement'}</Btn>
        </div>)}
    </Modal>
  );
}

function PrepareModal({ e, onClose, onPrepared }) {
  const closed = ['completed', 'cancelled'].includes(e.status);
  const threshold = Number(e.due?.threshold_units ?? 3);
  const units = Number(e.due?.eligible_units ?? 0);
  const [kind, setKind] = useState(closed ? 'close_out' : units >= threshold ? 'threshold' : 'early');
  const [cutoff, setCutoff] = useState(todayISO());
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const kinds = closed ? [['close_out', 'Close-out — pay all remaining approved days']]
    : [['threshold', `Standard — ${threshold} or more approved days`], ['early', 'Early — fewer days, with a reason']];
  const ok = kind !== 'early' || reason.trim();
  return (
    <Modal title={`Prepare settlement · ${e.employees?.name}`} onClose={onClose} width={500}>
      <Banner message={error} onDismiss={() => setError('')} />
      <div style={{ fontSize: 13, marginBottom: 12 }}>Approved, unsettled: <strong>{fmt(units)}</strong> day(s) · KES <strong>{fmt(e.due?.eligible_gross)}</strong></div>
      <Field label="Type">
        {kinds.map(([k, l]) => <label key={k} style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 6, opacity: k === 'threshold' && units < threshold ? 0.5 : 1 }}>
          <input type="radio" name="kind" checked={kind === k} disabled={k === 'threshold' && units < threshold} onChange={() => setKind(k)} /> {l}</label>)}
      </Field>
      <Field label="Cutoff date" hint="Includes EVERY approved, unsettled day up to and including this date, oldest first. A day cannot be skipped or split."><input type="date" style={inputStyle} value={cutoff} onChange={(x) => setCutoff(x.target.value)} /></Field>
      {kind === 'early' && <Field label="Reason for paying early" required><input style={inputStyle} value={reason} onChange={(x) => setReason(x.target.value)} /></Field>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn loading={saving} disabled={!ok} onClick={async () => {
          setSaving(true); const r = await api('POST', '/api/payroll/temporary/settlements', { engagement_id: e.id, cutoff_date: cutoff, kind, reason: reason || undefined }); setSaving(false);
          if (!r.ok) setError(r.error); else onPrepared(r.data.data.id);
        }}>Prepare settlement</Btn>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>You can add deductions next. A different person must approve it (an admin if it is above the limit).</div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════
// Due for payment
// ════════════════════════════════════════════════════════════════
function DuePanel({ refreshKey, onChanged, onPrepared }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [prepare, setPrepare] = useState(null);
  const load = useCallback(async () => {
    const r = await api('GET', '/api/payroll/temporary/engagements');
    if (!r.ok) { setError(r.error); setRows([]); return; }
    setRows(r.data.engagements.filter(e => e.due && (e.due.due || e.due.close_out_due)));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  return (
    <div>
      <Banner message={error} onDismiss={() => setError('')} />
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty>Nothing is due. A worker becomes due at 3.00 approved days, or when an engagement is closed with days left.</Empty> : (
        <Table>
          <thead><tr><th style={th}>Worker</th><th style={th}>Project</th><th style={{ ...th, ...num }}>Approved days</th><th style={{ ...th, ...num }}>Amount (KES)</th><th style={th}>Why</th><th style={th} /></tr></thead>
          <tbody>{rows.map(e => (
            <tr key={e.id}><td style={td}>{e.employees?.name}<div style={{ fontSize: 11, color: C.muted }}>{e.engagement_num}</div></td><td style={td}>{e.orders?.order_num}</td>
              <td style={{ ...td, ...num }}>{fmt(e.due.eligible_units)}</td><td style={{ ...td, ...num }}><strong>{fmt(e.due.eligible_gross)}</strong></td>
              <td style={td}>{e.due.close_out_due ? <Badge label="close-out" tone={['#ede9fe', '#5b21b6']} /> : <Badge label="threshold reached" tone={['#dcfce7', '#166534']} />}</td>
              <td style={td}><Btn small onClick={() => setPrepare(e)}>Prepare settlement</Btn></td></tr>))}</tbody>
        </Table>)}
      {prepare && <PrepareModal e={prepare} onClose={() => setPrepare(null)} onPrepared={(id) => { setPrepare(null); load(); onChanged(); onPrepared(id); }} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Limits (admin)
// ════════════════════════════════════════════════════════════════
function LimitsPanel({ settings, onSaved }) {
  const blank = { admin_approval_limit_kes: '', settlement_threshold_units: '', rolling_window_days: '', deduction_single_limit_kes: '', deduction_total_pct: '', damage_deductions_enabled: true };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (settings) setF({
      admin_approval_limit_kes: settings.admin_approval_limit_kes ?? '', settlement_threshold_units: settings.settlement_threshold_units, rolling_window_days: settings.rolling_window_days,
      deduction_single_limit_kes: settings.deduction_single_limit_kes, deduction_total_pct: settings.deduction_total_pct, damage_deductions_enabled: settings.damage_deductions_enabled,
    });
  }, [settings]);
  const field = (k, label, hint) => <Field label={label} hint={hint}><input style={inputStyle} inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Card style={{ maxWidth: 560 }}>
      <Banner message={error} onDismiss={() => setError('')} />
      <Banner tone="info" message={msg} />
      {field('admin_approval_limit_kes', 'Admin approval limit (KES)', 'Settlements (and payout sheets, by cash amount) above this need an admin. Leave empty to require an admin for everything.')}
      {settings && settings.admin_approval_limit_kes === null && <Banner tone="warn" message="No limit is set: only an admin can approve right now." />}
      {field('settlement_threshold_units', 'Settlement threshold (approved days)')}
      {field('rolling_window_days', 'Split-payment window (days)', 'A worker’s other approved settlements in this window count towards the limit.')}
      {field('deduction_single_limit_kes', 'Single deduction needing an admin (KES)')}
      {field('deduction_total_pct', 'Total deductions needing an admin (% of gross)')}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={!!f.damage_deductions_enabled} onChange={(e) => setF({ ...f, damage_deductions_enabled: e.target.checked })} /> Allow damage deductions (check the legal position with an adviser first)
      </label>
      <Btn loading={saving} onClick={async () => {
        setSaving(true); setError(''); setMsg('');
        const body = {
          admin_approval_limit_kes: f.admin_approval_limit_kes === '' ? null : Number(f.admin_approval_limit_kes),
          settlement_threshold_units: Number(f.settlement_threshold_units), rolling_window_days: Number(f.rolling_window_days),
          deduction_single_limit_kes: Number(f.deduction_single_limit_kes), deduction_total_pct: Number(f.deduction_total_pct),
          damage_deductions_enabled: !!f.damage_deductions_enabled,
        };
        const r = await api('PATCH', '/api/payroll/temporary/settings', body); setSaving(false);
        if (!r.ok) setError(r.error); else { setMsg('Saved.'); onSaved(); }
      }}>Save limits</Btn>
    </Card>
  );
}
