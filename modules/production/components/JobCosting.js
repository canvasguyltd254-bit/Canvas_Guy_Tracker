"use client";

/**
 * JobCostingPanel — planned vs actual cost for one job, with labour drill-down by stage.
 * Managers only (the API redacts every money figure for other roles).
 * Everything shown is calculated on the server (GET /api/production/jobs/:id/costing).
 */

import { useState, useEffect, useCallback } from "react";
import { C, Loading, fmtKes } from "@/shared/ui/ds";

const LABELS = { materials: "Materials", labour: "Internal labour", machine: "Machine time", outsourced: "Outsourced services", packaging: "Packaging" };
const ORDER = ["materials", "labour", "machine", "outsourced", "packaging"];
const th = { textAlign: "right", padding: "4px 8px", fontSize: 11, color: C.muted, fontWeight: 600 };
const td = { textAlign: "right", padding: "5px 8px", fontSize: 13, borderTop: `1px solid ${C.line}` };

export default function JobCostingPanel({ jobId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    const r = await fetch(`/api/production/jobs/${jobId}/costing`);
    let d = null; try { d = await r.json(); } catch { /* ignore */ }
    if (!r.ok) { setErr(d?.error || `Could not load costing (${r.status})`); return; }
    setData(d);
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  const box = { background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius, padding: "14px 16px", marginBottom: 16 };
  if (err) return <div style={{ ...box, color: C.red, fontSize: 13 }}>{err}</div>;
  if (!data) return <div style={box}><Loading /></div>;
  const c = data.costing;
  if (c.total_planned == null) return null;           // redacted for this role

  const money = (v) => (v == null ? <span style={{ color: C.faint }}>—</span> : fmtKes(v));
  const variance = (planned, actual) => {
    if (actual == null) return <span style={{ color: C.faint }}>—</span>;
    const d = Math.round((actual - planned) * 100) / 100;
    return <span style={{ color: d > 0 ? C.red : d < 0 ? C.green : C.muted }}>{d > 0 ? "+" : d < 0 ? "−" : ""}{fmtKes(Math.abs(d))}</span>;
  };
  const lab = c.categories.labour;

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>Costing</b>
        <span style={{ fontSize: 12, color: C.muted }}>planned vs actual · confidential</span>
        <button onClick={() => setOpen(o => !o)} style={{ all: "unset", cursor: "pointer", marginLeft: "auto", color: C.coral, fontSize: 12.5, fontWeight: 600 }}>
          {open ? "Hide stage detail" : "Labour by stage"}
        </button>
      </div>

      {data.migration_pending && <div style={{ fontSize: 12.5, color: C.amber, marginBottom: 8 }}>Some costing data needs migrations production_v2f and production_v3a — figures below are incomplete.</div>}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
          <thead><tr><th style={{ ...th, textAlign: "left" }}>Category</th><th style={th}>Planned</th><th style={th}>Actual</th><th style={th}>Variance</th></tr></thead>
          <tbody>
            {ORDER.map((k) => {
              const x = c.categories[k];
              const actual = k === "labour" ? x.actual : x.actual;
              return (
                <tr key={k}>
                  <td style={{ ...td, textAlign: "left" }}>{LABELS[k]}
                    {k !== "labour" && x.provisional && <span style={{ color: C.amber, fontSize: 11 }}> · estimate used where actual not recorded</span>}
                  </td>
                  <td style={td}>{money(x.planned)}</td>
                  <td style={td}>{k === "labour" && actual == null ? <span style={{ color: C.faint }}>no approved time</span> : money(actual)}</td>
                  <td style={td}>{variance(x.planned, actual)}</td>
                </tr>
              );
            })}
            <tr>
              <td style={{ ...td, textAlign: "left", fontWeight: 700 }}>Total production cost</td>
              <td style={{ ...td, fontWeight: 700 }}>{money(c.total_planned)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{money(c.total_actual)}{c.actual_is_provisional ? <span style={{ color: C.amber, fontSize: 11 }}> provisional</span> : null}{c.actual_is_incomplete ? <span style={{ color: C.red, fontSize: 11 }}> excludes labour (none approved)</span> : null}</td>
              <td style={{ ...td, fontWeight: 700 }}>{variance(c.total_planned, c.total_actual)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 12.5, color: C.muted, marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
        <span>Labour plan comes from {lab.planned_source === "assignments" ? "worker assignments" : lab.planned_source === "boq" ? "the BoQ internal-labour estimate (no worker days planned yet)" : "nothing yet — plan attendance days on the worker assignments"}.
          {lab.superseded_boq != null && <> The BoQ labour estimate of {fmtKes(lab.superseded_boq)} is replaced by it and not added.</>}</span>
        {lab.assignments_missing_rate > 0 && <span style={{ color: C.red }}>Rate missing for {lab.assignments_missing_rate} assignment{lab.assignments_missing_rate === 1 ? "" : "s"} — not costed (not counted as 0).</span>}
        {lab.assignments_without_plan > 0 && <span>{lab.assignments_without_plan} assignment{lab.assignments_without_plan === 1 ? " has" : "s have"} no planned days.</span>}
        {lab.pending_entries > 0 && <span style={{ color: C.amber }}>{lab.pending_entries} time entr{lab.pending_entries === 1 ? "y" : "ies"} ({lab.pending_units} day{lab.pending_units === 1 ? "" : "s"}) awaiting approval — not yet in actual labour.</span>}
        {lab.approved_entries_missing_cost > 0 && <span style={{ color: C.red }}>{lab.approved_entries_missing_cost} approved entr{lab.approved_entries_missing_cost === 1 ? "y has" : "ies have"} no cost.</span>}
        {lab.actual != null && <span>Approved attendance: {lab.actual_units.weekday} weekday day{lab.actual_units.weekday === 1 ? "" : "s"} ({lab.actual_units.overtime} with overtime allowance) + {lab.actual_units.sunday} Sunday day{lab.actual_units.sunday === 1 ? "" : "s"}.</span>}
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {c.stages.length === 0 ? <div style={{ fontSize: 12.5, color: C.faint }}>No stage has planned or actual labour yet.</div> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={{ ...th, textAlign: "left" }}>Stage</th><th style={th}>Planned</th><th style={th}>Actual</th><th style={th}>Variance</th></tr></thead>
              <tbody>{c.stages.map((s) => (
                <tr key={s.stage_id}><td style={{ ...td, textAlign: "left" }}>{s.stage_label}</td><td style={td}>{money(s.planned)}</td><td style={td}>{money(s.actual)}</td><td style={td}>{variance(s.planned, s.actual)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}`, display: "flex", gap: 22, flexWrap: "wrap", fontSize: 13 }}>
        <span>Selling value (ex-VAT): <b>{c.selling_value != null ? fmtKes(c.selling_value) : "n/a"}</b></span>
        <span>Gross profit (actual): <b style={{ color: c.gross_profit != null && c.gross_profit < 0 ? C.red : C.ink }}>{c.gross_profit != null ? fmtKes(c.gross_profit) : "n/a"}</b>{c.actual_is_incomplete ? <span style={{ color: C.red, fontSize: 11 }}> overstated — labour not yet approved</span> : null}</span>
        <span>Gross margin (actual): <b>{c.gross_margin_pct != null ? `${c.gross_margin_pct}%` : "n/a"}</b></span>
      </div>
      {c.actual_is_incomplete && (
        <div style={{ marginTop: 6, fontSize: 13, color: C.amber }}>
          Provisional forecast (planned labour standing in): cost <b>{fmtKes(c.forecast_total)}</b> · gross profit <b>{c.forecast_gross_profit != null ? fmtKes(c.forecast_gross_profit) : "n/a"}</b> · margin <b>{c.forecast_margin_pct != null ? `${c.forecast_margin_pct}%` : "n/a"}</b>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4 }}>{(data.notes || []).join(" ")}{c.actual_is_provisional ? " Some material/other actuals are estimates (provisional)." : ""} Planned labour is never counted as actual.</div>
    </div>
  );
}
