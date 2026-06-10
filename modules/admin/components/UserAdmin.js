"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/shared/supabase/client";

const ROLES = [
  { id: "admin", label: "Admin", desc: "Full access — manage users, orders, and settings" },
  { id: "production_manager", label: "Production Manager", desc: "Manage orders, assign work, update statuses" },
  { id: "sales", label: "Sales", desc: "Create orders, manage quotes, payments, and advance up to Deposit Paid" },
  { id: "production_staff", label: "Production Staff", desc: "View orders, update assigned work" },
  { id: "viewer", label: "Viewer", desc: "Read-only access to all orders" },
];

const ROLE_COLORS = {
  admin: "#C62828", production_manager: "#E65100",
  sales: "#1565C0", production_staff: "#2E7D32", viewer: "#9E9E9E",
};

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
