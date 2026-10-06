"use client";

/**
 * WorkshopControl — the "what needs me right now" view.
 *   • KPI strip + attention queue (reasons come from the shared server helper)
 *   • "Ready to work" per stage (upstream completed − this completed)
 *   • Selected job panel: stages, blockers, material readiness, print
 *   • Print chooser: type (shop-floor card / shortage sheet / internal pack) × scope
 *
 * Read-only apart from: material readiness (workshop may record), assign
 * workers, and printing. Nothing here records production progress.
 * Money: the shop-floor card and shortage sheet receive no financial data from
 * the server; the internal pack is requested only by admin / production_manager.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { C, Btn, Modal, Loading, fmtShortDate } from "@/shared/ui/ds";
import { buildShopFloorCards, buildShortageSheet, buildInternalPack } from "@/shared/lib/production/printSheets";

const STAGE_ORDER = ["materials", "assembly", "sanding", "finishing", "packaging"];
const STAGE_NAMES = { materials: "Material prep", assembly: "Assembly", sanding: "Sanding", finishing: "Finishing", packaging: "Packaging" };

const selectStyle = {
  padding: "7px 8px", border: `1px solid ${C.line}`, borderRadius: C.radiusSm, fontSize: 13, fontFamily: "inherit", background: C.card, color: C.ink,
};

const chip = (sev) => sev === "critical"
  ? { background: C.redBg, color: C.red, border: `1px solid ${C.redBd}` }
  : { background: C.amberBg, color: C.amber, border: `1px solid ${C.amberBd}` };

// First enabled stage that is not finished; null when every stage is done.
const currentStage = (job) => job.stages.find((s) => s.status !== "completed" && s.status !== "skipped") || null;

const worst = (att) => (att.some((a) => a.severity === "critical") ? "critical" : att.length ? "warning" : null);

function openPrintWindow(html) {
  const w = window.open("", "_blank");
  if (!w) { alert("Pop-up blocked — allow pop-ups to print."); return false; }
  w.document.open(); w.document.write(html); w.document.close();
  w.focus(); setTimeout(() => w.print(), 300);
  return true;
}

export default function WorkshopControl({ canEdit, canRecord, onAssign }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [stageF, setStageF] = useState("");                // "" | stage_key | "qc"
  const [attF, setAttF] = useState("all");                 // all | attention | critical | blocked
  const [workerF, setWorkerF] = useState("");
  const [expanded, setExpanded] = useState({});            // job id -> inline detail
  const [selected, setSelected] = useState(null);          // job id (full detail modal)
  const [printOpen, setPrintOpen] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    const r = await fetch("/api/production/schedule");
    if (!r.ok) {
      let m = null; try { m = (await r.json()).error; } catch { /* ignore */ }
      setErr(m || `Failed to load (${r.status})`); return;
    }
    setData(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const jobs = useMemo(() => data?.jobs || [], [data]);
  const kpi = useMemo(() => ({
    active: jobs.length,
    critical: jobs.filter((j) => worst(j.attention) === "critical").length,
    warning: jobs.filter((j) => worst(j.attention) === "warning").length,
    blocked: jobs.filter((j) => (j.blockers || []).length).length,
    short: jobs.filter((j) => (j.short_lines || []).length).length,
    qc: jobs.filter((j) => j.attention.some((a) => a.code === "qc_waiting")).length,
  }), [jobs]);

  const workers = useMemo(() => [...new Set(jobs.flatMap((j) => j.stages.flatMap((s) => s.workers || [])))].sort(), [jobs]);

  // All jobs, filtered. Sorted worst-first, then by production due.
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const sev = (j) => (worst(j.attention) === "critical" ? 0 : worst(j.attention) === "warning" ? 1 : 2);
    return jobs
      .filter((j) => !needle || [j.job_num, j.name, j.order_num, j.client].some((v) => (v || "").toLowerCase().includes(needle)))
      .filter((j) => !stageF || (stageF === "qc" ? (j.awaiting_qc_qty || 0) > 0 : currentStage(j)?.stage_key === stageF))
      .filter((j) => attF === "all" ? true : attF === "attention" ? j.attention.length > 0 : attF === "critical" ? worst(j.attention) === "critical" : (j.blockers || []).length > 0)
      .filter((j) => !workerF || j.stages.some((s) => (s.workers || []).includes(workerF)))
      .sort((a, b) => sev(a) - sev(b) || (a.production_due_date || "9999").localeCompare(b.production_due_date || "9999"));
  }, [jobs, q, stageF, attF, workerF]);

  const ready = useMemo(() => {
    const cols = Object.fromEntries(STAGE_ORDER.map((k) => [k, []]));
    for (const j of jobs) for (const s of j.stages) if (s.available > 0 && s.status !== "completed" && cols[s.stage_key]) {
      cols[s.stage_key].push({ job: j, available: s.available });
    }
    return cols;
  }, [jobs]);

  if (!data && !err) return <Loading />;
  if (err) return <div style={{ color: C.red, fontSize: 13 }}>{err} <Btn small onClick={load}>Retry</Btn></div>;

  const selectedJob = jobs.find((j) => j.id === selected) || null;
  const kpiBox = (label, value, tone) => (
    <div style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: C.radiusSm, padding: "8px 12px", minWidth: 96 }}>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone || C.ink }}>{value}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "stretch" }}>
        {kpiBox("Active jobs", kpi.active)}
        {kpiBox("Critical", kpi.critical, kpi.critical ? C.red : undefined)}
        {kpiBox("Warnings", kpi.warning, kpi.warning ? C.amber : undefined)}
        {kpiBox("Blocked", kpi.blocked)}
        {kpiBox("Materials short", kpi.short)}
        {kpiBox("QC waiting", kpi.qc)}
        <div style={{ marginLeft: "auto", alignSelf: "center" }}><Btn onClick={() => setPrintOpen(true)}>Print…</Btn></div>
      </div>

      {data.migration_pending && (
        <div style={{ background: C.amberBg, border: `1px solid ${C.amberBd}`, color: C.amber, borderRadius: C.radiusSm, padding: "9px 12px", fontSize: 13, marginBottom: 12 }}>
          Some production migrations (v2a–v2d) are not applied yet, so parts of this view are empty.
        </div>
      )}

      {/* Ready to work */}
      <h3 style={{ fontSize: 13, margin: "4px 0 8px", color: C.muted, textTransform: "uppercase", letterSpacing: ".04em" }}>Ready to work now</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginBottom: 18 }}>
        {STAGE_ORDER.map((k) => (
          <div key={k} style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: C.radiusSm, padding: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>{STAGE_NAMES[k]} <span style={{ color: C.muted, fontWeight: 500 }}>({ready[k].length})</span></div>
            {ready[k].length === 0 && <div style={{ fontSize: 12, color: C.faint }}>Nothing waiting</div>}
            {ready[k].slice(0, 6).map(({ job, available }) => (
              <button key={job.id} onClick={() => setSelected(job.id)} style={{ all: "unset", cursor: "pointer", display: "block", fontSize: 12, padding: "3px 0", width: "100%" }}>
                <b>{job.job_num}</b> <span style={{ color: C.muted }}>· {available} ready</span>
                {(job.blockers || []).length > 0 && <span style={{ color: C.red }}> · blocked</span>}
              </button>
            ))}
            {ready[k].length > 6 && <div style={{ fontSize: 11, color: C.muted }}>+{ready[k].length - 6} more</div>}
          </div>
        ))}
      </div>

      {/* All jobs — searchable control list */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ fontSize: 13, margin: 0, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em" }}>All jobs</h3>
        <input aria-label="Search jobs" placeholder="Search job, order or client" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ flex: "1 1 200px", minWidth: 160, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: C.radiusSm, fontSize: 13, fontFamily: "inherit", background: C.card, color: C.ink }} />
        <select aria-label="Filter by stage" value={stageF} onChange={(e) => setStageF(e.target.value)} style={selectStyle}>
          <option value="">Any stage</option>
          {STAGE_ORDER.map((k) => <option key={k} value={k}>{STAGE_NAMES[k]}</option>)}
          <option value="qc">Waiting for QC</option>
        </select>
        <select aria-label="Filter by attention" value={attF} onChange={(e) => setAttF(e.target.value)} style={selectStyle}>
          <option value="all">All jobs</option>
          <option value="attention">Needs attention</option>
          <option value="critical">Critical only</option>
          <option value="blocked">Blocked</option>
        </select>
        <select aria-label="Filter by worker" value={workerF} onChange={(e) => setWorkerF(e.target.value)} style={selectStyle}>
          <option value="">Any worker</option>
          {workers.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        {(q || stageF || attF !== "all" || workerF) && (
          <Btn small onClick={() => { setQ(""); setStageF(""); setAttF("all"); setWorkerF(""); }}>Clear</Btn>
        )}
        <span style={{ marginLeft: "auto", fontSize: 12, color: C.muted }}>{visible.length} of {jobs.length} jobs</span>
      </div>
      {visible.length === 0 ? (
        <div style={{ padding: "26px 10px", textAlign: "center", color: C.muted, fontSize: 13 }}>
          {jobs.length === 0 ? "No jobs on the shop floor. Jobs appear here once their production plan is activated." : "No jobs match these filters."}
        </div>
      ) : visible.map((j) => {
        const cur = currentStage(j);
        const open = !!expanded[j.id];
        const sev = worst(j.attention);
        return (
          <div key={j.id} style={{ border: `1px solid ${sev === "critical" ? C.redBd : C.line}`, background: C.card, borderRadius: C.radiusSm, padding: "9px 12px", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
              <button onClick={() => setExpanded((o) => ({ ...o, [j.id]: !o[j.id] }))} aria-expanded={open}
                style={{ all: "unset", cursor: "pointer", fontWeight: 700 }}>{open ? "▾" : "▸"} {j.job_num}</button>
              <span style={{ color: C.muted }}>{j.name}</span>
              <span style={{ color: C.muted, fontSize: 12 }}>{j.order_num || ""}{j.client ? ` · ${j.client}` : ""}</span>
              <span style={{ marginLeft: "auto", fontSize: 12, color: C.muted }}>
                Prod due {j.production_due_date ? fmtShortDate(j.production_due_date) : "not set"} · Customer {j.customer_due_date ? fmtShortDate(j.customer_due_date) : "not set"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 4, fontSize: 12.5 }}>
              <span><b>{cur ? cur.stage_label : (j.awaiting_qc_qty > 0 ? "QC" : "All stages done")}</b>
                {cur && cur.start ? <span style={{ color: C.muted }}> · {fmtShortDate(cur.start)} – {fmtShortDate(cur.end)}</span> : null}</span>
              <span style={{ color: C.muted }}>{j.accepted_qty}/{j.planned_quantity} accepted</span>
              {cur && (cur.workers || []).length > 0 && <span style={{ color: C.muted }}>{[...new Set(cur.workers)].join(", ")}</span>}
              {cur && !(cur.workers || []).length && cur.start && <span style={{ color: C.amber }}>No workers</span>}
              {j.attention.length > 0 && <span style={{ ...chip(sev), borderRadius: 6, padding: "1px 8px" }}>{j.attention.length} issue{j.attention.length === 1 ? "" : "s"}</span>}
              <span style={{ marginLeft: "auto" }}><Btn small onClick={() => setSelected(j.id)}>Open</Btn></span>
            </div>
            {open && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                {j.attention.length === 0 && <span style={{ fontSize: 12, color: C.faint }}>No issues</span>}
                {j.attention.map((a, i) => (
                  <span key={i} style={{ ...chip(a.severity), borderRadius: 6, padding: "2px 8px", fontSize: 12, alignSelf: "flex-start" }}>{a.message}</span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {selectedJob && (
        <SelectedJob
          job={selectedJob} canEdit={canEdit} canRecord={canRecord}
          onClose={() => setSelected(null)} onAssign={onAssign} onChanged={load}
          onPrint={() => setPrintOpen(true)}
        />
      )}
      {printOpen && <PrintChooser canEdit={canEdit} selectedJob={selectedJob} visibleJobs={visible} totalJobs={jobs.length} onClose={() => setPrintOpen(false)} />}
    </div>
  );
}

function SelectedJob({ job, canEdit, canRecord, onClose, onAssign, onChanged, onPrint }) {
  const [lines, setLines] = useState(null);
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState(null);

  const loadLines = useCallback(async () => {
    const r = await fetch(`/api/production/jobs/${job.id}/materials/readiness`);
    if (!r.ok) { setMsg(`Could not load materials (${r.status})`); setLines([]); return; }
    const d = await r.json();
    setLines(d.lines || []); setPending(!!d.migration_pending);
  }, [job.id]);
  useEffect(() => { loadLines(); }, [loadLines]);

  const mark = async (line, readiness) => {
    let note = "";
    if (readiness === "short") { note = window.prompt("What is short? (optional)", line.short_note || "") ?? ""; }
    setMsg(null);
    const r = await fetch(`/api/production/jobs/${job.id}/materials/readiness`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_id: line.id, readiness, note }),
    });
    if (!r.ok) { let m = null; try { m = (await r.json()).error; } catch { /* ignore */ } setMsg(m || `Could not save (${r.status})`); return; }
    await loadLines(); onChanged();
  };

  const seg = (line, value, label) => (
    <button disabled={!canRecord || pending} onClick={() => line.readiness !== value && mark(line, value)} style={{
      padding: "3px 9px", fontSize: 11.5, fontFamily: "inherit", cursor: canRecord && !pending ? "pointer" : "default",
      border: `1px solid ${line.readiness === value ? C.coral : C.line}`, background: line.readiness === value ? C.coralBg : C.card, borderRadius: 6, marginRight: 4,
    }}>{label}</button>
  );

  return (
    <Modal title={`${job.job_num} · ${job.name}`} onClose={onClose} wide
      footer={<><Btn onClick={onClose}>Close</Btn><Btn onClick={onPrint}>Print…</Btn></>}>
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
        {job.order_num || "—"}{job.client ? ` · ${job.client}` : ""} · Qty {job.planned_quantity} ·
        Production due <b style={{ color: C.ink }}>{job.production_due_date ? fmtShortDate(job.production_due_date) : "not set"}</b> ·
        Customer delivery <b style={{ color: C.ink }}>{job.customer_due_date ? fmtShortDate(job.customer_due_date) : "not set"}</b>
      </div>

      {job.attention.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 10 }}>
          {job.attention.map((a, i) => <span key={i} style={{ ...chip(a.severity), borderRadius: 6, padding: "2px 8px", fontSize: 12, alignSelf: "flex-start" }}>{a.message}</span>)}
        </div>
      )}

      <h4 style={{ margin: "8px 0 4px", fontSize: 12, color: C.muted, textTransform: "uppercase" }}>Stages</h4>
      <div>
        {job.stages.map((s) => (
          <div key={s.id} style={{ borderTop: `1px solid ${C.line}`, padding: "7px 2px", display: "flex", flexWrap: "wrap", gap: "2px 14px", alignItems: "center", fontSize: 12.5 }}>
            <b style={{ minWidth: 100 }}>{s.stage_label}</b>
            <span>{s.start ? `${fmtShortDate(s.start)} – ${fmtShortDate(s.end)}` : <span style={{ color: C.faint }}>Not scheduled</span>}</span>
            <span style={{ color: C.muted }}>{s.status.replace("_", " ")} · done {s.completed_quantity}/{s.planned_quantity} · ready {s.available}</span>
            <span style={{ flexBasis: "100%" }}>{[...new Set(s.workers)].join(", ") || <span style={{ color: C.faint }}>Unassigned</span>}</span>
            {canEdit && s.status !== "completed" && (
              <Btn small onClick={() => onAssign?.(job.id, s.stage_key)}>{(s.workers || []).length ? "Adjust team" : "Assign"}</Btn>
            )}
          </div>
        ))}
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "7px 2px", fontSize: 12.5, color: C.purple }}>
          ◆ QC gate: {job.awaiting_qc_qty || 0} waiting · {job.accepted_qty}/{job.planned_quantity} accepted{job.rework_qty > 0 ? ` · ${job.rework_qty} rework` : ""}
        </div>
      </div>

      <h4 style={{ margin: "14px 0 4px", fontSize: 12, color: C.muted, textTransform: "uppercase" }}>Blockers</h4>
      {(job.blockers || []).length === 0 ? <div style={{ fontSize: 12.5, color: C.faint }}>None open</div> : job.blockers.map((b) => (
        <div key={b.id} style={{ fontSize: 12.5, marginBottom: 4 }}>
          <b>{b.reason}</b> — owner {b.owner_name || "none"}, expected {b.expected_resolution_date ? fmtShortDate(b.expected_resolution_date) : "no date"}{b.supplier_po_ref ? `, ref ${b.supplier_po_ref}` : ""}
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: C.muted }}>Raise or resolve blockers from the Workshop Gantt.</div>

      <h4 style={{ margin: "14px 0 4px", fontSize: 12, color: C.muted, textTransform: "uppercase" }}>Materials readiness</h4>
      {lines === null ? <Loading /> : lines.length === 0 ? <div style={{ fontSize: 12.5, color: C.faint }}>No material lines on this job.</div> : lines.map((l) => (
        <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderTop: `1px solid ${C.line}`, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 160, fontSize: 12.5 }}>{l.material_name} <span style={{ color: C.muted }}>· {l.estimated_quantity} {l.unit}</span>{l.readiness === "short" && l.short_note ? <div style={{ color: C.red, fontSize: 11.5 }}>{l.short_note}</div> : null}</div>
          <div>{seg(l, "unchecked", "Unchecked")}{seg(l, "ready", "Ready")}{seg(l, "short", "Short")}</div>
        </div>
      ))}
      {pending && <div style={{ fontSize: 12, color: C.amber, marginTop: 6 }}>Readiness needs production_v2d_material_readiness.sql.</div>}
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>Marking a line short does not block the job or move dates — raise a blocker with an owner and expected date.</div>
      {canEdit && <MaterialActuals jobId={job.id} />}
      {msg && <div style={{ color: C.red, fontSize: 13, marginTop: 8 }}>{msg}</div>}
    </Modal>
  );
}

// Managers only: what was actually issued and at what unit cost. Feeds the internal pack.
function MaterialActuals({ jobId }) {
  const [lines, setLines] = useState(null);
  const [vals, setVals] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/production/jobs/${jobId}/materials/actuals`);
    let d = null; try { d = await r.json(); } catch { /* ignore */ }
    if (!r.ok) { setMsg(d?.error || `Could not load actuals (${r.status})`); setLines([]); return; }
    setLines(d.lines || []);
    setVals(Object.fromEntries((d.lines || []).map((l) => [l.id, { q: l.issued_quantity ?? "", c: l.actual_unit_cost ?? "" }])));
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  const save = async (l) => {
    setBusy(true); setMsg(null);
    const v = vals[l.id] || {};
    const r = await fetch(`/api/production/jobs/${jobId}/materials/actuals`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_id: l.id, issued_quantity: v.q === "" ? null : v.q, actual_unit_cost: v.c === "" ? null : v.c }),
    });
    setBusy(false);
    if (!r.ok) { let m = null; try { m = (await r.json()).error; } catch { /* ignore */ } setMsg(m || `Could not save (${r.status})`); return; }
    await load();
  };

  const inp = { width: 84, padding: "4px 6px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12.5, fontFamily: "inherit", background: C.card, color: C.ink };
  return (
    <>
      <h4 style={{ margin: "14px 0 4px", fontSize: 12, color: C.muted, textTransform: "uppercase" }}>Actual material used (managers)</h4>
      {lines === null ? <Loading /> : lines.length === 0 ? <div style={{ fontSize: 12.5, color: C.faint }}>No material lines.</div> : lines.map((l) => (
        <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderTop: `1px solid ${C.line}`, flexWrap: "wrap", fontSize: 12.5 }}>
          <div style={{ flex: 1, minWidth: 150 }}>{l.material_name} <span style={{ color: C.muted }}>· est {l.estimated_quantity} {l.unit}</span></div>
          <label style={{ color: C.muted, fontSize: 11 }}>Issued<br /><input aria-label={`Issued ${l.material_name}`} type="number" min="0" step="any" style={inp} value={vals[l.id]?.q ?? ""} onChange={(e) => setVals((o) => ({ ...o, [l.id]: { ...o[l.id], q: e.target.value } }))} /></label>
          <label style={{ color: C.muted, fontSize: 11 }}>Unit cost (KES)<br /><input aria-label={`Unit cost ${l.material_name}`} type="number" min="0" step="any" style={inp} value={vals[l.id]?.c ?? ""} onChange={(e) => setVals((o) => ({ ...o, [l.id]: { ...o[l.id], c: e.target.value } }))} /></label>
          <Btn small disabled={busy} onClick={() => save(l)}>Save</Btn>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>Leave blank if unknown — the internal pack then prints “Not recorded”, never 0.</div>
      {msg && <div style={{ color: C.red, fontSize: 13, marginTop: 6 }}>{msg}</div>}
    </>
  );
}

function PrintChooser({ canEdit, selectedJob, visibleJobs = [], totalJobs = 0, onClose }) {
  const [type, setType] = useState("card");
  const [scope, setScope] = useState(selectedJob ? "job" : "visible");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const go = async () => {
    setBusy(true); setErr(null);
    const qs = new URLSearchParams({ type, scope });
    if (scope === "job") qs.set("job_id", selectedJob.id);
    if (scope === "visible") qs.set("job_ids", visibleJobs.map((j) => j.id).join(","));
    if (scope === "order") qs.set("order_id", selectedJob.order_id);
    const r = await fetch(`/api/production/print?${qs}`);
    let d = null; try { d = await r.json(); } catch { /* ignore */ }
    setBusy(false);
    if (!r.ok) return setErr(d?.error || `Could not load print data (${r.status})`);
    const printedAt = new Date().toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
    const html = type === "card" ? buildShopFloorCards(d.jobs, { printedAt })
      : type === "shortage" ? buildShortageSheet(d.jobs, { printedAt })
      : buildInternalPack(d.jobs, { printedAt });
    if (openPrintWindow(html)) onClose();
  };

  const opt = (name, value, cur, set, title, desc, disabled) => (
    <label style={{ display: "block", border: `1px solid ${cur === value ? C.coral : C.line}`, background: cur === value ? C.coralBg : C.card, opacity: disabled ? 0.5 : 1,
      borderRadius: C.radiusSm, padding: "8px 12px", marginBottom: 6, cursor: disabled ? "not-allowed" : "pointer" }}>
      <input type="radio" name={name} disabled={disabled} checked={cur === value} onChange={() => set(value)} style={{ marginRight: 8 }} />
      <b style={{ fontSize: 13 }}>{title}</b><div style={{ fontSize: 12, color: C.muted, marginLeft: 22 }}>{desc}</div>
    </label>
  );

  return (
    <Modal title="Print" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy || ((scope === "job" || scope === "order") && !selectedJob)} onClick={go}>{busy ? "Preparing…" : "Print"}</Btn></>}>
      <div style={{ fontSize: 12, color: C.muted, textTransform: "uppercase", marginBottom: 4 }}>What</div>
      {opt("type", "card", type, setType, "Shop-floor card", "Stages, who, dates, materials, notes. No financial information.")}
      {opt("type", "shortage", type, setType, "Shortage sheet", "Only material lines marked short, with the blocker owner and expected date. No prices.")}
      {opt("type", "pack", type, setType, "Internal pack", canEdit ? "Managers only. Estimated material cost and payroll-allocated labour. Missing figures read “Not recorded”." : "Managers only.", !canEdit)}
      <div style={{ fontSize: 12, color: C.muted, textTransform: "uppercase", margin: "12px 0 4px" }}>Which jobs</div>
      {opt("scope", "job", scope, setScope, selectedJob ? `This job (${selectedJob.job_num})` : "This job", selectedJob ? selectedJob.name : "Open a job first to print just that one.", !selectedJob)}
      {opt("scope", "order", scope, setScope, selectedJob?.order_num ? `Whole order (${selectedJob.order_num})` : "Whole order", selectedJob ? "Every active job on this job's order." : "Open a job first to print its whole order.", !selectedJob?.order_id)}
      {opt("scope", "visible", scope, setScope, `Jobs shown in the list (${visibleJobs.length} of ${totalJobs})`, "Exactly what your current search and filters show.", visibleJobs.length === 0 || visibleJobs.length > 200)}
      {opt("scope", "all", scope, setScope, `All active jobs (${totalJobs})`, "Every job currently on the shop floor.", totalJobs === 0)}
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
