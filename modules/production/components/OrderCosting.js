"use client";

/**
 * OrderCostingPanel — one order-level costing view: Planned / Actual / Variance by category, the
 * attendance-vs-payroll labour sources, per-job totals, then revenue (ex-VAT) − actual direct costs = gross profit.
 * Managers only (the API returns 403 otherwise). All figures are calculated on the server.
 */

import { useState, useEffect, useCallback } from "react";
import { C, Loading, fmtKes } from "@/shared/ui/ds";

const ROWS = [
  ["materials", "Materials"], ["labour", "Internal labour"], ["machine", "Machine time"],
  ["outsourced", "Outsourced services"], ["packaging", "Packaging"], ["delivery", "Delivery / installation / other direct"],
];
const th = { textAlign: "right", padding: "4px 8px", fontSize: 11, color: C.muted, fontWeight: 600 };
const td = { textAlign: "right", padding: "5px 8px", fontSize: 13, borderTop: `1px solid ${C.line}` };
const money = (v) => (v == null ? "—" : fmtKes(v));
const varOf = (p, a) => (p == null || a == null ? "—" : `${a - p > 0 ? "+" : ""}${fmtKes(a - p)}`);

export default function OrderCostingPanel({ orderId }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    setErr(null);
    const r = await fetch(`/api/orders/${orderId}/production-costing`);
    let b = null; try { b = await r.json(); } catch { /* ignore */ }
    if (!r.ok) { setErr(b?.error || `Could not load costing (${r.status})`); return; }
    setD(b);
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  if (err) return <div style={{ color: C.red, fontSize: 13 }}>{err} <button onClick={load} style={{ marginLeft: 8 }}>Retry</button></div>;
  if (!d) return <Loading />;
  const r = d.rollup, lab = d.labour;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {d.migration_pending && <div style={{ color: C.amber, fontSize: 13 }}>Some costing migrations have not been applied yet — figures may be incomplete.</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
          <thead><tr><th style={{ ...th, textAlign: "left" }}>Category</th><th style={th}>Planned</th><th style={th}>Actual</th><th style={th}>Variance</th></tr></thead>
          <tbody>
            {ROWS.map(([k, label]) => {
              const x = r.rows[k];
              return (
                <tr key={k}>
                  <td style={{ ...td, textAlign: "left" }}>{label}{x.provisional && <span style={{ color: C.amber, fontSize: 11 }}> · Provisional</span>}</td>
                  <td style={td}>{money(x.planned)}</td>
                  <td style={td}>{k === "labour" && x.actual == null ? <span style={{ color: C.faint }}>no approved attendance</span> : money(x.actual)}</td>
                  <td style={td}>{varOf(x.planned, x.actual)}</td>
                </tr>
              );
            })}
            <tr>
              <td style={{ ...td, textAlign: "left", fontWeight: 700 }}>Total direct cost</td>
              <td style={{ ...td, fontWeight: 700 }}>{money(r.total_planned)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{money(r.total_actual)}{r.actual_is_incomplete && <span style={{ color: C.red, fontSize: 11 }}> excludes labour</span>}</td>
              <td style={{ ...td, fontWeight: 700 }}>{varOf(r.total_planned, r.total_actual)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", fontSize: 13, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
        <span>Revenue (ex-VAT): <b>{money(r.revenue_ex_vat)}</b></span>
        <span>Gross profit: <b style={{ color: r.gross_profit != null && r.gross_profit < 0 ? C.red : C.ink }}>{money(r.gross_profit)}</b>{r.actual_is_incomplete && <span style={{ color: C.red, fontSize: 11 }}> overstated — labour not yet approved</span>}</span>
        <span>Gross margin: <b>{r.gross_margin_pct != null ? `${r.gross_margin_pct}%` : "n/a"}</b></span>
      </div>
      {r.actual_is_incomplete && (
        <div style={{ fontSize: 13, color: C.amber }}>Provisional forecast (planned labour standing in): cost <b>{fmtKes(r.forecast_total)}</b> · gross profit <b>{money(r.forecast_gross_profit)}</b> · margin <b>{r.forecast_margin_pct != null ? `${r.forecast_margin_pct}%` : "n/a"}</b></div>
      )}

      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 4 }}>Labour sources</div>
        {lab.rows.length === 0 ? <div style={{ fontSize: 13, color: C.faint }}>No approved attendance or payroll allocations on this order.</div> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {lab.rows.map((x, i) => (
                <tr key={i}><td style={{ ...td, textAlign: "left" }}>{x.employee_name || "—"}</td>
                  <td style={{ ...td, textAlign: "left", color: C.muted }}>{x.source === "attendance" ? "Approved attendance" : "Payroll allocation"}{x.provisional && <span style={{ color: C.amber }}> · Provisional</span>}</td>
                  <td style={td}>{fmtKes(x.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {lab.superseded_payroll.length > 0 && (
          <div style={{ fontSize: 12, color: C.faint, marginTop: 4 }}>
            Not counted (superseded by attendance): {lab.superseded_payroll.map((s) => `${s.worker_name || "worker"} ${fmtKes(s.amount)}`).join(", ")}.
          </div>
        )}
        {lab.approved_entries_missing_cost > 0 && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{lab.approved_entries_missing_cost} approved entr{lab.approved_entries_missing_cost === 1 ? "y has" : "ies have"} no cost (rate missing).</div>}
      </div>

      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 4 }}>By job</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={{ ...th, textAlign: "left" }}>Job</th><th style={th}>Planned</th><th style={th}>Actual</th></tr></thead>
          <tbody>
            {d.jobs.map((j) => (
              <tr key={j.job_id}><td style={{ ...td, textAlign: "left" }}>{j.job_num} <span style={{ color: C.faint, fontSize: 11 }}>{j.status}</span></td>
                <td style={td}>{money(j.total_planned)}</td>
                <td style={td}>{money(j.total_actual)}{j.actual_is_incomplete && <span style={{ color: C.red, fontSize: 11 }}> excl. labour</span>}</td></tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4 }}>Job-level labour counts approved attendance only; order-level labour above also includes payroll allocations for workers with no attendance.</div>
      </div>
      <div style={{ fontSize: 11.5, color: C.faint }}>{d.notes.join(" ")}</div>
    </div>
  );
}
