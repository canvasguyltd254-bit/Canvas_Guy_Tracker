"use client";

/**
 * TimeEntries — daily actual labour, by ATTENDANCE (no hours). A manager/admin records the
 * share of the worker's day spent on a job (1 = a full day), and whether the day carried
 * overtime; an admin / another manager approves. Sundays are costed at the flat Sunday
 * rate automatically. Attendance, rates and cost can never be edited:
 * a mistake is voided (admin) and re-entered. Costs are calculated on the server.
 */

import { useState, useEffect, useCallback } from "react";
import { C, Btn, Modal, Loading, fmtShortDate, fmtKes } from "@/shared/ui/ds";
import { todayInNairobi } from "@/shared/lib/production/stageSchedule";
import { isSundayIso } from "@/shared/lib/production/labourCosting";

const STATUS_STYLE = {
  draft:     { background: C.sunken, color: C.muted },
  submitted: { background: C.amberBg, color: C.amber },
  approved:  { background: C.greenBg, color: C.green },
  rejected:  { background: C.redBg, color: C.red },
  voided:    { background: C.sunken, color: C.faint },
};
const inp = { padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: C.radiusSm, fontSize: 13, fontFamily: "inherit", background: C.card, color: C.ink, width: "100%" };

async function api(url, method, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, body: d };
}

export default function TimeEntries({ role }) {
  const isAdmin = role === "admin";
  const [entries, setEntries] = useState(null);
  const [options, setOptions] = useState([]);
  const [err, setErr] = useState(null);
  const [statusF, setStatusF] = useState("submitted,draft");
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState(null);       // { entry, action }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    const [a, b] = await Promise.all([
      api(`/api/production/time-entries?status=${statusF}`, "GET"),
      api("/api/production/time-entries/options", "GET"),
    ]);
    if (!a.ok) { setErr(a.body?.error || `Could not load time entries (${a.status})`); setEntries([]); return; }
    setEntries(a.body.entries || []);
    setOptions(b.ok ? b.body.options || [] : []);
  }, [statusF]);
  useEffect(() => { load(); }, [load]);

  const act = async (entry, action, note) => {
    setBusy(true);
    const r = await api(`/api/production/time-entries/${entry.id}`, "POST", { action, note });
    setBusy(false);
    if (!r.ok) { setErr(r.body?.error || `Failed (${r.status})`); return false; }
    setActing(null); load(); return true;
  };

  if (entries === null) return <Loading />;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <Btn primary onClick={() => setAdding(true)}>+ Record time</Btn>
        <select aria-label="Filter by status" value={statusF} onChange={(e) => setStatusF(e.target.value)} style={{ ...inp, width: "auto" }}>
          <option value="submitted,draft">Awaiting approval</option>
          <option value="approved">Approved</option>
          <option value="rejected,voided">Rejected / voided</option>
          <option value="draft,submitted,approved,rejected,voided">All</option>
        </select>
        <span style={{ fontSize: 12, color: C.muted }}>Attendance is entered for the worker. Approved attendance becomes actual labour cost on the job.</span>
      </div>
      {err && <div style={{ color: C.red, fontSize: 13, marginBottom: 8 }}>{err}</div>}

      {entries.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, fontSize: 13, padding: "30px 10px" }}>No time entries in this view.</div>
      ) : entries.map((e) => (
        <div key={e.id} style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: C.radiusSm, padding: "9px 12px", marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
            <b>{e.employee_name || "Worker"}</b>
            <span style={{ color: C.muted }}>{e.job_num} · {e.stage_label}</span>
            <span style={{ color: C.muted, fontSize: 12 }}>{fmtShortDate(e.work_date)}</span>
            <span style={{ ...STATUS_STYLE[e.status], borderRadius: 8, padding: "1px 8px", fontSize: 11.5, fontWeight: 600 }}>{e.status}</span>
            <span style={{ marginLeft: "auto", fontSize: 13 }}>
              {e.attendance_units} day{Number(e.attendance_units) === 1 ? "" : "s"}{e.is_sunday ? " · Sunday" : e.has_overtime ? " · overtime" : ""}
              {" · "}{e.rate_missing ? <span style={{ color: C.red }}>Rate missing</span> : <b>{fmtKes(e.actual_labour_cost)}</b>}
            </span>
          </div>
          {(e.notes || e.overtime_reason || e.decision_note || e.void_reason) && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
              {e.overtime_reason ? `Overtime: ${e.overtime_reason}. ` : ""}{e.notes || ""}{e.decision_note ? ` Decision: ${e.decision_note}` : ""}{e.void_reason ? ` Voided: ${e.void_reason}` : ""}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {e.status === "draft" && <Btn small disabled={busy} onClick={() => act(e, "submit")}>Submit</Btn>}
            {(e.status === "submitted") && <Btn small primary disabled={busy} onClick={() => act(e, "approve")}>Approve</Btn>}
            {(e.status === "submitted" || e.status === "draft") && <Btn small disabled={busy} onClick={() => setActing({ entry: e, action: "reject" })}>Reject</Btn>}
            {isAdmin && (e.status === "approved" || e.status === "submitted") && <Btn small disabled={busy} onClick={() => setActing({ entry: e, action: "void" })}>Void</Btn>}
          </div>
        </div>
      ))}

      {adding && <RecordDialog options={options} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {acting && <ReasonDialog {...acting} busy={busy} onClose={() => setActing(null)} onConfirm={(note) => act(acting.entry, acting.action, note)} />}
    </div>
  );
}

function ReasonDialog({ entry, action, busy, onClose, onConfirm }) {
  const [note, setNote] = useState("");
  const title = action === "void" ? "Void this time entry" : "Reject this time entry";
  return (
    <Modal title={title} onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy || !note.trim()} onClick={() => onConfirm(note)}>{action === "void" ? "Void entry" : "Reject"}</Btn></>}>
      <div style={{ fontSize: 13, marginBottom: 8 }}>{entry.employee_name} · {entry.job_num} · {fmtShortDate(entry.work_date)} · {entry.attendance_units} day{Number(entry.attendance_units) === 1 ? "" : "s"}{entry.is_sunday ? " · Sunday" : entry.has_overtime ? " · overtime" : ""}</div>
      <label style={{ fontSize: 12, color: C.muted }}>Reason (required)<textarea aria-label="Reason" style={{ ...inp, minHeight: 70 }} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {action === "void" && <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>The entry is kept for audit and no longer counts. Record a new entry to correct it.</div>}
    </Modal>
  );
}

function RecordDialog({ options, onClose, onSaved }) {
  const [asg, setAsg] = useState("");
  const [date, setDate] = useState(todayInNairobi());
  const [units, setUnits] = useState("1");
  const [ot, setOt] = useState(false);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const sunday = isSundayIso(date);
  const u = Number(units);

  const save = async () => {
    setSaving(true); setErr(null);
    const r = await api("/api/production/time-entries", "POST", {
      assignment_id: asg, work_date: date, attendance_units: u, has_overtime: ot && !sunday,
      overtime_reason: reason, notes, submit: true,
    });
    setSaving(false);
    if (!r.ok) return setErr(r.body?.error || `Could not save (${r.status})`);
    onSaved();
  };
  const bad = !asg || !date || !(u > 0) || u > 1 || (ot && !sunday && !reason.trim());

  return (
    <Modal title="Record time" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={saving || bad} onClick={save}>{saving ? "Saving…" : "Save for approval"}</Btn></>}>
      <label style={{ fontSize: 12, color: C.muted }}>Worker · job · stage
        <select aria-label="Assignment" style={inp} value={asg} onChange={(e) => setAsg(e.target.value)}>
          <option value="">Choose…</option>
          {options.map((o) => <option key={o.assignment_id} value={o.assignment_id}>{o.employee_name} — {o.job_num} · {o.stage_label}{o.operation_name ? ` · ${o.operation_name}` : ""}</option>)}
        </select>
      </label>
      {options.length === 0 && <div style={{ fontSize: 12, color: C.amber, marginTop: 6 }}>No active worker assignments. Assign workers to a stage first.</div>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ fontSize: 12, color: C.muted, flex: "1 1 130px" }}>Date<input type="date" max={todayInNairobi()} style={inp} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label style={{ fontSize: 12, color: C.muted, flex: "1 1 140px" }}>Share of the day on this job
          <select aria-label="Attendance" style={inp} value={["1", "0.75", "0.5", "0.25"].includes(units) ? units : "custom"} onChange={(e) => e.target.value !== "custom" && setUnits(e.target.value)}>
            <option value="1">Full day (1.00)</option><option value="0.75">0.75</option><option value="0.5">Half day (0.50)</option><option value="0.25">0.25</option><option value="custom">Other…</option>
          </select>
        </label>
        <label style={{ fontSize: 12, color: C.muted, flex: "1 1 90px" }}>Units<input aria-label="Attendance units" type="number" min={0.01} max={1} step="0.05" style={inp} value={units} onChange={(e) => setUnits(e.target.value)} /></label>
      </div>
      {sunday
        ? <div style={{ fontSize: 12.5, color: C.amber, background: C.amberBg, borderRadius: C.radiusSm, padding: "6px 10px", marginTop: 10 }}>Sunday — costed at the flat Sunday rate instead of the daily rate. No overtime allowance applies.</div>
        : <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}><input aria-label="Overtime" type="checkbox" checked={ot} onChange={(e) => setOt(e.target.checked)} />Overtime worked this day (flat allowance, regardless of duration)</label>}
      {ot && !sunday && <label style={{ fontSize: 12, color: C.muted, display: "block", marginTop: 10 }}>Overtime reason (required)<input aria-label="Overtime reason" style={inp} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      <label style={{ fontSize: 12, color: C.muted, display: "block", marginTop: 10 }}>Notes<input style={inp} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>The rate and cost are applied by the server. A worker's day across all jobs adds up to at most 1.00, with one entry per assignment per day. If a day is split between jobs, the overtime flag must match on each entry — the allowance is shared in proportion.</div>
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
