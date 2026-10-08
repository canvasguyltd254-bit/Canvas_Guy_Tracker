"use client";
import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/shared/supabase/client";
import { fetchAllRows } from "@/shared/lib/reports/fetchAll";

const EMPTY = {
  orders: [], itemsByOrder: {}, payTotals: {}, supplierPurchases: [],
  batchOrderIds: new Set(), deliveredValues: {},
};

// Loads everything the order and supplier reports need. Every read is paged past
// the 1,000-row cap and any failure is surfaced as `error` (never an empty
// report). Delivery-batch data failing is non-fatal: it sets `batchLoadError`,
// and partially delivered orders then show "unavailable" instead of a wrong number.
export default function useReportData(refreshKey) {
  const [state, setState] = useState({ ...EMPTY, loaded: false, error: "", batchLoadError: null });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(a => a + 1), []);

  useEffect(() => {
    let live = true;
    const sb = createClient();

    (async () => {
      setState(s => ({ ...s, loaded: false, error: "" }));
      try {
        const [orders, items, pays, purchases] = await Promise.all([
          fetchAllRows((a, b) => sb.from("orders").select("*").order("created_at", { ascending: false }).order("id").range(a, b), { label: "orders" }),
          fetchAllRows((a, b) => sb.from("order_items").select("*").order("order_id").order("sort_order").order("id").range(a, b), { label: "order items" }),
          fetchAllRows((a, b) => sb.from("order_payments").select("id,order_id,amount").is("reversed_at", null).order("id").range(a, b), { label: "payments" }),
          fetchAllRows((a, b) => sb.from("supplier_purchases").select("*, suppliers(name)").order("purchase_date", { ascending: false }).order("id").range(a, b), { label: "supplier purchases" }),
        ]);

        const itemsByOrder = {};
        items.forEach(i => { (itemsByOrder[i.order_id] ||= []).push(i); });

        const payTotals = {};
        pays.forEach(p => { payTotals[p.order_id] = (payTotals[p.order_id] || 0) + (parseFloat(p.amount) || 0); });

        const supplierPurchases = purchases.map(p => ({ ...p, supplier_name: p.suppliers?.name || "Unknown" }));

        // Delivery batches: prorated gross value of Delivered/Signed batch items per order.
        let batchOrderIds = new Set();
        let deliveredValues = {};
        let batchLoadError = null;
        try {
          const [allBatches, batchItems] = await Promise.all([
            fetchAllRows((a, b) => sb.from("delivery_batches").select("id,order_id,deleted_at").order("id").range(a, b), { label: "delivery batches" }),
            fetchAllRows((a, b) => sb.from("delivery_batch_items")
              .select("id, order_item_id, quantity_delivered, order_items(quantity, unit_price, gross_amount), delivery_batches(order_id, status)")
              .order("id").range(a, b), { label: "delivery batch items" }),
          ]);
          batchOrderIds = new Set(allBatches.filter(b => !b.deleted_at).map(b => b.order_id));

          const itemDelivered = {}, itemMeta = {}, itemToOrder = {};
          batchItems.forEach(bi => {
            const id = bi.order_item_id;
            if (id && bi.order_items && !itemMeta[id]) itemMeta[id] = bi.order_items;
            if (id && bi.delivery_batches?.order_id) itemToOrder[id] = bi.delivery_batches.order_id;
            if (!bi.delivery_batches || !["Delivered", "Signed"].includes(bi.delivery_batches.status)) return;
            const qty = Number(bi.quantity_delivered || 0);
            if (qty > 0) itemDelivered[id] = (itemDelivered[id] || 0) + qty;
          });
          Object.entries(itemDelivered).forEach(([id, raw]) => {
            const meta = itemMeta[id], orderId = itemToOrder[id];
            if (!meta || !orderId) return;
            const ordered = Number(meta.quantity || 0);
            const qty = ordered > 0 ? Math.min(raw, ordered) : raw;
            const unit = meta.gross_amount != null && ordered > 0 ? Number(meta.gross_amount) / ordered : Number(meta.unit_price || 0);
            deliveredValues[orderId] = (deliveredValues[orderId] || 0) + qty * unit;
          });
        } catch (e) {
          console.error("Reports: batch delivery load failed", e);
          batchLoadError = `Delivery values could not be loaded — ${e.message}.`;
          batchOrderIds = new Set();
          deliveredValues = {};
        }

        if (live) setState({ orders, itemsByOrder, payTotals, supplierPurchases, batchOrderIds, deliveredValues, batchLoadError, loaded: true, error: "" });
      } catch (e) {
        console.error("Reports: load failed", e);
        if (live) setState(s => ({ ...s, loaded: true, error: e.message || "Could not load report data." }));
      }
    })();

    return () => { live = false; };
  }, [refreshKey, attempt]);

  return { ...state, retry };
}
