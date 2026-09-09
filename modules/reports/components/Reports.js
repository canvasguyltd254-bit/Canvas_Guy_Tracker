"use client";
import { useState, useEffect, useMemo, useCallback, Fragment } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/shared/supabase/client";
import { useAuth } from "@/shared/context/AuthContext";
import { ALL_STATUS_COLORS, CATEGORIES } from "@/modules/orders/components/constants";
import { C, Btn, Loading, TabBar as SharedTabBar, Notice } from "@/shared/ui/ds";
// PDF generation handled server-side via /api/reports/pdf (build_report.py)

// ── Report type definitions ──
const REPORT_TYPES = [
  { id: "overdue",              label: "Overdue",             icon: "🔴", dateField: null },
  { id: "due-week",             label: "Due Orders",          icon: "📅", dateField: "due_date" },
  { id: "production",           label: "In Production",       icon: "🔨", dateField: null },
  { id: "ready",                label: "Ready for Delivery",  icon: "✅", dateField: null },
  { id: "receivables",          label: "Receivables",         icon: "💰", dateField: null },
  { id: "collections",          label: "Collections Due",     icon: "📋", dateField: "due_date" },
  { id: "sales-week",           label: "Sales by Period",     icon: "📈", dateField: "created_at" },
  { id: "completed",            label: "Completed",           icon: "🏁", dateField: "created_at" },
  { id: "workload",             label: "Workload",            icon: "⚙️", dateField: null },
  { id: "supplier-payables",    label: "Supplier Payables",   icon: "🏭", dateField: null },
  { id: "supplier-purchases",   label: "Supplier Purchases",  icon: "📦", dateField: "purchase_date" },
  { id: "order-pnl",           label: "Order P&L",           icon: "📊", dateField: "created_at" },
];

const PROD_STATUSES        = ["Material Check", "Production", "Quality Control", "Ready for Delivery"];
const FINANCIAL_REPORTS    = ["receivables", "collections"];
const DATE_RANGE_REPORTS   = ["due-week", "sales-week", "collections", "completed", "order-pnl"];
const SUMMARY_KPI_REPORTS  = ["receivables", "collections", "sales-week", "completed"];
const SUPPLIER_REPORTS     = ["supplier-payables", "supplier-purchases"];
const SUPPLIER_DATE_RANGE  = ["supplier-purchases"];

const DATE_PRESETS = [
  { id: "this-week",    label: "This week" },
  { id: "last-week",    label: "Last week" },
  { id: "this-month",   label: "This month" },
  { id: "last-month",   label: "Last month" },
  { id: "this-quarter", label: "This quarter" },
  { id: "custom",       label: "Custom" },
];

// ── Date preset calculator ──
function getPresetRange(preset) {
  const now = new Date();
  const s = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const e = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  switch (preset) {
    case "this-week": {
      const ws = new Date(now); ws.setDate(now.getDate() - now.getDay());
      return [s(ws), e(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6))];
    }
    case "last-week": {
      const ws = new Date(now); ws.setDate(now.getDate() - now.getDay() - 7);
      return [s(ws), e(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6))];
    }
    case "this-month":
      return [s(new Date(now.getFullYear(), now.getMonth(), 1)), e(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
    case "last-month": {
      const m = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      return [s(new Date(y, m, 1)), e(new Date(y, m + 1, 0))];
    }
    case "this-quarter": {
      const q = Math.floor(now.getMonth() / 3);
      return [s(new Date(now.getFullYear(), q * 3, 1)), e(new Date(now.getFullYear(), q * 3 + 3, 0))];
    }
    default:
      return [s(new Date(now.getFullYear(), now.getMonth(), 1)), e(now)];
  }
}

// Formats a Date as YYYY-MM-DD for <input type="date"> value
function toInputDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function Reports({ refreshKey = 0 } = {}) {
  const searchParams = useSearchParams();
  const initialType = searchParams.get("type") || "production";
  const { displayName } = useAuth();

  const [reportType, setReportType] = useState(initialType);
  const [orders, setOrders] = useState([]);
  const [allItems, setAllItems] = useState({});
  const [payTotals, setPayTotals] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("All");
  const [exporting, setExporting]               = useState(false);
  const [supplierPurchases, setSupplierPurchases] = useState([]);
  const [pnlCosts, setPnlCosts] = useState({});
  const [pnlPurchases, setPnlPurchases] = useState({});
  // Batch-delivered value per order_id — only set for orders with batch delivery.
  // deliveredValues[id] = sum(qty_delivered × unit_price) across Delivered/Signed batches.
  // deliveredValues[order_id] = prorated gross value of items in Delivered/Signed batches.
  // batchOrderIds = set of order IDs that actually use batch delivery.
  const [deliveredValues, setDeliveredValues] = useState({});
  const [batchOrderIds, setBatchOrderIds]     = useState(new Set());
  const [batchLoadError, setBatchLoadError]   = useState(null);

  // Sorting
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  // Date range
  const [datePreset, setDatePreset] = useState("this-month");
  const [dateFrom, setDateFrom] = useState(() => getPresetRange("this-month")[0]);
  const [dateTo, setDateTo]     = useState(() => getPresetRange("this-month")[1]);

  // Mobile layout
  const [isMobile, setIsMobile] = useState(false);
  const [mobileTableView, setMobileTableView] = useState(false);
  const [dateChipOpen, setDateChipOpen] = useState(false);

  const sb = createClient();

  // ── Load all data once ──
  useEffect(() => {
    (async () => {
      const { data: ord } = await sb.from("orders").select("*").order("due_date", { ascending: true, nullsFirst: false });
      setOrders(ord || []);
      const { data: items } = await sb.from("order_items").select("*").order("sort_order");
      if (items) {
        const m = {};
        items.forEach((i) => { if (!m[i.order_id]) m[i.order_id] = []; m[i.order_id].push(i); });
        setAllItems(m);
      }
      const { data: pays } = await sb.from("order_payments").select("order_id,amount").is("reversed_at", null);
      if (pays) {
        const t = {};
        pays.forEach((p) => { t[p.order_id] = (t[p.order_id] || 0) + parseFloat(p.amount); });
        setPayTotals(t);
      }
      const { data: spData } = await sb
        .from("supplier_purchases")
        .select("*, suppliers(name)")
        .order("purchase_date", { ascending: false });
      if (spData) {
        setSupplierPurchases(spData.map((p) => ({
          ...p,
          supplier_name: p.suppliers?.name || "Unknown",
        })));
      }

      // Fetch purchase→order links with full purchase details for P&L.
      // Option B: use l.amount (per-link allocation) when set; fall back to
      // sp.total_amount for legacy links that have no split amount.
      const { data: linkData } = await sb
        .from("purchase_order_links")
        .select("order_id, amount, supplier_purchases(id, total_amount, items_bought, purchase_date, suppliers(name))")
        .order("supplier_purchases(purchase_date)", { ascending: true });
      if (linkData) {
        const costs = {};
        const purchases = {};
        linkData.forEach((l) => {
          const sp = l.supplier_purchases;
          if (!sp) return;
          const fullAmt = parseFloat(sp.total_amount || 0);
          const amt     = l.amount != null ? parseFloat(l.amount) : fullAmt;
          costs[l.order_id] = (costs[l.order_id] || 0) + amt;
          if (!purchases[l.order_id]) purchases[l.order_id] = [];
          purchases[l.order_id].push({
            supplier_name:    sp.suppliers?.name || "Unknown",
            items_bought:     sp.items_bought  || "—",
            total_amount:     amt,        // allocated cost for this order
            purchase_total:   fullAmt,    // full purchase total (for reference)
            purchase_date:    sp.purchase_date || null,
          });
        });
        setPnlCosts(costs);
        setPnlPurchases(purchases);
      }

      // Batch delivery data — computes prorated gross delivered value per order.
      // Uses gross_amount (snapshotted VAT+discount-inclusive line value) ÷ ordered qty
      // so the per-unit rate already reflects any header/line discounts and tax.
      // Fulfilled statuses: Delivered, Signed (matches BATCH_FULFILLED_STATUSES).
      //
      // Charge-line policy (Phase 1):
      //   Transport, installation, and other charge lines do not appear in delivery_batch_items.
      //   They are absent from deliveredValues[order.id], so they fall into getUndeliveredValue()
      //   (total_value − delivered) for any Partially Delivered batch order. This means charge
      //   lines are only recognized as earned revenue when the order reaches Delivered or Closed —
      //   which is the correct Phase 1 rule. No additional code is required.

      // Clear stale state before every fetch cycle (handles retries via refreshKey).
      setBatchLoadError(null);
      setBatchOrderIds(new Set());
      setDeliveredValues({});

      // Step A: Identify ALL orders that have a batch (including those with no fulfilled items yet).
      // Must be a separate query — cannot derive from batch_items because an order with a batch
      // but no assigned/fulfilled items would be invisible in the items query.
      const { data: allBatchData, error: allBatchError } = await sb
        .from('delivery_batches')
        .select('order_id, deleted_at');

      // Step B: Compute prorated delivered value per order from fulfilled batch items.
      const { data: batchItemData, error: batchItemsError } = await sb
        .from('delivery_batch_items')
        .select(`
          order_item_id,
          quantity_delivered,
          order_items(quantity, unit_price, gross_amount),
          delivery_batches(order_id, status)
        `);

      if (allBatchError || batchItemsError) {
        // Either query failing makes delivered-value calculation unreliable.
        // Set the error; leave batchOrderIds and deliveredValues empty (cleared above).
        // Partial batch orders will show "Delivered value unavailable" and be excluded from totals.
        const msg = (allBatchError || batchItemsError).message || 'Batch data unavailable';
        console.error('Reports — batch delivery fetch failed:', allBatchError || batchItemsError);
        setBatchLoadError(`Delivery values could not be loaded — ${msg}.`);
      } else {
        // Both queries succeeded. Build batchOrderIds from all non-deleted batches.
        const batchIds = new Set(
          (allBatchData || [])
            .filter(b => !b.deleted_at)
            .map(b => b.order_id)
        );
        setBatchOrderIds(batchIds);

        // batchOrderIds already set from the delivery_batches query above.
        // This block only computes delivered (earned) values from fulfilled batch items.

        // 2. Aggregate delivered qty per order_item_id, then compute prorated gross value
        //    Cap aggregated qty at ordered qty to guard against data anomalies.
        const itemDelivered = {}; // order_item_id → total qty_delivered across all batches
        batchItemData.forEach(bi => {
          const batch = bi.delivery_batches;
          if (!batch || !['Delivered', 'Signed'].includes(batch.status)) return;
          const id  = bi.order_item_id;
          const qty = Number(bi.quantity_delivered || 0);
          if (qty > 0) itemDelivered[id] = (itemDelivered[id] || 0) + qty;
        });

        // 3. Map order_item_id → order_items row (deduplicated — same item appears in many rows)
        const itemMeta = {};
        batchItemData.forEach(bi => {
          if (bi.order_item_id && bi.order_items && !itemMeta[bi.order_item_id]) {
            itemMeta[bi.order_item_id] = bi.order_items;
          }
        });

        // 4. Map order_item_id → order_id (for grouping by order)
        const itemToOrder = {};
        batchItemData.forEach(bi => {
          if (bi.order_item_id && bi.delivery_batches?.order_id) {
            itemToOrder[bi.order_item_id] = bi.delivery_batches.order_id;
          }
        });

        // 5. Sum prorated gross value per order
        const dv = {};
        Object.entries(itemDelivered).forEach(([itemId, rawQtyDel]) => {
          const meta       = itemMeta[itemId];
          const orderId    = itemToOrder[itemId];
          if (!meta || !orderId) return;

          const orderedQty = Number(meta.quantity || 0);
          // Cap: you cannot deliver more than was ordered
          const qtyDel     = orderedQty > 0 ? Math.min(rawQtyDel, orderedQty) : rawQtyDel;

          // Prefer snapshotted gross_amount (VAT + discount inclusive) ÷ ordered qty.
          // Fall back to unit_price if gross_amount is absent (e.g. legacy rows).
          const grossUnit =
            meta.gross_amount != null && orderedQty > 0
              ? Number(meta.gross_amount) / orderedQty
              : Number(meta.unit_price || 0);

          dv[orderId] = (dv[orderId] || 0) + qtyDel * grossUnit;
        });

        setDeliveredValues(dv);
      }

      setLoaded(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // ── Mobile detection ──
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ── Date helpers ──
  const now = new Date();
  // isPartialBatch: true only when the order is Partially Delivered AND has real batch records.
  // Prevents missing batch data from silently zeroing billable value.
  const isPartialBatch = (o) =>
    o.status === 'Partially Delivered' && batchOrderIds.has(o.id);

  // Delivered (earned/collectable) value:
  //   • Partial batch orders, data OK  → prorated gross value of Delivered/Signed batch items
  //   • Partial batch orders, load ERR → null (unknown — excluded from KPI totals)
  //   • All others                     → full total_value (already earned on delivery)
  const getBillableValue = (o) => {
    if (isPartialBatch(o)) {
      if (batchLoadError) return null; // delivery amount unknown — do not overstate
      return deliveredValues[o.id] ?? 0;
    }
    return Number(o.total_value || 0);
  };

  // Undelivered value — production still owed to the client.
  // Returns null when billable value is unknown (batchLoadError).
  const getUndeliveredValue = (o) => {
    if (!isPartialBatch(o)) return 0;
    const bv = getBillableValue(o);
    if (bv === null) return null;
    return Math.max(Number(o.total_value || 0) - bv, 0);
  };

  // Collectable balance = delivered/billable value minus payments.
  // Returns null when delivered value is unknown.
  const getBalance = (o) => {
    const bv = getBillableValue(o);
    if (bv === null) return null;
    return Math.max(bv - (payTotals[o.id] || 0), 0);
  };
  const isOverdue  = (o) => o.due_date && !["Delivered", "Closed"].includes(o.status) && new Date(o.due_date + "T12:00:00") < now;

  const inRange = useCallback((dateStr) => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d >= dateFrom && d <= dateTo;
  }, [dateFrom, dateTo]);

  // ── Filter logic per report type ──
  const filterFn = useMemo(() => ({
    overdue:     (o) => isOverdue(o),
    "due-week":  (o) => {
      if (!o.due_date || ["Delivered", "Closed"].includes(o.status)) return false;
      return inRange(o.due_date + "T12:00:00");
    },
    production:  (o) => o.status === "Production",
    ready:       (o) => o.status === "Ready for Delivery",
    receivables: (o) => !["Closed"].includes(o.status) && getBalance(o) > 0,
    collections: (o) => inRange(o.due_date + "T12:00:00") && getBalance(o) > 0,
    "sales-week":(o) => inRange(o.created_at),
    completed:   (o) => ["Delivered", "Closed"].includes(o.status) && inRange(o.created_at),
    workload:    (o) => PROD_STATUSES.includes(o.status),
    // Supplier report filters
    "supplier-payables":  (p) => ["Unpaid", "Part Paid"].includes(p.payment_status),
    "supplier-purchases": (p) => inRange(p.purchase_date + "T12:00:00"),
    // P&L: all non-cancelled orders within the date range
    "order-pnl": (o) => !["Cancelled", "Cancelled/Refunded", "Refunded"].includes(o.status) && inRange(o.created_at),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [orders, payTotals, inRange]);

  // ── Apply filters + sorting ──
  const filtered = useMemo(() => {
    const fn = filterFn[reportType] || (() => true);

    // Supplier reports operate on a different dataset
    if (SUPPLIER_REPORTS.includes(reportType)) {
      const q = search.toLowerCase();
      return supplierPurchases.filter((p) => {
        if (!fn(p)) return false;
        if (clientFilter !== "All" && p.supplier_name !== clientFilter) return false;
        if (search) return [p.supplier_name, p.items_bought, p.payment_status].filter(Boolean).join(" ").toLowerCase().includes(q);
        return true;
      });
    }

    let res = orders.filter((o) => {
      if (!fn(o)) return false;
      if (clientFilter !== "All" && o.client !== clientFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return [o.client, o.order_num, o.items, o.assigned_to, o.notes].filter(Boolean).join(" ").toLowerCase().includes(q);
      }
      return true;
    });

    if (sortField) {
      res = [...res].sort((a, b) => {
        let av, bv;
        if (sortField === "total_value") {
          av = parseFloat(a.total_value) || 0;
          bv = parseFloat(b.total_value) || 0;
          return sortDir === "asc" ? av - bv : bv - av;
        }
        if (sortField === "balance") {
          av = getBalance(a); bv = getBalance(b);
          return sortDir === "asc" ? av - bv : bv - av;
        }
        av = (a[sortField] || "").toString().toLowerCase();
        bv = (b[sortField] || "").toString().toLowerCase();
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return res;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, supplierPurchases, reportType, clientFilter, search, filterFn, sortField, sortDir]);

  // ── Unique clients / suppliers for filter dropdown ──
  const clients = useMemo(() => {
    const fn = filterFn[reportType] || (() => true);
    if (SUPPLIER_REPORTS.includes(reportType)) {
      const set = new Set(supplierPurchases.filter(fn).map((p) => p.supplier_name));
      return Array.from(set).sort();
    }
    const set = new Set(orders.filter(fn).map((o) => o.client));
    return Array.from(set).sort();
  }, [orders, supplierPurchases, reportType, filterFn]);

  // ── Workload summary (category breakdown) ──
  const workloadSummary = useMemo(() => {
    if (reportType !== "workload") return null;
    const catMap = {};
    filtered.forEach((o) => {
      const items = allItems[o.id] || [];
      if (items.length === 0) {
        catMap["Other"] = (catMap["Other"] || 0) + 1;
      } else {
        items.forEach((i) => { catMap[i.category || "Other"] = (catMap[i.category || "Other"] || 0) + (i.quantity || 1); });
      }
    });
    return CATEGORIES.map((cat) => ({ label: cat, qty: catMap[cat] || 0 })).filter((c) => c.qty > 0);
  }, [filtered, allItems, reportType]);

  // ── Total units ──
  const totalUnits = useMemo(() =>
    filtered.reduce((s, o) => {
      const items = allItems[o.id] || [];
      return s + (items.length > 0 ? items.reduce((t, i) => t + (i.quantity || 1), 0) : 1);
    }, 0),
  [filtered, allItems]);

  // ── Financial / Sales KPI summary ──
  const summaryKpis = useMemo(() => {
    if (SUPPLIER_REPORTS.includes(reportType) && filtered.length > 0) {
      const totalValue   = filtered.reduce((s, p) => s + (parseFloat(p.total_amount) || 0), 0);
      const totalPaid    = filtered.reduce((s, p) => s + (parseFloat(p.amount_paid)  || 0), 0);
      const totalBalance = Math.max(totalValue - totalPaid, 0);
      return { totalValue, totalPaid, totalBalance };
    }
    if (!SUMMARY_KPI_REPORTS.includes(reportType) || filtered.length === 0) return null;
    // Each metric is computed over its own population to avoid mixing incompatible sets.
    // totalBillable and totalCollectableBalance exclude orders with unknown delivered value.
    // totalPaid covers all orders — payments are factual regardless of delivery status.
    // unknownCount lets the UI flag how many orders are missing from the value totals.
    const totalBillable          = filtered.reduce((s, o) => { const bv = getBillableValue(o); return bv !== null ? s + bv : s; }, 0);
    const totalPaid              = filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0);
    const totalCollectableBalance= filtered.reduce((s, o) => { const bal = getBalance(o); return bal !== null ? s + bal : s; }, 0);
    const unknownCount           = filtered.filter(o => getBillableValue(o) === null).length;
    return { totalBillable, totalPaid, totalCollectableBalance, unknownCount };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, payTotals, reportType, deliveredValues, batchOrderIds, batchLoadError]);

  // ── P&L KPI summary ──
  const pnlKpis = useMemo(() => {
    if (reportType !== "order-pnl" || filtered.length === 0) return null;
    const totalRevenue = filtered.reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0);
    const totalCosts   = filtered.reduce((s, o) => s + (pnlCosts[o.id] || 0), 0);
    const totalProfit  = totalRevenue - totalCosts;
    const avgMargin    = totalRevenue > 0 ? (totalProfit / totalRevenue * 100) : 0;
    return { totalRevenue, totalCosts, totalProfit, avgMargin };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, pnlCosts, reportType]);

  // ── Flat card rows (mobile) ──
  const cardItems = useMemo(() => {
    const rows = [];
    filtered.forEach((order) => {
      const items   = allItems[order.id] || [];
      const paid    = payTotals[order.id] || 0;
      const tv      = getBillableValue(order);
      const balance = getBalance(order);
      const payBadge = balance === null ? "unknown" : balance <= 0 ? "paid" : paid > 0 ? "partial" : "outstanding";
      if (items.length === 0) {
        rows.push({ order, item: null, paid, tv, balance, payBadge });
      } else {
        items.forEach((item) => rows.push({ order, item, paid, tv, balance, payBadge }));
      }
    });
    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, allItems, payTotals]);

  // ── Report metadata ──
  const reportMeta       = REPORT_TYPES.find((r) => r.id === reportType) || REPORT_TYPES[0];
  const isFinancial      = FINANCIAL_REPORTS.includes(reportType);
  const isSupplierReport = SUPPLIER_REPORTS.includes(reportType);
  const isOrderPnl       = reportType === "order-pnl";
  const showDateRange    = DATE_RANGE_REPORTS.includes(reportType) || SUPPLIER_DATE_RANGE.includes(reportType);

  // ── Date range preset handler ──
  const applyPreset = (preset) => {
    setDatePreset(preset);
    if (preset !== "custom") {
      const [f, t] = getPresetRange(preset);
      setDateFrom(f);
      setDateTo(t);
    }
  };

  // ── Sort handler ──
  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  };
  const sortIcon = (field) => sortField === field ? (sortDir === "asc" ? " ↑" : " ↓") : " ⇅";

  // ── PDF Export ──
  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/reports/pdf", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isOrderPnl ? {
            reportLabel: reportMeta.label,
            orderPnL: filtered.map((o) => ({
              order_num:     o.order_num     || "",
              client:        o.client        || "",
              status:        o.status        || "",
              revenue:       parseFloat(o.total_value) || 0,
              collected:     payTotals[o.id]            || 0,
              material_cost: pnlCosts[o.id]             || 0,
              purchases:     pnlPurchases[o.id]         || [],
            })),
            dateFrom: showDateRange ? dateFrom.toISOString() : null,
            dateTo:   showDateRange ? dateTo.toISOString()   : null,
            userName: displayName,
          } : isSupplierReport ? {
            reportLabel:       reportMeta.label,
            supplierPurchases: filtered,
            dateFrom:          showDateRange ? dateFrom.toISOString() : null,
            dateTo:            showDateRange ? dateTo.toISOString()   : null,
            userName: displayName,
          } : {
            reportLabel:     reportMeta.label,
            orders:          filtered,
            allItems,
            payTotals,
            dateFrom:        showDateRange ? dateFrom.toISOString() : null,
            dateTo:          showDateRange ? dateTo.toISOString()   : null,
            userName: displayName,
            showFinancials:  isFinancial,
            workloadSummary: reportType === "workload" ? workloadSummary : null,
          }
        ),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.detail || err.error || "PDF generation failed");
      }

      const blob      = await res.blob();
      const url       = URL.createObjectURL(blob);
      const a         = document.createElement("a");
      a.href          = url;
      const safeLabel = (reportMeta.label || "Report").replace(/\s+/g, "_");
      const dateStr   = new Date().toISOString().split("T")[0];
      a.download      = `${safeLabel}_${dateStr}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("PDF error: " + err.message);
    }
    setExporting(false);
  };

  if (!loaded) return <Loading />;

  // ── Batch load error banner (non-blocking — page renders but financial data is stale) ──
  const BatchErrorBanner = batchLoadError ? (
    <Notice color="red" style={{ marginBottom: 16, fontSize: 12, fontWeight: 600 }}>
      ⚠ {batchLoadError} Partially delivered batch orders show "Delivered value unavailable" and are excluded from Billable Value and Collectable Balance; recorded payments remain included.
    </Notice>
  ) : null;

  // ── Formatters ──
  const fmtDate    = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";
  const fmtKES     = (n) => n ? `KES ${Math.round(n).toLocaleString("en-KE")}` : "—";
  const fmtK       = (n) => {
    if (!n) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000)     return (n / 1_000).toFixed(0) + "K";
    return Math.round(n).toString();
  };
  const fmtDisplay = (d) => d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

  const daySpan = Math.round((dateTo - dateFrom) / (1000 * 60 * 60 * 24));

  // ── Preset label for date chip ──
  const presetLabel = DATE_PRESETS.find((p) => p.id === datePreset)?.label || "Custom";

  // ── Shared sub-sections ──────────────────────────────────────────────────────

  // Report type tab bar — uses shared TabBar from ds.js
  const reportTabs = REPORT_TYPES.map((r) => ({ key: r.id, label: `${r.icon} ${r.label}` }));
  const handleTabSelect = (key) => {
    setReportType(key);
    setClientFilter("All");
    setSearch("");
    setSortField(null);
    setMobileTableView(false);
  };

  // Date range panel (full inline block)
  const DatePanel = () => showDateRange ? (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radiusSm, padding: "12px 14px", marginBottom: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
        Date range — {reportMeta.dateField === "due_date" ? "due date" : "order created"}
      </div>
      <div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap" }}>
        {DATE_PRESETS.map((p) => (
          <button key={p.id} onClick={() => applyPreset(p.id)} style={{
            padding: "4px 11px", borderRadius: 5, fontSize: 11, cursor: "pointer", fontWeight: 500,
            border: `1.5px solid ${datePreset === p.id ? C.ink : C.line}`,
            background: datePreset === p.id ? C.ink : C.bg,
            color: datePreset === p.id ? C.card : C.muted,
          }}>{p.label}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="date" value={toInputDate(dateFrom)}
          onChange={(e) => { setDatePreset("custom"); setDateFrom(new Date(e.target.value + "T00:00:00")); }}
          style={{ padding: "6px 10px", borderRadius: C.radiusSm, border: `1px solid ${C.line}`, fontSize: 12, background: C.bg }} />
        <span style={{ color: C.faint, fontSize: 13 }}>→</span>
        <input type="date" value={toInputDate(dateTo)}
          onChange={(e) => { setDatePreset("custom"); setDateTo(new Date(e.target.value + "T23:59:59")); }}
          style={{ padding: "6px 10px", borderRadius: C.radiusSm, border: `1px solid ${C.line}`, fontSize: 12, background: C.bg }} />
        <span style={{ fontSize: 11, color: C.faint }}>{daySpan} day{daySpan !== 1 ? "s" : ""}</span>
      </div>
    </div>
  ) : null;

  // KPI stat grid
  const KpiGrid = () => summaryKpis ? (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 8 }}>
      {[
        { label: "Orders",                    val: filtered.length,                                color: C.ink,   mono: false },
        { label: "Delivered / Billable (KES)", val: fmtK(summaryKpis.totalBillable),               color: C.blue,  mono: true },
        { label: "Total Payments Recorded",   val: fmtK(summaryKpis.totalPaid),                   color: C.green, mono: true },
        {
          label: "Collectable Balance (KES)",
          val: summaryKpis.totalCollectableBalance > 0 ? fmtK(summaryKpis.totalCollectableBalance) : "✓ Cleared",
          color: summaryKpis.totalCollectableBalance > 0 ? C.red : C.green,
          mono: summaryKpis.totalCollectableBalance > 0,
        },
      ].map((k) => (
        <div key={k.label} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius, padding: isMobile ? "16px 12px" : "12px 14px", textAlign: isMobile ? "center" : "left" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: k.color, fontFamily: k.mono ? C.mono : undefined, letterSpacing: k.mono ? "-0.5px" : undefined, lineHeight: 1 }}>{k.val}</div>
          <div style={{ fontSize: 10, color: C.muted, marginTop: 5 }}>{k.label}</div>
        </div>
      ))}
      </div>
      {summaryKpis.unknownCount > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: C.red, fontWeight: 600 }}>
          ⚠ Delivery value unavailable for {summaryKpis.unknownCount} {summaryKpis.unknownCount === 1 ? "order" : "orders"}. These orders are excluded from Billable Value and Collectable Balance; recorded payments remain included.
        </div>
      )}
    </div>
  ) : null;

  // ── P&L KPI grid ─────────────────────────────────────────────────────────────
  const PnlKpiGrid = () => pnlKpis ? (
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
      {[
        { label: "Orders",         val: String(filtered.length),                                                      color: C.ink,   mono: false },
        { label: "Total Revenue",  val: fmtK(pnlKpis.totalRevenue),                                                   color: C.blue,  mono: true },
        { label: "Material Costs", val: fmtK(pnlKpis.totalCosts),                                                     color: C.red,   mono: true },
        { label: "Gross Profit",   val: pnlKpis.totalProfit >= 0 ? fmtK(pnlKpis.totalProfit) : `-${fmtK(Math.abs(pnlKpis.totalProfit))}`,
          color: pnlKpis.totalProfit >= 0 ? C.green : C.red, mono: true },
      ].map((k) => (
        <div key={k.label} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius, padding: isMobile ? "16px 12px" : "12px 14px", textAlign: isMobile ? "center" : "left" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: k.color, fontFamily: k.mono ? C.mono : undefined, letterSpacing: k.mono ? "-0.5px" : undefined, lineHeight: 1 }}>{k.val}</div>
          <div style={{ fontSize: 10, color: C.muted, marginTop: 5 }}>{k.label}</div>
        </div>
      ))}
    </div>
  ) : null;

  // ── Footer totals (shared) ────────────────────────────────────────────────────
  const FooterTotals = () => filtered.length > 0 ? (
    <div style={{ display: "flex", gap: 20, marginTop: 16, padding: "14px 16px", background: C.card, borderRadius: C.radiusSm, border: `1px solid ${C.line}`, flexWrap: "wrap", fontSize: 13 }}>
      {isOrderPnl ? (() => {
        const totalRev    = filtered.reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0);
        const totalCost   = filtered.reduce((s, o) => s + (pnlCosts[o.id]  || 0), 0);
        const totalProfit = totalRev - totalCost;
        const avgMargin   = totalRev > 0 ? (totalProfit / totalRev * 100) : 0;
        return (
          <>
            <div><span style={{ color: C.muted }}>Orders:</span> <strong>{filtered.length}</strong></div>
            <div><span style={{ color: C.muted }}>Revenue:</span> <strong style={{ fontFamily: C.mono }}>{fmtKES(totalRev)}</strong></div>
            <div><span style={{ color: C.muted }}>Material Costs:</span> <strong style={{ color: C.red, fontFamily: C.mono }}>{fmtKES(totalCost)}</strong></div>
            <div><span style={{ color: C.muted }}>Gross Profit:</span> <strong style={{ color: totalProfit >= 0 ? C.green : C.red, fontFamily: C.mono }}>{fmtKES(totalProfit)}</strong></div>
            <div><span style={{ color: C.muted }}>Avg Margin:</span> <strong style={{ color: avgMargin >= 30 ? C.green : avgMargin >= 10 ? C.amber : C.red }}>{avgMargin.toFixed(1)}%</strong></div>
          </>
        );
      })() : isSupplierReport ? (() => {
        const tv  = filtered.reduce((s, p) => s + (parseFloat(p.total_amount) || 0), 0);
        const col = filtered.reduce((s, p) => s + (parseFloat(p.amount_paid)  || 0), 0);
        const bal = Math.max(tv - col, 0);
        return (
          <>
            <div><span style={{ color: C.muted }}>Purchases:</span> <strong>{filtered.length}</strong></div>
            <div><span style={{ color: C.muted }}>Total:</span> <strong style={{ fontFamily: C.mono }}>{fmtKES(tv)}</strong></div>
            <div><span style={{ color: C.muted }}>Paid:</span> <strong style={{ color: C.green, fontFamily: C.mono }}>{fmtKES(col)}</strong></div>
            <div><span style={{ color: C.muted }}>Outstanding:</span> <strong style={{ color: bal > 0 ? C.red : C.green, fontFamily: C.mono }}>{fmtKES(bal)}</strong></div>
          </>
        );
      })() : (
        <>
          <div><span style={{ color: C.muted }}>Orders:</span> <strong>{filtered.length}</strong></div>
          <div><span style={{ color: C.muted }}>Units:</span> <strong>{totalUnits}</strong></div>
          {(isFinancial || reportType === "sales-week" || reportType === "completed") && (() => {
            const tv  = filtered.reduce((s, o) => { const bv = getBillableValue(o); return bv !== null ? s + bv : s; }, 0);
            const col = filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0);
            const bal = filtered.reduce((s, o) => { const b = getBalance(o); return b !== null ? s + b : s; }, 0);
            return (
              <>
                <div><span style={{ color: C.muted }}>Total Value:</span> <strong style={{ fontFamily: C.mono }}>{fmtKES(tv)}</strong></div>
                {isFinancial
                  ? <div><span style={{ color: C.muted }}>Outstanding:</span> <strong style={{ color: C.red, fontFamily: C.mono }}>{fmtKES(bal)}</strong></div>
                  : <div><span style={{ color: C.muted }}>Collected:</span> <strong style={{ color: C.green, fontFamily: C.mono }}>{fmtKES(col)}</strong></div>
                }
              </>
            );
          })()}
        </>
      )}
    </div>
  ) : null;

  // ── Mobile card layout ────────────────────────────────────────────────────────
  const MobileLayout = () => (
    <div>
      {/* Title */}
      <div style={{ padding: "20px 16px 12px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 900, marginBottom: "4px" }}>{reportMeta.icon} {reportMeta.label} Report</h1>
        <p style={{ color: C.muted, fontSize: "13px" }}>
          {filtered.length} order{filtered.length !== 1 ? "s" : ""} · {totalUnits} units
          {showDateRange && <> · {fmtDisplay(dateFrom)} – {fmtDisplay(dateTo)}</>}
        </p>
      </div>

      {/* Batch load error */}
      {BatchErrorBanner && <div style={{ padding: "0 16px" }}>{BatchErrorBanner}</div>}

      {/* PDF button — full width */}
      <div style={{ padding: "0 16px 16px" }}>
        <button onClick={handleExport} disabled={exporting || filtered.length === 0} style={{
          width: "100%", padding: "13px", borderRadius: "12px", border: "none",
          background: filtered.length === 0 ? C.line : C.ink, color: C.card,
          fontSize: 14, fontWeight: 600, cursor: filtered.length === 0 ? "not-allowed" : "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          opacity: exporting ? 0.6 : 1,
        }}>
          📄 {exporting ? "Generating..." : "Download PDF"}
        </button>
      </div>

      {/* Tab bar */}
      <SharedTabBar tabs={reportTabs} active={reportType} onSelect={handleTabSelect} />

      {/* Date chip (collapsed → expands inline) */}
      {showDateRange && (
        <div style={{ margin: "0 16px 12px" }}>
          <button onClick={() => setDateChipOpen((v) => !v)} style={{
            width: "100%", background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius,
            padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: "pointer", textAlign: "left",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: C.radiusSm, background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>📅</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{presetLabel}</div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{fmtDisplay(dateFrom)} – {fmtDisplay(dateTo)} · {daySpan} days</div>
              </div>
            </div>
            <span style={{ fontSize: 16, color: C.muted }}>{dateChipOpen ? "▲" : "▼"}</span>
          </button>
          {dateChipOpen && (
            <div style={{ marginTop: 8 }}>
              <DatePanel />
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div style={{ padding: "0 16px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ border: `1px solid ${C.line}`, borderRadius: C.radius, padding: "10px 12px", fontSize: 13, background: C.card, color: C.ink }} />
        <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}
          style={{ border: `1px solid ${C.line}`, borderRadius: C.radius, padding: "10px 12px", fontSize: 13, background: C.card, fontWeight: 500, color: C.ink }}>
          <option value="All">All Clients ({clients.length})</option>
          {clients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* KPI stat cards */}
      <div style={{ padding: "0 16px 16px" }}>
        <KpiGrid />
        <PnlKpiGrid />
      </div>

      {/* Workload summary */}
      {workloadSummary && workloadSummary.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", padding: "0 16px" }}>
          {workloadSummary.map((cat) => (
            <div key={cat.label} style={{ padding: "12px 16px", borderRadius: C.radius, background: C.card, border: `1px solid ${C.line}`, flex: "1 1 120px", minWidth: "110px" }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.coral, fontFamily: C.mono }}>{cat.qty}</div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 500 }}>{cat.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Toggle: Full Table */}
      <div style={{ padding: "0 16px 8px", display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setMobileTableView(true)} style={{ fontSize: 12, color: C.muted, background: "none", border: `1px solid ${C.line}`, borderRadius: C.radiusSm, padding: "5px 12px", cursor: "pointer" }}>
          Full Table ↗
        </button>
      </div>

      {/* Line item cards */}
      {isOrderPnl ? (
        filtered.length === 0 ? (
          <div style={{ margin: "0 16px 24px", padding: "40px 20px", textAlign: "center", background: C.card, borderRadius: C.radius, border: `1px solid ${C.line}` }}>
            <div style={{ fontSize: "32px", marginBottom: "10px" }}>📊</div>
            <div style={{ fontSize: "14px", color: C.muted }}>No orders match this report.</div>
          </div>
        ) : (
          <div style={{ padding: "0 16px 24px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>
              Orders ({filtered.length})
            </div>
            {filtered.map((o) => {
              const revenue        = parseFloat(o.total_value) || 0;
              const collected      = payTotals[o.id]    || 0;
              const costs          = pnlCosts[o.id]     || 0;
              const profit         = revenue - costs;
              const margin         = revenue > 0 ? (profit / revenue * 100) : 0;
              const sc             = ALL_STATUS_COLORS[o.status] || {};
              const orderPurchases = pnlPurchases[o.id] || [];
              return (
                <div key={o.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius, padding: "14px", marginBottom: "10px" }}>
                  {/* Header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", marginBottom: "10px" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "14px" }}>{o.client}</div>
                      <div style={{ fontSize: "11px", color: C.muted, marginTop: "2px" }}>{o.order_num}</div>
                    </div>
                    <StatusBadge status={o.status} colors={sc} />
                  </div>
                  {/* P&L summary grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px", paddingTop: "10px", borderTop: `1px solid ${C.line}` }}>
                    <div>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase" }}>Revenue</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, fontFamily: C.mono }}>{fmtKES(revenue)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase" }}>Material Costs</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, fontFamily: C.mono, color: C.red }}>{costs > 0 ? fmtKES(costs) : "—"}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase" }}>Gross Profit</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, fontFamily: C.mono, color: profit >= 0 ? C.green : C.red }}>{fmtKES(profit)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase" }}>Margin</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: margin >= 30 ? C.green : margin >= 10 ? C.amber : C.red }}>{margin.toFixed(1)}%</div>
                    </div>
                  </div>
                  {/* Itemized purchases */}
                  {orderPurchases.length > 0 && (
                    <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: `1px solid ${C.line}` }}>
                      <div style={{ fontSize: "9px", fontWeight: 700, color: C.faint, textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: "6px" }}>Cost Breakdown</div>
                      {orderPurchases.map((p, pIdx) => {
                        const dStr = p.purchase_date
                          ? new Date(p.purchase_date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })
                          : "";
                        return (
                          <div key={pIdx} style={{ display: "flex", alignItems: "flex-start", gap: "6px", padding: "5px 0", borderBottom: pIdx < orderPurchases.length - 1 ? `1px solid ${C.line}` : "none" }}>
                            <span style={{ color: C.coral, fontWeight: 700, fontSize: "11px", flexShrink: 0, marginTop: "1px" }}>↳</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: "12px", fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.supplier_name}</div>
                              <div style={{ fontSize: "10px", color: C.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.items_bought}{dStr ? ` · ${dStr}` : ""}</div>
                            </div>
                            <div style={{ fontSize: "12px", fontWeight: 700, color: C.red, fontFamily: C.mono, flexShrink: 0 }}>{fmtKES(p.total_amount)}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : isSupplierReport ? (
        filtered.length === 0 ? (
          <div style={{ margin: "0 16px 24px", padding: "40px 20px", textAlign: "center", background: C.card, borderRadius: C.radius, border: `1px solid ${C.line}` }}>
            <div style={{ fontSize: "32px", marginBottom: "10px" }}>📊</div>
            <div style={{ fontSize: "14px", color: C.muted }}>No purchases match this report.</div>
          </div>
        ) : (
          <div style={{ padding: "0 16px 24px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>
              Purchases ({filtered.length})
            </div>
            {filtered.map((p) => {
              const bal  = Math.max((parseFloat(p.total_amount) || 0) - (parseFloat(p.amount_paid) || 0), 0);
              const sClr = p.payment_status === "Paid" ? { bg: "#dcfce7", color: C.green } : p.payment_status === "Part Paid" ? { bg: "#fef9c3", color: C.amber } : { bg: "#fee2e2", color: C.red };
              const dStr = p.purchase_date ? new Date(p.purchase_date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
              return (
                <div key={p.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius, padding: "14px", marginBottom: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: "14px" }}>{p.supplier_name}</div>
                      <div style={{ fontSize: "11px", color: C.muted, marginTop: "2px" }}>{dStr} · {p.items_bought || "—"}</div>
                    </div>
                    <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 8px", borderRadius: "6px", whiteSpace: "nowrap", background: sClr.bg, color: sClr.color }}>{p.payment_status}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "10px", paddingTop: "10px", borderTop: `1px solid ${C.line}` }}>
                    <div>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase" }}>Total</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, fontFamily: C.mono }}>{fmtKES(parseFloat(p.total_amount) || 0)}</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase" }}>Paid</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: C.green, fontFamily: C.mono }}>{fmtKES(parseFloat(p.amount_paid) || 0)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase" }}>Balance</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: bal > 0 ? C.red : C.green, fontFamily: C.mono }}>{fmtKES(bal)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : cardItems.length === 0 ? (
        <div style={{ margin: "0 16px 24px", padding: "40px 20px", textAlign: "center", background: C.card, borderRadius: C.radius, border: `1px solid ${C.line}` }}>
          <div style={{ fontSize: "32px", marginBottom: "10px" }}>📊</div>
          <div style={{ fontSize: "14px", color: C.muted }}>No orders match this report.</div>
        </div>
      ) : (
        <div style={{ padding: "0 16px 24px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>
            Line Items ({cardItems.length})
          </div>
          {cardItems.map(({ order, item, paid, tv, balance, payBadge }, idx) => {
            const sc = ALL_STATUS_COLORS[order.status] || {};
            const name = item ? (item.description || item.category || "Item") : (order.items || order.client);
            const spec = item ? [item.size, item.finish_type !== "None" && item.finish_type, item.wood_type].filter(Boolean).join(" · ") : "";
            const payColors = { paid: { bg: "#dcfce7", color: C.green }, partial: { bg: "#fef9c3", color: C.amber }, outstanding: { bg: "#fee2e2", color: C.red } };
            const pClr = payColors[payBadge] || payColors.outstanding;
            return (
              <div key={`${order.id}-${item?.id || idx}`} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius, padding: "14px", marginBottom: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                    <div style={{ fontSize: "11px", color: C.muted, marginTop: "2px" }}>
                      {order.client} · {order.order_num}
                      {order.due_date && <> · Due {fmtDate(order.due_date)}</>}
                    </div>
                  </div>
                  {isFinancial ? (
                    <span style={{ fontSize: "10px", fontWeight: 700, padding: "3px 8px", borderRadius: "6px", whiteSpace: "nowrap", background: pClr.bg, color: pClr.color }}>
                      {payBadge === "paid" ? "Paid" : payBadge === "partial" ? "Partial" : "Outstanding"}
                    </span>
                  ) : (
                    <StatusBadge status={order.status} colors={sc} />
                  )}
                </div>
                {/* Numbers row */}
                {isFinancial ? (
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "10px", paddingTop: "10px", borderTop: `1px solid ${C.line}` }}>
                    <div>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase", letterSpacing: "0.5px" }}>Total</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, marginTop: "1px", fontFamily: C.mono }}>{fmtKES(tv)}</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase", letterSpacing: "0.5px" }}>Paid</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, marginTop: "1px", color: C.green, fontFamily: C.mono }}>{fmtKES(paid)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "10px", color: C.faint, textTransform: "uppercase", letterSpacing: "0.5px" }}>Balance</div>
                      <div style={{ fontSize: "13px", fontWeight: 700, marginTop: "1px", color: balance > 0 ? C.red : C.green, fontFamily: C.mono }}>{fmtKES(balance)}</div>
                    </div>
                  </div>
                ) : item ? (
                  <div style={{ display: "flex", gap: "16px", marginTop: "8px", flexWrap: "wrap" }}>
                    <div style={{ fontSize: "12px", color: C.ink }}>
                      <span style={{ color: C.faint, fontSize: "11px" }}>Qty </span>
                      <strong>{item.quantity || 1}</strong>
                    </div>
                    {spec && <div style={{ fontSize: "11px", color: C.muted }}>{spec}</div>}
                    {item.notes && <div style={{ fontSize: "11px", color: C.muted, fontStyle: "italic" }}>{item.notes}</div>}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div style={{ padding: "0 16px 8px" }}>
        <FooterTotals />
      </div>
    </div>
  );

  // ── Desktop layout ────────────────────────────────────────────────────────────
  const DesktopLayout = () => (
    <div style={{ padding: "20px 16px", color: C.ink }}>
      <div style={{ marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <h1 style={{ fontSize: "20px", fontWeight: 800, letterSpacing: "-0.4px", margin: 0, color: C.ink }}>{reportMeta.icon} {reportMeta.label} Report</h1>
            <p style={{ fontSize: "13px", color: C.muted, marginTop: "4px" }}>
              {filtered.length} order{filtered.length !== 1 ? "s" : ""} · {totalUnits} units
              {showDateRange && <> · <span style={{ color: C.ink }}>{fmtDisplay(dateFrom)} – {fmtDisplay(dateTo)}</span></>}
            </p>
          </div>
          <Btn primary onClick={handleExport} disabled={exporting || filtered.length === 0}>
            {exporting ? "Generating…" : "Download PDF"}
          </Btn>
        </div>
      </div>

      <SharedTabBar tabs={reportTabs} active={reportType} onSelect={handleTabSelect} />
      <DatePanel />

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ flex: "1 1 180px", padding: "8px 12px", borderRadius: C.radiusSm, border: `1px solid ${C.line}`, fontSize: 13, background: C.card, minWidth: "140px", color: C.ink }} />
        <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: C.radiusSm, border: `1px solid ${C.line}`, fontSize: 13, background: C.card, fontWeight: 500, cursor: "pointer", color: C.ink }}>
          <option value="All">All Clients ({clients.length})</option>
          {clients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {BatchErrorBanner}
      <KpiGrid />
      <PnlKpiGrid />

      {/* Workload summary */}
      {workloadSummary && workloadSummary.length > 0 && (
        <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
          {workloadSummary.map((cat) => (
            <div key={cat.label} style={{ padding: "12px 16px", borderRadius: C.radiusSm, background: C.card, border: `1px solid ${C.line}`, flex: "1 1 120px", minWidth: "110px" }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.coral, fontFamily: C.mono }}>{cat.qty}</div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 500 }}>{cat.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div style={{ padding: "60px 20px", textAlign: "center", background: C.card, borderRadius: C.radius, border: `1px solid ${C.line}` }}>
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>📊</div>
          <div style={{ fontSize: "14px", color: C.muted }}>{isSupplierReport ? "No supplier purchases match this report." : "No orders match this report."}</div>
        </div>
      ) : isOrderPnl ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", background: C.card, borderRadius: C.radiusSm, overflow: "hidden", border: `1px solid ${C.line}` }}>
            <thead>
              <tr style={{ background: C.ink, color: C.card, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                <th style={th}>Order #</th>
                <th style={th}>Client</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Revenue (KES)</th>
                <th style={{ ...th, textAlign: "right" }}>Collected (KES)</th>
                <th style={{ ...th, textAlign: "right" }}>Material Costs</th>
                <th style={{ ...th, textAlign: "right" }}>Gross Profit</th>
                <th style={{ ...th, textAlign: "right" }}>Margin %</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o, idx) => {
                const revenue      = parseFloat(o.total_value) || 0;
                const collected    = payTotals[o.id]    || 0;
                const costs        = pnlCosts[o.id]     || 0;
                const profit       = revenue - costs;
                const margin       = revenue > 0 ? (profit / revenue * 100) : 0;
                const sc           = ALL_STATUS_COLORS[o.status] || {};
                const orderPurchases = pnlPurchases[o.id] || [];
                const rowBg        = idx % 2 === 0 ? C.card : C.bg;
                const subBg        = idx % 2 === 0 ? C.bg : C.card;
                return (
                  <Fragment key={o.id}>
                    {/* Order summary row */}
                    <tr style={{ background: rowBg, borderBottom: orderPurchases.length > 0 ? "none" : `2px solid ${C.line}` }}>
                      <td style={{ ...td, fontFamily: C.mono, fontSize: "12px" }}>{o.order_num}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{o.client}</td>
                      <td style={td}><StatusBadge status={o.status} colors={sc} /></td>
                      <td style={{ ...td, textAlign: "right", fontFamily: C.mono }}>{fmtKES(revenue)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: C.mono, color: C.green }}>{fmtKES(collected)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: C.mono, color: C.red, fontWeight: costs > 0 ? 700 : 400 }}>{costs > 0 ? fmtKES(costs) : "—"}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700, fontFamily: C.mono, color: profit >= 0 ? C.green : C.red }}>{fmtKES(profit)}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 600, color: margin >= 30 ? C.green : margin >= 10 ? C.amber : C.red }}>{margin.toFixed(1)}%</td>
                    </tr>
                    {/* Purchase sub-rows */}
                    {orderPurchases.map((p, pIdx) => {
                      const dStr = p.purchase_date
                        ? new Date(p.purchase_date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })
                        : "";
                      return (
                        <tr key={pIdx} style={{ background: subBg, borderBottom: pIdx === orderPurchases.length - 1 ? `2px solid ${C.line}` : `1px solid ${C.line}` }}>
                          <td colSpan={2} style={{ ...td, paddingLeft: "24px", fontSize: "11px", color: C.ink }}>
                            <span style={{ color: C.coral, marginRight: "6px", fontWeight: 700 }}>↳</span>
                            <strong>{p.supplier_name}</strong>
                            {dStr && <span style={{ color: C.faint, fontWeight: 400, marginLeft: "6px" }}>· {dStr}</span>}
                          </td>
                          <td colSpan={3} style={{ ...td, fontSize: "11px", color: C.muted }}>{p.items_bought}</td>
                          <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontSize: "12px", fontWeight: 700, color: C.red }}>{fmtKES(p.total_amount)}</td>
                          <td colSpan={2} style={td} />
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : isSupplierReport ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", background: C.card, borderRadius: C.radiusSm, overflow: "hidden", border: `1px solid ${C.line}` }}>
            <thead>
              <tr style={{ background: C.ink, color: C.card, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                <th style={th}>Supplier</th>
                <th style={th}>Date</th>
                <th style={th}>Items Bought</th>
                <th style={{ ...th, textAlign: "right" }}>Total (KES)</th>
                <th style={{ ...th, textAlign: "right" }}>Paid (KES)</th>
                <th style={{ ...th, textAlign: "right" }}>Balance (KES)</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, idx) => {
                const bal = Math.max((parseFloat(p.total_amount) || 0) - (parseFloat(p.amount_paid) || 0), 0);
                const sClr = p.payment_status === "Paid" ? { bg: "#dcfce7", text: C.green } : p.payment_status === "Part Paid" ? { bg: "#fef9c3", text: C.amber } : { bg: "#fee2e2", text: C.red };
                const dStr = p.purchase_date ? new Date(p.purchase_date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
                return (
                  <tr key={p.id} style={{ background: idx % 2 === 0 ? C.card : C.bg, borderBottom: `1px solid ${C.line}` }}>
                    <td style={{ ...td, fontWeight: 700 }}>{p.supplier_name}</td>
                    <td style={td}>{dStr}</td>
                    <td style={{ ...td, fontSize: "12px", color: C.muted }}>{p.items_bought || "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: C.mono }}>{fmtKES(parseFloat(p.total_amount) || 0)}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: C.mono, color: C.green }}>{fmtKES(parseFloat(p.amount_paid) || 0)}</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 700, color: bal > 0 ? C.red : C.green, fontFamily: C.mono }}>{fmtKES(bal)}</td>
                    <td style={td}><span style={{ fontSize: "10px", fontWeight: 700, color: sClr.text, background: sClr.bg, padding: "3px 8px", borderRadius: "4px", whiteSpace: "nowrap" }}>{p.payment_status}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", background: C.card, borderRadius: C.radiusSm, overflow: "hidden", border: `1px solid ${C.line}` }}>
            <thead>
              <tr style={{ background: C.ink, color: C.card, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("client")}>Client{sortIcon("client")}</th>
                <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("order_num")}>Order #{sortIcon("order_num")}</th>
                <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("due_date")}>Due Date{sortIcon("due_date")}</th>
                <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("status")}>Status{sortIcon("status")}</th>
                <th style={th}>Category</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "center" }}>Qty</th>
                <th style={th}>Size</th>
                <th style={th}>Finish</th>
                {!isFinancial && <th style={th}>Wood</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right", cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("total_value")}>Delivered Value{sortIcon("total_value")}</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right" }}>Paid</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right", cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("balance")}>Balance{sortIcon("balance")}</th>}
                {!isFinancial && <th style={th}>Notes</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((order) => {
                const items        = allItems[order.id] || [];
                const paid         = payTotals[order.id] || 0;
                const tv           = getBillableValue(order);
                const undelivered  = getUndeliveredValue(order); // 0 for non-batch orders
                const balance      = getBalance(order);
                const sc           = ALL_STATUS_COLORS[order.status] || {};

                if (items.length === 0) {
                  return (
                    <tr key={order.id} style={{ borderBottom: `2px solid ${C.line}` }}>
                      <td style={{ ...td, fontWeight: 700 }}>{order.client}</td>
                      <td style={{ ...td, fontFamily: C.mono, fontSize: "12px" }}>{order.order_num}</td>
                      <td style={td}>{fmtDate(order.due_date)}</td>
                      <td style={td}><StatusBadge status={order.status} colors={sc} /></td>
                      <td style={td}>—</td>
                      <td style={td}>{order.items || "—"}</td>
                      <td style={{ ...td, textAlign: "center" }}>—</td>
                      <td style={td}>—</td>
                      <td style={td}>—</td>
                      {!isFinancial && <td style={td}>—</td>}
                      {isFinancial && (
                        <td style={{ ...td, textAlign: "right", fontFamily: C.mono }}>
                          {tv === null
                            ? <span style={{ fontSize: "10px", color: C.red, fontStyle: "italic" }}>Delivered value unavailable</span>
                            : <>
                                {fmtKES(tv)}
                                {undelivered > 0 && (
                                  <div style={{ fontSize: "10px", color: C.muted, marginTop: "2px" }}>
                                    +{fmtKES(undelivered)} undelivered
                                  </div>
                                )}
                              </>
                          }
                        </td>
                      )}
                      {isFinancial && <td style={{ ...td, textAlign: "right", fontFamily: C.mono }}>{fmtKES(paid)}</td>}
                      {isFinancial && <td style={{ ...td, textAlign: "right", fontWeight: 700, color: balance === null ? C.muted : balance > 0 ? C.red : C.green, fontFamily: C.mono }}>{balance === null ? "—" : fmtKES(balance)}</td>}
                      {!isFinancial && <td style={{ ...td, fontSize: "11px", color: C.muted }}>{order.notes || ""}</td>}
                    </tr>
                  );
                }

                return items.map((item, idx) => (
                  <tr key={`${order.id}-${item.id}`} style={{
                    borderBottom: `1px solid ${C.line}`,
                    background: idx % 2 === 1 ? C.bg : C.card,
                  }}>
                    {idx === 0 && (
                      <>
                        <td style={{ ...td, fontWeight: 700 }} rowSpan={items.length}>{order.client}</td>
                        <td style={{ ...td, fontFamily: C.mono, fontSize: "12px" }} rowSpan={items.length}>{order.order_num}</td>
                        <td style={td} rowSpan={items.length}>{fmtDate(order.due_date)}</td>
                        <td style={td} rowSpan={items.length}><StatusBadge status={order.status} colors={sc} /></td>
                      </>
                    )}
                    <td style={td}>{item.category || "—"}</td>
                    <td style={td}>{item.description || "—"}</td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 600, fontFamily: C.mono }}>{item.quantity || 1}</td>
                    <td style={td}>{item.size || "—"}</td>
                    <td style={{ ...td, fontSize: "11px" }}>{[item.finish_type, item.finish_color].filter(Boolean).join(" / ") || "—"}</td>
                    {!isFinancial && <td style={td}>{item.wood_type || "—"}</td>}
                    {isFinancial && idx === 0 && (
                      <td style={{ ...td, textAlign: "right", fontFamily: C.mono }} rowSpan={items.length}>
                        {tv === null
                          ? <span style={{ fontSize: "10px", color: C.red, fontStyle: "italic" }}>Delivered value unavailable</span>
                          : <>
                              {fmtKES(tv)}
                              {undelivered > 0 && (
                                <div style={{ fontSize: "10px", color: C.muted, marginTop: "2px" }}>
                                  +{fmtKES(undelivered)} undelivered
                                </div>
                              )}
                            </>
                        }
                      </td>
                    )}
                    {isFinancial && idx === 0 && <td style={{ ...td, textAlign: "right", fontFamily: C.mono }} rowSpan={items.length}>{fmtKES(paid)}</td>}
                    {isFinancial && idx === 0 && <td style={{ ...td, textAlign: "right", fontWeight: 700, color: balance === null ? C.muted : balance > 0 ? C.red : C.green, fontFamily: C.mono }} rowSpan={items.length}>{balance === null ? "—" : fmtKES(balance)}</td>}
                    {!isFinancial && <td style={{ ...td, fontSize: "11px", color: C.muted }}>{item.notes || ""}</td>}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}

      <FooterTotals />
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  // Mobile: card layout (with "Full Table" toggle to switch back to table)
  // Desktop: existing table layout
  if (isMobile && !mobileTableView) {
    return <MobileLayout />;
  }

  // Mobile table view: wrap with a "← Card View" back button
  if (isMobile && mobileTableView) {
    return (
      <div>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.line}` }}>
          <button onClick={() => setMobileTableView(false)} style={{ fontSize: "13px", color: C.coral, fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            ← Card View
          </button>
        </div>
        <DesktopLayout />
      </div>
    );
  }

  return <DesktopLayout />;
}

// ── Shared styles ──
const th = { padding: "10px 12px", textAlign: "left", fontWeight: 600 };
const td = { padding: "8px 12px", verticalAlign: "top" };

function StatusBadge({ status, colors }) {
  return (
    <span style={{
      fontSize: "10px", fontWeight: 700,
      color: colors.text || C.muted, background: colors.bg || C.bg,
      padding: "3px 8px", borderRadius: "4px", whiteSpace: "nowrap",
    }}>{status}</span>
  );
}
