"use client";
import { Fragment, useEffect, useMemo, useState, useCallback } from "react";
import { useAuth } from "@/shared/context/AuthContext";
import { C, Panel, StatCard, Notice, Empty, Loading, Badge } from "@/shared/ui/ds";
import { describePeriod } from "@/shared/lib/customerReport";
import { sortRows } from "@/shared/lib/reports/orderRules";
import { PeriodButton, ExportButtons } from "./ReportBar";
import { exportPdf, exportCsv } from "./reportExport";
import { SortTh, useSort } from "./SortTh";

const kes = n => `KES ${Math.round(n || 0).toLocaleString("en-KE")}`;
const num = n => Math.round(n || 0).toLocaleString("en-KE");

const CSV_COLUMNS = [
  { key: "order_num", label: "Order" }, { key: "client", label: "Client" }, { key: "status", label: "Status" },
  { key: "revenue", label: "Revenue ex-VAT" }, { key: "materials", label: "Materials" }, { key: "labour", label: "Labour" },
  { key: "direct", label: "Direct expenses" }, { key: "cost", label: "Total cost" }, { key: "profit", label: "Profit" }, { key: "margin", label: "Margin %" },
  { key: "collected", label: "Collected" },
];

// Order profit & loss for orders created in the period. Revenue is ex-VAT and
// cost includes purchases, labour and direct expenses, the same as the P&L tab
// inside each order (server: /api/reports/order-pnl).
export default function OrderPnlReport({ range, today, onRangeChange }) {
  const { displayName } = useAuth();
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(() => new Set());
  const { sort, toggle } = useSort({ field: "profit", dir: "asc" });

  const bounded = !!(range.from && range.to);

  useEffect(() => {
    if (!bounded) { setState({ loading: false, error: "", data: null }); return undefined; }
    const ctl = new AbortController();
    setState(s => ({ ...s, loading: true, error: "" }));
    (async () => {
      try {
        const res = await fetch(`/api/reports/order-pnl?from=${range.from}&to=${range.to}`, { signal: ctl.signal });
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

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const list = q ? data.rows.filter(r => `${r.client} ${r.order_num}`.toLowerCase().includes(q)) : data.rows;
    return sortRows(list, sort.field, sort.dir, (r, f) => r[f]);
  }, [data, search, sort]);

  const t = data?.totals;
  const name = ext => `Order_PnL_${range.from}_to_${range.to}.${ext}`;

  const onPdf = useCallback(async () => {
    setBusy(true); setExportError("");
    try {
      await exportPdf({
        reportLabel: "Order P&L",
        orderPnL: rows.map(r => ({ ...r, revenue: r.revenue, material_cost: r.materials })),
        pnlTotals: t,
        filters: { period: describePeriod(range) },
        userName: displayName,
      }, name("pdf"));
    } catch (e) { setExportError(e.message); }
    setBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, t, range, displayName]);

  const toggleOpen = id => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <PeriodButton range={range} today={today} onChange={onRangeChange} subject="orders created" title="P&L period" />
        <input
          type="search" aria-label="Search orders" placeholder="Search client or order…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: "1 1 200px", minHeight: 38, border: `1px solid ${C.line}`, borderRadius: C.radiusSm, padding: "6px 12px", fontSize: 13, background: C.card, color: C.ink, fontFamily: "inherit" }}
        />
        <div style={{ marginLeft: "auto" }}>
          <ExportButtons
            onPdf={onPdf}
            onCsv={() => { try { exportCsv(CSV_COLUMNS, rows, name("csv")); } catch (e) { setExportError(e.message); } }}
            busy={busy} disabled={!data || rows.length === 0}
          />
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
            <StatCard label="Orders" value={String(t.count)} />
            <StatCard label="Revenue (ex-VAT)" value={kes(t.revenue)} mono />
            <StatCard label="Total cost" value={kes(t.cost)} sub={`Materials ${kes(t.materials)} · Labour ${kes(t.labour)} · Direct ${kes(t.direct)}`} mono />
            <StatCard label="Profit" value={kes(t.profit)} sub={t.margin === null ? "" : `${t.margin.toFixed(1)}% margin`} alert={t.profit < 0} mono />
          </div>

          {(t.estimated > 0 || t.uncosted > 0 || data.excludedOrders > 0) && (
            <Notice color="amber" style={{ marginBottom: 12 }}>
              {t.uncosted > 0 && <>{t.uncosted} order{t.uncosted === 1 ? " has" : "s have"} no costs recorded yet, so {t.uncosted === 1 ? "its" : "their"} margin shows 100% and flatters the total. </>}
              {t.estimated > 0 && <>{t.estimated} order{t.estimated === 1 ? "" : "s"} predate VAT line snapshots, so revenue is estimated as total ÷ 1.16. </>}
              {data.excludedOrders > 0 && <>{data.excludedOrders} cancelled or suspended order{data.excludedOrders === 1 ? " is" : "s are"} excluded.</>}
            </Notice>
          )}

          {rows.length === 0 ? (
            <Panel><Empty message="No orders match." /></Panel>
          ) : (
            <Panel>
              <div style={{ overflowX: "auto" }}>
                <table style={tbl}>
                  <thead>
                    <tr style={headRow}>
                      <SortTh field="order_num" sort={sort} onSort={toggle}>Order</SortTh>
                      <SortTh field="client" sort={sort} onSort={toggle}>Client</SortTh>
                      <SortTh field="status" sort={sort} onSort={toggle}>Status</SortTh>
                      <SortTh field="revenue" sort={sort} onSort={toggle} right>Revenue</SortTh>
                      <SortTh field="cost" sort={sort} onSort={toggle} right>Cost</SortTh>
                      <SortTh field="profit" sort={sort} onSort={toggle} right>Profit</SortTh>
                      <SortTh field="margin" sort={sort} onSort={toggle} right>Margin</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, idx) => {
                      const isOpen = open.has(r.id);
                      const detail = r.cost > 0;
                      return (
                        <Fragment key={r.id}>
                          <tr style={{ ...bodyRow, background: idx % 2 ? C.bg : C.card, cursor: detail ? "pointer" : "default" }} onClick={() => detail && toggleOpen(r.id)}>
                            <td style={{ ...td, fontFamily: C.mono, fontSize: 12 }}>
                              {detail && <span aria-hidden="true" style={{ color: C.coral, marginRight: 6 }}>{isOpen ? "▾" : "▸"}</span>}
                              {r.order_num}
                            </td>
                            <td style={{ ...td, fontWeight: 700 }}>{r.client}</td>
                            <td style={td}><Badge>{r.status}</Badge></td>
                            <td style={{ ...td, textAlign: "right", fontFamily: C.mono }}>
                              {num(r.revenue)}{r.revenue_estimated && <span title="Estimated: total ÷ 1.16" style={{ color: C.amber }}> ≈</span>}
                            </td>
                            <td style={{ ...td, textAlign: "right", fontFamily: C.mono, color: r.cost ? C.red : C.faint }}>{r.cost ? num(r.cost) : "—"}</td>
                            <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700, color: r.profit >= 0 ? C.green : C.red }}>{num(r.profit)}</td>
                            <td style={{ ...td, textAlign: "right", fontWeight: 700, color: !r.cost ? C.faint : r.margin >= 30 ? C.green : r.margin >= 10 ? C.amber : C.red }}>
                              {r.margin === null ? "—" : `${r.margin.toFixed(1)}%`}{!r.cost && r.margin !== null ? "*" : ""}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr style={{ background: C.lane }}>
                              <td colSpan={7} style={{ padding: "8px 14px 12px 34px", fontSize: 12 }}>
                                <div style={{ display: "flex", gap: 18, flexWrap: "wrap", color: C.muted, marginBottom: r.purchases.length ? 6 : 0 }}>
                                  <span>Materials <b style={{ color: C.ink }}>{num(r.materials)}</b></span>
                                  <span>Labour <b style={{ color: C.ink }}>{num(r.labour)}</b></span>
                                  <span>Direct expenses <b style={{ color: C.ink }}>{num(r.direct)}</b></span>
                                  <span>Collected <b style={{ color: C.green }}>{num(r.collected)}</b></span>
                                </div>
                                {r.purchases.map((p, i) => (
                                  <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "3px 0", borderTop: i ? `1px solid ${C.line}` : "none" }}>
                                    <span><b>{p.supplier_name}</b> <span style={{ color: C.muted }}>· {p.items_bought}</span></span>
                                    <span style={{ fontFamily: C.mono, color: C.red }}>{num(p.total_amount)}</span>
                                  </div>
                                ))}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: C.ink, color: "#fff" }}>
                      <td colSpan={3} style={{ ...td, fontWeight: 700 }}>Total · {rows.length} order{rows.length === 1 ? "" : "s"}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700 }}>{num(t.revenue)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700 }}>{num(t.cost)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700 }}>{num(t.profit)}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{t.margin === null ? "—" : `${t.margin.toFixed(1)}%`}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div style={{ padding: "8px 14px", fontSize: 11.5, color: C.muted }}>* No costs recorded yet. Click a row with costs to see the breakdown. Totals cover all matching orders, not only the filtered rows.</div>
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
const td = { padding: "9px 12px", verticalAlign: "top" };
