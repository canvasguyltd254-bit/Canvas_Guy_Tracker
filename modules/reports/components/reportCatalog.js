// The report catalogue: groups, labels and which reports need a date range or
// finance-level access. Pure data, no React.

export const FINANCE_ROLES = ["admin", "head_of_sales"];

export const REPORTS = {
  overdue:              { label: "Overdue",            kind: "orders",   range: false, hint: "Not delivered and past the delivery due date" },
  "due-week":           { label: "Due orders",         kind: "orders",   range: true,  rangeOn: "delivery due date", hint: "Not delivered, delivery due in the period" },
  production:           { label: "In production",      kind: "orders",   range: false, hint: "Orders currently in production" },
  ready:                { label: "Ready for delivery", kind: "orders",   range: false, hint: "Finished and waiting to be delivered" },
  workload:             { label: "Workload",           kind: "orders",   range: false, hint: "Everything between material check and ready" },
  receivables:          { label: "Receivables",        kind: "orders",   range: false, financial: true, hint: "Invoiced orders with money still owed" },
  collections:          { label: "Collections due",    kind: "orders",   range: true,  rangeOn: "payment due date", financial: true, hint: "Money owed whose payment falls due in the period" },
  "payments-received":  { label: "Payments received",  kind: "payments", range: true,  finance: true, hint: "What customers paid between two dates" },
  "sales-week":         { label: "Sales by period",    kind: "orders",   range: true,  rangeOn: "order date", financial: true, hint: "Invoiced orders created in the period" },
  completed:            { label: "Completed",          kind: "orders",   range: true,  rangeOn: "order date", financial: true, hint: "Delivered or closed orders created in the period" },
  "product-cash":       { label: "Cash by product",    kind: "productCash", range: true, finance: true, hint: "What each item category has brought in, with invoiced, outstanding and est. margin" },
  "order-pnl":          { label: "Order P&L",          kind: "pnl",      range: true,  finance: true, hint: "Profit per order, ex-VAT, with labour and expenses" },
  "supplier-payables":  { label: "Supplier payables",  kind: "supplier", range: false, hint: "Unpaid and part-paid supplier purchases" },
  "supplier-purchases": { label: "Supplier purchases", kind: "supplier", range: true,  rangeOn: "purchase date", hint: "Supplier purchases in the period" },
};

export const GROUPS = [
  { id: "operations", label: "Operations",    reports: ["overdue", "due-week", "production", "ready", "workload"] },
  { id: "money-in",   label: "Money in",      reports: ["receivables", "collections", "payments-received"] },
  { id: "sales",      label: "Sales & profit", reports: ["sales-week", "completed", "product-cash", "order-pnl"] },
  { id: "suppliers",  label: "Suppliers",     reports: ["supplier-payables", "supplier-purchases"] },
];

export const canSee = (id, role) => !REPORTS[id]?.finance || FINANCE_ROLES.includes(role);

export function visibleGroups(role) {
  return GROUPS
    .map(g => ({ ...g, reports: g.reports.filter(id => canSee(id, role)) }))
    .filter(g => g.reports.length > 0);
}

export function groupOf(id) {
  return GROUPS.find(g => g.reports.includes(id))?.id || GROUPS[0].id;
}

/** A usable report id for this role (falls back to production). */
export function resolveReport(id, role) {
  return REPORTS[id] && canSee(id, role) ? id : "production";
}
