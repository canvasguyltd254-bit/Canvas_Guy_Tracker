"use client";

import { useState, useEffect }  from "react";
import { useRouter }            from "next/navigation";
import Link                     from "next/link";
import { createClient }         from "@/shared/supabase/client";
import AppShell                 from "@/shared/ui/AppShell";
import * as modules             from "@/modules/registry";

const moduleList = Object.values(modules);

// Badge labels and colours per module key
const BADGE_CONFIG = {
  orders:     { key: "active",       label: "active",    color: "#1a1a1a" },
  production: { key: "in_production",label: "active",    color: "#7C3AED" },
  customers:  { key: "overdue",      label: "overdue",   color: "#DC2626" },
  suppliers:  { key: "unmatched",    label: "unmatched", color: "#D97706" },
  contacts:   { key: "total",        label: "contacts",  color: "#0369A1" },
  accounting: { key: "unposted",     label: "unposted",  color: "#DC2626" },
  admin:      { key: "total_users",  label: "users",     color: "#1a1a1a" },
};

// Icon backgrounds per module
const MODULE_BG = {
  dashboard:  "#FFF7ED",
  orders:     "#F0FDF4",
  production: "#FAF5FF",
  reports:    "#EFF6FF",
  customers:  "#FFF1F2",
  contacts:   "#F0F9FF",
  suppliers:  "#FEFCE8",
  accounting: "#F7FEE7",
  admin:      "#F9FAFB",
};

function ModuleCard({ mod, counts }) {
  const badge  = BADGE_CONFIG[mod.id];
  const count  = badge && counts ? counts[mod.id]?.[badge.key] : undefined;
  const path   = mod.navItems[0]?.path;

  return (
    <Link href={path} style={{ textDecoration: "none", display: "flex", flexDirection: "column" }}>
      <div style={{
        background: "#fff",
        border: "1.5px solid #E0DDD8",
        borderRadius: "12px",
        padding: "20px",
        transition: "box-shadow 0.15s, transform 0.15s",
        cursor: "pointer",
        position: "relative",
        minHeight: "120px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
        onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
        onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "none"; }}
      >
        {/* Module icon — standalone, no badge alongside */}
        <div style={{
          width: "44px", height: "44px", borderRadius: "10px", flexShrink: 0,
          background: MODULE_BG[mod.id] || "#F3F4F6",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "22px",
        }}>
          {mod.icon}
        </div>

        {/* Name + inline badge chip + description */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap", marginBottom: "4px" }}>
            <span style={{ fontSize: "15px", fontWeight: 700, color: "#1a1a1a" }}>
              {mod.name}
            </span>
            {typeof count === "number" && count > 0 && badge && (
              <span style={{
                fontSize: "11px", fontWeight: 600,
                color: badge.color,
                // Use module icon tint for coloured badges; neutral for dark-text badges
                background: badge.color === "#1a1a1a" ? "#f0f0ee" : (MODULE_BG[mod.id] || "#f0f0ee"),
                padding: "1px 7px", borderRadius: "10px",
                fontFamily: "'DM Mono', monospace",
                letterSpacing: "0.2px",
                lineHeight: "1.6",
                whiteSpace: "nowrap",
              }}>
                {count} {badge.label}
              </span>
            )}
          </div>
          <div style={{ fontSize: "12px", color: "#888", lineHeight: 1.4 }}>
            {mod.description}
          </div>
        </div>

        {/* Arrow */}
        <div style={{
          position: "absolute", bottom: "18px", right: "18px",
          fontSize: "14px", color: "#CCC",
        }}>
          →
        </div>
      </div>
    </Link>
  );
}

export default function ModulesHome() {
  const router = useRouter();
  const [userRole, setUserRole] = useState(null);
  const [counts,   setCounts]   = useState(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { router.replace("/login"); return; }

      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("id", data.user.id)
        .single();

      setUserRole(profile?.role || "viewer");
    });
  }, []);

  useEffect(() => {
    if (!userRole) return;
    fetch("/api/home/summary")
      .then(r => r.json())
      .then(j => { if (j.success) setCounts(j.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userRole]);

  // Accounting is hidden until the module is fully built
  const HIDDEN_ON_HOME = new Set(['accounting']);
  const visibleModules = userRole
    ? moduleList.filter(mod => mod.allowedRoles?.includes(userRole) && !HIDDEN_ON_HOME.has(mod.id))
    : [];

  return (
    <AppShell>
      <div style={{ padding: "24px 20px 40px" }}>
        {/* Page header */}
        <div style={{ marginBottom: "28px" }}>
          <h1 style={{
            fontSize: "22px", fontWeight: 800, color: "#1a1a1a",
            margin: 0, letterSpacing: "-0.3px",
          }}>
            Home
          </h1>
          <p style={{ fontSize: "13px", color: "#888", margin: "4px 0 0" }}>
            {userRole
              ? `You have access to ${visibleModules.length} module${visibleModules.length !== 1 ? "s" : ""}.`
              : "Loading…"}
          </p>
        </div>

        {/* Module grid */}
        {loading || !userRole ? (
          <div className="module-grid">
            {[...Array(6)].map((_, i) => (
              <div key={i} style={{
                background: "#fff", border: "1.5px solid #E0DDD8",
                borderRadius: "12px", padding: "20px", minHeight: "120px",
                animation: "pulse 1.4s ease-in-out infinite",
              }} />
            ))}
          </div>
        ) : (
          <div className="module-grid">
            {visibleModules.map(mod => (
              <ModuleCard key={mod.id} mod={mod} counts={counts} />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.5; }
        }
        .module-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 14px;
        }
        @media (max-width: 480px) {
          .module-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </AppShell>
  );
}
