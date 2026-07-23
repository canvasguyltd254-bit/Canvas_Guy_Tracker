"use client";
/**
 * modules/accounting/components/AccountingReview.js
 *
 * GL health screen for admin + production_manager.
 *
 * Three tabs:
 *   1. Unposted — records with journal_entry_id IS NULL, grouped by type
 *   2. Errors   — accounting_posting_errors where resolved = false
 *   3. Reversals — journal_entries with source_type = 'reversal'
 *
 * Each unposted row and each posting error row has a Retry button that
 * calls POST /api/accounting/review/retry, then refreshes the relevant section.
 */

import { useState, useEffect, useCallback } from "react";

// ─── helpers ────────────────────────────────────────────────────────────────

const fmt = (n) =>
  n == null ? "—" : `KSh ${Number(n).toLocaleString("en-KE", { minimumFractionDigits: 0 })}`;

const fmtDate = (d) => {
  if (!d) return "—";
  const [y, m, day] = String(d).split("T")[0].split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${day} ${months[parseInt(m) - 1]} ${y}`;
};

// ─── palette ────────────────────────────────────────────────────────────────

const BRAND   = "#E8512A";
const DARK    = "#1a1a1a";
const SURFACE = "#ffffff";
const BG      = "#f7f7f5";
const BORDER  = "#e5e5e5";
const MUTED   = "#666";
const TEXT    = "#111";

// ─── sub-components ─────────────────────────────────────────────────────────

function KpiCard({ label, value, color, onClick, active }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, minWidth: 120, padding: "16px", borderRadius: 8,
        background: active ? DARK : SURFACE,
        color: active ? "#fff" : TEXT,
        border: active ? `2px solid ${DARK}` : `2px solid ${BORDER}`,
        cursor: "pointer", textAlign: "left", transition: "all 0.15s",
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 800, color: active ? "#fff" : color }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: active ? "#ccc" : MUTED, marginTop: 4 }}>{label}</div>
    </button>
  );
}

function SectionLabel({ children, count }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      fontWeight: 700, fontSize: 14, color: DARK,
      padding: "12px 0 8px",
      borderBottom: `2px solid ${BORDER}`, marginBottom: 12,
    }}>
      {children}
      {count != null && (
        <span style={{
          background: count > 0 ? BRAND : "#ddd",
          color: count > 0 ? "#fff" : "#888",
          fontSize: 11, fontWeight: 700, borderRadius: 20,
          padding: "1px 8px",
        }}>{count}</span>
      )}
    </div>
  );
}

function EmptyState({ label }) {
  return (
    <div style={{
      padding: "28px 0", textAlign: "center", color: MUTED, fontSize: 13,
    }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5"
           style={{ display: "block", margin: "0 auto 8px" }}>
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      {label}
    </div>
  );
}

function RetryButton({ onClick, loading, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      style={{
        padding: "4px 12px", borderRadius: 5, fontSize: 12, fontWeight: 600,
        background: loading ? "#ddd" : BRAND,
        color: loading ? MUTED : "#fff",
        border: "none", cursor: loading || disabled ? "default" : "pointer",
        whiteSpace: "nowrap", flexShrink: 0,
      }}
    >
      {loading ? "Posting…" : "Retry"}
    </button>
  );
}

function InlineError({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      marginTop: 4, fontSize: 11, color: "#c62828",
      background: "#fff5f5", border: "1px solid #ffcdd2",
      borderRadius: 4, padding: "3px 8px",
    }}>
      {msg}
    </div>
  );
}

// ─── Unposted tables ─────────────────────────────────────────────────────────

// Generic table for manual payments, chatpesa allocations, and supplier OBs.
// Supplier purchases use PurchasesTable below (handles the "Assign Category" flow).
function UnpostedTable({ rows, columns, sourceType, onRetried }) {
  const [retrying, setRetrying] = useState({});
  const [errors, setErrors]     = useState({});

  const handleRetry = async (id) => {
    setRetrying(r => ({ ...r, [id]: true }));
    setErrors(e => ({ ...e, [id]: null }));
    try {
      const res = await fetch("/api/accounting/review/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_type: sourceType, source_id: id }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        onRetried(id);
      } else {
        setErrors(e => ({ ...e, [id]: json.error || "Posting failed" }));
      }
    } catch {
      setErrors(e => ({ ...e, [id]: "Network error" }));
    } finally {
      setRetrying(r => ({ ...r, [id]: false }));
    }
  };

  if (!rows.length) return <EmptyState label="All caught up — nothing unposted" />;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} style={{
                textAlign: "left", padding: "6px 10px", fontSize: 11,
                fontWeight: 700, color: MUTED, background: BG,
                borderBottom: `1px solid ${BORDER}`,
                whiteSpace: "nowrap",
              }}>{c.label}</th>
            ))}
            <th style={{ width: 90, background: BG, borderBottom: `1px solid ${BORDER}` }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}
              style={{ borderBottom: `1px solid ${BORDER}` }}
            >
              {columns.map(c => (
                <td key={c.key} style={{
                  padding: "8px 10px", verticalAlign: "top",
                  color: c.muted ? MUTED : TEXT,
                  whiteSpace: c.noWrap ? "nowrap" : "normal",
                  maxWidth: c.maxWidth || undefined,
                }}>
                  {c.render ? c.render(row[c.key], row) : (row[c.key] ?? "—")}
                </td>
              ))}
              <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                <RetryButton
                  onClick={() => handleRetry(row.id)}
                  loading={retrying[row.id]}
                />
                <InlineError msg={errors[row.id]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Purchases table (with inline category assignment) ───────────────────────

/**
 * Supplier purchases need special handling: rows with no accounting_category_id
 * cannot be posted.  This component shows a category picker inline and a combined
 * "Assign & Post" button that sends accounting_category_id to the retry API.
 * Rows that already have a category get the standard Retry button.
 */
function PurchasesTable({ rows, categories, onRetried }) {
  const [retrying,     setRetrying]     = useState({});
  const [errors,       setErrors]       = useState({});
  const [selectedCat,  setSelectedCat]  = useState({});  // rowId → category uuid

  const handleRetry = async (id, catId) => {
    setRetrying(r => ({ ...r, [id]: true }));
    setErrors(e => ({ ...e, [id]: null }));
    try {
      const body = { source_type: "supplier_purchase", source_id: id };
      if (catId) body.accounting_category_id = catId;
      const res  = await fetch("/api/accounting/review/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        onRetried(id);
      } else {
        setErrors(e => ({ ...e, [id]: json.error || "Posting failed" }));
      }
    } catch {
      setErrors(e => ({ ...e, [id]: "Network error" }));
    } finally {
      setRetrying(r => ({ ...r, [id]: false }));
    }
  };

  const purchaseCategories = (categories || []).filter(c => c.for_purchases);

  if (!rows.length) return <EmptyState label="All caught up — nothing unposted" />;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {[
              { label: "Date" }, { label: "Supplier" }, { label: "Items" },
              { label: "Category" }, { label: "Amount" },
            ].map(h => (
              <th key={h.label} style={{
                textAlign: "left", padding: "6px 10px", fontSize: 11,
                fontWeight: 700, color: MUTED, background: BG,
                borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap",
              }}>{h.label}</th>
            ))}
            <th style={{ width: 140, background: BG, borderBottom: `1px solid ${BORDER}` }} />
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const hasCategory = !!row.category_name;
            const catId = selectedCat[row.id] || "";
            return (
              <tr key={row.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                <td style={{ padding: "8px 10px", whiteSpace: "nowrap", color: MUTED }}>{fmtDate(row.date)}</td>
                <td style={{ padding: "8px 10px" }}>{row.supplier_name || "—"}</td>
                <td style={{ padding: "8px 10px", maxWidth: 280 }}>{row.description || "—"}</td>

                {/* Category column: plain text if set, inline picker if missing */}
                <td style={{ padding: "8px 10px", minWidth: 180 }}>
                  {hasCategory ? (
                    <span style={{ color: MUTED }}>{row.category_name}</span>
                  ) : (
                    <select
                      value={catId}
                      onChange={e => setSelectedCat(s => ({ ...s, [row.id]: e.target.value }))}
                      style={{
                        fontSize: 12, padding: "3px 6px", borderRadius: 4,
                        border: `1px solid ${catId ? BORDER : "#c62828"}`,
                        background: "#fff", maxWidth: 200, width: "100%",
                        color: catId ? TEXT : "#c62828",
                      }}
                    >
                      <option value="">— assign category —</option>
                      {purchaseCategories.map(c => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  )}
                </td>

                <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{fmt(row.amount)}</td>

                {/* Action column */}
                <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                  {hasCategory ? (
                    <>
                      <RetryButton
                        onClick={() => handleRetry(row.id, null)}
                        loading={retrying[row.id]}
                      />
                      <InlineError msg={errors[row.id]} />
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => catId && handleRetry(row.id, catId)}
                        disabled={retrying[row.id] || !catId}
                        style={{
                          padding: "4px 12px", borderRadius: 5, fontSize: 12, fontWeight: 600,
                          background: (retrying[row.id] || !catId) ? "#ddd" : BRAND,
                          color: (retrying[row.id] || !catId) ? MUTED : "#fff",
                          border: "none",
                          cursor: (retrying[row.id] || !catId) ? "default" : "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {retrying[row.id] ? "Posting…" : "Assign & Post"}
                      </button>
                      <InlineError msg={errors[row.id]} />
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tab: Unposted ───────────────────────────────────────────────────────────

function UnpostedTab({ data, categories, onRetried }) {
  const { supplier_purchases, manual_payments, chatpesa_allocations, supplier_opening_balances } = data;

  const paymentCols = [
    { key: "date",           label: "Date",      noWrap: true, render: fmtDate },
    { key: "supplier_name",  label: "Supplier" },
    { key: "payment_method", label: "Method",    muted: true },
    { key: "reference",      label: "Ref",       muted: true },
    { key: "amount",         label: "Amount",    noWrap: true, render: fmt },
  ];

  const chatpesaCols = [
    { key: "date",          label: "Date",     noWrap: true, render: fmtDate },
    { key: "type",          label: "Type",     render: v => ({
        supplier_purchase: "Supplier purchase",
        opening_balance:   "Opening balance",
        petty_cash:        "Petty cash",
      }[v] || v) },
    { key: "supplier_name", label: "Supplier", muted: true, render: v => v || "—" },
    { key: "petty_label",   label: "Category", muted: true, render: v => v || "—" },
    { key: "amount",        label: "Amount",   noWrap: true, render: fmt },
  ];

  const obCols = [
    { key: "date",         label: "OB Date",  noWrap: true, render: fmtDate },
    { key: "supplier_name", label: "Supplier" },
    { key: "amount",       label: "Balance",  noWrap: true, render: fmt },
  ];

  const total =
    supplier_purchases.length +
    manual_payments.length +
    chatpesa_allocations.length +
    supplier_opening_balances.length;

  if (total === 0) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="1.5"
             style={{ display: "block", margin: "0 auto 16px" }}>
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <div style={{ fontWeight: 700, fontSize: 16, color: DARK }}>All transactions are posted</div>
        <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>No unposted records found.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <section>
        <SectionLabel count={supplier_purchases.length}>Supplier Purchases</SectionLabel>
        <PurchasesTable
          rows={supplier_purchases}
          categories={categories}
          onRetried={(id) => onRetried("supplier_purchases", id)}
        />
      </section>

      <section>
        <SectionLabel count={manual_payments.length}>Manual Payments</SectionLabel>
        <UnpostedTable
          rows={manual_payments}
          columns={paymentCols}
          sourceType="manual_payment"
          onRetried={(id) => onRetried("manual_payments", id)}
        />
      </section>

      <section>
        <SectionLabel count={chatpesa_allocations.length}>Chatpesa Allocations</SectionLabel>
        <UnpostedTable
          rows={chatpesa_allocations}
          columns={chatpesaCols}
          sourceType="chatpesa_allocation"
          onRetried={(id) => onRetried("chatpesa_allocations", id)}
        />
      </section>

      <section>
        <SectionLabel count={supplier_opening_balances.length}>Supplier Opening Balances</SectionLabel>
        <UnpostedTable
          rows={supplier_opening_balances}
          columns={obCols}
          sourceType="supplier_opening_balance"
          onRetried={(id) => onRetried("supplier_opening_balances", id)}
        />
      </section>
    </div>
  );
}

// ─── Tab: Errors ─────────────────────────────────────────────────────────────

function ErrorsTab({ errors, onRetried }) {
  const [retrying, setRetrying] = useState({});
  const [retryErrors, setRetryErrors] = useState({});
  const [resolved, setResolved] = useState({});

  const handleRetry = async (err) => {
    if (!err.source_type || !err.source_id) return;
    setRetrying(r => ({ ...r, [err.id]: true }));
    setRetryErrors(e => ({ ...e, [err.id]: null }));
    try {
      const res = await fetch("/api/accounting/review/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_type: err.source_type, source_id: err.source_id }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setResolved(r => ({ ...r, [err.id]: true }));
        onRetried && onRetried();
      } else {
        setRetryErrors(e => ({ ...e, [err.id]: json.error || "Posting failed" }));
      }
    } catch {
      setRetryErrors(e => ({ ...e, [err.id]: "Network error" }));
    } finally {
      setRetrying(r => ({ ...r, [err.id]: false }));
    }
  };

  const visible = errors.filter(e => !resolved[e.id]);

  if (!visible.length) return <EmptyState label="No unresolved posting errors" />;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
            {["When", "Source type", "Source ID", "Error"].map(h => (
              <th key={h} style={{
                textAlign: "left", padding: "6px 10px", fontSize: 11,
                fontWeight: 700, color: MUTED, background: BG,
                borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap",
              }}>{h}</th>
            ))}
            <th style={{ width: 90, background: BG, borderBottom: `1px solid ${BORDER}` }} />
          </tr>
        </thead>
        <tbody>
          {visible.map(e => (
            <tr key={e.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
              <td style={{ padding: "8px 10px", whiteSpace: "nowrap", color: MUTED }}>{fmtDate(e.attempted_at)}</td>
              <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{e.source_type || "—"}</td>
              <td style={{ padding: "8px 10px", fontFamily: "monospace", fontSize: 11, color: MUTED, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                {e.source_id || "—"}
              </td>
              <td style={{ padding: "8px 10px", color: "#c62828", maxWidth: 320 }}>{e.error_message}</td>
              <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                {e.source_type && e.source_id ? (
                  <>
                    <RetryButton
                      onClick={() => handleRetry(e)}
                      loading={retrying[e.id]}
                    />
                    <InlineError msg={retryErrors[e.id]} />
                  </>
                ) : (
                  <span style={{ fontSize: 11, color: MUTED }}>No source</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tab: Reversals ──────────────────────────────────────────────────────────

function ReversalsTab({ reversals }) {
  if (!reversals.length) return <EmptyState label="No reversals recorded" />;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
            {["Reversed on", "Entry date", "Description", "Reversed entry ID"].map(h => (
              <th key={h} style={{
                textAlign: "left", padding: "6px 10px", fontSize: 11,
                fontWeight: 700, color: MUTED, background: BG,
                borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap",
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reversals.map(r => (
            <tr key={r.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
              <td style={{ padding: "8px 10px", whiteSpace: "nowrap", color: MUTED }}>{fmtDate(r.posted_at)}</td>
              <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{fmtDate(r.entry_date)}</td>
              <td style={{ padding: "8px 10px", maxWidth: 340 }}>{r.description}</td>
              <td style={{
                padding: "8px 10px", fontFamily: "monospace", fontSize: 11,
                color: MUTED, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {r.source_id}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Root component ──────────────────────────────────────────────────────────

export default function AccountingReview() {
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [data, setData]           = useState(null);
  const [categories, setCategories] = useState([]);
  const [activeTab, setActiveTab] = useState("unposted");

  // Load accounting categories once — used by PurchasesTable for inline assignment
  useEffect(() => {
    fetch("/api/accounting-categories")
      .then(r => r.json())
      .then(j => { if (j.success) setCategories(j.data || []); })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/accounting/review");
      const json = await res.json();
      if (!res.ok) { setError(json.error || "Failed to load"); return; }
      setData(json.data);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Remove a row from unposted in-place so retry success is reflected without a full reload
  const handleUnpostedRetried = (section, id) => {
    setData(prev => ({
      ...prev,
      unposted: {
        ...prev.unposted,
        [section]: prev.unposted[section].filter(r => r.id !== id),
      },
      summary: {
        ...prev.summary,
        unposted_count: prev.summary.unposted_count - 1,
      },
    }));
  };

  const summary = data?.summary || { unposted_count: 0, error_count: 0, reversal_count: 0 };

  const tabs = [
    { id: "unposted",   label: "Unposted",  count: summary.unposted_count,  alertColor: summary.unposted_count > 0 ? BRAND : "#4caf50" },
    { id: "errors",     label: "Errors",    count: summary.error_count,     alertColor: summary.error_count > 0 ? "#c62828" : "#4caf50" },
    { id: "reversals",  label: "Reversals", count: summary.reversal_count,  alertColor: "#1565c0" },
  ];

  return (
    <div style={{ padding: "24px 20px", maxWidth: 1100, margin: "0 auto" }}>

      {/* Page header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: DARK }}>GL Review</h1>
          <p style={{ margin: "4px 0 0", color: MUTED, fontSize: 13 }}>
            Unposted transactions, posting errors, and reversal history
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 600,
            background: DARK, color: "#fff", border: "none",
            cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          background: "#fff5f5", border: "1px solid #ffcdd2", color: "#c62828",
          borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* KPI strip — doubles as tab selector */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        {tabs.map(t => (
          <KpiCard
            key={t.id}
            label={t.label}
            value={loading ? "…" : t.count}
            color={t.alertColor}
            onClick={() => setActiveTab(t.id)}
            active={activeTab === t.id}
          />
        ))}
      </div>

      {/* Content card */}
      {loading ? (
        <div style={{ padding: 48, textAlign: "center", color: MUTED, fontSize: 13 }}>
          Loading GL data…
        </div>
      ) : data ? (
        <div style={{
          background: SURFACE, borderRadius: 10, border: `1px solid ${BORDER}`,
          padding: "20px 24px",
        }}>
          {activeTab === "unposted" && (
            <UnpostedTab
              data={data.unposted}
              categories={categories}
              onRetried={handleUnpostedRetried}
            />
          )}
          {activeTab === "errors" && (
            <ErrorsTab
              errors={data.posting_errors}
              onRetried={load}
            />
          )}
          {activeTab === "reversals" && (
            <ReversalsTab reversals={data.reversal_history} />
          )}
        </div>
      ) : null}
    </div>
  );
}
