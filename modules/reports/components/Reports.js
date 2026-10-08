"use client";
import { useMemo, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/shared/context/AuthContext";
import { CATEGORIES } from "@/modules/orders/components/constants";
import { C, Loading, Notice, StatCard, Btn } from "@/shared/ui/ds";
import { presetRange, describePeriod } from "@/shared/lib/customerReport";
import { nairobiToday } from "@/shared/lib/reports/dateBounds";
import { makeValueModel, makeOrderFilters, countUndatedReceivables, sortRows, DEFAULT_SORT } from "@/shared/lib/reports/orderRules";
import {
  orderRow, orderSortValue, summariseOrderRows, orderUnits, supplierRow,
  FINANCIAL_CSV_COLUMNS, OPERATIONAL_CSV_COLUMNS, SUPPLIER_CSV_COLUMNS,
} from "@/shared/lib/reports/orderRows";
import { CustomerPicker } from "@/modules/customers/components/ReportControls";
import useReportData from "./useReportData";
import { REPORTS, visibleGroups, groupOf, resolveReport } from "./reportCatalog";
import { PeriodButton, ExportButtons } from "./ReportBar";
import { exportPdf, exportCsv, slug } from "./reportExport";
import { useSort } from "./SortTh";
import { FinancialOrders, OperationalOrders, SupplierTable, OrderCards } from "./OrderReportView";
import PaymentsReceivedReport from "./PaymentsReceivedReport";
import OrderPnlReport from "./OrderPnlReport";
import ProductCashReport from "./ProductCashReport";

const kes = n => `KES ${Math.round(n || 0).toLocaleString("en-KE")}`;

export default function Reports({ refreshKey = 0 } = {}) {
  const searchParams = useSearchParams();
  const { userRole, displayName, loaded: authLoaded } = useAuth();
  const today = useMemo(() => nairobiToday(), []);

  // The role is not known until auth loads, so only check access afterwards.
  const [reportType, setReportType] = useState(() => (REPORTS[searchParams.get("type")] ? searchParams.get("type") : "production"));
  const [range, setRange] = useState(() => presetRange("this_month", nairobiToday()));
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState(null);
  const { sort, setSort, toggle } = useSort(DEFAULT_SORT[reportType] || { field: null, dir: "asc" });
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [isMobile, setIsMobile] = useState(false);

  const data = useReportData(refreshKey);
  const meta = REPORTS[reportType];
  const groups = useMemo(() => visibleGroups(userRole), [userRole]);
  const activeGroup = groupOf(reportType);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 720);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Once the role is known, make sure the chosen report is one it may open.
  useEffect(() => {
    if (!authLoaded) return;
    const ok = resolveReport(reportType, userRole);
    if (ok !== reportType) setReportType(ok);
  }, [authLoaded, userRole, reportType]);

  const selectReport = useCallback(id => {
    setReportType(id);
    setSearch("");
    setClientFilter(null);
    setExportError("");
    setSort(DEFAULT_SORT[id] || { field: null, dir: "asc" });
  }, [setSort]);

  // ── order + supplier report rows ───────────────────────────────────────────
  const model = useMemo(() => makeValueModel({
    payTotals: data.payTotals, batchOrderIds: data.batchOrderIds,
    deliveredValues: data.deliveredValues, batchLoadError: data.batchLoadError,
  }), [data.payTotals, data.batchOrderIds, data.deliveredValues, data.batchLoadError]);

  const effectiveRange = meta?.range ? range : {};
  const filters = useMemo(() => makeOrderFilters({ today, range: effectiveRange, model }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today, range.from, range.to, meta?.range, model]);

  const isOrderReport = meta?.kind === "orders";
  const isSupplier = meta?.kind === "supplier";
  const financial = !!meta?.financial;
  const paymentDue = reportType === "collections";

  // Everything the report matches before search / client filters apply.
  const baseRows = useMemo(() => {
    if (isOrderReport) {
      const fn = filters[reportType];
      return data.orders.filter(fn).map(o => ({
        ...orderRow(o, model, today),
        items_text: o.items || "",
        notes: o.notes || "",
        assigned_to: o.assigned_to || "",
        units: orderUnits(data.itemsByOrder[o.id]),
        items: (data.itemsByOrder[o.id] || []).map(i => `${i.quantity || 1}× ${i.description || i.category || "item"}`).join("; ") || (o.items || ""),
      }));
    }
    if (isSupplier) {
      const inPeriod = d => !!d && (!range.from || d.slice(0, 10) >= range.from) && (!range.to || d.slice(0, 10) <= range.to);
      const fn = reportType === "supplier-payables"
        ? p => ["Unpaid", "Part Paid"].includes(p.payment_status)
        : p => inPeriod(p.purchase_date);
      return data.supplierPurchases.filter(fn).map(supplierRow);
    }
    return [];
  }, [isOrderReport, isSupplier, reportType, filters, data.orders, data.itemsByOrder, data.supplierPurchases, model, today, range.from, range.to]);

  const clientNames = useMemo(() => {
    const key = isSupplier ? "supplier_name" : "client";
    return [...new Set(baseRows.map(r => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [baseRows, isSupplier]);
  const clientOptions = useMemo(() => clientNames.map(n => ({ id: n, name: n })), [clientNames]);

  const rows = useMemo(() => {
    const key = isSupplier ? "supplier_name" : "client";
    const q = search.trim().toLowerCase();
    const list = baseRows.filter(r => {
      if (clientFilter && r[key] !== clientFilter) return false;
      if (!q) return true;
      const hay = isSupplier
        ? [r.supplier_name, r.items_bought, r.payment_status]
        : [r.client, r.order_num, r.invoice_number, r.items_text, r.assigned_to, r.notes];
      return hay.filter(Boolean).join(" ").toLowerCase().includes(q);
    });
    return sortRows(list, sort.field, sort.dir, (r, f) => (isSupplier ? r[f] : orderSortValue(r, f)));
  }, [baseRows, clientFilter, search, sort, isSupplier]);

  const summary = useMemo(() => (isOrderReport && financial ? summariseOrderRows(rows) : null), [isOrderReport, financial, rows]);
  const supplierTotals = useMemo(() => (isSupplier ? {
    total: rows.reduce((s, r) => s + r.total_amount, 0),
    paid: rows.reduce((s, r) => s + r.amount_paid, 0),
    balance: rows.reduce((s, r) => s + r.balance, 0),
  } : null), [isSupplier, rows]);
  const undated = useMemo(() => (reportType === "receivables" || reportType === "collections"
    ? countUndatedReceivables(data.orders, model) : null), [reportType, data.orders, model]);

  const workload = useMemo(() => {
    if (reportType !== "workload") return null;
    const map = {};
    rows.forEach(r => {
      const items = data.itemsByOrder[r.id] || [];
      if (!items.length) map.Other = (map.Other || 0) + 1;
      else items.forEach(i => { map[i.category || "Other"] = (map[i.category || "Other"] || 0) + (i.quantity || 1); });
    });
    return CATEGORIES.map(c => ({ label: c, qty: map[c] || 0 })).filter(c => c.qty > 0);
  }, [reportType, rows, data.itemsByOrder]);

  const unitsById = useMemo(() => Object.fromEntries(rows.map(r => [r.id, r.units])), [rows]);

  // ── export ─────────────────────────────────────────────────────────────────
  const fileBase = `${slug(meta?.label)}_${today}`;

  const onPdf = async () => {
    setBusy(true); setExportError("");
    try {
      const common = {
        reportLabel: meta.label,
        dateFrom: meta.range ? range.from : null,
        dateTo: meta.range ? range.to : null,
        userName: displayName,
      };
      if (isSupplier) {
        await exportPdf({ ...common, supplierPurchases: rows, supplierTotals }, `${fileBase}.pdf`);
      } else {
        const ids = new Set(rows.map(r => r.id));
        const orders = data.orders.filter(o => ids.has(o.id));
        await exportPdf({
          ...common,
          orders,
          allItems: financial ? {} : Object.fromEntries([...ids].map(id => [id, data.itemsByOrder[id] || []])),
          payTotals: Object.fromEntries([...ids].map(id => [id, data.payTotals[id] || 0])),
          reportRows: rows,
          showFinancials: financial,
          paymentDue,
          summary,
          workloadSummary: workload,
        }, `${fileBase}.pdf`);
      }
    } catch (e) { setExportError(e.message); }
    setBusy(false);
  };

  const onCsv = () => {
    setExportError("");
    try {
      if (isSupplier) exportCsv(SUPPLIER_CSV_COLUMNS, rows, `${fileBase}.csv`);
      else exportCsv(financial ? FINANCIAL_CSV_COLUMNS : OPERATIONAL_CSV_COLUMNS, rows, `${fileBase}.csv`);
    } catch (e) { setExportError(e.message); }
  };

  if (!data.loaded) return <Loading />;

  const isOwnView = meta?.kind === "payments" || meta?.kind === "pnl" || meta?.kind === "productCash";

  return (
    <div style={{ padding: isMobile ? "16px 12px" : "20px 16px", color: C.ink }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.4px", margin: 0 }}>Reports</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: "4px 0 0" }}>{meta?.label} — {meta?.hint}</p>
        </div>
        {!isOwnView && <ExportButtons onPdf={onPdf} onCsv={onCsv} busy={busy} disabled={rows.length === 0} />}
      </div>

      {/* Group → report navigation */}
      <nav aria-label="Report groups" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {groups.map(g => {
          const on = g.id === activeGroup;
          return (
            <button
              key={g.id} type="button" aria-current={on ? "true" : undefined}
              onClick={() => !on && selectReport(g.reports[0])}
              style={{
                border: `1px solid ${on ? C.ink : C.line}`, background: on ? C.ink : C.card, color: on ? "#fff" : C.ink,
                borderRadius: 20, padding: "7px 16px", minHeight: 38, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              }}
            >{g.label}</button>
          );
        })}
      </nav>
      <div role="tablist" aria-label="Reports" style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 16, borderBottom: `1px solid ${C.line}` }}>
        {(groups.find(g => g.id === activeGroup)?.reports || []).map(id => {
          const on = id === reportType;
          return (
            <button
              key={id} type="button" role="tab" aria-selected={on} onClick={() => selectReport(id)}
              style={{
                border: "none", background: "none", padding: "9px 14px", minHeight: 40, fontSize: 13, fontWeight: on ? 800 : 600,
                color: on ? C.coral : C.muted, cursor: "pointer", fontFamily: "inherit",
                borderBottom: `3px solid ${on ? C.coral : "transparent"}`, marginBottom: -1,
              }}
            >{REPORTS[id].label}</button>
          );
        })}
      </div>

      {data.error && (
        <Notice color="red" style={{ marginBottom: 14 }}>
          {data.error} Figures below may be incomplete.{" "}
          <button type="button" onClick={data.retry} style={{ marginLeft: 6, background: "none", border: "none", color: "inherit", textDecoration: "underline", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit", padding: 0 }}>Retry</button>
        </Notice>
      )}

      {meta?.kind === "payments" && <PaymentsReceivedReport range={range} today={today} onRangeChange={setRange} />}
      {meta?.kind === "pnl" && <OrderPnlReport range={range} today={today} onRangeChange={setRange} />}
      {meta?.kind === "productCash" && <ProductCashReport range={range} today={today} onRangeChange={setRange} />}

      {!isOwnView && !data.error && (
        <>
          {data.batchLoadError && (isOrderReport && financial) && (
            <Notice color="red" style={{ marginBottom: 12 }}>
              {data.batchLoadError} Partially delivered batch orders show "unavailable" and are left out of billable value and balance totals; recorded payments stay included.
            </Notice>
          )}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
            {meta.range && (
              <PeriodButton
                range={range} today={today} onChange={setRange}
                subject={`${meta.rangeOn || "dates"} in`} title={`${meta.label} period`}
              />
            )}
            <input
              type="search" aria-label="Search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
              style={{ flex: "1 1 200px", minHeight: 38, border: `1px solid ${C.line}`, borderRadius: C.radiusSm, padding: "6px 12px", fontSize: 13, background: C.card, color: C.ink, fontFamily: "inherit" }}
            />
            <CustomerPicker
              customers={clientOptions} value={clientFilter} onChange={setClientFilter}
              allLabel={isSupplier ? "All suppliers" : "All clients"}
            />
            {(search || clientFilter) && <Btn small onClick={() => { setSearch(""); setClientFilter(null); }}>Clear filters</Btn>}
          </div>

          {exportError && <Notice color="red" style={{ marginBottom: 12 }}>{exportError}</Notice>}

          {summary && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
                <StatCard label="Orders" value={String(summary.count)} />
                <StatCard label="Invoiced" value={kes(summary.billable)} sub={summary.undelivered > 0 ? `+ ${kes(summary.undelivered)} not yet delivered` : undefined} mono />
                <StatCard label="Paid" value={kes(summary.paid)} mono />
                <StatCard label="Balance owed" value={summary.balance > 0 ? kes(summary.balance) : "Cleared"} alert={summary.balance > 0} mono />
                <StatCard label="Overdue" value={summary.overdue > 0 ? kes(summary.overdue) : "None"} sub={summary.overdueCount ? `${summary.overdueCount} order${summary.overdueCount === 1 ? "" : "s"}` : undefined} alert={summary.overdue > 0} mono />
              </div>
              {summary.unknown > 0 && (
                <Notice color="amber" style={{ marginBottom: 12 }}>{summary.unknown} order{summary.unknown === 1 ? "" : "s"} left out of the totals: delivery value unavailable.</Notice>
              )}
            </>
          )}

          {reportType === "collections" && undated && undated.count > 0 && (
            <Notice color="amber" style={{ marginBottom: 12 }}>
              {undated.count} invoiced order{undated.count === 1 ? "" : "s"} ({kes(undated.amount)}) {undated.count === 1 ? "has" : "have"} no payment due date, so {undated.count === 1 ? "it never appears" : "they never appear"} here. Set a payment due date on the order to include {undated.count === 1 ? "it" : "them"}.
            </Notice>
          )}

          {isSupplier && supplierTotals && rows.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
              <StatCard label="Purchases" value={String(rows.length)} />
              <StatCard label="Total" value={kes(supplierTotals.total)} mono />
              <StatCard label="Paid" value={kes(supplierTotals.paid)} mono />
              <StatCard label="Outstanding" value={supplierTotals.balance > 0 ? kes(supplierTotals.balance) : "Cleared"} alert={supplierTotals.balance > 0} mono />
            </div>
          )}

          {workload && workload.length > 0 && (
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              {workload.map(c => (
                <div key={c.label} style={{ padding: "12px 16px", borderRadius: C.radiusSm, background: C.card, border: `1px solid ${C.line}`, flex: "1 1 120px", minWidth: 110 }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: C.coral, fontFamily: C.mono }}>{c.qty}</div>
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 500 }}>{c.label}</div>
                </div>
              ))}
            </div>
          )}

          {isSupplier ? (
            <SupplierTable rows={rows} sort={sort} onSort={toggle} emptyMessage="No supplier purchases match this report." />
          ) : isMobile ? (
            rows.length ? <OrderCards rows={rows} financial={financial} unitsById={unitsById} paymentDue={paymentDue} />
              : <div style={{ padding: 40, textAlign: "center", color: C.muted, background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius }}>No orders match this report.</div>
          ) : financial ? (
            <FinancialOrders rows={rows} sort={sort} onSort={toggle} paymentDue={paymentDue} emptyMessage="No orders match this report." />
          ) : (
            <OperationalOrders rows={rows} itemsByOrder={data.itemsByOrder} sort={sort} onSort={toggle} emptyMessage="No orders match this report." />
          )}

          {rows.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>
              {rows.length} {isSupplier ? "purchase" : "order"}{rows.length === 1 ? "" : "s"}
              {meta.range && <> · {describePeriod(range)}</>}
              {!isSupplier && !financial && <> · {rows.reduce((s, r) => s + r.units, 0)} units</>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
