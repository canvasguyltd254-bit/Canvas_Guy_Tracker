"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/shared/supabase/client";

const ROLES = [
  { id: "admin", label: "Admin", desc: "Full access — manage users, orders, and settings" },
  { id: "production_manager", label: "Production Manager", desc: "Manage orders, assign work, update statuses" },
  { id: "head_of_sales", label: "Head of Sales", desc: "Supervisor — create/edit orders, approve credit ≤250k, authorize batch deliveries, send back orders" },
  { id: "sales", label: "Sales", desc: "Create orders, manage quotes, payments, and advance up to Deposit Paid" },
  { id: "production_staff", label: "Production Staff", desc: "View orders, update assigned work" },
  { id: "viewer", label: "Viewer", desc: "Read-only access to all orders" },
];

const ROLE_COLORS = {
  admin: "#C62828", production_manager: "#E65100", head_of_sales: "#F57C00",
  sales: "#1565C0", production_staff: "#2E7D32", viewer: "#9E9E9E",
};

/* === CLIENT CREDIT LIMITS COMPONENT === */
function ClientCreditLimits() {
  const [allClients, setAllClients] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientLimit, setNewClientLimit] = useState("");
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [loading, setLoading] = useState(false);
  const sb = createClient();

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    // Fetch all orders to find reseller/commercial clients
    const { data: orders } = await sb.from("orders").select("id,client,customer_type,total_value,status").in("customer_type", ["reseller", "commercial"]);
    
    // Fetch all payments
    const { data: pays } = await sb.from("order_payments").select("order_id,amount");
    
    // Fetch existing client_profiles
    const { data: profiles } = await sb.from("client_profiles").select("client_name,credit_limit");
    
    // Build unique client list from orders
    const clientSet = new Map();
    (orders || []).forEach(o => {
      if (!clientSet.has(o.client)) {
        clientSet.set(o.client, { name: o.client, type: o.customer_type, limit: null });
      }
    });

    // Merge with existing profiles (update limits)
    (profiles || []).forEach(p => {
      if (clientSet.has(p.client_name)) {
        clientSet.get(p.client_name).limit = parseFloat(p.credit_limit) || 0;
      }
    });

    // Calculate exposure for each client
    const exp = {};
    const ordMap = {};
    (orders || []).forEach(o => {
      if (!["Delivered", "Closed"].includes(o.status)) {
        ordMap[o.id] = o;
      }
    });
    (pays || []).forEach(p => {
      if (ordMap[p.order_id]) {
        const o = ordMap[p.order_id];
        if (!exp[o.client]) exp[o.client] = 0;
        exp[o.client] += parseFloat(p.amount) || 0;
      }
    });
    Object.keys(ordMap).forEach(oid => {
      const o = ordMap[oid];
      if (!exp[o.client]) exp[o.client] = 0;
      exp[o.client] = Math.max((parseFloat(o.total_value) || 0) - (exp[o.client] || 0), 0);
    });

    // Attach exposure to clients
    const clientList = Array.from(clientSet.values()).map(c => ({
      ...c,
      exposure: exp[c.name] || 0
    })).sort((a, b) => a.name.localeCompare(b.name));

    setAllClients(clientList);
  };

  const handleSaveLimit = async (clientName, newLimit) => {
    setLoading(true);
    try {
      const encodedName = encodeURIComponent(clientName);
      const res = await fetch(`/api/admin/clients/${encodedName}/credit-limit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credit_limit: parseFloat(newLimit),
          customer_type: allClients.find(c => c.name === clientName)?.type || 'reseller',
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to update credit limit');
      setEditId(null);
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
    setLoading(false);
  };

  const handleAddClient = async () => {
    if (!newClientName.trim() || !newClientLimit.trim()) {
      alert("Please enter client name and credit limit");
      return;
    }
    setLoading(true);
    try {
      // First create the profile (POST /api/admin/clients), then set the limit
      const createRes = await fetch('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: newClientName.trim(),
          customer_type: 'reseller',
        }),
      });
      const createJson = await createRes.json();

      // 409 means profile already exists — proceed to set limit anyway
      if (!createRes.ok && createRes.status !== 409) {
        throw new Error(createJson.error || 'Failed to create client profile');
      }

      // Set the limit via the dedicated endpoint
      const encodedName = encodeURIComponent(newClientName.trim());
      const limitRes = await fetch(`/api/admin/clients/${encodedName}/credit-limit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credit_limit: parseFloat(newClientLimit) }),
      });
      const limitJson = await limitRes.json();
      if (!limitRes.ok) throw new Error(limitJson.error || 'Failed to set credit limit');

      setShowAddModal(false);
      setNewClientName("");
      setNewClientLimit("");
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
    setLoading(false);
  };

  const fmt = n => `KES ${Math.round(n).toLocaleString("en-KE")}`;

  return (
    <div style={{ marginBottom: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
        <div>
          <h3 style={{ fontSize: "14px", fontWeight: 700, marginBottom: "4px" }}>Client Credit Limits</h3>
          <p style={{ fontSize: "12px", color: "#888" }}>All Reseller & Commercial clients. Manage credit exposure and limits.</p>
        </div>
        <button onClick={() => setShowAddModal(true)} style={{ padding: "8px 16px", background: "#1565C0", color: "#fff", border: "none", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>+ Add Client Limit</button>
      </div>

      {showAddModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", maxWidth: "400px", width: "100%", boxShadow: "0 8px 40px rgba(0,0,0,0.2)" }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px" }}>Add Client Credit Limit</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "18px" }}>
              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase" }}>Client Name *</label>
                <input type="text" value={newClientName} onChange={e => setNewClientName(e.target.value)} placeholder="e.g., Serena Hotel" style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase" }}>Credit Limit (KES) *</label>
                <input type="number" value={newClientLimit} onChange={e => setNewClientLimit(e.target.value)} placeholder="e.g., 1000000" style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button onClick={handleAddClient} disabled={loading || !newClientName.trim() || !newClientLimit.trim()} style={{ flex: 1, padding: "10px", background: (loading || !newClientName.trim() || !newClientLimit.trim()) ? "#ccc" : "#1565C0", color: "#fff", border: "none", borderRadius: "6px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Add</button>
              <button onClick={() => setShowAddModal(false)} style={{ flex: 1, padding: "10px", background: "#f5f5f5", color: "#666", border: "none", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {allClients.length === 0 ? (
        <div style={{ fontSize: "13px", color: "#999", background: "#f5f5f5", padding: "16px", borderRadius: "8px" }}>No reseller or commercial clients found. Create an order with a reseller/commercial customer to add them here.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: "13px", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f5f5f5", borderBottom: "1.5px solid #e0e0e0" }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, color: "#666", fontSize: "11px", textTransform: "uppercase" }}>Client</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "#666", fontSize: "11px", textTransform: "uppercase" }}>Type</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "#666", fontSize: "11px", textTransform: "uppercase" }}>Current Exposure</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "#666", fontSize: "11px", textTransform: "uppercase" }}>Credit Limit</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "#666", fontSize: "11px", textTransform: "uppercase" }}>Available</th>
              </tr>
            </thead>
            <tbody>
              {allClients.map((c) => {
                const limit = c.limit || 0;
                const exp = c.exposure || 0;
                const avail = limit > 0 ? Math.max(limit - exp, 0) : limit;
                const overLimit = limit > 0 && exp > limit;
                return (
                  <tr key={c.name} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: "12px", color: "#333", fontWeight: 500 }}>{c.name}</td>
                    <td style={{ padding: "12px", textAlign: "right", fontSize: "11px", color: "#888", textTransform: "capitalize" }}>{c.type}</td>
                    <td style={{ padding: "12px", textAlign: "right", fontFamily: "'DM Mono',monospace", fontSize: "12px", color: overLimit ? "#C62828" : "#333" }}>
                      {fmt(exp)}{overLimit && <span style={{ color: "#C62828", fontWeight: 700, marginLeft: "4px" }}>⚠️</span>}
                    </td>
                    <td style={{ padding: "12px", textAlign: "right", fontFamily: "'DM Mono',monospace", fontSize: "12px" }}>
                      {editId === c.name ? (
                        <input
                          autoFocus
                          type="number"
                          value={editVal}
                          onChange={(e) => setEditVal(e.target.value)}
                          onBlur={() => handleSaveLimit(c.name, editVal)}
                          onKeyDown={(e) => e.key === "Enter" && handleSaveLimit(c.name, editVal)}
                          style={{ width: "120px", padding: "6px 8px", border: "1.5px solid #1565C0", borderRadius: "4px", fontSize: "12px" }}
                        />
                      ) : limit > 0 ? (
                        <span onClick={() => { setEditId(c.name); setEditVal(limit); }} style={{ cursor: "pointer", color: "#1565C0", textDecoration: "underline" }}>
                          {fmt(limit)}
                        </span>
                      ) : (
                        <span onClick={() => { setEditId(c.name); setEditVal(""); }} style={{ cursor: "pointer", color: "#E65100", fontStyle: "italic" }}>
                          Set limit
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "12px", textAlign: "right", fontFamily: "'DM Mono',monospace", fontSize: "12px", color: overLimit ? "#C62828" : avail > 0 ? "#2E7D32" : "#999" }}>
                      {limit > 0 ? fmt(avail) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function UserAdmin() {
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(null);
  const [tab, setTab] = useState("users");
  const [settings, setSettings] = useState({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("user_profiles").select("*").eq("id", user.id).single();
        setCurrentUser(profile);
      }
      const { data } = await supabase.from("user_profiles").select("*").order("created_at", { ascending: true });
      setUsers(data || []);
      const { data: sdata } = await supabase.from("admin_settings").select("*");
      if (sdata) { const s = {}; sdata.forEach(r => { s[r.key] = r.value }); setSettings(s); }
      setSettingsLoaded(true);
      setLoaded(true);
    })();
  }, []);

  const updateRole = async (userId, newRole) => {
    setSaving(userId);
    const { error } = await supabase.rpc("update_user_role", { target_user_id: userId, new_role: newRole });
    if (error) { alert("Failed: " + error.message); setSaving(null); return; }
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u));
    setSaving(null);
  };

  const saveSetting = async (key, value) => {
    await supabase.from("admin_settings").upsert({ key, value, updated_at: new Date().toISOString() });
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const isAdmin = currentUser?.role === "admin";

  if (!loaded) return <div style={{ padding: "40px", textAlign: "center", color: "#aaa" }}>Loading...</div>;

  if (!isAdmin) return (
    <div style={{ padding: "60px 20px", textAlign: "center" }}>
      <div style={{ fontSize: "36px", marginBottom: "12px" }}>🔒</div>
      <div style={{ fontSize: "16px", fontWeight: 600, color: "#999" }}>Admin access required</div>
      <div style={{ fontSize: "13px", color: "#bbb", marginTop: "6px" }}>Only administrators can view and manage users.</div>
    </div>
  );

  return (
    <div style={{ padding: "20px 16px" }}>
      <h1 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "4px" }}>Team Members</h1>
      <p style={{ fontSize: "13px", color: "#999", marginBottom: "20px" }}>
        {isAdmin ? "Manage roles for your team. Users are created in Supabase Authentication." : "View team members and their roles."}
      </p>

      {/* Tabs */}
      {isAdmin && (
        <div style={{ display: "flex", gap: "4px", marginBottom: "20px" }}>
          <button onClick={() => setTab("users")} style={{ padding: "8px 16px", borderRadius: "6px", border: "1.5px solid " + (tab === "users" ? "#1a1a1a" : "#e0e0e0"), background: tab === "users" ? "#1a1a1a" : "#fff", color: tab === "users" ? "#fff" : "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Users</button>
          <button onClick={() => setTab("settings")} style={{ padding: "8px 16px", borderRadius: "6px", border: "1.5px solid " + (tab === "settings" ? "#1a1a1a" : "#e0e0e0"), background: tab === "settings" ? "#1a1a1a" : "#fff", color: tab === "settings" ? "#fff" : "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Settings</button>
        </div>
      )}

      {/* Settings tab */}
      {tab === "settings" && isAdmin && (
        <>
        <div style={{ marginBottom: "24px" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 700, marginBottom: "14px" }}>Batch Delivery Thresholds</h3>
          <p style={{ fontSize: "12px", color: "#888", marginBottom: "14px" }}>When a new order exceeds these thresholds, the system will suggest enabling batch delivery tracking.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", maxWidth: "400px" }}>
            <div>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase" }}>Unit Threshold</label>
              <input type="number" value={settings.batch_delivery_unit_threshold || "20"} onChange={e => saveSetting("batch_delivery_unit_threshold", e.target.value)} style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa" }} />
              <div style={{ fontSize: "11px", color: "#bbb", marginTop: "4px" }}>Suggest if units exceed this</div>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase" }}>Value Threshold (KES)</label>
              <input type="number" value={settings.batch_delivery_value_threshold || "500000"} onChange={e => saveSetting("batch_delivery_value_threshold", e.target.value)} style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa" }} />
              <div style={{ fontSize: "11px", color: "#bbb", marginTop: "4px" }}>Suggest if value exceeds this</div>
            </div>
          </div>
        </div>
        <ClientCreditLimits />
        </>
      )}

      {tab === "users" && <>
      {/* Role legend */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px" }}>
        {ROLES.map(r => (
          <div key={r.id} style={{ padding: "6px 12px", borderRadius: "6px", background: "#fff", border: "1px solid #e8e8e5", fontSize: "11px" }}>
            <span style={{ fontWeight: 700, color: ROLE_COLORS[r.id] }}>{r.label}</span>
            <span style={{ color: "#999", marginLeft: "6px" }}>{r.desc}</span>
          </div>
        ))}
      </div>

      {/* User list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {users.map(u => {
          const isSelf = currentUser?.id === u.id;
          return (
            <div key={u.id} style={{
              background: "#fff", borderRadius: "8px", border: "1px solid #e8e8e5",
              padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px",
              flexWrap: "wrap",
            }}>
              <div style={{
                width: "36px", height: "36px", borderRadius: "50%",
                background: ROLE_COLORS[u.role] || "#ccc", color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "14px", fontWeight: 700, flexShrink: 0,
              }}>
                {(u.display_name || u.email || "?")[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: "140px" }}>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "#1a1a1a" }}>
                  {u.display_name || u.email?.split("@")[0]}
                  {isSelf && <span style={{ fontSize: "10px", color: "#999", marginLeft: "6px" }}>(you)</span>}
                </div>
                <div style={{ fontSize: "12px", color: "#999" }}>{u.email}</div>
              </div>
              {isAdmin && !isSelf ? (
                <select
                  value={u.role}
                  onChange={e => updateRole(u.id, e.target.value)}
                  disabled={saving === u.id}
                  style={{
                    padding: "6px 10px", borderRadius: "6px", border: "1.5px solid #e0e0e0",
                    fontSize: "13px", background: "#fafafa", color: ROLE_COLORS[u.role],
                    fontWeight: 600, cursor: "pointer",
                  }}
                >
                  {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              ) : (
                <span style={{
                  padding: "4px 10px", borderRadius: "4px", fontSize: "11px",
                  fontWeight: 700, color: ROLE_COLORS[u.role],
                  background: `${ROLE_COLORS[u.role]}15`, border: `1px solid ${ROLE_COLORS[u.role]}30`,
                }}>
                  {ROLES.find(r => r.id === u.role)?.label || u.role}
                </span>
              )}
            </div>
          );
        })}
      </div>

      </>}

      {isAdmin && tab === "users" && (
        <div style={{ marginTop: "24px", padding: "14px 16px", background: "#FFFDE7", borderRadius: "8px", border: "1px solid #FFD54F", fontSize: "12px", color: "#666" }}>
          To add new team members, go to <strong>Supabase Dashboard → Authentication → Users → Add User</strong>. They will appear here automatically after their first login.
        </div>
      )}
    </div>
  );
}
