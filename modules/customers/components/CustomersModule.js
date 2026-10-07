"use client";
import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/shared/supabase/client";
import { useRouter } from "next/navigation";
import { useAuth } from "@/shared/context/AuthContext";
import CustomerListView from "./CustomerListView";
import { CustomerPicker, PeriodModal } from "./ReportControls";
import {
  C, Btn, Badge, Modal, PageHeader, StatCard, TabBar,
  Table, Th, Td, Field, TInput, TSelect, TArea,
  Notice, Empty, Loading, Mono, fmtKes, fmtDate,
} from "@/shared/ui/ds";
import {
  localDateOf, formatDay, presetRange, describePeriod, filterOrders, filterReceivables,
  orderBalance, daysLate, orderKpis, receivableKpis,
} from "@/shared/lib/customerReport";
import { ageingTotals } from "@/shared/lib/customerList";

const WRITE_ROLES = ["admin", "production_manager", "head_of_sales", "sales"];
const VALID_TERMS = ["COD", "7 Days", "30 Days", "60 Days"];

const fmtN = (n) => Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const EMPTY_FORM = {
  name: "", contact_person: "", phone: "", email: "",
  address: "", kra_pin: "", credit_limit: "", credit_terms: "COD",
  opening_balance: "", opening_balance_date: "", notes: "",
};

const STATUS_COLORS = {
  "Inquiry":            { bg: "#F3F4F6", text: "#6B7280" },
  "Quoted":             { bg: "#EFF6FF", text: "#1D4ED8" },
  "Quote Approved":     { bg: "#DBEAFE", text: "#1E40AF" },
  "Deposit Paid":       { bg: "#FEF9C3", text: "#854D0E" },
  "In Production":      { bg: "#FFF7ED", text: "#C2410C" },
  "Quality Check":      { bg: "#FAF5FF", text: "#7E22CE" },
  "Ready for Delivery": { bg: "#F0FDF4", text: "#15803D" },
  "Out for Delivery":   { bg: "#ECFDF5", text: "#065F46" },
  "Delivered":          { bg: "#D1FAE5", text: "#065F46" },
  "Closed":             { bg: "#F3F4F6", text: "#374151" },
  "Cancelled":          { bg: "#FEE2E2", text: "#991B1B" },
};

const TERMS_COLORS = {
  "COD":     "gray",
  "7 Days":  "blue",
  "30 Days": "amber",
  "60 Days": "red",
};

function TermsBadge({ terms }) {
  return <Badge color={TERMS_COLORS[terms] || "gray"}>{terms}</Badge>;
}

// Wide page container: fills its parent up to 1560px. It deliberately uses no
// viewport units or offset tricks — an earlier version that centred itself on
// `100vw` overflowed the page horizontally when a scrollbar was showing. In the
// workspace tabs (where Customers normally opens) the parent is full width, so
// this is as wide as a desktop monitor allows.
function Wide({ children }) {
  return (
    <div className="cg-wide">
      <style>{`
        .cg-wide {
          box-sizing: border-box;
          width: 100%;
          max-width: 1560px;
          margin: 0 auto;
          padding: 24px 24px 8px;
        }
        @media (max-width: 720px) {
          .cg-wide { padding: 16px; }
        }
      `}</style>
      {children}
    </div>
  );
}

// ── CUSTOMER REPORTS TAB ──────────────────────────────────────────────────────
const REPORT_TYPES = [
  { key: "customer-receivables", label: "Customer Receivables" },
  { key: "customer-orders",      label: "Customer Orders" },
];

const slug = s => String(s || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function CustomerReportsTab({ customers }) {
  const { displayName }                   = useAuth();
  const today                             = useMemo(() => localDateOf(new Date()), []);
  const [reportType, setReportType]       = useState("customer-receivables");
  const [orders, setOrders]               = useState([]);
  const [payTotals, setPayTotals]         = useState({});
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [ordersError, setOrdersError]     = useState("");
  const [ordersLoaded, setOrdersLoaded]   = useState(false);
  const [customerId, setCustomerId]       = useState(null);
  const [range, setRange]                 = useState(() => presetRange("last_3_months", localDateOf(new Date())));
  const [showPeriod, setShowPeriod]       = useState(false);
  const [exporting, setExporting]         = useState(false);
  const [exportError, setExportError]     = useState("");

  const isOrdersReport = reportType === "customer-orders";

  useEffect(() => {
    if (isOrdersReport && !ordersLoaded) fetchOrders();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportType]);

  const fetchOrders = async () => {
    setLoadingOrders(true);
    setOrdersError("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("orders")
        .select("id, order_num, client, created_at, due_date, status, total_value, customer_id, customers(name), order_payments(amount, reversed_at)")
        .not("customer_id", "is", null)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const pt = {};
      const mapped = (data || []).map(o => {
        // Reversed payments no longer count as paid — the reversal journal
        // already backs the receipt out in the GL.
        pt[o.id] = (o.order_payments || []).filter(p => !p.reversed_at).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
        return { ...o, customer_name: o.customers?.name || o.client };
      });
      setPayTotals(pt);
      setOrders(mapped);
      setOrdersLoaded(true);
    } catch (err) {
      setOrdersError(`Couldn't load orders. ${err.message}`);
    }
    setLoadingOrders(false);
  };

  const selectedCustomer = useMemo(() => customers.find(c => c.id === customerId) || null, [customers, customerId]);

  const filteredOrders = useMemo(
    () => filterOrders(orders, { customerId, from: range.from, to: range.to }),
    [orders, customerId, range]
  );
  const filteredCustomers = useMemo(
    () => [...filterReceivables(customers, { customerId })]
      .sort((a, b) => (b._stats?.outstanding || 0) - (a._stats?.outstanding || 0)),
    [customers, customerId]
  );

  const rows = isOrdersReport ? filteredOrders : filteredCustomers;

  const kpis = useMemo(() => {
    if (isOrdersReport) {
      const k = orderKpis(filteredOrders, payTotals, today);
      return [
        { label: "Orders",      value: k.count, sub: describePeriod(range) },
        { label: "Total Value", value: fmtKes(k.value),     mono: true },
        { label: "Collected",   value: fmtKes(k.collected), mono: true },
        { label: "Outstanding", value: fmtKes(k.outstanding), mono: true, alert: k.outstanding >= 0.5,
          sub: k.lateCount ? `${k.lateCount} late · ${fmtKes(k.lateAmount)}` : undefined },
      ];
    }
    const k = receivableKpis(filteredCustomers);
    return [
      { label: "Customers",   value: k.count },
      { label: "Total Sales", value: fmtKes(k.sales),       mono: true },
      { label: "Outstanding", value: fmtKes(k.outstanding), mono: true, alert: k.outstanding >= 0.5 },
      { label: "Overdue",     value: fmtKes(k.overdue),     mono: true, alert: k.overdue >= 0.5,
        sub: k.overdueCustomers ? `${k.overdueCustomers} customer${k.overdueCustomers === 1 ? "" : "s"}` : undefined },
    ];
  }, [isOrdersReport, filteredOrders, filteredCustomers, payTotals, range, today]);

  const handleExport = async () => {
    setExporting(true); setExportError("");
    try {
      const customerLabel = selectedCustomer ? selectedCustomer.name : "All customers";
      const suffix = selectedCustomer ? ` ${selectedCustomer.name}` : "";
      let body;
      if (isOrdersReport) {
        body = {
          reportLabel: `Customer Orders${suffix}`,
          filters: { customer: customerLabel, period: describePeriod(range) },
          customerOrders: filteredOrders.map(o => ({
            customer_name: o.customer_name,
            order_num:     o.order_num,
            created_at:    localDateOf(o.created_at),
            due_date:      o.due_date,
            status:        o.status,
            total_value:   o.total_value,
            amount_paid:   payTotals[o.id] || 0,
          })),
          userName: displayName,
        };
      } else {
        body = {
          reportLabel: `Customer Receivables${suffix}`,
          filters: { customer: customerLabel, asAt: today },
          ageing: ageingTotals(filteredCustomers),
          customerReceivables: filteredCustomers.map(c => ({
            name:         c.name,
            credit_terms: c.credit_terms,
            total_sales:  c._stats?.total_sales || 0,
            outstanding:  c._stats?.outstanding || 0,
            overdue:      c._stats?.overdue || 0,
            oldest_overdue_days: c._stats?.oldest_overdue_days || 0,
            credit_limit: parseFloat(c.credit_limit || 0),
            total_orders: c._stats?.total_orders || 0,
          })),
          userName: displayName,
        };
      }

      const res = await fetch("/api/reports/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.error || "Export failed");
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${slug(body.reportLabel)}_${today}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(`PDF error: ${err.message}`);
    }
    setExporting(false);
  };

  const loading = isOrdersReport && loadingOrders;

  const totalsBar = (items) => (
    <div style={{ display: "flex", gap: 24, padding: "12px 16px", background: C.ink, borderRadius: "0 0 12px 12px", flexWrap: "wrap" }}>
      {items.map(t => (
        <span key={t.label || t.value} style={{ fontSize: 12, color: C.coral }}>
          {t.label
            ? <>{t.label}: <span style={{ color: "#fff", fontFamily: C.mono }}>{t.value}</span></>
            : <span style={{ color: "#fff", fontWeight: 700 }}>{t.value}</span>}
        </span>
      ))}
    </div>
  );

  const ordersTotals = orderKpis(filteredOrders, payTotals, today);
  const recTotals    = receivableKpis(filteredCustomers);

  return (
    <div>
      {/* Report type selector */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {REPORT_TYPES.map(rt => (
          <button key={rt.key}
            onClick={() => { setReportType(rt.key); setCustomerId(null); setExportError(""); }}
            style={{
              padding: "8px 16px", borderRadius: C.radiusSm,
              border: `1.5px solid ${reportType === rt.key ? C.coral : C.line}`,
              background: reportType === rt.key ? C.coral : C.card,
              color:      reportType === rt.key ? "#fff"  : C.muted,
              fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
            }}>
            {rt.label}
          </button>
        ))}
      </div>

      {/* Filters + Export */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <CustomerPicker customers={customers} value={customerId} onChange={setCustomerId} />

        {isOrdersReport ? (
          <button
            type="button"
            onClick={() => setShowPeriod(true)}
            aria-haspopup="dialog"
            style={{
              border: `1px solid ${C.line}`, background: C.card, color: C.ink, borderRadius: C.radiusSm,
              padding: "9px 14px", minHeight: 44, fontSize: 13, fontWeight: 600, cursor: "pointer",
              fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 8,
            }}
          >
            <span style={{ color: C.muted, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>Period</span>
            {describePeriod(range)}
            <span aria-hidden="true" style={{ color: C.faint }}>▾</span>
          </button>
        ) : (
          <span
            title="Receivables are the current balances. Use Customer Orders to report on a date range."
            style={{ fontSize: 12.5, color: C.muted, padding: "0 6px" }}
          >
            As at {formatDay(today)}
          </span>
        )}

        <Btn primary onClick={handleExport} disabled={exporting || rows.length === 0 || loading}
          style={{ marginLeft: "auto" }}>
          {exporting ? "Exporting…" : "Export PDF"}
        </Btn>
      </div>

      {exportError && <Notice color="red" style={{ marginBottom: 12 }}>{exportError}</Notice>}
      {ordersError && isOrdersReport && (
        <Notice color="red" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1 }}>{ordersError}</span>
          <Btn small onClick={fetchOrders}>Retry</Btn>
        </Notice>
      )}

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
        {kpis.map(k => (
          <StatCard key={k.label} label={k.label} value={k.value} sub={k.sub} mono={k.mono} alert={k.alert} />
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty message={isOrdersReport && orders.length > 0
          ? "No orders in this period. Try a wider date range."
          : "No data for this report."} />
      ) : isOrdersReport ? (
        <div style={{ background: C.card, borderRadius: C.radius, border: `1px solid ${C.line}` }}>
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Order #</Th>
                <Th>Date</Th>
                <Th>Status</Th>
                <Th right>Value (KES)</Th>
                <Th right>Paid (KES)</Th>
                <Th right>Balance (KES)</Th>
                <Th>Due Date</Th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((o) => {
                const paid  = payTotals[o.id] || 0;
                const bal   = orderBalance(o, payTotals);
                const late  = daysLate(o, payTotals, today);
                const sc    = STATUS_COLORS[o.status] || { bg: "#F3F4F6", text: "#6B7280" };
                return (
                  <tr key={o.id}>
                    <Td style={{ fontWeight: 700 }}>{o.customer_name}</Td>
                    <Td><Mono style={{ color: C.coral, fontSize: 12 }}>{o.order_num}</Mono></Td>
                    <Td mono muted>{fmtDate(o.created_at)}</Td>
                    <Td>
                      <span style={{ fontSize: 11, fontWeight: 700, color: sc.text, background: sc.bg, padding: "2px 8px", borderRadius: 4 }}>{o.status}</span>
                    </Td>
                    <Td right mono>{fmtN(o.total_value)}</Td>
                    <Td right mono style={{ color: C.green }}>{fmtN(paid)}</Td>
                    <Td right mono style={{ fontWeight: 700, color: bal >= 0.5 ? C.amber : C.green }}>{fmtN(bal)}</Td>
                    <Td mono style={{ color: late ? C.red : C.muted, fontWeight: late ? 700 : 400 }}>
                      {o.due_date || "—"}{late > 0 && ` · ${late}d late`}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {totalsBar([
            { value: `${ordersTotals.count} Order${ordersTotals.count === 1 ? "" : "s"}` },
            { label: "Total Value", value: `KES ${fmtN(ordersTotals.value)}` },
            { label: "Collected",   value: `KES ${fmtN(ordersTotals.collected)}` },
            { label: "Outstanding", value: `KES ${fmtN(ordersTotals.outstanding)}` },
          ])}
        </div>
      ) : (
        <div style={{ background: C.card, borderRadius: C.radius, border: `1px solid ${C.line}` }}>
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Terms</Th>
                <Th right>Total Sales</Th>
                <Th right>Outstanding</Th>
                <Th right>Overdue</Th>
                <Th right>Credit Limit</Th>
                <Th right>Avail. Credit</Th>
                <Th>Orders</Th>
              </tr>
            </thead>
            <tbody>
              {filteredCustomers.map((c) => {
                const stats = c._stats || {};
                const ts    = stats.total_sales || 0;
                const out   = stats.outstanding  || 0;
                const ovd   = stats.overdue      || 0;
                const cl    = parseFloat(c.credit_limit || 0);
                const avail = Math.max(cl - out, 0);
                return (
                  <tr key={c.id}>
                    <Td style={{ fontWeight: 700 }}>{c.name}</Td>
                    <Td><TermsBadge terms={c.credit_terms} /></Td>
                    <Td right mono>{fmtN(ts)}</Td>
                    <Td right mono style={{ fontWeight: 700, color: out >= 0.5 ? C.amber : C.green }}>{fmtN(out)}</Td>
                    <Td right mono style={{ color: ovd >= 0.5 ? C.red : C.faint }}>{fmtN(ovd)}</Td>
                    <Td right mono muted>{cl > 0 ? fmtN(cl) : "—"}</Td>
                    <Td right mono style={{ color: cl > 0 ? (avail > 0 ? C.green : C.red) : C.faint }}>{cl > 0 ? fmtN(avail) : "—"}</Td>
                    <Td muted>{stats.total_orders || 0}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {totalsBar([
            { value: `${recTotals.count} Customer${recTotals.count !== 1 ? "s" : ""}` },
            { label: "Total Sales",  value: `KES ${fmtN(recTotals.sales)}` },
            { label: "Outstanding",  value: `KES ${fmtN(recTotals.outstanding)}` },
            { label: "Overdue",      value: `KES ${fmtN(recTotals.overdue)}` },
          ])}
        </div>
      )}

      {showPeriod && (
        <PeriodModal
          range={range}
          today={today}
          onClose={() => setShowPeriod(false)}
          onApply={r => { setRange(r); setShowPeriod(false); }}
        />
      )}
    </div>
  );
}


// ── MAIN MODULE ───────────────────────────────────────────────────────────────
export default function CustomersModule({ defaultAction, defaultProspectName, defaultPhone, actionNonce, refreshKey = 0 } = {}) {
  const router = useRouter();
  const { userRole = '', loaded: authLoaded } = useAuth();
  const [customers, setCustomers]     = useState([]);
  const [loading, setLoading]         = useState(true);
  const [loadError, setLoadError]     = useState("");
  const [view, setView]               = useState("list");   // "list" | "reports"
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);
  const [formError, setFormError]     = useState("");

  useEffect(() => {
    if (!authLoaded) return;
    loadCustomers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, refreshKey]);

  // Open new-customer form triggered by ?new=customer query param
  useEffect(() => {
    if (defaultAction === 'customer' && authLoaded && WRITE_ROLES.includes(userRole)) {
      setForm({ ...EMPTY_FORM, name: defaultProspectName || '', phone: defaultPhone || '' });
      setFormError('');
      setShowForm(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAction, actionNonce, authLoaded, userRole]);

  const loadCustomers = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res  = await fetch("/api/customers");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load customers");
      setCustomers(json.data || []);
    } catch (err) {
      setLoadError(`Couldn't load customers. ${err.message}`);
    }
    setLoading(false);
  };

  const canWrite = WRITE_ROLES.includes(userRole);

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError("Customer name is required."); return; }
    setSaving(true); setFormError("");
    try {
      const res  = await fetch("/api/customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to create customer");
      setShowForm(false);
      setForm(EMPTY_FORM);
      await loadCustomers();
    } catch (err) {
      setFormError(err.message);
    }
    setSaving(false);
  };

  return (
    <Wide>

      <PageHeader
        title="Customers"
        description="Accounts, credit and collections"
        actions={canWrite && view === "list" && (
          <Btn primary onClick={() => { setShowForm(true); setForm(EMPTY_FORM); setFormError(""); }}>
            + Add Customer
          </Btn>
        )}
      />

      <TabBar
        tabs={[
          { key: "list",    label: `Customers (${customers.length})` },
          { key: "reports", label: "Reports" },
        ]}
        active={view}
        onSelect={setView}
      />

      {view === "reports" ? (
        <CustomerReportsTab customers={customers} />
      ) : (
        <CustomerListView
          customers={customers}
          loading={loading}
          loadError={loadError}
          onRetry={loadCustomers}
          canWrite={canWrite}
          onAdd={() => { setShowForm(true); setForm(EMPTY_FORM); setFormError(""); }}
          onOpen={id => router.push(`/customers/${id}`)}
        />
      )}

      {/* Add Customer Modal — Modal auto-dispatches quickactions:lock/unlock */}
      {showForm && (
        <Modal
          title="Add Customer"
          onClose={() => setShowForm(false)}
          footer={
            <>
              <Btn onClick={() => setShowForm(false)}>Cancel</Btn>
              <Btn primary onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Add Customer"}
              </Btn>
            </>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="form-grid">
            <Field label="Customer name *" full>
              <TInput value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Westgate Shopping Mall" />
            </Field>
            <Field label="Contact person">
              <TInput value={form.contact_person} onChange={e => setForm({ ...form, contact_person: e.target.value })} placeholder="e.g. Mary Njeru" />
            </Field>
            <Field label="Phone">
              <TInput type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="0712 XXX XXX" />
            </Field>
            <Field label="Email">
              <TInput type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
            </Field>
            <Field label="KRA PIN (optional)">
              <TInput value={form.kra_pin} onChange={e => setForm({ ...form, kra_pin: e.target.value })} placeholder="A000000000X" />
            </Field>
            <Field label="Address" full>
              <TInput value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="e.g. Westlands, Nairobi" />
            </Field>
            <Field label="Credit limit (KSh)">
              <TInput type="number" min="0" step="1000" value={form.credit_limit} onChange={e => setForm({ ...form, credit_limit: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Credit terms">
              <TSelect value={form.credit_terms} onChange={e => setForm({ ...form, credit_terms: e.target.value })}>
                {VALID_TERMS.map(t => <option key={t} value={t}>{t}</option>)}
              </TSelect>
            </Field>
            <Field label="Opening balance (KSh)">
              <TInput type="number" min="0" step="1" value={form.opening_balance} onChange={e => setForm({ ...form, opening_balance: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Opening balance date">
              <TInput type="date" value={form.opening_balance_date} onChange={e => setForm({ ...form, opening_balance_date: e.target.value })} />
            </Field>
            <Field label="Notes" full>
              <TArea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Internal notes…" />
            </Field>
          </div>

          {formError && <Notice color="red" style={{ marginTop: 14 }}>{formError}</Notice>}
        </Modal>
      )}
    </Wide>
  );
}
