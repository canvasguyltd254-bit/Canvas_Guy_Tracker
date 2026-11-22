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
  const [focusSheet, setFocusSheet] = useState(null);
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
      <HowItWorks />
      <TabBar tabs={tabs} active={sub} onSelect={setSub} style={{ marginBottom: 10 }} />
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }} data-testid="tab-help">{TAB_HELP[sub]}</div>
      {sub === 'engagements' && <EngagementsPanel role={userRole} settings={settings} refreshKey={tick} onChanged={bump}
        onPrepared={(id) => { setFocusSettlement(id); setSub('settlements'); }} />}
      {sub === 'due' && <DuePanel role={userRole} refreshKey={tick} onChanged={bump} onPrepared={(id) => { setFocusSettlement(id); setSub('settlements'); }} />}
      {sub === 'settlements' && <SettlementsPanel role={userRole} userId={user?.id} settings={settings} refreshKey={tick} onChanged={bump}
        focusId={focusSettlement} onFocusDone={() => setFocusSettlement(null)}
        onOpenSheet={(id) => { setFocusSheet(id); setSub('sheets'); }} />}
      {sub === 'sheets' && <SheetsPanel role={userRole} userId={user?.id} settings={settings} refreshKey={tick} onChanged={bump}
        focusId={focusSheet} onFocusDone={() => setFocusSheet(null)} />}
      {sub === 'settings' && <LimitsPanel settings={settings} onSaved={bump} />}
    </div>
  );
}

// One plain sentence per tab, so a first-time user always knows what they are looking at and what comes next.
const TAB_HELP = {
  engagements: 'An engagement is the deal with one worker on one project: the agreed daily rate and the dates. Create one first; nothing can be paid without it.',
  due: 'Workers whose approved days are ready to be paid. Choose “Prepare settlement” on a row to start paying them.',
  settlements: 'A settlement is the amount owed to one worker for their approved days. Check it, add any deductions, then have a second person approve it.',
  sheets: 'A payout sheet is the paper the worker signs when they receive their cash. One sheet covers one settlement.',
  settings: 'Admin only: the amounts above which an admin must approve, and the deduction rules.',
};

// Always visible, collapsed to one line once understood. <details> keeps it keyboard accessible with no state to manage.
function HowItWorks() {
  const steps = [
    ['Record days', 'In Production → Time, record each day the worker attended and get it approved.'],
    ['Create the engagement', 'Here, under Engagements: the worker, the project and the agreed daily rate. Then link their Production assignment to it so their days count.'],
    ['Prepare the settlement', 'When days are due (3 approved days, or the job ends), prepare a settlement. Add any deductions.'],
    ['Approve it', 'A different person approves. Above the approval limit, an admin does.'],
    ['Create a payout sheet', 'Print it, the worker signs next to their cash, upload a photo of the signed copy.'],
    ['Mark it paid', 'Enter the receiver’s full name. A different person from the one who prepared it pays. Paid is final.'],
  ];
  return (
    <details style={{ background: C.blueBg, border: `1px solid ${C.blueBd}`, borderRadius: 9, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: C.blue }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>How temporary workers are paid (6 steps) — cash only, no statutory deductions</summary>
      <ol style={{ margin: '10px 0 2px', paddingLeft: 20, lineHeight: 1.55 }}>
        {steps.map(([t, d]) => <li key={t}><strong>{t}.</strong> {d}</li>)}
      </ol>
    </details>
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
      {loading ? <Spinner /> : rows.length === 0 ? <Empty>No engagements yet. Start with “+ New engagement” above: pick the worker, the project and the agreed daily rate.</Empty> : (
        <Table>
          <thead><tr><th style={th}>Engagement</th><th style={th}>Worker</th><th style={th}>Project</th><th style={{ ...th, ...num }}>Daily rate</th><th style={{ ...th, ...num }}>Unsettled days</th><th style={{ ...th, ...num }}>Unsettled KES</th><th style={th}>Status</th><th style={th} /></tr></thead>
          <tbody>{rows.map(e => (
            <tr key={e.id}>
              <td style={td}><strong>{e.engagement_num}</strong>{e.version > 1 && <div style={{ fontSize: 11, color: C.muted }}>v{e.version}</div>}</td>
              <td style={td}>{e.employees?.name}<div style={{ fontSize: 11, color: C.muted }}>{e.employees?.employee_num}</div></td>
              <td style={td}>{e.orders?.order_num}<div style={{ fontSize: 11, color: C.muted }}>{e.orders?.client}</div></td>
              <td style={{ ...td, ...num }}>{fmt(e.agreed_daily_rate)}</td>
              <td style={{ ...td, ...num }}>{e.due ? fmt(e.due.eligible_units) : '—'}{e.due?.due && <div><Badge label="due" tone={['#dcfce7', '#166534']} /></div>}{e.due?.max_days_reached && <div title={maxDaysMessage(e.due)}><Badge label="max days" tone={['#fef9c3', '#854d0e']} /></div>}</td>
              <td style={{ ...td, ...num }}>{e.due ? fmt(e.due.eligible_gross) : '—'}</td>
              <td style={td}><Badge label={e.status} /></td>
              <td style={td}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Btn small variant="secondary" onClick={() => setDetail(e)}>Open</Btn>
                {SETTLEABLE.includes(e.status) && e.due && Number(e.due.eligible_units) > 0 && <Btn small onClick={() => setPrepare(e)}>Settle</Btn>}
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
  const missing = [!f.employee_id && 'a worker', !f.order_id && 'a project', !(Number(f.agreed_daily_rate) > 0) && 'the agreed daily rate', !f.start_date && 'a start date'].filter(Boolean);
  const ready = missing.length === 0;

  return (
    <Modal title="New temporary engagement" onClose={onClose} width={560}>
      <Banner message={error} onDismiss={() => setError('')} />
      <Field label="Worker" required hint={role === 'admin' ? 'Not listed? Register the worker under Payroll → Employees first.' : undefined}>
        <input aria-label="Search workers" style={{ ...inputStyle, marginBottom: 6 }} placeholder="Search by name or number" value={wq} onChange={(e) => setWq(e.target.value)} />
        <select style={inputStyle} value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
          <option value="">Select a worker…</option>
          {workers.map(w => <option key={w.id} value={w.id}>{w.name} · {w.employee_num}</option>)}
        </select>
        {role !== 'admin' && <div style={{ fontSize: 12, color: C.amber, marginTop: 6, fontWeight: 600 }}>Can’t find the worker? Ask an administrator to register this worker.</div>}
      </Field>
      <Field label="Project" required>
        <input aria-label="Search projects" style={{ ...inputStyle, marginBottom: 6 }} placeholder="Search order number or client" value={oq} onChange={(e) => setOq(e.target.value)} />
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
      {!ready && <div style={{ fontSize: 12, color: C.amber, fontWeight: 600, marginBottom: 8 }} aria-live="polite">Still needed: {missing.join(', ')}.</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn loading={saving} disabled={!ready} title={ready ? '' : `Still needed: ${missing.join(', ')}`} onClick={async () => {
          setSaving(true); const r = await api('POST', '/api/payroll/temporary/engagements', f); setSaving(false);
          if (!r.ok) setError(r.error); else onCreated();
        }}>Create engagement</Btn>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}

// Statuses that can hold approved, unsettled work. A cancelled engagement still owes the days already worked.
const SETTLEABLE = ['active', 'completed', 'cancelled'];
// Warning only (nothing is blocked). Counts ALL non-voided attendance, so it stays visible after payment.
const maxDaysMessage = (d) => `Maximum days reached: ${fmt(d.total_units)} day(s) recorded against a guide of ${fmt(d.max_days)}. Check whether the agreed work has grown before more is booked.`;

// Assignment dates cannot fall on a Sunday: move to the nearest working day in the given direction.
const nonSunday = (iso, step = 1) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + step);
  return d.toISOString().slice(0, 10);
};

/** Put this worker on a job stage and link it to the engagement in one step (no trip to Production). */
function AssignForm({ e, targets, busy, onSubmit, defaultOpen }) {
  const today = todayISO();
  const start0 = nonSunday(e.start_date > today ? e.start_date : today, 1);
  const end0 = e.expected_end_date && e.expected_end_date >= start0 ? nonSunday(e.expected_end_date, -1) : start0;
  const [open, setOpen] = useState(!!defaultOpen);
  const [jobId, setJobId] = useState(targets.length === 1 ? targets[0].job_id : '');
  const job = targets.find(t => t.job_id === jobId);
  const [stageId, setStageId] = useState('');
  const stage = job?.stages.find(s => s.stage_id === stageId);
  const [opId, setOpId] = useState('');
  const [qty, setQty] = useState(targets.length === 1 ? String(targets[0].planned_quantity ?? '') : '');
  const [start, setStart] = useState(start0);
  const [end, setEnd] = useState(end0 < start0 ? start0 : end0);
  const [hours, setHours] = useState('8');

  if (!targets.length) return <Empty>This project has no production jobs yet. Create its production plan in Production first, then come back to assign this worker.</Empty>;
  if (!open) return <Btn small variant="secondary" onClick={() => setOpen(true)}>Assign to a job stage…</Btn>;

  const pickJob = (v) => { setJobId(v); setStageId(''); setOpId(''); const j = targets.find(t => t.job_id === v); setQty(j ? String(j.planned_quantity ?? '') : ''); };
  const pickStage = (v) => { setStageId(v); const s = job?.stages.find(x => x.stage_id === v); setOpId(s?.operations.length === 1 ? s.operations[0].id : ''); };
  const missing = !jobId ? 'Choose a job' : !stageId ? 'Choose a stage' : !opId ? 'Choose an operation' : !(Number(qty) > 0) ? 'Enter a quantity' : !start || !end ? 'Enter the dates' : end < start ? 'End is before start' : !(Number(hours) > 0) ? 'Enter hours per day' : '';

  return (
    <div style={{ background: C.bg, borderRadius: 9, padding: 12, marginTop: 8 }} data-testid="assign-form">
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Adds {e.employees?.name} to the stage and links it at KES {fmt(e.agreed_daily_rate)}/day. Other workers already on that stage are not changed.</div>
      <Field label="Job" required><select style={inputStyle} value={jobId} onChange={(x) => pickJob(x.target.value)}>
        <option value="">Select a job…</option>{targets.map(t => <option key={t.job_id} value={t.job_id}>{t.job_num}{t.description ? ` — ${t.description}` : ''}</option>)}</select></Field>
      {job && <Field label="Stage" required><select style={inputStyle} value={stageId} onChange={(x) => pickStage(x.target.value)}>
        <option value="">Select a stage…</option>{job.stages.map(s => <option key={s.stage_id} value={s.stage_id}>{s.stage_label}</option>)}</select></Field>}
      {stage && <Field label="Operation" required><select style={inputStyle} value={opId} onChange={(x) => setOpId(x.target.value)}>
        <option value="">Select an operation…</option>{stage.operations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
      {opId && (
        <>
          <Field label={`Quantity (job has ${job.planned_quantity})`} required hint="Whole units this worker is responsible for."><input style={inputStyle} inputMode="numeric" value={qty} onChange={(x) => setQty(x.target.value)} /></Field>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}><Field label="Planned start" required><input type="date" style={inputStyle} value={start} onChange={(x) => setStart(x.target.value)} /></Field></div>
            <div style={{ flex: 1 }}><Field label="Planned end" required hint="Not a Sunday."><input type="date" style={inputStyle} value={end} onChange={(x) => setEnd(x.target.value)} /></Field></div>
            <div style={{ width: 110 }}><Field label="Hours/day" required><input style={inputStyle} inputMode="decimal" value={hours} onChange={(x) => setHours(x.target.value)} /></Field></div>
          </div>
        </>)}
      <Btn loading={busy === 'assign'} disabled={!!missing} title={missing} onClick={() => onSubmit({ action: 'assign_worker', job_id: jobId, stage_id: stageId, operation_id: opId, quantity: Number(qty), start, end, hours_per_day: Number(hours) })}>Assign and link</Btn>
      {missing && <span style={{ fontSize: 11, color: C.muted, marginLeft: 10 }}>{missing}</span>}
    </div>
  );
}

function EngagementModal({ e, role, onClose, onChanged, onSettle }) {
  const [asg, setAsg] = useState(null);
  const [targets, setTargets] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState('');          // '', 'close', 'cancel', 'rate'
  const [reason, setReason] = useState('');
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState('');

  const loadAsg = useCallback(async () => {
    if (e.status !== 'active') { setAsg([]); return; }
    const r = await api('GET', `/api/payroll/temporary/engagements/${e.id}/assignments`);
    if (r.ok) { setAsg(r.data.assignments); setTargets(r.data.targets || []); } else { setAsg([]); setTargets([]); setError(r.error); }
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
      {e.due?.max_days_reached && <Banner tone="warn" message={maxDaysMessage(e.due)} />}
      {e.due && <div style={{ fontSize: 13, marginBottom: 12 }}>Approved, unsettled: <strong>{fmt(e.due.eligible_units)}</strong> day(s) · KES <strong>{fmt(e.due.eligible_gross)}</strong>{e.due.due ? ' — due for payment' : ''}</div>}

      {e.status === 'active' && (
        <>
          <h4 style={{ margin: '8px 0 6px', fontSize: 13 }}>Production assignments</h4>
          {asg && asg.length > 0 && !asg.some(a => a.linked) && (
            <Banner tone="warn" message="No assignment is linked yet. Days recorded in Production will not appear or be paid here until you link this worker’s assignment below." />)}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Attendance only counts once the worker’s Production assignment is linked to this engagement. Linking sets the assignment’s rate to the agreed rate and is refused once time has been recorded on it.</div>
          {!asg ? <Spinner /> : asg.length === 0 ? <Empty>This worker is not assigned to any job on this project yet.{canLinkAssignment(role) ? ' Assign them below.' : ' Ask the production manager to assign them.'}</Empty> : (
            <Table><tbody>{asg.map(a => (
              <tr key={a.id}><td style={td}><strong>{a.job_num}</strong><div style={{ fontSize: 11, color: C.muted }}>{a.description}</div></td>
                <td style={td}>{a.linked ? <Badge label="linked" tone={['#dcfce7', '#166534']} /> : a.linked_elsewhere ? <Badge label="linked to another engagement" /> : <Badge label="not linked" tone={['#fef9c3', '#854d0e']} />}</td>
                <td style={td}>{!a.linked && !a.linked_elsewhere && (canLinkAssignment(role)
                  ? <Btn small loading={busy === a.id} onClick={() => patch(a.id, { action: 'link_assignment', assignment_id: a.id }, () => setMsg('Assignment linked.'))}>Link</Btn>
                  : <span style={{ fontSize: 11, color: C.muted }}>Ask the production manager to link this</span>)}</td></tr>))}</tbody></Table>)}
          {asg && canLinkAssignment(role) && (
            <AssignForm key={`${asg.length}-${targets.length}`} e={e} targets={targets} busy={busy} defaultOpen={asg.length === 0}
              onSubmit={(body) => patch('assign', body, () => setMsg('Worker assigned and linked. Attendance can now be recorded in Production.'))} />)}
        </>)}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
        {e.status === 'planned' && <Btn variant="success" loading={busy === 'activate'} onClick={() => patch('activate', { action: 'activate' })}>Activate</Btn>}
        {SETTLEABLE.includes(e.status) && e.due && Number(e.due.eligible_units) > 0 && <Btn onClick={() => onSettle(e)}>Prepare settlement</Btn>}
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
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty>Nothing is due yet. A worker appears here once they have 3 approved days, or when their engagement ends with days still unpaid. Days are approved in Production → Time.</Empty> : (
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
