"use client";

/**
 * modules/production/components/ProductionBoard.js
 *
 * Production module — Phase 1A UI
 * Layout aligned with production-module-phase-1.html mockup.
 *
 * Tabs:
 *   Shop floor        — two-column: kanban lanes + sticky detail aside
 *   Production plans  — sidebar plan list + plan detail with job table
 *   Est. materials    — flat material estimates table across all jobs
 *   People            — 3-column worker cards with assignment detail
 *
 * New plan: 2-step inline wizard (Choose order → Review and create draft)
 *
 * Data:
 *   GET  /api/production/jobs         → shop floor kanban + stats
 *   GET  /api/production/plans        → plans tab list
 *   GET  /api/production/plans/:id    → plan detail (jobs + assignments + materials)
 *   POST /api/production/plans        → create plan
 *   PATCH /api/production/jobs/:id    → status change
 *   PUT  /api/production/jobs/:id/assignments → worker assignments
 */

import { suggestedAttendanceUnits } from "@/shared/lib/production/labourCosting";
import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/shared/context/AuthContext";
import { C, Mono, Btn, Modal, Badge, Loading, fmtShortDate, fmtKes } from "@/shared/ui/ds";
import { conflictsCausedBy } from "@/shared/lib/production/workerLoad";
import WorkshopGantt from "./WorkshopGantt";
import WorkshopControl from "./WorkshopControl";
import TimeEntries from "./TimeEntries";

// ── Design tokens (matching mockup palette) ───────────────────────────────────

const T = {
  border:   `1px solid ${C.line}`,
  borderBold: `1px solid ${C.line}`,
  radius:   C.radiusSm,
  muted:    C.muted,
  bg:       C.bg,
  card:     C.card,
  ink:      C.ink,
};

// ── Constants ─────────────────────────────────────────────────────────────────

const KANBAN_COLUMNS = [
  { key: "ready",             statuses: ["Planned", "Materials Ready"], label: "Ready to start",    dot: C.green  },
  { key: "awaiting-mats",     statuses: ["Awaiting Materials"],         label: "Awaiting materials", dot: C.amber  },
  { key: "in-production",     statuses: ["In Production"],              label: "In production",      dot: C.blue   },
  { key: "quality-control",   statuses: ["Quality Control"],            label: "Quality control",    dot: C.purple },
  { key: "paused",            statuses: ["Paused"],                     label: "Paused",             dot: C.red    },
];

const STATUS_DOT = {
  "Planned":            C.muted,
  "Awaiting Materials": C.amber,
  "Materials Ready":    C.green,
  "In Production":      C.blue,
  "Quality Control":    C.purple,
  "Paused":             C.red,
  "Completed":          C.green,
  "Cancelled":          C.muted,
};

const PLAN_BADGE = {
  "Draft":     "gray",
  "Active":    "blue",
  "Paused":    "amber",
  "Completed": "green",
  "Cancelled": "gray",
};

// Job status → Badge palette key (see BADGE_PALETTE in shared/ui/ds.js).
// Distinct from STATUS_DOT above, which holds raw hex values for dots/borders.
const JOB_STATUS_BADGE = {
  "Planned":            "gray",
  "Awaiting Materials": "amber",
  "Materials Ready":    "green",
  "In Production":      "blue",
  "Quality Control":    "purple",
  "Paused":             "red",
  "Completed":          "green",
  "Cancelled":          "gray",
};

// Colour per aggregate order-level status (left border + dot)
const ORDER_STATUS_COLOR = {
  "In production":  C.coral,
  "Materials hold": C.amber,
  "Awaiting QC":    C.green,
  "Paused":         C.red,
  "Blocked":        C.red,
  "Completed":      C.green,
  "Planned":        C.muted,
  "Unknown":        C.muted,
};

const WIZARD_STEPS = ["Choose order", "Review and create draft"];

// Orders eligible for a production plan: confirmed, deposit received, not yet completed
const PLAN_ELIGIBLE_STATUSES = ["Deposit Paid", "Material Check", "Production", "Quality Control"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function specLine(job) {
  const parts = [job.size, job.finish_color || job.finish_type, job.wood_type].filter(Boolean);
  return parts.length
    ? parts.join(" · ") + ` · Qty ${job.planned_quantity}`
    : `Qty ${job.planned_quantity}`;
}

function initials(name = "") {
  return name.split(" ").map(w => w[0] || "").join("").toUpperCase().slice(0, 2) || "?";
}

function workerNames(assignments = []) {
  const names = [...new Set(assignments.map(a => a.employees?.name).filter(Boolean))];
  if (!names.length) return null;
  if (names.length <= 2) return names.join(" + ");
  return `${names[0]} + ${names.length - 1} more`;
}

function daysLate(plannedFinish) {
  if (!plannedFinish) return null;
  const diff = Math.ceil((new Date() - new Date(plannedFinish + "T12:00:00")) / 86400000);
  return diff > 0 ? diff : null;
}

// ── currentOp — most relevant operation label for a job's quantity buckets ────
function currentOp(job) {
  const total = job.planned_quantity || 0;
  if ((job.awaiting_qc_qty || 0) > 0)
    return { label: "Awaiting QC",  done: job.awaiting_qc_qty,  total };
  if ((job.rework_qty || 0) > 0)
    return { label: "Rework",       done: job.rework_qty,        total };
  if ((job.in_production_qty || 0) > 0) {
    const opName = (job.production_job_assignments || [])[0]?.production_operations?.name
      || "In Production";
    return { label: opName, done: job.in_production_qty, total };
  }
  if ((job.accepted_qty || 0) >= total && total > 0)
    return { label: "Completed", done: total, total };
  return { label: job.status || "Not started", done: 0, total };
}

// ── orderStatusLabel — aggregate order-level status label from its jobs ────────
function orderStatusLabel(jobs) {
  if (!jobs?.length) return "Unknown";
  const ss = jobs.map(j => j.status);
  if (ss.every(s => s === "Completed"))          return "Completed";
  if (jobs.some(j => j.blocker_reason))          return "Blocked";      // any blocker takes priority
  if (ss.some(s => s === "Paused"))              return "Paused";
  if (ss.some(s => s === "Awaiting Materials"))  return "Materials hold";
  if (ss.some(s => s === "Quality Control"))     return "Awaiting QC";
  if (ss.some(s => s === "In Production"))       return "In production";
  return "Planned";
}

// ── Shared input style ────────────────────────────────────────────────────────

const inputStyle = {
  width: "100%", padding: "10px 12px", fontSize: 13, minHeight: 44,
  border: `1.5px solid ${C.line}`, borderRadius: C.radiusSm,
  background: C.card, color: C.ink, fontFamily: "inherit",
};

// ── StageActionModal — for jobs with production_job_stages ───────────────────
// Context-driven: QC decisions surface first (3-button choice row),
// then the recommended next production stage, then rework actions.

const STAGE_ADVANCE_META = {
  materials: { label: "Materials ready",     question: "Are these materials prepared?",               color: C.amber,  needsOp: false },
  assembly:  { label: "Start assembly",      question: "Ready to start assembly?",                    color: C.blue,   needsOp: true  },
  sanding:   { label: "Finished sanding",    question: "Sanding complete on these units?",            color: C.blue,   needsOp: true  },
  finishing: { label: "Finished — send to QC", question: "Painting/finishing done? Submit to QC?",   color: C.purple, needsOp: true  },
  packaging: { label: "Package units",       question: "Ready to package these accepted units?",      color: C.green,  needsOp: false },
};

function stageSubmitLabel(action, n) {
  if (!action || !n) return "Record";
  if (action.apiPath === 'legacy_accept')  return `Accept ${n} unit${n !== 1 ? "s" : ""}`;
  if (action.apiPath === 'rework-receive') return `Send ${n} to rework`;
  if (action.apiPath === 'legacy_scrap')  return `Scrap ${n} unit${n !== 1 ? "s" : ""}`;
  if (action.apiPath === 'rework-complete') return `Resume ${n} unit${n !== 1 ? "s" : ""} after rework`;
  if (action.stageKey === 'materials')    return `Confirm ${n} unit${n !== 1 ? "s" : ""} prepared`;
  if (action.stageKey === 'packaging')    return `Package ${n} unit${n !== 1 ? "s" : ""}`;
  return `Advance ${n} unit${n !== 1 ? "s" : ""}`;
}

export function StageActionModal({ job, onClose, onDone, canQC }) {
  const [operations,          setOperations]          = useState([]);
  const [action,              setAction]              = useState(null);
  const [qty,                 setQty]                 = useState("");
  const [notes,               setNotes]               = useState("");
  const [showNote,            setShowNote]            = useState(false);
  const [operationId,         setOperationId]         = useState("");
  const [reworkTargetStageId, setReworkTargetStageId] = useState("");
  const [scrapPhase,          setScrapPhase]          = useState(false);
  const [saving,              setSaving]              = useState(false);
  const [err,                 setErr]                 = useState(null);

  const stages = (job.production_job_stages || []).filter(s => s.is_enabled);

  useEffect(() => {
    fetch("/api/production/operations")
      .then(r => r.ok ? r.json() : null)
      .then(d => setOperations(d?.operations || []));
  }, []);

  // ── Build action catalogue ─────────────────────────────────────────────────

  // QC decisions (surface first — most urgent)
  const qcActions = [];
  if (job.awaiting_qc_qty > 0 && canQC) {
    qcActions.push({ key: 'accept',      label: 'Passed QC',      color: '#16a34a', apiPath: 'legacy_accept',  stageId: null, stageKey: null, available: job.awaiting_qc_qty, needsOp: false, destructive: false });
    qcActions.push({ key: 'rework_send', label: 'Needs rework',   color: '#d97706', apiPath: 'rework-receive', stageId: null, stageKey: null, available: job.awaiting_qc_qty, needsOp: false, destructive: false });
    qcActions.push({ key: 'scrap',       label: 'Scrap',          color: '#dc2626', apiPath: 'legacy_scrap',   stageId: null, stageKey: null, available: job.awaiting_qc_qty, needsOp: false, destructive: true  });
  }

  // Production stage advancement (one per enabled non-completed stage)
  const productionActions = [];
  const matStage = stages.find(s => s.stage_key === 'materials' && s.status !== 'completed');
  if (matStage) {
    const avail = matStage.planned_quantity - matStage.completed_quantity;
    if (avail > 0) productionActions.push({
      key: 'materials', label: STAGE_ADVANCE_META.materials.label,
      question: STAGE_ADVANCE_META.materials.question,
      color: C.amber, stageId: matStage.id, stageKey: 'materials',
      stageLabel: matStage.stage_label, available: avail,
      needsOp: false, apiPath: 'materials-confirm', destructive: false,
    });
  }
  for (const stage of stages.filter(s => ['assembly','sanding','finishing','packaging'].includes(s.stage_key))) {
    if (stage.status === 'completed') continue;
    const meta = STAGE_ADVANCE_META[stage.stage_key];
    const avail = stage.stage_key === 'packaging'
      ? Math.max(0, job.accepted_qty - stage.completed_quantity)
      : Math.max(0, stage.planned_quantity - stage.completed_quantity);
    if (avail > 0) productionActions.push({
      key: `advance_${stage.stage_key}`, label: meta.label, question: meta.question,
      color: meta.color, stageId: stage.id, stageKey: stage.stage_key,
      stageLabel: stage.stage_label, available: avail,
      needsOp: meta.needsOp, apiPath: 'advance', destructive: false,
    });
  }

  // Rework completion at stages with pending rework
  const reworkActions = [];
  for (const stage of stages) {
    const pending = (stage.rework_received_quantity || 0) - (stage.rework_completed_quantity || 0);
    if (pending > 0) reworkActions.push({
      key: `rework_complete_${stage.stage_key}`,
      label: `Complete rework — ${stage.stage_label}`,
      question: `Rework done on these units at ${stage.stage_label}?`,
      color: C.blue, stageId: stage.id, stageKey: stage.stage_key,
      stageLabel: stage.stage_label, available: pending,
      needsOp: ['assembly','sanding','finishing'].includes(stage.stage_key),
      apiPath: 'rework-complete', destructive: false,
    });
  }

  const allActions = [...qcActions, ...productionActions, ...reworkActions];

  // ── Context: determine the primary "situation" ─────────────────────────────
  // QC pending dominates; otherwise the first ready production action.
  const isQCContext  = qcActions.length > 0;
  const primaryProd  = productionActions[0] || null;
  const hasRework    = reworkActions.length > 0;

  // Derived from selected action
  const opsForStage     = action?.needsOp
    ? operations.filter(op => op.stage_key === action.stageKey && op.is_active !== false)
    : [];
  const reworkTargetStages = stages.filter(s => ['assembly','sanding','finishing'].includes(s.stage_key));
  const parsedQty    = parseInt(qty, 10) || 0;

  const selectAction = (a) => {
    setAction(a);
    setQty(String(a.available));
    setOperationId("");
    setReworkTargetStageId("");
    setErr(null);
    setScrapPhase(false);
  };

  const handleBack = () => {
    if (scrapPhase)       { setScrapPhase(false); return; }
    if (action)           { setAction(null); setQty(""); setErr(null); return; }
    onClose();
  };

  const doSubmit = async () => {
    const n = parsedQty;
    setSaving(true); setErr(null);
    let url, body;
    const base = `/api/production/jobs/${job.id}`;
    if (action.apiPath === 'legacy_accept')  { url = `${base}/progress`; body = { transition: 'accept', quantity: n, notes: notes || undefined }; }
    else if (action.apiPath === 'legacy_scrap')   { url = `${base}/progress`; body = { transition: 'scrap',  quantity: n, notes: notes || undefined }; }
    else if (action.apiPath === 'rework-receive') { url = `${base}/stages/${reworkTargetStageId}/rework-receive`; body = { quantity: n, notes: notes || undefined }; }
    else { url = `${base}/stages/${action.stageId}/${action.apiPath}`; body = { quantity: n, notes: notes || undefined, operation_id: operationId || undefined }; }

    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Failed to record progress"); setSaving(false); setScrapPhase(false); return; }
    if (data.stage) {
      const updatedStages = (job.production_job_stages || []).map(s => s.id === data.stage.id ? data.stage : s);
      onDone({ ...data.job, production_job_stages: updatedStages });
    } else {
      onDone(data.job);
    }
  };

  const handleSubmit = () => {
    const n = parsedQty;
    if (!n || n <= 0) { setErr("Enter a positive quantity"); return; }
    if (n > action.available) { setErr(`Only ${action.available} unit${action.available !== 1 ? "s" : ""} available`); return; }
    if (action.needsOp && !operationId) { setErr("Select an operation"); return; }
    if (action.apiPath === 'rework-receive' && !reworkTargetStageId) { setErr("Select which stage to send rework to"); return; }
    if (action.apiPath === 'legacy_scrap' && !scrapPhase) { setScrapPhase(true); return; }
    doSubmit();
  };

  const backLabel  = scrapPhase ? "← Back" : (action ? "← Back" : "Cancel");
  const noActions  = allActions.length === 0;

  return (
    <Modal
      title={job.job_num}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={handleBack}>{backLabel}</Btn>
          {action && !scrapPhase && (
            <Btn
              primary={!action.destructive}
              onClick={handleSubmit}
              disabled={saving}
              style={action.destructive ? { background: "#dc2626", color: "#fff", border: "none", borderRadius: C.radiusSm, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" } : {}}
            >
              {saving ? "Recording…" : (action.apiPath === 'legacy_scrap' ? "Confirm scrap →" : stageSubmitLabel(action, parsedQty))}
            </Btn>
          )}
          {scrapPhase && (
            <button
              onClick={doSubmit}
              disabled={saving}
              style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: C.radiusSm, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
            >
              {saving ? "Scrapping…" : `Confirm — scrap ${parsedQty} unit${parsedQty !== 1 ? "s" : ""}`}
            </button>
          )}
        </>
      }
    >
      {noActions ? (
        <div style={{ fontSize: 13, color: C.muted }}>No actions available for this job right now.</div>
      ) : scrapPhase ? (
        /* ── Scrap confirmation ── */
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ padding: "14px 16px", background: "#fef2f2", border: "1.5px solid #fca5a5", borderRadius: T.radius }}>
            <div style={{ fontWeight: 700, color: "#dc2626", fontSize: 14, marginBottom: 4 }}>
              Scrapping {parsedQty} unit{parsedQty !== 1 ? "s" : ""} — this cannot be undone
            </div>
            <div style={{ fontSize: 13, color: "#7f1d1d" }}>
              Scrapped units are permanently removed from the production count.
            </div>
          </div>
          {err && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}
        </div>
      ) : !action ? (
        /* ── Action picker ── */
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* QC context — 3-button row */}
          {isQCContext && (
            <div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                Quality check · {job.awaiting_qc_qty} unit{job.awaiting_qc_qty !== 1 ? "s" : ""} waiting
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 12 }}>
                What happened to {job.awaiting_qc_qty === 1 ? "this unit" : `these ${job.awaiting_qc_qty} units`}?
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {qcActions.map(a => (
                  <button key={a.key} onClick={() => selectAction(a)} style={{
                    padding: "14px 10px", cursor: "pointer",
                    border: `2px solid ${C.line}`, borderRadius: T.radius,
                    background: C.card, textAlign: "center",
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: a.color }}>{a.label}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Production actions */}
          {productionActions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {isQCContext && <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 4 }}>Production</div>}
              {productionActions.map(a => (
                <button key={a.key} onClick={() => selectAction(a)} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 14px", cursor: "pointer",
                  border: `1.5px solid ${C.line}`, borderRadius: T.radius,
                  background: C.card, textAlign: "left", width: "100%",
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: a.color }}>{a.label}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{a.stageLabel} · {a.available} unit{a.available !== 1 ? "s" : ""}</div>
                  </div>
                  <span style={{ fontSize: 16, color: C.muted }}>›</span>
                </button>
              ))}
            </div>
          )}

          {/* Rework actions */}
          {hasRework && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Rework</div>
              {reworkActions.map(a => (
                <button key={a.key} onClick={() => selectAction(a)} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 14px", cursor: "pointer",
                  border: `1.5px solid ${C.line}`, borderRadius: T.radius,
                  background: C.card, textAlign: "left", width: "100%",
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: a.color }}>{a.label}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{a.available} unit{a.available !== 1 ? "s" : ""} awaiting rework</div>
                  </div>
                  <span style={{ fontSize: 16, color: C.muted }}>›</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* ── Action form ── */
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Context subtitle */}
          <div style={{ fontSize: 13, color: C.muted }}>{action.stageLabel || "QC decision"}</div>

          {/* Question */}
          <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>
            {action.question || action.label}
          </div>

          {err && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}

          {/* Rework target stage picker */}
          {action.apiPath === 'rework-receive' && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, display: "block", marginBottom: 6 }}>Which stage needs rework? *</label>
              <select value={reworkTargetStageId} onChange={e => setReworkTargetStageId(e.target.value)} style={inputStyle}>
                <option value="">Select stage…</option>
                {reworkTargetStages.map(s => <option key={s.id} value={s.id}>{s.stage_label}</option>)}
              </select>
            </div>
          )}

          {/* Operation picker */}
          {action.needsOp && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, display: "block", marginBottom: 6 }}>
                Operation * <span style={{ fontWeight: 400, color: C.muted }}>({action.stageLabel})</span>
              </label>
              <select value={operationId} onChange={e => setOperationId(e.target.value)} style={inputStyle}>
                <option value="">Select operation…</option>
                {opsForStage.map(op => <option key={op.id} value={op.id}>{op.name}</option>)}
              </select>
            </div>
          )}

          {/* Quantity with "Use all N" shortcut */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 8 }}>How many units?</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="number" min={1} max={action.available} value={qty}
                onChange={e => setQty(e.target.value)} style={{ ...inputStyle, width: 120 }} />
              {action.available > 1 && parsedQty !== action.available && (
                <Btn small onClick={() => setQty(String(action.available))}>
                  Use all {action.available}
                </Btn>
              )}
            </div>
          </div>

          {/* Collapsible note */}
          <div>
            <button
              onClick={() => setShowNote(v => !v)}
              style={{ fontSize: 13, color: C.muted, background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}
            >
              <span style={{ fontSize: 10 }}>{showNote ? "▼" : "▶"}</span> Optional note
            </button>
            {showNote && (
              <input value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Add a note…" style={{ ...inputStyle, marginTop: 8 }} />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── RecordProgressModal ───────────────────────────────────────────────────────
// For jobs WITH stages → delegates to StageActionModal (context-driven, stage-routed).
// For legacy jobs (no stages) → same context-driven UX, routes to /progress.

const BOARD_PROGRESS_CHOICES = {
  accept:       { label: "Passed QC",                color: "#16a34a", destructive: false },
  rework:       { label: "Needs rework",             color: "#d97706", destructive: false },
  scrap:        { label: "Scrap",                    color: "#dc2626", destructive: true  },
  rework_start: { label: "Rework complete — resume", color: C.blue,   destructive: false },
  submit_qc:    { label: "Submit to QC",             color: C.purple, destructive: false },
  start:        { label: "Start production",         color: C.blue,   destructive: false },
};

function legacySubmitLabel(choice, n) {
  if (!choice || !n) return "Record";
  const map = { accept: `Accept ${n}`, rework: `Send ${n} to rework`, scrap: `Scrap ${n}`, rework_start: `Resume ${n}`, submit_qc: `Submit ${n} to QC`, start: `Start ${n}` };
  return map[choice] || "Record";
}

function RecordProgressModal({ job, onClose, onDone, canQC }) {
  // Route stage-enabled jobs to StageActionModal
  const hasStages = (job.production_job_stages || []).some(s => s.is_enabled);
  if (hasStages) {
    return <StageActionModal job={job} onClose={onClose} onDone={onDone} canQC={canQC} />;
  }

  // ── Legacy context-driven modal (no stage tracking) ───────────────────────
  const [choice,     setChoice]     = useState(null);
  const [qty,        setQty]        = useState("");
  const [notes,      setNotes]      = useState("");
  const [showNote,   setShowNote]   = useState(false);
  const [scrapPhase, setScrapPhase] = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [err,        setErr]        = useState(null);

  const notStarted = Math.max(0, job.planned_quantity - job.in_production_qty - job.awaiting_qc_qty - job.rework_qty - job.accepted_qty);
  const pool = { accept: job.awaiting_qc_qty, rework: job.awaiting_qc_qty, scrap: job.awaiting_qc_qty, rework_start: job.rework_qty, submit_qc: job.in_production_qty, start: notStarted };

  // Priority context
  const context = (() => {
    if (pool.accept > 0 && canQC) return { subtitle: `Quality check · ${pool.accept} unit${pool.accept !== 1 ? "s" : ""} waiting`, question: `What happened to ${pool.accept === 1 ? "this unit" : `these ${pool.accept} units`}?`, choices: ["accept", "rework", "scrap"] };
    if (pool.rework_start > 0)   return { subtitle: `Rework · ${pool.rework_start} unit${pool.rework_start !== 1 ? "s" : ""} in rework`, question: `Ready to resume production?`, choices: ["rework_start"] };
    if (pool.submit_qc > 0)      return { subtitle: `In production · ${pool.submit_qc} unit${pool.submit_qc !== 1 ? "s" : ""} in progress`, question: `Finished and ready for QC?`, choices: ["submit_qc"] };
    if (pool.start > 0)          return { subtitle: `${pool.start} unit${pool.start !== 1 ? "s" : ""} not yet started`, question: `Ready to begin production?`, choices: ["start"] };
    return null;
  })();

  // Auto-select single-choice contexts on mount
  useEffect(() => {
    if (context?.choices?.length === 1) { setChoice(context.choices[0]); setQty(String(pool[context.choices[0]] || 1)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const available  = choice ? pool[choice] : 0;
  const parsedQty  = parseInt(qty, 10) || 0;
  const choiceMeta = choice ? BOARD_PROGRESS_CHOICES[choice] : null;

  const selectChoice = (key) => { setChoice(key); setQty(String(pool[key] || 1)); setErr(null); setScrapPhase(false); };
  const handleBack   = () => { if (scrapPhase) { setScrapPhase(false); return; } if (choice && context?.choices?.length > 1) { setChoice(null); setQty(""); setErr(null); return; } onClose(); };

  const handleSubmit = async () => {
    const n = parsedQty;
    if (!n || n <= 0) { setErr("Enter a positive quantity"); return; }
    if (n > available) { setErr(`Only ${available} units available`); return; }
    if (choice === "scrap" && !scrapPhase) { setScrapPhase(true); return; }
    setSaving(true); setErr(null);
    const transition = choice === "rework_start" ? "rework_start" : choice;
    const r = await fetch(`/api/production/jobs/${job.id}/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transition, quantity: n, notes: notes || undefined }) });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Failed to record progress"); setSaving(false); setScrapPhase(false); return; }
    onDone(data.job);
  };

  const backLabel = scrapPhase ? "← Back" : (choice && (context?.choices?.length || 0) > 1 ? "← Back" : "Cancel");

  return (
    <Modal
      title={job.job_num}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={handleBack}>{backLabel}</Btn>
          {choice && !scrapPhase && (
            <Btn primary={!choiceMeta?.destructive} onClick={handleSubmit} disabled={saving || !parsedQty}
              style={choiceMeta?.destructive ? { background: "#dc2626", color: "#fff", border: "none", borderRadius: C.radiusSm, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" } : {}}>
              {saving ? "Recording…" : (choice === "scrap" ? "Confirm scrap →" : legacySubmitLabel(choice, parsedQty))}
            </Btn>
          )}
          {scrapPhase && (
            <button onClick={handleSubmit} disabled={saving} style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: C.radiusSm, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
              {saving ? "Scrapping…" : `Confirm — scrap ${parsedQty} unit${parsedQty !== 1 ? "s" : ""}`}
            </button>
          )}
        </>
      }
    >
      {context && <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, marginTop: -4 }}>{context.subtitle}</div>}

      {!context ? (
        <div style={{ fontSize: 13, color: C.muted }}>No actions available. Job may be complete.</div>
      ) : scrapPhase ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ padding: "14px 16px", background: "#fef2f2", border: "1.5px solid #fca5a5", borderRadius: T.radius }}>
            <div style={{ fontWeight: 700, color: "#dc2626", fontSize: 14, marginBottom: 4 }}>Scrapping {parsedQty} unit{parsedQty !== 1 ? "s" : ""} — this cannot be undone</div>
            <div style={{ fontSize: 13, color: "#7f1d1d" }}>Scrapped units are permanently removed from the production count.</div>
          </div>
          {err && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{context.question}</div>
          {err && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}

          {/* Choice buttons (QC context: 3 across; others: auto-selected) */}
          {context.choices.length > 1 && (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${context.choices.length}, 1fr)`, gap: 8 }}>
              {context.choices.map(key => {
                const m = BOARD_PROGRESS_CHOICES[key];
                return (
                  <button key={key} onClick={() => selectChoice(key)} style={{
                    padding: "14px 10px", cursor: "pointer",
                    border: `2px solid ${choice === key ? m.color : C.line}`,
                    borderRadius: T.radius, background: choice === key ? `${m.color}14` : C.card, textAlign: "center",
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: m.color }}>{m.label}</div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Quantity + "Use all N" */}
          {choice && (
            <>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 8 }}>How many units?</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="number" min={1} max={available} value={qty} onChange={e => setQty(e.target.value)} style={{ ...inputStyle, width: 120 }} />
                  {available > 1 && parsedQty !== available && (
                    <Btn small onClick={() => setQty(String(available))}>Use all {available}</Btn>
                  )}
                </div>
              </div>
              <div>
                <button onClick={() => setShowNote(v => !v)} style={{ fontSize: 13, color: C.muted, background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 10 }}>{showNote ? "▼" : "▶"}</span> Optional note
                </button>
                {showNote && <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Add a note…" style={{ ...inputStyle, marginTop: 8 }} />}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── AssignWorkersModal (stage-level) ──────────────────────────────────────────
// Workflow: choose stage → choose an operation that BELONGS to that stage →
// choose how the team shares the work → pick workers → dates. Operations come
// from the database (production_operations.stage_key); nothing is hard-coded.
// Capacity (8 h/day, Mon–Sat) only ever WARNS; the server enforces the rest.

// Planned attendance for one worker -> API fields. Blank means "not planned" (the saved plan is kept).
function planFields(h = {}) {
  const o = {};
  if (h.days !== "" && h.days != null) o.planned_attendance_units = Number(h.days);
  if (h.otDays !== "" && h.otDays != null) o.planned_overtime_days = Number(h.otDays);
  if (h.sunDays !== "" && h.sunDays != null) o.planned_sunday_units = Number(h.sunDays);
  return o;
}

export function AssignWorkersModal({ job, onClose, onDone, initialStageKey }) {
  const stages = (job.production_job_stages || [])
    .filter(s => s.is_enabled !== false)
    .sort((a, b) => a.sort_order - b.sort_order);

  const [loading,    setLoading]    = useState(true);
  const [operations, setOperations] = useState([]);
  const [workers,    setWorkers]    = useState([]);
  const [allAsg,     setAllAsg]     = useState([]);
  const [pending,    setPending]    = useState(false);
  const [stageId,    setStageId]    = useState(
    (stages.find(s => s.stage_key === initialStageKey) || stages.find(s => s.status !== "completed") || stages[0] || {}).id || ""
  );
  const [opId,   setOpId]   = useState("");
  const [mode,   setMode]   = useState("working_together");
  const [sel,    setSel]    = useState({});          // employee_id -> quantity
  const [q,      setQ]      = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const [start,  setStart]  = useState(job.planned_start || today);
  const [end,    setEnd]    = useState(job.planned_finish || today);
  const [hpd,    setHpd]    = useState(4);
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState(null);
  const [saved,  setSaved]  = useState(null);        // { warnings }
  const [plan,   setPlan]   = useState({});          // employee_id -> { days: "", otDays: "", sunDays: "" }  (planned attendance, strings)
  const [groups, setGroups] = useState([]);          // saved groups with planned hours (GET /assignments)
  const [labour, setLabour] = useState({});          // employee_id -> { rate_status, planned_labour_cost }  (server-calculated)
  const [labourPending, setLabourPending] = useState(false);

  useEffect(() => {
    fetch(`/api/production/jobs/${job.id}/assignments`).then(r => r.ok ? r.json() : null).then(d => setGroups(d?.groups || []));
  }, [job.id]);

  useEffect(() => {
    Promise.all([
      fetch("/api/production/workers").then(r => r.ok ? r.json() : null),
      fetch("/api/production/operations").then(r => r.ok ? r.json() : null),
    ]).then(([w, o]) => {
      setWorkers(w?.workers || []);
      setAllAsg(w?.assignments || []);
      setPending(!!w?.migration_pending);
      setOperations((o?.operations || []).filter(x => x.is_active));
      setLoading(false);
    });
  }, []);

  const stage = stages.find(s => s.id === stageId);
  const planned = job.planned_quantity;
  const ops = operations.filter(o => stage && o.stage_key === stage.stage_key);

  // The (job, stage, operation) group already saved in the database, if any.
  const groupRows = allAsg.filter(a =>
    a.job_id === job.id && a.stage_id === stageId && a.operation_id === opId &&
    (a.status === "Assigned" || a.status === "In Progress"));
  const editing = groupRows.length > 0;

  // Prefill from the persisted group whenever stage / operation changes (or data finishes loading).
  useEffect(() => {
    if (loading) return;
    if (groupRows.length) {
      const first = groupRows[0];
      setMode(first.assignment_mode || "working_together");
      setSel(Object.fromEntries(groupRows.map(a => [a.employee_id, a.assigned_quantity])));
      if (first.planned_start_date) setStart(first.planned_start_date);
      if (first.planned_end_date) setEnd(first.planned_end_date);
      if (first.planned_hours_per_day) setHpd(Number(first.planned_hours_per_day));
      const g = groups.find(x => x.stage_id === stageId && x.operation_id === opId);
      setPlan(Object.fromEntries((g?.workers || []).map(w => [w.employee_id, {
        days:    w.planned_attendance_units != null ? String(w.planned_attendance_units) : "",
        otDays:  w.planned_overtime_days != null ? String(w.planned_overtime_days) : "",
        sunDays: w.planned_sunday_units != null ? String(w.planned_sunday_units) : "",
      }])));
    } else {
      setSel({}); setPlan({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId, opId, loading, groups]);

  // Currently available to this stage = upstream completed − this stage completed
  // (materials start from planned; packaging draws from QC-accepted units).
  const availableNow = (() => {
    if (!stage) return 0;
    if (stage.stage_key === "materials") return Math.max(0, planned - stage.completed_quantity);
    if (stage.stage_key === "packaging") return Math.max(0, (job.accepted_qty || 0) - stage.completed_quantity);
    const idx = stages.findIndex(s => s.id === stage.id);
    const prev = stages.slice(0, idx).reverse().find(s => s.stage_key !== "packaging");
    return Math.max(0, (prev ? prev.completed_quantity : 0) - stage.completed_quantity);
  })();

  const ids = Object.keys(sel);
  const isSunday = (iso) => !!iso && new Date(`${iso}T00:00:00Z`).getUTCDay() === 0;

  // ── validation (mirrors the server; the server remains the authority) ──────
  const errors = [];
  if (!opId) errors.push("Choose an operation.");
  if (!ids.length) errors.push(editing ? "Select at least one worker — or use “Remove whole team”." : "Select at least one worker.");
  if (end < start) errors.push("The end date is before the start date.");
  if (isSunday(start) || isSunday(end)) errors.push("Start and end must be working days (not Sunday).");
  if (mode === "working_together") {
    if (new Set(ids.map(i => sel[i])).size > 1) errors.push("Working together: every worker has the same quantity.");
    ids.forEach(i => { if (!(sel[i] > 0) || sel[i] > planned) errors.push(`Quantity must be between 1 and ${planned}.`); });
  } else {
    const sum = ids.reduce((s, i) => s + (Number(sel[i]) || 0), 0);
    if (ids.some(i => !(sel[i] > 0))) errors.push("Each selected worker needs a quantity above 0.");
    if (sum > planned) errors.push(`Split quantities add up to ${sum} — more than the ${planned} planned.`);
  }
  ids.forEach(i => {
    const h = plan[i] || {};
    if ([h.days, h.otDays, h.sunDays].some(v => v !== "" && v != null && !(Number(v) >= 0))) errors.push("Planned days cannot be negative.");
    if (Number(h.otDays) > Math.ceil(Number(h.days) || 0)) errors.push("Overtime days cannot exceed the attendance days.");
  });
  const uniqueErrors = [...new Set(errors)];

  // Planned labour cost is calculated by the SERVER (same SQL rates the save uses); the browser only displays it.
  const previewKey = JSON.stringify([ids, plan, start, end]);
  useEffect(() => {
    if (!ids.length || end < start) { setLabour({}); return; }
    const t = setTimeout(async () => {
      const r = await fetch("/api/production/labour/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start, end,
          workers: ids.map(i => ({ employee_id: i, ...planFields(plan[i]) })),
        }),
      });
      if (!r.ok) { setLabourPending(r.status === 503); setLabour({}); return; }
      const d = await r.json();
      setLabourPending(false);
      setLabour(Object.fromEntries((d.workers || []).map(w => [w.employee_id, w])));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  const suggested = suggestedAttendanceUnits(start, end);
  const useSuggested = () => setPlan(p => Object.fromEntries(ids.map(i => [i, { days: String(suggested), otDays: p[i]?.otDays ?? "", sunDays: p[i]?.sunDays ?? "" }])));
  const teamCost = ids.reduce((sum, i) => sum + (labour[i]?.planned_labour_cost ?? 0), 0);
  const missingRates = ids.filter(i => labour[i]?.rate_status === "missing").length;
  const anyCost = ids.some(i => labour[i]?.planned_labour_cost != null);

  const proposed = ids.map(i => ({
    employee_id: i, job_id: job.id, job_num: job.job_num, status: "Assigned",
    planned_start_date: start, planned_end_date: end, planned_hours_per_day: Number(hpd),
  }));
  const warnings = [];
  if (ids.length && end >= start) {
    const groupIds = new Set(groupRows.map(a => a.id));
    conflictsCausedBy(allAsg.filter(a => !groupIds.has(a.id)), proposed).forEach(c => {
      const w = workers.find(x => x.id === c.employee_id);
      warnings.push(`${w?.name || "Worker"} would have ${c.allocated_hours} h of ${c.available_hours} h on ${c.date} (${c.job_nums.join(", ")}).`);
    });
  }
  if (stage && availableNow < planned && stage.stage_key !== "materials") {
    warnings.push(`Only ${availableNow} of ${planned} are available to ${stage.stage_label} today. You can still schedule all ${planned} — completion is capped by upstream quantity.`);
  }

  const toggle = (id) => setSel(s => {
    const n = { ...s };
    if (n[id] != null) delete n[id]; else n[id] = mode === "working_together" ? planned : 1;
    return n;
  });
  const switchMode = (m) => {
    setMode(m);
    if (m === "working_together") { const first = Object.values(sel)[0] || planned; setSel(s => Object.fromEntries(Object.keys(s).map(k => [k, first]))); }
  };

  const filtered = workers.filter(w => {
    const t = q.trim().toLowerCase();
    return !t || `${w.name} ${(w.recent_operations || []).join(" ")}`.toLowerCase().includes(t);
  });

  const handleSave = async () => {
    setErr(null);
    if (uniqueErrors.length) return;
    setSaving(true);
    const r = await fetch(`/api/production/jobs/${job.id}/assignments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage_id: stageId, operation_id: opId, assignment_mode: mode,
        workers: ids.map(i => ({
          employee_id: i, assigned_quantity: Number(sel[i]),
          ...planFields(plan[i]),
        })),
        planned_start_date: start, planned_end_date: end, planned_hours_per_day: Number(hpd),
      }),
    });
    const data = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) { setErr(data.error || "Failed to save"); return; }
    if ((data.warnings || []).length) setSaved({ warnings: data.warnings }); else onDone();
  };

  const handleRemoveTeam = async () => {
    if (!window.confirm("Remove the whole team from this operation? Their records are kept as history.")) return;
    setErr(null); setSaving(true);
    const r = await fetch(`/api/production/jobs/${job.id}/assignments`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage_id: stageId, operation_id: opId }),
    });
    const data = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) { setErr(data.error || "Failed to remove"); return; }
    onDone();
  };

  if (saved) {
    return (
      <Modal title="Saved" onClose={onDone} footer={<Btn primary onClick={onDone}>Done</Btn>}>
        <div style={{ fontSize: 13, marginBottom: 8 }}>Saved. These are planned dates only — no production progress was recorded.</div>
        <div style={{ fontSize: 13, color: C.amber, background: C.amberBg, borderRadius: T.radius, padding: "8px 12px" }}>
          Please check:
          <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
            {saved.warnings.map((w, i) => <li key={i}>{w.message || `${w.allocated_hours} h of ${w.available_hours} h on ${w.date} (${(w.job_nums || []).join(", ")})`}</li>)}
          </ul>
        </div>
      </Modal>
    );
  }

  const chip = (on) => ({
    padding: "6px 12px", borderRadius: 8, border: `1.5px solid ${on ? C.coral || "#E8512A" : C.line}`,
    background: on ? "#fff1ec" : "#fff", color: on ? "#E8512A" : C.ink, fontWeight: 600, fontSize: 13, cursor: "pointer",
  });

  return (
    <Modal
      title={`${editing ? "Adjust team" : "Assign workers"} — ${job.job_num}`}
      onClose={onClose}
      footer={
        <>
          {editing && <Btn onClick={handleRemoveTeam} disabled={saving}>Remove whole team</Btn>}
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary onClick={handleSave} disabled={saving || loading || uniqueErrors.length > 0 || pending}>
            {saving ? "Saving…" : editing ? "Save changes" : "Save assignment"}
          </Btn>
        </>
      }
    >
      {loading ? <Loading /> : (
        <div>
          {pending && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius, marginBottom: 12 }}>Stage assignments need migrations production_v2a and production_v2e to be applied first.</div>}
          {err && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius, marginBottom: 12 }}>{err}</div>}

          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", marginBottom: 6 }}>1 · Stage</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            {stages.map(s => (
              <button key={s.id} style={chip(s.id === stageId)} onClick={() => { setStageId(s.id); setOpId(""); }}>{s.stage_label}</button>
            ))}
          </div>
          {stage && (
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
              <Mono>{planned}</Mono> total planned · <b style={{ color: C.ink }}>{stage.stage_key === "materials" ? `${availableNow} still to prepare` : `${availableNow} currently available`}</b>
              <span> · QC is a manager-only gate; workers are never assigned to it.</span>
            </div>
          )}

          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", marginBottom: 6 }}>2 · Operation <span style={{ fontWeight: 400, textTransform: "none" }}>(only this stage’s operations)</span></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {ops.length === 0 && <span style={{ fontSize: 12.5, color: C.muted }}>No operations are configured for this stage.</span>}
            {ops.map(o => <button key={o.id} style={chip(o.id === opId)} onClick={() => setOpId(o.id)}>{o.name}</button>)}
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", marginBottom: 6 }}>3 · How will the team share the work?</div>
          {[["working_together", "Working together on the same quantity", "Every selected worker works on the same assigned quantity."],
            ["split_quantity", "Split the quantity between workers", `Individual quantities add up to no more than ${planned}.`]].map(([m, t, d]) => (
            <div key={m} onClick={() => switchMode(m)} style={{ ...chip(mode === m), display: "block", marginBottom: 6, fontWeight: 400 }}>
              <b>{t}</b><div style={{ fontSize: 12, color: C.muted }}>{d}</div>
            </div>
          ))}

          {editing && <div style={{ fontSize: 12.5, color: C.muted, background: C.bg, borderRadius: T.radius, padding: "6px 10px", marginBottom: 6 }}>
            This operation already has a team. You are editing it: change quantities or dates, switch the mode, add workers, or deselect someone to remove them (their record is kept as history).
          </div>}
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", margin: "12px 0 6px" }}>4 · People</div>
          <input style={{ ...inputStyle, marginBottom: 8 }} placeholder="Search by name or operations they have worked on" value={q} onChange={e => setQ(e.target.value)} />
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {filtered.map(w => {
              const on = sel[w.id] != null;
              const pct = Math.min(100, (w.week_hours / w.week_capacity) * 100);
              return (
                <div key={w.id} style={{ border: `1px solid ${on ? "#E8512A" : C.line}`, background: on ? "#fff1ec" : "#fff", borderRadius: 9, padding: "7px 10px", marginBottom: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 80px", gap: 10, alignItems: "center" }}>
                  <div onClick={() => toggle(w.id)} style={{ cursor: "pointer" }}>
                    <b style={{ fontSize: 13 }}>{w.name}</b>
                    <div style={{ fontSize: 11.5, color: C.muted }}>
                      {(w.recent_operations || []).length ? `Has done: ${w.recent_operations.slice(0, 3).join(", ")}` : "No production history yet"} · {w.week_hours} of {w.week_capacity} h this week
                    </div>
                  </div>
                  <div style={{ height: 6, background: "#eee", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: pct > 100 ? C.red : pct > 80 ? C.amber : C.green }} />
                  </div>
                  {on
                    ? <input type="number" min={1} style={inputStyle} value={sel[w.id]} onChange={e => { const v = parseInt(e.target.value, 10) || 0; setSel(s => mode === "working_together" ? Object.fromEntries(Object.keys(s).map(k => [k, v])) : { ...s, [w.id]: v }); }} />
                    : <Btn small onClick={() => toggle(w.id)}>Add</Btn>}
                </div>
                {on && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 6, fontSize: 12 }}>
                    <label style={{ color: C.muted }}>Attendance days <input aria-label={`Planned attendance days ${w.name}`} type="number" min={0} step="any" style={{ ...inputStyle, width: 76 }} value={plan[w.id]?.days ?? ""} onChange={e => setPlan(p => ({ ...p, [w.id]: { ...p[w.id], days: e.target.value } }))} /></label>
                    <label style={{ color: C.muted }}>Overtime days <input aria-label={`Planned overtime days ${w.name}`} type="number" min={0} step="any" style={{ ...inputStyle, width: 76 }} value={plan[w.id]?.otDays ?? ""} onChange={e => setPlan(p => ({ ...p, [w.id]: { ...p[w.id], otDays: e.target.value } }))} /></label>
                    <label style={{ color: C.muted }}>Sunday days <input aria-label={`Planned Sunday days ${w.name}`} type="number" min={0} step="any" style={{ ...inputStyle, width: 76 }} value={plan[w.id]?.sunDays ?? ""} onChange={e => setPlan(p => ({ ...p, [w.id]: { ...p[w.id], sunDays: e.target.value } }))} /></label>
                    {labour[w.id] && (labour[w.id].rate_status === "missing"
                      ? <span style={{ color: C.red, fontWeight: 600 }}>Rate missing</span>
                      : <span style={{ color: C.green }}>Rate available</span>)}
                    {labour[w.id]?.planned_labour_cost != null && <span style={{ color: C.ink }}>Planned cost <b>KES {labour[w.id].planned_labour_cost.toLocaleString("en-KE")}</b></span>}
                    {labour[w.id] && labour[w.id].rate_status !== "missing" && labour[w.id].planned_labour_cost == null && <span style={{ color: C.muted }}>No days planned</span>}
                  </div>
                )}
                </div>
              );
            })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
            <label style={{ fontSize: 12 }}>Start<input type="date" style={inputStyle} value={start} onChange={e => setStart(e.target.value)} /></label>
            <label style={{ fontSize: 12 }}>End<input type="date" style={inputStyle} value={end} onChange={e => setEnd(e.target.value)} /></label>
            <label style={{ fontSize: 12 }}>Hours / day each<input type="number" min={1} max={12} style={inputStyle} value={hpd} onChange={e => setHpd(e.target.value)} /></label>
          </div>

          {ids.length > 0 && (
            <div style={{ fontSize: 12.5, background: C.bg, borderRadius: T.radius, padding: "8px 12px", marginTop: 10 }}>
              <div>Scheduled duration: <b>{suggested} working day{suggested === 1 ? "" : "s"}</b> → suggested <b>{suggested} attendance day{suggested === 1 ? "" : "s"}</b> each{" "}
                <Btn small onClick={useSuggested}>Use suggested days</Btn>
                <span style={{ color: C.muted }}> — adjust freely. Pay is by attendance: daily rate, plus a flat overtime allowance per overtime day, or the flat Sunday rate on Sundays. There are no overtime hours.</span></div>
              {labourPending && <div style={{ color: C.amber, marginTop: 4 }}>Labour costing needs production_v3a_labour_costing.sql — planned days will not be saved until it is applied.</div>}
              {anyCost && <div style={{ marginTop: 4 }}>Planned labour for this team: <b>KES {teamCost.toLocaleString("en-KE")}</b>{missingRates ? <span style={{ color: C.red }}> + {missingRates} worker{missingRates === 1 ? "" : "s"} with no rate (not costed)</span> : null}</div>}
              {!anyCost && missingRates > 0 && <div style={{ color: C.red, marginTop: 4 }}>{missingRates} worker{missingRates === 1 ? " has" : "s have"} no rate set — payroll must add a daily rate before they can be costed.</div>}
            </div>
          )}

          {uniqueErrors.length > 0 && ids.length + (opId ? 1 : 0) > 0 && (
            <div style={{ fontSize: 12.5, color: C.red, background: C.redBg, borderRadius: T.radius, padding: "8px 12px", marginTop: 10 }}>
              Cannot save yet:<ul style={{ margin: "4px 0 0 18px", padding: 0 }}>{uniqueErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div style={{ fontSize: 12.5, color: C.amber, background: C.amberBg, borderRadius: T.radius, padding: "8px 12px", marginTop: 10 }}>
              Heads up (does not block saving):<ul style={{ margin: "4px 0 0 18px", padding: 0 }}>{warnings.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── StatKpi — top KPI bar ─────────────────────────────────────────────────────

function StatKpi({ label, value, sub, accent }) {
  return (
    <div style={{ background: C.card, border: T.border, borderRadius: T.radius, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <Mono style={{ fontSize: 24, fontWeight: 600, color: accent || C.ink, lineHeight: 1 }}>{value}</Mono>
      </div>
      {sub && <div style={{ marginTop: 5, fontSize: 12, color: C.muted }}>{sub}</div>}
    </div>
  );
}

// ── JobRow — minimal kanban row ───────────────────────────────────────────────

function JobRow({ job, selected, onClick }) {
  const late    = daysLate(job.planned_finish);
  const workers = workerNames(job.production_job_assignments);
  const order   = job.production_plans?.orders;

  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      style={{
        width: "100%", textAlign: "left", display: "block",
        padding: "12px 3px", border: 0,
        borderBottom: T.border,
        background: selected ? "#fff1ed" : "transparent",
        color: "inherit", cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      {/* Ref row */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: C.muted }}>
        <Mono style={{ fontSize: 11 }}>{job.job_num}</Mono>
        {order && <Mono style={{ fontSize: 11 }}>{order.order_num}</Mono>}
      </div>

      {/* Name */}
      <div style={{ margin: "7px 0 3px", fontWeight: 500, fontSize: 14, color: C.ink }}>
        {job.description || job.category || "Untitled job"}
      </div>

      {/* Spec */}
      <div style={{ fontSize: 12, color: C.muted, minHeight: 30 }}>{specLine(job)}</div>

      {/* Meta row */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginTop: 9, fontSize: 12 }}>
        <span style={{ color: job.blocker_reason ? C.amber : C.muted, fontWeight: job.blocker_reason ? 600 : 400 }}>
          {job.blocker_reason ? `⚠ ${job.blocker_reason}` : workers || "Unassigned"}
        </span>
        <Mono style={{ fontSize: 12, color: late ? C.red : C.faint, fontWeight: late ? 700 : 400 }}>
          {late ? `${late}d late` : (job.planned_finish ? fmtShortDate(job.planned_finish) : "")}
        </Mono>
      </div>
    </button>
  );
}

// ── JobDetail — sticky right-side panel ──────────────────────────────────────

function JobDetail({ job, canEdit, canRecord, onStatusChange, onRecordProgress, onAssignWorkers, onOpenJob }) {
  const order = job.production_plans?.orders;
  const dot   = STATUS_DOT[job.status] || C.muted;
  const assignments = job.production_job_assignments || [];
  const pct = job.planned_quantity > 0
    ? Math.round((job.accepted_qty / job.planned_quantity) * 100)
    : 0;

  return (
    <div style={{ background: C.card, border: T.border, borderRadius: T.radius, padding: "18px" }}>
      {/* Status dot + label */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, display: "inline-block", flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: dot, fontWeight: 600 }}>{job.status}</span>
      </div>

      {/* Title */}
      <div style={{ fontSize: 18, fontWeight: 500, color: C.ink, marginBottom: 4 }}>
        {job.description || job.category || "Untitled job"}
      </div>
      <div style={{ fontSize: 12, color: C.muted }}>
        <Mono>{job.job_num}</Mono>
        {order && <> · {order.order_num} · {order.client}</>}
      </div>

      {/* Qty grid 2×2 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "18px 0" }}>
        {[
          { label: "Planned",       value: job.planned_quantity,  color: C.ink   },
          { label: "Accepted",      value: job.accepted_qty,      color: C.green },
          { label: "In production", value: job.in_production_qty, color: C.blue  },
          { label: "Rework",        value: job.rework_qty,        color: job.rework_qty > 0 ? C.amber : C.muted },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ borderBottom: T.border, paddingBottom: 8 }}>
            <span style={{ display: "block", fontSize: 12, color: C.muted }}>{label}</span>
            <Mono style={{ display: "block", marginTop: 4, fontSize: 18, fontWeight: 500, color }}>{value}</Mono>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div style={{ height: 6, background: C.bg, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: C.green, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{pct}% complete</div>

      {/* Item specification */}
      {(job.size || job.finish_type || job.production_instructions) && (
        <div style={{ marginTop: 17 }}>
          <div style={{ fontSize: 13, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8, color: C.ink }}>
            Item specification
          </div>
          <div style={{ fontSize: 13, color: C.muted }}>
            {[job.size, job.finish_color || job.finish_type, job.wood_type].filter(Boolean).join(" · ")}
          </div>
          {job.production_instructions && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6, fontStyle: "italic" }}>
              {job.production_instructions}
            </div>
          )}
        </div>
      )}

      {/* Assigned workers */}
      {assignments.length > 0 && (
        <div style={{ marginTop: 17 }}>
          <div style={{ fontSize: 13, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8, color: C.ink }}>
            Assigned workers
          </div>
          {assignments.map(a => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 0", borderBottom: T.border }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 30, height: 30, borderRadius: "50%", display: "grid", placeItems: "center", background: C.bg, fontSize: 12, flexShrink: 0 }}>
                  {initials(a.employees?.name)}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: C.ink }}>{a.employees?.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{a.production_operations?.name}</div>
                </div>
              </div>
              <Mono style={{ fontSize: 13, color: C.muted }}>{a.assigned_quantity}</Mono>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        {canRecord && job.status !== "Completed" && job.status !== "Cancelled" && (
          <Btn small primary onClick={() => onRecordProgress && onRecordProgress(job)}>Record progress</Btn>
        )}
        {canEdit && (
          <Btn small onClick={() => onAssignWorkers && onAssignWorkers(job)}>Assign workers</Btn>
        )}
        <Btn small onClick={() => onOpenJob && onOpenJob(job)}>Open job ↗</Btn>
      </div>
    </div>
  );
}

// ── ShopFloorTab ──────────────────────────────────────────────────────────────

function ShopFloorTab({ onOpenWizard, canEdit, canRecord }) {
  const router = useRouter();
  const [jobs,        setJobs]        = useState([]);
  const [stats,       setStats]       = useState(null);
  const [loaded,      setLoaded]      = useState(false);
  const [fetchErr,    setFetchErr]    = useState(null);
  const [empFilter,   setEmpFilter]   = useState("");
  const [employees,   setEmployees]   = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [statusChange,  setStatusChange]  = useState(null);
  const [progressJob,   setProgressJob]   = useState(null); // RecordProgressModal
  const [assignJob,     setAssignJob]     = useState(null); // AssignWorkersModal

  const load = useCallback(async () => {
    setFetchErr(null);
    const params = new URLSearchParams({ status: "all_active" });
    if (empFilter) params.set("employee_id", empFilter);
    const r = await fetch(`/api/production/jobs?${params}`);
    if (!r.ok) { setFetchErr("Failed to load jobs"); setLoaded(true); return; }
    const { jobs: j, stats: s } = await r.json();
    setJobs(j || []);
    setStats(s || null);
    setLoaded(true);
    // Build employee filter list
    const empMap = {};
    (j || []).forEach(job =>
      (job.production_job_assignments || []).forEach(a => {
        if (a.employees?.id) empMap[a.employees.id] = a.employees.name;
      })
    );
    setEmployees(Object.entries(empMap).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
  }, [empFilter]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = (job, nextStatus) => {
    if (!nextStatus) return; // "Record progress" is Phase 1B — noop for now
    setStatusChange({ job, nextStatus });
  };

  const jobsFor = (col) => jobs.filter(j => col.statuses.includes(j.status));

  if (!loaded) return <Loading />;

  return (
    <>
      {fetchErr && (
        <div style={{ padding: "10px 14px", background: C.redBg, color: C.red, borderRadius: T.radius, marginBottom: 16, fontSize: 13 }}>
          {fetchErr}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <div>
            <span style={{ display: "block", fontSize: 12, color: C.muted, marginBottom: 5 }}>Worker</span>
            <select
              value={empFilter}
              onChange={e => setEmpFilter(e.target.value)}
              style={{ ...inputStyle, width: "auto", minWidth: 160 }}
            >
              <option value="">All workers</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
        </div>
        {canEdit && (
          <Btn primary small onClick={onOpenWizard}>+ New production plan</Btn>
        )}
      </div>

      {/* KPI cards */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 18 }}>
          <StatKpi
            label="Active jobs"
            value={stats.active_count}
            sub={`${stats.active_orders} orders · ${stats.active_units} units`}
            accent={C.blue}
          />
          <StatKpi
            label="Awaiting materials"
            value={stats.awaiting_materials_count}
            sub={stats.awaiting_materials_blocked > 0 ? `${stats.awaiting_materials_blocked} blocked` : "Waiting on delivery"}
            accent={C.amber}
          />
          <StatKpi
            label="Ready after QC"
            value={stats.accepted_units}
            sub={`${stats.accepted_jobs} jobs complete`}
            accent={C.green}
          />
        </div>
      )}

      {/* Two-column workspace: kanban + detail */}
      <div style={{ display: "grid", gridTemplateColumns: selectedJob ? "minmax(0, 1fr) 320px" : "1fr", gap: 18, alignItems: "start" }}>

        {/* Kanban lanes */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(155px, 1fr))", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
          {KANBAN_COLUMNS.map(col => {
            const colJobs = jobsFor(col);
            const isMulti = col.statuses.length > 1;
            return (
              <div key={col.key} style={{ minWidth: 155 }}>
                {/* Lane header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 2px 9px", borderBottom: `3px solid ${C.line}`, marginBottom: 3 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: col.dot, display: "inline-block" }} />
                    <strong style={{ fontWeight: 500, fontSize: 13, color: C.ink }}>{col.label}</strong>
                  </div>
                  <Mono style={{ fontSize: 13, color: C.muted }}>{colJobs.length}</Mono>
                </div>

                {colJobs.length === 0 ? (
                  <div style={{ padding: "20px 3px", fontSize: 12, color: C.faint, textAlign: "center" }}>
                    No jobs
                  </div>
                ) : colJobs.map(job => (
                  <div key={job.id}>
                    {isMulti && (
                      <div style={{ padding: "4px 2px 1px" }}>
                        <Badge color={job.status === "Materials Ready" ? "green" : "gray"}>
                          {job.status === "Materials Ready" ? "Materials ready" : "Planned"}
                        </Badge>
                      </div>
                    )}
                    <JobRow
                      job={job}
                      selected={selectedJob?.id === job.id}
                      onClick={() => setSelectedJob(prev => prev?.id === job.id ? null : job)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* Detail panel (sticky aside) */}
        {selectedJob && (
          <div style={{ position: "sticky", top: 12 }}>
            <JobDetail
              job={selectedJob}
              canEdit={canEdit}
              canRecord={canRecord}
              onStatusChange={handleStatusChange}
              onRecordProgress={(job) => setProgressJob(job)}
              onAssignWorkers={(job) => setAssignJob(job)}
              onOpenJob={(job) => router.push(`/production/jobs/${job.id}`)}
            />
          </div>
        )}
      </div>

      {/* Empty state */}
      {jobs.length === 0 && !fetchErr && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6, color: C.ink }}>No active production jobs</div>
          <div style={{ fontSize: 13, marginBottom: 20 }}>Create a production plan from an order to get started.</div>
          {canEdit && <Btn primary onClick={onOpenWizard}>+ New production plan</Btn>}
        </div>
      )}

      {/* Status change modal */}
      {statusChange && (
        <StatusChangeModal
          job={statusChange.job}
          nextStatus={statusChange.nextStatus}
          onClose={() => setStatusChange(null)}
          onDone={() => { setStatusChange(null); load(); }}
        />
      )}

      {/* Record progress modal */}
      {progressJob && (
        <RecordProgressModal
          job={progressJob}
          canQC={canEdit}
          onClose={() => setProgressJob(null)}
          onDone={(updatedJob) => {
            setProgressJob(null);
            // Update the job in-place so the detail panel reflects new qty immediately
            setJobs(prev => prev.map(j => j.id === updatedJob.id ? { ...j, ...updatedJob } : j));
            setSelectedJob(prev => prev?.id === updatedJob.id ? { ...prev, ...updatedJob } : prev);
          }}
        />
      )}

      {/* Assign workers modal */}
      {assignJob && (
        <AssignWorkersModal
          job={assignJob}
          onClose={() => setAssignJob(null)}
          onDone={() => { setAssignJob(null); load(); }}
        />
      )}
    </>
  );
}

// ── StatusChangeModal ─────────────────────────────────────────────────────────

function StatusChangeModal({ job, nextStatus, onClose, onDone }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState(null);
  const [reason, setReason] = useState("");
  const needsReason = nextStatus === "Cancelled" || nextStatus === "Paused";

  const handleConfirm = async () => {
    setSaving(true);
    setErr(null);
    const body = { status: nextStatus };
    if (nextStatus === "Cancelled") body.cancelled_reason = reason;
    if (nextStatus === "Paused")    body.blocker_reason   = reason;
    try {
      const r = await fetch(`/api/production/jobs/${job.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || "Failed to update job"); setSaving(false); return; }
      onDone(data.job);
    } catch {
      setErr("Network error"); setSaving(false);
    }
  };

  return (
    <Modal
      title={`Move to ${nextStatus}`}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary onClick={handleConfirm} disabled={saving || (needsReason && !reason.trim())}>
            {saving ? "Saving…" : "Confirm"}
          </Btn>
        </>
      }
    >
      <div style={{ fontSize: 13, color: C.muted }}>
        Moving <Mono style={{ color: C.ink }}>{job.job_num}</Mono> — {job.description || job.category} to <strong>{nextStatus}</strong>.
      </div>
      {err && (
        <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius, marginTop: 10 }}>
          {err}
        </div>
      )}
      {needsReason && (
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, display: "block", marginBottom: 5 }}>
            {nextStatus === "Cancelled" ? "Cancellation reason *" : "Blocker / pause reason *"}
          </label>
          <textarea
            value={reason} onChange={e => setReason(e.target.value)} rows={2}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </div>
      )}
    </Modal>
  );
}

// ── PlansTab ──────────────────────────────────────────────────────────────────

function PlansTab({ onOpenWizard, canEdit, initialPlanId }) {
  const [plans,         setPlans]         = useState([]);
  const [loaded,        setLoaded]        = useState(false);
  // Seeded from ?plan=<id> so the job page's back button lands on the right plan
  const [selectedId,    setSelectedId]    = useState(initialPlanId || null);
  const [detail,        setDetail]        = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [err,           setErr]           = useState(null);
  const [view,          setView]          = useState("active"); // "active" | "archived"

  const loadPlans = useCallback(async (tab) => {
    setLoaded(false);
    setErr(null);
    const url = tab === "archived"
      ? "/api/production/plans?archived=true"
      : "/api/production/plans";
    const r = await fetch(url);
    if (!r.ok) { setErr("Failed to load plans"); setLoaded(true); return; }
    const { plans: p } = await r.json();
    // Filter client-side: active tab excludes Cancelled; archived tab shows Cancelled + archived
    const filtered = tab === "archived"
      ? (p || []).filter(plan => plan.status === "Cancelled" || plan.archived_at)
      : (p || []).filter(plan => plan.status !== "Cancelled");
    setPlans(filtered);
    setLoaded(true);
    if (filtered.length > 0) setSelectedId(prev => prev ?? filtered[0].id);
  }, []);

  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    setDetailLoading(true);
    const r = await fetch(`/api/production/plans/${id}`);
    if (r.ok) { const { plan } = await r.json(); setDetail(plan); }
    setDetailLoading(false);
  }, []);

  useEffect(() => { loadPlans(view); }, [view, loadPlans]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); }, [selectedId, loadDetail]);

  // The board stays mounted between navigations, so a later arrival from the job
  // page (?plan=<other id>) must re-point the selection rather than keep the old one.
  useEffect(() => {
    if (initialPlanId && initialPlanId !== selectedId) setSelectedId(initialPlanId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPlanId]);

  const switchView = (tab) => {
    setView(tab);
    setSelectedId(null);
    setDetail(null);
  };

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: "flex", alignItems: "center", borderBottom: T.border, marginBottom: 16 }}>
        {[
          { key: "active",   label: "Active plans" },
          { key: "archived", label: "Archived" },
        ].map(t => (
          <button key={t.key} onClick={() => switchView(t.key)} style={{
            padding: "6px 14px", fontSize: 13, fontWeight: view === t.key ? 600 : 400,
            color: view === t.key ? C.coral : C.muted,
            background: "transparent", border: 0,
            borderBottom: view === t.key ? `2px solid ${C.coral}` : "2px solid transparent",
            marginBottom: -1, cursor: "pointer",
          }}>{t.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        {canEdit && view === "active" && (
          <Btn small primary onClick={onOpenWizard} style={{ marginBottom: 6 }}>+ New plan</Btn>
        )}
      </div>

      {err && (
        <div style={{ padding: "10px 14px", background: C.redBg, color: C.red, borderRadius: T.radius, marginBottom: 16, fontSize: 13 }}>{err}</div>
      )}

      {!loaded ? <Loading /> : plans.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: C.ink, marginBottom: 6 }}>
            {view === "archived" ? "No archived plans" : "No production plans yet"}
          </div>
          <div style={{ fontSize: 13, marginBottom: 20 }}>
            {view === "archived"
              ? "Cancelled plans will appear here."
              : "Create a plan from an active order to begin tracking production."}
          </div>
          {canEdit && view === "active" && <Btn primary onClick={onOpenWizard}>+ New production plan</Btn>}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: 20, alignItems: "start" }}>
          {/* Plan list sidebar */}
          <div style={{ borderRight: T.border, paddingRight: 16 }}>
            {plans.map(plan => {
              const order  = plan.orders;
              const active = selectedId === plan.id;
              // Count active (non-cancelled) PRODUCT jobs for the subtitle (exclude charges)
              const prodCount = (plan.production_jobs || [])
                .filter(j => !j.cancelled_at && j.order_items?.line_type === 'product')
                .length;
              return (
                <button
                  key={plan.id}
                  onClick={() => setSelectedId(plan.id)}
                  style={{
                    width: "100%", display: "block", textAlign: "left",
                    background: active ? C.bg : "transparent", border: 0,
                    borderBottom: T.border, padding: "10px 8px",
                    cursor: "pointer",
                    borderRadius: active ? `${T.radius} ${T.radius} 0 0` : 0,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: active ? C.coral : C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {order?.client || "—"}
                    </span>
                    <Badge color={PLAN_BADGE[plan.status] || "gray"} style={{ flexShrink: 0 }}>{plan.status}</Badge>
                  </div>
                  <div style={{ fontSize: 11, color: active ? C.coral : C.muted }}>
                    <Mono>{order?.order_num}</Mono>
                    {" · "}{prodCount} product{prodCount !== 1 ? "s" : ""}
                    {" · "}{plan._summary?.pct_complete || 0}% done
                  </div>
                </button>
              );
            })}
          </div>

          {/* Plan detail panel */}
          <div>
            {detailLoading && <Loading />}
            {!detailLoading && detail && (
              <PlanDetail
                plan={detail}
                canEdit={canEdit}
                onRefresh={() => loadDetail(selectedId)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── PlanOrderInfoCard ─────────────────────────────────────────────────────────

function PlanOrderInfoCard({ plan, canEdit, onSaved }) {
  const order = plan.orders;
  const [editing, setEditing] = useState(false);
  const [dDate,   setDDate]   = useState(plan.delivery_date ? plan.delivery_date.slice(0, 10) : "");
  const [notes,   setNotes]   = useState(plan.notes || "");
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState(null);

  const handleSave = async () => {
    setSaving(true); setErr(null);
    const r = await fetch(`/api/production/plans/${plan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delivery_date: dDate || null, notes: notes.trim() || null }),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Failed to save"); setSaving(false); return; }
    setSaving(false); setEditing(false); onSaved?.();
  };

  const cancel = () => {
    setEditing(false);
    setDDate(plan.delivery_date ? plan.delivery_date.slice(0, 10) : "");
    setNotes(plan.notes || "");
    setErr(null);
  };

  return (
    <div style={{ background: C.card, border: T.border, borderRadius: T.radius, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        {/* Read-only order fields + editable plan fields */}
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", flex: 1, fontSize: 13 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>Client</div>
            <div style={{ fontWeight: 600, color: C.ink }}>{order?.client || "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>Order</div>
            <Mono style={{ color: C.muted }}>{order?.order_num || "—"}</Mono>
          </div>
          {order?.total_amount != null && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>Value</div>
              <div style={{ color: C.ink }}>{fmtKes(order.total_amount)}</div>
            </div>
          )}
          {order?.due_date && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>Order due</div>
              <div style={{ color: C.muted }}>{fmtShortDate(order.due_date)}</div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>Delivery date</div>
            {editing ? (
              <input
                type="date"
                value={dDate}
                onChange={e => setDDate(e.target.value)}
                style={{ ...inputStyle, padding: "3px 8px", fontSize: 13, minHeight: 30, width: 160 }}
              />
            ) : (
              <div style={{ color: plan.delivery_date ? C.ink : C.faint }}>
                {plan.delivery_date ? fmtShortDate(plan.delivery_date) : "Not set"}
              </div>
            )}
          </div>
        </div>
        {/* Edit controls */}
        {canEdit && !editing && (
          <Btn small onClick={() => setEditing(true)} style={{ flexShrink: 0 }}>Edit</Btn>
        )}
        {editing && (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <Btn small onClick={cancel}>Cancel</Btn>
            <Btn small primary onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</Btn>
          </div>
        )}
      </div>
      {/* Notes row */}
      {editing && (
        <div style={{ marginTop: 12 }}>
          {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>{err}</div>}
          <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Notes</div>
          <textarea
            rows={2}
            placeholder="Production notes…"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box", minHeight: 56 }}
          />
        </div>
      )}
      {!editing && plan.notes && (
        <div style={{ marginTop: 8, fontSize: 13, color: C.muted, fontStyle: "italic", borderTop: T.border, paddingTop: 8 }}>
          {plan.notes}
        </div>
      )}
    </div>
  );
}

// ── JobBoqTab ─────────────────────────────────────────────────────────────────
// BoQ costing, inline inside the production plan. This is the ONLY surface that
// writes BoQ costs for a single job — the job page shows the same rows read-only.
//
// A line only counts as costed when isLineComplete() passes, which needs a unit
// cost AND a cost source (and a supplier when the source is a supplier, or when
// the line is an outsourced service). All three are editable here; that is the
// whole reason this tab exists.

function JobBoqTab({ job, canEdit, onCostedChange, onRefresh }) {
  const [materials, setMaterials] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [tplId,     setTplId]     = useState("");
  const [applying,  setApplying]  = useState(false);
  const [newLine,   setNewLine]   = useState(null);  // inline add-a-line form
  const [adding,    setAdding]    = useState(false);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState({});   // material id -> bool
  const [costDraft, setCostDraft] = useState({});   // material id -> string
  const [err,       setErr]       = useState(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/production/jobs/${job.id}/materials`).then(r => r.ok ? r.json() : { materials: [] }),
      fetch("/api/suppliers").then(r => r.ok ? r.json() : { data: [] }),
      fetch("/api/production/templates").then(r => r.ok ? r.json() : { templates: [] }),
    ]).then(([mData, sData, tData]) => {
      setMaterials(mData.materials || []);
      setSuppliers(sData.data || []);
      setTemplates(tData.templates || []);
      setLoading(false);
    });
  }, [job.id]);

  // Tell the parent row how many lines are costed so the badge can update
  useEffect(() => {
    if (loading) return;
    onCostedChange?.(materials.filter(isLineComplete).length, materials.length);
  }, [materials, loading, onCostedChange]);

  async function patchMaterial(mid, body) {
    setSaving(s => ({ ...s, [mid]: true }));
    setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/materials/${mid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(s => ({ ...s, [mid]: false }));
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setErr(d.error || "Could not save that change");
      return null;
    }
    const { material: updated } = await r.json();
    // Server may auto-adjust (e.g. in-house line types clear the supplier)
    setMaterials(prev => prev.map(m => m.id === mid ? { ...m, ...updated } : m));
    // This tab keeps its own materials list (fetched independently of the plan),
    // so a save here does not otherwise reach the plan-level job row — without
    // this, the "X of Y costed" badge on the collapsed row goes stale: it still
    // reflects whatever was costed when the plan was first loaded, even though
    // the save above just persisted correctly.
    onRefresh?.();
    return updated;
  }

  const subtotal = materials.reduce((s, m) => s + (m.estimated_total_cost || 0), 0);
  const costedCt = materials.filter(isLineComplete).length;

  // Add a single BoQ line. The template loader covers bulk authoring; this covers
  // the one-off — a line a template does not carry. Only name, unit and quantity
  // per unit are required; cost and source are set afterwards on the row itself.
  async function addLine() {
    if (!newLine?.material_name?.trim()) { setErr("Give the line a name"); return; }
    if (!newLine?.unit?.trim())          { setErr("Give the line a unit");  return; }
    const qpu = parseFloat(newLine.quantity_per_unit);
    if (!(qpu > 0)) { setErr("Quantity per unit must be greater than 0"); return; }

    setAdding(true);
    setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/materials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        material_name:     newLine.material_name.trim(),
        specification:     newLine.specification?.trim() || null,
        unit:              newLine.unit.trim(),
        quantity_per_unit: qpu,
        waste_percentage:  newLine.waste_percentage ? parseFloat(newLine.waste_percentage) : 0,
        boq_line_type:     newLine.boq_line_type || "material",
      }),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Could not add that line"); setAdding(false); return; }

    // Refetch rather than push the POST response: POST does not return the
    // suppliers join, so appending it directly would give the row a different
    // shape from every other row in the table.
    const mr = await fetch(`/api/production/jobs/${job.id}/materials`);
    if (mr.ok) { const { materials: m } = await mr.json(); setMaterials(m || []); }
    setNewLine(null);
    setAdding(false);
    onRefresh?.(); // new line changes the row's "X of Y costed" denominator too
  }

  async function deleteLine(mid) {
    setSaving(s => ({ ...s, [mid]: true }));
    setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/materials/${mid}`, { method: "DELETE" });
    setSaving(s => ({ ...s, [mid]: false }));
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setErr(d.error || "Could not remove that line");
      return;
    }
    setMaterials(prev => prev.filter(m => m.id !== mid));
    onRefresh?.();
  }

  async function applyTemplate() {
    if (!tplId) return;
    setApplying(true);
    setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/materials/apply-template`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: tplId }),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Could not apply that template"); setApplying(false); return; }
    // Refetch so the new lines arrive with their server-assigned defaults
    const mr = await fetch(`/api/production/jobs/${job.id}/materials`);
    if (mr.ok) { const { materials: m } = await mr.json(); setMaterials(m || []); }
    setTplId("");
    setApplying(false);
    onRefresh?.();
  }

  // BoQ authoring — template picker. Lives here because this is the one
  // surface that owns a job's BoQ; the job page shows the same rows read-only.
  const templateBar = canEdit && templates.length > 0 && (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: C.muted, flexShrink: 0 }}>BoQ template:</span>
      <select value={tplId} onChange={e => setTplId(e.target.value)}
        style={{ ...inputStyle, fontSize: 12, minWidth: 180, maxWidth: 260, minHeight: 32 }}>
        <option value="">Choose template…</option>
        {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <Btn small primary onClick={applyTemplate} disabled={!tplId || applying}>
        {applying ? "Applying…" : materials.length ? "Append lines" : "Load BoQ"}
      </Btn>
    </div>
  );

  const blankLine = {
    material_name: "", specification: "", unit: "",
    quantity_per_unit: "", waste_percentage: "", boq_line_type: "material",
  };

  const addLineForm = canEdit && (
    newLine ? (
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: T.border }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>New BoQ line</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1.4fr 90px 80px 70px", gap: 6, marginBottom: 8 }}>
          <input placeholder="Material name *" value={newLine.material_name}
            onChange={e => setNewLine(l => ({ ...l, material_name: e.target.value }))}
            style={{ ...inputStyle, fontSize: 12 }} />
          <select value={newLine.boq_line_type}
            onChange={e => setNewLine(l => ({ ...l, boq_line_type: e.target.value }))}
            style={{ ...inputStyle, fontSize: 12 }}>
            {BOQ_LINE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input placeholder="Unit *" value={newLine.unit}
            onChange={e => setNewLine(l => ({ ...l, unit: e.target.value }))}
            style={{ ...inputStyle, fontSize: 12 }} />
          <input type="number" step="0.01" min="0.01" placeholder="Qty/unit *" value={newLine.quantity_per_unit}
            onChange={e => setNewLine(l => ({ ...l, quantity_per_unit: e.target.value }))}
            style={{ ...inputStyle, fontSize: 12 }} />
          <input type="number" step="0.1" min="0" max="99" placeholder="Waste %" value={newLine.waste_percentage}
            onChange={e => setNewLine(l => ({ ...l, waste_percentage: e.target.value }))}
            style={{ ...inputStyle, fontSize: 12 }} />
        </div>
        <input placeholder="Specification (optional)" value={newLine.specification}
          onChange={e => setNewLine(l => ({ ...l, specification: e.target.value }))}
          style={{ ...inputStyle, fontSize: 12, marginBottom: 8 }} />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Btn small onClick={() => { setNewLine(null); setErr(null); }}>Cancel</Btn>
          <Btn small primary onClick={addLine} disabled={adding}>{adding ? "Adding…" : "Add line"}</Btn>
          <span style={{ fontSize: 11, color: C.muted }}>Set the cost and source on the row once it is added.</span>
        </div>
      </div>
    ) : (
      <Btn small onClick={() => { setNewLine(blankLine); setErr(null); }}>+ Add line</Btn>
    )
  );

  // Floor roles: quantities and spec only. The API sends no cost data to them; this keeps the screen honest too.
  if (!canEdit) {
    if (loading) return <Loading />;
    return materials.length === 0
      ? <div style={{ fontSize: 13, color: C.muted, padding: "8px 0" }}>No materials listed for this job yet.</div>
      : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ borderBottom: T.border }}>{["Material", "Type", "Quantity"].map((h) => <th key={h} style={{ textAlign: "left", padding: "4px 10px 6px 0", fontSize: 11, color: C.muted, fontWeight: 600 }}>{h}</th>)}</tr></thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id} style={{ borderBottom: `1px solid ${C.bg}` }}>
                  <td style={{ padding: "7px 10px 7px 0" }}><div style={{ fontWeight: 500 }}>{m.material_name}</div>{m.specification && <div style={{ fontSize: 11, color: C.muted }}>{m.specification}</div>}</td>
                  <td style={{ padding: "7px 10px 7px 0", color: C.muted }}>{BOQ_LINE_TYPE_LABELS[m.boq_line_type] || "Material"}</td>
                  <td style={{ padding: "7px 10px 7px 0", whiteSpace: "nowrap" }}><Mono>{m.estimated_quantity ?? m.planned_quantity ?? "—"}</Mono>{m.unit && <span style={{ color: C.faint, fontSize: 11 }}> {m.unit}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }

  if (loading) return <Loading />;

  if (materials.length === 0) {
    return (
      <div style={{ padding: "8px 0" }}>
        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, padding: "6px 10px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}
        {templateBar}
        <div style={{ fontSize: 13, color: C.muted, padding: "4px 0 10px" }}>
          No BoQ lines on this job yet — load a template, or add lines one at a time.
        </div>
        {addLineForm}
      </div>
    );
  }

  return (
    <div>
      {err && (
        <div style={{ fontSize: 12, color: C.red, marginBottom: 10, padding: "6px 10px", background: C.redBg, borderRadius: T.radius }}>{err}</div>
      )}
      {templateBar}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: T.border }}>
              {["Line", "Type", "Qty", "Unit cost", "Cost source", "Total", "", ""].map((h, i) => (
                <th key={i} style={{ textAlign: h === "Total" ? "right" : "left", padding: "4px 10px 6px 0", fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {materials.map(m => {
              const complete = isLineComplete(m);
              const inHouse  = INHOUSE_BOQ_TYPES.has(m.boq_line_type);
              const draft    = costDraft[m.id];
              return (
                <tr key={m.id} style={{ borderBottom: `1px solid ${C.bg}` }}>
                  <td style={{ padding: "7px 10px 7px 0", minWidth: 140 }}>
                    <div style={{ fontWeight: 500, color: C.ink }}>{m.material_name}</div>
                    {m.specification && <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{m.specification}</div>}
                  </td>

                  {/* boq_line_type — saves immediately */}
                  <td style={{ padding: "7px 10px 7px 0" }}>
                    {canEdit ? (
                      <select
                        value={m.boq_line_type || "material"}
                        disabled={saving[m.id]}
                        onChange={e => patchMaterial(m.id, { boq_line_type: e.target.value })}
                        style={{ ...inputStyle, fontSize: 11, minHeight: 30, padding: "3px 6px" }}
                      >
                        {BOQ_LINE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <span style={{ color: C.muted }}>{BOQ_LINE_TYPE_LABELS[m.boq_line_type] || "Material"}</span>
                    )}
                  </td>

                  <td style={{ padding: "7px 10px 7px 0", whiteSpace: "nowrap" }}>
                    <Mono>{m.estimated_quantity ?? m.planned_quantity ?? "—"}</Mono>
                    {m.unit && <span style={{ color: C.faint, fontSize: 10 }}> {m.unit}</span>}
                  </td>

                  {/* unit cost — saves on blur */}
                  <td style={{ padding: "7px 10px 7px 0" }}>
                    {canEdit ? (
                      <input
                        type="number" step="0.01" min="0"
                        aria-label={`Unit cost for ${m.material_name}`}
                        value={draft !== undefined ? draft : (m.estimated_unit_cost ?? "")}
                        disabled={saving[m.id]}
                        onChange={e => setCostDraft(d => ({ ...d, [m.id]: e.target.value }))}
                        onBlur={async () => {
                          if (draft === undefined) return;
                          const v = draft === "" ? null : parseFloat(draft);
                          setCostDraft(d => { const n = { ...d }; delete n[m.id]; return n; });
                          if (v !== null && isNaN(v)) return;
                          if (v === (m.estimated_unit_cost ?? null)) return;
                          await patchMaterial(m.id, { estimated_unit_cost: v });
                        }}
                        style={{ ...inputStyle, fontSize: 12, minHeight: 30, padding: "3px 6px", width: 82 }}
                        placeholder="0.00"
                      />
                    ) : (
                      <Mono>{m.estimated_unit_cost != null ? fmtKes(m.estimated_unit_cost) : "—"}</Mono>
                    )}
                  </td>

                  {/* cost source — the field that was missing everywhere but Materials */}
                  <td style={{ padding: "7px 10px 7px 0" }}>
                    {canEdit ? (
                      <CostSourceCombobox
                        value={m.cost_source_type}
                        supplierId={m.preferred_supplier_id}
                        suppliers={suppliers}
                        disabled={saving[m.id] || inHouse}
                        onChange={({ costSourceType, supplierId }) =>
                          patchMaterial(m.id, {
                            cost_source_type: costSourceType,
                            preferred_supplier_id: costSourceType === "supplier" ? supplierId : null,
                          })
                        }
                      />
                    ) : (
                      <span style={{ color: C.muted }}>{m.suppliers?.name || m.cost_source_type || "—"}</span>
                    )}
                  </td>

                  <td style={{ padding: "7px 0", textAlign: "right", whiteSpace: "nowrap" }}>
                    <Mono style={{ color: complete ? C.ink : C.faint }}>
                      {m.estimated_total_cost != null ? fmtKes(m.estimated_total_cost) : "—"}
                    </Mono>
                  </td>

                  <td style={{ padding: "7px 0 7px 8px", width: 20, textAlign: "center" }}>
                    {complete
                      ? <span title="Estimate complete" style={{ color: C.green }}>✓</span>
                      : <span title="Needs a unit cost and a cost source" style={{ color: C.amber }}>•</span>}
                  </td>

                  <td style={{ padding: "7px 0 7px 4px", width: 22, textAlign: "right" }}>
                    {canEdit && (
                      <button
                        onClick={() => deleteLine(m.id)}
                        disabled={saving[m.id]}
                        title={`Remove ${m.material_name} from this BoQ`}
                        aria-label={`Remove ${m.material_name}`}
                        style={{ background: "none", border: 0, cursor: "pointer", color: C.red, fontSize: 13, padding: "2px 4px", opacity: saving[m.id] ? 0.4 : 1 }}
                      >✕</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 10, borderTop: T.border, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: costedCt === materials.length ? C.green : C.amber }}>
          {costedCt} of {materials.length} line{materials.length !== 1 ? "s" : ""} costed
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: C.muted }}>
          Subtotal <Mono style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{fmtKes(subtotal)}</Mono>
        </span>
      </div>

      {addLineForm}
    </div>
  );
}

// ── JobPanel ──────────────────────────────────────────────────────────────────
// The expanded job row inside a plan. Everything you need to prepare a job
// lives here as tabs, so costing never throws you out of the plan.

function JobPanel({ job, canEdit, onClose, onRefresh, onAssignWorkers }) {
  // Open on whichever step is still outstanding for this job
  const hasBoq        = (job.production_material_estimates?.length || 0) > 0;
  const boqCosted     = hasBoq && (job.production_material_estimates || []).every(isLineComplete);
  const hasAssignment = (job.production_job_assignments?.length || 0) > 0;
  const defaultTab    = !boqCosted ? "boq" : (!hasAssignment ? "workers" : "cutlist");

  const [tab, setTab] = useState(defaultTab);
  const [costed, setCosted] = useState(null); // live [costed, total] from the BoQ tab
  // Hoisted: hooks must not be called inside the conditional tab render below
  const handleCostedChange = useCallback((c, n) => setCosted([c, n]), []);

  const spec = [job.size, job.finish_color || job.finish_type, job.wood_type].filter(Boolean).join(" · ");

  const TABS = [
    { key: "boq",     label: "BoQ and costing" },
    { key: "cutlist", label: "Cut list" },
    { key: "workers", label: "Workers" },
  ];

  return (
    <tr>
      <td colSpan={6} style={{ padding: 0, borderBottom: T.border }}>
        <div style={{ background: C.bg, borderTop: `2px solid ${C.coral}`, padding: "14px 18px" }}>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: C.ink }}>
                {job.description || job.category || "Job"}{" "}
                <Mono style={{ fontSize: 11, color: C.faint }}>{job.job_num}</Mono>
              </div>
              {spec && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{spec}</div>}
            </div>
            <button onClick={onClose} style={{ background: "none", border: 0, cursor: "pointer", color: C.muted, fontSize: 20, lineHeight: 1, padding: "0 4px" }} aria-label="Close panel">×</button>
          </div>

          {/* Tab bar */}
          <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
            {TABS.map(t => {
              const active = tab === t.key;
              let hint = null;
              if (t.key === "boq") {
                const [c, n] = costed || [
                  (job.production_material_estimates || []).filter(isLineComplete).length,
                  job.production_material_estimates?.length || 0,
                ];
                hint = n === 0 ? "none" : `${c}/${n}`;
              }
              if (t.key === "workers") hint = hasAssignment ? null : "none";
              return (
                <button key={t.key} onClick={() => setTab(t.key)} style={{
                  fontSize: 12, fontWeight: active ? 600 : 400,
                  padding: "5px 12px", cursor: "pointer", fontFamily: "inherit",
                  background: active ? C.card : "transparent",
                  color: active ? C.ink : C.muted,
                  border: `1px solid ${active ? C.line : "transparent"}`,
                  borderRadius: T.radius,
                }}>
                  {t.label}
                  {hint && <span style={{ marginLeft: 6, fontSize: 10, color: C.amber }}>{hint}</span>}
                </button>
              );
            })}
          </div>

          {tab === "boq" && (
            <JobBoqTab job={job} canEdit={canEdit} onCostedChange={handleCostedChange} onRefresh={onRefresh} />
          )}
          {tab === "cutlist" && <JobCutListTab job={job} canEdit={canEdit} />}
          {tab === "workers" && (
            <div style={{ padding: "8px 0" }}>
              {hasAssignment ? (
                <div style={{ fontSize: 13, color: C.ink, marginBottom: 12 }}>
                  Assigned: <strong>{workerNames(job.production_job_assignments || [])}</strong>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>No workers assigned to this job yet.</div>
              )}
              {canEdit && (
                <Btn small primary onClick={() => onAssignWorkers?.(job)}>
                  {hasAssignment ? "Change assignment" : "Assign workers"}
                </Btn>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── JobCutListTab ─────────────────────────────────────────────────────────────

function JobCutListTab({ job, canEdit }) {
  const [items,     setItems]     = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [adding,    setAdding]    = useState(false);
  const [err,       setErr]       = useState(null);
  const [newRow,    setNewRow]    = useState(null);
  const [applyTpl,  setApplyTpl]  = useState("");
  const [applying,  setApplying]  = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/production/jobs/${job.id}/cut-list`).then(r => r.ok ? r.json() : { items: [] }),
      fetch("/api/production/cut-list-templates").then(r => r.ok ? r.json() : { templates: [] }),
    ]).then(([clData, tplData]) => {
      setItems(clData.items || []);
      setTemplates(tplData.templates || []);
      setLoading(false);
    });
  }, [job.id]);

  const handleApplyTemplate = async () => {
    if (!applyTpl) return;
    setApplying(true); setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/cut-list/apply-template`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: applyTpl }),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Failed to apply template"); setApplying(false); return; }
    setItems(data.items || []); setApplyTpl(""); setApplying(false);
  };

  const handleAddRow = async () => {
    if (!newRow?.piece_name?.trim()) return;
    setAdding(true); setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/cut-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newRow),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Failed to add item"); setAdding(false); return; }
    setItems(prev => [...prev, data.item]); setNewRow(null); setAdding(false);
  };

  const handleDelete = async (cid) => {
    const r = await fetch(`/api/production/jobs/${job.id}/cut-list/${cid}`, { method: "DELETE" });
    if (r.ok) setItems(prev => prev.filter(it => it.id !== cid));
  };

  return (
    <div>
          {loading ? <Loading /> : (
            <>
              {err && <div style={{ fontSize: 13, color: C.red, marginBottom: 10, padding: "6px 10px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}

              {/* Template bar */}
              {canEdit && templates.length > 0 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: C.muted, flexShrink: 0 }}>Apply template:</span>
                  <select value={applyTpl} onChange={e => setApplyTpl(e.target.value)}
                    style={{ ...inputStyle, flex: 1, minWidth: 180, fontSize: 12, maxWidth: 260 }}>
                    <option value="">Choose template…</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <Btn small primary onClick={handleApplyTemplate} disabled={!applyTpl || applying}>
                    {applying ? "Applying…" : "Apply & append"}
                  </Btn>
                </div>
              )}

              {/* Cut list table */}
              {items.length === 0 ? (
                <div style={{ fontSize: 13, color: C.muted, padding: "10px 0 14px" }}>No pieces yet.</div>
              ) : (
                <div style={{ overflowX: "auto", marginBottom: 12 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: T.border }}>
                        {["Piece name", "W cm", "H cm", "Thick mm", "Qty", "Material", ""].map(h => (
                          <th key={h} style={{ textAlign: "left", padding: "4px 10px 6px 0", fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(it => (
                        <tr key={it.id} style={{ borderBottom: `1px solid ${C.bg}` }}>
                          <td style={{ padding: "5px 10px 5px 0", fontWeight: 500 }}>{it.piece_name}</td>
                          <td style={{ padding: "5px 10px 5px 0" }}><Mono>{it.width_cm ?? "—"}</Mono></td>
                          <td style={{ padding: "5px 10px 5px 0" }}><Mono>{it.height_cm ?? "—"}</Mono></td>
                          <td style={{ padding: "5px 10px 5px 0" }}><Mono>{it.thickness_mm ?? "—"}</Mono></td>
                          <td style={{ padding: "5px 10px 5px 0" }}><Mono>{it.quantity}</Mono></td>
                          <td style={{ padding: "5px 10px 5px 0", color: C.muted }}>{it.material_description || "—"}</td>
                          <td style={{ padding: "5px 0", textAlign: "right" }}>
                            {canEdit && (
                              <button onClick={() => handleDelete(it.id)}
                                style={{ background: "none", border: 0, cursor: "pointer", color: C.red, fontSize: 14, padding: "2px 6px" }}>✕</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Add piece form */}
              {canEdit && !newRow && (
                <Btn small onClick={() => setNewRow({ piece_name: "", width_cm: "", height_cm: "", thickness_mm: "", quantity: 1, material_description: "" })}>
                  + Add piece
                </Btn>
              )}
              {canEdit && newRow && (
                <div style={{ marginTop: 10, borderTop: T.border, paddingTop: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>New piece</div>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 80px 80px 80px 60px 1fr", gap: 6, marginBottom: 8 }}>
                    <input placeholder="Piece name *" value={newRow.piece_name}
                      onChange={e => setNewRow(r => ({ ...r, piece_name: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 12 }} />
                    <input type="number" placeholder="W cm" value={newRow.width_cm}
                      onChange={e => setNewRow(r => ({ ...r, width_cm: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 12 }} />
                    <input type="number" placeholder="H cm" value={newRow.height_cm}
                      onChange={e => setNewRow(r => ({ ...r, height_cm: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 12 }} />
                    <input type="number" placeholder="Thick mm" value={newRow.thickness_mm}
                      onChange={e => setNewRow(r => ({ ...r, thickness_mm: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 12 }} />
                    <input type="number" min={1} placeholder="Qty" value={newRow.quantity}
                      onChange={e => setNewRow(r => ({ ...r, quantity: parseInt(e.target.value, 10) || 1 }))}
                      style={{ ...inputStyle, fontSize: 12 }} />
                    <input placeholder="Material" value={newRow.material_description}
                      onChange={e => setNewRow(r => ({ ...r, material_description: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 12 }} />
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Btn small onClick={() => setNewRow(null)}>Cancel</Btn>
                    <Btn small primary onClick={handleAddRow} disabled={adding || !newRow.piece_name?.trim()}>
                      {adding ? "Adding…" : "Add piece"}
                    </Btn>
                  </div>
                </div>
              )}
            </>
          )}
    </div>
  );
}

// ── AddProductModal ───────────────────────────────────────────────────────────

function AddProductModal({ plan, onClose, onAdded }) {
  const [items,   setItems]   = useState([]);
  const [qtys,    setQtys]    = useState({});   // order_item_id -> quantity to add
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(null); // id of the item being added
  const [err,     setErr]     = useState(null);

  useEffect(() => {
    fetch(`/api/production/plans/${plan.id}/available-products`)
      .then(r => r.ok ? r.json() : { items: [] })
      .then(d => {
        const list = d.items || [];
        setItems(list);
        // Default each input to the full remaining balance
        setQtys(Object.fromEntries(list.map(i => [i.id, i.remaining_quantity])));
        setLoading(false);
      });
  }, [plan.id]);

  const addItem = async (item) => {
    const qty = parseInt(qtys[item.id], 10);
    if (!Number.isInteger(qty) || qty < 1) { setErr("Enter a quantity of 1 or more"); return; }
    if (qty > item.remaining_quantity) {
      setErr(`Only ${item.remaining_quantity} unit${item.remaining_quantity !== 1 ? "s" : ""} left to allocate on that line`);
      return;
    }

    setSaving(item.id); setErr(null);
    const r = await fetch(`/api/production/plans/${plan.id}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_item_id:    item.id,
        description:      item.description,
        category:         item.category,
        size:             item.size,
        finish_type:      item.finish_type,
        finish_color:     item.finish_color,
        wood_type:        item.wood_type,
        planned_quantity: qty,
      }),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Failed to add product"); setSaving(null); return; }

    setSaving(null);
    onAdded?.();
    // Keep the modal open when the line still has an unallocated balance,
    // so a split (e.g. 3 in oak, 2 in walnut) can be entered in one sitting.
    if (qty < item.remaining_quantity) {
      setItems(prev => prev
        .map(i => i.id === item.id
          ? { ...i,
              allocated_quantity: i.allocated_quantity + qty,
              remaining_quantity: i.remaining_quantity - qty }
          : i)
        .filter(i => i.remaining_quantity > 0));
      setQtys(prev => ({ ...prev, [item.id]: item.remaining_quantity - qty }));
    } else {
      onClose();
    }
  };

  return (
    <Modal
      title="Add product to plan"
      onClose={onClose}
      footer={<Btn onClick={onClose}>Close</Btn>}
    >
      {loading ? <Loading /> : items.length === 0 ? (
        <div style={{ fontSize: 13, color: C.muted, textAlign: "center", padding: "24px 0" }}>
          Every product on this order is fully allocated to production jobs.
        </div>
      ) : (
        <div>
          {err && <div style={{ fontSize: 13, color: C.red, marginBottom: 10, padding: "6px 10px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
            Products on <Mono>{plan.orders?.order_num}</Mono> with quantity still to plan.
            Add the full balance, or part of it to split a line across jobs.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map(item => {
              const spec    = [item.size, item.finish_color || item.finish_type, item.wood_type].filter(Boolean).join(" · ");
              const partial = item.allocated_quantity > 0;
              return (
                <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", border: T.border, borderRadius: T.radius, background: C.card }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, color: C.ink }}>{item.description || item.category || "Product"}</div>
                    {spec && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{spec}</div>}
                    <div style={{ fontSize: 11, marginTop: 3, color: partial ? C.amber : C.faint }}>
                      {partial
                        ? `${item.allocated_quantity} of ${item.quantity} already planned · ${item.remaining_quantity} left`
                        : `${item.quantity} ordered · none planned yet`}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <input
                      type="number"
                      min={1}
                      max={item.remaining_quantity}
                      value={qtys[item.id] ?? ""}
                      onChange={e => setQtys(p => ({ ...p, [item.id]: e.target.value }))}
                      aria-label={`Quantity to add for ${item.description || "product"}`}
                      style={{ ...inputStyle, width: 70, fontSize: 13, textAlign: "center" }}
                    />
                    <Btn small primary onClick={() => addItem(item)} disabled={saving === item.id}>
                      {saving === item.id ? "Adding…" : "Add"}
                    </Btn>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── PlanDetail ────────────────────────────────────────────────────────────────

function PlanDetail({ plan, canEdit, onRefresh }) {
  const router = useRouter();
  const order  = plan.orders;

  // Active (non-cancelled) jobs, product lines only
  const allJobs      = plan.production_jobs || [];
  const activeJobs   = allJobs.filter(j => !j.cancelled_at);
  const cancelledCt  = allJobs.filter(j =>  j.cancelled_at).length;
  const completedCt  = activeJobs.filter(j => j.status === "Completed").length;

  const [assignJob,      setAssignJob]      = useState(null);
  const [cutListJobId,   setCutListJobId]   = useState(null); // which job's cut list is open
  const [addProductOpen, setAddProductOpen] = useState(false);
  const [planSaving,     setPlanSaving]     = useState(false);
  const [planErr,        setPlanErr]        = useState(null);

  const changePlanStatus = async (nextStatus, extra = {}) => {
    setPlanSaving(true);
    setPlanErr(null);
    const r = await fetch(`/api/production/plans/${plan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus, ...extra }),
    });
    const data = await r.json();
    if (!r.ok) { setPlanErr(data.error || "Failed to update plan"); setPlanSaving(false); return; }
    setPlanSaving(false);
    onRefresh();
  };

  // State-machine: derive the single primary action for each job
  function nextAction(job) {
    const hasMaterials  = (job.production_material_estimates?.length || 0) > 0;
    // Must use isLineComplete, not just a non-null unit cost: a line with a price
    // but no cost source does not count as costed by the checklist or the row
    // badge, so a weaker test here would offer "Assign team" on a job that still
    // blocks activation.
    const materialsCosted = hasMaterials &&
      (job.production_material_estimates || []).every(isLineComplete);
    const hasAssignment = (job.production_job_assignments?.length || 0) > 0;

    if (job.status === "Completed")
      return { label: "Completed ✓", type: "done" };

    // Both BoQ authoring and costing happen in this panel's BoQ tab — the job
    // page is read-only for materials, so sending the user there is a dead end.
    if (!hasMaterials && canEdit)
      return { label: "Add BoQ", type: "action", onClick: () => setCutListJobId(job.id) };

    if (!materialsCosted && canEdit)
      return { label: "Cost materials", type: "action", onClick: () => setCutListJobId(job.id) };

    if (!hasAssignment && canEdit)
      return { label: "Assign team", type: "action", onClick: () => setAssignJob(job) };

    if (plan.status === "Draft")
      return { label: "Ready to activate", type: "done" };

    const inProgress = ["In Production", "Quality Control", "Paused", "Awaiting Materials", "Materials Ready", "Planned"].includes(job.status);
    return {
      label: inProgress ? "View progress ↗" : "Open ↗",
      type: "link",
      onClick: () => router.push(`/production/jobs/${job.id}`),
    };
  }

  // Draft setup checklist (6 steps)
  // Step 3 = BoQ added (at least one estimate per job)
  // Step 4 = Materials costed (every estimate has a unit cost)
  const allHaveStages     = activeJobs.length > 0 && activeJobs.every(j => (j.production_job_stages || []).some(s => s.is_enabled));
  const allHaveBoQ        = activeJobs.length > 0 && activeJobs.every(j => (j.production_material_estimates?.length || 0) > 0);
  const allMaterialsCosted = activeJobs.length > 0 && allHaveBoQ &&
    activeJobs.every(j => (j.production_material_estimates || []).every(m => m.estimated_unit_cost != null));
  const allHaveAssignment = activeJobs.length > 0 && activeJobs.every(j => (j.production_job_assignments?.length || 0) > 0);
  const checklist = [
    { n: 1, label: "Plan created",      done: true },
    { n: 2, label: "Configure stages",  done: allHaveStages },
    { n: 3, label: "BoQ added",         done: allHaveBoQ },
    { n: 4, label: "Materials costed",  done: allMaterialsCosted },
    { n: 5, label: "Team assigned",     done: allHaveAssignment },
    { n: 6, label: "Activate",          done: plan.status !== "Draft" },
  ];
  // Activate is enabled only when steps 1-5 are all complete
  const checklistReady = activeJobs.length > 0 && checklist.slice(0, 5).every(s => s.done);
  const firstMissing   = checklist.slice(0, 5).find(s => !s.done);

  return (
    <div>
      {/* Order info card — delivery date + notes editable */}
      <PlanOrderInfoCard plan={plan} canEdit={canEdit} onSaved={onRefresh} />

      {/* Plan status + actions header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: C.muted }}>
          {activeJobs.length} product{activeJobs.length !== 1 ? "s" : ""}
          {" · "}{completedCt} of {activeJobs.length} completed
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          <Badge color={PLAN_BADGE[plan.status] || "gray"}>{plan.status}</Badge>
          {canEdit && plan.status === "Draft" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
              <Btn small primary onClick={() => changePlanStatus("Active")} disabled={planSaving || !checklistReady}>
                Activate
              </Btn>
              {!checklistReady && firstMissing && (
                <span style={{ fontSize: 10, color: C.amber, whiteSpace: "nowrap" }}>
                  Step {firstMissing.n}: {firstMissing.label}
                </span>
              )}
            </div>
          )}
          {canEdit && plan.status === "Active" && (
            <Btn small onClick={() => changePlanStatus("Paused")} disabled={planSaving}>Pause</Btn>
          )}
          {canEdit && plan.status === "Paused" && (
            <Btn small primary onClick={() => changePlanStatus("Active")} disabled={planSaving}>Resume</Btn>
          )}
          {canEdit && ["Active", "Paused"].includes(plan.status) && (
            <Btn small danger onClick={() => changePlanStatus("Cancelled")} disabled={planSaving}>Cancel</Btn>
          )}
        </div>
      </div>

      {planErr && (
        <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius, marginBottom: 10 }}>
          {planErr}
        </div>
      )}

      {/* Draft setup checklist */}
      {plan.status === "Draft" && activeJobs.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap",
          marginBottom: 16, padding: "10px 16px",
          background: C.bg, borderRadius: T.radius, border: T.border, fontSize: 12,
        }}>
          {checklist.map((s, i, arr) => (
            <span key={s.n} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{
                width: 18, height: 18, borderRadius: "50%", display: "inline-grid", placeItems: "center",
                background: s.done ? C.green : C.line, color: s.done ? "#fff" : C.muted,
                fontSize: 10, fontWeight: 700, flexShrink: 0,
              }}>{s.done ? "✓" : s.n}</span>
              <span style={{ color: s.done ? C.green : C.muted }}>{s.label}</span>
              {i < arr.length - 1 && <span style={{ color: C.line, margin: "0 4px" }}>→</span>}
            </span>
          ))}
        </div>
      )}

      {/* Products table */}
      {activeJobs.length === 0 ? (
        <div style={{ fontSize: 13, color: C.muted, padding: "20px 0" }}>No products to produce in this plan.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.line}` }}>
                {["Products to produce", "Qty", "BoQ / Costing", "Details", "Team", ""].map(h => (
                  <th key={h} style={{
                    textAlign: "left", padding: "8px 12px 8px 0",
                    fontSize: 11, fontWeight: 600, color: C.muted,
                    textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeJobs.map(job => {
                const hasMaterials  = (job.production_material_estimates?.length || 0) > 0;
                const hasAssignment = (job.production_job_assignments?.length || 0) > 0;
                const spec = [job.size, job.finish_color || job.finish_type, job.wood_type].filter(Boolean).join(" · ");
                const action = nextAction(job);
                const cutListOpen = cutListJobId === job.id;
                return (
                  <Fragment key={job.id}>
                    <tr style={{ borderBottom: cutListOpen ? "none" : T.border }}>
                      {/* Product name + spec + job number */}
                      <td style={{ padding: "12px 12px 12px 0", verticalAlign: "top", width: "30%" }}>
                        <div style={{ fontWeight: 500, color: C.ink }}>{job.description || job.category || "Untitled"}</div>
                        {spec && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{spec}</div>}
                        <Mono style={{ fontSize: 11, color: C.faint }}>{job.job_num}</Mono>
                      </td>
                      {/* Planned quantity */}
                      <td style={{ padding: "12px 12px 12px 0", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <Mono style={{ fontSize: 13, color: C.ink }}>{job.planned_quantity}</Mono>
                      </td>
                      {/* BoQ / Costing — costed count is what gates activation */}
                      <td style={{ padding: "12px 12px 12px 0", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        {!hasMaterials ? (
                          <span style={{ fontSize: 12, color: C.amber }}>No BoQ</span>
                        ) : !canEdit ? (
                          <span style={{ fontSize: 12, color: C.muted }}>{job.production_material_estimates.length} material line{job.production_material_estimates.length === 1 ? "" : "s"}</span>
                        ) : (() => {
                          const lines  = job.production_material_estimates;
                          const costed = lines.filter(isLineComplete).length;
                          const done   = costed === lines.length;
                          return (
                            <span style={{ fontSize: 12, color: done ? C.green : C.amber }}>
                              {done ? `✓ ${lines.length} costed` : `${costed} of ${lines.length} costed`}
                            </span>
                          );
                        })()}
                      </td>
                      {/* Open the job panel — BoQ costing, cut list and workers */}
                      <td style={{ padding: "12px 12px 12px 0", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <button
                          onClick={() => setCutListJobId(cutListOpen ? null : job.id)}
                          aria-expanded={cutListOpen}
                          style={{
                            background: cutListOpen ? C.coral : "transparent",
                            color: cutListOpen ? "#fff" : C.blue,
                            border: `1px solid ${cutListOpen ? C.coral : C.line}`,
                            borderRadius: T.radius, padding: "2px 8px", fontSize: 12,
                            cursor: "pointer", fontFamily: "inherit",
                          }}
                        >
                          {cutListOpen ? "Close ▲" : "Open ▼"}
                        </button>
                      </td>
                      {/* Team / assignment */}
                      <td style={{ padding: "12px 12px 12px 0", verticalAlign: "top" }}>
                        {hasAssignment
                          ? <span style={{ fontSize: 12, color: C.green }}>{workerNames(job.production_job_assignments || [])}</span>
                          : <span style={{ fontSize: 12, color: C.faint }}>Unassigned</span>}
                      </td>
                      {/* Primary next action + job access */}
                      <td style={{ padding: "12px 0 12px 0", verticalAlign: "top", textAlign: "right", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
                          {action.type === "done" && (
                            <span style={{ fontSize: 12, color: C.green }}>{action.label}</span>
                          )}
                          {(action.type === "link" || action.type === "action") && (
                            <Btn small primary={action.label === "Cost materials"} onClick={action.onClick}>{action.label}</Btn>
                          )}
                          <Btn small onClick={() => router.push(`/production/jobs/${job.id}`)}>Open ↗</Btn>
                        </div>
                      </td>
                    </tr>
                    {/* Inline job panel — BoQ costing, cut list, workers */}
                    {cutListOpen && (
                      <JobPanel
                        job={job}
                        canEdit={canEdit}
                        onClose={() => setCutListJobId(null)}
                        onRefresh={onRefresh}
                        onAssignWorkers={j => setAssignJob(j)}
                      />
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {cancelledCt > 0 && (
        <div style={{ fontSize: 12, color: C.faint, marginTop: 12 }}>
          {cancelledCt} cancelled product{cancelledCt !== 1 ? "s" : ""} not shown.
        </div>
      )}

      {/* Add product from order */}
      {canEdit && plan.status !== "Cancelled" && (
        <div style={{ marginTop: 14 }}>
          <Btn small onClick={() => setAddProductOpen(true)}>+ Add product from order</Btn>
        </div>
      )}

      {/* Modals */}
      {assignJob && (
        <AssignWorkersModal
          job={assignJob}
          onClose={() => setAssignJob(null)}
          onDone={() => { setAssignJob(null); onRefresh(); }}
        />
      )}
      {addProductOpen && (
        <AddProductModal
          plan={plan}
          onClose={() => setAddProductOpen(false)}
          onAdded={() => { setAddProductOpen(false); onRefresh(); }}
        />
      )}
    </div>
  );
}

// ── MaterialsTab ──────────────────────────────────────────────────────────────
// Order → Job → Material hierarchy. Single endpoint, no N+1. Inline cost editing
// for admin / production_manager. Read-only for all other roles.

// A BoQ line is "estimate complete" when it has a unit cost, a cost source,
// and (when source = supplier or boq_line_type = outsourced_service) a supplier.
function isLineComplete(m) {
  if (m.estimated_unit_cost == null) return false;
  if (!m.cost_source_type) return false;
  if (m.cost_source_type === "supplier" && !m.preferred_supplier?.id) return false;
  if (m.boq_line_type === "outsourced_service" && !m.preferred_supplier?.id) return false;
  return true;
}

function deriveCostingStatus(materials) {
  if (!materials || materials.length === 0) return "boq_missing";
  const allComplete  = materials.every(isLineComplete);
  const someComplete = materials.some(isLineComplete);
  if (allComplete)  return "fully_costed";
  if (someComplete) return "partial";
  return "not_costed";
}

function recomputeJob(job) {
  const costedCt = job.materials.filter(isLineComplete).length;
  const subtotal  = job.materials.reduce((s, m) => s + (m.estimated_total_cost || 0), 0);
  return { ...job, costed_lines: costedCt, estimated_subtotal: subtotal, costing_status: deriveCostingStatus(job.materials) };
}

function recomputeOrder(order) {
  const fullyCostedJobs = order.jobs.filter(j => j.costing_status === "fully_costed").length;
  const uncostedLines   = order.jobs.reduce((s, j) => s + (j.total_lines - j.costed_lines), 0);
  const subtotal        = order.jobs.reduce((s, j) => s + j.estimated_subtotal, 0);
  return { ...order, fully_costed_jobs: fullyCostedJobs, uncosted_lines: uncostedLines, estimated_subtotal: subtotal };
}

function CostingBadge({ job }) {
  const { costing_status, costed_lines, total_lines } = job;
  const base = { fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 10 };
  if (costing_status === "boq_missing")
    return <span style={{ ...base, color: C.muted, background: C.bg }}>BoQ missing</span>;
  if (costing_status === "not_costed")
    return <span style={{ ...base, color: C.amber, background: "#FFF8E1" }}>Costs required</span>;
  if (costing_status === "partial")
    return <span style={{ ...base, color: C.amber, background: "#FFF8E1" }}>Partial · {costed_lines} of {total_lines}</span>;
  return <span style={{ ...base, color: C.green, background: "#E8F5E9" }}>Estimate complete</span>;
}

function MatJobAction({ job, canEdit, onExpandJob, router }) {
  const active = ["In Production", "Quality Control", "Paused", "Awaiting Materials", "Materials Ready"].includes(job.status);
  if (job.costing_status === "boq_missing")
    return <Btn small onClick={() => router.push(`/production/jobs/${job.job_id}`)}>Add BoQ ↗</Btn>;
  if (job.costing_status !== "fully_costed" && canEdit)
    return <Btn small onClick={() => onExpandJob(job.job_id)}>Complete estimate</Btn>;
  if (active)
    return <Btn small onClick={() => router.push(`/production/jobs/${job.job_id}`)}>View progress ↗</Btn>;
  return <Btn small onClick={() => router.push(`/production/jobs/${job.job_id}`)}>View job ↗</Btn>;
}

// ── BoQ vocabulary maps ───────────────────────────────────────────────────────

const BOQ_LINE_TYPE_LABELS = {
  material:           "Material",
  consumable:         "Consumable",
  packaging:          "Packaging",
  internal_labour:    "Internal labour",
  machine_time:       "Machine time",
  outsourced_service: "Outsourced",
};

const BOQ_LINE_TYPE_OPTIONS = [
  { value: "material",           label: "Material" },
  { value: "consumable",         label: "Consumable" },
  { value: "packaging",          label: "Packaging" },
  { value: "internal_labour",    label: "Internal labour" },
  { value: "machine_time",       label: "Machine time" },
  { value: "outsourced_service", label: "Outsourced service" },
];

// In-house line types: setting these auto-sets cost_source_type = 'in_house'
const INHOUSE_BOQ_TYPES = new Set(["internal_labour", "machine_time"]);

// ── CostSourceCombobox ────────────────────────────────────────────────────────
// Searchable cost-source picker: static options (In-house, Stock, Manual) + supplier list.
// onChange receives { costSourceType, supplierId }.

function CostSourceCombobox({ value, supplierId, suppliers, onChange, disabled }) {
  const [open, setOpen]   = useState(false);
  const [q,    setQ]      = useState("");
  const ref               = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const staticOpts = [
    { type: "in_house", label: "In-house",        sub: "Produced internally" },
    { type: "stock",    label: "From stock",       sub: "Draw from inventory" },
    { type: "manual",   label: "Manual estimate",  sub: "No source linked"   },
  ];
  const supplierOpts = (suppliers || []).map(s => ({ type: "supplier", label: s.name, id: s.id }));
  const allOpts = [...staticOpts, ...supplierOpts];
  const lq = q.trim().toLowerCase();
  const visibleOpts = lq ? allOpts.filter(o => o.label.toLowerCase().includes(lq)) : allOpts;

  // Current display
  let displayLabel = "Select source…";
  let displayColor = C.muted;
  if (value === "in_house")       { displayLabel = "In-house";    displayColor = C.blue; }
  else if (value === "stock")     { displayLabel = "From stock";  displayColor = C.green; }
  else if (value === "manual")    { displayLabel = "Manual";      displayColor = C.muted; }
  else if (value === "supplier" && supplierId) {
    const sup = (suppliers || []).find(s => s.id === supplierId);
    displayLabel = sup ? sup.name : "Supplier";
    displayColor = C.ink;
  }

  function select(opt) {
    onChange({ costSourceType: opt.type, supplierId: opt.type === "supplier" ? opt.id : null });
    setOpen(false);
    setQ("");
  }

  return (
    <div ref={ref} style={{ position: "relative", minWidth: 150 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) { setOpen(o => !o); setQ(""); } }}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          padding: "6px 10px", background: open ? C.bg : "transparent",
          border: `1.5px solid ${open ? C.blue : C.line}`, borderRadius: C.radiusSm,
          cursor: disabled ? "default" : "pointer", fontSize: 12, color: displayColor,
          minHeight: 36, textAlign: "left", boxSizing: "border-box",
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayLabel}</span>
        <span style={{ color: C.muted, fontSize: 10, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 300,
          background: C.card, border: T.border, borderRadius: T.radius,
          boxShadow: "0 4px 16px rgba(0,0,0,0.13)", width: 230, maxHeight: 260,
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          <div style={{ padding: "6px 8px", borderBottom: T.border }}>
            <input
              autoFocus
              placeholder="Search…"
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}
              style={{ width: "100%", padding: "5px 8px", fontSize: 12, border: `1px solid ${C.line}`, borderRadius: C.radiusSm, outline: "none", boxSizing: "border-box" }}
            />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {visibleOpts.length === 0 && (
              <div style={{ padding: "10px 12px", fontSize: 12, color: C.muted }}>No results</div>
            )}
            {/* Section header: static options */}
            {!lq && <div style={{ padding: "6px 12px 2px", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Source type</div>}
            {visibleOpts.filter(o => o.type !== "supplier").map((opt, i) => {
              const active = opt.type === value;
              return (
                <button key={opt.type} type="button" onClick={() => select(opt)} style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "7px 12px", background: active ? "#EEF4FF" : "transparent",
                  border: "none", cursor: "pointer", fontSize: 12, color: active ? C.blue : C.ink,
                }}>
                  <div style={{ fontWeight: active ? 600 : 400 }}>{opt.label}</div>
                  {opt.sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{opt.sub}</div>}
                </button>
              );
            })}
            {/* Section header: suppliers */}
            {visibleOpts.some(o => o.type === "supplier") && (
              <div style={{ padding: "6px 12px 2px", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", borderTop: T.border, marginTop: 2 }}>Suppliers</div>
            )}
            {visibleOpts.filter(o => o.type === "supplier").map(opt => {
              const active = value === "supplier" && supplierId === opt.id;
              return (
                <button key={opt.id} type="button" onClick={() => select(opt)} style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "7px 12px", background: active ? "#EEF4FF" : "transparent",
                  border: "none", cursor: "pointer", fontSize: 12,
                  color: active ? C.blue : C.ink, fontWeight: active ? 600 : 400,
                }}>
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Shared input style for cost / supplier fields in edit mode
const matInputStyle = {
  padding: "10px 12px", fontSize: 13,
  border: `1.5px solid ${C.blue}`, borderRadius: C.radiusSm,
  minHeight: 44, boxSizing: "border-box",
  // No outline:none — browser focus ring is intentional for accessibility
};

function MaterialTable({
  job, canEdit, suppliers, editingCost, boqSaving,
  onStartEdit, onCancelEdit, onSaveCost,
  onCostChange, onCostSourceChange, onBoqLineTypeChange,
  selectedMids, onToggleSelect,
}) {
  // Initialize false to match SSR output; useEffect sets the real value after
  // first paint so client and server agree on the initial render (no hydration mismatch).
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const TH = ({ children, right, w }) => (
    <th style={{ textAlign: right ? "right" : "left", padding: "6px 8px 6px 0", fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", width: w }}>
      {children}
    </th>
  );

  // ── Mobile card layout ────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {job.materials.map(m => {
          const ed = editingCost[m.id];
          const isUncosted = m.estimated_unit_cost == null;
          const showEdit = ed != null; // auto-open for uncosted; explicit for costed
          const lineComplete = isLineComplete(m);
          return (
            <div key={m.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.line}` }}>
              {/* Name + BoQ type badge */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                {canEdit && (
                  <input type="checkbox" checked={selectedMids.has(m.id)} onChange={() => onToggleSelect(m.id)}
                    style={{ marginTop: 3, accentColor: C.blue }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, color: C.ink, fontSize: 13 }}>{m.material_name}</div>
                  {m.specification && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{m.specification}</div>}
                </div>
                {/* BoQ line type select — always editable, immediate save */}
                {canEdit && (
                  <select
                    value={m.boq_line_type || "material"}
                    disabled={boqSaving[m.id]}
                    onChange={e => onBoqLineTypeChange(job.job_id, m.id, e.target.value)}
                    style={{ fontSize: 11, color: C.muted, border: `1px solid ${C.line}`, borderRadius: C.radiusSm, padding: "2px 4px", background: "transparent" }}
                  >
                    {BOQ_LINE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
              </div>
              {/* Qty row */}
              <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 12, color: C.muted, flexWrap: "wrap" }}>
                <span>{m.estimated_quantity != null ? Number(m.estimated_quantity).toFixed(2) : "—"} {m.unit}</span>
              </div>
              {/* Edit region: always shown when ed exists (auto-open for uncosted) */}
              {showEdit ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  <input
                    type="number" step="0.01" min="0" placeholder="Unit cost (KES)"
                    value={ed.value}
                    onChange={e => onCostChange(m.id, e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") onSaveCost(job.job_id, m.id); if (e.key === "Escape" && !isUncosted) onCancelEdit(m.id); }}
                    style={{ ...matInputStyle, width: "100%" }}
                    autoFocus={!isUncosted} disabled={ed.saving}
                  />
                  <CostSourceCombobox
                    value={ed.costSource}
                    supplierId={ed.supplierId}
                    suppliers={suppliers}
                    onChange={({ costSourceType, supplierId }) => onCostSourceChange(m.id, costSourceType, supplierId)}
                    disabled={ed.saving || INHOUSE_BOQ_TYPES.has(ed.boqLineType)}
                  />
                  {!isUncosted && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn small primary onClick={() => onSaveCost(job.job_id, m.id)} disabled={ed.saving}>{ed.saving ? "Saving…" : "Save"}</Btn>
                      <Btn small onClick={() => onCancelEdit(m.id)} disabled={ed.saving}>Cancel</Btn>
                    </div>
                  )}
                  {isUncosted && (
                    <Btn small primary onClick={() => onSaveCost(job.job_id, m.id)} disabled={ed.saving}>{ed.saving ? "Saving…" : "Save estimate"}</Btn>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                  {/* Cost source label */}
                  {m.cost_source_type && (
                    <span style={{ fontSize: 11, color: C.muted, background: C.bg, borderRadius: 8, padding: "1px 6px" }}>
                      {m.cost_source_type === "supplier" ? (m.preferred_supplier?.name || "Supplier") : m.cost_source_type === "in_house" ? "In-house" : m.cost_source_type === "stock" ? "Stock" : "Manual"}
                    </span>
                  )}
                  {!lineComplete && <span style={{ fontSize: 11, color: C.amber, fontWeight: 500 }}>Costs required</span>}
                  <span style={{ fontSize: 12, color: lineComplete ? C.ink : C.faint, fontWeight: 500 }}>
                    {m.estimated_unit_cost != null ? <><Mono>{fmtKes(m.estimated_unit_cost)}</Mono><span style={{ color: C.muted, fontWeight: 400 }}>/{m.unit}</span></> : "—"}
                  </span>
                  <span style={{ color: C.muted }}>→</span>
                  <Mono style={{ fontSize: 12, color: m.estimated_total_cost != null ? C.ink : C.faint }}>
                    {m.estimated_total_cost != null ? fmtKes(m.estimated_total_cost) : "—"}
                  </Mono>
                  {canEdit && (
                    <button
                      onClick={() => onStartEdit(m.id, m)}
                      style={{ marginLeft: "auto", background: "none", border: `1px solid ${C.line}`, cursor: "pointer", color: C.muted, fontSize: 11, padding: "6px 10px", borderRadius: C.radiusSm, minHeight: 36 }}
                    >
                      Edit
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ── Desktop table layout ──────────────────────────────────────────────────────
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: `1.5px solid ${C.line}` }}>
          {canEdit && <th style={{ width: 28, padding: "6px 8px 6px 0" }} />}
          <TH>Material / Spec</TH>
          <TH w={100}>BoQ type</TH>
          <TH>Qty · Unit</TH>
          <TH w={170}>Cost source</TH>
          <TH w={120}>Unit cost</TH>
          <TH right w={100}>Total</TH>
          {canEdit && <th style={{ width: 80 }} />}
        </tr>
      </thead>
      <tbody>
        {job.materials.map(m => {
          const ed = editingCost[m.id];
          const isUncosted = m.estimated_unit_cost == null;
          const showEdit = ed != null;
          const lineComplete = isLineComplete(m);
          return (
            <tr key={m.id} style={{ borderBottom: `1px solid ${C.line}`, background: showEdit && isUncosted ? "#FAFBFF" : "transparent" }}>
              {/* Checkbox */}
              {canEdit && (
                <td style={{ padding: "8px 8px 8px 0", verticalAlign: "middle" }}>
                  <input type="checkbox" checked={selectedMids.has(m.id)} onChange={() => onToggleSelect(m.id)}
                    style={{ accentColor: C.blue, cursor: "pointer" }} />
                </td>
              )}
              {/* Material name + specification */}
              <td style={{ padding: "8px 8px 8px 0", verticalAlign: "middle" }}>
                <div style={{ fontWeight: 500, color: C.ink }}>{m.material_name}</div>
                {m.specification && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{m.specification}</div>}
              </td>
              {/* BoQ line type — always-visible select, immediate save */}
              <td style={{ padding: "8px 8px 8px 0", verticalAlign: "middle" }}>
                {canEdit ? (
                  <select
                    value={m.boq_line_type || "material"}
                    disabled={boqSaving[m.id]}
                    onChange={e => onBoqLineTypeChange(job.job_id, m.id, e.target.value)}
                    style={{ fontSize: 11, color: C.muted, border: `1px solid ${C.line}`, borderRadius: C.radiusSm, padding: "3px 6px", background: "transparent", opacity: boqSaving[m.id] ? 0.5 : 1 }}
                  >
                    {BOQ_LINE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <span style={{ fontSize: 11, color: C.muted }}>{BOQ_LINE_TYPE_LABELS[m.boq_line_type] || "Material"}</span>
                )}
              </td>
              {/* Qty · Unit */}
              <td style={{ padding: "8px 8px 8px 0", verticalAlign: "middle" }}>
                <Mono style={{ color: C.ink }}>{m.estimated_quantity != null ? Number(m.estimated_quantity).toFixed(2) : "—"}</Mono>
                <span style={{ color: C.muted, marginLeft: 4 }}>{m.unit}</span>
              </td>
              {/* Cost source — combobox when editing, label otherwise */}
              <td style={{ padding: "8px 8px 8px 0", verticalAlign: "middle", minWidth: 150 }}>
                {showEdit ? (
                  <CostSourceCombobox
                    value={ed.costSource}
                    supplierId={ed.supplierId}
                    suppliers={suppliers}
                    onChange={({ costSourceType, supplierId }) => onCostSourceChange(m.id, costSourceType, supplierId)}
                    disabled={ed.saving || INHOUSE_BOQ_TYPES.has(ed.boqLineType)}
                  />
                ) : (
                  <span style={{ fontSize: 11, color: C.muted }}>
                    {m.cost_source_type === "in_house"  ? "In-house"
                      : m.cost_source_type === "stock"  ? "From stock"
                      : m.cost_source_type === "manual" ? "Manual"
                      : m.cost_source_type === "supplier" ? (m.preferred_supplier?.name || "Supplier (unset)")
                      : <span style={{ color: C.amber }}>Not set</span>}
                  </span>
                )}
              </td>
              {/* Unit cost — always-visible input for uncosted rows; click-to-edit for costed */}
              <td style={{ padding: "8px 8px 8px 0", verticalAlign: "middle", minWidth: 110 }}>
                {showEdit ? (
                  <input
                    type="number" step="0.01" min="0" placeholder="0.00"
                    value={ed.value}
                    onChange={e => onCostChange(m.id, e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") onSaveCost(job.job_id, m.id); if (e.key === "Escape" && !isUncosted) onCancelEdit(m.id); }}
                    style={{ ...matInputStyle, width: "100%" }}
                    autoFocus={!isUncosted} disabled={ed.saving}
                  />
                ) : (
                  <span
                    onClick={() => canEdit && onStartEdit(m.id, m)}
                    style={{ cursor: canEdit ? "pointer" : "default", color: lineComplete ? C.ink : C.amber }}
                    title={canEdit ? "Click to edit" : undefined}
                  >
                    {m.estimated_unit_cost != null
                      ? <Mono>{fmtKes(m.estimated_unit_cost)}</Mono>
                      : <span style={{ fontSize: 11, fontWeight: 500 }}>{canEdit ? "Set cost" : "—"}</span>}
                  </span>
                )}
              </td>
              {/* Total */}
              <td style={{ padding: "8px 8px 8px 0", verticalAlign: "middle", textAlign: "right" }}>
                <Mono style={{ color: m.estimated_total_cost != null ? C.ink : C.faint }}>
                  {m.estimated_total_cost != null ? fmtKes(m.estimated_total_cost) : "—"}
                </Mono>
              </td>
              {/* Actions: save/cancel for costed rows in edit mode; none for uncosted (use the button at bottom) */}
              {canEdit && (
                <td style={{ padding: "8px 0", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                  {showEdit && !isUncosted ? (
                    <div style={{ display: "flex", gap: 4 }}>
                      <Btn small primary onClick={() => onSaveCost(job.job_id, m.id)} disabled={ed.saving}>
                        {ed.saving ? "…" : "Save"}
                      </Btn>
                      <Btn small onClick={() => onCancelEdit(m.id)} disabled={ed.saving}>✕</Btn>
                    </div>
                  ) : showEdit && isUncosted ? (
                    <Btn small primary onClick={() => onSaveCost(job.job_id, m.id)} disabled={ed.saving}>
                      {ed.saving ? "…" : "Save"}
                    </Btn>
                  ) : (
                    <button
                      onClick={() => onStartEdit(m.id, m)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 11, padding: "4px 6px", borderRadius: C.radiusSm }}
                    >
                      Edit
                    </button>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MaterialsTab({ focusJobId, onFocusHandled }) {
  const { role } = useAuth();
  const router   = useRouter();
  const canEdit  = ["admin", "production_manager"].includes(role);

  const [orders,       setOrders]       = useState([]);
  const [loaded,       setLoaded]       = useState(false);
  const [err,          setErr]          = useState(null);
  const [search,       setSearch]       = useState("");
  const [costingFlt,   setCostingFlt]   = useState("all");    // all | needs_costing | fully_costed
  const [planStatus,   setPlanStatus]   = useState("Active"); // Active | Draft | Active,Draft
  const [expanded,     setExpanded]     = useState({});       // order_id → bool
  const [jobExpanded,  setJobExpanded]  = useState({});       // job_id   → bool
  const [editingCost,  setEditingCost]  = useState({});       // mid → { value, costSource, supplierId, boqLineType, saving }
  const [boqSaving,    setBoqSaving]    = useState({});       // mid → bool (boq_line_type immediate save)
  const [suppliers,    setSuppliers]    = useState([]);       // for CostSourceCombobox
  const [selectedMids, setSelectedMids] = useState(new Set()); // bulk selection
  const [bulkSupplierPick, setBulkSupplierPick] = useState(null); // { costSourceType, supplierId } for bulk modal
  const [bulkWorking,  setBulkWorking]  = useState(false);

  // A costing link may come from a Draft plan, while this tab normally opens on
  // Active plans. Include both so the requested job is guaranteed to be fetched.
  useEffect(() => {
    if (focusJobId && planStatus !== "Active,Draft") setPlanStatus("Active,Draft");
  }, [focusJobId, planStatus]);

  // ── Load suppliers once (for CostSourceCombobox) ────────────────────────────
  useEffect(() => {
    if (!canEdit) return;
    fetch("/api/suppliers")
      .then(r => r.ok ? r.json() : { data: [] })
      .then(({ data: list }) => setSuppliers(list || []))
      .catch(() => {});
  }, [canEdit]);

  // ── Load (server: plan_status filter) ────────────────────────────────────────
  const load = useCallback(async (ps) => {
    setLoaded(false);
    setErr(null);
    const r = await fetch(`/api/production/materials-summary?plan_status=${encodeURIComponent(ps)}`);
    if (!r.ok) { setErr("Failed to load materials"); setLoaded(true); return; }
    const { orders: data } = await r.json();
    setOrders(data || []);
    if (data?.length > 0) setExpanded({ [data[0].order_id]: true });
    setLoaded(true);
  }, []);

  useEffect(() => { load(planStatus); }, [load, planStatus]);

  // ── Auto-open edit state for uncosted rows (direct edit UX) ─────────────────
  // Uncosted rows should show their inputs immediately so the user can type
  // without first clicking an "Edit" button.
  useEffect(() => {
    if (!canEdit || !loaded) return;
    setEditingCost(e => {
      const next = { ...e };
      let changed = false;
      for (const o of orders) {
        for (const j of o.jobs) {
          for (const m of j.materials) {
            if (m.estimated_unit_cost == null && !next[m.id]) {
              next[m.id] = {
                value: "",
                costSource: m.cost_source_type || null,
                supplierId: m.preferred_supplier?.id || null,
                boqLineType: m.boq_line_type || "material",
                saving: false,
              };
              changed = true;
            }
          }
        }
      }
      return changed ? next : e;
    });
  }, [orders, canEdit, loaded]);

  // When opened from a production-plan row, reveal and scroll to that exact job.
  useEffect(() => {
    if (!focusJobId || !loaded || orders.length === 0) return;
    const parentOrder = orders.find(o => o.jobs.some(j => j.job_id === focusJobId));
    if (!parentOrder) return;
    setExpanded(e => ({ ...e, [parentOrder.order_id]: true }));
    setJobExpanded(e => ({ ...e, [focusJobId]: true }));
    const timer = window.setTimeout(() => {
      document.getElementById(`material-job-${focusJobId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      onFocusHandled?.();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [focusJobId, loaded, orders, onFocusHandled]);

  // ── Client-side filter (search + costing) ────────────────────────────────────
  const filtered = useMemo(() => {
    let result = orders;

    if (costingFlt !== "all") {
      result = result.map(o => {
        const jobs = o.jobs.filter(j =>
          costingFlt === "fully_costed"
            ? j.costing_status === "fully_costed"
            : j.costing_status !== "fully_costed"
        );
        return jobs.length ? recomputeOrder({ ...o, jobs }) : null;
      }).filter(Boolean);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.map(o => {
        const orderHit = [o.order_num, o.client].join(" ").toLowerCase().includes(q);
        const jobs = o.jobs.filter(j =>
          orderHit ||
          [j.name, j.job_num].join(" ").toLowerCase().includes(q) ||
          j.materials.some(m => m.material_name.toLowerCase().includes(q))
        );
        return jobs.length ? recomputeOrder({ ...o, jobs }) : null;
      }).filter(Boolean);
    }

    return result;
  }, [orders, costingFlt, search]);

  // ── Inline cost editing ───────────────────────────────────────────────────────
  function startEdit(mid, m) {
    setEditingCost(e => ({
      ...e,
      [mid]: {
        value: m.estimated_unit_cost != null ? String(m.estimated_unit_cost) : "",
        costSource: m.cost_source_type || null,
        supplierId: m.preferred_supplier?.id || null,
        boqLineType: m.boq_line_type || "material",
        saving: false,
      },
    }));
  }
  function cancelEdit(mid) {
    setEditingCost(e => { const n = { ...e }; delete n[mid]; return n; });
  }
  function costChange(mid, value) {
    setEditingCost(e => ({ ...e, [mid]: { ...e[mid], value } }));
  }
  function costSourceChange(mid, costSourceType, supplierId) {
    setEditingCost(e => ({ ...e, [mid]: { ...e[mid], costSource: costSourceType, supplierId: supplierId || null } }));
  }

  // ── boq_line_type: immediate save (independent of cost editing) ──────────────
  async function saveBoqLineType(jobId, mid, boqLineType) {
    setBoqSaving(b => ({ ...b, [mid]: true }));
    const r = await fetch(`/api/production/jobs/${jobId}/materials/${mid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boq_line_type: boqLineType }),
    });
    setBoqSaving(b => ({ ...b, [mid]: false }));
    if (!r.ok) return;
    const { material: updated } = await r.json();
    // Update local material + reflect auto-changes (e.g. in_house clears supplier)
    setOrders(prev => prev.map(o => ({
      ...o,
      jobs: o.jobs.map(j => j.job_id !== jobId ? j : recomputeJob({
        ...j,
        materials: j.materials.map(m => m.id !== mid ? m : {
          ...m,
          boq_line_type:    updated.boq_line_type,
          cost_source_type: updated.cost_source_type,
          preferred_supplier: updated.cost_source_type !== "supplier" ? null : m.preferred_supplier,
        }),
      })),
    })));
    // If currently editing this row, sync editingCost to reflect auto-set source
    if (editingCost[mid]) {
      const autoSource = INHOUSE_BOQ_TYPES.has(boqLineType) ? "in_house" : editingCost[mid].costSource;
      const autoSupplierId = INHOUSE_BOQ_TYPES.has(boqLineType) ? null : editingCost[mid].supplierId;
      setEditingCost(e => ({ ...e, [mid]: { ...e[mid], boqLineType, costSource: autoSource, supplierId: autoSupplierId } }));
    }
  }

  // ── Save cost + source ────────────────────────────────────────────────────────
  async function saveCost(jobId, mid) {
    const entry = editingCost[mid];
    if (!entry) return;
    const raw = entry.value.trim();
    const num = raw === "" ? null : parseFloat(raw);
    if (raw !== "" && (isNaN(num) || num < 0)) return;

    setEditingCost(e => ({ ...e, [mid]: { ...e[mid], saving: true } }));
    const body = {
      estimated_unit_cost: num,
      cost_source_type: entry.costSource || null,
      preferred_supplier_id: entry.costSource === "supplier" ? (entry.supplierId || null) : null,
    };
    const r = await fetch(`/api/production/jobs/${jobId}/materials/${mid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { setEditingCost(e => ({ ...e, [mid]: { ...e[mid], saving: false } })); return; }
    const { material: updated } = await r.json();

    const savedSupplier = entry.costSource === "supplier" && entry.supplierId
      ? (suppliers.find(s => s.id === entry.supplierId) || null)
      : null;

    setOrders(prev => prev.map(o => {
      const updatedJobs = o.jobs.map(j => j.job_id !== jobId ? j : recomputeJob({
        ...j,
        materials: j.materials.map(m => m.id !== mid ? m : {
          ...m,
          estimated_unit_cost:  updated.estimated_unit_cost  != null ? Number(updated.estimated_unit_cost)  : null,
          estimated_total_cost: updated.estimated_total_cost != null ? Number(updated.estimated_total_cost) : null,
          cost_source_type:     updated.cost_source_type || null,
          preferred_supplier:   savedSupplier ? { id: savedSupplier.id, name: savedSupplier.name } : null,
        }),
      }));
      return recomputeOrder({ ...o, jobs: updatedJobs });
    }));

    cancelEdit(mid);
  }

  // ── Bulk selection ────────────────────────────────────────────────────────────
  function toggleSelect(mid) {
    setSelectedMids(prev => { const n = new Set(prev); n.has(mid) ? n.delete(mid) : n.add(mid); return n; });
  }
  function clearSelection() { setSelectedMids(new Set()); }

  // ── Bulk actions ──────────────────────────────────────────────────────────────
  function findJobIdForMid(mid) {
    for (const o of orders) {
      for (const j of o.jobs) {
        if (j.materials.some(m => m.id === mid)) return j.job_id;
      }
    }
    return null;
  }
  async function bulkSetSource(costSourceType, supplierId) {
    setBulkWorking(true);
    const mids = [...selectedMids];
    const results = await Promise.all(mids.map(async mid => {
      const jobId = findJobIdForMid(mid);
      if (!jobId) return { mid, ok: false, error: "Job not found" };
      try {
        const r = await fetch(`/api/production/jobs/${jobId}/materials/${mid}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cost_source_type: costSourceType,
            preferred_supplier_id: costSourceType === "supplier" ? supplierId : null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          return { mid, ok: false, error: body.error || `HTTP ${r.status}` };
        }
        return { mid, ok: true };
      } catch (e) {
        return { mid, ok: false, error: e.message };
      }
    }));
    setBulkWorking(false);
    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      alert(`${failed.length} of ${mids.length} updates failed. Check the console for details.`);
      console.error("bulkSetSource failures:", failed);
    }
    clearSelection();
    await load(planStatus);
  }

  const expandJob = (jobId) => setJobExpanded(e => ({ ...e, [jobId]: true }));

  if (!loaded) return <Loading />;

  // Grand total: sum only the jobs visible after client-side filtering
  const grandTotal = filtered.reduce(
    (s, o) => s + o.jobs.reduce((js, j) => js + j.estimated_subtotal, 0),
    0
  );

  return (
    <div>
      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <input
          placeholder="Search order, client, product or material…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: "1 1 200px", minWidth: 160, padding: "8px 12px", fontSize: 13 }}
        />
        <select
          value={planStatus}
          onChange={e => setPlanStatus(e.target.value)}
          style={{ ...inputStyle, flex: "0 0 auto", width: "auto", padding: "8px 12px", fontSize: 13 }}
        >
          <option value="Active">Active plans</option>
          <option value="Draft">Draft plans</option>
          <option value="Active,Draft">Active + Draft</option>
        </select>
        <select
          value={costingFlt}
          onChange={e => setCostingFlt(e.target.value)}
          style={{ ...inputStyle, flex: "0 0 auto", width: "auto", padding: "8px 12px", fontSize: 13 }}
        >
          <option value="all">All costing states</option>
          <option value="needs_costing">Estimate required</option>
          <option value="fully_costed">Estimate complete</option>
        </select>
      </div>

      {/* ── Bulk action toolbar ─────────────────────────────────────────────── */}
      {canEdit && selectedMids.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#EEF4FF", borderRadius: T.radius, border: `1px solid #C7D9FF`, marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.blue }}>
            {selectedMids.size} line{selectedMids.size !== 1 ? "s" : ""} selected
          </span>
          <Btn small disabled={bulkWorking} onClick={() => bulkSetSource("in_house", null)}>Mark as In-house</Btn>
          <Btn small disabled={bulkWorking} onClick={() => bulkSetSource("stock", null)}>Mark as Stock</Btn>
          <Btn small disabled={bulkWorking} onClick={() => setBulkSupplierPick({ costSourceType: "supplier", supplierId: null })}>Apply supplier…</Btn>
          <button
            onClick={clearSelection}
            style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: 12, color: C.muted, padding: "4px 8px" }}
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Bulk supplier picker modal ──────────────────────────────────────── */}
      {bulkSupplierPick && (
        <Modal title="Apply supplier to selected lines" onClose={() => setBulkSupplierPick(null)}>
          <div style={{ marginBottom: 14, fontSize: 13, color: C.muted }}>
            Choose a supplier to assign to {selectedMids.size} selected line{selectedMids.size !== 1 ? "s" : ""}.
          </div>
          <CostSourceCombobox
            value={bulkSupplierPick.supplierId ? "supplier" : null}
            supplierId={bulkSupplierPick.supplierId}
            suppliers={suppliers}
            onChange={({ costSourceType, supplierId }) => setBulkSupplierPick(p => ({ ...p, costSourceType, supplierId }))}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <Btn primary disabled={!bulkSupplierPick.supplierId || bulkWorking}
              onClick={() => { bulkSetSource("supplier", bulkSupplierPick.supplierId); setBulkSupplierPick(null); }}>
              {bulkWorking ? "Applying…" : `Apply to ${selectedMids.size} line${selectedMids.size !== 1 ? "s" : ""}`}
            </Btn>
            <Btn onClick={() => setBulkSupplierPick(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {err && (
        <div style={{ padding: "10px 14px", background: C.redBg, color: C.red, borderRadius: T.radius, marginBottom: 16, fontSize: 13 }}>{err}</div>
      )}

      {/* ── Empty state ──────────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: C.ink, marginBottom: 6 }}>
            {orders.length === 0 ? "No material estimates" : "No results match your filters"}
          </div>
          <div style={{ fontSize: 13 }}>
            {orders.length === 0
              ? "BoQ lines are added inside a production plan — open a plan, expand a product, and use its BoQ tab."
              : "Try widening your search or changing the costing filter."}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* ── Order cards ────────────────────────────────────────────────── */}
          {filtered.map(order => {
            const isOpen       = !!expanded[order.order_id];
            const needsCosting = order.uncosted_lines > 0;

            return (
              <div key={order.order_id} style={{ border: T.border, borderRadius: T.radius, background: C.card, overflow: "hidden" }}>

                {/* Order header — click to expand/collapse */}
                <button
                  onClick={() => setExpanded(e => ({ ...e, [order.order_id]: !e[order.order_id] }))}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
                >
                  <span style={{ fontSize: 11, color: C.muted, flexShrink: 0, transition: "transform 0.15s", transform: isOpen ? "rotate(90deg)" : "none" }}>▶</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Mono style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{order.order_num}</Mono>
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{order.client}</span>
                      {order.due_date && (
                        <span style={{ fontSize: 12, color: C.muted }}>· Due {fmtShortDate(order.due_date)}</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 10, marginTop: 3, fontSize: 12, color: C.muted, flexWrap: "wrap" }}>
                      <span>{order.total_jobs} product{order.total_jobs !== 1 ? "s" : ""}</span>
                      {order.estimated_subtotal > 0 && <span>{fmtKes(order.estimated_subtotal)} estimated</span>}
                      {needsCosting
                        ? <span style={{ color: C.amber }}>{order.uncosted_lines} line{order.uncosted_lines !== 1 ? "s" : ""} need estimate</span>
                        : order.total_jobs > 0 && <span style={{ color: C.green }}>All estimates complete</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: C.muted, flexShrink: 0, whiteSpace: "nowrap" }}>
                    {order.fully_costed_jobs}/{order.total_jobs} complete
                  </span>
                </button>

                {/* Job blocks */}
                {isOpen && (
                  <div style={{ borderTop: T.border }}>
                    {order.jobs.map((job, ji) => {
                      const jobOpen  = !!jobExpanded[job.job_id];
                      const specParts = [job.size, job.wood_type, job.finish_color].filter(Boolean);

                      return (
                        <div id={`material-job-${job.job_id}`} key={job.job_id} style={{ borderBottom: ji < order.jobs.length - 1 ? T.border : "none" }}>

                          {/* Job header */}
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 16px", background: jobOpen ? C.bg : "transparent" }}>
                            <button
                              onClick={() => setJobExpanded(e => ({ ...e, [job.job_id]: !e[job.job_id] }))}
                              style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 0", flexShrink: 0, fontSize: 12, color: C.muted, marginTop: 3, minWidth: 16, minHeight: 44, display: "flex", alignItems: "flex-start", paddingTop: 3 }}
                            >
                              {jobOpen ? "▾" : "▸"}
                            </button>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{job.name}</span>
                                <Mono style={{ fontSize: 11, color: C.muted }}>{job.job_num}</Mono>
                                <CostingBadge job={job} />
                              </div>
                              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                                Qty {job.planned_quantity}
                                {specParts.length > 0 && ` · ${specParts.join(" · ")}`}
                                {job.total_lines > 0 && ` · ${job.total_lines} material line${job.total_lines !== 1 ? "s" : ""}`}
                              </div>
                              {job.estimated_subtotal > 0 && (
                                <div style={{ fontSize: 12, marginTop: 2 }}>
                                  <Mono style={{ color: C.ink }}>{fmtKes(job.estimated_subtotal)}</Mono>
                                  <span style={{ color: C.muted }}> estimated</span>
                                  {job.total_lines > job.costed_lines && (
                                    <span style={{ color: C.amber, marginLeft: 6 }}>· {job.total_lines - job.costed_lines} estimate required</span>
                                  )}
                                </div>
                              )}
                            </div>
                            <div style={{ flexShrink: 0 }}>
                              <MatJobAction job={job} canEdit={canEdit} onExpandJob={expandJob} router={router} />
                            </div>
                          </div>

                          {/* Material table (expandable) */}
                          {jobOpen && (
                            <div style={{ padding: "0 16px 14px 36px" }}>
                              {job.materials.length === 0 ? (
                                <div style={{ fontSize: 12, color: C.muted, padding: "10px 0" }}>
                                  No material estimates added yet.
                                  {canEdit && (
                                    <button
                                      onClick={() => router.push(`/production/jobs/${job.job_id}`)}
                                      style={{ marginLeft: 8, fontSize: 12, color: C.blue, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
                                    >
                                      Add BoQ ↗
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <>
                                  <div style={{ overflowX: "auto" }}>
                                    <MaterialTable
                                      job={job}
                                      canEdit={canEdit}
                                      suppliers={suppliers}
                                      editingCost={editingCost}
                                      boqSaving={boqSaving}
                                      onStartEdit={startEdit}
                                      onCancelEdit={cancelEdit}
                                      onSaveCost={saveCost}
                                      onCostChange={costChange}
                                      onCostSourceChange={costSourceChange}
                                      onBoqLineTypeChange={saveBoqLineType}
                                      selectedMids={selectedMids}
                                      onToggleSelect={toggleSelect}
                                    />
                                  </div>
                                  {/* Job subtotal row */}
                                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 16, marginTop: 8, paddingTop: 8, borderTop: T.border, fontSize: 12, flexWrap: "wrap" }}>
                                    {job.total_lines > job.costed_lines && (
                                      <span style={{ color: C.amber }}>
                                        {job.total_lines - job.costed_lines} estimate required
                                      </span>
                                    )}
                                    <span style={{ color: C.muted }}>Job subtotal</span>
                                    <Mono style={{ fontWeight: 600, color: C.ink }}>
                                      {job.estimated_subtotal > 0 ? fmtKes(job.estimated_subtotal) : "—"}
                                    </Mono>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Grand total */}
          {grandTotal > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 16, padding: "10px 0", fontWeight: 600, fontSize: 13, borderTop: `2px solid ${C.line}` }}>
              <span style={{ color: C.muted }}>Total estimated material cost</span>
              <Mono style={{ color: C.ink }}>{fmtKes(grandTotal)}</Mono>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── TemplatesTab ──────────────────────────────────────────────────────────────
// Full CRUD for BoQ templates. Managers create, edit and delete templates;
// staff can view them. Each template maps to a job category and holds an
// ordered list of standard material line items.

function TemplateItemEditor({ items, onChange }) {
  // items: [{material_name, specification, unit, quantity_per_unit, waste_percentage, boq_line_type}]
  const blankRow = () => ({ material_name: "", specification: "", unit: "", quantity_per_unit: "1", waste_percentage: "0", boq_line_type: "material" });
  const update = (i, field, val) => onChange(items.map((it, idx) => idx === i ? { ...it, [field]: val } : it));
  const add    = () => onChange([...items, blankRow()]);
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));

  const col = (label, width) => (
    <th style={{ textAlign: "left", padding: "5px 6px 5px 0", fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", width }}>{label}</th>
  );

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: `1.5px solid ${C.line}` }}>
              {col("Material name *",  "22%")}
              {col("Specification",    "18%")}
              {col("Type *",           "16%")}
              {col("Unit *",           "9%")}
              {col("Qty/unit *",       "9%")}
              {col("Waste %",          "7%")}
              {col("",                 "32px")}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "14px 0", color: C.muted, fontSize: 12, textAlign: "center" }}>
                  No items yet — add a row below.
                </td>
              </tr>
            )}
            {items.map((it, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                <td style={{ padding: "5px 6px 5px 0" }}>
                  <input value={it.material_name} onChange={e => update(i, "material_name", e.target.value)}
                    placeholder="e.g. Frame Moulding" style={{ ...inputStyle, fontSize: 12 }} />
                </td>
                <td style={{ padding: "5px 6px 5px 0" }}>
                  <input value={it.specification} onChange={e => update(i, "specification", e.target.value)}
                    placeholder="Optional detail" style={{ ...inputStyle, fontSize: 12 }} />
                </td>
                <td style={{ padding: "5px 6px 5px 0" }}>
                  <select value={it.boq_line_type || "material"} onChange={e => update(i, "boq_line_type", e.target.value)}
                    style={{ ...inputStyle, fontSize: 12 }}>
                    {BOQ_LINE_TYPE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: "5px 6px 5px 0" }}>
                  <input value={it.unit} onChange={e => update(i, "unit", e.target.value)}
                    placeholder="sheet" style={{ ...inputStyle, fontSize: 12 }} />
                </td>
                <td style={{ padding: "5px 6px 5px 0" }}>
                  <input type="number" step="0.0001" min="0.0001" value={it.quantity_per_unit}
                    onChange={e => update(i, "quantity_per_unit", e.target.value)} style={{ ...inputStyle, fontSize: 12 }} />
                </td>
                <td style={{ padding: "5px 6px 5px 0" }}>
                  <input type="number" step="0.01" min="0" max="99.99" value={it.waste_percentage}
                    onChange={e => update(i, "waste_percentage", e.target.value)} style={{ ...inputStyle, fontSize: 12 }} />
                </td>
                <td style={{ padding: "5px 0" }}>
                  <button onClick={() => remove(i)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 14, padding: "2px 4px" }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8 }}>
        <Btn small onClick={add}>+ Add item</Btn>
      </div>
    </div>
  );
}

function TemplateModal({ template, onClose, onSaved }) {
  // template = null (new) | { id, name, category, description, items }
  const isNew = !template;
  const [name,        setName]        = useState(template?.name        || "");
  const [category,    setCategory]    = useState(template?.category    || "");
  const [description, setDescription] = useState(template?.description || "");
  const [items,       setItems]       = useState(
    (template?.items || []).map(it => ({
      material_name:     it.material_name,
      specification:     it.specification || "",
      unit:              it.unit,
      quantity_per_unit: String(it.quantity_per_unit),
      waste_percentage:  String(it.waste_percentage ?? 0),
      boq_line_type:     it.boq_line_type || "material",
    }))
  );
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState(null);

  const handleSave = async () => {
    setErr(null);
    if (!name.trim())     { setErr("Template name is required"); return; }
    if (!category.trim()) { setErr("Category is required — it must match the job category exactly"); return; }

    // Validate items
    for (let i = 0; i < items.length; i++) {
      if (!items[i].material_name.trim()) { setErr(`Row ${i + 1}: material name is required`); return; }
      if (!items[i].unit.trim())          { setErr(`Row ${i + 1}: unit is required`); return; }
      if (parseFloat(items[i].quantity_per_unit) <= 0) { setErr(`Row ${i + 1}: quantity must be > 0`); return; }
    }

    setSaving(true);
    let templateId = template?.id;

    // Create or update header
    if (isNew) {
      const r = await fetch("/api/production/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), category: category.trim(), description: description.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "Failed to create template"); setSaving(false); return; }
      templateId = d.template.id;
    } else {
      const r = await fetch(`/api/production/templates/${templateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), category: category.trim(), description: description.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "Failed to update template"); setSaving(false); return; }
    }

    // Save items (PUT replaces all)
    const r2 = await fetch(`/api/production/templates/${templateId}/items`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const d2 = await r2.json();
    if (!r2.ok) { setErr(d2.error || "Failed to save items"); setSaving(false); return; }

    onSaved();
  };

  return (
    <Modal
      title={isNew ? "New BoQ template" : `Edit template — ${template.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save template"}</Btn>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {err && (
          <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius }}>{err}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, display: "block", marginBottom: 4 }}>Template name *</label>
            <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="e.g. Wall Decoration" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, display: "block", marginBottom: 4 }}>
              Job category * <span style={{ fontSize: 11, fontWeight: 400, color: C.muted }}>(must match job category exactly)</span>
            </label>
            <input value={category} onChange={e => setCategory(e.target.value)} style={inputStyle} placeholder="e.g. Wall Decoration" />
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, display: "block", marginBottom: 4 }}>Description</label>
          <input value={description} onChange={e => setDescription(e.target.value)} style={inputStyle} placeholder="Optional description…" />
        </div>

        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, marginBottom: 10 }}>
            Material line items ({items.length})
          </div>
          <TemplateItemEditor items={items} onChange={setItems} />
        </div>
      </div>
    </Modal>
  );
}

function TemplatesTab({ canEdit }) {
  const [templates,  setTemplates]  = useState([]);
  const [loaded,     setLoaded]     = useState(false);
  const [err,        setErr]        = useState(null);
  const [editing,    setEditing]    = useState(null);  // null | 'new' | template obj
  const [expanded,   setExpanded]   = useState(null);  // template id
  const [deleting,   setDeleting]   = useState(null);

  const load = async () => {
    setLoaded(false);
    const r = await fetch("/api/production/templates?with_items=true");
    if (!r.ok) { setErr("Failed to load templates"); setLoaded(true); return; }
    const { templates: t } = await r.json();
    setTemplates(t || []);
    setLoaded(true);
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id) => {
    if (!confirm("Archive this template? It will no longer appear in the Load BoQ list.")) return;
    setDeleting(id);
    const r = await fetch(`/api/production/templates/${id}`, { method: "DELETE" });
    if (r.ok) {
      setTemplates(ts => ts.filter(t => t.id !== id));
      if (expanded === id) setExpanded(null);
    } else {
      setErr("Failed to archive template");
    }
    setDeleting(null);
  };

  if (!loaded) return <Loading />;

  return (
    <div>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 500, fontSize: 15, color: C.ink }}>BoQ Templates</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            Standard Bill of Quantities for each product category. Click "Load BoQ" on any production job to insert a template's items in one step.
          </div>
        </div>
        {canEdit && (
          <Btn primary onClick={() => setEditing("new")}>+ New template</Btn>
        )}
      </div>

      {err && (
        <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius, marginBottom: 16 }}>{err}</div>
      )}

      {templates.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: C.ink, marginBottom: 6 }}>No templates yet</div>
          <div style={{ fontSize: 13, marginBottom: 16 }}>Create a template so your team can load a full material list with one click.</div>
          {canEdit && <Btn onClick={() => setEditing("new")}>Create first template</Btn>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {templates.map(t => {
            const isOpen = expanded === t.id;
            return (
              <div key={t.id} style={{ border: `1px solid ${C.line}`, borderRadius: T.radius, overflow: "hidden" }}>
                {/* Card header */}
                <div
                  onClick={() => setExpanded(isOpen ? null : t.id)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer", background: isOpen ? C.bg : C.card, userSelect: "none" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>{t.name}</div>
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                        Category: <span style={{ color: C.ink }}>{t.category}</span>
                        {t.description && <> · {t.description}</>}
                      </div>
                    </div>
                    <Badge color="gray">{t.item_count} {t.item_count === 1 ? "item" : "items"}</Badge>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {canEdit && (
                      <>
                        <Btn small onClick={e => { e.stopPropagation(); setEditing(t); }}>Edit</Btn>
                        <Btn small danger onClick={e => { e.stopPropagation(); handleDelete(t.id); }} disabled={deleting === t.id}>
                          {deleting === t.id ? "…" : "Archive"}
                        </Btn>
                      </>
                    )}
                    <span style={{ fontSize: 12, color: C.muted }}>{isOpen ? "▲" : "▼"}</span>
                  </div>
                </div>

                {/* Expanded items table */}
                {isOpen && (
                  <div style={{ padding: "0 16px 14px", borderTop: `1px solid ${C.line}` }}>
                    {!t.items || t.items.length === 0 ? (
                      <div style={{ fontSize: 12, color: C.muted, padding: "12px 0" }}>No items — edit this template to add materials.</div>
                    ) : (
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 12 }}>
                          <thead>
                            <tr style={{ borderBottom: `1.5px solid ${C.line}` }}>
                              {["#", "Material", "Spec", "Unit", "Qty/unit", "Waste%"].map(h => (
                                <th key={h} style={{ textAlign: "left", padding: "4px 8px 6px 0", fontSize: 10, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {t.items.map((it, idx) => (
                              <tr key={it.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                                <td style={{ padding: "7px 8px 7px 0", color: C.faint, width: 24 }}>{idx + 1}</td>
                                <td style={{ padding: "7px 8px 7px 0", fontWeight: 500, color: C.ink }}>{it.material_name}</td>
                                <td style={{ padding: "7px 8px 7px 0", color: C.muted }}>{it.specification || "—"}</td>
                                <td style={{ padding: "7px 8px 7px 0", color: C.muted }}>{it.unit}</td>
                                <td style={{ padding: "7px 8px 7px 0" }}><Mono>{it.quantity_per_unit}</Mono></td>
                                <td style={{ padding: "7px 0 7px 0" }}><Mono>{it.waste_percentage}%</Mono></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / New modal */}
      {editing && (
        <TemplateModal
          template={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

// ── PeopleTab ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function printWorkerSheet(worker) {
  const printDate = new Date().toLocaleDateString("en-KE", { day: "numeric", month: "long", year: "numeric" });

  const fmtDate = iso => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
    } catch { return null; }
  };

  const rows = worker.assignments.map(a => {
    // Build the spec pills line — only include fields that have values
    const specs = [
      a.size          ? escapeHtml(a.size)        : null,
      a.wood_type     ? escapeHtml(a.wood_type)   : null,
      a.finish_type   ? escapeHtml(a.finish_type) : null,
      a.finish_color  ? escapeHtml(a.finish_color): null,
    ].filter(Boolean);

    const specLine = specs.length
      ? `<div class="specs">${specs.map(s => `<span class="pill">${s}</span>`).join("")}</div>`
      : "";

    const dueLine = fmtDate(a.due_date)
      ? `<span class="due">Production due: ${fmtDate(a.due_date)}</span>`
      : "";

    return `
    <tr>
      <td class="td-job">
        <strong>${escapeHtml(a.job_name)}</strong>
        <span class="mono">${escapeHtml(a.job_num)}</span>
        ${specLine}
      </td>
      <td>${escapeHtml(a.operation || "—")}</td>
      <td class="qty">${escapeHtml(String(a.qty))}</td>
      <td class="td-order">
        <span class="order-num">${escapeHtml(a.order_num || "—")}</span>
        ${dueLine}
      </td>
      <td class="sign"></td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(worker.name)} – Assignment Sheet</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #111; padding: 32px; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 2px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 28px; }

  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; padding: 8px 10px 8px 0;
    border-bottom: 2px solid #111;
    font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #444;
  }
  td { padding: 13px 10px 13px 0; border-bottom: 1px solid #ddd; vertical-align: top; }

  /* Job cell */
  td.td-job { width: 36%; }
  td.td-job strong { display: block; font-size: 13px; font-weight: 600; margin-bottom: 2px; }
  .mono { display: block; font-family: monospace; font-size: 11px; color: #888; margin-bottom: 5px; }

  /* Spec pills */
  .specs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .pill {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    background: #f0f0f0;
    font-size: 10.5px;
    color: #333;
    font-weight: 500;
    letter-spacing: .01em;
  }

  /* Qty cell */
  td.qty { width: 7%; font-family: monospace; font-size: 15px; font-weight: 700; }

  /* Order cell */
  td.td-order { width: 18%; }
  .order-num { display: block; font-family: monospace; font-size: 12px; font-weight: 600; color: #111; }
  .due { display: block; font-size: 10.5px; color: #e05d00; font-weight: 500; margin-top: 3px; }

  /* Sign-off cell */
  td.sign { width: 14%; border-bottom-color: #000 !important; }

  .footer {
    margin-top: 36px;
    font-size: 10px;
    color: #aaa;
    display: flex;
    justify-content: space-between;
    border-top: 1px solid #eee;
    padding-top: 12px;
  }

  @media print {
    @page { margin: 1.5cm; size: A4; }
    .pill { background: #ebebeb; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .due  { color: #c04000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(worker.name)}</h1>
<div class="sub">${worker.assignments.length} assignment${worker.assignments.length !== 1 ? "s" : ""} · Canvas Guy Production · ${printDate}</div>
<table>
  <thead>
    <tr>
      <th>Job &amp; Specifications</th>
      <th style="width:20%">Operation</th>
      <th>Qty</th>
      <th>Order / Due</th>
      <th>Sign-off</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<div class="footer">
  <span>Canvas Guy Limited – Production Assignment Sheet</span>
  <span>Printed ${printDate}</span>
</div>
</body>
</html>`;

  const w = window.open("", "_blank", "width=860,height=720");
  if (!w) {
    alert("Allow popups for this page to print the assignment sheet.");
    return;
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

function printAllAssignments(workers) {
  if (!workers.length) { alert("No active worker assignments to print."); return; }
  const printDate = new Date().toLocaleDateString("en-KE", { day: "numeric", month: "long", year: "numeric" });
  const fmtD = iso => {
    if (!iso) return null;
    try { return new Date(iso).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }); }
    catch { return null; }
  };

  const sections = workers.map(worker => {
    const rows = worker.assignments.map(a => {
      const specs = [a.size, a.wood_type, a.finish_type, a.finish_color].filter(Boolean).map(s => escapeHtml(s));
      const specLine = specs.length
        ? `<div class="specs">${specs.map(s => `<span class="pill">${s}</span>`).join("")}</div>`
        : "";
      const dueLine = fmtD(a.due_date)
        ? `<span class="due">Production due: ${fmtD(a.due_date)}</span>`
        : "";
      return `<tr>
        <td class="td-job"><strong>${escapeHtml(a.job_name)}</strong><span class="mono">${escapeHtml(a.job_num)}</span>${specLine}</td>
        <td>${escapeHtml(a.operation || "—")}</td>
        <td class="qty">${escapeHtml(String(a.qty))}</td>
        <td class="td-order"><span class="order-num">${escapeHtml(a.order_num || "—")}</span>${dueLine}</td>
        <td class="sign"></td>
      </tr>`;
    }).join("");
    return `<div class="worker-block">
      <h2>${escapeHtml(worker.name)}</h2>
      <div class="sub">${worker.assignments.length} assignment${worker.assignments.length !== 1 ? "s" : ""} · Canvas Guy Production · ${printDate}</div>
      <table>
        <thead><tr>
          <th>Job &amp; Specifications</th><th style="width:20%">Operation</th>
          <th>Qty</th><th>Order / Due</th><th>Sign-off</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Canvas Guy – All Assignment Sheets</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#111;padding:32px}
    .worker-block{page-break-after:always;padding-bottom:32px}
    .worker-block:last-child{page-break-after:auto}
    h2{font-size:20px;font-weight:600;margin-bottom:2px}
    .sub{color:#666;font-size:12px;margin-bottom:24px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:8px 10px 8px 0;border-bottom:2px solid #111;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#444}
    td{padding:12px 10px 12px 0;border-bottom:1px solid #ddd;vertical-align:top}
    td.td-job{width:36%}
    td.td-job strong{display:block;font-size:13px;font-weight:600;margin-bottom:2px}
    .mono{display:block;font-family:monospace;font-size:11px;color:#888;margin-bottom:4px}
    .specs{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
    .pill{display:inline-block;padding:2px 7px;border-radius:4px;background:#f0f0f0;font-size:10.5px;color:#333;font-weight:500}
    td.qty{width:7%;font-family:monospace;font-size:15px;font-weight:700}
    td.td-order{width:18%}
    .order-num{display:block;font-family:monospace;font-size:12px;font-weight:600;color:#111}
    .due{display:block;font-size:10.5px;color:#e05d00;font-weight:500;margin-top:3px}
    td.sign{width:14%;border-bottom-color:#000!important}
    @media print{
      @page{margin:1.5cm;size:A4}
      .pill{background:#ebebeb;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .due{color:#c04000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    }
  </style></head><body>${sections}</body></html>`;

  const w = window.open("", "_blank", "width=860,height=720");
  if (!w) { alert("Allow popups for this page to print the assignment sheets."); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

// ── JobItemRow — one job row inside the expanded OrderCard ────────────────────
function JobItemRow({ job, onOpenJob, canRecord, canEdit, onRecordProgress, onAssignWorkers }) {
  const op          = currentOp(job);
  const assignments = job.production_job_assignments || [];
  const seen        = new Set();
  const workers     = assignments.reduce((acc, a) => {
    if (a.employees?.id && !seen.has(a.employees.id)) {
      seen.add(a.employees.id);
      acc.push(a.employees);
    }
    return acc;
  }, []);
  const spec = [job.size, job.wood_type, job.finish_type, job.finish_color].filter(Boolean).join(" · ");

  return (
    <tr style={{ borderBottom: T.border }}>
      {/* Item name + spec */}
      <td style={{ padding: "12px 12px 12px 16px", verticalAlign: "top" }}>
        <button
          onClick={onOpenJob}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, color: C.ink }}>
            {job.description || job.category || "Untitled"}
          </div>
        </button>
        {spec && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{spec}</div>
        )}
      </td>

      {/* Quantity */}
      <td style={{ padding: "12px", verticalAlign: "top", whiteSpace: "nowrap" }}>
        <Mono style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{job.planned_quantity}</Mono>
        <span style={{ fontSize: 11, color: C.muted }}> units</span>
      </td>

      {/* Current operation */}
      <td style={{ padding: "12px", verticalAlign: "top", whiteSpace: "nowrap" }}>
        <span style={{ color: C.ink, fontWeight: 500 }}>{op.label}</span>
        <span style={{ color: C.muted, fontSize: 12 }}> · {op.done}/{op.total}</span>
      </td>

      {/* Assigned workers — avatar initials circles */}
      <td style={{ padding: "12px", verticalAlign: "top" }}>
        {workers.length === 0 ? (
          <span style={{ fontSize: 12, color: C.muted, opacity: 0.5 }}>Unassigned</span>
        ) : (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {workers.map(w => (
              <div
                key={w.id}
                title={w.name}
                style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: C.bg, border: T.border,
                  display: "grid", placeItems: "center",
                  fontSize: 11, fontWeight: 600, color: C.ink,
                  flexShrink: 0,
                }}
              >
                {initials(w.name)}
              </div>
            ))}
          </div>
        )}
      </td>

      {/* Exception / blocker */}
      <td style={{ padding: "12px", verticalAlign: "top", fontSize: 12, color: job.blocker_reason ? C.amber : C.muted, opacity: job.blocker_reason ? 1 : 0.45 }}>
        {job.blocker_reason
          ? <span title={job.blocker_reason}>{job.blocker_reason.length > 28 ? job.blocker_reason.slice(0, 28) + "…" : job.blocker_reason}</span>
          : "—"}
      </td>

      {/* Actions */}
      <td style={{ padding: "10px 12px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {canRecord && (
            <Btn small onClick={() => onRecordProgress(job)} title="Record progress for this job">
              Progress
            </Btn>
          )}
          {canEdit && (
            <Btn small onClick={() => onAssignWorkers(job)} title="Assign workers to this job">
              Assign
            </Btn>
          )}
          {!canRecord && !canEdit && (
            <button
              onClick={onOpenJob}
              style={{ fontSize: 11, color: C.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
            >
              View →
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── OrderCard — expandable order row with job item table ─────────────────────
function OrderCard({ group, expanded, onToggle, canEdit, canRecord, onRecordProgress, onAssignWorkers, router }) {
  const { order_num, client, jobs, productionDue, customerDue } = group;
  const [hover, setHover] = useState(false);

  const totalPlanned  = jobs.reduce((s, j) => s + (j.planned_quantity || 0), 0);
  const totalAccepted = jobs.reduce((s, j) => s + (j.accepted_qty     || 0), 0);
  const pct           = totalPlanned > 0 ? Math.round((totalAccepted / totalPlanned) * 100) : 0;
  const status        = orderStatusLabel(jobs);
  const statusColor   = ORDER_STATUS_COLOR[status] || C.muted;
  const late          = daysLate(productionDue);

  return (
    <div style={{
      background: C.card,
      border:     T.border,
      borderLeft: `3px solid ${statusColor}`,
      borderRadius: T.radius,
      overflow: "hidden",
    }}>
      {/* Header — always visible, click to expand */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          padding: "14px 16px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          userSelect: "none",
          background: hover ? C.bg : "transparent",
          transition: "background 0.15s",
        }}
      >
        {/* Order identity */}
        <div style={{ flex: "1 1 180px", minWidth: 160 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: C.ink, marginBottom: 3 }}>
            {order_num} · {client}
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>
            {jobs.length} item group{jobs.length !== 1 ? "s" : ""} · {totalPlanned} units
          </div>
        </div>

        {/* Progress */}
        <div style={{ minWidth: 150 }}>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 5 }}>Overall progress</div>
          <div style={{ height: 6, background: C.bg, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: C.green, borderRadius: 3, transition: "width 0.3s" }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{totalAccepted} / {totalPlanned}</div>
        </div>

        {/* Status dot + label */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 130 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: statusColor }}>{status}</span>
        </div>

        {/* Production due date */}
        <div style={{ minWidth: 100, textAlign: "right" }}>
          <div style={{ fontSize: 11, color: C.muted }}>Production due</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: late ? C.red : C.ink }}>
            {productionDue ? fmtShortDate(productionDue) : "—"}
          </div>
          {customerDue && <div style={{ fontSize: 11, color: C.muted }}>Customer {fmtShortDate(customerDue)}</div>}
        </div>

        {/* Expand chevron */}
        <div style={{
          fontSize: 13, color: C.muted, flexShrink: 0,
          transform: expanded ? "rotate(180deg)" : "none",
          transition: "transform 0.2s",
        }}>▾</div>
      </div>

      {/* Expanded job items table */}
      {expanded && (
        <div style={{ borderTop: T.border, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760 }}>
            <thead>
              <tr style={{ background: C.bg }}>
                {["SPECIFIC ITEM", "QUANTITY", "CURRENT OPERATION", "ASSIGNED WORKERS", "EXCEPTION", "ACTIONS"].map(h => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: h === "SPECIFIC ITEM" ? "8px 12px 8px 16px" : "8px 12px",
                      fontSize: 10, fontWeight: 700, color: C.muted,
                      letterSpacing: "0.06em", whiteSpace: "nowrap",
                      borderBottom: T.border,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => (
                <JobItemRow
                  key={job.id}
                  job={job}
                  canEdit={canEdit}
                  canRecord={canRecord}
                  onRecordProgress={onRecordProgress}
                  onAssignWorkers={onAssignWorkers}
                  onOpenJob={() => router.push(`/production/jobs/${job.id}`)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── OrdersInProgressTab ───────────────────────────────────────────────────────
function OrdersInProgressTab({ onOpenWizard, canEdit, canRecord }) {
  const router = useRouter();
  const [jobs,    setJobs]    = useState([]);
  const [loaded,  setLoaded]  = useState(false);
  const [error,   setError]   = useState(null);
  const [search,  setSearch]  = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [expandedOrders, setExpandedOrders] = useState(new Set());
  const [progressJob, setProgressJob] = useState(null);
  const [assignJob,   setAssignJob]   = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/production/jobs?status=all_active");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { jobs: j = [] } = await r.json();
      setJobs(j);
      // Auto-expand first order
      const firstKey = j[0]?.production_plans?.orders?.id || j[0]?.production_plans?.orders?.order_num;
      if (firstKey) setExpandedOrders(new Set([firstKey]));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleOrder = (key) =>
    setExpandedOrders(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Group jobs by order, compute production due date (latest planned_finish across jobs)
  const orderGroups = useMemo(() => {
    const map = {};
    for (const job of jobs) {
      const order = job.production_plans?.orders;
      if (!order) continue;
      const key = order.id || order.order_num;
      if (!map[key]) {
        map[key] = { key, order_num: order.order_num, client: order.client, jobs: [], productionDue: null, customerDue: null };
      }
      map[key].jobs.push(job);
      // Order-level production due = latest job production due (falls back to the
      // job's planned finish). The customer's delivery date is kept separate and
      // is never shown as a production date.
      const pd = job.production_due_date || job.planned_finish;
      if (pd && (!map[key].productionDue || pd > map[key].productionDue)) {
        map[key].productionDue = pd;
      }
      map[key].customerDue = order.due_date || null;
    }
    return Object.values(map).sort((a, b) => {
      if (!a.productionDue && !b.productionDue) return 0;
      if (!a.productionDue) return 1;
      if (!b.productionDue) return -1;
      return a.productionDue.localeCompare(b.productionDue);
    });
  }, [jobs]);

  // Filtered list
  const filtered = useMemo(() => {
    return orderGroups.filter(og => {
      if (search) {
        const q = search.toLowerCase();
        if (!(og.order_num || "").toLowerCase().includes(q) &&
            !(og.client    || "").toLowerCase().includes(q) &&
            !og.jobs.some(j => (j.description || j.category || "").toLowerCase().includes(q))) {
          return false;
        }
      }
      if (stateFilter) {
        const label = orderStatusLabel(og.jobs);
        if (label !== stateFilter) return false;
      }
      return true;
    });
  }, [orderGroups, search, stateFilter]);

  // Inline KPI stats
  const kpi = useMemo(() => {
    const orderSet = new Set(
      jobs.map(j => j.production_plans?.orders?.id || j.production_plans?.orders?.order_num).filter(Boolean)
    );
    return {
      activeOrders: orderSet.size,
      unitsMoving:  jobs.reduce((s, j) => s + (j.in_production_qty || 0), 0),
      awaitingQC:   jobs.reduce((s, j) => s + (j.awaiting_qc_qty   || 0), 0),
      blocked:      jobs.filter(j => j.blocker_reason).length,
    };
  }, [jobs]);

  if (!loaded) return <Loading />;

  if (error) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center" }}>
        <div style={{ color: C.red, fontWeight: 500, marginBottom: 8 }}>Could not load orders</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>{error}</div>
        <Btn onClick={load}>Retry</Btn>
      </div>
    );
  }

  return (
    <>
      {/* Inline stats bar */}
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
        <span><span style={{ color: C.ink, fontWeight: 600 }}>{kpi.activeOrders}</span> active orders</span>
        <span style={{ padding: "0 6px" }}>·</span>
        <span><span style={{ color: C.blue, fontWeight: 600 }}>{kpi.unitsMoving}</span> units moving</span>
        <span style={{ padding: "0 6px" }}>·</span>
        <span><span style={{ color: C.purple, fontWeight: 600 }}>{kpi.awaitingQC}</span> awaiting QC</span>
        <span style={{ padding: "0 6px" }}>·</span>
        <span style={{ color: kpi.blocked > 0 ? C.red : C.muted }}>
          <span style={{ fontWeight: kpi.blocked > 0 ? 700 : 400 }}>{kpi.blocked}</span> blocked
        </span>
      </div>

      {/* Toolbar: search + state filter */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search order, customer or item…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 200, maxWidth: 420 }}
        />
        <select
          value={stateFilter}
          onChange={e => setStateFilter(e.target.value)}
          style={{ ...inputStyle, width: "auto", minWidth: 195 }}
        >
          <option value="">All production states</option>
          <option value="In production">In production</option>
          <option value="Blocked">Blocked</option>
          <option value="Materials hold">Materials hold</option>
          <option value="Awaiting QC">Awaiting QC</option>
          <option value="Paused">Paused</option>
        </select>
      </div>

      {/* Order cards */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: C.ink, marginBottom: 6 }}>
            {search || stateFilter ? "No orders match your filters." : "No active orders in production."}
          </div>
          {!search && !stateFilter && (
            <>
              <div style={{ fontSize: 13, marginBottom: 16 }}>Create a production plan from an active order to get started.</div>
              {canEdit && <Btn primary onClick={onOpenWizard}>+ New production plan</Btn>}
            </>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map(og => (
            <OrderCard
              key={og.key}
              group={og}
              expanded={expandedOrders.has(og.key)}
              onToggle={() => toggleOrder(og.key)}
              canEdit={canEdit}
              canRecord={canRecord}
              onRecordProgress={j => setProgressJob(j)}
              onAssignWorkers={j => setAssignJob(j)}
              router={router}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {progressJob && (
        <RecordProgressModal
          job={progressJob}
          canQC={canEdit}
          onClose={() => setProgressJob(null)}
          onDone={updatedJob => {
            setProgressJob(null);
            setJobs(prev => prev.map(j => j.id === updatedJob.id ? { ...j, ...updatedJob } : j));
          }}
        />
      )}
      {assignJob && (
        <AssignWorkersModal
          job={assignJob}
          onClose={() => setAssignJob(null)}
          onDone={() => { setAssignJob(null); load(); }}
        />
      )}
    </>
  );
}

// ── TodaysWorkTab — worker-focused daily allocation view ─────────────────────
//   Distinct from PeopleTab: optimised for handing out and printing daily work
//   sheets. Shows spec detail + production due prominently per assignment.
// ── StagePipeline ─────────────────────────────────────────────────────────────
// Stage keys, labels and sort order come from create_job_stages() in
// production_v1e_stages.sql. Status values come from the CHECK constraint on
// production_job_stages.status: not_started | active | completed | skipped.
// The API returns the stage state in `status` (see api/production/jobs/route.js).

const STAGE_DEFS = [
  { key: "materials", abbr: "Mat",  label: "Materials Preparation"    },
  { key: "assembly",  abbr: "Asm",  label: "Cutting / Joining / Assembly" },
  { key: "sanding",   abbr: "Snd",  label: "Sanding"                  },
  { key: "finishing", abbr: "Fin",  label: "Finishing / Painting"     },
  { key: "packaging", abbr: "Pkg",  label: "Packaging"                },
];

const STAGE_STATUS_COLOR = {
  completed:   C.green,
  active:      C.blue,
  not_started: C.muted,
  skipped:     C.faint,
};

const STAGE_STATUS_LABEL = {
  completed:   "completed",
  active:      "in progress",
  not_started: "not started",
  skipped:     "skipped",
};

function StagePipeline({ stages }) {
  // Index the job's stage rows by stage_key
  const map = {};
  for (const s of (stages || [])) if (s.stage_key) map[s.stage_key] = s;

  // Before the v1e migration runs, jobs have no stage rows at all.
  if (Object.keys(map).length === 0) {
    return <span style={{ fontSize: 11, color: C.faint }}>No stages</span>;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
      {STAGE_DEFS.map((def, i) => {
        const s       = map[def.key];
        const enabled = s?.is_enabled !== false && !!s;
        const st      = s?.status || "not_started";
        const color   = enabled ? (STAGE_STATUS_COLOR[st] || C.muted) : C.line;
        const done    = st === "completed";
        const tip     = s
          ? `${def.label}: ${STAGE_STATUS_LABEL[st] || st}` +
            (s.completed_quantity != null && s.planned_quantity != null
              ? ` (${s.completed_quantity}/${s.planned_quantity})`
              : "")
          : `${def.label}: not applicable`;
        return (
          <span key={def.key} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span title={tip} style={{
              fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 10,
              background: enabled && st !== "not_started" ? `${color}22` : C.bg,
              color:      enabled ? color : C.faint,
              border: `1px solid ${enabled && st !== "not_started" ? color : C.line}`,
              whiteSpace: "nowrap",
              textDecoration: st === "skipped" ? "line-through" : "none",
            }}>
              {done ? "✓ " : ""}{def.abbr}
            </span>
            {i < STAGE_DEFS.length - 1 && (
              <span style={{ color: C.line, fontSize: 9 }}>›</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function TodaysWorkTab() {
  const router = useRouter();
  const [jobs,      setJobs]      = useState([]);
  const [loaded,    setLoaded]    = useState(false);
  const [error,     setError]     = useState(null);
  const [search,    setSearch]    = useState("");
  const [view,      setView]      = useState("worker"); // "worker" | "order"
  const [expanded,  setExpanded]  = useState(new Set());
  const [printing,  setPrinting]  = useState(null);

  useEffect(() => {
    fetch("/api/production/jobs?status=all_active")
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { setJobs(data?.jobs || []); setLoaded(true); })
      .catch(err => { setError(err.message); setLoaded(true); });
  }, []);

  // ── By Worker data ──────────────────────────────────────────────────────────
  const workers = useMemo(() => {
    const map = {};
    for (const job of jobs) {
      for (const a of (job.production_job_assignments || [])) {
        if (!a.employees?.id) continue;
        const wid = a.employees.id;
        if (!map[wid]) map[wid] = { id: wid, name: a.employees.name, jobsByOrder: {} };
        const orderKey  = job.production_plans?.orders?.order_num || "—";
        const orderClient = job.production_plans?.orders?.client || "";
        if (!map[wid].jobsByOrder[orderKey]) {
          map[wid].jobsByOrder[orderKey] = { order_num: orderKey, client: orderClient, jobs: [] };
        }
        map[wid].jobsByOrder[orderKey].jobs.push({
          id:           job.id,
          job_num:      job.job_num,
          job_name:     job.description || job.category || "Untitled",
          operation:    a.production_operations?.name,
          qty:          a.assigned_quantity,
          due_date:     job.production_due_date || job.planned_finish,
          size:         job.size,
          finish_type:  job.finish_type,
          finish_color: job.finish_color,
          wood_type:    job.wood_type,
          status:       job.status,
          stages:       job.production_job_stages || [],
        });
      }
    }
    return Object.values(map)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(w => ({ ...w, ordersArr: Object.values(w.jobsByOrder) }));
  }, [jobs]);

  // ── By Order data ───────────────────────────────────────────────────────────
  const orders = useMemo(() => {
    const map = {};
    for (const job of jobs) {
      const o = job.production_plans?.orders;
      if (!o) continue;
      const key = o.order_num;
      if (!map[key]) map[key] = { order_num: o.order_num, client: o.client || "—", jobs: [] };
      map[key].jobs.push({
        ...job,
        workers: (job.production_job_assignments || [])
          .map(a => a.employees?.name).filter(Boolean),
      });
    }
    return Object.values(map).sort((a, b) => a.order_num.localeCompare(b.order_num));
  }, [jobs]);

  // ── Filter ──────────────────────────────────────────────────────────────────
  const filteredWorkers = useMemo(() => {
    if (!search.trim()) return workers;
    const q = search.toLowerCase();
    return workers.filter(w => w.name.toLowerCase().includes(q));
  }, [workers, search]);

  const filteredOrders = useMemo(() => {
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    return orders.filter(o =>
      o.order_num.toLowerCase().includes(q) || o.client.toLowerCase().includes(q)
    );
  }, [orders, search]);

  const toggle = (id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ── Print ───────────────────────────────────────────────────────────────────
  const handlePrint = (worker) => {
    setPrinting(worker.id);
    // Build flat assignments list for existing printWorkerSheet
    const assignments = worker.ordersArr.flatMap(og =>
      og.jobs.map(j => ({
        job_num:      j.job_num,
        job_name:     j.job_name,
        operation:    j.operation,
        qty:          j.qty,
        order_num:    og.order_num,
        due_date:     j.due_date,
        size:         j.size,
        finish_type:  j.finish_type,
        finish_color: j.finish_color,
        wood_type:    j.wood_type,
      }))
    );
    try { printWorkerSheet({ ...worker, assignments }); } finally { setPrinting(null); }
  };

  const handlePrintAll = () => {
    setPrinting("all");
    const list = filteredWorkers.map(w => {
      const assignments = w.ordersArr.flatMap(og =>
        og.jobs.map(j => ({
          job_num: j.job_num, job_name: j.job_name, operation: j.operation,
          qty: j.qty, order_num: og.order_num, due_date: j.due_date,
          size: j.size, finish_type: j.finish_type, finish_color: j.finish_color, wood_type: j.wood_type,
        }))
      );
      return { ...w, assignments };
    });
    try { printAllAssignments(list); } finally { setPrinting(null); }
  };

  const fmtDue = iso => {
    if (!iso) return null;
    try { return new Date(iso).toLocaleDateString("en-KE", { day: "numeric", month: "short" }); }
    catch { return null; }
  };

  if (!loaded) return <Loading />;

  if (error) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center" }}>
        <div style={{ color: C.red, fontWeight: 500, marginBottom: 8 }}>Could not load assignments</div>
        <div style={{ fontSize: 12, color: C.muted }}>{error}</div>
      </div>
    );
  }

  if (workers.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: C.ink, marginBottom: 6 }}>No workers assigned yet</div>
        <div style={{ fontSize: 13 }}>Assign workers to active production jobs and they'll appear here.</div>
      </div>
    );
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────────
  const toolbar = (
    <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
      {/* View toggle */}
      <div style={{ display: "flex", border: T.border, borderRadius: T.radius, overflow: "hidden" }}>
        {[
          { key: "worker", label: "By Worker" },
          { key: "order",  label: "By Order"  },
        ].map(v => (
          <button key={v.key} onClick={() => setView(v.key)} style={{
            padding: "6px 14px", fontSize: 12, fontWeight: view === v.key ? 600 : 400,
            background: view === v.key ? C.coral : "transparent",
            color:      view === v.key ? "#fff" : C.muted,
            border: 0, cursor: "pointer", fontFamily: "inherit",
          }}>{v.label}</button>
        ))}
      </div>

      <input type="text" placeholder={view === "worker" ? "Filter by worker…" : "Filter by order…"}
        value={search} onChange={e => setSearch(e.target.value)}
        style={{ ...inputStyle, flex: 1, minWidth: 160, maxWidth: 280 }} />

      <div style={{ fontSize: 13, color: C.muted, flex: 1 }}>
        {view === "worker"
          ? `${filteredWorkers.length} worker${filteredWorkers.length !== 1 ? "s" : ""}`
          : `${filteredOrders.length} order${filteredOrders.length !== 1 ? "s" : ""}`}
      </div>

      {view === "worker" && filteredWorkers.length > 1 && (
        <Btn onClick={handlePrintAll} disabled={printing === "all"}>
          {printing === "all" ? "Opening…" : "Print all sheets"}
        </Btn>
      )}
    </div>
  );

  // ── BY WORKER view ──────────────────────────────────────────────────────────
  if (view === "worker") {
    return (
      <>
        {toolbar}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredWorkers.map(w => {
            const isOpen  = expanded.has(w.id);
            const totalJobs  = w.ordersArr.reduce((s, og) => s + og.jobs.length, 0);
            const totalUnits = w.ordersArr.flatMap(og => og.jobs).reduce((s, j) => s + (j.qty || 0), 0);
            return (
              <div key={w.id} style={{ background: C.card, border: T.border, borderRadius: T.radius, overflow: "hidden" }}>
                {/* Worker header — click to expand */}
                <div
                  role="button" tabIndex={0}
                  onClick={() => toggle(w.id)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(w.id); } }}
                  style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", userSelect: "none" }}
                >
                  <div style={{ width: 40, height: 40, borderRadius: "50%", display: "grid", placeItems: "center", background: C.bg, fontSize: 14, fontWeight: 700, color: C.ink, flexShrink: 0 }}>
                    {initials(w.name)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{w.name}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      {totalJobs} job{totalJobs !== 1 ? "s" : ""} · {totalUnits} unit{totalUnits !== 1 ? "s" : ""} · {w.ordersArr.length} order{w.ordersArr.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                  <Btn small onClick={e => { e.stopPropagation(); handlePrint(w); }} disabled={printing === w.id}>
                    {printing === w.id ? "…" : "Print"}
                  </Btn>
                  <span style={{ color: C.muted, fontSize: 13, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
                </div>

                {/* Expanded: jobs grouped by order */}
                {isOpen && (
                  <div style={{ borderTop: T.border }}>
                    {w.ordersArr.map(og => (
                      <div key={og.order_num}>
                        {/* Order group header */}
                        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", background: C.bg, borderBottom: T.border }}>
                          <Mono style={{ fontSize: 12, fontWeight: 700, color: C.coral }}>{og.order_num}</Mono>
                          <span style={{ fontSize: 12, color: C.muted }}>{og.client}</span>
                          <span style={{ fontSize: 11, color: C.faint }}>· {og.jobs.length} job{og.jobs.length !== 1 ? "s" : ""}</span>
                        </div>
                        {/* Job rows */}
                        {og.jobs.map((j, i) => {
                          const specParts = [j.size, j.wood_type, j.finish_type, j.finish_color].filter(Boolean);
                          const due = fmtDue(j.due_date);
                          return (
                            <div key={j.job_num} style={{ padding: "12px 16px", borderBottom: i < og.jobs.length - 1 ? T.border : "none", display: "flex", alignItems: "flex-start", gap: 14 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                                  <span style={{ fontSize: 13, fontWeight: 500, color: C.ink }}>{j.job_name}</span>
                                  <Mono style={{ fontSize: 11, color: C.faint }}>{j.job_num}</Mono>
                                </div>
                                {specParts.length > 0 && (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                                    {specParts.map(s => (
                                      <span key={s} style={{ fontSize: 10, fontWeight: 500, padding: "2px 6px", background: C.bg, border: T.border, borderRadius: 4, color: C.ink }}>{s}</span>
                                    ))}
                                  </div>
                                )}
                                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                                  <StagePipeline stages={j.stages} />
                                  {j.operation && (
                                    <span style={{ fontSize: 11, color: C.muted }}>
                                      Task: <strong style={{ color: C.ink }}>{j.operation}</strong>
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div style={{ textAlign: "right", flexShrink: 0 }}>
                                <Mono style={{ fontSize: 17, fontWeight: 700, color: C.ink, display: "block" }}>{j.qty}</Mono>
                                <div style={{ fontSize: 10, color: C.muted }}>units</div>
                                {due && <div style={{ fontSize: 11, fontWeight: 600, color: daysLate(j.due_date) ? C.red : C.muted, marginTop: 2 }}>Due {due}</div>}
                                <button onClick={() => router.push(`/production/jobs/${j.id}`)}
                                  style={{ fontSize: 11, color: C.blue, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", marginTop: 3, padding: 0 }}>
                                  View job →
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  // ── BY ORDER view ───────────────────────────────────────────────────────────
  return (
    <>
      {toolbar}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filteredOrders.map(og => {
          const isOpen = expanded.has(og.order_num);
          const totalPlanned  = og.jobs.reduce((s, j) => s + (j.planned_quantity || 0), 0);
          const totalAccepted = og.jobs.reduce((s, j) => s + (j.accepted_qty     || 0), 0);
          const pct = totalPlanned > 0 ? Math.round((totalAccepted / totalPlanned) * 100) : 0;

          return (
            <div key={og.order_num} style={{ background: C.card, border: T.border, borderRadius: T.radius, overflow: "hidden" }}>
              {/* Order header */}
              <div
                role="button" tabIndex={0}
                onClick={() => toggle(og.order_num)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(og.order_num); } }}
                style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", userSelect: "none", flexWrap: "wrap" }}
              >
                <div style={{ flex: "1 1 200px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <Mono style={{ fontSize: 14, fontWeight: 700, color: C.coral }}>{og.order_num}</Mono>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{og.client}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    {og.jobs.length} job{og.jobs.length !== 1 ? "s" : ""} · {totalPlanned} units planned
                  </div>
                </div>
                {/* Progress bar */}
                <div style={{ minWidth: 140 }}>
                  <div style={{ height: 6, background: C.bg, borderRadius: 3, overflow: "hidden", marginBottom: 3 }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: C.green, borderRadius: 3, transition: "width 0.3s" }} />
                  </div>
                  <div style={{ fontSize: 11, color: C.muted }}>{totalAccepted} / {totalPlanned} · {pct}% complete</div>
                </div>
                <span style={{ color: C.muted, fontSize: 13, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
              </div>

              {/* Expanded job rows with stage pipeline */}
              {isOpen && (
                <div style={{ borderTop: T.border }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: C.bg }}>
                        {["Item", "Stages", "Workers", "Qty", "Status", ""].map(h => (
                          <th key={h} style={{ textAlign: "left", padding: "7px 12px 7px 16px", fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: "0.06em", borderBottom: T.border }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {og.jobs.map((job, i) => {
                        const spec = [job.size, job.finish_color || job.finish_type, job.wood_type].filter(Boolean).join(" · ");
                        return (
                          <tr key={job.id} style={{ borderBottom: i < og.jobs.length - 1 ? T.border : "none" }}>
                            <td style={{ padding: "11px 12px 11px 16px", verticalAlign: "top", width: "25%" }}>
                              <div style={{ fontWeight: 500, color: C.ink }}>{job.description || job.category || "Untitled"}</div>
                              {spec && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{spec}</div>}
                              <Mono style={{ fontSize: 11, color: C.faint }}>{job.job_num}</Mono>
                            </td>
                            <td style={{ padding: "11px 12px", verticalAlign: "middle" }}>
                              <StagePipeline stages={job.production_job_stages || []} />
                            </td>
                            <td style={{ padding: "11px 12px", verticalAlign: "top", fontSize: 12 }}>
                              {job.workers?.length
                                ? <span style={{ color: C.green }}>{job.workers.join(", ")}</span>
                                : <span style={{ color: C.faint }}>Unassigned</span>}
                            </td>
                            <td style={{ padding: "11px 12px", verticalAlign: "top" }}>
                              <Mono style={{ fontSize: 13, fontWeight: 700 }}>{job.planned_quantity}</Mono>
                            </td>
                            <td style={{ padding: "11px 12px", verticalAlign: "top" }}>
                              <Badge color={JOB_STATUS_BADGE[job.status] || "gray"}>{job.status}</Badge>
                            </td>
                            <td style={{ padding: "11px 16px 11px 8px", textAlign: "right" }}>
                              <Btn small onClick={() => router.push(`/production/jobs/${job.id}`)}>Open ↗</Btn>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function PeopleTab() {
  const [jobs,   setJobs]   = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/production/jobs?status=all_active")
      .then(r => r.ok ? r.json() : null)
      .then(data => { setJobs(data?.jobs || []); setLoaded(true); });
  }, []);

  if (!loaded) return <Loading />;

  // Build worker map from assignments across all jobs
  const workerMap = {};
  for (const job of jobs) {
    for (const a of (job.production_job_assignments || [])) {
      if (!a.employees?.id) continue;
      const wid = a.employees.id;
      if (!workerMap[wid]) {
        workerMap[wid] = { id: wid, name: a.employees.name, assignments: [] };
      }
      workerMap[wid].assignments.push({
        job_num:       job.job_num,
        job_name:      job.description || job.category || "Untitled",
        operation:     a.production_operations?.name,
        qty:           a.assigned_quantity,
        order_num:     job.production_plans?.orders?.order_num,
        due_date:      job.production_due_date || job.planned_finish,   // ISO date string or null
        size:          job.size,
        finish_type:   job.finish_type,
        finish_color:  job.finish_color,
        wood_type:     job.wood_type,
      });
    }
  }
  const workers = Object.values(workerMap).sort((a, b) => a.name.localeCompare(b.name));

  if (workers.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: C.ink, marginBottom: 6 }}>No workers assigned</div>
        <div style={{ fontSize: 13 }}>Assign workers to production jobs to see them here.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
      {workers.map(w => (
        <div key={w.id} style={{ background: C.card, border: T.border, borderRadius: T.radius, padding: "16px" }}>
          {/* Worker header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", display: "grid", placeItems: "center", background: C.bg, fontSize: 14, fontWeight: 500, color: C.ink, flexShrink: 0 }}>
              {initials(w.name)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 500, color: C.ink }}>{w.name}</div>
              <div style={{ fontSize: 12, color: C.muted }}>
                {w.assignments.length} active assignment{w.assignments.length !== 1 ? "s" : ""}
              </div>
            </div>
            <Btn small onClick={() => printWorkerSheet(w)} title="Print assignment sheet">Print</Btn>
          </div>

          {/* Assignments */}
          {w.assignments.map((a, i) => (
            <div key={i} style={{ marginTop: i === 0 ? 14 : 0, paddingTop: 12, borderTop: T.border }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: C.ink }}>{a.job_name}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                <Mono>{a.job_num}</Mono>
                {a.order_num && <> · {a.order_num}</>}
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                {a.operation} · <Mono>{a.qty}</Mono> units
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── NewPlanWizard ─────────────────────────────────────────────────────────────

function NewPlanWizard({ onClose, onCreated }) {
  const [step,     setStep]     = useState(0);
  const [orders,   setOrders]   = useState([]);
  const [orderId,  setOrderId]  = useState("");
  const [search,   setSearch]   = useState("");
  const [notes,    setNotes]    = useState("");
  const [saving,   setSaving]   = useState(false);
  const [err,      setErr]      = useState(null);
  const [loadingOrds, setLoadingOrds] = useState(true);

  useEffect(() => {
    fetch("/api/orders").then(r => r.ok ? r.json() : null).then(data => {
      const eligible = (data?.data || []).filter(
        o => o.suspended_at === null && PLAN_ELIGIBLE_STATUSES.includes(o.status)
      );
      setOrders(eligible);
      setLoadingOrds(false);
    });
  }, []);

  const selectedOrder = orders.find(o => o.id === orderId);

  const handleCreate = async () => {
    if (!orderId) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/production/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: orderId, notes: notes || undefined }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || "Failed to create plan"); setSaving(false); return; }
      onCreated(data.plan);
    } catch {
      setErr("Network error"); setSaving(false);
    }
  };

  return (
    <div style={{ background: C.card, border: T.border, borderRadius: T.radius, padding: "24px", marginBottom: 24 }}>
      {/* Step indicators */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${WIZARD_STEPS.length}, 1fr)`, gap: 5, marginBottom: 24 }}>
        {WIZARD_STEPS.map((label, i) => (
          <div key={i} style={{ textAlign: "center", fontSize: 12, color: i === step ? C.coral : i < step ? C.green : C.faint }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%", margin: "0 auto 4px",
              background: i === step ? C.coral : i < step ? C.green : C.bg,
              border: `2px solid ${i === step ? C.coral : i < step ? C.green : C.line}`,
              display: "grid", placeItems: "center",
              fontSize: 12, fontWeight: 700, color: i <= step ? "#fff" : C.muted,
            }}>
              {i < step ? "✓" : i + 1}
            </div>
            {label}
          </div>
        ))}
      </div>

      {err && (
        <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius, marginBottom: 16 }}>
          {err}
        </div>
      )}

      {/* Step 0: Choose order */}
      {step === 0 && (
        <div>
          <div style={{ fontSize: 16, fontWeight: 500, color: C.ink, marginBottom: 10 }}>Choose an order</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
            Showing confirmed orders at Deposit Paid, Material Check, Production, and Quality Control stages.
          </div>
          {/* Search input */}
          <input
            type="text"
            placeholder="Search by client or order number…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...inputStyle, marginBottom: 10 }}
          />
          {loadingOrds ? <Loading /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflowY: "auto" }}>
              {(() => {
                const q = search.trim().toLowerCase();
                const visible = q
                  ? orders.filter(o =>
                      (o.client || "").toLowerCase().includes(q) ||
                      (o.order_num || "").toLowerCase().includes(q))
                  : orders;
                if (visible.length === 0) return (
                  <div style={{ fontSize: 13, color: C.muted, padding: "20px 0" }}>
                    {search ? "No orders match your search." : "No eligible orders found. Orders must be at Deposit Paid, Material Check, Production, or Quality Control stage."}
                  </div>
                );
                return visible.map(o => (
                  <button
                    key={o.id}
                    onClick={() => setOrderId(o.id)}
                    style={{
                      width: "100%", textAlign: "left", background: orderId === o.id ? C.coralBg : C.bg,
                      border: `1.5px solid ${orderId === o.id ? C.coral : C.line}`,
                      borderRadius: T.radius, padding: "12px 14px", cursor: "pointer",
                      transition: "border-color 0.15s", flexShrink: 0,
                    }}
                  >
                    <div style={{ fontWeight: 500, fontSize: 13, color: C.ink, marginBottom: 2 }}>{o.client}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      <Mono>{o.order_num}</Mono>
                      <span style={{ marginLeft: 8, padding: "1px 6px", borderRadius: 99, background: C.bg, border: T.border, fontSize: 11 }}>{o.status}</span>
                      {o.due_date && <> · Due {fmtShortDate(o.due_date)}</>}
                    </div>
                  </button>
                ));
              })()}
            </div>
          )}
        </div>
      )}

      {/* Step 1: Review and create draft */}
      {step === 1 && (
        <div>
          <div style={{ fontSize: 16, fontWeight: 500, color: C.ink, marginBottom: 4 }}>Review and create draft</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
            A draft plan will be created for <strong>{selectedOrder?.client}</strong> ({selectedOrder?.order_num}).
            One job per order item will be generated from the order. You can assign workers and add material estimates after creation.
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, display: "block", marginBottom: 5 }}>
              Planning notes (optional)
            </label>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)} rows={3}
              placeholder="Any initial scheduling or material notes…"
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>
        </div>
      )}

      {/* Wizard footer */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24, gap: 8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <div style={{ display: "flex", gap: 8 }}>
          {step > 0 && <Btn onClick={() => setStep(s => s - 1)}>Back</Btn>}
          {step < WIZARD_STEPS.length - 1 ? (
            <Btn primary onClick={() => setStep(s => s + 1)} disabled={step === 0 && !orderId}>
              Continue
            </Btn>
          ) : (
            <Btn primary onClick={handleCreate} disabled={saving || !orderId}>
              {saving ? "Creating plan…" : "Create Draft Plan"}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProductionBoard() {
  const { userRole = "viewer" } = useAuth();
  const canEdit   = ["admin", "production_manager"].includes(userRole);
  const canRecord = ["admin", "production_manager", "production_staff"].includes(userRole);

  const searchParams = useSearchParams();

  // Workshop / Schedule / Plans / Materials / BoQ templates are the approved
  // structure. "Record progress" (ids: orders, today) stays at the end because
  // stage progress is still recorded there — it is retired only once Workshop can
  // record progress itself.
  const tabs = [
    { id: "control",   label: "Workshop"           },
    { id: "gantt",     label: "Schedule"           },
    { id: "plans",     label: "Plans"              },
    ...(canEdit ? [{ id: "materials", label: "Materials" }] : []),
    { id: "templates", label: "BoQ templates"      },
    { id: "orders",    label: "Record progress"    },
    { id: "today",     label: "Today's work"       },
    ...(canEdit ? [{ id: "time", label: "Time" }] : []),
  ];

  // Tab and selected plan come from the URL so that /production?tab=plans&plan=<id>
  // is linkable, survives a refresh, and gives the job page somewhere concrete to
  // return to. Falls back to the default tab when the param is absent or unknown.
  const urlTab  = searchParams?.get("tab") || null;
  const urlPlan = searchParams?.get("plan") || null;

  const [activeTab, setActiveTab] = useState(
    tabs.some(t => t.id === urlTab) ? urlTab : "control"
  );
  const [wizardOpen,   setWizardOpen]   = useState(false);
  const [printingAll,  setPrintingAll]  = useState(false);
  const [materialFocusJob, setMaterialFocusJob] = useState(null);
  const [ganttAssign, setGanttAssign] = useState(null);   // { job, stageKey }
  const [ganttKey,    setGanttKey]    = useState(0);      // bump to refresh the Gantt
  const [ganttErr,    setGanttErr]    = useState(null);

  // Gantt bar -> Assign workers: load the full job (stages included) first so the
  // modal gets the same shape it gets everywhere else.
  const openGanttAssign = async (jobId, stageKey) => {
    setGanttErr(null);
    const r = await fetch(`/api/production/jobs/${jobId}`);
    if (!r.ok) { setGanttErr(`Could not load job (${r.status})`); return; }
    const { job } = await r.json();
    setGanttAssign({ job, stageKey });
  };

  // Follow later navigations (e.g. the job page's back button) without
  // clobbering a tab the user picked by hand.
  useEffect(() => {
    if (urlTab && tabs.some(t => t.id === urlTab)) setActiveTab(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const handlePlanCreated = () => {
    setWizardOpen(false);
    setActiveTab("orders");
  };

  // NOTE: nothing currently calls this. It used to be the Plans → "Cost materials"
  // jump into the Materials tab; costing now happens inline in the plan's BoQ tab,
  // so the jump was removed. MaterialsTab still accepts focusJobId and will expand
  // and scroll to a job when given one — kept for a future "see this job alongside
  // the rest" affordance. Delete both if that never materialises.

  // Fetch active jobs, build worker list, open print window for all
  const handlePrintAll = async () => {
    setPrintingAll(true);
    try {
      const r = await fetch("/api/production/jobs?status=all_active");
      if (!r.ok) { alert(`Could not load assignments (${r.status}).`); return; }
      const { jobs = [] } = await r.json();
      const workerMap = {};
      for (const job of jobs) {
        for (const a of (job.production_job_assignments || [])) {
          if (!a.employees?.id) continue;
          const wid = a.employees.id;
          if (!workerMap[wid]) workerMap[wid] = { id: wid, name: a.employees.name, assignments: [] };
          workerMap[wid].assignments.push({
            job_num:      job.job_num,
            job_name:     job.description || job.category || "Untitled",
            operation:    a.production_operations?.name,
            qty:          a.assigned_quantity,
            order_num:    job.production_plans?.orders?.order_num,
            due_date:     job.production_due_date || job.planned_finish,
            size:         job.size,
            finish_type:  job.finish_type,
            finish_color: job.finish_color,
            wood_type:    job.wood_type,
          });
        }
      }
      const workers = Object.values(workerMap).sort((a, b) => a.name.localeCompare(b.name));
      printAllAssignments(workers);
    } finally {
      setPrintingAll(false);
    }
  };

  return (
    <div style={{ padding: "20px 18px", color: C.ink, maxWidth: "100%", minWidth: 0 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 500, color: C.ink, letterSpacing: "-0.3px" }}>Production control</h1>
          <p style={{ margin: "5px 0 0", fontSize: 13, color: C.muted }}>Canvas Guy shop floor</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Btn onClick={handlePrintAll} disabled={printingAll}>
            {printingAll ? "Loading…" : "Print assignments"}
          </Btn>
          {canEdit && !wizardOpen && (
            <Btn primary onClick={() => setWizardOpen(true)}>+ New production plan</Btn>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ position: "relative", marginBottom: 20 }}>
        <div className="tab-scroll" style={{ display: "flex", gap: 0, borderBottom: `2px solid ${C.line}`, overflowX: "auto", scrollbarWidth: "none" }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: "8px 16px", background: "none", border: "none",
                borderBottom: activeTab === t.id ? `2px solid ${C.coral}` : "2px solid transparent",
                marginBottom: -2,
                fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                color: activeTab === t.id ? C.coral : C.muted,
                whiteSpace: "nowrap",
                transition: "color 0.15s",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Gradient fade — hints at horizontal scroll on narrow viewports */}
        <div className="tab-fade-right" style={{
          position: "absolute", right: 0, top: 0, bottom: 2,
          width: 40, pointerEvents: "none",
          background: `linear-gradient(to right, transparent, ${C.bg})`,
        }} />
      </div>

      {/* Wizard (inline, above tab content) */}
      {wizardOpen && (
        <NewPlanWizard
          onClose={() => setWizardOpen(false)}
          onCreated={handlePlanCreated}
        />
      )}

      {/* Tab panels */}
      {activeTab === "orders" && (
        <OrdersInProgressTab onOpenWizard={() => setWizardOpen(true)} canEdit={canEdit} canRecord={canRecord} />
      )}
      {activeTab === "today"     && <TodaysWorkTab />}
      {activeTab === "time"      && canEdit && <TimeEntries role={userRole} />}
      {activeTab === "control"   && (
        <>
          {ganttErr && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{ganttErr}</div>}
          <WorkshopControl key={ganttKey} canEdit={canEdit} canRecord={canRecord} onAssign={openGanttAssign} />
          {ganttAssign && (
            <AssignWorkersModal
              job={ganttAssign.job}
              initialStageKey={ganttAssign.stageKey}
              onClose={() => setGanttAssign(null)}
              onDone={() => { setGanttAssign(null); setGanttKey(k => k + 1); }}
            />
          )}
        </>
      )}
      {activeTab === "gantt"     && (
        <>
          {ganttErr && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{ganttErr}</div>}
          <WorkshopGantt key={ganttKey} canEdit={canEdit} onAssign={openGanttAssign} />
          {ganttAssign && (
            <AssignWorkersModal
              job={ganttAssign.job}
              initialStageKey={ganttAssign.stageKey}
              onClose={() => setGanttAssign(null)}
              onDone={() => { setGanttAssign(null); setGanttKey(k => k + 1); }}
            />
          )}
        </>
      )}
      {activeTab === "plans"     && <PlansTab onOpenWizard={() => setWizardOpen(true)} canEdit={canEdit} initialPlanId={urlPlan} />}
      {activeTab === "materials" && canEdit && <MaterialsTab focusJobId={materialFocusJob} onFocusHandled={() => setMaterialFocusJob(null)} />}
      {activeTab === "templates" && <TemplatesTab canEdit={canEdit} />}

      {/* Mobile styles */}
      <style>{`
        /* Hide tab scrollbar cross-browser */
        .tab-scroll::-webkit-scrollbar { display: none; }
        /* Gradient fade: visible only when tabs might overflow */
        .tab-fade-right { display: none; }
        @media (max-width: 640px) {
          .tab-fade-right { display: block; }
        }
        /* OrderCard header focus ring */
        [role="button"]:focus-visible {
          outline: 2px solid ${C.coral};
          outline-offset: -2px;
          border-radius: ${C.radiusSm};
        }
      `}</style>
    </div>
  );
}
