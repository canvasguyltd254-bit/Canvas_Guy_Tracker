"use client";
import { C, Panel, Empty, Badge } from "@/shared/ui/ds";
import { ALL_STATUS_COLORS } from "@/modules/orders/components/constants";
import { SortTh } from "./SortTh";

const kes = n => (n === null || n === undefined ? "—" : n ? `KES ${Math.round(n).toLocaleString("en-KE")}` : "—");
const day = d => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");

export function StatusPill({ status }) {
  const sc = ALL_STATUS_COLORS[status] || {};
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: sc.text || C.muted, background: sc.bg || C.bg, padding: "3px 8px", borderRadius: 4, whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
}

const tbl = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const headRow = { background: C.ink, color: "#fff", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" };
const td = { padding: "9px 12px", verticalAlign: "top" };
const th = { padding: "10px 12px", textAlign: "left", fontWeight: 600 };

// ── Financial reports: one row per order ─────────────────────────────────────
export function FinancialOrders({ rows, sort, onSort, paymentDue, emptyMessage }) {
  if (rows.length === 0) return <Panel><Empty message={emptyMessage} /></Panel>;
  return (
    <Panel>
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead>
            <tr style={headRow}>
              <SortTh field="client" sort={sort} onSort={onSort}>Client</SortTh>
              <SortTh field="order_num" sort={sort} onSort={onSort}>Order</SortTh>
              <th style={th}>Invoice</th>
              <SortTh field="status" sort={sort} onSort={onSort}>Status</SortTh>
              <SortTh field={paymentDue ? "payment_due_date" : "due_date"} sort={sort} onSort={onSort}>{paymentDue ? "Payment due" : "Delivery due"}</SortTh>
              <SortTh field="billable" sort={sort} onSort={onSort} right>Invoiced</SortTh>
              <SortTh field="paid" sort={sort} onSort={onSort} right>Paid</SortTh>
              <SortTh field="balance" sort={sort} onSort={onSort} right>Balance</SortTh>
              <SortTh field="days_late" sort={sort} onSort={onSort} right>Days overdue</SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${C.line}`, background: i % 2 ? C.bg : C.card }}>
                <td style={{ ...td, fontWeight: 700 }}>{r.client}</td>
                <td style={{ ...td, fontFamily: C.mono, fontSize: 12 }}>{r.order_num}</td>
                <td style={{ ...td, fontFamily: C.mono, fontSize: 12 }}>{r.invoice_number || "—"}</td>
                <td style={td}><StatusPill status={r.status} /></td>
                <td style={td}>{day(paymentDue ? r.payment_due_date : r.due_date)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: C.mono }}>
                  {r.billable === null
                    ? <span style={{ fontSize: 10, color: C.red, fontStyle: "italic" }}>Unavailable</span>
                    : <>
                        {kes(r.billable)}
                        {r.undelivered > 0 && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>+{kes(r.undelivered)} undelivered</div>}
                      </>}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: C.mono, color: C.green }}>{kes(r.paid)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700, color: r.balance === null ? C.muted : r.balance > 0 ? C.red : C.green }}>
                  {r.balance === null ? "—" : kes(r.balance)}
                </td>
                <td style={{ ...td, textAlign: "right", fontWeight: 700, color: r.days_late > 0 ? C.red : C.faint }}>{r.days_late > 0 ? r.days_late : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ── Operational reports: order + its items ───────────────────────────────────
export function OperationalOrders({ rows, itemsByOrder, sort, onSort, emptyMessage }) {
  if (rows.length === 0) return <Panel><Empty message={emptyMessage} /></Panel>;
  return (
    <Panel>
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead>
            <tr style={headRow}>
              <SortTh field="client" sort={sort} onSort={onSort}>Client</SortTh>
              <SortTh field="order_num" sort={sort} onSort={onSort}>Order</SortTh>
              <SortTh field="due_date" sort={sort} onSort={onSort}>Due</SortTh>
              <SortTh field="status" sort={sort} onSort={onSort}>Status</SortTh>
              <th style={th}>Category</th><th style={th}>Description</th>
              <th style={{ ...th, textAlign: "center" }}>Qty</th><th style={th}>Size</th><th style={th}>Finish</th><th style={th}>Wood</th><th style={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const items = itemsByOrder[r.id] || [];
              const late = r.delivery_days_late;
              const lead = (
                <>
                  <td style={{ ...td, fontWeight: 700 }} rowSpan={Math.max(items.length, 1)}>{r.client}</td>
                  <td style={{ ...td, fontFamily: C.mono, fontSize: 12 }} rowSpan={Math.max(items.length, 1)}>{r.order_num}</td>
                  <td style={td} rowSpan={Math.max(items.length, 1)}>
                    {day(r.due_date)}
                    {late > 0 && <div style={{ fontSize: 10, fontWeight: 700, color: C.red }}>{late} day{late === 1 ? "" : "s"} late</div>}
                  </td>
                  <td style={td} rowSpan={Math.max(items.length, 1)}><StatusPill status={r.status} /></td>
                </>
              );
              if (items.length === 0) {
                return (
                  <tr key={r.id} style={{ borderBottom: `2px solid ${C.line}` }}>
                    {lead}<td style={td}>—</td><td style={td}>{r.items_text || "—"}</td>
                    <td style={{ ...td, textAlign: "center" }}>—</td><td style={td}>—</td><td style={td}>—</td><td style={td}>—</td><td style={td}>{r.notes || ""}</td>
                  </tr>
                );
              }
              return items.map((it, idx) => (
                <tr key={`${r.id}-${it.id}`} style={{ borderBottom: idx === items.length - 1 ? `2px solid ${C.line}` : `1px solid ${C.line}` }}>
                  {idx === 0 && lead}
                  <td style={td}>{it.category || "—"}</td>
                  <td style={td}>{it.description || "—"}</td>
                  <td style={{ ...td, textAlign: "center", fontWeight: 600, fontFamily: C.mono }}>{it.quantity || 1}</td>
                  <td style={td}>{it.size || "—"}</td>
                  <td style={{ ...td, fontSize: 11 }}>{[it.finish_type, it.finish_color].filter(Boolean).join(" / ") || "—"}</td>
                  <td style={td}>{it.wood_type || "—"}</td>
                  <td style={{ ...td, fontSize: 11, color: C.muted }}>{it.notes || ""}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ── Supplier reports ─────────────────────────────────────────────────────────
export function SupplierTable({ rows, sort, onSort, emptyMessage }) {
  if (rows.length === 0) return <Panel><Empty message={emptyMessage} /></Panel>;
  return (
    <Panel>
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead>
            <tr style={headRow}>
              <SortTh field="supplier_name" sort={sort} onSort={onSort}>Supplier</SortTh>
              <SortTh field="purchase_date" sort={sort} onSort={onSort}>Date</SortTh>
              <th style={th}>Items bought</th>
              <SortTh field="total_amount" sort={sort} onSort={onSort} right>Total</SortTh>
              <SortTh field="amount_paid" sort={sort} onSort={onSort} right>Paid</SortTh>
              <SortTh field="balance" sort={sort} onSort={onSort} right>Balance</SortTh>
              <SortTh field="payment_status" sort={sort} onSort={onSort}>Status</SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.id} style={{ borderBottom: `1px solid ${C.line}`, background: i % 2 ? C.bg : C.card }}>
                <td style={{ ...td, fontWeight: 700 }}>{p.supplier_name}</td>
                <td style={td}>{day(p.purchase_date)}</td>
                <td style={{ ...td, fontSize: 12, color: C.muted }}>{p.items_bought || "—"}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: C.mono }}>{kes(p.total_amount)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: C.mono, color: C.green }}>{kes(p.amount_paid)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: C.mono, fontWeight: 700, color: p.balance > 0 ? C.red : C.green }}>{kes(p.balance)}</td>
                <td style={td}><Badge color={p.payment_status === "Paid" ? "green" : p.payment_status === "Part Paid" ? "amber" : "red"}>{p.payment_status}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ── Mobile cards (one per order / purchase) ──────────────────────────────────
export function OrderCards({ rows, financial, unitsById, paymentDue }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map(r => (
        <div key={r.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radius, padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{r.client}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{r.order_num}{r.invoice_number ? ` · ${r.invoice_number}` : ""}</div>
            </div>
            <StatusPill status={r.status} />
          </div>
          {financial ? (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
              <Num label="Invoiced" value={r.billable === null ? "n/a" : kes(r.billable)} />
              <Num label="Paid" value={kes(r.paid)} color={C.green} center />
              <Num label="Balance" value={r.balance === null ? "—" : kes(r.balance)} color={r.balance > 0 ? C.red : C.green} right />
            </div>
          ) : (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}`, fontSize: 12, color: C.muted }}>
              Due {day(r.due_date)} · {unitsById[r.id] || 1} unit{(unitsById[r.id] || 1) === 1 ? "" : "s"}
              {r.delivery_days_late > 0 && <span style={{ color: C.red, fontWeight: 700 }}> · {r.delivery_days_late}d late</span>}
            </div>
          )}
          {financial && (paymentDue ? r.payment_due_date : r.days_late > 0) && (
            <div style={{ marginTop: 8, fontSize: 11, color: r.days_late > 0 ? C.red : C.muted, fontWeight: r.days_late > 0 ? 700 : 400 }}>
              {paymentDue ? `Payment due ${day(r.payment_due_date)}` : ""}{r.days_late > 0 ? `${paymentDue ? " · " : ""}${r.days_late} days overdue` : ""}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Num({ label, value, color, center, right }) {
  return (
    <div style={{ textAlign: right ? "right" : center ? "center" : "left" }}>
      <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: C.mono }}>{value}</div>
    </div>
  );
}
