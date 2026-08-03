'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/shared/context/AuthContext';
import { C, PageHeader, TabBar } from '@/shared/ui/ds';

// ── Role constants ────────────────────────────────────────────
const PAYROLL_ROLES  = ['admin', 'head_of_sales', 'production_manager'];
const ADMIN_ONLY     = ['admin'];

// ── Colour aliases — map legacy names to design tokens ───────
const CORAL  = C.coral;
const DARK   = C.ink;
const LIGHT  = C.bg;
const BORDER = C.line;
const GREEN  = C.green;
const AMBER  = C.amber;
const RED    = C.red;
const BLUE   = C.blue;
const PURPLE = C.purple;

// ── Helpers ───────────────────────────────────────────────────
const fmt  = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtD = (s) => s ? new Date(s).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** Returns an array of YYYY-MM-DD strings from start to end inclusive (UTC-safe). */
function getDatesInRange(start, end) {
  const dates = [];
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end   + 'T00:00:00Z');
  while (d <= e) {
    dates.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/** Short column label: "Mon 13" — rendered in UTC to avoid day-shift in EAT */
function colLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}

function Badge({ label, color = DARK, bg = LIGHT }) {
  return (
    <span style={{
      background: bg, color, borderRadius: 12, padding: '2px 10px',
      fontSize: 12, fontWeight: 600, letterSpacing: 0.3,
    }}>{label}</span>
  );
}

function StatusBadge({ status }) {
  const map = {
    draft:       { bg: '#fef9c3', color: '#854d0e' },
    approved:    { bg: '#dcfce7', color: '#166534' },
    closed:      { bg: '#f3f4f6', color: '#374151' },
    unpaid:      { bg: '#fee2e2', color: '#991b1b' },
    part_paid:   { bg: '#fef3c7', color: '#92400e' },
    paid:        { bg: '#dcfce7', color: '#166534' },
    exported:    { bg: '#dbeafe', color: '#1e40af' },
    sent:        { bg: '#dbeafe', color: '#1d4ed8' },
    reconciled:  { bg: '#ede9fe', color: '#5b21b6' },
    casual:      { bg: '#fef3c7', color: '#92400e' },
    permanent:   { bg: '#dbeafe', color: '#1e40af' },
    skilled_casual: { bg: '#ede9fe', color: '#5b21b6' },
    combined:    { bg: '#f0fdf4', color: '#166534' },
    weekly:      { bg: '#ecfdf5', color: '#065f46' },
    monthly:     { bg: '#eff6ff', color: '#1e40af' },
  };
  const s = map[status] || { bg: LIGHT, color: DARK };
  return <Badge label={(status || '').replace(/_/g, ' ')} bg={s.bg} color={s.color} />;
}

function Spinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
      <div style={{
        width: 28, height: 28, border: `3px solid ${BORDER}`,
        borderTopColor: CORAL, borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }} />
    </div>
  );
}

function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div style={{
      background: C.redBg, border: `1px solid ${C.redBd}`, borderRadius: 9,
      padding: '10px 14px', color: C.red, fontSize: 13, marginBottom: 12,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span>{message}</span>
      {onDismiss && <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.red }}>×</button>}
    </div>
  );
}

function EmptyState({ icon = '📭', message }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: C.muted }}>
      <div style={{ fontSize: 36, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: 13 }}>{message}</div>
    </div>
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${BORDER}`, borderRadius: 12,
      padding: 20, ...style,
    }}>{children}</div>
  );
}

// ── Modal ─────────────────────────────────────────────────────
function Modal({ title, onClose, children, width = 520 }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      padding: '60px 14px',
    }}>
      <div style={{
        background: C.card, borderRadius: 13, padding: 24, width, maxWidth: '95vw',
        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, borderBottom: `1px solid ${C.line}`, paddingBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: C.muted, lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Form helpers ──────────────────────────────────────────────
function Field({ label, children, required }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {label}{required && <span style={{ color: RED }}> *</span>}
      </label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '9px 11px', border: `1px solid ${BORDER}`,
  borderRadius: 8, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit',
  background: '#fafaf8', color: C.ink,
};

function Btn({ onClick, disabled, loading, children, variant = 'primary', small = false, style = {} }) {
  const base = {
    padding: small ? '6px 11px' : '9px 15px', borderRadius: C.radiusSm, border: 'none',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    fontWeight: 700, fontSize: small ? 12 : 13, opacity: disabled || loading ? 0.45 : 1,
    transition: 'opacity 0.15s', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5,
    ...style,
  };
  const variants = {
    primary:   { background: C.coral,   color: '#fff',  border: `1px solid ${C.coral}` },
    secondary: { background: C.card,    color: C.ink,   border: `1px solid ${C.line}` },
    danger:    { background: C.redBg,   color: C.red,   border: `1px solid ${C.redBd}` },
    success:   { background: C.greenBg, color: C.green, border: `1px solid ${C.greenBd}` },
  };
  return (
    <button onClick={onClick} disabled={disabled || loading} style={{ ...base, ...variants[variant] }}>
      {loading ? '…' : children}
    </button>
  );
}

// ════════════════════════════════════════════════════════════════
// OVERVIEW TAB
// ════════════════════════════════════════════════════════════════
function OverviewTab({ userRole }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [runsData, employeesData, pendingData] = await Promise.all([
        fetch('/api/payroll/runs?limit=5').then(r => r.json()),
        fetch('/api/payroll/employees?active=true').then(r => r.json()),
        fetch('/api/payroll/runs?status=approved&limit=100').then(r => r.json()),
      ]);
      setStats({
        recentRuns:      runsData?.runs || [],
        activeEmployees: employeesData?.employees?.length || 0,
        pendingRuns:     pendingData?.runs || [],
      });
      setLoading(false);
    }
    load().catch(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;

  const totalUnpaid = (stats?.pendingRuns || []).reduce((s, r) => s + Number(r.total_net || 0), 0);

  const metricStyle = { flex: 1, minWidth: 160 };
  const metricCard = (label, value, sub, color = DARK) => (
    <Card style={metricStyle}>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </Card>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        {metricCard('Active Employees', stats?.activeEmployees, 'on payroll', CORAL)}
        {metricCard('Approved Runs', stats?.pendingRuns?.length, 'awaiting payment')}
        {metricCard('Outstanding (KES)', `KES ${fmt(totalUnpaid)}`, 'net payable', totalUnpaid > 0 ? RED : GREEN)}
      </div>

      <Card>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700 }}>Recent Payroll Runs</h3>
        {stats?.recentRuns?.length === 0
          ? <EmptyState message="No payroll runs yet" />
          : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${BORDER}` }}>
                  {['Run #', 'Type', 'Period', 'Status', 'Employees', 'Net Pay'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: '#6b7280', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.recentRuns.map(r => (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '8px', fontWeight: 600 }}>{r.run_num}</td>
                    <td style={{ padding: '8px' }}><StatusBadge status={r.run_type} /></td>
                    <td style={{ padding: '8px', fontSize: 13, color: '#6b7280' }}>{fmtD(r.period_start)} – {fmtD(r.period_end)}</td>
                    <td style={{ padding: '8px' }}><StatusBadge status={r.status} /></td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>{r.employee_count || '—'}</td>
                    <td style={{ padding: '8px', fontWeight: 600 }}>KES {fmt(r.total_net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        }
      </Card>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// EMPLOYEES TAB
// ════════════════════════════════════════════════════════════════
function EmployeesTab({ userRole }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('true');
  const [showForm, setShowForm] = useState(false);
  const [editEmp, setEditEmp] = useState(null);
  const [saving, setSaving] = useState(false);

  const INITIAL_FORM = {
    name: '', type: 'casual', day_rate: '', monthly_salary: '', sha_amount: '300',
    phone: '', id_number: '', nssf_number: '', bank_account: '', bank_name: '',
    hire_date: '', notes: '',
  };
  const [form, setForm] = useState(INITIAL_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (typeFilter)   params.set('type', typeFilter);
    if (activeFilter) params.set('active', activeFilter);
    if (search)       params.set('search', search);
    const res  = await fetch(`/api/payroll/employees?${params}`);
    const data = await res.json();
    setEmployees(data.employees || []);
    setLoading(false);
  }, [typeFilter, activeFilter, search]);

  useEffect(() => { load(); }, [load]);

  function openNew() { setForm(INITIAL_FORM); setEditEmp(null); setShowForm(true); }
  function openEdit(emp) {
    setForm({
      name:           emp.name || '',
      type:           emp.type || 'casual',
      day_rate:       emp.day_rate || '',
      monthly_salary: emp.monthly_salary || '',
      sha_amount:     emp.sha_amount || '300',
      phone:          emp.phone || '',
      id_number:      emp.id_number || '',
      nssf_number:    emp.nssf_number || '',
      bank_account:   emp.bank_account || '',
      bank_name:      emp.bank_name || '',
      hire_date:      emp.hire_date || '',
      notes:          emp.notes || '',
    });
    setEditEmp(emp);
    setShowForm(true);
  }

  async function save() {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    const method  = editEmp ? 'PATCH' : 'POST';
    const url     = editEmp ? `/api/payroll/employees/${editEmp.id}` : '/api/payroll/employees';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    const data    = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || 'Save failed'); return; }
    setShowForm(false);
    load();
  }

  async function toggleActive(emp) {
    await fetch(`/api/payroll/employees/${emp.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !emp.is_active }),
    });
    load();
  }

  const canEdit = PAYROLL_ROLES.includes(userRole);

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ ...inputStyle, width: 220 }}
          placeholder="Search name or phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select style={{ ...inputStyle, width: 150 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          <option value="casual">Casual</option>
          <option value="permanent">Permanent</option>
          <option value="skilled_casual">Skilled Casual</option>
        </select>
        <select style={{ ...inputStyle, width: 130 }} value={activeFilter} onChange={e => setActiveFilter(e.target.value)}>
          <option value="true">Active only</option>
          <option value="false">Inactive</option>
          <option value="">All</option>
        </select>
        <div style={{ flex: 1 }} />
        {canEdit && <Btn onClick={openNew}>+ Add Employee</Btn>}
      </div>

      {loading ? <Spinner /> : employees.length === 0
        ? <EmptyState icon="👥" message="No employees found" />
        : <Card style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: LIGHT, borderBottom: `2px solid ${BORDER}` }}>
                  {['#', 'Name', 'Type', 'Rate', 'SHA', 'Phone', 'Status', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#374151', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map(emp => (
                  <tr key={emp.id} style={{ borderBottom: `1px solid ${BORDER}`, opacity: emp.is_active ? 1 : 0.55 }}>
                    <td style={{ padding: '10px 12px', color: '#9ca3af', fontFamily: 'monospace', fontSize: 12 }}>{emp.employee_num}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>{emp.name}</td>
                    <td style={{ padding: '10px 12px' }}><StatusBadge status={emp.type} /></td>
                    <td style={{ padding: '10px 12px', fontSize: 13 }}>
                      {emp.type === 'permanent'
                        ? `KES ${fmt(emp.monthly_salary)}/mo`
                        : `KES ${fmt(emp.day_rate)}/day`}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 13 }}>KES {fmt(emp.sha_amount)}</td>
                    <td style={{ padding: '10px 12px', fontSize: 13, color: '#6b7280' }}>{emp.phone || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <Badge label={emp.is_active ? 'Active' : 'Inactive'} bg={emp.is_active ? '#dcfce7' : '#f3f4f6'} color={emp.is_active ? GREEN : '#6b7280'} />
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {canEdit && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Btn onClick={() => openEdit(emp)} variant="secondary" small>Edit</Btn>
                          <Btn onClick={() => toggleActive(emp)} variant={emp.is_active ? 'danger' : 'success'} small>
                            {emp.is_active ? 'Deactivate' : 'Activate'}
                          </Btn>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
      }

      {/* Add/Edit Modal */}
      {showForm && (
        <Modal title={editEmp ? `Edit: ${editEmp.name}` : 'Add Employee'} onClose={() => setShowForm(false)} width={560}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Full Name" required>
              <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="Employee Type" required>
              <select style={inputStyle} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                <option value="casual">Casual (daily)</option>
                <option value="permanent">Permanent (monthly)</option>
                <option value="skilled_casual">Skilled Casual</option>
              </select>
            </Field>
            {form.type !== 'permanent'
              ? <Field label="Day Rate (KES)">
                  <input type="number" style={inputStyle} value={form.day_rate} onChange={e => setForm(f => ({ ...f, day_rate: e.target.value }))} />
                </Field>
              : <Field label="Monthly Salary (KES)">
                  <input type="number" style={inputStyle} value={form.monthly_salary} onChange={e => setForm(f => ({ ...f, monthly_salary: e.target.value }))} />
                </Field>
            }
            <Field label="SHA Deduction (KES)">
              <input type="number" style={inputStyle} value={form.sha_amount} onChange={e => setForm(f => ({ ...f, sha_amount: e.target.value }))} />
            </Field>
            <Field label="M-Pesa Phone">
              <input style={inputStyle} value={form.phone} placeholder="07xx…" onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </Field>
            <Field label="ID Number">
              <input style={inputStyle} value={form.id_number} onChange={e => setForm(f => ({ ...f, id_number: e.target.value }))} />
            </Field>
            <Field label="NSSF Number">
              <input style={inputStyle} value={form.nssf_number} onChange={e => setForm(f => ({ ...f, nssf_number: e.target.value }))} />
            </Field>
            <Field label="Hire Date">
              <input type="date" style={inputStyle} value={form.hire_date} onChange={e => setForm(f => ({ ...f, hire_date: e.target.value }))} />
            </Field>
            <Field label="Bank Account">
              <input style={inputStyle} value={form.bank_account} onChange={e => setForm(f => ({ ...f, bank_account: e.target.value }))} />
            </Field>
            <Field label="Bank Name">
              <input style={inputStyle} value={form.bank_name} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} />
            </Field>
          </div>
          <Field label="Notes">
            <textarea style={{ ...inputStyle, height: 60, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </Field>
          {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
            <Btn onClick={save} loading={saving}>{editEmp ? 'Save Changes' : 'Create Employee'}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// PAYROLL RUNS TAB
// ════════════════════════════════════════════════════════════════
function PayrollRunsTab({ userRole }) {
  const [runs, setRuns]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [exportingPdf, setExportingPdf] = useState(null);

  const FORM0 = { period_type: 'weekly', run_type: 'casual', period_start: '', period_end: '', notes: '' };
  const [form, setForm] = useState(FORM0);
  const [saving, setSaving] = useState(false);
  const [reopenId, setReopenId]       = useState(null);
  const [reopenReason, setReopenReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    const res  = await fetch(`/api/payroll/runs?${params}&limit=50`);
    const data = await res.json();
    setRuns(data.runs || []);
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function createRun() {
    if (!form.period_start || !form.period_end) { setError('Period dates required'); return; }
    setSaving(true);
    const res  = await fetch('/api/payroll/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || 'Failed'); return; }
    setShowCreate(false);
    load();
  }

  async function approveRun(runId) {
    setError('');
    const res  = await fetch(`/api/payroll/runs/${runId}/approve`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Approval failed'); return; }
    load();
  }

  async function reopenRun() {
    if (!reopenReason.trim()) { setError('A reason is required to reopen a payroll run'); return; }
    setError('');
    const res  = await fetch(`/api/payroll/runs/${reopenId}/approve?action=reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reopenReason.trim() }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Reopen failed'); return; }
    setReopenId(null);
    setReopenReason('');
    load();
  }

  async function deleteRun(runId, runNum) {
    if (!confirm(`Delete run ${runNum}? This cannot be undone.`)) return;
    setError('');
    const res  = await fetch(`/api/payroll/runs/${runId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Delete failed'); return; }
    load();
  }

  const canCreate  = PAYROLL_ROLES.includes(userRole);
  const canApprove = ADMIN_ONLY.includes(userRole);

  async function exportRunPdf(run) {
    setExportingPdf(run.id);
    try {
      const res = await fetch(`/api/payroll/runs/${run.id}/pdf`);
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF failed'); }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `Payroll_Run_${run.run_num}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('PDF export failed: ' + err.message);
    }
    setExportingPdf(null);
  }

  if (selectedRun) {
    return (
      <RunDetail
        run={selectedRun}
        userRole={userRole}
        onBack={() => { setSelectedRun(null); load(); }}
      />
    );
  }

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError('')} />
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={{ ...inputStyle, width: 160 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="approved">Approved</option>
          <option value="closed">Closed</option>
        </select>
        <div style={{ flex: 1 }} />
        {canCreate && <Btn onClick={() => setShowCreate(true)}>+ New Payroll Run</Btn>}
      </div>

      {loading ? <Spinner /> : runs.length === 0
        ? <EmptyState icon="📋" message="No payroll runs found" />
        : <Card style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: LIGHT, borderBottom: `2px solid ${BORDER}` }}>
                  {['Run #', 'Type', 'Period', 'Status', 'Employees', 'Gross', 'Net', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#374151', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '10px 12px', fontWeight: 700, fontFamily: 'monospace' }}>{run.run_num}</td>
                    <td style={{ padding: '10px 12px' }}><StatusBadge status={run.run_type} /></td>
                    <td style={{ padding: '10px 12px', fontSize: 13, color: '#6b7280' }}>{fmtD(run.period_start)} – {fmtD(run.period_end)}</td>
                    <td style={{ padding: '10px 12px' }}><StatusBadge status={run.status} /></td>
                    <td style={{ padding: '10px 12px', textAlign: 'center' }}>{run.employee_count || '—'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 13 }}>KES {fmt(run.total_gross)}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>KES {fmt(run.total_net)}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Btn onClick={() => setSelectedRun(run)} variant="secondary" small>Open</Btn>
                        <Btn onClick={() => exportRunPdf(run)} variant="secondary" small loading={exportingPdf === run.id} disabled={!!exportingPdf}>PDF</Btn>
                        {canApprove && run.status === 'draft' && (
                          <Btn onClick={() => approveRun(run.id)} variant="success" small>Approve</Btn>
                        )}
                        {canApprove && run.status === 'approved' && (
                          reopenId === run.id
                            ? <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <input
                                  style={{ ...inputStyle, width: 180, padding: '4px 8px', fontSize: 12 }}
                                  placeholder="Reason for reopening…"
                                  value={reopenReason}
                                  onChange={e => setReopenReason(e.target.value)}
                                  autoFocus
                                />
                                <Btn onClick={reopenRun} variant="primary" small>Confirm</Btn>
                                <Btn onClick={() => { setReopenId(null); setReopenReason(''); }} variant="secondary" small>Cancel</Btn>
                              </div>
                            : <Btn onClick={() => { setReopenId(run.id); setReopenReason(''); setError(''); }} small>Reopen</Btn>
                        )}
                        {canApprove && run.status === 'draft' && (
                          <Btn onClick={() => deleteRun(run.id, run.run_num)} variant="danger" small>Delete</Btn>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
      }

      {showCreate && (
        <Modal title="New Payroll Run" onClose={() => setShowCreate(false)}>
          <Field label="Run Type" required>
            <select style={inputStyle} value={form.run_type} onChange={e => setForm(f => ({ ...f, run_type: e.target.value }))}>
              <option value="casual">Casual Weekly</option>
              <option value="permanent">Permanent Monthly</option>
              <option value="skilled_casual">Skilled Casual</option>
              <option value="combined">Combined</option>
            </select>
          </Field>
          <Field label="Period Type" required>
            <select style={inputStyle} value={form.period_type} onChange={e => setForm(f => ({ ...f, period_type: e.target.value }))}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Period Start" required>
              <input type="date" style={inputStyle} value={form.period_start} onChange={e => setForm(f => ({ ...f, period_start: e.target.value }))} />
            </Field>
            <Field label="Period End" required>
              <input type="date" style={inputStyle} value={form.period_end} onChange={e => setForm(f => ({ ...f, period_end: e.target.value }))} />
            </Field>
          </div>
          <Field label="Notes">
            <textarea style={{ ...inputStyle, height: 60 }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </Field>
          {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <Btn variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Btn>
            <Btn onClick={createRun} loading={saving}>Create Run</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Skilled Worker Order Allocations Panel ────────────────────
const BLOCKED_STATUSES = ['Closed', 'Cancelled', 'Cancelled/Refunded', 'Refunded'];

// ── Two-step order+item picker ─────────────────────────────────
// Step 1: pick an order  →  Step 2: pick an item within that order
function OrderItemPicker({ orders, allocs, entry, onAdd, onClose, saving }) {
  const [step, setStep]           = useState(1);
  const [search, setSearch]       = useState('');
  const [pickerOrder, setPickerOrder] = useState(null);
  const [orderItems, setOrderItems]   = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [pickerItem, setPickerItem]   = useState(null);
  const [amount, setAmount]           = useState('');
  const [notes, setNotes]             = useState('');
  const [err, setErr]                 = useState('');

  const activeOrders = orders.filter(o => !BLOCKED_STATUSES.includes(o.status));
  const filtered = search.trim()
    ? activeOrders.filter(o =>
        (o.order_num || '').toLowerCase().includes(search.toLowerCase()) ||
        (o.client    || '').toLowerCase().includes(search.toLowerCase()))
    : activeOrders;

  async function selectOrder(o) {
    setPickerOrder(o);
    setPickerItem(null);
    setAmount('');
    setNotes('');
    setErr('');
    setItemsLoading(true);
    setStep(2);
    const { data } = await supabase
      .from('order_items')
      .select('id, description, category, quantity, unit_price, sort_order')
      .eq('order_id', o.id)
      .order('sort_order', { ascending: true });
    setOrderItems(data || []);
    setItemsLoading(false);
  }

  function selectItem(item) {
    setPickerItem(item);
    setErr('');
  }

  // Is this item already allocated to the SAME order in this session?
  // Repair orders reuse parent item IDs — same item on a different order is allowed.
  const isDuplicateItem = pickerItem && pickerOrder
    ? allocs.some(a => a.order_item_id === pickerItem.id && a.order_id === pickerOrder.id)
    : false;

  function confirm() {
    if (!pickerItem) { setErr('Select an item'); return; }
    if (!amount || Number(amount) <= 0) { setErr('Enter a valid amount'); return; }
    if (isDuplicateItem && !notes.trim()) {
      setErr('This item already has an allocation — add a note (e.g. "repair visit") to confirm');
      return;
    }
    onAdd({
      order_id:        pickerOrder.id,
      order_item_id:   pickerItem.id,
      allocated_amount: Number(amount),
      notes:           notes || null,
      // for display only
      _order:     pickerOrder,
      _item:      pickerItem,
    });
  }

  const ss = {
    label: { fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
    input: { width: '100%', padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, background: '#fafafa', boxSizing: 'border-box', fontFamily: 'inherit' },
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 540, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Modal header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #f0ede8', display: 'flex', alignItems: 'center', gap: 10 }}>
          {step === 2 && (
            <button onClick={() => { setStep(1); setPickerOrder(null); setPickerItem(null); setErr(''); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', fontSize: 18, padding: '0 4px', lineHeight: 1, flexShrink: 0 }}>←</button>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1a1a', marginBottom: 2 }}>
              {step === 1 ? 'Link to customer order' : (
                <span>
                  <span style={{ color: '#E8512A', fontFamily: 'monospace' }}>{pickerOrder?.order_num}</span>
                  {' '}<span style={{ color: '#555', fontWeight: 500 }}>{pickerOrder?.client}</span>
                  {' '}— select item
                </span>
              )}
            </div>
            {step === 1 && (
              <div style={{ fontSize: 11, color: '#aaa' }}>
                Step 1 of 2 — choose the order
              </div>
            )}
            {step === 2 && (
              <div style={{ fontSize: 11, color: '#aaa' }}>Step 2 of 2 — choose the specific item</div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: 20, padding: '0 4px', lineHeight: 1, flexShrink: 0 }}>✕</button>
        </div>

        {/* Step 1 — order search + list */}
        {step === 1 && (
          <>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #f5f3ef' }}>
              <input autoFocus type="text" placeholder="Search by order number or client name…"
                value={search} onChange={e => setSearch(e.target.value)}
                style={{ ...ss.input, fontSize: 14 }} />
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {filtered.length === 0 ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: '#aaa', fontSize: 13 }}>
                  {search ? `No active orders match "${search}"` : 'No active orders available'}
                </div>
              ) : filtered.slice(0, 80).map(o => (
                <button key={o.id} type="button" onClick={() => selectOrder(o)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 20px', border: 'none', borderBottom: '1px solid #f5f3ef', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#fef8f6'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <div style={{ width: 80, flexShrink: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#E8512A', fontFamily: 'monospace' }}>{o.order_num}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.client}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: '#888', background: '#f5f3ef', padding: '2px 8px', borderRadius: 4 }}>{o.status}</span>
                    <span style={{ color: '#ccc', fontSize: 14 }}>›</span>
                  </div>
                </button>
              ))}
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0ede8', fontSize: 11, color: '#aaa' }}>
              {activeOrders.length} active order{activeOrders.length !== 1 ? 's' : ''} available
            </div>
          </>
        )}

        {/* Step 2 — item list + amount form */}
        {step === 2 && (
          <>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {itemsLoading ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading items…</div>
              ) : orderItems.length === 0 ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: '#aaa', fontSize: 13 }}>
                  No items found for this order. Items are added via the order form.
                </div>
              ) : orderItems.map(item => {
                const isSelected    = pickerItem?.id === item.id;
                const alreadyLinked = allocs.some(a => a.order_item_id === item.id && a.order_id === pickerOrder?.id);
                return (
                  <button key={item.id} type="button"
                    onClick={() => selectItem(item)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 20px', border: 'none', borderBottom: '1px solid #f5f3ef', background: isSelected ? '#fff8f6' : 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#fef8f6'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'none'; }}>
                    <div style={{ width: 20, flexShrink: 0, textAlign: 'center' }}>
                      {isSelected && <span style={{ color: '#E8512A', fontWeight: 700, fontSize: 14 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a' }}>{item.description}</div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                        {item.category && <span style={{ marginRight: 8 }}>{item.category}</span>}
                        {item.quantity && <span>Qty: {item.quantity}</span>}
                      </div>
                    </div>
                    {alreadyLinked && (
                      <span style={{ fontSize: 11, color: '#E8512A', background: '#fff0ec', padding: '2px 8px', borderRadius: 4, flexShrink: 0 }}>Already linked</span>
                    )}
                    {item.unit_price && (
                      <span style={{ fontSize: 12, color: '#888', background: '#f5f3ef', padding: '2px 8px', borderRadius: 4, flexShrink: 0, fontFamily: 'monospace' }}>
                        KES {Number(item.unit_price).toLocaleString()}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Amount + notes + confirm */}
            <div style={{ padding: '14px 20px', borderTop: '1px solid #f0ede8', background: '#fafafa' }}>
              {err && (
                <div style={{ fontSize: 12, color: '#C62828', background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 6, padding: '7px 10px', marginBottom: 10 }}>
                  {err}
                </div>
              )}
              {isDuplicateItem && !err && (
                <div style={{ fontSize: 12, color: '#92400E', background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 6, padding: '7px 10px', marginBottom: 10 }}>
                  ⚠ This item already has an allocation. Add a note to confirm (e.g. "repair visit").
                </div>
              )}
              {pickerItem && (
                <div style={{ fontSize: 12, color: '#555', marginBottom: 10 }}>
                  Selected: <strong style={{ color: '#1a1a1a' }}>{pickerItem.description}</strong>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: '0 0 130px' }}>
                  <div style={ss.label}>Amount (KES) *</div>
                  <input type="number" min="1" step="1" placeholder="0"
                    value={amount} onChange={e => setAmount(e.target.value)}
                    style={{ ...ss.input }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={ss.label}>{isDuplicateItem ? 'Note (required — repair/revisit reason)' : 'Notes (optional)'}</div>
                  <input type="text" placeholder={isDuplicateItem ? 'e.g. repair visit, returned item' : 'e.g. joinery work'}
                    value={notes} onChange={e => setNotes(e.target.value)}
                    style={{ ...ss.input }} />
                </div>
                <button onClick={confirm} disabled={saving || !pickerItem}
                  style={{ padding: '9px 20px', borderRadius: 7, border: 'none', background: (saving || !pickerItem) ? '#ccc' : '#1a1a1a', color: '#fff', fontSize: 13, fontWeight: 600, cursor: (saving || !pickerItem) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {saving ? 'Saving…' : 'Add'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SkilledAllocPanel({ entry, runId, canEdit, onSaved }) {
  const [allocs, setAllocs]   = useState([]);
  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/payroll/entries/${entry.id}/allocations`).then(r => r.json()).catch(() => ({})),
      supabase.from('orders').select('id, order_num, client, status').order('created_at', { ascending: false }).limit(300),
    ]).then(([aData, oRes]) => {
      if (aData.error) setError(aData.error);
      setAllocs(aData.allocations || []);
      setOrders(oRes.data || []);
      setLoading(false);
    }).catch(() => { setError('Failed to load'); setLoading(false); });
  }, [entry.id]);

  async function persist(newList) {
    setSaving(true); setError('');
    const res  = await fetch(`/api/payroll/entries/${entry.id}/allocations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocations: newList }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || 'Failed to save'); return false; }
    setAllocs(data.allocations || newList);
    onSaved();
    return true;
  }

  async function handleAdd(pending) {
    // pending: { order_id, order_item_id, allocated_amount, notes, _order, _item }
    const next = [
      ...allocs,
      { ...pending, orders: pending._order, order_item: pending._item },
    ];
    setAllocs(next); // optimistic
    const ok = await persist(next.map(a => ({
      order_id:         a.order_id,
      order_item_id:    a.order_item_id || null,
      allocated_amount: a.allocated_amount,
      notes:            a.notes || null,
    })));
    if (ok) setShowPicker(false);
    else setAllocs(allocs); // revert on failure
  }

  async function removeLink(idx) {
    const next = allocs.filter((_, i) => i !== idx);
    setAllocs(next);
    if (next.length > 0) {
      await persist(next.map(a => ({
        order_id:         a.order_id,
        order_item_id:    a.order_item_id || null,
        allocated_amount: a.allocated_amount,
        notes:            a.notes || null,
      })));
    }
  }

  const totalAlloc = allocs.reduce((s, a) => s + Number(a.allocated_amount || 0), 0);
  const netPay     = Number(entry.net_pay || 0);

  return (
    <div style={{ background: '#f8f9ff', padding: '16px 20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1a1a' }}>
          Order Links — <span style={{ color: BLUE }}>{entry.snapshot_name}</span>
        </div>
        {allocs.length > 0 && (
          <div style={{ fontSize: 12, color: '#6b7280', display: 'flex', gap: 12 }}>
            <span>Allocated: <strong style={{ color: '#1a1a1a' }}>KES {fmt(totalAlloc)}</strong></span>
            {netPay > 0 && (
              <span style={{ color: totalAlloc > netPay ? '#C62828' : '#065F46' }}>
                Net pay: <strong>KES {fmt(netPay)}</strong>
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 13, color: '#C62828', background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>Loading…</div>
      ) : (
        <>
          {/* Existing allocations — card list */}
          {allocs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {allocs.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1.5px solid #E8512A', borderRadius: 8, background: '#fff8f6', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#E8512A', fontFamily: 'monospace', flexShrink: 0 }}>
                    {a.orders?.order_num || a.order_id?.slice(0,8)}
                  </span>
                  <span style={{ fontSize: 12, color: '#555', flexShrink: 0 }}>{a.orders?.client || '—'}</span>
                  {a.order_item && (
                    <>
                      <span style={{ fontSize: 11, color: '#aaa' }}>›</span>
                      <span style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>{a.order_item.description}</span>
                    </>
                  )}
                  <span style={{ fontSize: 12, color: '#fff', background: '#E8512A', padding: '2px 8px', borderRadius: 4, fontFamily: 'monospace', marginLeft: 'auto', flexShrink: 0 }}>
                    KES {fmt(a.allocated_amount)}
                  </span>
                  {a.notes && <span style={{ fontSize: 11, color: '#aaa', fontStyle: 'italic', flexShrink: 0 }}>{a.notes}</span>}
                  {canEdit && (
                    <button onClick={() => removeLink(i)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: 15, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}>✕</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Add link button */}
          {canEdit && (
            <button type="button" onClick={() => setShowPicker(true)}
              style={{ width: '100%', padding: '9px 12px', border: '1.5px dashed #d0d0d0', borderRadius: 7, background: '#fff', color: '#999', fontSize: 13, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
              {allocs.length > 0 ? '+ Link to another order item…' : '+ Link to a customer order item…'}
            </button>
          )}
          {!canEdit && allocs.length === 0 && (
            <div style={{ fontSize: 13, color: '#9ca3af' }}>No order links recorded.</div>
          )}
        </>
      )}

      {/* Two-step picker modal */}
      {showPicker && (
        <OrderItemPicker
          orders={orders}
          allocs={allocs}
          entry={entry}
          saving={saving}
          onAdd={handleAdd}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

// ── Employee Adjustments Panel (inline in attendance grid) ────
function EmployeeAdjPanel({ entry, runId, adjustments, onSaved, canEdit }) {
  const empAdjs = (adjustments || []).filter(a => a.employee_id === entry.employee_id);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState({ adj_type: 'advance', amount: '', is_deduction: true, description: '' });
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');

  async function save() {
    if (!form.amount || !form.description) { setErr('Amount and description required'); return; }
    setSaving(true);
    const res  = await fetch(`/api/payroll/runs/${runId}/adjustments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, employee_id: entry.employee_id, amount: Number(form.amount) }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setErr(data.error || 'Failed'); return; }
    setForm({ adj_type: 'advance', amount: '', is_deduction: true, description: '' });
    setShowForm(false);
    onSaved();
  }

  async function remove(adjId) {
    await fetch(`/api/payroll/runs/${runId}/adjustments?adj_id=${adjId}`, { method: 'DELETE' });
    onSaved();
  }

  return (
    <div style={{ padding: '12px 16px', background: '#fafafa', borderTop: `1px solid ${BORDER}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Adjustments — {entry.snapshot_name}</strong>
        {canEdit && !showForm && <Btn onClick={() => setShowForm(true)} small>+ Add Adjustment</Btn>}
      </div>

      {empAdjs.length === 0 && !showForm && (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>No adjustments for this employee.</div>
      )}

      {empAdjs.map(adj => (
        <div key={adj.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 13, flexWrap: 'wrap' }}>
          <Badge label={adj.adj_type} bg={LIGHT} color="#374151" />
          <Badge
            label={adj.is_deduction ? 'Deduction' : 'Addition'}
            bg={adj.is_deduction ? '#fee2e2' : '#dcfce7'}
            color={adj.is_deduction ? RED : GREEN}
          />
          <strong>KES {fmt(adj.amount)}</strong>
          <span style={{ color: '#6b7280' }}>{adj.description}</span>
          {canEdit && (
            <Btn onClick={() => remove(adj.id)} variant="danger" small>Remove</Btn>
          )}
        </div>
      ))}

      {showForm && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, marginTop: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
            <Field label="Type">
              <select style={inputStyle} value={form.adj_type} onChange={e => setForm(f => ({ ...f, adj_type: e.target.value }))}>
                <option value="advance">Advance</option>
                <option value="damage">Damage</option>
                <option value="overtime">Overtime</option>
                <option value="bonus">Bonus</option>
                <option value="other">Other</option>
              </select>
            </Field>
            <Field label="Amount (KES)">
              <input type="number" style={inputStyle} value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </Field>
            <Field label="Effect">
              <select style={inputStyle} value={form.is_deduction ? 'true' : 'false'} onChange={e => setForm(f => ({ ...f, is_deduction: e.target.value === 'true' }))}>
                <option value="true">Deduction (reduce pay)</option>
                <option value="false">Addition (increase pay)</option>
              </select>
            </Field>
          </div>
          <Field label="Description">
            <input style={inputStyle} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </Field>
          {err && <div style={{ color: RED, fontSize: 12, marginTop: 4 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn onClick={save} loading={saving} small>Save</Btn>
            <Btn variant="secondary" onClick={() => { setShowForm(false); setErr(''); }} small>Cancel</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Run Detail ────────────────────────────────────────────────
function RunDetail({ run: initialRun, userRole, onBack }) {
  const [run, setRun]             = useState(initialRun);
  const [entries, setEntries]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [activeTab, setActiveTab] = useState('entries');
  const [employees, setEmployees] = useState([]);
  const [addingEmp, setAddingEmp] = useState(false);
  const [selectedEmpId, setSelectedEmpId] = useState('');
  const [adding, setAdding]       = useState(false);

  // Attendance grid state
  const [gridData, setGridData]   = useState({});   // { [empId]: { [date]: { present, overtime_hours } } }
  const [attLoading, setAttLoading] = useState(false);
  const [savingGrid, setSavingGrid] = useState(false);
  const [expandedEmp, setExpandedEmp]     = useState(null); // entry.id of expanded row
  const [expandedLinks, setExpandedLinks] = useState(null); // entry.id of expanded order-links row

  // Adjustments state (global list, filtered per-employee in panel)
  const [adjustments, setAdjustments] = useState([]);
  const [showAdjForm, setShowAdjForm] = useState(false);
  const [adjForm, setAdjForm] = useState({ employee_id: '', adj_type: 'advance', amount: '', is_deduction: true, description: '' });
  const [savingAdj, setSavingAdj] = useState(false);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const [entRes, adjRes] = await Promise.all([
      fetch(`/api/payroll/runs/${run.id}/entries`).then(r => r.json()),
      fetch(`/api/payroll/runs/${run.id}/adjustments`).then(r => r.json()),
    ]);
    setEntries(entRes.entries || []);
    setAdjustments(adjRes.adjustments || []);
    setLoading(false);
  }, [run.id]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  useEffect(() => {
    if (addingEmp && employees.length === 0) {
      fetch('/api/payroll/employees?active=true').then(r => r.json()).then(d => setEmployees(d.employees || []));
    }
  }, [addingEmp, employees.length]);

  // Load ALL attendance for the run when attendance tab is opened
  useEffect(() => {
    if (activeTab !== 'attendance') return;
    setAttLoading(true);
    fetch(`/api/payroll/runs/${run.id}/attendance`)
      .then(r => r.json())
      .then(d => {
        const records  = d.attendance || [];
        const dates    = getDatesInRange(run.period_start, run.period_end);
        const casual   = entries.filter(e => e.snapshot_type !== 'permanent');

        // Build grid: fill every (employee × date) with defaults, then overwrite from DB
        const grid = {};
        casual.forEach(entry => {
          grid[entry.employee_id] = {};
          dates.forEach(date => { grid[entry.employee_id][date] = { present: false, overtime_hours: 0 }; });
        });
        records.forEach(a => {
          if (grid[a.employee_id]?.[a.work_date] !== undefined) {
            grid[a.employee_id][a.work_date] = { present: a.present, overtime_hours: Number(a.overtime_hours || 0) };
          }
        });
        setGridData(grid);
        setAttLoading(false);
      });
  }, [activeTab, run.id, run.period_start, run.period_end, entries]);

  async function addEmployee() {
    if (!selectedEmpId) return;
    setAdding(true);
    const res  = await fetch(`/api/payroll/runs/${run.id}/entries`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: selectedEmpId }),
    });
    const data = await res.json();
    setAdding(false);
    if (!res.ok) { setError(data.error || 'Failed to add employee'); return; }
    setAddingEmp(false);
    setSelectedEmpId('');
    loadEntries();
  }

  function togglePresent(empId, date) {
    setGridData(prev => ({
      ...prev,
      [empId]: { ...prev[empId], [date]: { ...prev[empId][date], present: !prev[empId][date].present } },
    }));
  }

  function setOTGrid(empId, date, val) {
    setGridData(prev => ({
      ...prev,
      [empId]: { ...prev[empId], [date]: { ...prev[empId][date], overtime_hours: Number(val) || 0 } },
    }));
  }

  async function saveGrid() {
    setSavingGrid(true);
    const rows = [];
    Object.entries(gridData).forEach(([emp_id, days]) => {
      Object.entries(days).forEach(([work_date, val]) => {
        rows.push({ employee_id: emp_id, work_date, present: val.present, overtime_hours: val.overtime_hours || 0 });
      });
    });
    const res  = await fetch(`/api/payroll/runs/${run.id}/attendance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    const data = await res.json();
    setSavingGrid(false);
    if (!res.ok) { setError(data.error || 'Failed to save attendance'); return; }
    loadEntries();
  }

  async function saveAdj() {
    if (!adjForm.employee_id || !adjForm.amount || !adjForm.description) {
      setError('All adjustment fields required'); return;
    }
    setSavingAdj(true);
    const res  = await fetch(`/api/payroll/runs/${run.id}/adjustments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adjForm),
    });
    const data = await res.json();
    setSavingAdj(false);
    if (!res.ok) { setError(data.error || 'Failed'); return; }
    setShowAdjForm(false);
    setAdjForm({ employee_id: '', adj_type: 'advance', amount: '', is_deduction: true, description: '' });
    loadEntries();
  }

  async function deleteAdj(adjId) {
    await fetch(`/api/payroll/runs/${run.id}/adjustments?adj_id=${adjId}`, { method: 'DELETE' });
    loadEntries();
  }

  const isDraft    = run.status === 'draft';
  // Admin can edit approved runs directly (fewer restrictions); prod_manager only on draft
  const canEdit    = isDraft ? PAYROLL_ROLES.includes(userRole) : userRole === 'admin';
  const canApprove = ADMIN_ONLY.includes(userRole);

  const totalGross = entries.reduce((s, e) => s + Number(e.gross_pay || 0), 0);
  const totalNet   = entries.reduce((s, e) => s + Number(e.net_pay || 0), 0);

  // Live net payable computed from gridData (used on attendance tab before save)
  const liveNetPayable = activeTab === 'attendance' && Object.keys(gridData).length > 0
    ? entries.reduce((sum, entry) => {
        const empGrid = gridData[entry.employee_id] || {};
        if (entry.snapshot_type === 'permanent') return sum + Number(entry.net_pay || 0);
        const days    = Object.values(empGrid).filter(c => c.present).length;
        const otKes   = Object.values(empGrid).reduce((s, c) => s + Number(c.overtime_hours || 0), 0);
        const gross   = days * Number(entry.snapshot_day_rate || 0) + otKes;
        return sum + Math.max(0, gross - Number(entry.snapshot_sha || 0));
      }, 0)
    : totalNet;

  const tabStyle = (t) => ({
    padding: '8px 16px', borderBottom: activeTab === t ? `3px solid ${CORAL}` : '3px solid transparent',
    fontWeight: activeTab === t ? 700 : 500, cursor: 'pointer', fontSize: 14,
    color: activeTab === t ? CORAL : '#6b7280',
  });

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Btn variant="secondary" small onClick={onBack}>← Back</Btn>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{run.run_num}</div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>
            <StatusBadge status={run.run_type} /> &nbsp;
            {fmtD(run.period_start)} – {fmtD(run.period_end)} &nbsp;
            <StatusBadge status={run.status} />
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>
            Net Payable{activeTab === 'attendance' && Object.keys(gridData).length > 0 ? ' (live)' : ''}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: CORAL }}>KES {fmt(liveNetPayable)}</div>
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {/* Sub-tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${BORDER}`, marginBottom: 16 }}>
        <span style={tabStyle('entries')} onClick={() => setActiveTab('entries')}>Entries ({entries.length})</span>
        <span style={tabStyle('attendance')} onClick={() => setActiveTab('attendance')}>Attendance</span>
        <span style={tabStyle('adjustments')} onClick={() => setActiveTab('adjustments')}>Adjustments ({adjustments.length})</span>
      </div>

      {/* ENTRIES */}
      {activeTab === 'entries' && (
        <>
          {canEdit && (
            <div style={{ marginBottom: 12 }}>
              {addingEmp
                ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select style={{ ...inputStyle, width: 280 }} value={selectedEmpId} onChange={e => setSelectedEmpId(e.target.value)}>
                      <option value="">— Select employee —</option>
                      {employees
                        .filter(e => !entries.find(en => en.employee_id === e.id))
                        .filter(e => e.type === run.run_type)
                        .map(e => (
                          <option key={e.id} value={e.id}>{e.name} ({e.type})</option>
                        ))}
                    </select>
                    <Btn onClick={addEmployee} loading={adding}>Add</Btn>
                    <Btn variant="secondary" onClick={() => setAddingEmp(false)}>Cancel</Btn>
                  </div>
                : <Btn onClick={() => setAddingEmp(true)}>+ Add Employee</Btn>
              }
            </div>
          )}

          {loading ? <Spinner /> : entries.length === 0
            ? <EmptyState icon="👥" message="No employees added to this run yet" />
            : <Card style={{ padding: 0 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: LIGHT, borderBottom: `2px solid ${BORDER}` }}>
                      {['Employee', 'Type', 'Days', 'OT (KES)', 'Gross', 'SHA', 'Deductions', 'Net', 'Paid', 'Status', ''].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, color: '#6b7280', fontSize: 11 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(entry => (
                      <React.Fragment key={entry.id}>
                      <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                        <td style={{ padding: '8px 10px', fontWeight: 600 }}>{entry.snapshot_name}</td>
                        <td style={{ padding: '8px 10px' }}><StatusBadge status={entry.snapshot_type} /></td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{entry.days_worked}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{Number(entry.overtime_amount || 0) > 0 ? `KES ${fmt(entry.overtime_amount)}` : '—'}</td>
                        <td style={{ padding: '8px 10px' }}>KES {fmt(entry.gross_pay)}</td>
                        <td style={{ padding: '8px 10px', color: RED }}>-{fmt(entry.sha_deduction)}</td>
                        <td style={{ padding: '8px 10px', color: RED }}>-{fmt(entry.total_deductions)}</td>
                        <td style={{ padding: '8px 10px', fontWeight: 700 }}>KES {fmt(entry.net_pay)}</td>
                        <td style={{ padding: '8px 10px', color: GREEN }}>KES {fmt(entry.amount_paid)}</td>
                        <td style={{ padding: '8px 10px' }}><StatusBadge status={entry.payment_status} /></td>
                        <td style={{ padding: '8px 10px' }}>
                          {entry.snapshot_type === 'casual' && (
                            <Btn onClick={() => setActiveTab('attendance')} variant="secondary" small>Attendance</Btn>
                          )}
                          {entry.snapshot_type === 'skilled_casual' && canEdit && (
                            <Btn
                              onClick={() => setExpandedLinks(expandedLinks === entry.id ? null : entry.id)}
                              variant="secondary" small
                            >
                              {expandedLinks === entry.id ? '▲ Links' : '⛓ Order Links'}
                            </Btn>
                          )}
                        </td>
                      </tr>
                      {entry.snapshot_type === 'skilled_casual' && expandedLinks === entry.id && (
                        <tr key={`links-${entry.id}`} style={{ background: '#f0f4ff', borderBottom: `1px solid ${BORDER}` }}>
                          <td colSpan={11} style={{ padding: 0 }}>
                            <SkilledAllocPanel
                              entry={entry}
                              runId={run.id}
                              canEdit={canEdit}
                              onSaved={loadEntries}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: LIGHT, borderTop: `2px solid ${BORDER}` }}>
                      <td colSpan={4} style={{ padding: '10px 10px', fontWeight: 700 }}>Totals ({entries.length} employees)</td>
                      <td style={{ padding: '10px 10px', fontWeight: 700 }}>KES {fmt(totalGross)}</td>
                      <td colSpan={2} style={{ padding: '10px 10px', color: RED, fontWeight: 700 }}>
                        -{fmt(entries.reduce((s, e) => s + Number(e.total_deductions || 0), 0))}
                      </td>
                      <td colSpan={3} style={{ padding: '10px 10px', fontWeight: 800, color: CORAL }}>KES {fmt(totalNet)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </Card>
          }
        </>
      )}

      {/* ATTENDANCE GRID */}
      {activeTab === 'attendance' && (() => {
        const casualEntries = entries.filter(e => e.snapshot_type === 'casual');
        const dates = run.period_start && run.period_end ? getDatesInRange(run.period_start, run.period_end) : [];

        if (casualEntries.length === 0) {
          return <EmptyState icon="📅" message="No casual (daily) employees in this run — skilled workers are paid by order, manage their pay via Order Links in the Entries tab" />;
        }

        return (
          <div>
            {attLoading ? <Spinner /> : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 600 }}>
                    <thead>
                      <tr style={{ background: LIGHT, borderBottom: `2px solid ${BORDER}` }}>
                        <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 700, minWidth: 160, position: 'sticky', left: 0, background: LIGHT, zIndex: 1 }}>
                          Employee
                        </th>
                        {dates.map(d => (
                          <th key={d} style={{ textAlign: 'center', padding: '8px 6px', fontWeight: 600, fontSize: 11, color: '#374151', minWidth: 68 }}>
                            {colLabel(d)}
                          </th>
                        ))}
                        <th style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: '#374151', minWidth: 80 }}>
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {casualEntries.map(entry => {
                        const empGrid   = gridData[entry.employee_id] || {};
                        const daysOn    = Object.values(empGrid).filter(c => c.present).length;
                        const totalOT   = Object.values(empGrid).reduce((s, c) => s + Number(c.overtime_hours || 0), 0);
                        const liveGross = daysOn * Number(entry.snapshot_day_rate || 0) + totalOT;
                        const liveNet   = Math.max(0, liveGross - Number(entry.snapshot_sha || 0));
                        const isExpanded = expandedEmp === entry.id;

                        return (
                          <React.Fragment key={entry.id}>
                            <tr style={{ borderBottom: isExpanded ? 'none' : `1px solid ${BORDER}`, background: isExpanded ? '#fff8f6' : 'white' }}>
                              {/* Employee name — click to expand adjustments */}
                              <td style={{ padding: '8px 12px', position: 'sticky', left: 0, background: isExpanded ? '#fff8f6' : 'white', zIndex: 1 }}>
                                <span
                                  onClick={() => setExpandedEmp(isExpanded ? null : entry.id)}
                                  style={{ cursor: 'pointer', color: CORAL, fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}
                                >
                                  {entry.snapshot_name}
                                  <span style={{ fontSize: 10, opacity: 0.7 }}>{isExpanded ? '▲' : '▼'}</span>
                                </span>
                                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{entry.snapshot_type}</div>
                              </td>

                              {/* Date cells */}
                              {dates.map(date => {
                                const cell = empGrid[date] || { present: false, overtime_hours: 0 };
                                return (
                                  <td key={date} style={{ padding: '6px 4px', textAlign: 'center', verticalAlign: 'top' }}>
                                    <input
                                      type="checkbox"
                                      checked={!!cell.present}
                                      disabled={!canEdit}
                                      onChange={() => togglePresent(entry.employee_id, date)}
                                      style={{ width: 16, height: 16, cursor: canEdit ? 'pointer' : 'default', accentColor: CORAL }}
                                    />
                                    <input
                                      type="number" min="0" step="50"
                                      value={cell.overtime_hours || ''}
                                      placeholder="OT KES"
                                      disabled={!canEdit}
                                      onChange={e => setOTGrid(entry.employee_id, date, e.target.value)}
                                      style={{ display: 'block', width: 60, margin: '3px auto 0', border: `1px solid ${BORDER}`, borderRadius: 4, padding: '2px 4px', fontSize: 10, textAlign: 'center', background: canEdit ? 'white' : '#f5f5f5' }}
                                    />
                                  </td>
                                );
                              })}

                              {/* Totals — live computed */}
                              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, fontSize: 12, minWidth: 90 }}>
                                <div style={{ color: daysOn > 0 ? GREEN : '#9ca3af' }}>{daysOn}d</div>
                                {totalOT > 0 && <div style={{ color: AMBER, fontSize: 11 }}>+{fmt(totalOT)} OT</div>}
                                <div style={{ color: CORAL, fontSize: 12, marginTop: 2 }}>KES {fmt(liveNet)}</div>
                              </td>
                            </tr>

                            {/* Inline adjustments expand */}
                            {isExpanded && (
                              <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                                <td colSpan={dates.length + 2} style={{ padding: 0 }}>
                                  <EmployeeAdjPanel
                                    entry={entry}
                                    runId={run.id}
                                    adjustments={adjustments}
                                    onSaved={loadEntries}
                                    canEdit={canEdit}
                                  />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {canEdit && (
                  <div style={{ marginTop: 16 }}>
                    <Btn onClick={saveGrid} loading={savingGrid}>Save Attendance</Btn>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

      {/* ADJUSTMENTS */}
      {activeTab === 'adjustments' && (
        <div>
          {canEdit && (
            <div style={{ marginBottom: 12 }}>
              <Btn onClick={() => setShowAdjForm(true)}>+ Add Adjustment</Btn>
            </div>
          )}
          {adjustments.length === 0
            ? <EmptyState icon="⚖️" message="No adjustments yet" />
            : <Card style={{ padding: 0 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: LIGHT, borderBottom: `2px solid ${BORDER}` }}>
                      {['Employee', 'Type', 'Amount', 'Deduction?', 'Description', ''].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 12, color: '#6b7280' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {adjustments.map(adj => (
                      <tr key={adj.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{adj.employees?.name || '—'}</td>
                        <td style={{ padding: '8px 12px' }}><StatusBadge status={adj.adj_type} /></td>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>KES {fmt(adj.amount)}</td>
                        <td style={{ padding: '8px 12px' }}>
                          <Badge label={adj.is_deduction ? 'Deduction' : 'Addition'} bg={adj.is_deduction ? '#fee2e2' : '#dcfce7'} color={adj.is_deduction ? RED : GREEN} />
                        </td>
                        <td style={{ padding: '8px 12px', fontSize: 13, color: '#6b7280' }}>{adj.description}</td>
                        <td style={{ padding: '8px 12px' }}>
                          {canEdit && <Btn onClick={() => deleteAdj(adj.id)} variant="danger" small>Remove</Btn>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
          }

          {showAdjForm && (
            <Modal title="Add Adjustment" onClose={() => setShowAdjForm(false)}>
              <Field label="Employee" required>
                <select style={inputStyle} value={adjForm.employee_id} onChange={e => setAdjForm(f => ({ ...f, employee_id: e.target.value }))}>
                  <option value="">— Select —</option>
                  {entries.map(e => <option key={e.employee_id} value={e.employee_id}>{e.snapshot_name}</option>)}
                </select>
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Type" required>
                  <select style={inputStyle} value={adjForm.adj_type} onChange={e => setAdjForm(f => ({ ...f, adj_type: e.target.value }))}>
                    <option value="advance">Advance (deduction)</option>
                    <option value="damage">Damage (deduction)</option>
                    <option value="overtime">Overtime (addition)</option>
                    <option value="bonus">Bonus (addition)</option>
                    <option value="other">Other</option>
                  </select>
                </Field>
                <Field label="Amount (KES)" required>
                  <input type="number" style={inputStyle} value={adjForm.amount} onChange={e => setAdjForm(f => ({ ...f, amount: e.target.value }))} />
                </Field>
              </div>
              <Field label="Effect">
                <select style={inputStyle} value={adjForm.is_deduction ? 'true' : 'false'} onChange={e => setAdjForm(f => ({ ...f, is_deduction: e.target.value === 'true' }))}>
                  <option value="true">Deduction (reduce net pay)</option>
                  <option value="false">Addition (increase net pay)</option>
                </select>
              </Field>
              <Field label="Description" required>
                <input style={inputStyle} value={adjForm.description} onChange={e => setAdjForm(f => ({ ...f, description: e.target.value }))} />
              </Field>
              {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <Btn variant="secondary" onClick={() => setShowAdjForm(false)}>Cancel</Btn>
                <Btn onClick={saveAdj} loading={savingAdj}>Save</Btn>
              </div>
            </Modal>
          )}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// PAYMENTS TAB
// ════════════════════════════════════════════════════════════════
// ── ApportionmentModal ────────────────────────────────────────
// Note: apportionment and FIFO-split math was removed from the client.
// The preview endpoint (GET /api/payroll/batches/preview?amount_available=…)
// now runs the same logic as the batch POST and returns pre-computed
// worker.allocation, worker.workerLinks, and worker.status fields.
function ApportionmentModal({ runs, onClose, onCreated }) {
  const [step, setStep]             = useState(1); // 1=form, 2=preview, 3=confirm
  const [form, setForm]             = useState({ run_id: '', payment_method: 'mpesa', notes: '', amount_available: '' });
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating]     = useState(false);
  const [pool, setPool]             = useState(null);   // { run, workers, run_total_owed }
  const [computed, setComputed]     = useState(null);   // { workers with allocation, links, total }
  const [err, setErr]               = useState('');

  async function preview() {
    if (!form.run_id) { setErr('Select a payroll run'); return; }
    const amt = Number(form.amount_available);
    if (!Number.isSafeInteger(amt) || amt <= 0) { setErr('Enter a valid amount available'); return; }
    setPreviewing(true);
    setErr('');
    // Pass amount_available so the server runs apportion() + fifoSplit() server-side.
    // The returned workers already have allocation, workerLinks, and status fields —
    // we use them directly so the preview always matches what the batch POST will save.
    const res  = await fetch(`/api/payroll/batches/preview?run_id=${form.run_id}&amount_available=${amt}`);
    const data = await res.json();
    setPreviewing(false);
    if (!res.ok) { setErr(data.error || 'Failed to load pool'); return; }

    const { workers, run_total_owed, links, effective_total } = data;

    setPool(data);
    setComputed({ workers, links, total: effective_total ?? amt, run_total_owed });
    setStep(2);
  }

  async function confirm() {
    setCreating(true);
    setErr('');
    // Send only inputs — server recomputes apportionment and creates batch atomically.
    // Links are NOT sent from the client to prevent tampering.
    const res  = await fetch('/api/payroll/batches', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        run_id:           form.run_id,
        payment_method:   form.payment_method,
        notes:            form.notes || null,
        amount_available: Number(form.amount_available),
      }),
    });
    const data = await res.json();
    setCreating(false);
    if (!res.ok) { setErr(data.error || 'Failed to create batch'); return; }
    onCreated();
  }

  const amt          = Number(form.amount_available) || 0;
  const isShortCash  = computed && amt < computed.run_total_owed - 0.5;
  const ratio        = computed ? Math.min(1, amt / computed.run_total_owed) : 0;

  return (
    <Modal
      title={step === 1 ? 'New Payment Batch' : 'Apportionment Preview'}
      onClose={onClose}
      width={step === 1 ? 520 : 760}
    >
      {/* ── Step 1: Form ── */}
      {step === 1 && (
        <div>
          <Field label="Payroll Run" required>
            <select style={inputStyle} value={form.run_id} onChange={e => setForm(f => ({ ...f, run_id: e.target.value }))}>
              <option value="">— Select approved run —</option>
              {runs.map(r => (
                <option key={r.id} value={r.id}>
                  {r.run_num} | {fmtD(r.period_start)}–{fmtD(r.period_end)} | KES {fmt(r.total_net)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payment Method">
            <select style={inputStyle} value={form.payment_method} onChange={e => setForm(f => ({ ...f, payment_method: e.target.value }))}>
              <option value="mpesa">M-Pesa (Chatpesa)</option>
              <option value="cash">Cash</option>
              <option value="bank">Bank Transfer</option>
              <option value="mixed">Mixed</option>
            </select>
          </Field>
          <Field label="Amount Available to Disburse (KES)" required>
            <input
              type="number" min="0" step="1"
              style={inputStyle}
              placeholder="e.g. 60000"
              value={form.amount_available}
              onChange={e => setForm(f => ({ ...f, amount_available: e.target.value }))}
            />
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
              Enter the actual cash/float available. If this is less than what's owed, pay is apportioned proportionally.
            </div>
          </Field>
          <Field label="Notes">
            <textarea style={{ ...inputStyle, height: 56 }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </Field>
          {err && <ErrorBanner message={err} onDismiss={() => setErr('')} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn onClick={preview} loading={previewing}>Preview →</Btn>
          </div>
        </div>
      )}

      {/* ── Step 2: Preview table ── */}
      {step === 2 && computed && (
        <div>
          {/* Summary banner */}
          <div style={{
            display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center',
            background: isShortCash ? '#fef3c7' : '#dcfce7',
            border: `1px solid ${isShortCash ? '#fbbf24' : '#86efac'}`,
            borderRadius: 8, padding: '10px 14px', marginBottom: 16,
          }}>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Available</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#1a1a1a' }}>KES {fmt(amt)}</div>
            </div>
            <div style={{ color: '#d1d5db', fontSize: 18 }}>÷</div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total Owed</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#1a1a1a' }}>KES {fmt(computed.run_total_owed)}</div>
            </div>
            <div style={{ color: '#d1d5db', fontSize: 18 }}>=</div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Ratio</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: isShortCash ? '#92400e' : '#166534' }}>
                {isShortCash ? `${(ratio * 100).toFixed(1)}%` : '100% (full pay)'}
              </div>
            </div>
            {isShortCash && (
              <div style={{ marginLeft: 'auto', fontSize: 12, color: '#92400e', fontWeight: 600 }}>
                ⚠ Short-cash — proportional apportionment applied
              </div>
            )}
          </div>

          {/* Worker table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                  {['Employee', 'Bal B/F', 'This Run', 'Total Owed', 'Allocation', 'Status'].map(h => (
                    <th key={h} style={{ textAlign: h === 'Employee' ? 'left' : 'right', padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                      {h === 'Status' ? <span style={{ display: 'block', textAlign: 'center' }}>{h}</span> : h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {computed.workers.map((w, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '9px 10px', fontWeight: 600, color: '#111827' }}>{w.employee_name}</td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', color: w.balance_brought_forward > 0 ? CORAL : '#9ca3af', fontSize: 12 }}>
                      {w.balance_brought_forward > 0 ? `KES ${fmt(w.balance_brought_forward)}` : '—'}
                    </td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', color: '#374151' }}>KES {fmt(w.current_balance)}</td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600, color: '#111827' }}>KES {fmt(w.total_owed)}</td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 700, color: w.allocation > 0 ? GREEN : '#9ca3af' }}>
                      {w.allocation > 0 ? `KES ${fmt(w.allocation)}` : '—'}
                    </td>
                    <td style={{ padding: '9px 10px', textAlign: 'center' }}>
                      <StatusBadge status={w.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                  <td style={{ padding: '9px 10px', fontWeight: 700, color: '#111827' }}>Total</td>
                  <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600, color: CORAL }}>
                    {computed.workers.some(w => w.balance_brought_forward > 0)
                      ? `KES ${fmt(computed.workers.reduce((s, w) => s + w.balance_brought_forward, 0))}`
                      : '—'}
                  </td>
                  <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600 }}>
                    KES {fmt(computed.workers.reduce((s, w) => s + w.current_balance, 0))}
                  </td>
                  <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 700 }}>
                    KES {fmt(computed.run_total_owed)}
                  </td>
                  <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 700, color: GREEN }}>
                    KES {fmt(computed.links.reduce((s, l) => s + l.amount, 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {err && <ErrorBanner message={err} onDismiss={() => setErr('')} />}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 }}>
            <Btn variant="secondary" onClick={() => { setStep(1); setErr(''); }}>← Back</Btn>
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
              <Btn onClick={confirm} loading={creating}>Confirm & Create Batch</Btn>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function PaymentsTab({ userRole }) {
  const [batches, setBatches]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [runs, setRuns]         = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [reconcileId, setReconcileId] = useState(null);
  const [chatpesaRef, setChatpesaRef] = useState('');
  const [expandedId, setExpandedId]   = useState(null);
  const [detail, setDetail]           = useState({});   // { [batchId]: { links, loading } }

  async function loadDetail(batchId) {
    if (detail[batchId]?.links) return; // already loaded
    setDetail(d => ({ ...d, [batchId]: { loading: true } }));
    const res  = await fetch(`/api/payroll/batches/${batchId}`);
    const data = await res.json();
    setDetail(d => ({ ...d, [batchId]: { loading: false, links: data.links || [] } }));
  }

  function toggleExpand(batchId) {
    if (expandedId === batchId) { setExpandedId(null); return; }
    setExpandedId(batchId);
    loadDetail(batchId);
  }
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [bRes, rRes] = await Promise.all([
      fetch('/api/payroll/batches').then(r => r.json()),
      fetch('/api/payroll/runs?status=approved&limit=50').then(r => r.json()),
    ]);
    setBatches(bRes.batches || []);
    setRuns(rRes.runs || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);


  async function downloadCsv(batchId, batchNum) {
    const res = await fetch(`/api/payroll/batches/${batchId}/chatpesa`);
    if (!res.ok) { const d = await res.json(); setError(d.error || 'Export failed'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `chatpesa_${batchNum}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    load();
  }

  async function reconcile(batchId) {
    const res  = await fetch(`/api/payroll/batches/${batchId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reconcile', chatpesa_ref: chatpesaRef }),
    });
    if (!res.ok) { setError('Reconcile failed'); return; }
    setReconcileId(null);
    setChatpesaRef('');
    load();
  }

  async function deleteBatch(batchId, batchNum) {
    if (!confirm(`Delete payment batch ${batchNum}? This cannot be undone.`)) return;
    setDeletingId(batchId);
    const res  = await fetch(`/api/payroll/batches/${batchId}`, { method: 'DELETE' });
    const data = await res.json();
    setDeletingId(null);
    if (!res.ok) { setError(data.error || 'Failed to delete batch'); return; }
    load();
  }

  const canCreateBatch    = PAYROLL_ROLES.includes(userRole);
  const canExportBatch    = PAYROLL_ROLES.includes(userRole);
  const canReconcileBatch = ADMIN_ONLY.includes(userRole);
  const canDeleteBatch    = ADMIN_ONLY.includes(userRole);

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError('')} />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        {canCreateBatch && <Btn onClick={() => setShowCreate(true)}>+ New Payment Batch</Btn>}
      </div>

      {loading ? <Spinner /> : batches.length === 0
        ? <EmptyState icon="💳" message="No payment batches yet. Approve a payroll run first." />
        : <Card style={{ padding: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: LIGHT, borderBottom: `2px solid ${BORDER}` }}>
                  {['Batch #', 'Run', 'Method', 'Amount', 'Status', 'Chatpesa Ref', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#6b7280', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batches.map(b => {
                  const isOpen   = expandedId === b.id;
                  const det      = detail[b.id];
                  const links    = det?.links || [];
                  const paidCount   = links.filter(l => l.payroll_entries?.payment_status === 'paid').length;
                  const unpaidCount = links.length - paidCount;
                  return (
                    <React.Fragment key={b.id}>
                      {/* ── Batch summary row ── */}
                      <tr
                        onClick={() => toggleExpand(b.id)}
                        style={{ borderBottom: isOpen ? 'none' : `1px solid ${BORDER}`, cursor: 'pointer', background: isOpen ? '#fef8f6' : 'transparent' }}
                        onMouseEnter={e => { if (!isOpen) e.currentTarget.style.background = '#fafafa'; }}
                        onMouseLeave={e => { if (!isOpen) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <td style={{ padding: '10px 12px', fontWeight: 700, fontFamily: 'monospace' }}>
                          <span style={{ marginRight: 6, fontSize: 11, color: '#aaa' }}>{isOpen ? '▾' : '▸'}</span>
                          {b.batch_num}
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 13, color: '#6b7280' }}>{b.payroll_runs?.run_num || '—'}</td>
                        <td style={{ padding: '10px 12px' }}><Badge label={b.payment_method} bg="#dbeafe" color={BLUE} /></td>
                        <td style={{ padding: '10px 12px', fontWeight: 600 }}>KES {fmt(b.total_amount)}</td>
                        <td style={{ padding: '10px 12px' }}><StatusBadge status={b.status} /></td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#9ca3af' }}>{b.chatpesa_ref || '—'}</td>
                        <td style={{ padding: '10px 12px' }} onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {canExportBatch && b.payment_method === 'mpesa' && b.status !== 'reconciled' && (
                              <Btn onClick={() => downloadCsv(b.id, b.batch_num)} variant="secondary" small>⬇ CSV</Btn>
                            )}
                            {canReconcileBatch && b.payment_method === 'mpesa' && b.status === 'exported' && (
                              reconcileId === b.id
                                ? <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <input style={{ ...inputStyle, width: 140, padding: '4px 8px' }} placeholder="Chatpesa ref…" value={chatpesaRef} onChange={e => setChatpesaRef(e.target.value)} />
                                    <Btn onClick={() => reconcile(b.id)} variant="success" small>Confirm</Btn>
                                    <Btn onClick={() => setReconcileId(null)} variant="secondary" small>Cancel</Btn>
                                  </div>
                                : <Btn onClick={() => setReconcileId(b.id)} variant="success" small>Reconcile</Btn>
                            )}
                            {canReconcileBatch && b.payment_method !== 'mpesa' && b.status === 'draft' && (
                              reconcileId === b.id
                                ? <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <input style={{ ...inputStyle, width: 160, padding: '4px 8px' }} placeholder="Reference / receipt no." value={chatpesaRef} onChange={e => setChatpesaRef(e.target.value)} />
                                    <Btn onClick={() => reconcile(b.id)} variant="success" small>Mark Paid</Btn>
                                    <Btn onClick={() => setReconcileId(null)} variant="secondary" small>Cancel</Btn>
                                  </div>
                                : <Btn onClick={() => setReconcileId(b.id)} variant="success" small>Mark Paid</Btn>
                            )}
                            {canDeleteBatch && b.status !== 'reconciled' && (
                              <Btn onClick={() => deleteBatch(b.id, b.batch_num)} variant="danger" small loading={deletingId === b.id}>Delete</Btn>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* ── Expanded detail panel ── */}
                      {isOpen && (
                        <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                          <td colSpan={7} style={{ padding: 0, background: '#fef8f6' }}>
                            <div style={{ padding: '0 16px 16px 32px' }}>

                              {/* Summary chips */}
                              <div style={{ display: 'flex', gap: 12, padding: '12px 0 10px', borderBottom: `1px solid #f0ede8`, marginBottom: 10 }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>
                                  {links.length} employee{links.length !== 1 ? 's' : ''}
                                </span>
                                <span style={{ fontSize: 12, background: '#dcfce7', color: '#166534', padding: '2px 10px', borderRadius: 10, fontWeight: 600 }}>
                                  ✓ {paidCount} paid
                                </span>
                                {unpaidCount > 0 && (
                                  <span style={{ fontSize: 12, background: '#fef3c7', color: '#92400e', padding: '2px 10px', borderRadius: 10, fontWeight: 600 }}>
                                    ⏳ {unpaidCount} outstanding
                                  </span>
                                )}
                              </div>

                              {/* Employee rows */}
                              {det?.loading ? (
                                <div style={{ padding: '16px 0', color: '#aaa', fontSize: 13 }}>Loading…</div>
                              ) : links.length === 0 ? (
                                <div style={{ padding: '16px 0', color: '#aaa', fontSize: 13 }}>No entries linked to this batch.</div>
                              ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                  <thead>
                                    <tr style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600 }}>
                                      <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Employee</th>
                                      <th style={{ textAlign: 'right', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Net Pay</th>
                                      <th style={{ textAlign: 'right', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Paid</th>
                                      <th style={{ textAlign: 'right', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Balance</th>
                                      <th style={{ textAlign: 'center', padding: '4px 0 4px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {links.map((l, i) => {
                                      const e       = l.payroll_entries || {};
                                      const netPay  = Number(e.net_pay   || 0);
                                      const paid    = Number(e.amount_paid || 0);
                                      const balance = netPay - paid;
                                      // If batch exported + entry was in the export CSV → show "sent" (Chatpesa payment dispatched)
                                      const isSent  = b.status === 'exported' && Array.isArray(b.exported_entry_ids) && b.exported_entry_ids.includes(e.id);
                                      const displayStatus = isSent && (e.payment_status === 'unpaid' || e.payment_status === 'part_paid')
                                        ? 'sent'
                                        : (e.payment_status || 'unpaid');
                                      return (
                                        <tr key={i} style={{ borderTop: '1px solid #f0ede8' }}>
                                          <td style={{ padding: '7px 8px 7px 0', fontWeight: 600, color: '#1a1a1a' }}>{e.snapshot_name || '—'}</td>
                                          <td style={{ padding: '7px 8px', textAlign: 'right', color: '#374151' }}>KES {fmt(netPay)}</td>
                                          <td style={{ padding: '7px 8px', textAlign: 'right', color: GREEN, fontWeight: paid > 0 ? 600 : 400 }}>
                                            {paid > 0 ? `KES ${fmt(paid)}` : '—'}
                                          </td>
                                          <td style={{ padding: '7px 8px', textAlign: 'right', color: balance > 0 ? CORAL : '#9ca3af', fontWeight: balance > 0 ? 600 : 400 }}>
                                            {balance > 0 ? `KES ${fmt(balance)}` : '—'}
                                          </td>
                                          <td style={{ padding: '7px 0 7px 8px', textAlign: 'center' }}>
                                            <StatusBadge status={displayStatus} />
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>
      }

      {showCreate && (
        <ApportionmentModal
          runs={runs}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// COMPLIANCE TAB
// ════════════════════════════════════════════════════════════════
function ComplianceTab({ userRole }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ rule_type: 'sha', effective_from: '', fixed_amount: '', rate: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/payroll/statutory').then(r => r.json()).then(d => { setRules(d.rules || []); setLoading(false); });
  }, []);

  async function save() {
    setSaving(true);
    const res  = await fetch('/api/payroll/statutory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || 'Failed'); return; }
    setShowForm(false);
    const updated = await fetch('/api/payroll/statutory').then(r => r.json());
    setRules(updated.rules || []);
  }

  const isAdmin = userRole === 'admin';
  const activeRules = rules.filter(r => !r.effective_to);

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {/* Active rules summary */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {activeRules.map(r => (
          <Card key={r.id} style={{ flex: '0 0 auto', minWidth: 180 }}>
            <div style={{ fontSize: 12, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>{r.rule_type}</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>
              {r.fixed_amount ? `KES ${fmt(r.fixed_amount)}` : `${r.rate}%`}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>from {fmtD(r.effective_from)}</div>
          </Card>
        ))}
        {activeRules.length === 0 && !loading && (
          <Card>
            <div style={{ color: '#9ca3af', fontSize: 14 }}>No statutory rules configured</div>
          </Card>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Rule History</h3>
        {isAdmin && <Btn onClick={() => setShowForm(true)}>+ Add Rule</Btn>}
      </div>

      {loading ? <Spinner /> : (
        <Card style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: LIGHT, borderBottom: `2px solid ${BORDER}` }}>
                {['Type', 'Amount/Rate', 'Effective From', 'Effective To', 'Description'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 12, color: '#6b7280' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.id} style={{ borderBottom: `1px solid ${BORDER}`, opacity: r.effective_to ? 0.6 : 1 }}>
                  <td style={{ padding: '8px 12px' }}><Badge label={r.rule_type.toUpperCase()} bg="#ede9fe" color={PURPLE} /></td>
                  <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                    {r.fixed_amount ? `KES ${fmt(r.fixed_amount)} (fixed)` : `${r.rate}% (rate)`}
                  </td>
                  <td style={{ padding: '8px 12px' }}>{fmtD(r.effective_from)}</td>
                  <td style={{ padding: '8px 12px', color: r.effective_to ? RED : GREEN }}>
                    {r.effective_to ? fmtD(r.effective_to) : '(active)'}
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 13, color: '#6b7280' }}>{r.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {showForm && (
        <Modal title="Add Statutory Rule" onClose={() => setShowForm(false)}>
          <Field label="Rule Type" required>
            <select style={inputStyle} value={form.rule_type} onChange={e => setForm(f => ({ ...f, rule_type: e.target.value }))}>
              <option value="sha">SHA / SHIF</option>
              <option value="nssf">NSSF</option>
              <option value="paye">PAYE</option>
              <option value="ahl">AHL</option>
              <option value="nita">NITA</option>
            </select>
          </Field>
          <Field label="Effective From" required>
            <input type="date" style={inputStyle} value={form.effective_from} onChange={e => setForm(f => ({ ...f, effective_from: e.target.value }))} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Fixed Amount (KES)">
              <input type="number" style={inputStyle} value={form.fixed_amount} placeholder="e.g. 300" onChange={e => setForm(f => ({ ...f, fixed_amount: e.target.value }))} />
            </Field>
            <Field label="Rate (%)">
              <input type="number" style={inputStyle} value={form.rate} placeholder="e.g. 2.75" onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} />
            </Field>
          </div>
          <Field label="Description">
            <input style={inputStyle} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </Field>
          {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
            <Btn onClick={save} loading={saving}>Save Rule</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// REPORTS TAB
// ════════════════════════════════════════════════════════════════
function ReportsTab({ userRole }) {
  const [runs, setRuns]         = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]   = useState(true);

  // Employee report form
  const [empId,      setEmpId]      = useState('');
  const [empSearch,  setEmpSearch]  = useState('');
  const [showSuggs,  setShowSuggs]  = useState(false);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/payroll/runs?limit=20').then(r => r.json()),
      fetch('/api/payroll/employees?active=true&limit=200').then(r => r.json()),
    ]).then(([runsData, empData]) => {
      setRuns(runsData.runs || []);
      setEmployees(empData.employees || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function exportEmpReport() {
    if (!empId) { setExportErr('Select an employee'); return; }
    setExporting(true); setExportErr('');
    try {
      const res = await fetch(`/api/payroll/employees/${empId}/report/pdf?from=${dateFrom}&to=${dateTo}`);
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF failed'); }
      const blob = await res.blob();
      const emp  = employees.find(e => e.id === empId);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `Payroll_Report_${(emp?.name || 'Employee').replace(/\s+/g, '_')}_${dateFrom}_to_${dateTo}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportErr('Export failed: ' + err.message);
    }
    setExporting(false);
  }

  if (loading) return <Spinner />;

  // Aggregate stats from closed/approved runs
  const approvedRuns = runs.filter(r => r.status === 'approved' || r.status === 'closed');
  const totalPaid    = approvedRuns.reduce((s, r) => s + Number(r.total_net || 0), 0);
  const avgNet       = approvedRuns.length ? totalPaid / approvedRuns.length : 0;

  const byType = approvedRuns.reduce((acc, r) => {
    acc[r.run_type] = (acc[r.run_type] || 0) + Number(r.total_net || 0);
    return acc;
  }, {});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── KPI cards ── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {[
          ['Total Approved Runs',   approvedRuns.length],
          ['Net Approved (KES)',    `KES ${fmt(totalPaid)}`],
          ['Avg Net per Run (KES)', `KES ${fmt(avgNet)}`],
        ].map(([label, value]) => (
          <Card key={label} style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 4 }}>{value}</div>
          </Card>
        ))}
      </div>

      {/* ── Employee Payroll Report ── */}
      <Card>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>Employee Payroll Report</h3>
        <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, marginTop: 0 }}>
          Generate a full payroll history for one employee over a date range — includes gross earnings,
          SHA deductions, advance deductions, and net pay per run.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 12, alignItems: 'flex-end' }}>
          <Field label="Employee">
            <div style={{ position: 'relative' }}>
              <input
                style={inputStyle}
                placeholder="Search by name…"
                value={empSearch}
                autoComplete="off"
                onChange={e => { setEmpSearch(e.target.value); setEmpId(''); setShowSuggs(true); }}
                onFocus={() => setShowSuggs(true)}
                onBlur={() => setTimeout(() => setShowSuggs(false), 150)}
              />
              {empId && (
                <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#2E7D32', fontWeight: 700, pointerEvents: 'none' }}>✓</span>
              )}
              {showSuggs && empSearch.length > 0 && (() => {
                const q = empSearch.toLowerCase();
                const hits = employees.filter(e => e.name.toLowerCase().includes(q) || (e.employee_num || '').toLowerCase().includes(q)).slice(0, 8);
                if (!hits.length) return null;
                return (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 50, maxHeight: 220, overflowY: 'auto' }}>
                    {hits.map(e => (
                      <div
                        key={e.id}
                        onMouseDown={() => { setEmpId(e.id); setEmpSearch(`${e.name} (${e.type})`); setShowSuggs(false); }}
                        style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: `1px solid ${BORDER}` }}
                        onMouseEnter={ev => ev.currentTarget.style.background = '#f5f5f5'}
                        onMouseLeave={ev => ev.currentTarget.style.background = 'transparent'}
                      >
                        <strong>{e.name}</strong>
                        <span style={{ marginLeft: 8, fontSize: 11, color: '#9ca3af' }}>{e.employee_num} · {e.type}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </Field>
          <Field label="From">
            <input type="date" style={inputStyle} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" style={inputStyle} value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </Field>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ visibility: 'hidden', fontSize: 11, fontWeight: 700 }}>Action</span>
            <Btn onClick={exportEmpReport} loading={exporting} disabled={!empId}>
              Export PDF
            </Btn>
          </div>
        </div>
        {exportErr && <ErrorBanner message={exportErr} onDismiss={() => setExportErr('')} />}
      </Card>

      {/* ── Run history + type breakdown ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>By Employee Type</h3>
          {Object.entries(byType).length === 0
            ? <EmptyState message="No data yet" />
            : Object.entries(byType).map(([type, total]) => (
                <div key={type} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 14 }}>
                  <StatusBadge status={type} />
                  <strong>KES {fmt(total)}</strong>
                </div>
              ))
          }
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>Recent Run History</h3>
          {runs.slice(0, 8).map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 13 }}>
              <div>
                <strong>{r.run_num}</strong>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtD(r.period_start)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 600 }}>KES {fmt(r.total_net)}</div>
                <StatusBadge status={r.status} />
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// MAIN MODULE SHELL
// ════════════════════════════════════════════════════════════════
export default function PayrollModule() {
  const [activeTab, setActiveTab] = useState('overview');
  const { userRole, loaded }      = useAuth();

  if (!loaded) return <Spinner />;

  if (!userRole || !PAYROLL_ROLES.includes(userRole)) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: C.muted }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🔒</div>
        <div>You don&apos;t have access to the Payroll module.</div>
      </div>
    );
  }

  const TABS = [
    { key: 'overview',   label: 'Overview' },
    { key: 'employees',  label: 'Employees' },
    { key: 'runs',       label: 'Payroll Runs' },
    { key: 'payments',   label: 'Payments' },
    { key: 'compliance', label: 'Compliance' },
    { key: 'reports',    label: 'Reports' },
  ];

  return (
    <div style={{ padding: '20px 16px', color: DARK }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <PageHeader
        title="Payroll"
        description="Employee payroll management"
      />

      <TabBar tabs={TABS} active={activeTab} onSelect={setActiveTab} style={{ marginBottom: 24 }} />

      {activeTab === 'overview'   && <OverviewTab   userRole={userRole} />}
      {activeTab === 'employees'  && <EmployeesTab  userRole={userRole} />}
      {activeTab === 'runs'       && <PayrollRunsTab userRole={userRole} />}
      {activeTab === 'payments'   && <PaymentsTab   userRole={userRole} />}
      {activeTab === 'compliance' && <ComplianceTab userRole={userRole} />}
      {activeTab === 'reports'    && <ReportsTab    userRole={userRole} />}
    </div>
  );
}
