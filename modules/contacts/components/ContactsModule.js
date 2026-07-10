"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";

const TYPE_COLORS = {
  Customer:    { bg: "#DBEAFE", text: "#1E40AF", border: "#93C5FD" },
  Supplier:    { bg: "#FEF3C7", text: "#92400E", border: "#FCD34D" },
  General:     { bg: "#F3F4F6", text: "#374151", border: "#D1D5DB" },
  Transporter: { bg: "#D1FAE5", text: "#065F46", border: "#6EE7B7" },
};

const CONTACT_TYPES = ["General", "Transporter"];

const ss = {
  label:    { display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.5px" },
  input:    { width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "13px", background: "#fafafa", boxSizing: "border-box", fontFamily: "inherit" },
  textarea: { width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "13px", background: "#fafafa", resize: "vertical", minHeight: "60px", fontFamily: "inherit", boxSizing: "border-box" },
};

const EMPTY_FORM = { contact_type: "General", name: "", company: "", phone: "", email: "", address: "", notes: "" };

function TypeBadge({ type }) {
  const c = TYPE_COLORS[type] || TYPE_COLORS.General;
  return (
    <span style={{ fontSize: "10px", fontWeight: 700, color: c.text, background: c.bg, border: `1px solid ${c.border}`, padding: "2px 7px", borderRadius: "3px", whiteSpace: "nowrap" }}>
      {type}
    </span>
  );
}

function Avatar({ name, type, size = 36 }) {
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const COLOR = { Customer: "#2563EB", Supplier: "#D97706", General: "#6B7280", Transporter: "#059669" };
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: COLOR[type] || "#888", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.38, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
      {initials}
    </div>
  );
}

export default function ContactsModule() {
  const router                      = useRouter();
  const [contacts, setContacts]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch]         = useState("");
  const [showForm, setShowForm]     = useState(false);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState("");
  const [editContact, setEditContact] = useState(null);

  const loadContacts = async (type = typeFilter) => {
    setLoading(true);
    const params = new URLSearchParams({ type });
    if (search) params.set("search", search);
    const res  = await fetch(`/api/contacts?${params}`);
    const json = await res.json();
    setContacts(json.data || []);
    setLoading(false);
  };

  useEffect(() => { loadContacts(); }, []);
  useEffect(() => { loadContacts(typeFilter); }, [typeFilter]);

  const filtered = useMemo(() => {
    if (!search) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(c =>
      [c.name, c.company, c.contact_person, c.phone, c.email].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
  }, [contacts, search]);

  // Counts per type (from full unfiltered list — reload with "all" for counts)
  const [counts, setCounts] = useState({});
  useEffect(() => {
    fetch("/api/contacts?type=all").then(r => r.json()).then(j => {
      const all = j.data || [];
      const c = {};
      for (const item of all) c[item.contact_type] = (c[item.contact_type] || 0) + 1;
      setCounts(c);
    });
  }, [contacts]);

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError("Name is required."); return; }
    setSaving(true); setFormError("");
    try {
      const isEdit = !!editContact;
      const url    = isEdit ? `/api/contacts/${editContact.id}` : "/api/contacts";
      const method = isEdit ? "PATCH" : "POST";
      const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const json   = await res.json();
      if (!json.success) throw new Error(json.error || "Failed");
      setShowForm(false); setForm(EMPTY_FORM); setEditContact(null);
      await loadContacts();
    } catch (err) { setFormError(err.message); }
    setSaving(false);
  };

  const handleDelete = async (contact) => {
    if (!confirm(`Delete ${contact.name}?`)) return;
    await fetch(`/api/contacts/${contact.id}`, { method: "DELETE" });
    await loadContacts();
  };

  const openEdit = (contact) => {
    if (contact.source !== "contacts") {
      // Navigate to the appropriate module
      if (contact.source === "customers") router.push(`/customers/${contact.id}`);
      if (contact.source === "suppliers") router.push(`/suppliers`);
      return;
    }
    setEditContact(contact);
    setForm({ contact_type: contact.contact_type, name: contact.name, company: contact.company || "", phone: contact.phone || "", email: contact.email || "", address: contact.address || "", notes: contact.notes || "" });
    setFormError("");
    setShowForm(true);
  };

  const TYPE_TABS = [
    { key: "all",         label: `All (${Object.values(counts).reduce((s, n) => s + n, 0)})` },
    { key: "Customer",    label: `Customers (${counts.Customer || 0})` },
    { key: "Supplier",    label: `Suppliers (${counts.Supplier || 0})` },
    { key: "General",     label: `General (${counts.General || 0})` },
    { key: "Transporter", label: `Transporters (${counts.Transporter || 0})` },
  ];

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "24px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, margin: 0 }}>Contacts</h1>
          <p style={{ fontSize: "13px", color: "#999", margin: "4px 0 0" }}>Customers, suppliers, general contacts and transporters</p>
        </div>
        <button onClick={() => { setShowForm(true); setForm(EMPTY_FORM); setEditContact(null); setFormError(""); }}
          style={{ padding: "10px 20px", borderRadius: "8px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>
          + Add Contact
        </button>
      </div>

      {/* Search + type tabs */}
      <input type="text" placeholder="Search by name, phone, email…" value={search} onChange={e => setSearch(e.target.value)}
        style={{ width: "100%", padding: "10px 14px", borderRadius: "8px", border: "1.5px solid #e0e0e0", fontSize: "14px", background: "#fff", marginBottom: "12px", boxSizing: "border-box" }} />

      <div style={{ display: "flex", gap: 0, marginBottom: "16px", borderBottom: "2px solid #e8e8e5", overflowX: "auto" }}>
        {TYPE_TABS.map(t => (
          <button key={t.key} onClick={() => setTypeFilter(t.key)} style={{
            padding: "8px 16px", fontSize: "12px", fontWeight: 600, border: "none", background: "none", cursor: "pointer",
            color: typeFilter === t.key ? "#1a1a1a" : "#999",
            borderBottom: typeFilter === t.key ? "2px solid #E8512A" : "2px solid transparent",
            marginBottom: "-2px", whiteSpace: "nowrap",
          }}>{t.label}</button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div style={{ padding: "60px 20px", textAlign: "center", color: "#aaa" }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: "60px 20px", textAlign: "center" }}>
          <div style={{ fontSize: "36px", marginBottom: "10px" }}>📇</div>
          <div style={{ fontSize: "14px", color: "#999" }}>{search ? "No contacts match your search." : "No contacts in this category."}</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {filtered.map(c => (
            <div key={`${c.source}-${c.id}`}
              style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e8e8e5", padding: "12px 14px", display: "flex", alignItems: "center", gap: "12px" }}>
              <Avatar name={c.name} type={c.contact_type} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "#1a1a1a" }}>{c.name}</span>
                  <TypeBadge type={c.contact_type} />
                  {c.company && <span style={{ fontSize: "12px", color: "#888" }}>{c.company}</span>}
                </div>
                <div style={{ fontSize: "12px", color: "#999", marginTop: "3px" }}>
                  {[c.contact_person, c.phone, c.email].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                {/* Call link */}
                {c.phone && (
                  <a href={`tel:${c.phone}`} onClick={e => e.stopPropagation()}
                    style={{ padding: "5px 12px", borderRadius: "5px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "11px", fontWeight: 600, textDecoration: "none", display: "flex", alignItems: "center", gap: "4px" }}>
                    📞 Call
                  </a>
                )}
                {/* View/Edit */}
                <button onClick={() => openEdit(c)}
                  style={{ padding: "5px 12px", borderRadius: "5px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>
                  {c.source === "contacts" ? "Edit" : "View →"}
                </button>
                {/* Delete (contacts table only) */}
                {c.source === "contacts" && (
                  <button onClick={() => handleDelete(c)}
                    style={{ padding: "5px 10px", borderRadius: "5px", border: "1.5px solid #FCA5A5", background: "#fff", color: "#C62828", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Modal (General + Transporter only) */}
      {showForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={() => { setShowForm(false); setEditContact(null); }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "480px", maxHeight: "90vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: "17px", fontWeight: 700, margin: "0 0 18px" }}>{editContact ? "Edit Contact" : "Add Contact"}</h2>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div style={{ gridColumn: "1/-1" }}>
                <label style={ss.label}>Type</label>
                <select style={ss.input} value={form.contact_type} onChange={e => setForm({ ...form, contact_type: e.target.value })}>
                  {CONTACT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: "1/-1" }}>
                <label style={ss.label}>Name *</label>
                <input style={ss.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. John Kamau" />
              </div>
              <div style={{ gridColumn: "1/-1" }}>
                <label style={ss.label}>Company (optional)</label>
                <input style={ss.input} value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} placeholder="e.g. Kamau Logistics" />
              </div>
              <div>
                <label style={ss.label}>Phone</label>
                <input style={ss.input} type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="0712 XXX XXX" />
              </div>
              <div>
                <label style={ss.label}>Email</label>
                <input style={ss.input} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
              </div>
              <div style={{ gridColumn: "1/-1" }}>
                <label style={ss.label}>Address</label>
                <input style={ss.input} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="e.g. Industrial Area, Nairobi" />
              </div>
              <div style={{ gridColumn: "1/-1" }}>
                <label style={ss.label}>Notes</label>
                <textarea style={ss.textarea} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Internal notes…" />
              </div>
            </div>

            {formError && <div style={{ marginTop: "10px", padding: "8px 12px", background: "#FEE2E2", color: "#991B1B", borderRadius: "6px", fontSize: "12px" }}>{formError}</div>}

            <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
              <button onClick={() => { setShowForm(false); setEditContact(null); }} style={{ flex: 1, padding: "10px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={handleSave} disabled={saving} style={{ flex: 2, padding: "10px", borderRadius: "8px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : editContact ? "Save Changes" : "Add Contact"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
