"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Btn, C, Empty, Loading, Notice, Panel, PanelHead, StatCard, fmtKes, fmtShortDate } from "@/shared/ui/ds";

const STATE_COLOR = { normal: "green", low_cash: "amber", shortfall: "red" };

export default function CashflowModule() {
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/cashflow/forecast", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "Could not load the forecast");
      setForecast(body.data);
    } catch (err) {
      setError(err.message || "Could not load the forecast");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24 }}><Loading /></div>;
  if (error) return (
    <div style={{ padding: 24 }}>
      <Notice color="red" style={{ marginBottom: 12 }}>{error}</Notice>
      <Btn onClick={load}>Retry</Btn>
    </div>
  );

  const weeks = forecast?.weeks || [];
  const first = weeks[0];
  const warnings = forecast?.warnings || [];

  return (
    <div style={{ padding: "24px 20px 40px", maxWidth: 1500, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, color: C.ink, fontSize: 24, letterSpacing: "-0.3px" }}>Cashflow</h1>
          <p style={{ margin: "5px 0 0", color: C.muted, fontSize: 13 }}>13-week view of expected collections, planned payments and cash risk.</p>
        </div>
        <Btn small onClick={load}>Refresh</Btn>
      </div>

      {forecast?.ledger_health?.is_provisional && (
        <Notice color="amber" style={{ marginBottom: 16 }}>
          This forecast is provisional. Review the warnings below before using it to approve or delay payments.
        </Notice>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 16 }}>
        <StatCard label="Available now" value={fmtKes(forecast?.opening_cash)} sub={forecast?.ledger_health?.is_provisional ? "Provisional" : "Reconciled inputs"} alert={forecast?.ledger_health?.is_provisional} />
        <StatCard label="Expected in · this week" value={fmtKes(first?.money_in?.weighted)} sub={`${fmtKes(first?.money_in?.gross)} gross`} />
        <StatCard label="Planned out · this week" value={fmtKes(first?.money_out?.total_planned)} sub={`${fmtKes(first?.money_out?.held)} held`} />
        <StatCard label="Shortfall weeks" value={forecast?.counts?.shortfall_weeks ?? 0} sub={forecast?.first_shortfall_week ? `First: ${fmtShortDate(forecast.first_shortfall_week.week_start)}` : "None in horizon"} alert={(forecast?.counts?.shortfall_weeks ?? 0) > 0} />
      </div>

      {warnings.length > 0 && (
        <Panel>
          <PanelHead title="Forecast warnings" sub="Items that affect how confidently these figures can be used" />
          <div style={{ padding: "10px 18px 14px", display: "grid", gap: 8 }}>
            {warnings.map((warning, index) => (
              <Notice key={`${warning.code}-${index}`} color={warning.severity === "critical" ? "red" : warning.severity === "warning" ? "amber" : "blue"}>
                {warning.message}
              </Notice>
            ))}
          </div>
        </Panel>
      )}

      {forecast?.receipt_methods && (
        <Panel>
          <PanelHead title="Cash not yet banked" sub="Cash and M-PESA receipts that have not reached the bank. Not part of the bank balance above." />
          <div style={{ padding: "10px 18px 14px", fontSize: 12.5 }}>
            {!forecast.receipt_methods.available ? (
              <Notice color="blue">Payment method data is not available yet — apply cashflow_r2_r5_support.sql.</Notice>
            ) : forecast.receipt_methods.unbanked_count === 0 ? (
              <span style={{ color: C.muted }}>No unbanked receipts recorded.{forecast.receipt_methods.unknown_method_count > 0 ? ` ${forecast.receipt_methods.unknown_method_count} older payment(s) have no method recorded and cannot be assessed.` : ""}</span>
            ) : (
              <>
                <div style={{ fontFamily: C.mono, fontWeight: 700, marginBottom: 8 }}>{fmtKes(forecast.receipt_methods.unbanked_total)} across {forecast.receipt_methods.unbanked_count} receipt(s)</div>
                <div style={{ display: "grid", gap: 4 }}>
                  {forecast.receipt_methods.unbanked.slice(0, 8).map((u) => (
                    <div key={u.payment_id} style={{ display: "flex", justifyContent: "space-between", gap: 12, color: u.days_unbanked >= forecast.receipt_methods.warn_after_days ? C.red : C.muted }}>
                      <span>{u.order_num || "Order"} · {u.customer_name || "—"} · {u.payment_method === "mpesa" ? "M-PESA" : "Cash"}</span>
                      <span style={{ fontFamily: C.mono }}>{fmtKes(u.amount)} · {u.days_unbanked}d</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Panel>
      )}

      {forecast?.statutory_coverage && (
        <Panel>
          <PanelHead title="Statutory coverage" sub="Which statutory payments the forecast actually includes. Estimated lines are manual figures." />
          <div style={{ padding: "10px 18px 14px", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(forecast.statutory_coverage).map(([type, v]) => (
              <Badge key={type} color={v.status === "tracked" ? "green" : v.status === "missing" ? "red" : "gray"}>
                {type.toUpperCase()} · {v.status === "tracked" ? (v.basis === "payroll_computed" ? "from payroll" : "Estimated") : v.status === "missing" ? "MISSING" : "not tracked"}
              </Badge>
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <PanelHead title="13-week forecast" sub="Weighted collections drive the official closing balance; committed BoQ appears in the downside view. Each week's state uses its lowest day, in whichever view is worse." />
        {weeks.length === 0 ? <Empty message="No forecast weeks are available." /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900, fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: C.muted, textAlign: "left" }}>
                  {['Week', 'Opening', 'Expected in', 'Planned out', 'Committed BoQ', 'Closing', 'Downside', 'State'].map(label => (
                    <th key={label} style={{ padding: "11px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map(week => (
                  <tr key={week.week_start}>
                    <td style={cell}>{fmtShortDate(week.week_start)}</td>
                    <td style={moneyCell}>{fmtKes(week.opening)}</td>
                    <td style={moneyCell}>{fmtKes(week.money_in.weighted)}</td>
                    <td style={moneyCell}>{fmtKes(week.money_out.total_planned)}</td>
                    <td style={moneyCell}>{fmtKes(week.committed_boq.net)}</td>
                    <td style={{ ...moneyCell, color: week.closing < 0 ? C.red : C.ink, fontWeight: 700 }}>{fmtKes(week.closing)}</td>
                    <td style={{ ...moneyCell, color: week.downside_closing < 0 ? C.red : C.muted }}>{fmtKes(week.downside_closing)}</td>
                    <td style={cell}>
                      <Badge color={STATE_COLOR[week.state] || "gray"}>{week.state_label}</Badge>
                      {week.state_basis && (
                        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 3 }} title="State is set by the lowest day of the week, in the worse of the official and downside views.">
                          Low {fmtKes(week.state_basis.balance)} · {fmtShortDate(week.state_basis.date)}{week.state_basis.chain === "downside" ? " (downside)" : ""}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

const cell = { padding: "12px 14px", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" };
const moneyCell = { ...cell, fontFamily: C.mono, textAlign: "right" };
