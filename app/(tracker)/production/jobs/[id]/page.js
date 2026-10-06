"use client";

/**
 * app/(tracker)/production/jobs/[id]/page.js
 *
 * Production job EXECUTION screen — for running a job, not preparing one.
 * Reached from Today's work, Shop floor, or a plan's job row.
 *
 * Preparation (BoQ authoring, costing, cut list, worker assignment) lives in the
 * production plan. In particular this page must NOT edit BoQ costs: only the
 * plan can set cost_source_type, and a line without one never counts as costed,
 * so an editor here would silently produce rows that block plan activation.
 *
 * Layout:
 *   Hero        — identity, status, stage pipeline, Record progress
 *   Main column — quantity flow bar, materials to gather (read-only), history
 *   Rail        — spec, dates, workshop notes, workers, drawing thumbnails
 *                 (rail stacks under the main column below 900px)
 *
 * Known duplication: progress recording also exists on the board as
 * StageActionModal. Both drive the same /progress and stage RPCs.
 */

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/shared/context/AuthContext";
import { C, Mono, Btn, Badge, Loading, Modal, fmtShortDate, fmtKes } from "@/shared/ui/ds";
import { StageActionModal, AssignWorkersModal } from "@/modules/production/components/ProductionBoard";
import JobCostingPanel from "@/modules/production/components/JobCosting";

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = { border: `1px solid ${C.line}`, radius: C.radiusSm };

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

const TRANSITION_LABELS = {
  start:        { label: "Start work",    from: "not started", to: "in production", color: C.blue   },
  submit_qc:    { label: "Submit to QC",  from: "in production", to: "awaiting QC", color: C.purple },
  accept:       { label: "Accept (QC)",   from: "awaiting QC",  to: "accepted",     color: C.green  },
  rework:       { label: "Send to rework",from: "awaiting QC",  to: "rework",       color: C.amber  },
  rework_start: { label: "Restart rework",from: "rework",       to: "in production",color: C.blue   },
  scrap:        { label: "Scrap",         from: "awaiting QC",  to: "scrapped",     color: C.red    },
};

// ── Section card ──────────────────────────────────────────────────────────────
function SectionCard({ title, children, action }) {
  return (
    <div style={{ background: C.card, border: T.border, borderRadius: T.radius, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px 12px", borderBottom: T.border }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, textTransform: "uppercase", letterSpacing: "0.04em" }}>{title}</div>
        {action}
      </div>
      <div style={{ padding: "16px 18px" }}>{children}</div>
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "10px 12px", minHeight: 44, fontSize: 13,
  border: `1.5px solid ${C.line}`, borderRadius: C.radiusSm,
  background: C.card, color: C.ink, fontFamily: "inherit",
};

// ── Shared form field wrapper (module-level — never define inside a component) ─
function FormField({ label, children }) {
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: C.ink, display: "block", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

// ── Material templates per job category ───────────────────────────────────────
// Each item maps directly to POST /api/production/jobs/:id/materials body.
// Groups are display-only — they don't go to the DB.
const MATERIAL_TEMPLATES = {
  "Wall Decoration": [
    // ── Canvas print
    { material_name: "Canvas Sheet",          specification: "Standard primed, gesso-coated",    unit: "sheet",   quantity_per_unit: 1,     waste_percentage: 5  },
    { material_name: "Canvas Print Time",     specification: "Large-format inkjet / sublimation", unit: "hours",   quantity_per_unit: 0.5,   waste_percentage: 0  },
    // ── Framing
    { material_name: "Frame Moulding",        specification: "Pine, finger-jointed, primed",      unit: "metre",   quantity_per_unit: 2.2,   waste_percentage: 15 },
    { material_name: "Backing Board",         specification: "3mm MDF or foam board",             unit: "sheet",   quantity_per_unit: 1,     waste_percentage: 5  },
    { material_name: "Hanging Hardware",      specification: "D-ring + picture wire + screws",    unit: "set",     quantity_per_unit: 1,     waste_percentage: 0  },
    { material_name: "Corner Fixings",        specification: "V-nails or staples",                unit: "set",     quantity_per_unit: 1,     waste_percentage: 0  },
    // ── Finishing
    { material_name: "Gesso Primer",          specification: "Brush-on, water-based",             unit: "litre",   quantity_per_unit: 0.15,  waste_percentage: 10 },
    { material_name: "Varnish / Sealant",     specification: "UV-protective clear coat",          unit: "litre",   quantity_per_unit: 0.1,   waste_percentage: 10 },
    { material_name: "Sanding Paper 120-grit",specification: "Aluminium oxide sheet",             unit: "sheet",   quantity_per_unit: 1,     waste_percentage: 0  },
    { material_name: "Sanding Paper 220-grit",specification: "Fine finish sheet",                 unit: "sheet",   quantity_per_unit: 1,     waste_percentage: 0  },
    // ── Machine time
    { material_name: "Machine Time — Frame Saw",      specification: "Cross-cut / mitre saw",    unit: "hours",   quantity_per_unit: 0.25,  waste_percentage: 0  },
    { material_name: "Machine Time — Pneumatic Nailer",specification: "Frame assembly",           unit: "hours",   quantity_per_unit: 0.15,  waste_percentage: 0  },
    // ── Packaging
    { material_name: "Packaging — Bubble Wrap",       specification: "Anti-scratch wrap",         unit: "metre",   quantity_per_unit: 0.5,   waste_percentage: 5  },
    { material_name: "Packaging — Cardboard Corner",  specification: "Protective corner guards",  unit: "set",     quantity_per_unit: 1,     waste_percentage: 0  },
  ],

  "Custom Frame": [
    // ── Framing materials
    { material_name: "Frame Moulding",        specification: "Hardwood or pine — specify profile", unit: "metre",  quantity_per_unit: 2.5,   waste_percentage: 15 },
    { material_name: "Acrylic Glazing",       specification: "2mm clear or non-reflective",        unit: "sheet",  quantity_per_unit: 1,     waste_percentage: 5  },
    { material_name: "MDF Backing",           specification: "3mm MDF board",                      unit: "sheet",  quantity_per_unit: 1,     waste_percentage: 5  },
    { material_name: "V-nails / Corner Fixings",specification: "Frame underpinner consumables",    unit: "set",    quantity_per_unit: 1,     waste_percentage: 0  },
    { material_name: "Hanging Hardware",      specification: "D-ring + wire + screws",             unit: "set",    quantity_per_unit: 1,     waste_percentage: 0  },
    // ── Finishing
    { material_name: "Frame Finish / Stain",  specification: "Spray or brush — specify colour",    unit: "litre",  quantity_per_unit: 0.1,   waste_percentage: 10 },
    { material_name: "Top Coat Lacquer",      specification: "Clear satin or gloss",               unit: "litre",  quantity_per_unit: 0.08,  waste_percentage: 10 },
    { material_name: "Sanding Paper 120-grit",specification: "Aluminium oxide",                    unit: "sheet",  quantity_per_unit: 1,     waste_percentage: 0  },
    { material_name: "Sanding Paper 220-grit",specification: "Fine finish",                        unit: "sheet",  quantity_per_unit: 1,     waste_percentage: 0  },
    // ── Machine time
    { material_name: "Machine Time — Mitre Saw",      specification: "Cutting moulding to length", unit: "hours",  quantity_per_unit: 0.3,   waste_percentage: 0  },
    { material_name: "Machine Time — Frame Underpinner",specification: "Joining corners",          unit: "hours",  quantity_per_unit: 0.2,   waste_percentage: 0  },
    { material_name: "Machine Time — Orbital Sander", specification: "Surface prep",               unit: "hours",  quantity_per_unit: 0.25,  waste_percentage: 0  },
    // ── Packaging
    { material_name: "Packaging — Bubble Wrap",       specification: "Anti-scratch wrap",          unit: "metre",  quantity_per_unit: 0.4,   waste_percentage: 5  },
    { material_name: "Packaging — Cardboard Corner",  specification: "Protective corner guards",   unit: "set",    quantity_per_unit: 1,     waste_percentage: 0  },
  ],

  "Furniture": [
    // ── Timber
    { material_name: "Pine Timber (rough)",   specification: "110×50mm or specify section",       unit: "board-ft",quantity_per_unit: 8,    waste_percentage: 15 },
    { material_name: "MDF Panel 18mm",        specification: "2440×1220 standard sheet",          unit: "sheet",   quantity_per_unit: 1,    waste_percentage: 10 },
    { material_name: "MDF Panel 12mm",        specification: "2440×1220 standard sheet",          unit: "sheet",   quantity_per_unit: 0.5,  waste_percentage: 10 },
    // ── Fasteners & adhesives
    { material_name: "Wood Screws 35mm",      specification: "Countersunk self-tapping",          unit: "packet",  quantity_per_unit: 0.5,  waste_percentage: 0  },
    { material_name: "Wood Screws 50mm",      specification: "Countersunk self-tapping",          unit: "packet",  quantity_per_unit: 0.25, waste_percentage: 0  },
    { material_name: "Wood Glue",             specification: "PVA, interior grade",               unit: "litre",   quantity_per_unit: 0.3,  waste_percentage: 5  },
    { material_name: "Wood Filler",           specification: "Solvent-based, sandable",           unit: "tube",    quantity_per_unit: 0.25, waste_percentage: 0  },
    { material_name: "Edge Banding",          specification: "Iron-on PVC, 22mm or match MDF",   unit: "metre",   quantity_per_unit: 2,    waste_percentage: 10 },
    // ── Sanding
    { material_name: "Sanding Paper 80-grit", specification: "Material removal / rough shaping",  unit: "sheet",   quantity_per_unit: 2,    waste_percentage: 0  },
    { material_name: "Sanding Paper 120-grit",specification: "Intermediate shaping",              unit: "sheet",   quantity_per_unit: 3,    waste_percentage: 0  },
    { material_name: "Sanding Paper 220-grit",specification: "Pre-finish surface prep",           unit: "sheet",   quantity_per_unit: 2,    waste_percentage: 0  },
    // ── Finishing
    { material_name: "Wood Stain",            specification: "Oil or water-based — specify tone", unit: "litre",   quantity_per_unit: 0.4,  waste_percentage: 10 },
    { material_name: "Top Coat Varnish",      specification: "Polyurethane satin or gloss",       unit: "litre",   quantity_per_unit: 0.25, waste_percentage: 10 },
    // ── Machine time
    { material_name: "Machine Time — Table Saw",          specification: "Ripping & cross-cutting",      unit: "hours", quantity_per_unit: 1,    waste_percentage: 0 },
    { material_name: "Machine Time — Planer/Thicknesser", specification: "Dimensioning rough timber",     unit: "hours", quantity_per_unit: 0.5,  waste_percentage: 0 },
    { material_name: "Machine Time — Router",             specification: "Joinery, profiling, rebates",   unit: "hours", quantity_per_unit: 0.5,  waste_percentage: 0 },
    { material_name: "Machine Time — Orbital Sander",     specification: "Surface sanding all stages",    unit: "hours", quantity_per_unit: 0.75, waste_percentage: 0 },
    { material_name: "Machine Time — Drill Press",        specification: "Dowel holes / hardware fixing", unit: "hours", quantity_per_unit: 0.25, waste_percentage: 0 },
    // ── Packaging
    { material_name: "Packaging — Moving Blanket",        specification: "Protective wrap for transit",   unit: "piece", quantity_per_unit: 1,    waste_percentage: 0 },
    { material_name: "Packaging — Stretch Wrap",          specification: "Pallet / crate wrap",           unit: "metre", quantity_per_unit: 3,    waste_percentage: 5 },
  ],

  "Skirting": [
    // ── Materials
    { material_name: "Skirting Profile",      specification: "Pine, primed — specify height & profile", unit: "metre",  quantity_per_unit: 1.05, waste_percentage: 5  },
    { material_name: "Wood Filler",           specification: "Fine surface filler, sandable",            unit: "tube",   quantity_per_unit: 0.05, waste_percentage: 0  },
    { material_name: "Finishing Nails 40mm",  specification: "Lost-head, galvanised",                    unit: "packet", quantity_per_unit: 0.1,  waste_percentage: 0  },
    { material_name: "Caulk / Sealant",       specification: "Flexible paintable sealant",              unit: "tube",   quantity_per_unit: 0.1,  waste_percentage: 0  },
    // ── Finishing
    { material_name: "Primer Coat",           specification: "Water-based timber primer",                unit: "litre",  quantity_per_unit: 0.06, waste_percentage: 10 },
    { material_name: "Top Coat Paint",        specification: "Satinwood — specify colour",               unit: "litre",  quantity_per_unit: 0.05, waste_percentage: 10 },
    { material_name: "Sanding Paper 120-grit",specification: "Between coats",                           unit: "sheet",  quantity_per_unit: 0.5,  waste_percentage: 0  },
    { material_name: "Sanding Paper 220-grit",specification: "Final de-nibbing",                        unit: "sheet",  quantity_per_unit: 0.25, waste_percentage: 0  },
    // ── Machine time
    { material_name: "Machine Time — Mitre Saw",  specification: "Cutting lengths and returns",         unit: "hours",  quantity_per_unit: 0.1,  waste_percentage: 0  },
    // ── Packaging
    { material_name: "Packaging — Cardboard Tube",specification: "Protective sleeve for long lengths",  unit: "piece",  quantity_per_unit: 1,    waste_percentage: 0  },
  ],
};

// ── initials helper ───────────────────────────────────────────────────────────
// Stage vocabulary — keys and statuses come from create_job_stages() and the
// status CHECK constraint in production_v1e_stages.sql.
const STAGE_SHORT = {
  materials: "Materials",
  assembly:  "Assembly",
  sanding:   "Sanding",
  finishing: "Finishing",
  packaging: "Packaging",
};

const STAGE_STATUS_TEXT = {
  not_started: "not started",
  active:      "in progress",
  completed:   "completed",
  skipped:     "skipped",
};

function isImage(url = "") {
  return /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(url || "");
}

// ── DrawingViewer — full-screen overlay ───────────────────────────────────────
// A technical drawing is unreadable as a thumbnail, and this page exists partly
// so someone can read one while the work happens. Escape and arrow keys work.

function DrawingViewer({ drawings, index, onClose, onIndex }) {
  const d = drawings[index];

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape")     onClose();
      if (e.key === "ArrowRight") onIndex(Math.min(index + 1, drawings.length - 1));
      if (e.key === "ArrowLeft")  onIndex(Math.max(index - 1, 0));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, drawings.length, onClose, onIndex]);

  if (!d) return null;

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Drawing: ${d.file_name}`}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.82)",
        display: "flex", flexDirection: "column",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", color: "#fff", flexShrink: 0 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.file_name}</div>
          {d.category && <div style={{ fontSize: 12, opacity: 0.7 }}>{d.category}</div>}
        </div>
        {drawings.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, flexShrink: 0 }}>
            <button onClick={() => onIndex(Math.max(index - 1, 0))} disabled={index === 0}
              style={{ background: "rgba(255,255,255,0.15)", border: 0, color: "#fff", borderRadius: 6, padding: "4px 10px", cursor: index === 0 ? "default" : "pointer", opacity: index === 0 ? 0.4 : 1, fontFamily: "inherit" }}>←</button>
            <span style={{ opacity: 0.8 }}>{index + 1} / {drawings.length}</span>
            <button onClick={() => onIndex(Math.min(index + 1, drawings.length - 1))} disabled={index === drawings.length - 1}
              style={{ background: "rgba(255,255,255,0.15)", border: 0, color: "#fff", borderRadius: 6, padding: "4px 10px", cursor: index === drawings.length - 1 ? "default" : "pointer", opacity: index === drawings.length - 1 ? 0.4 : 1, fontFamily: "inherit" }}>→</button>
          </div>
        )}
        {d.file_url && (
          <a href={d.file_url} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 13, color: "#fff", opacity: 0.85, textDecoration: "none", flexShrink: 0 }}>
            Open original ↗
          </a>
        )}
        <button onClick={onClose} aria-label="Close viewer"
          style={{ background: "none", border: 0, color: "#fff", fontSize: 26, lineHeight: 1, cursor: "pointer", padding: "0 4px", flexShrink: 0 }}>×</button>
      </div>

      <div onClick={e => e.stopPropagation()} style={{ flex: 1, minHeight: 0, padding: "0 16px 16px" }}>
        {isImage(d.file_url) ? (
          <img src={d.file_url} alt={d.file_name}
            style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        ) : (
          <iframe src={d.file_url} title={d.file_name}
            style={{ width: "100%", height: "100%", border: 0, background: "#fff", borderRadius: 6 }} />
        )}
      </div>
    </div>
  );
}

function initials(name = "") {
  return name.split(" ").map(w => w[0] || "").join("").toUpperCase().slice(0, 2) || "?";
}

// ── RecordProgressModal ───────────────────────────────────────────────────────
// Context-driven, shop-floor language. Adapts to the job's current state:
//   QC pending  → "What happened to these N units?" [Passed QC / Needs rework / Scrap]
//   Rework      → "Rework complete?" [Resume production]
//   In production → "Submit to QC?"
//   Not started → "Start production?"

const PROGRESS_CHOICES = {
  accept:       { label: "Passed QC",                      color: "#16a34a", destructive: false },
  rework:       { label: "Needs rework",                   color: "#d97706", destructive: false },
  scrap:        { label: "Scrap",                          color: "#dc2626", destructive: true  },
  rework_start: { label: "Rework complete — resume",       color: C.blue,   destructive: false },
  submit_qc:    { label: "Submit to QC",                   color: C.purple, destructive: false },
  start:        { label: "Start production",               color: C.blue,   destructive: false },
};

function submitLabel(choice, n) {
  if (!choice || !n) return "Record";
  const map = {
    accept:       `Accept ${n} unit${n !== 1 ? "s" : ""}`,
    rework:       `Send ${n} to rework`,
    scrap:        `Scrap ${n} unit${n !== 1 ? "s" : ""}`,
    rework_start: `Resume ${n} unit${n !== 1 ? "s" : ""}`,
    submit_qc:    `Submit ${n} to QC`,
    start:        `Start ${n} unit${n !== 1 ? "s" : ""}`,
  };
  return map[choice] || "Record";
}

function RecordProgressModal({ job, onClose, onDone, canQC }) {
  const hasStages = (job.production_job_stages || []).some(stage => stage.is_enabled);
  if (hasStages) {
    return (
      <StageActionModal
        job={job}
        onClose={onClose}
        onDone={onDone}
        canQC={canQC}
      />
    );
  }

  const [choice,      setChoice]      = useState(null);
  const [qty,         setQty]         = useState("");
  const [notes,       setNotes]       = useState("");
  const [showNote,    setShowNote]    = useState(false);
  const [scrapPhase,  setScrapPhase]  = useState(false); // confirmation step for Scrap
  const [saving,      setSaving]      = useState(false);
  const [err,         setErr]         = useState(null);

  const notStarted = job.planned_quantity
    - job.in_production_qty - job.awaiting_qc_qty
    - job.rework_qty - job.accepted_qty;

  const pool = {
    accept:       job.awaiting_qc_qty,
    rework:       job.awaiting_qc_qty,
    scrap:        job.awaiting_qc_qty,
    rework_start: job.rework_qty,
    submit_qc:    job.in_production_qty,
    start:        Math.max(0, notStarted),
  };

  // Determine the current active context — highest priority first
  const context = (() => {
    if (pool.accept > 0) return {
      subtitle: `Quality check · ${pool.accept} unit${pool.accept !== 1 ? "s" : ""} waiting`,
      question: `What happened to ${pool.accept === 1 ? "this unit" : `these ${pool.accept} units`}?`,
      choices:  ["accept", "rework", "scrap"],
    };
    if (pool.rework_start > 0) return {
      subtitle: `Rework · ${pool.rework_start} unit${pool.rework_start !== 1 ? "s" : ""} in rework`,
      question: `Ready to resume production?`,
      choices:  ["rework_start"],
    };
    if (pool.submit_qc > 0) return {
      subtitle: `In production · ${pool.submit_qc} unit${pool.submit_qc !== 1 ? "s" : ""} in progress`,
      question: `Finished and ready for quality check?`,
      choices:  ["submit_qc"],
    };
    if (pool.start > 0) return {
      subtitle: `${pool.start} unit${pool.start !== 1 ? "s" : ""} not yet started`,
      question: `Ready to begin production?`,
      choices:  ["start"],
    };
    return null;
  })();

  const available  = choice ? pool[choice] : 0;
  const parsedQty  = parseInt(qty, 10) || 0;
  const choiceMeta = choice ? PROGRESS_CHOICES[choice] : null;

  const selectChoice = (key) => {
    setChoice(key);
    setQty(String(pool[key] || 1));
    setErr(null);
    setScrapPhase(false);
  };

  // Auto-select when there is only one possible choice (production-staff path)
  useEffect(() => {
    if (context && context.choices.length === 1 && !choice) {
      selectChoice(context.choices[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBack = () => {
    if (scrapPhase) { setScrapPhase(false); return; }
    if (choice && (context?.choices?.length || 0) > 1) { setChoice(null); setQty(""); setErr(null); return; }
    onClose();
  };

  const handleSubmit = async () => {
    const n = parsedQty;
    if (!n || n <= 0) { setErr("Enter a positive quantity"); return; }
    if (n > available)  { setErr(`Only ${available} unit${available !== 1 ? "s" : ""} available`); return; }

    // Scrap requires a two-step confirmation
    if (choice === "scrap" && !scrapPhase) { setScrapPhase(true); return; }

    setSaving(true); setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transition: choice, quantity: n, notes: notes || undefined }),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Failed to record progress"); setSaving(false); setScrapPhase(false); return; }
    onDone(data.job);
  };

  // ── Quantity breakdown (collapsible) ────────────────────────────────────────
  const [showBreakdown, setShowBreakdown] = useState(false);
  const breakdown = [
    { label: "Not started",   value: notStarted,            color: C.muted  },
    { label: "In production", value: job.in_production_qty, color: C.blue   },
    { label: "Awaiting QC",   value: job.awaiting_qc_qty,   color: C.purple },
    { label: "Rework",        value: job.rework_qty,        color: C.amber  },
    { label: "Accepted",      value: job.accepted_qty,      color: C.green  },
    { label: "Scrapped",      value: job.scrapped_qty,      color: C.red    },
  ];

  const backLabel = scrapPhase ? "← Back" : (choice && (context?.choices?.length || 0) > 1 ? "← Back" : "Cancel");
  const primaryDisabled = saving || !choice || !parsedQty || parsedQty <= 0;

  return (
    <Modal
      title={job.job_num}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={handleBack}>{backLabel}</Btn>
          {choice && !scrapPhase && (
            <Btn
              primary={!choiceMeta?.destructive}
              danger={choiceMeta?.destructive}
              onClick={handleSubmit}
              disabled={primaryDisabled}
              style={choiceMeta?.destructive ? { background: "#dc2626", color: "#fff", border: "none" } : {}}
            >
              {saving ? "Recording…" : (choice === "scrap" ? "Confirm scrap →" : submitLabel(choice, parsedQty))}
            </Btn>
          )}
          {scrapPhase && (
            <Btn
              onClick={handleSubmit}
              disabled={saving}
              style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: C.radiusSm, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
            >
              {saving ? "Scrapping…" : `Confirm — scrap ${parsedQty} unit${parsedQty !== 1 ? "s" : ""}`}
            </Btn>
          )}
        </>
      }
    >
      {/* Context subtitle */}
      {context && (
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 18, marginTop: -4 }}>
          {context.subtitle}
        </div>
      )}

      {!context ? (
        <div style={{ fontSize: 13, color: C.muted, padding: "8px 0" }}>
          No actions available — all units are accepted or the job is complete.
        </div>
      ) : scrapPhase ? (
        /* ── Scrap confirmation ── */
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ padding: "14px 16px", background: "#fef2f2", border: "1.5px solid #fca5a5", borderRadius: T.radius }}>
            <div style={{ fontWeight: 700, color: "#dc2626", fontSize: 14, marginBottom: 4 }}>
              Scrapping {parsedQty} unit{parsedQty !== 1 ? "s" : ""} — this cannot be undone
            </div>
            <div style={{ fontSize: 13, color: "#7f1d1d" }}>
              Scrapped units are permanently removed from the production count. Are you sure?
            </div>
          </div>
          {err && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}
          {notes && (
            <div style={{ fontSize: 12, color: C.muted }}>
              Note: <em>{notes}</em>
            </div>
          )}
        </div>
      ) : (
        /* ── Main form ── */
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {err && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius }}>{err}</div>}

          {/* Question */}
          <div style={{ fontSize: 16, fontWeight: 600, color: C.ink }}>{context.question}</div>

          {/* Choice buttons */}
          {context.choices.length > 1 && (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${context.choices.length}, 1fr)`, gap: 8 }}>
              {context.choices.map(key => {
                const m = PROGRESS_CHOICES[key];
                const selected = choice === key;
                return (
                  <button
                    key={key}
                    onClick={() => selectChoice(key)}
                    style={{
                      padding: "14px 10px", cursor: "pointer",
                      border: `2px solid ${selected ? m.color : C.line}`,
                      borderRadius: T.radius, background: selected ? `${m.color}14` : C.card,
                      textAlign: "center", transition: "all 0.1s",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: m.color }}>{m.label}</div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Quantity — only shown after choice is selected */}
          {choice && (
            <>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 8 }}>How many units?</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="number" min={1} max={available} value={qty}
                    onChange={e => setQty(e.target.value)}
                    style={{ ...inputStyle, width: 120 }}
                  />
                  {available > 1 && parsedQty !== available && (
                    <Btn small onClick={() => setQty(String(available))}>
                      Use all {available}
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
                  <textarea
                    value={notes} onChange={e => setNotes(e.target.value)}
                    placeholder="Add a note…"
                    rows={2}
                    style={{ ...inputStyle, marginTop: 8, resize: "vertical" }}
                  />
                )}
              </div>
            </>
          )}

          {/* Quantity breakdown — collapsible */}
          <div>
            <button
              onClick={() => setShowBreakdown(v => !v)}
              style={{ fontSize: 12, color: C.muted, background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}
            >
              <span style={{ fontSize: 10 }}>{showBreakdown ? "▼" : "▶"}</span> View quantity breakdown
            </button>
            {showBreakdown && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 10 }}>
                {breakdown.map(({ label, value, color }) => (
                  <div key={label} style={{ background: C.bg, borderRadius: T.radius, padding: "7px 10px" }}>
                    <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
                    <Mono style={{ fontSize: 16, fontWeight: 600, color }}>{value}</Mono>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── LinkDrawingModal ──────────────────────────────────────────────────────────
function LinkDrawingModal({ job, linkedIds, onClose, onDone }) {
  const [drawings, setDrawings] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(null);
  const [err,      setErr]      = useState(null);

  // Fetch drawings for the same order
  useEffect(() => {
    // Get order_id from the job's plan (need to fetch separately or pass it in)
    // For now fetch via the orders drawings API
    if (!job.order_id) { setLoading(false); return; }
    fetch(`/api/orders/${job.order_id}/drawings`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setDrawings(data?.drawings || []); setLoading(false); });
  }, [job.order_id]);

  const handleLink = async (drawingId) => {
    setSaving(drawingId);
    setErr(null);
    const r = await fetch(`/api/production/jobs/${job.id}/drawings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drawing_id: drawingId }),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || "Failed to link drawing"); setSaving(null); return; }
    setSaving(null);
    onDone();
  };

  const handleUnlink = async (drawingId) => {
    setSaving(drawingId);
    const r = await fetch(`/api/production/jobs/${job.id}/drawings`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drawing_id: drawingId }),
    });
    setSaving(null);
    if (r.ok) onDone();
  };

  return (
    <Modal title={`Link drawings — ${job.job_num}`} onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      {loading ? <Loading /> : (
        <div>
          {err && <div style={{ fontSize: 13, color: C.red, padding: "8px 12px", background: C.redBg, borderRadius: T.radius, marginBottom: 12 }}>{err}</div>}
          {drawings.length === 0 ? (
            <div style={{ fontSize: 13, color: C.muted }}>No drawings found for this order.</div>
          ) : drawings.map(d => {
            const isLinked = linkedIds.includes(d.id);
            return (
              <div key={d.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: T.border }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: C.ink }}>{d.file_name}</div>
                  {d.category && <div style={{ fontSize: 11, color: C.muted }}>{d.category}</div>}
                </div>
                <Btn
                  small
                  danger={isLinked}
                  onClick={() => isLinked ? handleUnlink(d.id) : handleLink(d.id)}
                  disabled={saving === d.id}
                >
                  {saving === d.id ? "…" : isLinked ? "Unlink" : "Link"}
                </Btn>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ── Main job page ─────────────────────────────────────────────────────────────
export default function JobDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { userRole = "viewer" } = useAuth();
  const canEdit = ["admin", "production_manager"].includes(userRole);
  const canRecord = ["admin", "production_manager", "production_staff"].includes(userRole);
  const canQC = ["admin", "production_manager"].includes(userRole);

  const [job,       setJob]       = useState(null);
  const [materials, setMaterials] = useState([]);
  const [drawings,  setDrawings]  = useState([]);
  const [history,   setHistory]   = useState([]);
  const [loaded,    setLoaded]    = useState(false);
  const [err,       setErr]       = useState(null);

  const [showProgress,    setShowProgress]    = useState(false);
  const [showAssign,      setShowAssign]      = useState(false);
  const [showDrawings,    setShowDrawings]    = useState(false);
  const [viewerIndex,     setViewerIndex]     = useState(null); // full-screen drawing viewer

  // Single breakpoint: below this the rail stacks under the main column.
  // Desktop is the primary surface for this page, so this is a plain collapse.
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => setIsNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const loadJob = useCallback(async () => {
    const [jobRes, matRes, drawRes, histRes] = await Promise.all([
      fetch(`/api/production/jobs/${id}`),
      fetch(`/api/production/jobs/${id}/materials`),
      fetch(`/api/production/jobs/${id}/drawings`),
      fetch(`/api/production/jobs/${id}/history`).catch(() => null),
    ]);

    if (!jobRes.ok) { setErr("Job not found"); setLoaded(true); return; }
    const { job: j } = await jobRes.json();
    setJob(j);

    if (matRes.ok) { const { materials: m } = await matRes.json(); setMaterials(m || []); }
    if (drawRes.ok) { const { drawings: d } = await drawRes.json(); setDrawings(d || []); }
    if (histRes?.ok) { const data = await histRes.json(); setHistory(data?.entries || []); }
    setLoaded(true);
  }, [id]);

  useEffect(() => { loadJob(); }, [loadJob]);




  if (!loaded) return <Loading />;
  if (err || !job) return <div style={{ padding: 24, color: C.red }}>{err || "Job not found"}</div>;

  const dot = STATUS_DOT[job.status] || C.muted;
  const pct = job.planned_quantity > 0 ? Math.round((job.accepted_qty / job.planned_quantity) * 100) : 0;
  const notStarted = job.planned_quantity - job.in_production_qty - job.awaiting_qc_qty - job.rework_qty - job.accepted_qty;

  // Stage rows for the hero pipeline. Empty before production_v1e_stages has run,
  // in which case the hero simply renders without the pipeline.
  const stages = [...(job.production_job_stages || [])]
    .filter(s => s.is_enabled !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const matTotal = materials.reduce((s, m) => s + (m.estimated_total_cost || 0), 0);

  return (
    <>
    <div style={{ padding: "20px 18px", color: C.ink, maxWidth: 1240, margin: "0 auto" }}>

        {/* Back to the plan this job belongs to, not the module home. */}
        <button
          onClick={() => router.push(
            job.production_plans?.id
              ? `/production?tab=plans&plan=${job.production_plans.id}`
              : "/production?tab=plans"
          )}
          style={{ background: "none", border: "none", fontSize: 13, color: C.muted, cursor: "pointer", padding: "0 0 10px", fontFamily: "inherit" }}
        >
          ← Back to {job.production_plans?.orders?.order_num
            ? `plan · ${job.production_plans.orders.order_num}`
            : "production plan"}
        </button>

        {/* ── Hero ──────────────────────────────────────────────────────────
            Identity + the primary action + the stage pipeline. The pipeline is
            the first question an execution screen has to answer — where is this
            job right now — and it was previously absent from the page entirely. */}
        <div style={{ background: C.card, border: T.border, borderRadius: T.radius, padding: "16px 18px", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap", marginBottom: stages.length ? 16 : 0 }}>
            <div style={{ minWidth: 220 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: dot, display: "inline-block" }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: dot }}>{job.status}</span>
              </div>
              <h1 style={{ margin: "0 0 4px", fontSize: 21, fontWeight: 500, color: C.ink, lineHeight: 1.25 }}>
                {job.description || job.category || "Untitled job"}
              </h1>
              <div style={{ fontSize: 12, color: C.muted }}>
                <Mono>{job.job_num}</Mono>
                {job.production_plans?.orders && <> · {job.production_plans.orders.order_num} · {job.production_plans.orders.client}</>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {canEdit && (
                <Btn small onClick={() => setShowAssign(true)}>Assign workers</Btn>
              )}
              {canRecord && job.status !== "Completed" && job.status !== "Cancelled" && (
                <Btn primary small onClick={() => setShowProgress(true)}>Record progress</Btn>
              )}
            </div>
          </div>

          {/* Stage pipeline. Widths are weighted so the active stage reads as the
              focus; stages the job does not use render muted rather than hidden,
              so the shape of the route stays constant between jobs. */}
          {stages.length > 0 && (
            <div style={{ display: "flex", alignItems: "stretch", gap: 4 }}>
              {stages.map(s => {
                const st      = s.status || "not_started";
                const active  = st === "active";
                const done    = st === "completed";
                const skipped = st === "skipped";
                const colour  = done ? C.green : active ? C.blue : C.muted;
                return (
                  <div
                    key={s.id || s.stage_key}
                    title={`${s.stage_label || s.stage_key}: ${STAGE_STATUS_TEXT[st] || st}`}
                    style={{
                      flex: active ? 1.5 : 1,
                      padding: "8px 6px",
                      borderRadius: C.radiusSm,
                      textAlign: "center",
                      background: done ? "#E8F5E9" : active ? "#EEF4FF" : C.bg,
                      border: active ? `2px solid ${C.blue}` : `1px solid ${C.line}`,
                      opacity: skipped ? 0.55 : 1,
                      minWidth: 0,
                    }}
                  >
                    <div style={{
                      fontSize: 11, fontWeight: active ? 700 : 500, color: colour,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      textDecoration: skipped ? "line-through" : "none",
                    }}>
                      {done ? "✓ " : ""}{STAGE_SHORT[s.stage_key] || s.stage_label || s.stage_key}
                    </div>
                    {active && s.planned_quantity != null && (
                      <div style={{ fontSize: 10, color: C.blue, marginTop: 1 }}>
                        {s.completed_quantity || 0} of {s.planned_quantity}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Body: main column + rail ─────────────────────────────────────── */}
        <div style={{
          display: "grid",
          gridTemplateColumns: isNarrow ? "minmax(0, 1fr)" : "minmax(0, 1.55fr) minmax(0, 1fr)",
          gap: 14,
          alignItems: "start",
        }}>

          {/* ── Main column ── */}
          <div>

            {/* Quantity flow — one stacked bar replaces the old seven-cell grid,
                which spent three rows of vertical space mostly rendering zeros.
                Zero states drop out of the legend instead of holding a whole cell. */}
            <SectionCard title="Quantity flow">
              {(() => {
                const planned = job.planned_quantity || 0;
                const segs = [
                  { label: "Accepted",      value: job.accepted_qty     || 0, colour: C.green  },
                  { label: "Awaiting QC",   value: job.awaiting_qc_qty  || 0, colour: C.purple },
                  { label: "In production", value: job.in_production_qty || 0, colour: C.blue   },
                  { label: "Rework",        value: job.rework_qty       || 0, colour: C.amber  },
                  { label: "Scrapped",      value: job.scrapped_qty     || 0, colour: C.red    },
                  { label: "Not started",   value: notStarted           || 0, colour: C.line   },
                ];
                const shown = segs.filter(s => s.value > 0);
                return (
                  <>
                    <div style={{ display: "flex", height: 22, borderRadius: 4, overflow: "hidden", background: C.bg, marginBottom: 10 }}>
                      {planned > 0 && shown.map(s => (
                        <div
                          key={s.label}
                          title={`${s.label}: ${s.value}`}
                          style={{ width: `${(s.value / planned) * 100}%`, background: s.colour }}
                        />
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12 }}>
                      {shown.map(s => (
                        <span key={s.label} style={{ color: C.muted }}>
                          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: s.colour, marginRight: 6 }} />
                          {s.label} <strong style={{ color: C.ink }}>{s.value}</strong>
                        </span>
                      ))}
                      <div style={{ flex: 1 }} />
                      <span style={{ color: C.muted }}>
                        <strong style={{ color: C.ink }}>{pct}%</strong> accepted of {planned}
                      </span>
                    </div>
                  </>
                );
              })()}
            </SectionCard>

            {canEdit && <JobCostingPanel jobId={job.id} />}

            {/* Materials — read-only stores checklist.
                BoQ authoring and costing both live in the production plan, which is the
                only surface that can set cost_source_type; a line without one never
                counts as costed, so an editor here would silently block activation.
                Costs are deliberately omitted: this list exists so whoever confirms the
                Materials Preparation stage knows what to gather, not what it cost. */}
            <SectionCard
              title={`Materials to gather (${materials.length})`}
              action={
                <Btn
                  small
                  onClick={() => router.push(
                    job.production_plans?.id
                      ? `/production?tab=plans&plan=${job.production_plans.id}`
                      : "/production?tab=plans"
                  )}
                >
                  Open in plan →
                </Btn>
              }
            >
              {materials.length === 0 ? (
                <div style={{ fontSize: 13, color: C.muted }}>
                  No BoQ lines yet — add them from the production plan.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: `2px solid ${C.line}` }}>
                        {["Material", "Required", "Unit"].map(h => (
                          <th key={h} style={{ textAlign: "left", padding: "6px 10px 6px 0", fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {materials.map(m => {
                        const required = m.adjustment_quantity != null && Number(m.adjustment_quantity) !== 0
                          ? Number(m.estimated_quantity || 0) + Number(m.adjustment_quantity)
                          : Number(m.estimated_quantity || 0);
                        return (
                          <tr key={m.id} style={{ borderBottom: T.border }}>
                            <td style={{ padding: "9px 10px 9px 0" }}>
                              <div style={{ fontWeight: 500, color: C.ink }}>{m.material_name}</div>
                              {m.specification && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{m.specification}</div>}
                            </td>
                            <td style={{ padding: "9px 10px 9px 0", whiteSpace: "nowrap" }}>
                              <Mono style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>
                                {required ? required.toFixed(2) : "—"}
                              </Mono>
                              {m.adjustment_quantity != null && Number(m.adjustment_quantity) !== 0 && (
                                <span style={{ fontSize: 11, color: C.amber, marginLeft: 6 }}>
                                  incl. adj {Number(m.adjustment_quantity) > 0 ? "+" : ""}{Number(m.adjustment_quantity)}
                                </span>
                              )}
                            </td>
                            <td style={{ padding: "9px 0", color: C.muted }}>{m.unit}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            {/* Progress history */}
            {history.length > 0 && (
              <SectionCard title="Progress history">
                {history.map(e => (
                  <div key={e.id} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: T.border, fontSize: 13 }}>
                    <Mono style={{ fontSize: 11, color: C.muted, width: 80, flexShrink: 0, paddingTop: 2 }}>
                      {fmtShortDate(e.recorded_at)}
                    </Mono>
                    <div>
                      <span style={{ fontWeight: 500, color: C.ink }}>{TRANSITION_LABELS[e.transition]?.label || e.transition}</span>
                      <span style={{ color: C.muted }}> · <Mono>{e.quantity}</Mono> units</span>
                      {e.notes && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{e.notes}</div>}
                    </div>
                  </div>
                ))}
              </SectionCard>
            )}
          </div>

          {/* ── Rail: glanceable context, not things you read through ── */}
          <div>
            <SectionCard title="Details">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                {[job.size, job.finish_type, job.finish_color, job.wood_type].filter(Boolean).map(v => (
                  <span key={v} style={{ fontSize: 12, padding: "3px 9px", background: C.bg, borderRadius: 4, color: C.ink }}>{v}</span>
                ))}
              </div>
              {job.planned_start && (
                <div style={{ fontSize: 12, color: C.muted, borderTop: T.border, paddingTop: 9 }}>
                  Planned {fmtShortDate(job.planned_start)} — <strong style={{ color: C.ink }}>{fmtShortDate(job.planned_finish)}</strong>
                </div>
              )}
              <div style={{ fontSize: 12, color: C.muted, paddingTop: 6 }}>
                Production due: <strong style={{ color: C.ink }}>{job.production_due_date ? fmtShortDate(job.production_due_date) : "not set"}</strong>
                {" · "}Customer delivery: <strong style={{ color: C.ink }}>{job.production_plans?.orders?.due_date ? fmtShortDate(job.production_plans.orders.due_date) : "not set"}</strong>
              </div>
              {job.production_instructions && (
                <div style={{ marginTop: 10, padding: "9px 12px", background: C.bg, borderRadius: T.radius, fontSize: 12, color: C.ink }}>
                  <strong>Workshop notes: </strong>{job.production_instructions}
                </div>
              )}
            </SectionCard>

            <SectionCard title={`On this job (${(job.production_job_assignments || []).length})`}>
              {(job.production_job_assignments || []).length === 0 ? (
                <div style={{ fontSize: 13, color: C.muted }}>No workers assigned yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {(job.production_job_assignments || []).map(a => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ width: 28, height: 28, borderRadius: "50%", background: C.bg, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 600, color: C.ink, flexShrink: 0 }}>
                        {(a.employees?.name || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2)}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.employees?.name}</div>
                        <div style={{ fontSize: 10, color: C.muted }}>{a.production_operations?.name} · {a.assigned_quantity}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* Drawings as thumbnails — this page exists partly so a drawing can be
                read while the work happens, so they sit above the fold, not in a
                list at the bottom. Clicking opens the full-screen viewer. */}
            <SectionCard
              title={`Drawings (${drawings.length})`}
              action={canEdit ? <Btn small onClick={() => setShowDrawings(true)}>Manage</Btn> : null}
            >
              {drawings.length === 0 ? (
                <div style={{ fontSize: 13, color: C.muted }}>No drawings linked.</div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {drawings.map((d, i) => (
                    <button
                      key={d.id}
                      onClick={() => setViewerIndex(i)}
                      title={d.file_name}
                      style={{
                        display: "block", padding: 0, border: T.border, borderRadius: T.radius,
                        background: C.bg, cursor: "pointer", overflow: "hidden", textAlign: "left",
                        fontFamily: "inherit",
                      }}
                    >
                      <div style={{ aspectRatio: "1 / 1", display: "grid", placeItems: "center", overflow: "hidden" }}>
                        {isImage(d.file_url)
                          ? <img src={d.file_url} alt={d.file_name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          : <span style={{ fontSize: 22, color: C.muted }}>▤</span>}
                      </div>
                      <div style={{ padding: "5px 7px", borderTop: T.border, background: C.card }}>
                        <div style={{ fontSize: 10, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.file_name}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showProgress && (
        <RecordProgressModal
          job={job}
          canQC={canQC}
          onClose={() => setShowProgress(false)}
          onDone={(updatedJob) => { setJob(updatedJob); setShowProgress(false); loadJob(); }}
        />
      )}
      {showAssign && (
        <AssignWorkersModal
          job={job}
          onClose={() => setShowAssign(false)}
          onDone={() => { setShowAssign(false); loadJob(); }}
        />
      )}
      {showDrawings && (
        <LinkDrawingModal
          job={job}
          linkedIds={drawings.map(d => d.id)}
          onClose={() => setShowDrawings(false)}
          onDone={() => { setShowDrawings(false); loadJob(); }}
        />
      )}
      {viewerIndex !== null && drawings[viewerIndex] && (
        <DrawingViewer
          drawings={drawings}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </>
  );
}
