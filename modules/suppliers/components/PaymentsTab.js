"use client";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAYMENT_METHODS = ["Cash","M-Pesa","Bank Transfer","Cheque","Other"];

const STATUS_META = {
  unmatched: { label: "Unmatched", bg: "#FEF3C7", text: "#92400E", border: "#FCD34D" },
  partial:   { label: "Partial",   bg: "#DBEAFE", text: "#1E40AF", border: "#93C5FD" },
  matched:   { label: "Matched",   bg: "#D1FAE5", text: "#065F46", border: "#6EE7B7" },
  ignored:   { label: "Ignored",   bg: "#F3F4F6", text: "#6B7280", border: "#D1D5DB" },
  credit:    { label: "Credit",    bg: "#F3F4F6", text: "#9CA3AF", border: "#E5E7EB" },
  refund:    { label: "Refund",    bg: "#FEE2E2", text: "#991B1B", border: "#FCA5A5" },
};

const ALLOC_TYPES = [
  { value: "supplier_purchase", label: "Supplier purchase" },
  { value: "opening_balance",   label: "Supplier opening balance" },
  { value: "petty_cash",        label: "Petty cash / expense" },
];

const fmt = (n) => "KSh " + Number(n||0).toLocaleString("en-KE",{minimumFractionDigits:0,maximumFractionDigits:0});

const ss = {
  label:    { display:"block", fontSize:"11px", fontWeight:600, color:"#888", marginBottom:"5px", textTransform:"uppercase", letterSpacing:"0.5px" },
  input:    { width:"100%", padding:"8px 10px", border:"1.5px solid #e0e0e0", borderRadius:"6px", fontSize:"13px", background:"#fafafa", boxSizing:"border-box", fontFamily:"inherit" },
  textarea: { width:"100%", padding:"8px 10px", border:"1.5px solid #e0e0e0", borderRadius:"6px", fontSize:"13px", background:"#fafafa", resize:"vertical", minHeight:"60px", fontFamily:"inherit", boxSizing:"border-box" },
};

// ── CSV PARSER ────────────────────────────────────────────────────────────────

function parseChatpesaCSV(text) {
  // Normalise line endings
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  // Find the header line (starts with "ID,")
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/^"|"$/g,"").trim();
    if (clean.startsWith("ID,") || clean === "ID") { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error("Cannot find CSV header row — expected a line starting with 'ID,'");

  // Extract metadata from preamble
  const meta = {};
  for (let i = 0; i < headerIdx; i++) {
    const line = lines[i].replace(/"/g,"").trim();
    const fromTo = line.match(/Statement from (.+?) to (.+)/);
    if (fromTo) { meta.statementFrom = fromTo[1].trim(); meta.statementTo = fromTo[2].trim(); }
    const acct = line.match(/Account (CP\d+)\s*-\s*(.+)/);
    if (acct) { meta.accountRef = acct[1]; meta.accountName = acct[2].trim(); }
  }

  // Determine reconciliation week (Monday of statement_from week)
  if (meta.statementFrom) {
    const d = new Date(meta.statementFrom);
    if (!isNaN(d)) {
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);
      meta.reconciliationWeek = d.toISOString().split("T")[0];
    }
  }

  // Simple CSV row parser (handles quoted fields with commas/newlines)
  function parseRow(line) {
    const fields = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === "," && !inQ) {
        fields.push(cur); cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields;
  }

  const headers = parseRow(lines[headerIdx]);

  const rows = [];
  let i = headerIdx + 1;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    // Accumulate multi-line quoted cells
    let rowText = lines[i];
    while ((rowText.split('"').length - 1) % 2 !== 0 && i + 1 < lines.length) {
      i++;
      rowText += "\n" + lines[i];
    }
    const vals = parseRow(rowText);
    if (vals.length >= headers.length - 2) { // allow a couple missing trailing fields
      const obj = {};
      headers.forEach((h, idx) => { obj[h.trim()] = (vals[idx] || "").trim(); });
      rows.push(obj);
    }
    i++;
  }

  // Map to our field names
  const mapped = rows.map(r => ({
    chatpesaId:    r["ID"],
    txType:        (r["Type"] || "").toLowerCase(),
    source:        r["Source"],
    sourceId:      r["Source ID"],
    accountName:   r["Account Name"],
    accountNumber: r["Account Number"],
    description:   r["Description"],
    confirmCode:   r["Confirm Code"],
    amount:        parseFloat(r["Amount"]) || 0,
    balanceAfter:  parseFloat(r["Balance"]) || 0,
    transactionDate: parseDate(r["Date"]),
    transactionTime: r["Time"],
  })).filter(r => r.chatpesaId && r.transactionDate);

  return { meta, rows: mapped };
}

function parseDate(str) {
  if (!str) return null;
  // "09 Jul, 2026" → "2026-07-09"
  const m = str.match(/(\d{1,2})\s+(\w+),?\s+(\d{4})/);
  if (!m) return null;
  const months = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
  const mon = months[m[2].substring(0,3)];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
}

// ── SUB-COMPONENTS ────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.ignored;
  return (
    <span style={{ fontSize:"11px", fontWeight:700, color:m.text, background:m.bg, border:`1px solid ${m.border}`, padding:"2px 8px", borderRadius:"4px", whiteSpace:"nowrap" }}>
      {m.label}
    </span>
  );
}

function SuggestionChip({ supplier, confidence, onAccept }) {
  if (!supplier) return null;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:"8px", padding:"8px 12px", background:"#FFF8F0", border:"1px solid #FCD34D", borderRadius:"7px", marginBottom:"12px" }}>
      <span style={{ fontSize:"12px" }}>💡</span>
      <div style={{ flex:1, fontSize:"12px", color:"#92400E" }}>
        <strong>Suggested:</strong> {supplier.name}
        <span style={{ color:"#B45309", marginLeft:"6px" }}>({confidence}% match)</span>
      </div>
      <button onClick={onAccept} style={{ padding:"4px 12px", borderRadius:"5px", border:"none", background:"#F59E0B", color:"#fff", fontSize:"11px", fontWeight:700, cursor:"pointer" }}>
        Use this
      </button>
    </div>
  );
}

// ── MATCH MODAL ───────────────────────────────────────────────────────────────

function MatchModal({ tx, suppliers, onClose, onSaved }) {
  // Compute remaining unallocated amount (for smart default)
  const alreadyAllocated = useMemo(() =>
    (tx.chatpesa_payment_allocations || []).reduce((s, a) => s + parseFloat(a.amount || 0), 0),
    [tx]
  );
  const defaultAmount = String(Math.max(0, parseFloat(tx.amount || 0) - alreadyAllocated));

  const [allocations, setAllocations] = useState([
    { _key: 1, type: "supplier_purchase", supplier_id: tx.suggested_supplier_id || "", purchase_id: "", petty_cash_category: "", accounting_category_id: "", amount: defaultAmount, note: "" }
  ]);
  const [purchaseCache, setPurchaseCache]   = useState({});  // { supplierId: purchases[] }
  const [pettyCashCategories, setPettyCashCategories] = useState([]);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState("");
  const nextKey = useRef(2);

  // Load petty cash accounting categories from the API
  useEffect(() => {
    fetch("/api/accounting-categories?for_petty_cash=true")
      .then(r => r.json())
      .then(j => setPettyCashCategories(j.data || []))
      .catch(() => {});
  }, []);

  const totalAllocated  = allocations.reduce((s,a) => s + (parseFloat(a.amount)||0), 0);
  const remaining       = parseFloat(tx.amount||0) - alreadyAllocated - totalAllocated;
  const canSave         = allocations.every(a => {
    if ((parseFloat(a.amount)||0) <= 0) return false;
    if (a.type === "supplier_purchase") return !!a.purchase_id;
    if (a.type === "opening_balance")   return !!a.supplier_id;
    if (a.type === "petty_cash")        return !!a.petty_cash_category && !!a.accounting_category_id;
    return false;
  });

  const loadPurchases = useCallback(async (supplierId) => {
    if (!supplierId || purchaseCache[supplierId]) return;
    const res  = await fetch(`/api/purchases?supplier_id=${supplierId}`);
    const json = await res.json();
    setPurchaseCache(c => ({ ...c, [supplierId]: json.data || [] }));
  }, [purchaseCache]);

  const updateAlloc = (key, field, val) => {
    setAllocations(prev => prev.map(a => {
      if (a._key !== key) return a;
      const updated = { ...a, [field]: val };
      // Reset purchase when supplier changes
      if (field === "supplier_id") { updated.purchase_id = ""; loadPurchases(val); }
      // Auto-fill amount if only one alloc and field is type
      return updated;
    }));
  };

  const addAlloc = () => {
    setAllocations(prev => [...prev, { _key: nextKey.current++, type:"supplier_purchase", supplier_id:"", purchase_id:"", petty_cash_category:"", accounting_category_id:"", amount:"", note:"" }]);
  };

  const removeAlloc = (key) => {
    setAllocations(prev => prev.filter(a => a._key !== key));
  };

  const handleSave = async () => {
    setError("");

    // Validate all allocations before submitting any (prevents partial-save on split)
    for (const alloc of allocations) {
      if ((parseFloat(alloc.amount) || 0) <= 0) { setError("All allocations must have a positive amount."); return; }
      if (alloc.type === "supplier_purchase" && !alloc.purchase_id)   { setError("Select a purchase for every supplier_purchase allocation."); return; }
      if (alloc.type === "opening_balance"   && !alloc.supplier_id)   { setError("Select a supplier for every opening_balance allocation."); return; }
      if (alloc.type === "petty_cash" && !alloc.petty_cash_category)  { setError("Select a category for every petty cash allocation."); return; }
      if (alloc.type === "petty_cash" && !alloc.accounting_category_id) { setError("Select an accounting category for every petty cash allocation."); return; }
    }
    if (totalAllocated + alreadyAllocated > parseFloat(tx.amount) + 0.01) { setError("Total allocated exceeds transaction amount."); return; }

    setSaving(true);
    try {
      // Send all allocations in a single atomic request.
      // The split-allocations endpoint inserts all rows together — if the insert
      // fails nothing is saved, so no compensating deletes are ever needed.
      const payload = allocations.map(alloc => ({
        allocation_type:        alloc.type,
        supplier_purchase_id:   alloc.type === "supplier_purchase" ? alloc.purchase_id           : undefined,
        supplier_id:            alloc.type === "opening_balance"   ? alloc.supplier_id            : undefined,
        petty_cash_category:    alloc.type === "petty_cash"        ? alloc.petty_cash_category    : undefined,
        accounting_category_id: alloc.type === "petty_cash"        ? alloc.accounting_category_id : undefined,
        amount:                 parseFloat(alloc.amount),
        note:                   alloc.note || undefined,
      }));

      const res  = await fetch(`/api/chatpesa/transactions/${tx.id}/split-allocations`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ allocations: payload }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Allocation failed");

      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  const handleIgnore = async () => {
    setSaving(true);
    try {
      const res  = await fetch(`/api/chatpesa/transactions/${tx.id}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ action:"ignore" }) });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to ignore");
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  // Pre-load purchases for the default suggested supplier
  useEffect(() => {
    if (tx.suggested_supplier_id) loadPurchases(tx.suggested_supplier_id);
  }, []);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:400, display:"flex", alignItems:"center", justifyContent:"center", padding:"16px" }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:"12px", width:"100%", maxWidth:"580px", maxHeight:"90vh", display:"flex", flexDirection:"column", overflow:"hidden" }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding:"18px 20px 14px", borderBottom:"1px solid #f0ede8", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <div style={{ fontSize:"15px", fontWeight:700, marginBottom:"4px" }}>Match transaction</div>
            <div style={{ fontSize:"12px", color:"#888" }}>{tx.transaction_date} · {tx.source}</div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:"#aaa", fontSize:"20px", lineHeight:1 }}>✕</button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY:"auto", flex:1, padding:"16px 20px" }}>

          {/* Transaction card */}
          <div style={{ background:"#f9f9f7", borderRadius:"8px", padding:"12px 14px", marginBottom:"14px", borderLeft:"3px solid #1a1a1a" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:"10px" }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:"14px", fontWeight:700, color:"#1a1a1a" }}>{tx.account_name || "—"}</div>
                {tx.description && <div style={{ fontSize:"12px", color:"#666", marginTop:"3px", whiteSpace:"pre-line" }}>{tx.description}</div>}
                {tx.confirm_code && <div style={{ fontSize:"11px", color:"#aaa", marginTop:"3px", fontFamily:"monospace" }}>{tx.confirm_code}</div>}
              </div>
              <div style={{ fontSize:"18px", fontWeight:800, color:"#1a1a1a", flexShrink:0 }}>{fmt(tx.amount)}</div>
            </div>
          </div>

          {/* Fuzzy suggestion */}
          {tx.suggested_supplier && tx.suggested_confidence >= 0.7 && (
            <SuggestionChip
              supplier={tx.suggested_supplier}
              confidence={Math.round(tx.suggested_confidence * 100)}
              onAccept={() => {
                updateAlloc(allocations[0]._key, "supplier_id", tx.suggested_supplier_id);
                updateAlloc(allocations[0]._key, "type", "supplier_purchase");
              }}
            />
          )}

          {/* Existing allocations (if re-matching) */}
          {tx.chatpesa_payment_allocations?.length > 0 && (
            <div style={{ marginBottom:"12px", padding:"10px 12px", background:"#F0FDF4", borderRadius:"7px", border:"1px solid #6EE7B7" }}>
              <div style={{ fontSize:"11px", fontWeight:700, color:"#065F46", marginBottom:"6px", textTransform:"uppercase", letterSpacing:"0.5px" }}>Already allocated</div>
              {tx.chatpesa_payment_allocations.map(a => (
                <div key={a.id} style={{ fontSize:"12px", color:"#065F46", display:"flex", justifyContent:"space-between" }}>
                  <span>{a.allocation_type === "petty_cash" ? a.petty_cash_category : a.supplier?.name || a.supplier_purchase?.items_bought?.slice(0,40)}</span>
                  <span style={{ fontWeight:700 }}>{fmt(a.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Allocation builder */}
          <div style={{ fontSize:"11px", fontWeight:700, color:"#888", textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:"10px" }}>
            Add allocations
          </div>

          {allocations.map((alloc, idx) => (
            <div key={alloc._key} style={{ background:"#fafafa", border:"1.5px solid #e8e8e5", borderRadius:"8px", padding:"12px", marginBottom:"10px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"10px" }}>
                <span style={{ fontSize:"12px", fontWeight:600, color:"#666" }}>Allocation {idx+1}</span>
                {allocations.length > 1 && (
                  <button onClick={() => removeAlloc(alloc._key)} style={{ background:"none", border:"none", cursor:"pointer", color:"#C62828", fontSize:"14px", fontWeight:700 }}>✕</button>
                )}
              </div>

              {/* Type */}
              <div style={{ marginBottom:"8px" }}>
                <label style={ss.label}>Type</label>
                <select style={ss.input} value={alloc.type} onChange={e => updateAlloc(alloc._key, "type", e.target.value)}>
                  {ALLOC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              {/* Supplier Purchase */}
              {alloc.type === "supplier_purchase" && (
                <>
                  <div style={{ marginBottom:"8px" }}>
                    <label style={ss.label}>Supplier</label>
                    <select style={ss.input} value={alloc.supplier_id} onChange={e => updateAlloc(alloc._key, "supplier_id", e.target.value)}>
                      <option value="">— Select supplier —</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  {alloc.supplier_id && (
                    <div style={{ marginBottom:"8px" }}>
                      <label style={ss.label}>Purchase</label>
                      <select style={ss.input} value={alloc.purchase_id} onChange={e => updateAlloc(alloc._key, "purchase_id", e.target.value)}>
                        <option value="">— Select purchase —</option>
                        {(purchaseCache[alloc.supplier_id] || [])
                          .filter(p => parseFloat(p.total_amount||0) - parseFloat(p.amount_paid||0) > 0.01)
                          .map(p => {
                            const balance = parseFloat(p.total_amount||0) - parseFloat(p.amount_paid||0);
                            return (
                              <option key={p.id} value={p.id}>
                                {p.purchase_date} · {p.items_bought?.slice(0,40) || "No description"} · Bal: KSh {Math.round(balance).toLocaleString()}
                              </option>
                            );
                          })}
                      </select>
                      {alloc.supplier_id && !purchaseCache[alloc.supplier_id] && (
                        <div style={{ fontSize:"11px", color:"#999", marginTop:"4px" }}>Loading purchases…</div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Opening Balance */}
              {alloc.type === "opening_balance" && (
                <div style={{ marginBottom:"8px" }}>
                  <label style={ss.label}>Supplier</label>
                  <select style={ss.input} value={alloc.supplier_id} onChange={e => updateAlloc(alloc._key, "supplier_id", e.target.value)}>
                    <option value="">— Select supplier —</option>
                    {suppliers.map(s => {
                      const ob = parseFloat(s.opening_balance || 0);
                      return (
                        <option key={s.id} value={s.id}>
                          {s.name}{ob > 0 ? ` — OB: KSh ${Math.round(ob).toLocaleString()}` : " — No OB"}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              {/* Petty Cash */}
              {alloc.type === "petty_cash" && (
                <div style={{ marginBottom:"8px" }}>
                  <label style={ss.label}>Accounting category</label>
                  {pettyCashCategories.length > 0 ? (
                    <select style={ss.input} value={alloc.accounting_category_id} onChange={e => {
                      const cat = pettyCashCategories.find(c => c.id === e.target.value);
                      setAllocations(prev => prev.map(a => a._key !== alloc._key ? a : {
                        ...a,
                        accounting_category_id: e.target.value,
                        petty_cash_category:    cat?.label || "",
                      }));
                    }}>
                      <option value="">— Select category —</option>
                      {pettyCashCategories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  ) : (
                    <select style={ss.input} value={alloc.petty_cash_category} onChange={e => updateAlloc(alloc._key, "petty_cash_category", e.target.value)}>
                      <option value="">— Select category —</option>
                      {["Transport","Fuel","Lunch","Airtime","Casual wages","Workshop supplies","Other"].map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                </div>
              )}

              {/* Amount + Note */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
                <div>
                  <label style={ss.label}>Amount (KSh)</label>
                  <input style={ss.input} type="number" min="0" step="1" value={alloc.amount} onChange={e => updateAlloc(alloc._key, "amount", e.target.value)} placeholder="0" />
                </div>
                <div>
                  <label style={ss.label}>Note (optional)</label>
                  <input style={ss.input} value={alloc.note} onChange={e => updateAlloc(alloc._key, "note", e.target.value)} placeholder="e.g. invoice #123" />
                </div>
              </div>
            </div>
          ))}

          <button onClick={addAlloc} style={{ width:"100%", padding:"8px", border:"1.5px dashed #d0d0d0", borderRadius:"7px", background:"#fafafa", color:"#999", fontSize:"13px", cursor:"pointer", marginBottom:"12px", fontFamily:"inherit" }}>
            + Add allocation (split payment)
          </button>

          {/* Running total */}
          <div style={{ padding:"10px 14px", background: remaining < -0.01 ? "#FEE2E2" : remaining <= 0.01 ? "#D1FAE5" : "#FEF3C7", borderRadius:"7px", display:"flex", justifyContent:"space-between", fontSize:"13px" }}>
            <span style={{ color:"#666" }}>Allocated</span>
            <div style={{ textAlign:"right" }}>
              <strong>{fmt(totalAllocated)}</strong>
              <span style={{ color:"#888", marginLeft:"6px" }}>of {fmt(tx.amount)}</span>
              {Math.abs(remaining) > 0.01 && (
                <div style={{ fontSize:"11px", color: remaining < 0 ? "#991B1B" : "#92400E" }}>
                  {remaining < 0 ? `Over by ${fmt(Math.abs(remaining))}` : `${fmt(remaining)} remaining`}
                </div>
              )}
            </div>
          </div>

          {error && <div style={{ marginTop:"10px", padding:"8px 12px", background:"#FEE2E2", color:"#991B1B", borderRadius:"6px", fontSize:"12px" }}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={{ padding:"14px 20px", borderTop:"1px solid #f0ede8", display:"flex", gap:"8px", justifyContent:"space-between" }}>
          <button onClick={handleIgnore} disabled={saving} style={{ padding:"9px 16px", borderRadius:"7px", border:"1.5px solid #e0e0e0", background:"#fff", color:"#666", fontSize:"13px", fontWeight:600, cursor:"pointer" }}>
            Ignore
          </button>
          <div style={{ display:"flex", gap:"8px" }}>
            <button onClick={onClose} style={{ padding:"9px 16px", borderRadius:"7px", border:"1.5px solid #e0e0e0", background:"#fff", color:"#666", fontSize:"13px", fontWeight:600, cursor:"pointer" }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving || !canSave || remaining < -0.01} style={{ padding:"9px 20px", borderRadius:"7px", border:"none", background: canSave && remaining >= -0.01 ? "#1a1a1a" : "#ccc", color:"#fff", fontSize:"13px", fontWeight:600, cursor: canSave && !saving ? "pointer" : "not-allowed" }}>
              {saving ? "Saving…" : "Confirm match"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── UPLOAD MODAL ──────────────────────────────────────────────────────────────

function UploadModal({ onClose, onImported }) {
  const [parsed, setParsed]       = useState(null);
  const [error, setError]         = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult]       = useState(null);
  const fileRef                   = useRef();

  const handleFile = (file) => {
    if (!file) return;
    if (!file.name.endsWith(".csv")) { setError("Please select a .csv file."); return; }
    setError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = parseChatpesaCSV(e.target.result);
        setParsed(data);
      } catch (err) {
        setError(err.message);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!parsed) return;
    setUploading(true);
    setError("");
    try {
      const res  = await fetch("/api/chatpesa", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(parsed) });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Import failed");
      setResult(json);
      onImported();
    } catch (err) {
      setError(err.message);
    }
    setUploading(false);
  };

  const debits  = parsed?.rows.filter(r => r.txType === "debit").length || 0;
  const credits = parsed?.rows.filter(r => r.txType === "credit" && !r.source?.includes("refund")).length || 0;
  const refunds = parsed?.rows.filter(r => r.source?.toLowerCase().includes("refund")).length || 0;
  const totalDebitAmt = parsed?.rows.filter(r => r.txType === "debit").reduce((s,r) => s + r.amount, 0) || 0;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:400, display:"flex", alignItems:"center", justifyContent:"center", padding:"16px" }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:"12px", width:"100%", maxWidth:"480px", padding:"24px" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"20px" }}>
          <h2 style={{ fontSize:"16px", fontWeight:700, margin:0 }}>Upload Chatpesa CSV</h2>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:"#aaa", fontSize:"20px", lineHeight:1 }}>✕</button>
        </div>

        {result ? (
          <div>
            <div style={{ padding:"16px", background:"#D1FAE5", borderRadius:"8px", marginBottom:"16px" }}>
              <div style={{ fontSize:"14px", fontWeight:700, color:"#065F46", marginBottom:"8px" }}>✓ Import complete</div>
              <div style={{ fontSize:"13px", color:"#065F46" }}>{result.message}</div>
              <div style={{ marginTop:"8px", display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px", fontSize:"12px", color:"#065F46" }}>
                <span>Debits imported: <strong>{result.debits}</strong></span>
                <span>Credits: <strong>{result.credits}</strong></span>
                <span>Refunds: <strong>{result.refunds}</strong></span>
                <span>Duplicates skipped: <strong>{result.duplicates}</strong></span>
              </div>
            </div>
            <button onClick={onClose} style={{ width:"100%", padding:"10px", borderRadius:"8px", border:"none", background:"#1a1a1a", color:"#fff", fontSize:"13px", fontWeight:600, cursor:"pointer" }}>Done</button>
          </div>
        ) : (
          <>
            {/* File drop zone */}
            <div
              style={{ border:"2px dashed #e0e0e0", borderRadius:"10px", padding:"32px 20px", textAlign:"center", cursor:"pointer", marginBottom:"16px" }}
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}>
              <div style={{ fontSize:"28px", marginBottom:"8px" }}>📄</div>
              <div style={{ fontSize:"13px", color:"#666" }}>{parsed ? "Change file" : "Click or drag Chatpesa CSV here"}</div>
              <input ref={fileRef} type="file" accept=".csv" style={{ display:"none" }} onChange={e => handleFile(e.target.files[0])} />
            </div>

            {error && <div style={{ padding:"8px 12px", background:"#FEE2E2", color:"#991B1B", borderRadius:"6px", fontSize:"12px", marginBottom:"12px" }}>{error}</div>}

            {/* Preview */}
            {parsed && !error && (
              <div style={{ marginBottom:"16px" }}>
                {parsed.meta.accountRef && (
                  <div style={{ fontSize:"12px", color:"#999", marginBottom:"10px" }}>
                    {parsed.meta.accountRef} · {parsed.meta.accountName} · {parsed.meta.statementFrom} → {parsed.meta.statementTo}
                  </div>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
                  {[
                    { label:"Debits",   val:debits,   sub:fmt(totalDebitAmt), color:"#1a1a1a" },
                    { label:"Credits",  val:credits,  sub:"auto-ignored",      color:"#9CA3AF" },
                    { label:"Refunds",  val:refunds,  sub:"visible only",      color:"#991B1B" },
                    { label:"Total rows", val:parsed.rows.length, sub:"",     color:"#666" },
                  ].map(c => (
                    <div key={c.label} style={{ background:"#f9f9f7", borderRadius:"7px", padding:"10px 12px" }}>
                      <div style={{ fontSize:"11px", color:"#999", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.5px" }}>{c.label}</div>
                      <div style={{ fontSize:"18px", fontWeight:700, color:c.color }}>{c.val}</div>
                      {c.sub && <div style={{ fontSize:"11px", color:"#aaa" }}>{c.sub}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display:"flex", gap:"8px" }}>
              <button onClick={onClose} style={{ flex:1, padding:"10px", borderRadius:"8px", border:"1.5px solid #e0e0e0", background:"#fff", color:"#666", fontSize:"13px", fontWeight:600, cursor:"pointer" }}>Cancel</button>
              <button onClick={handleImport} disabled={!parsed || uploading || !!error} style={{ flex:2, padding:"10px", borderRadius:"8px", border:"none", background: parsed && !error ? "#E8512A" : "#ccc", color:"#fff", fontSize:"13px", fontWeight:600, cursor: parsed && !error ? "pointer" : "not-allowed" }}>
                {uploading ? "Importing…" : `Import ${debits} debits`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── MANUAL PAYMENT MODAL ──────────────────────────────────────────────────────

function ManualPaymentModal({ suppliers, presetSupplierId, onClose, onSaved }) {
  const [form, setForm]         = useState({ supplier_id: presetSupplierId || "", purchase_id: "", payment_date: new Date().toISOString().split("T")[0], amount: "", payment_method: "M-Pesa", reference: "", note: "" });
  const [purchases, setPurchases] = useState([]);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");

  useEffect(() => {
    if (form.supplier_id) {
      fetch(`/api/purchases?supplier_id=${form.supplier_id}`).then(r => r.json()).then(j => setPurchases(j.data || []));
    } else {
      setPurchases([]);
    }
  }, [form.supplier_id]);

  const handleSave = async () => {
    if (!form.supplier_id) { setError("Select a supplier."); return; }
    if (!parseFloat(form.amount)) { setError("Enter an amount."); return; }
    setSaving(true);
    setError("");
    try {
      const res  = await fetch("/api/manual-payments", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ ...form, supplier_purchase_id: form.purchase_id || null }) });
      const json = await res.json();
      if (!json.success) throw new Error(json.detail || json.error || "Failed");
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:400, display:"flex", alignItems:"center", justifyContent:"center", padding:"16px" }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:"12px", padding:"24px", width:"100%", maxWidth:"460px", maxHeight:"90vh", overflowY:"auto" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"20px" }}>
          <h2 style={{ fontSize:"16px", fontWeight:700, margin:0 }}>Manual payment</h2>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:"#aaa", fontSize:"20px", lineHeight:1 }}>✕</button>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px" }}>
          <div style={{ gridColumn:"1/-1" }}>
            <label style={ss.label}>Supplier *</label>
            <select style={ss.input} value={form.supplier_id} onChange={e => setForm({...form, supplier_id:e.target.value, purchase_id:""})}>
              <option value="">— Select supplier —</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {form.supplier_id && (
            <div style={{ gridColumn:"1/-1" }}>
              <label style={ss.label}>Link to purchase (optional)</label>
              <select style={ss.input} value={form.purchase_id} onChange={e => setForm({...form, purchase_id:e.target.value})}>
                <option value="">— None —</option>
                {purchases
                  .filter(p => parseFloat(p.total_amount||0) - parseFloat(p.amount_paid||0) > 0.01)
                  .map(p => {
                    const bal = parseFloat(p.total_amount||0) - parseFloat(p.amount_paid||0);
                    return <option key={p.id} value={p.id}>{p.purchase_date} · {p.items_bought?.slice(0,40)} · Bal {fmt(bal)}</option>;
                  })}
              </select>
            </div>
          )}
          <div>
            <label style={ss.label}>Date</label>
            <input style={ss.input} type="date" value={form.payment_date} onChange={e => setForm({...form, payment_date:e.target.value})} />
          </div>
          <div>
            <label style={ss.label}>Amount (KSh) *</label>
            <input style={ss.input} type="number" min="0" step="1" value={form.amount} onChange={e => setForm({...form, amount:e.target.value})} placeholder="0" />
          </div>
          <div>
            <label style={ss.label}>Method</label>
            <select style={ss.input} value={form.payment_method} onChange={e => setForm({...form, payment_method:e.target.value})}>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={ss.label}>Reference</label>
            <input style={ss.input} value={form.reference} onChange={e => setForm({...form, reference:e.target.value})} placeholder="e.g. QDK91XMPL" />
          </div>
          <div style={{ gridColumn:"1/-1" }}>
            <label style={ss.label}>Note</label>
            <input style={ss.input} value={form.note} onChange={e => setForm({...form, note:e.target.value})} placeholder="Optional note" />
          </div>
        </div>

        {error && <div style={{ marginTop:"10px", padding:"8px 12px", background:"#FEE2E2", color:"#991B1B", borderRadius:"6px", fontSize:"12px" }}>{error}</div>}

        <div style={{ display:"flex", gap:"8px", marginTop:"16px" }}>
          <button onClick={onClose} style={{ flex:1, padding:"10px", borderRadius:"8px", border:"1.5px solid #e0e0e0", background:"#fff", color:"#666", fontSize:"13px", fontWeight:600, cursor:"pointer" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ flex:2, padding:"10px", borderRadius:"8px", border:"none", background:"#1a1a1a", color:"#fff", fontSize:"13px", fontWeight:600, cursor:saving?"not-allowed":"pointer", opacity:saving?0.6:1 }}>
            {saving ? "Saving…" : "Record payment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MAIN PaymentsTab ──────────────────────────────────────────────────────────

export default function PaymentsTab({ suppliers }) {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [statusFilter, setStatusFilter] = useState("unmatched");
  const [search, setSearch]             = useState("");
  const [matchingTx, setMatchingTx]     = useState(null);
  const [showUpload, setShowUpload]     = useState(false);
  const [showManual, setShowManual]     = useState(false);

  // Summary counts (all statuses)
  const [allStats, setAllStats] = useState({ unmatched:0, partial:0, matched:0, ignored:0, refund:0, totalDebits:0 });

  const loadTransactions = async (status = statusFilter) => {
    setLoading(true);
    const params = new URLSearchParams({ status, limit:"300" });
    if (search) params.set("search", search);
    const res  = await fetch(`/api/chatpesa/transactions?${params}`);
    const json = await res.json();
    setTransactions(json.data || []);
    setLoading(false);
  };

  const loadStats = async () => {
    const res  = await fetch("/api/chatpesa/transactions?status=all&limit=500");
    const json = await res.json();
    const txs  = json.data || [];
    setAllStats({
      unmatched:   txs.filter(t => t.match_status==="unmatched").length,
      partial:     txs.filter(t => t.match_status==="partial").length,
      matched:     txs.filter(t => t.match_status==="matched").length,
      ignored:     txs.filter(t => t.match_status==="ignored").length,
      refund:      txs.filter(t => t.match_status==="refund").length,
      totalDebits: txs.filter(t => t.tx_type==="debit").reduce((s,t)=>s+parseFloat(t.amount||0),0),
    });
  };

  useEffect(() => { loadTransactions(); loadStats(); }, []);
  useEffect(() => { loadTransactions(statusFilter); }, [statusFilter]);

  const handleSearch = (e) => {
    if (e.key === "Enter") loadTransactions();
  };

  const canMatch = (tx) => tx.tx_type === "debit" && !["ignored","credit"].includes(tx.match_status);

  const STATUS_TABS = [
    { key:"unmatched", label:`Unmatched (${allStats.unmatched})` },
    { key:"partial",   label:`Partial (${allStats.partial})` },
    { key:"matched",   label:`Matched (${allStats.matched})` },
    { key:"ignored",   label:`Ignored (${allStats.ignored})` },
    { key:"refund",    label:`Refunds (${allStats.refund})` },
    { key:"all",       label:"All" },
  ];

  return (
    <div>
      {/* Summary bar */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:"10px", marginBottom:"20px" }}>
        {[
          { label:"Unmatched",  val:allStats.unmatched,  color: allStats.unmatched > 0 ? "#92400E" : "#065F46" },
          { label:"Partial",    val:allStats.partial,    color: allStats.partial > 0 ? "#1E40AF" : "#065F46" },
          { label:"Matched",    val:allStats.matched,    color:"#065F46" },
          { label:"Total debits", val:fmt(allStats.totalDebits), color:"#1a1a1a" },
        ].map(c => (
          <div key={c.label} style={{ background:"#fff", border:"1px solid #e8e8e5", borderRadius:"10px", padding:"12px 14px" }}>
            <div style={{ fontSize:"11px", color:"#999", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:"4px" }}>{c.label}</div>
            <div style={{ fontSize:"18px", fontWeight:700, color:c.color }}>{c.val}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display:"flex", gap:"8px", marginBottom:"16px", flexWrap:"wrap" }}>
        <input type="text" placeholder="Search transactions…" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={handleSearch}
          style={{ flex:"1 1 200px", padding:"9px 14px", borderRadius:"8px", border:"1.5px solid #e0e0e0", fontSize:"13px", background:"#fff" }} />
        <button onClick={() => setShowManual(true)} style={{ padding:"9px 16px", borderRadius:"7px", border:"1.5px solid #e0e0e0", background:"#fff", color:"#333", fontSize:"13px", fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" }}>
          + Manual payment
        </button>
        <button onClick={() => setShowUpload(true)} style={{ padding:"9px 16px", borderRadius:"7px", border:"none", background:"#E8512A", color:"#fff", fontSize:"13px", fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" }}>
          ↑ Upload CSV
        </button>
      </div>

      {/* Status tabs */}
      <div style={{ display:"flex", gap:0, marginBottom:"16px", borderBottom:"2px solid #e8e8e5", overflowX:"auto" }}>
        {STATUS_TABS.map(t => (
          <button key={t.key} onClick={() => setStatusFilter(t.key)} style={{ padding:"8px 14px", fontSize:"12px", fontWeight:600, border:"none", background:"none", cursor:"pointer", color: statusFilter===t.key ? "#1a1a1a" : "#999", borderBottom: statusFilter===t.key ? "2px solid #E8512A" : "2px solid transparent", marginBottom:"-2px", whiteSpace:"nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Transaction list */}
      {loading ? (
        <div style={{ padding:"40px", textAlign:"center", color:"#aaa" }}>Loading…</div>
      ) : transactions.length === 0 ? (
        <div style={{ padding:"60px 20px", textAlign:"center" }}>
          <div style={{ fontSize:"36px", marginBottom:"12px" }}>📋</div>
          <div style={{ fontSize:"14px", color:"#999" }}>
            {statusFilter === "unmatched" ? "No unmatched transactions — you're up to date." : `No ${statusFilter} transactions.`}
          </div>
          {statusFilter === "unmatched" && (
            <button onClick={() => setShowUpload(true)} style={{ marginTop:"12px", padding:"8px 20px", borderRadius:"6px", border:"1.5px solid #e0e0e0", background:"#fff", color:"#333", fontSize:"13px", fontWeight:600, cursor:"pointer" }}>
              Upload Chatpesa CSV
            </button>
          )}
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:"6px" }}>
          {transactions.map(tx => {
            const sm = STATUS_META[tx.match_status] || STATUS_META.ignored;
            const allocated = (tx.chatpesa_payment_allocations||[]).reduce((s,a)=>s+parseFloat(a.amount||0),0);
            return (
              <div key={tx.id} style={{ background:"#fff", borderRadius:"10px", border:"1px solid #e8e8e5", borderLeft:`4px solid ${sm.border}`, padding:"12px 16px", display:"flex", alignItems:"flex-start", gap:"12px", flexWrap:"wrap" }}>
                <div style={{ flex:"1 1 200px", minWidth:0 }}>
                  <div style={{ display:"flex", gap:"8px", alignItems:"center", flexWrap:"wrap" }}>
                    <span style={{ fontSize:"13px", fontWeight:700, color:"#1a1a1a" }}>{tx.account_name || "—"}</span>
                    <StatusBadge status={tx.match_status} />
                    {tx.suggested_supplier && tx.match_status === "unmatched" && (
                      <span style={{ fontSize:"10px", color:"#B45309", background:"#FEF3C7", padding:"1px 6px", borderRadius:"3px" }}>
                        💡 {tx.suggested_supplier.name} ({Math.round(tx.suggested_confidence*100)}%)
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize:"11px", color:"#aaa", marginTop:"3px" }}>
                    {tx.transaction_date} · {tx.source}
                  </div>
                  {tx.description && (
                    <div style={{ fontSize:"12px", color:"#666", marginTop:"3px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {tx.description.split("\n")[0]}
                    </div>
                  )}
                  {allocated > 0 && tx.match_status === "partial" && (
                    <div style={{ fontSize:"11px", color:"#1E40AF", marginTop:"3px" }}>
                      Allocated: {fmt(allocated)} of {fmt(tx.amount)}
                    </div>
                  )}
                </div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:"6px", flexShrink:0 }}>
                  <span style={{ fontSize:"14px", fontWeight:700, color:"#1a1a1a" }}>{fmt(tx.amount)}</span>
                  {canMatch(tx) && (
                    <button onClick={() => setMatchingTx(tx)} style={{ padding:"5px 12px", borderRadius:"5px", border:"none", background:"#1a1a1a", color:"#fff", fontSize:"11px", fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" }}>
                      {tx.match_status === "partial" ? "Add more" : "Match"}
                    </button>
                  )}
                  {tx.match_status === "ignored" && (
                    <button onClick={async () => {
                      await fetch(`/api/chatpesa/transactions/${tx.id}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"unignore"}) });
                      loadTransactions(); loadStats();
                    }} style={{ padding:"5px 12px", borderRadius:"5px", border:"1.5px solid #e0e0e0", background:"#fff", color:"#666", fontSize:"11px", fontWeight:600, cursor:"pointer" }}>
                      Restore
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onImported={() => { loadTransactions(); loadStats(); }} />}
      {showManual && <ManualPaymentModal suppliers={suppliers} onClose={() => setShowManual(false)} onSaved={() => { loadTransactions(); loadStats(); }} />}
      {matchingTx && <MatchModal tx={matchingTx} suppliers={suppliers} onClose={() => setMatchingTx(null)} onSaved={() => { loadTransactions(); loadStats(); }} />}

      <style>{`@media(max-width:640px){}`}</style>
    </div>
  );
}
