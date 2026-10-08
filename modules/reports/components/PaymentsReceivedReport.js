"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import { createClient } from "@/shared/supabase/client";
import { useAuth } from "@/shared/context/AuthContext";
import { C, Panel, PanelHead, StatCard, Notice, Empty, Loading } from "@/shared/ui/ds";
import { fetchAllRows } from "@/shared/lib/reports/fetchAll";
import { PAYMENT_COLUMNS } from "@/shared/lib/reports/paymentsReceived";
import { describePeriod, formatDay } from "@/shared/lib/customerReport";
import { CustomerPicker } from "@/modules/customers/components/ReportControls";
import { PeriodButton, ExportButtons, Segmented } from "./ReportBar";
import { exportPdf, exportCsv, slug } from "./reportExport";

const kes = n => `KES ${Math.round(n || 0).toLocaleString("en-KE")}`;
const kes2 = n => (n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "What was paid between day X and day Y" — customer payments received (or banked)
// in a period. All totals come from the server (/api/reports/payments-received).
export default function PaymentsReceivedReport({ range, today, onRangeChange }) {
  const { displayName } = useAuth();
  const [basis, setBasis] = useState("received");
  const [customerId, setCustomerId] = useState(null);
  const [method, setMethod] = useState("");
  const [customers, setCustomers] = useState([]);
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [nonce, setNonce] = useState(0);

  // Customer list for the picker (once).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const sb = createClient();
        const rows = await fetchAllRows(
          (a, b) => sb.from("customers").select("id,name,phone,email,contact_person").order("name").order("id").range(a, b),
          { label: "customers" },
        );
        if (live) setCustomers(rows);
      } catch { /* picker simply stays empty; the report itself still works */ }
    })();
    return () => { live = false; };
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams({ from: range.from || "", to: range.to || "", basis });
    if (customerId) p.set("customerId", customerId);
    if (method) p.set("method", method);
    return p.toString();
  }, [range, basis, customerId, method]);

  const bounded = !!(range.from && range.to);

  useEffect(() => {
    if (!bounded) { setState({ loading: false, error: "", data: null }); return undefined; }
    const ctl = new AbortController();
    setState(s => ({ ...s, loading: true, error: "" }));
    (async () => {
      try {
        const res = await fetch(`/api/reports/payments-received?${query}`, { signal: ctl.signal });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Could not load the report.");
        setState({ loading: false, error: "", data: json.data });
      } catch (e) {
        if (e.name === "AbortError") return;
        setState({ loading: false, error: e.message, data: null });
      }
    })();
    return () => ctl.abort();
  }, [query, bounded, nonce]);

  const { loading, error, data } = state;
  const columnsMissing = !!data?.columnsMissing;

  const filename = ext => `Payments_Received_${range.from || "start"}_to_${range.to || "now"}.${ext}`;

  const onPdf = useCallback(async () => {
    setBusy(true); setExportError("");
    try {
      await exportPdf({
        reportLabel: "Payments Received",
        paymentsReceived: data,
        filters: {
          period: describePeriod(range),
          basis: basis === "banked" ? "Banked date" : "Received date",
          customer: customers.find(c => c.id === customerId)?.name || "All customers",
          method: method || "All methods",
        },
        userName: displayName,
      }, filename("pdf"));
    } catch (e) { setExportError(e.message); }
    setBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, range, basis, customerId, method, customers, displayName]);

  const onCsv = () => {
    setExportError("");
    try { exportCsv(PAYMENT_COLUMNS, data.rows, filename("csv")); }
    catch (e) { setExportError(e.message); }
  };

  const methods = useMemo(() => (data?.byMethod || []).map(m => m.name), [data]);
  const s = data?.summary;
  const noRows = !loading && !error && data && data.rows.length === 0;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <PeriodButton
          range={range} today={today} onChange={onRangeChange}
          subject={basis === "banked" ? "payments banked" : "payments received"} title="Payments period"
        />
        <Segmented
          label="Date basis" value={basis} onChange={setBasis}
          options={[
            { value: "received", label: "Received date", title: "The day the customer paid" },
            { value: "banked", label: "Banked date", disabled: columnsMissing, title: columnsMissing ? "Needs the cashflow_r2_r5_support migration" : "The day it reached the bank or till account" },
          ]}
        />
        <CustomerPicker customers={customers} value={customerId} onChange={setCustomerId} allLabel="All customers" />
        <select
          aria-label="Payment method" value={method} onChange={e => setMethod(e.target.value)}
          style={{ minHeight: 38, border: `1px solid ${C.line}`, borderRadius: C.radiusSm, padding: "6px 10px", fontSize: 13, background: C.card, color: C.ink, fontFamily: "inherit" }}
        >
          <option value="">All methods</option>
          {["Cash", "M-Pesa", "Bank Transfer", "Cheque", "Other", "Unspecified"].map(m => <option key={m} value={m}>{m}</option>)}
          {methods.filter(m => !["Cash", "M-Pesa", "Bank Transfer", "Cheque", "Other", "Unspecified"].includes(m)).map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <div style={{ marginLeft: "auto" }}>
          <ExportButtons onPdf={onPdf} onCsv={onCsv} busy={busy} disabled={!data || data.rows.length === 0} />
        </div>
      </div>

      {!bounded && <Notice color="amber">Choose a start and end date. "All time" is not available for this report.</Notice>}
      {error && (
        <Notice color="red" style={{ marginBottom: 12 }}>
          {error}{" "}
          <button type="button" onClick={() => setNonce(n => n + 1)} style={{ marginLeft: 6, background: "none", border: "none", color: "inherit", textDecoration: "underline", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", padding: 0 }}>Retry</button>
        </Notice>
      )}
      {exportError && <Notice color="red" style={{ marginBottom: 12 }}>{exportError}</Notice>}
      {columnsMissing && (
        <Notice color="amber" style={{ marginBottom: 12 }}>
          Payment methods and banked dates are not recorded yet (the cashflow_r2_r5_support migration has not been applied), so every payment shows as "Unspecified".
        </Notice>
      )}

      {loading && <Loading />}

      {!loading && data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 14 }}>
            <StatCard label={basis === "banked" ? "Banked" : "Received"} value={kes(s.total)} sub={`${s.count} payment${s.count === 1 ? "" : "s"}`} mono />
            <StatCard label="Average payment" value={kes(s.average)} mono />
            <StatCard label="Largest payment" value={kes(s.largest)} mono />
            {data.unbanked && <StatCard label="Received, not banked" value={kes(data.unbanked.total)} sub={`${data.unbanked.count} payment${data.unbanked.count === 1 ? "" : "s"}`} alert={data.unbanked.total > 0} mono />}
          </div>

          {(data.reversed.count > 0 || data.excluded.count > 0) && (
            <Notice color="blue" style={{ marginBottom: 14 }}>
              Not in the total above:{" "}
              {data.reversed.count > 0 && <>{data.reversed.count} reversed payment{data.reversed.count === 1 ? "" : "s"} ({kes(data.reversed.total)})</>}
              {data.reversed.count > 0 && data.excluded.count > 0 && "; "}
              {data.excluded.count > 0 && <>{data.excluded.count} payment{data.excluded.count === 1 ? "" : "s"} on cancelled or suspended orders ({kes(data.excluded.total)})</>}.
            </Notice>
          )}

          {noRows ? (
            <Panel><Empty message={`No payments ${basis === "banked" ? "banked" : "received"} in this period.`} /></Panel>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginBottom: 6 }}>
                <Breakdown title="By method" rows={data.byMethod} total={s.total} />
                <Breakdown title="By customer" rows={data.byCustomer.slice(0, 8)} total={s.total} more={Math.max(0, data.byCustomer.length - 8)} />
              </div>

              <Panel>
                <PanelHead title="Daily totals" sub={`${data.byDay.length} day${data.byDay.length === 1 ? "" : "s"} with payments`} />
                <div style={{ overflowX: "auto" }}>
                  <table style={tbl}>
                    <thead><tr style={headRow}><th style={th}>Date</th><th style={{ ...th, textAlign: "right" }}>Payments</th><th style={{ ...th, textAlign: "right" }}>Total (KES)</th></tr></thead>
                    <tbody>
                      {data.byDay.map(d => (
                        <tr key={d.date} style={bodyRow}>
                          <td style={td}>{formatDay(d.date)}</td>
                          <td style={{ ...td, textAlign: "right" }}>{d.count}</td>
                          <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700 }}>{kes2(d.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <Panel>
                <PanelHead title="All payments" sub={`${data.rows.length} in ${describePeriod(range)}`} />
                <div style={{ overflowX: "auto" }}>
                  <table style={tbl}>
                    <thead>
                      <tr style={headRow}>
                        <th style={th}>Date</th><th style={th}>Customer</th><th style={th}>Order</th><th style={th}>Invoice</th>
                        <th style={th}>Method</th><th style={th}>Reference</th><th style={{ ...th, textAlign: "right" }}>Amount (KES)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map(r => (
                        <tr key={r.id} style={bodyRow}>
                          <td style={td}>{formatDay(r.date)}</td>
                          <td style={{ ...td, fontWeight: 700 }}>{r.customer}</td>
                          <td style={{ ...td, fontFamily: C.mono, fontSize: 12 }}>{r.order_num || "—"}</td>
                          <td style={{ ...td, fontFamily: C.mono, fontSize: 12 }}>{r.invoice_number || "—"}</td>
                          <td style={td}>{r.method}</td>
                          <td style={{ ...td, color: C.muted, fontSize: 12 }}>{r.reference || "—"}</td>
                          <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700 }}>{kes2(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: C.ink, color: "#fff" }}>
                        <td colSpan={6} style={{ ...td, fontWeight: 700 }}>Total</td>
                        <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700 }}>{kes2(s.total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Panel>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Breakdown({ title, rows, total, more = 0 }) {
  return (
    <Panel>
      <PanelHead title={title} />
      <div style={{ padding: "6px 18px 14px" }}>
        {rows.map(r => {
          const pct = total > 0 ? Math.round((r.total / total) * 100) : 0;
          return (
            <div key={r.name} style={{ padding: "8px 0", borderBottom: `1px solid ${C.line}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                <span style={{ fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontFamily: C.mono, whiteSpace: "nowrap" }}>{kes(r.total)} <span style={{ color: C.muted }}>· {pct}%</span></span>
              </div>
              <div style={{ height: 5, background: C.sunken, borderRadius: 3, marginTop: 6 }} aria-hidden="true">
                <div style={{ width: `${pct}%`, height: "100%", background: C.coral, borderRadius: 3 }} />
              </div>
            </div>
          );
        })}
        {more > 0 && <div style={{ fontSize: 12, color: C.muted, paddingTop: 8 }}>+ {more} more in the full list below</div>}
      </div>
    </Panel>
  );
}

const tbl = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const headRow = { background: C.ink, color: "#fff", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" };
const bodyRow = { borderBottom: `1px solid ${C.line}` };
const th = { padding: "10px 12px", textAlign: "left", fontWeight: 600 };
const td = { padding: "9px 12px", verticalAlign: "top" };
