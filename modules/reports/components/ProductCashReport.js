"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useAuth } from "@/shared/context/AuthContext";
import { C, Panel, PanelHead, StatCard, Notice, Empty, Loading } from "@/shared/ui/ds";
import { describePeriod } from "@/shared/lib/customerReport";
import { sortRows } from "@/shared/lib/reports/orderRules";
import { PRODUCT_CASH_COLUMNS } from "@/shared/lib/reports/productCash";
import { PeriodButton, ExportButtons } from "./ReportBar";
import { exportPdf, exportCsv } from "./reportExport";
import { SortTh, useSort } from "./SortTh";

const kes = n => `KES ${Math.round(n || 0).toLocaleString("en-KE")}`;
const num = n => Math.round(n || 0).toLocaleString("en-KE");
const pc = n => (n === null || n === undefined ? "—" : `${Number(n).toFixed(1)}%`);

// What each item category has brought in. Cash is ALLOCATED across an order's
// lines by value (customers pay against orders, not items). The right-hand
// columns describe orders RAISED in the period, not the same cash. Server:
// /api/reports/product-cash.
export default function ProductCashReport({ range, today, onRangeChange }) {
  const { displayName } = useAuth();
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [nonce, setNonce] = useState(0);
  const { sort, toggle } = useSort({ field: "cash", dir: "desc" });
  const bounded = !!(range.from && range.to);

  useEffect(() => {
    if (!bounded) { setState({ loading: false, error: "", data: null }); return undefined; }
    const ctl = new AbortController();
    setState(s => ({ ...s, loading: true, error: "" }));
    (async () => {
      try {
        const res = await fetch(`/api/reports/product-cash?from=${range.from}&to=${range.to}`, { signal: ctl.signal });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Could not load the report.");
        setState({ loading: false, error: "", data: json.data });
      } catch (e) {
        if (e.name === "AbortError") return;
        setState({ loading: false, error: e.message, data: null });
      }
    })();
    return () => ctl.abort();
  }, [range, bounded, nonce]);

  const { loading, error, data } = state;
  const rows = useMemo(() => (data ? sortRows(data.rows, sort.field, sort.dir, (r, f) => r[f]) : []), [data, sort]);
  const file = ext => `Cash_by_Product_${range.from || "start"}_to_${range.to || "now"}.${ext}`;

  const onPdf = useCallback(async () => {
    setBusy(true); setExportError("");
    try {
      await exportPdf({ reportLabel: "Cash by Product", productCash: data, filters: { period: describePeriod(range) }, userName: displayName }, file("pdf"));
    } catch (e) { setExportError(e.message); }
    setBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, range, displayName]);

  const onCsv = () => {
    setExportError("");
    try { exportCsv(PRODUCT_CASH_COLUMNS, data.rows, file("csv")); } catch (e) { setExportError(e.message); }
  };

  const rc = data?.reconciliation, t = data?.totals, fl = data?.flags;
  const empty = !loading && !error && data && data.rows.length === 0 && !(rc.unallocated > 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <PeriodButton range={range} today={today} onChange={onRangeChange} subject="payments and orders dated" title="Cash by product period" />
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
      {loading && <Loading />}

      {!loading && data && (
        <>
          <Notice color="blue" style={{ marginBottom: 12 }}>
            Customers pay against orders, not items, so cash per category is <b>allocated</b>: each payment is split across the order's lines by value. The columns from Orders raised onward describe orders created in the period, with money collected to date, so they will not equal the cash column.
          </Notice>

          {rc.ok === false && (
            <Notice color="red" style={{ marginBottom: 12 }}>
              Allocated cash differs from the Payments Received total by {kes(Math.abs(rc.difference))}. Do not rely on this report until that is explained.
            </Notice>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 14 }}>
            <StatCard label="Cash received" value={kes(rc.total)} sub={rc.ok ? "Matches Payments Received" : "Allocated total"} mono />
            <StatCard label="Orders raised" value={kes(t.invoiced)} sub={`${fl.cohortOrders} invoiced order${fl.cohortOrders === 1 ? "" : "s"}`} mono />
            <StatCard label="Outstanding" value={kes(t.outstanding)} sub="On those orders" alert={t.outstanding >= 0.5} mono />
            <StatCard label="Est. margin" value={pc(t.margin)} sub={t.margin === null ? "No costs recorded" : kes(t.profit)} mono />
          </div>

          {(rc.unallocated > 0 || rc.excluded > 0 || fl.ordersWithoutLines > 0 || fl.estimatedOrders > 0 || fl.uncostedOrders > 0) && (
            <Notice color="amber" style={{ marginBottom: 14 }}>
              {rc.unallocated > 0 && <div>{kes(rc.unallocated)} of cash ({rc.unallocatedPayments} payment{rc.unallocatedPayments === 1 ? "" : "s"}) is on orders with no priced lines, so it cannot be put in a category.</div>}
              {rc.excluded > 0 && <div>{kes(rc.excluded)} was paid on cancelled or suspended orders and is not counted.</div>}
              {fl.ordersWithoutLines > 0 && <div>{fl.ordersWithoutLines} invoiced order{fl.ordersWithoutLines === 1 ? "" : "s"} ({kes(fl.ordersWithoutLinesValue)}) have no priced lines and are missing from the category columns.</div>}
              {fl.uncostedOrders > 0 && <div>{fl.uncostedOrders} of {fl.cohortOrders} orders have no costs recorded yet, so margins here are overstated until costs are linked.</div>}
              {fl.estimatedOrders > 0 && <div>{fl.estimatedOrders} order{fl.estimatedOrders === 1 ? "" : "s"} predate VAT line snapshots; their revenue is estimated as total / 1.16.</div>}
            </Notice>
          )}

          {empty ? (
            <Panel><Empty message="No payments or invoiced orders in this period." /></Panel>
          ) : (
            <Panel>
              <PanelHead title="By item category" sub={`${data.rows.length} categor${data.rows.length === 1 ? "y" : "ies"} · ${describePeriod(range)}`} />
              <div style={{ overflowX: "auto" }}>
                <table style={tbl}>
                  <thead>
                    <tr style={headRow}>
                      <SortTh field="category" sort={sort} onSort={toggle} style={th}>Category</SortTh>
                      <SortTh field="cash" sort={sort} onSort={toggle} style={{ ...th, textAlign: "right" }} right>Cash received</SortTh>
                      <SortTh field="orders" sort={sort} onSort={toggle} style={{ ...th, textAlign: "right" }} right>Orders raised</SortTh>
                      <SortTh field="units" sort={sort} onSort={toggle} style={{ ...th, textAlign: "right" }} right>Units</SortTh>
                      <SortTh field="invoiced" sort={sort} onSort={toggle} style={{ ...th, textAlign: "right" }} right>Invoiced</SortTh>
                      <SortTh field="collected" sort={sort} onSort={toggle} style={{ ...th, textAlign: "right" }} right>Collected</SortTh>
                      <SortTh field="outstanding" sort={sort} onSort={toggle} style={{ ...th, textAlign: "right" }} right>Outstanding</SortTh>
                      <SortTh field="revenue" sort={sort} onSort={toggle} style={{ ...th, textAlign: "right" }} right>Revenue ex-VAT</SortTh>
                      <SortTh field="profit" sort={sort} onSort={toggle} style={{ ...th, textAlign: "right" }} right>Est. margin</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.category} style={bodyRow}>
                        <td style={{ ...td, fontWeight: 700 }}>{r.category}</td>
                        <td style={{ ...td, ...money, fontWeight: 700, color: r.cash > 0 ? C.green : C.muted }}>{r.cash > 0 ? num(r.cash) : "—"}</td>
                        <td style={{ ...td, ...money }}>{r.orders || "—"}</td>
                        <td style={{ ...td, ...money }}>{r.units || "—"}</td>
                        <td style={{ ...td, ...money }}>{r.invoiced > 0 ? num(r.invoiced) : "—"}</td>
                        <td style={{ ...td, ...money }}>{r.collected > 0 ? num(r.collected) : "—"}</td>
                        <td style={{ ...td, ...money, fontWeight: 700, color: r.outstanding >= 0.5 ? C.amber : C.muted }}>{r.outstanding >= 0.5 ? num(r.outstanding) : "—"}</td>
                        <td style={{ ...td, ...money }}>{r.revenue > 0 ? num(r.revenue) : "—"}</td>
                        <td style={{ ...td, ...money, fontWeight: 700, color: r.revenue > 0 ? (r.profit >= 0 ? C.green : C.red) : C.muted }}>
                          {r.revenue <= 0 ? "—" : r.uncosted ? <span style={{ color: C.muted, fontWeight: 400 }}>No cost recorded</span> : `${num(r.profit)} (${pc(r.margin)})`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: C.ink, color: "#fff" }}>
                      <td style={{ ...td, fontWeight: 700 }}>Total</td>
                      <td style={{ ...td, ...money, fontWeight: 700 }}>{num(t.cash)}</td>
                      <td style={td} />
                      <td style={{ ...td, ...money }}>{t.units || ""}</td>
                      <td style={{ ...td, ...money, fontWeight: 700 }}>{num(t.invoiced)}</td>
                      <td style={{ ...td, ...money, fontWeight: 700 }}>{num(t.collected)}</td>
                      <td style={{ ...td, ...money, fontWeight: 700 }}>{num(t.outstanding)}</td>
                      <td style={{ ...td, ...money, fontWeight: 700 }}>{num(t.revenue)}</td>
                      <td style={{ ...td, ...money, fontWeight: 700 }}>{t.margin === null ? "—" : `${num(t.profit)} (${pc(t.margin)})`}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div style={{ padding: "10px 14px", fontSize: 12, color: C.muted, borderTop: `1px solid ${C.line}` }}>
                Cash received {kes(rc.allocated)} allocated{rc.unallocated > 0 ? ` + ${kes(rc.unallocated)} unallocated` : ""} = {kes(rc.total)}
                {rc.expected !== null && <> · Payments Received report: {kes(rc.expected)}</>}. Margin is an estimate: costs are recorded per order and split across categories by sales value.
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

const tbl = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const headRow = { background: C.ink, color: "#fff", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" };
const bodyRow = { borderBottom: `1px solid ${C.line}` };
const th = { padding: "10px 12px", textAlign: "left", fontWeight: 600 };
const td = { padding: "9px 12px", verticalAlign: "top" };
const money = { textAlign: "right", fontFamily: C.mono, whiteSpace: "nowrap" };
