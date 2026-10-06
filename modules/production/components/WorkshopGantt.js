"use client";

/**
 * WorkshopGantt — all active jobs on one timeline, scheduled against PRODUCTION
 * due. Customer delivery is shown separately as its own marker.
 *
 * Reads GET /api/production/schedule (the same persisted rows the job list and
 * job detail use). It only ever writes PLANNED DATES (stage schedule + production
 * due) — never quantities, stage status or progress events.
 *
 * Moving a stage that affects later stages never happens silently: the server
 * answers 409 requires_choice and ImpactDialog asks shift / keep / review.
 * Stage keys are the DB keys (materials, assembly, sanding, finishing,
 * packaging). QC is a gate with no stage row: it is drawn as a read-only gate lane
 * between Finishing and Packaging, showing awaiting / accepted / rework counts.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { C, Btn, Modal, Loading, fmtShortDate } from "@/shared/ui/ds";
import { validateStageDates, todayInNairobi } from "@/shared/lib/production/stageSchedule";

const DAY_MS = 86400000;
const DAY_W = 34;          // px per day column
const LABEL_W = 250;       // px for the left label column
const WINDOW_DAYS = 35;    // five weeks

const toMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => toIso(toMs(iso) + n * DAY_MS);
const isSunday = (iso) => new Date(toMs(iso)).getUTCDay() === 0;
const dayDiff = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
function mondayOf(iso) {
  const dow = new Date(toMs(iso)).getUTCDay();
  return addDays(iso, dow === 0 ? -6 : 1 - dow);
}
const todayIso = () => todayInNairobi();

const STAGE_COLORS = {
  completed:   { bg: C.greenBg,  bd: C.greenBd,  fg: C.green },
  active:      { bg: C.blueBg,   bd: C.blueBd,   fg: C.blue },
  not_started: { bg: C.sunken,  bd: C.line,     fg: C.muted },
  skipped:     { bg: C.sunken,  bd: C.line,     fg: C.faint },
};

// Left label cells stay put while the timeline scrolls horizontally.
const stickyLabel = (bg, extra = {}) => ({
  width: LABEL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 5, background: bg,
  borderRight: `1px solid ${C.line}`, ...extra,
});

const dateInput = {
  padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: C.radiusSm,
  fontSize: 13, fontFamily: "inherit", background: C.card, color: C.ink,
};

function jobSpan(job) {
  const dated = job.stages.filter((s) => s.start && s.end);
  if (dated.length) {
    return {
      start: dated.reduce((m, s) => (s.start < m ? s.start : m), dated[0].start),
      end:   dated.reduce((m, s) => (s.end > m ? s.end : m), dated[0].end),
      jobLevel: false,
    };
  }
  if (job.job_planned_start && job.job_planned_finish) {
    return { start: job.job_planned_start, end: job.job_planned_finish, jobLevel: true };
  }
  return null;
}

// Why a job needs attention comes from the server (shared attention helper):
// explicit reasons with a code, severity and sentence. The UI never re-derives it.
function jobFlags(job) {
  const flags = (job.attention || []).map((a) => ({ tone: a.severity === "critical" ? "red" : "amber", text: a.message, code: a.code }));
  return flags;
}

const tone = (t) => ({
  red:   { background: C.redBg,   color: C.red,   border: `1px solid ${C.redBd}` },
  amber: { background: C.amberBg, color: C.amber, border: `1px solid ${C.amberBd}` },
}[t]);

// QC is a gate, not a stage row. Insert a marker entry before Packaging (or at the end).
function withQcGate(stages) {
  const i = stages.findIndex((s) => s.stage_key === "packaging");
  const gate = { gate: "qc", id: "qc-gate" };
  return i === -1 ? [...stages, gate] : [...stages.slice(0, i), gate, ...stages.slice(i)];
}

function QcGateLane({ job, gridW, gridBg, markers }) {
  const waiting = job.awaiting_qc_qty || 0;
  const rework = job.rework_qty || 0;
  const accepted = job.accepted_qty || 0;
  const qcAttention = (job.attention || []).find((a) => a.code === "qc_waiting" || a.code === "qc_waiting_unknown");
  return (
    <div style={{ display: "flex", alignItems: "stretch", background: C.lane, borderTop: `1px solid ${C.line}` }}>
      <div style={stickyLabel(C.lane, { padding: "6px 12px 6px 28px", fontSize: 12 })}>
        <div style={{ fontWeight: 600, color: C.purple }}>◆ QC gate</div>
        <div style={{ color: C.muted, fontSize: 11 }}>
          {waiting} waiting · {accepted}/{job.planned_quantity} accepted{rework > 0 ? ` · ${rework} rework` : ""}
        </div>
      </div>
      <div style={{ position: "relative", width: gridW, minHeight: 36 }}>
        {gridBg}
        {markers(job)}
        <div style={{ position: "relative", zIndex: 1, padding: "9px 10px", fontSize: 11.5, color: qcAttention || rework > 0 ? C.amber : C.muted }}>
          {qcAttention ? qcAttention.message
            : waiting > 0 ? `${waiting} unit(s) awaiting QC — QC has no scheduled dates`
            : rework > 0 ? `${rework} unit(s) failed QC and are waiting for rework`
            : "Nothing waiting for QC — quality check is a gate, not a scheduled stage"}
        </div>
      </div>
    </div>
  );
}

export default function WorkshopGantt({ canEdit, onAssign }) {
  const [data, setData]       = useState(null);
  const [err, setErr]         = useState(null);
  const [winStart, setWinStart] = useState(() => mondayOf(todayIso()));
  const [open, setOpen]       = useState({});             // job_id -> expanded
  const [editStage, setEditStage] = useState(null);       // { job, stage }
  const [impact, setImpact]   = useState(null);           // { job, stage, start, end, impact }
  const [dueJob, setDueJob]   = useState(null);
  const [raiseJob, setRaiseJob] = useState(null);         // job to raise a blocker on
  const [resolving, setResolving] = useState(null);       // { job, blocker }
  const [reviewJob, setReviewJob] = useState(null);       // job whose dates to review after a resolve
  const [notice, setNotice]   = useState(null);           // [{message}]

  const load = useCallback(async () => {
    setErr(null);
    const r = await fetch("/api/production/schedule");
    if (!r.ok) { setErr(`Failed to load schedule (${r.status})`); return; }
    setData(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const days = useMemo(() => Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(winStart, i)), [winStart]);
  const winEnd = days[days.length - 1];
  const today = todayIso();

  if (!data && !err) return <Loading />;
  if (err) return <div style={{ color: C.red, fontSize: 13 }}>{err} <Btn small onClick={load}>Retry</Btn></div>;

  const jobs = data.jobs || [];
  const conflicts = data.conflicts || [];

  const bar = (start, end) => {
    if (!start || !end || end < winStart || start > winEnd) return null;
    const s = start < winStart ? winStart : start;
    const e = end > winEnd ? winEnd : end;
    return { left: dayDiff(winStart, s) * DAY_W, width: (dayDiff(s, e) + 1) * DAY_W - 2, clippedL: start < winStart, clippedR: end > winEnd };
  };
  const marker = (iso) => (iso && iso >= winStart && iso <= winEnd ? dayDiff(winStart, iso) * DAY_W + DAY_W / 2 : null);

  const gridW = WINDOW_DAYS * DAY_W;
  const gridBg = (
    <div style={{ position: "absolute", inset: 0, display: "flex", pointerEvents: "none" }}>
      {days.map((d) => (
        <div key={d} style={{
          width: DAY_W, flexShrink: 0, borderLeft: `1px solid ${C.line}`,
          background: isSunday(d) ? C.sunken : d === today ? C.coralBg : "transparent",
        }} />
      ))}
    </div>
  );

  const markers = (job) => (
    <>
      {marker(job.production_due_date) != null && (
        <div title={`Production due ${fmtShortDate(job.production_due_date)}`} style={{
          position: "absolute", top: 0, bottom: 0, left: marker(job.production_due_date), width: 2, background: C.coral, zIndex: 2, pointerEvents: "none",
        }} />
      )}
      {marker(job.customer_due_date) != null && (
        <div title={`Customer delivery ${fmtShortDate(job.customer_due_date)}`} style={{
          position: "absolute", top: 0, bottom: 0, left: marker(job.customer_due_date) + 4, width: 0,
          borderLeft: `2px dashed ${C.ink}`, zIndex: 2, pointerEvents: "none",
        }} />
      )}
    </>
  );

  return (
    <div>
      {data.migration_pending && (
        <div style={{ background: C.amberBg, border: `1px solid ${C.amberBd}`, color: C.amber, borderRadius: C.radiusSm, padding: "9px 12px", fontSize: 13, marginBottom: 12 }}>
          Scheduling needs the production v2a and v2b migrations. Until they are applied, only job-level dates can be shown and stages cannot be scheduled.
        </div>
      )}

      {notice && notice.length > 0 && (
        <div style={{ background: C.amberBg, border: `1px solid ${C.amberBd}`, color: C.amber, borderRadius: C.radiusSm, padding: "9px 12px", fontSize: 13, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Saved. Please check:</div>
          {notice.map((w, i) => <div key={i}>• {w.message}</div>)}
          <div style={{ marginTop: 6 }}><Btn small onClick={() => setNotice(null)}>Dismiss</Btn></div>
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <Btn small onClick={() => setWinStart(addDays(winStart, -7))}>◀ Week</Btn>
        <Btn small onClick={() => setWinStart(mondayOf(todayIso()))}>Today</Btn>
        <Btn small onClick={() => setWinStart(addDays(winStart, 7))}>Week ▶</Btn>
        <span style={{ fontSize: 12, color: C.muted, marginLeft: 6 }}>
          {fmtShortDate(winStart)} – {fmtShortDate(winEnd)} · planned dates only; nothing here records progress
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: 12, color: C.muted, alignItems: "center" }}>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: C.coral, verticalAlign: "middle", marginRight: 4 }} />Production due</span>
          <span><span style={{ display: "inline-block", width: 10, borderTop: `2px dashed ${C.ink}`, verticalAlign: "middle", marginRight: 4 }} />Customer delivery</span>
        </span>
      </div>

      {/* Worker conflicts (advisory) */}
      {conflicts.length > 0 && (
        <div style={{ background: C.redBg, border: `1px solid ${C.redBd}`, color: C.red, borderRadius: C.radiusSm, padding: "9px 12px", fontSize: 13, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Worker over capacity (advisory)</div>
          {conflicts.slice(0, 8).map((c, i) => (
            <div key={i}>
              {c.employee_name || "Worker"} · {fmtShortDate(c.date)} · {c.job_nums.join(", ")} · {c.allocated_hours}h allocated of {c.available_hours}h
            </div>
          ))}
          {conflicts.length > 8 && <div>…and {conflicts.length - 8} more day(s)</div>}
        </div>
      )}

      {jobs.length === 0 ? (
        <div style={{ textAlign: "center", padding: "50px 20px", color: C.muted, fontSize: 13 }}>No active production jobs.</div>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: C.radius, background: C.card }}>
          <div style={{ minWidth: LABEL_W + gridW }}>
            {/* Date header */}
            <div style={{ display: "flex", borderBottom: `1px solid ${C.line}`, background: C.bg, position: "sticky", top: 0, zIndex: 3 }}>
              <div style={stickyLabel(C.bg, { padding: "8px 12px", fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", zIndex: 6 })}>Job</div>
              <div style={{ display: "flex", width: gridW }}>
                {days.map((d) => (
                  <div key={d} style={{
                    width: DAY_W, flexShrink: 0, textAlign: "center", padding: "4px 0", fontSize: 10, lineHeight: 1.25,
                    borderLeft: `1px solid ${C.line}`, color: d === today ? C.coral : isSunday(d) ? C.faint : C.muted,
                    fontWeight: d === today ? 700 : 500, background: isSunday(d) ? C.sunken : "transparent",
                  }}>
                    <div>{["S","M","T","W","T","F","S"][new Date(toMs(d)).getUTCDay()]}</div>
                    <div>{+d.slice(8)}</div>
                  </div>
                ))}
              </div>
            </div>

            {jobs.map((job) => {
              const span = jobSpan(job);
              const isOpen = !!open[job.id];
              const flags = jobFlags(job);
              const spanBar = span && bar(span.start, span.end);
              return (
                <div key={job.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                  {/* Job row */}
                  <div style={{ display: "flex", alignItems: "stretch" }}>
                    <div style={stickyLabel(C.card, { padding: "8px 12px", fontSize: 12 })}>
                      <button
                        onClick={() => setOpen((o) => ({ ...o, [job.id]: !o[job.id] }))}
                        aria-expanded={isOpen}
                        style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
                      >
                        <div style={{ fontWeight: 700, color: C.ink }}>{isOpen ? "▾" : "▸"} {job.job_num} <span style={{ fontWeight: 500, color: C.muted }}>· {job.name}</span></div>
                        <div style={{ color: C.muted, marginTop: 1 }}>{job.order_num || "—"}{job.client ? ` · ${job.client}` : ""}</div>
                      </button>
                      <div style={{ marginTop: 3, color: C.muted }}>
                        Prod due: <b style={{ color: C.ink }}>{job.production_due_date ? fmtShortDate(job.production_due_date) : "not set"}</b>
                        {canEdit && <button onClick={() => setDueJob(job)} style={{ all: "unset", cursor: "pointer", color: C.coral, marginLeft: 6, fontWeight: 600 }}>edit</button>}
                      </div>
                      <div style={{ color: C.muted }}>
                        Customer: <b style={{ color: C.ink }}>{job.customer_due_date ? fmtShortDate(job.customer_due_date) : "not set"}</b>
                      </div>
                      {(job.blockers || []).map((b) => (
                        <div key={b.id} style={{ marginTop: 5, padding: "5px 8px", background: C.amberBg, border: `1px solid ${C.amberBd}`, borderRadius: 6, color: C.amber, fontSize: 11.5 }}>
                          <b>Blocked:</b> {b.reason}
                          <div>Owner: {b.owner_name || "none"} · Expected: {b.expected_resolution_date ? fmtShortDate(b.expected_resolution_date) : "no date"}{b.supplier_po_ref ? ` · Ref ${b.supplier_po_ref}` : ""}</div>
                          {canEdit && <button onClick={() => setResolving({ job, blocker: b })} style={{ all: "unset", cursor: "pointer", color: C.coral, fontWeight: 700 }}>Resolve</button>}
                        </div>
                      ))}
                      {canEdit && !data.pending?.blockers && (
                        <button onClick={() => setRaiseJob(job)} style={{ all: "unset", cursor: "pointer", color: C.coral, fontWeight: 600, marginTop: 4, display: "block" }}>+ Raise blocker</button>
                      )}
                      {flags.length > 0 && (
                        <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {flags.filter((f) => f.code !== "blocked").map((f, i) => <span key={i} style={{ ...tone(f.tone), borderRadius: 8, padding: "1px 7px", fontSize: 10.5, fontWeight: 600 }}>{f.text}</span>)}
                        </div>
                      )}
                    </div>
                    <div style={{ position: "relative", width: gridW, minHeight: 44 }}>
                      {gridBg}
                      {markers(job)}
                      {spanBar && (
                        <div title={span.jobLevel ? "Job-level plan (no stage schedule yet)" : "Overall schedule"} style={{
                          position: "absolute", top: 16, height: 12, left: spanBar.left, width: spanBar.width, borderRadius: 6,
                          background: span.jobLevel ? "transparent" : C.sunkenBd,
                          border: span.jobLevel ? `2px dashed ${C.faint}` : "none", zIndex: 1,
                        }} />
                      )}
                    </div>
                  </div>

                  {/* Stage lanes */}
                  {isOpen && withQcGate(job.stages).map((s) => {
                    if (s.gate === "qc") return <QcGateLane key="qc" job={job} gridW={gridW} gridBg={gridBg} markers={markers} />;
                    const b = bar(s.start, s.end);
                    const col = STAGE_COLORS[s.status] || STAGE_COLORS.not_started;
                    const late = s.end && job.production_due_date && s.end > job.production_due_date;
                    const locked = s.status === "completed" || s.status === "skipped";
                    const clickable = canEdit && !locked && !data.pending?.schedules;
                    return (
                      <div key={s.id} style={{ display: "flex", alignItems: "stretch", background: C.lane, borderTop: `1px solid ${C.line}` }}>
                        <div style={stickyLabel(C.lane, { padding: "6px 12px 6px 28px", fontSize: 12 })}>
                          <div style={{ fontWeight: 600, color: C.ink }}>{s.stage_label}</div>
                          <div style={{ color: C.muted, fontSize: 11 }}>
                            {s.status.replace("_", " ")} · {s.completed_quantity}/{s.planned_quantity}
                            {s.workers.length > 0 && ` · ${[...new Set(s.workers)].join(", ")}`}
                          </div>
                        </div>
                        <div style={{ position: "relative", width: gridW, minHeight: 36 }}>
                          {gridBg}
                          {markers(job)}
                          {b ? (
                            <button
                              disabled={!clickable}
                              onClick={() => setEditStage({ job, stage: s })}
                              title={`${s.stage_label}: ${fmtShortDate(s.start)} – ${fmtShortDate(s.end)}${late ? " (after production due)" : ""}`}
                              style={{
                                position: "absolute", top: 7, height: 22, left: b.left, width: b.width, zIndex: 1,
                                background: col.bg, color: col.fg, fontSize: 11, fontWeight: 600, fontFamily: "inherit",
                                border: `${late ? 2 : 1}px solid ${late ? C.red : col.bd}`,
                                borderRadius: 6, cursor: clickable ? "pointer" : "default",
                                borderLeftStyle: b.clippedL ? "dashed" : "solid", borderRightStyle: b.clippedR ? "dashed" : "solid",
                                overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", padding: "0 6px", textAlign: "left",
                              }}
                            >
                              {s.stage_label}
                            </button>
                          ) : (
                            <div style={{ position: "relative", zIndex: 1, padding: "9px 10px", fontSize: 11.5, color: C.muted }}>
                              {s.start && s.end
                                ? "Scheduled outside this view"
                                : clickable
                                  ? <button onClick={() => setEditStage({ job, stage: s })} style={{ all: "unset", cursor: "pointer", color: C.coral, fontWeight: 600 }}>+ Schedule this stage</button>
                                  : "Not scheduled"}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {editStage && (
        <EditStageDialog
          {...editStage}
          canEdit={canEdit}
          onClose={() => setEditStage(null)}
          onAssign={(jobId, stageKey) => { setEditStage(null); onAssign?.(jobId, stageKey); }}
          onNeedChoice={(payload) => { setEditStage(null); setImpact(payload); }}
          onSaved={(warnings) => { setEditStage(null); setNotice(warnings?.length ? warnings : null); load(); }}
        />
      )}
      {impact && (
        <ImpactDialog
          {...impact}
          onClose={() => setImpact(null)}
          onSaved={(warnings) => { setImpact(null); setNotice(warnings?.length ? warnings : null); load(); }}
        />
      )}
      {raiseJob && (
        <RaiseBlockerDialog job={raiseJob} onClose={() => setRaiseJob(null)} onSaved={() => { setRaiseJob(null); load(); }} />
      )}
      {resolving && (
        <ResolveBlockerDialog
          {...resolving}
          onClose={() => setResolving(null)}
          onResolved={(res) => {
            const j = resolving.job; setResolving(null); load();
            if (res.review_dates) setReviewJob(j);
          }}
        />
      )}
      {reviewJob && (
        <Modal title={`${reviewJob.job_num} · Review dates?`} onClose={() => setReviewJob(null)}
          footer={<>
            <Btn onClick={() => setReviewJob(null)}>Keep dates as they are</Btn>
            <Btn primary onClick={() => { setOpen((o) => ({ ...o, [reviewJob.id]: true })); setReviewJob(null); }}>Review stage dates</Btn>
          </>}>
          <div style={{ fontSize: 13 }}>
            The blocker is resolved. Work may have been delayed while it was open — would you like to review this job's stage dates?
            Nothing has been moved.
          </div>
        </Modal>
      )}
      {dueJob && (
        <DueDialog job={dueJob} onClose={() => setDueJob(null)} onSaved={() => { setDueJob(null); load(); }} />
      )}
    </div>
  );
}

// Shared POST helper. Returns { ok, status, body }.
async function postSchedule(jobId, stageId, payload) {
  const r = await fetch(`/api/production/jobs/${jobId}/stages/${stageId}/schedule`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON error body */ }
  return { ok: r.ok, status: r.status, body };
}

function EditStageDialog({ job, stage, canEdit, onClose, onAssign, onNeedChoice, onSaved }) {
  const [start, setStart] = useState(stage.start || job.job_planned_start || todayIso());
  const [end, setEnd]     = useState(stage.end || job.job_planned_finish || todayIso());
  const [saving, setSaving] = useState(false);
  const [err, setErr]     = useState(null);
  const localErr = validateStageDates(start, end);

  const save = async () => {
    setSaving(true); setErr(null);
    const res = await postSchedule(job.id, stage.id, { start, end });
    setSaving(false);
    if (res.status === 409 && res.body?.requires_choice) {
      if (res.body.assignment_impact && !res.body.impact?.needs_choice) {
        // Only worker dates are affected — go straight to the move/keep question.
        return onNeedChoice({ job, stage, start, end, impact: res.body.impact,
          phase2: { payload: { start, end }, proposals: res.body.assignment_impact } });
      }
      return onNeedChoice({ job, stage, start, end, impact: res.body.impact });
    }
    if (!res.ok) return setErr(res.body?.error || `Could not save (${res.status})`);
    onSaved(res.body?.warnings);
  };

  return (
    <Modal
      title={`${job.job_num} · ${stage.stage_label}`}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => onAssign(job.id, stage.stage_key)}>Assign workers</Btn>
          <Btn primary disabled={saving || !!localErr} onClick={save}>{saving ? "Saving…" : "Save dates"}</Btn>
        </>
      }
    >
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: C.muted }}>Start<br /><input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={dateInput} /></label>
        <label style={{ fontSize: 12, color: C.muted }}>End<br /><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={dateInput} /></label>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
        Working days are Monday–Saturday. Saving changes planned dates only — it does not record any progress.
      </div>
      {(localErr || err) && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{localErr || err}</div>}
    </Modal>
  );
}

function AssignmentImpactDialog({ job, stage, payload, proposals, onClose, onSaved }) {
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const confirm = async () => {
    setSaving(true); setErr(null);
    const res = await postSchedule(job.id, stage.id, { ...payload, assignments: choice });
    setSaving(false);
    if (!res.ok) return setErr(res.body?.error || `Could not save (${res.status})`);
    onSaved(res.body?.warnings);
  };
  const opt = (value, title, desc) => (
    <label style={{
      display: "block", border: `1px solid ${choice === value ? C.coral : C.line}`, background: choice === value ? C.coralBg : C.card,
      borderRadius: C.radiusSm, padding: "10px 12px", marginBottom: 8, cursor: "pointer",
    }}>
      <input type="radio" name="asgchoice" checked={choice === value} onChange={() => setChoice(value)} style={{ marginRight: 8 }} />
      <b style={{ fontSize: 13 }}>{title}</b>
      <div style={{ fontSize: 12, color: C.muted, marginLeft: 22 }}>{desc}</div>
    </label>
  );
  return (
    <Modal title="Workers are booked on the old dates" onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Cancel — change nothing</Btn>
        <Btn primary disabled={!choice || saving} onClick={confirm}>{saving ? "Saving…" : "Apply"}</Btn>
      </>}>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        These worker bookings no longer fit the new stage dates. Should their dates move too?
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, maxHeight: 160, overflowY: "auto" }}>
        {proposals.map((p) => (
          <div key={p.assignment_id}>
            {p.employee_name || "Worker"} ({p.stage_key}): {fmtShortDate(p.start)} – {fmtShortDate(p.end)} → {fmtShortDate(p.new_start)} – {fmtShortDate(p.new_end)}
          </div>
        ))}
      </div>
      {opt("move", "Move their dates with the stage", "Booked dates are updated to the proposed dates above.")}
      {opt("keep", "Keep their current dates", "Bookings stay as they are; you will be warned that they no longer match the stage.")}
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}

function ImpactDialog({ job, stage, start, end, impact, phase2: phase2Init, onClose, onSaved }) {
  const [phase2, setPhase2] = useState(phase2Init || null);
  const movable = impact.downstream.filter((d) => !d.locked);
  const locked  = impact.downstream.filter((d) => d.locked);
  const [choice, setChoice] = useState("");           // no default: the user must pick
  const [overrides, setOverrides] = useState(() =>
    Object.fromEntries(movable.map((d) => [d.stage_id, { start: d.shifted_start, end: d.shifted_end }])));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const label = (key) => job.stages.find((s) => s.stage_key === key)?.stage_label || key;
  const dir = impact.delta_working_days;
  const reviewErr = choice === "review"
    ? movable.map((d) => validateStageDates(overrides[d.stage_id].start, overrides[d.stage_id].end)).find(Boolean)
    : null;

  const confirm = async () => {
    setSaving(true); setErr(null);
    const payload = { start, end, downstream: choice };
    if (choice === "review") {
      payload.overrides = movable.map((d) => ({ stage_id: d.stage_id, ...overrides[d.stage_id] }));
    }
    const res = await postSchedule(job.id, stage.id, payload);
    setSaving(false);
    if (res.status === 409 && res.body?.assignment_impact) {
      return setPhase2({ payload, proposals: res.body.assignment_impact });
    }
    if (!res.ok) return setErr(res.body?.error || `Could not save (${res.status})`);
    onSaved(res.body?.warnings);
  };

  const radio = (value, title, desc) => (
    <label style={{
      display: "block", border: `1px solid ${choice === value ? C.coral : C.line}`, background: choice === value ? C.coralBg : C.card,
      borderRadius: C.radiusSm, padding: "10px 12px", marginBottom: 8, cursor: "pointer",
    }}>
      <input type="radio" name="downstream" checked={choice === value} onChange={() => setChoice(value)} style={{ marginRight: 8 }} />
      <b style={{ fontSize: 13 }}>{title}</b>
      <div style={{ fontSize: 12, color: C.muted, marginLeft: 22 }}>{desc}</div>
    </label>
  );

  if (phase2) {
    return <AssignmentImpactDialog job={job} stage={stage} payload={phase2.payload} proposals={phase2.proposals}
      onClose={onClose} onSaved={onSaved} />;
  }

  return (
    <Modal
      title="This change affects later stages"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel — change nothing</Btn>
          <Btn primary disabled={!choice || saving || !!reviewErr} onClick={confirm}>{saving ? "Saving…" : "Apply"}</Btn>
        </>
      }
    >
      <div style={{ fontSize: 13, marginBottom: 10 }}>
        <b>{stage.stage_label}</b> will run {fmtShortDate(start)} – {fmtShortDate(end)}
        {dir !== 0 && <> (its end moves {Math.abs(dir)} working day{Math.abs(dir) === 1 ? "" : "s"} {dir > 0 ? "later" : "earlier"})</>}.
        Choose what happens to the stages after it:
      </div>

      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
        {movable.map((d) => (
          <div key={d.stage_id}>
            {label(d.stage_key)}: {fmtShortDate(d.start)} – {fmtShortDate(d.end)}
            {dir !== 0 && <> → {fmtShortDate(d.shifted_start)} – {fmtShortDate(d.shifted_end)} if shifted</>}
            {d.overlaps && <span style={{ color: C.red }}> · starts before {stage.stage_label} ends</span>}
          </div>
        ))}
        {locked.map((d) => <div key={d.stage_id}>{label(d.stage_key)}: already finished — will not move</div>)}
      </div>

      {radio("shift", "Shift all later stages", `Move each unfinished later stage by the same ${Math.abs(dir)} working day(s), skipping Sundays.`)}
      {radio("keep", "Keep later stages where they are", "Only this stage changes. Any overlap is reported after saving.")}
      {radio("review", "Review each stage", "Set the dates for every later stage yourself.")}

      {choice === "review" && (
        <div style={{ marginTop: 6 }}>
          {movable.map((d) => (
            <div key={d.stage_id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
              <span style={{ width: 110, fontSize: 12 }}>{label(d.stage_key)}</span>
              <input type="date" style={dateInput} value={overrides[d.stage_id].start}
                onChange={(e) => setOverrides((o) => ({ ...o, [d.stage_id]: { ...o[d.stage_id], start: e.target.value } }))} />
              <input type="date" style={dateInput} value={overrides[d.stage_id].end}
                onChange={(e) => setOverrides((o) => ({ ...o, [d.stage_id]: { ...o[d.stage_id], end: e.target.value } }))} />
            </div>
          ))}
        </div>
      )}
      {(reviewErr || err) && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{reviewErr || err}</div>}
    </Modal>
  );
}

function DueDialog({ job, onClose, onSaved }) {
  const [val, setVal] = useState(job.production_due_date || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const after = val && job.customer_due_date && val > job.customer_due_date;

  const save = async () => {
    setSaving(true); setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ production_due_date: val || null }),
    });
    setSaving(false);
    if (!r.ok) {
      let m = null; try { m = (await r.json()).error; } catch { /* ignore */ }
      return setErr(m || `Could not save (${r.status})`);
    }
    onSaved();
  };

  return (
    <Modal title={`${job.job_num} · Production due`} onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Btn></>}>
      <div style={{ fontSize: 13, marginBottom: 10 }}>
        The date production must finish. This is separate from the customer delivery date
        ({job.customer_due_date ? fmtShortDate(job.customer_due_date) : "not set"}), which is not changed here.
        Stage schedules do not move when this changes.
      </div>
      <input type="date" value={val} onChange={(e) => setVal(e.target.value)} style={dateInput} />
      {after && <div style={{ color: C.red, fontSize: 12.5, marginTop: 8 }}>This is after the customer delivery date.</div>}
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}


function RaiseBlockerDialog({ job, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [owner, setOwner]   = useState("");
  const [expected, setExpected] = useState("");
  const [ref, setRef]       = useState("");
  const [notes, setNotes]   = useState("");
  const [stageId, setStageId] = useState("");
  const [workers, setWorkers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState(null);

  useEffect(() => {
    fetch("/api/production/workers").then((r) => (r.ok ? r.json() : null)).then((d) => setWorkers(d?.workers || []));
  }, []);

  const save = async () => {
    setSaving(true); setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/blocker`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason, owner_employee_id: owner || null, expected_resolution_date: expected || null,
        supplier_po_ref: ref || null, notes: notes || null, stage_id: stageId || null,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      let m = null; try { m = (await r.json()).error; } catch { /* ignore */ }
      return setErr(m || `Could not save (${r.status})`);
    }
    onSaved();
  };

  const lab = { fontSize: 12, color: C.muted, display: "block", marginTop: 10 };
  const fld = { ...dateInput, width: "100%", boxSizing: "border-box" };
  return (
    <Modal title={`${job.job_num} · Raise blocker`} onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={saving || !reason.trim()} onClick={save}>{saving ? "Saving…" : "Raise blocker"}</Btn></>}>
      <label style={lab}>Reason (required)<input style={fld} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Waiting for oak boards from supplier" /></label>
      <label style={lab}>Owner — who is responsible for clearing it
        <select style={fld} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">No owner yet</option>
          {workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      <label style={lab}>Expected resolution date<input type="date" style={fld} value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
      <label style={lab}>Stage affected (optional)
        <select style={fld} value={stageId} onChange={(e) => setStageId(e.target.value)}>
          <option value="">Whole job</option>
          {job.stages.map((s) => <option key={s.id} value={s.id}>{s.stage_label}</option>)}
        </select>
      </label>
      <label style={lab}>Supplier / PO reference<input style={fld} value={ref} onChange={(e) => setRef(e.target.value)} /></label>
      <label style={lab}>Notes<textarea style={{ ...fld, minHeight: 56 }} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
        Raising a blocker does not change the job's status, quantities or dates.
      </div>
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}

function ResolveBlockerDialog({ job, blocker, onClose, onResolved }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setSaving(true); setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/blocker/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocker_id: blocker.id, note: note || null }),
    });
    let body = null; try { body = await r.json(); } catch { /* ignore */ }
    setSaving(false);
    if (!r.ok) return setErr(body?.error || `Could not resolve (${r.status})`);
    onResolved(body);
  };
  return (
    <Modal title={`${job.job_num} · Resolve blocker`} onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={saving} onClick={save}>{saving ? "Saving…" : "Mark resolved"}</Btn></>}>
      <div style={{ fontSize: 13, marginBottom: 8 }}><b>{blocker.reason}</b></div>
      <label style={{ fontSize: 12, color: C.muted, display: "block" }}>How was it resolved? (optional)
        <textarea style={{ ...dateInput, width: "100%", boxSizing: "border-box", minHeight: 56 }} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}
