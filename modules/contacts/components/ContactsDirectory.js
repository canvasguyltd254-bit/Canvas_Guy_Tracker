"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/shared/supabase/client";

const CATEGORIES = [
  "Supplier",
  "Service Provider",
  "Subcontractor",
  "Installer",
  "Transporter",
  "Maintenance Provider",
];

const CAT_COLORS = {
  Supplier: { bg: "#E3F2FD", text: "#1565C0" },
  "Service Provider": { bg: "#F3E5F5", text: "#7B1FA2" },
  Subcontractor: { bg: "#FFF3E0", text: "#E65100" },
  Installer: { bg: "#E8F5E9", text: "#2E7D32" },
  Transporter: { bg: "#FFFDE7", text: "#F57F17" },
  "Maintenance Provider": { bg: "#FCE4EC", text: "#C62828" },
};

const EMPTY_FORM = {
  company_name: "",
  category: "Supplier",
  contact_person: "",
  phone: "",
  email: "",
  location: "",
  products_services: "",
  notes: "",
};

export default function ContactsDirectory() {
  const [contacts, setContacts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [userRole, setUserRole] = useState("viewer");
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const sb = createClient();

  const canEdit = ["admin", "production_manager", "sales"].includes(userRole);
  const canDelete = ["admin", "production_manager"].includes(userRole);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: profile } = await sb.from("user_profiles").select("role").eq("id", user.id).single();
        if (profile) setUserRole(profile.role);
      }
      await loadContacts();
    })();
  }, []);

  const loadContacts = async () => {
    const { data } = await sb.from("contacts").select("*").order("company_name", { ascending: true });
    setContacts(data || []);
    setLoaded(true);
  };

  const openAdd = () => { setForm(EMPTY_FORM); setEditing(null); setShowForm(true); };

  const openEdit = (c) => {
    setForm({
      company_name: c.company_name || "",
      category: c.category || "Supplier",
      contact_person: c.contact_person || "",
      phone: c.phone || "",
      email: c.email || "",
      location: c.location || "",
      products_services: c.products_services || "",
      notes: c.notes || "",
    });
    setEditing(c.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.company_name.trim()) { alert("Company name is required."); return; }
    setSaving(true);
    try {
      if (editing) {
        const { error } = await sb.from("contacts").update({ ...form, company_name: form.company_name.trim() }).eq("id", editing);
        if (error) throw error;
      } else {
        const { error } = await sb.from("contacts").insert({ ...form, company_name: form.company_name.trim() });
        if (error) throw error;
      }
      setShowForm(false);
      setEditing(null);
      await loadContacts();
    } catch (err) {
      alert("Error: " + err.message);
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await sb.from("contacts").delete().eq("id", deleteTarget);
    if (error) { alert("Error: " + error.message); }
    setDeleteTarget(null);
    await loadContacts();
  };

  const filtered = contacts.filter((c) => {
    if (filterCat !== "All" && c.category !== filterCat) return false;
    if (search) {
      const q = search.toLowerCase();
      return [c.company_name, c.contact_person, c.phone, c.email, c.location, c.products_services, c.notes]
        .filter(Boolean).join(" ").toLowerCase().includes(q);
    }
    return true;
  });

  // Group by category for the count badges
  const catCounts = {};
  contacts.forEach((c) => { catCounts[c.category] = (catCounts[c.category] || 0) + 1; });

  if (!loaded) return <div style={{ padding: "40px", textAlign: "center", color: "#aaa" }}>Loading...</div>;

  const ss = {
    label: { display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.5px" },
    input: { width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa" },
    textarea: { width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa", resize: "vertical", minHeight: "60px", fontFamily: "inherit" },
  };

  return (
    <div style={{ padding: "20px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "4px" }}>Contacts Directory</h1>
          <p style={{ fontSize: "13px", color: "#999" }}>
            {contacts.length} contact{contacts.length !== 1 ? "s" : ""} — suppliers, service providers & operational contacts
          </p>
        </div>
        {canEdit && (
          <button onClick={openAdd} style={{
            padding: "10px 20px", borderRadius: "8px", border: "none",
            background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600,
            cursor: "pointer", whiteSpace: "nowrap",
          }}>+ Add Contact</button>
        )}
      </div>

      {/* Search + Category filter */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
        <input
          type="text" placeholder="Search contacts..." value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: "1 1 200px", padding: "9px 14px", borderRadius: "8px", border: "1.5px solid #e0e0e0", fontSize: "14px", background: "#fff", minWidth: "180px" }}
        />
        <select
          value={filterCat} onChange={(e) => setFilterCat(e.target.value)}
          style={{ padding: "9px 14px", borderRadius: "8px", border: "1.5px solid #e0e0e0", fontSize: "13px", background: "#fff", fontWeight: 500, cursor: "pointer" }}
        >
          <option value="All">All Categories ({contacts.length})</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{cat} ({catCounts[cat] || 0})</option>
          ))}
        </select>
      </div>

      {/* Contact cards */}
      {filtered.length === 0 ? (
        <div style={{ padding: "60px 20px", textAlign: "center" }}>
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>📇</div>
          <div style={{ fontSize: "14px", color: "#999" }}>{search || filterCat !== "All" ? "No contacts match your filter." : "No contacts yet."}</div>
          {canEdit && !search && filterCat === "All" && (
            <button onClick={openAdd} style={{
              marginTop: "14px", padding: "8px 20px", borderRadius: "6px", border: "1.5px solid #e0e0e0",
              background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer",
            }}>Add your first contact</button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {filtered.map((c) => {
            const colors = CAT_COLORS[c.category] || { bg: "#f5f5f5", text: "#666" };
            const isExpanded = expandedId === c.id;
            return (
              <div key={c.id} className="order-card" style={{
                background: "#fff", borderRadius: "10px", border: "1px solid #e8e8e5",
                borderLeft: `4px solid ${colors.text}`, overflow: "hidden",
                cursor: "pointer", transition: "box-shadow 0.15s, transform 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,0.1)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "none"; }}
              onClick={() => setExpandedId(isExpanded ? null : c.id)}>
                {/* Summary row */}
                <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 200px", minWidth: "140px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: "#1a1a1a" }}>{c.company_name}</span>
                      <span style={{
                        fontSize: "10px", fontWeight: 700, color: colors.text,
                        background: colors.bg, padding: "2px 8px", borderRadius: "4px",
                        textTransform: "uppercase", letterSpacing: "0.3px",
                      }}>{c.category}</span>
                    </div>
                    {c.contact_person && (
                      <div style={{ fontSize: "12px", color: "#888", marginTop: "3px" }}>{c.contact_person}</div>
                    )}
                  </div>
                  <div className="contact-meta" style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
                    {c.phone && (
                      <a href={`tel:${c.phone}`} onClick={(e) => e.stopPropagation()} style={{
                        fontSize: "13px", color: "#1565C0", textDecoration: "none", fontFamily: "'DM Mono', monospace",
                      }}>{c.phone}</a>
                    )}
                    {c.location && (
                      <span style={{ fontSize: "12px", color: "#999" }}>📍 {c.location}</span>
                    )}
                  </div>
                  <span style={{ fontSize: "16px", color: "#ccc", flexShrink: 0, transition: "transform 0.15s", transform: isExpanded ? "rotate(180deg)" : "rotate(0)" }}>▾</span>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div style={{ padding: "0 16px 16px", borderTop: "1px solid #f0ede8" }}>
                    <div className="contact-detail-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", paddingTop: "14px" }}>
                      {c.phone && <div><div style={ss.label}>Phone</div><a href={`tel:${c.phone}`} style={{ fontSize: "13px", color: "#1565C0", textDecoration: "none" }}>{c.phone}</a></div>}
                      {c.email && <div><div style={ss.label}>Email</div><a href={`mailto:${c.email}`} style={{ fontSize: "13px", color: "#1565C0", textDecoration: "none" }}>{c.email}</a></div>}
                      {c.location && <div><div style={ss.label}>Location</div><div style={{ fontSize: "13px", color: "#333" }}>{c.location}</div></div>}
                      {c.contact_person && <div><div style={ss.label}>Contact Person</div><div style={{ fontSize: "13px", color: "#333" }}>{c.contact_person}</div></div>}
                    </div>
                    {c.products_services && (
                      <div style={{ marginTop: "14px" }}>
                        <div style={ss.label}>Products / Services</div>
                        <div style={{ fontSize: "13px", color: "#333", whiteSpace: "pre-line" }}>{c.products_services}</div>
                      </div>
                    )}
                    {c.notes && (
                      <div style={{ marginTop: "14px" }}>
                        <div style={ss.label}>Notes</div>
                        <div style={{ fontSize: "13px", color: "#666", fontStyle: "italic" }}>{c.notes}</div>
                      </div>
                    )}
                    {/* Actions */}
                    {(canEdit || canDelete) && (
                      <div style={{ display: "flex", gap: "8px", marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #f0ede8" }}>
                        {canEdit && (
                          <button onClick={(e) => { e.stopPropagation(); openEdit(c); }} style={{
                            padding: "7px 16px", borderRadius: "6px", border: "1.5px solid #e0e0e0",
                            background: "#fff", color: "#333", fontSize: "12px", fontWeight: 600,
                            cursor: "pointer",
                          }}>Edit</button>
                        )}
                        {canDelete && (
                          <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(c.id); }} style={{
                            padding: "7px 16px", borderRadius: "6px", border: "1.5px solid #FFCDD2",
                            background: "#FFF5F5", color: "#C62828", fontSize: "12px", fontWeight: 600,
                            cursor: "pointer",
                          }}>Delete</button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Modal */}
      {showForm && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.5)", zIndex: 200,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "16px",
        }} onClick={() => { setShowForm(false); setEditing(null); }}>
          <div style={{
            background: "#fff", borderRadius: "12px", padding: "24px",
            width: "100%", maxWidth: "520px", maxHeight: "90vh", overflowY: "auto",
          }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "20px" }}>
              {editing ? "Edit Contact" : "Add Contact"}
            </h2>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }} className="form-grid">
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Company Name *</label>
                <input style={ss.input} value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} placeholder="e.g. ABC Paints" />
              </div>
              <div>
                <label style={ss.label}>Category</label>
                <select style={{ ...ss.input, cursor: "pointer" }} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                </select>
              </div>
              <div>
                <label style={ss.label}>Contact Person</label>
                <input style={ss.input} value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} placeholder="e.g. John Kamau" />
              </div>
              <div>
                <label style={ss.label}>Phone</label>
                <input style={ss.input} type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="e.g. 0712 XXX XXX" />
              </div>
              <div>
                <label style={ss.label}>Email</label>
                <input style={ss.input} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="e.g. info@abcpaints.co.ke" />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Location</label>
                <input style={ss.input} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Industrial Area, Nairobi" />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Products / Services</label>
                <textarea style={ss.textarea} value={form.products_services} onChange={(e) => setForm({ ...form, products_services: e.target.value })} placeholder="e.g. NC Lacquer, PU Finish, Thinner, Sanding Sealer" rows={3} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Notes</label>
                <textarea style={ss.textarea} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Best bulk pricing" rows={2} />
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "20px" }}>
              <button onClick={() => { setShowForm(false); setEditing(null); }} style={{
                padding: "10px 20px", borderRadius: "8px", border: "1.5px solid #e0e0e0",
                background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer",
              }}>Cancel</button>
              <button onClick={handleSave} disabled={saving} style={{
                padding: "10px 24px", borderRadius: "8px", border: "none",
                background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1,
              }}>{saving ? "Saving..." : editing ? "Update" : "Add Contact"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.5)", zIndex: 200,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "16px",
        }} onClick={() => setDeleteTarget(null)}>
          <div style={{
            background: "#fff", borderRadius: "12px", padding: "24px",
            width: "100%", maxWidth: "380px",
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: "24px", marginBottom: "12px" }}>⚠️</div>
            <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px" }}>Delete Contact</h3>
            <p style={{ fontSize: "13px", color: "#666", marginBottom: "20px" }}>
              Are you sure you want to remove <strong>{contacts.find((c) => c.id === deleteTarget)?.company_name}</strong> from the directory? This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
              <button onClick={() => setDeleteTarget(null)} style={{
                padding: "9px 18px", borderRadius: "8px", border: "1.5px solid #e0e0e0",
                background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer",
              }}>Cancel</button>
              <button onClick={handleDelete} style={{
                padding: "9px 18px", borderRadius: "8px", border: "none",
                background: "#C62828", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer",
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 640px) {
          .contact-meta { flex-direction: column; gap: 4px !important; align-items: flex-start !important; }
          .contact-detail-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
