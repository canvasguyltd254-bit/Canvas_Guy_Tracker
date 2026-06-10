"use client";
import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/shared/supabase/client";
import * as modules from "@/modules/registry";

const moduleList = Object.values(modules);

export default function AppShell({ children }) {
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userRole, setUserRole] = useState("viewer");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      setUser(data.user);
      if (data.user) {
        const { data: profile } = await supabase.from("user_profiles").select("role").eq("id", data.user.id).single();
        if (profile) setUserRole(profile.role);
      }
    });
  }, []);

  useEffect(() => { setMobileMenuOpen(false); }, [pathname]);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f5" }}>
      {/* Top bar — compact */}
      <header style={{
        background: "#1a1a1a", color: "#fff", padding: "0 16px",
        height: "56px", display: "flex", alignItems: "center",
        justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {/* Hamburger — mobile */}
          <button className="mobile-burger" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} style={{
            background: "none", border: "none", color: "#fff", fontSize: "20px",
            cursor: "pointer", padding: "4px", display: "flex",
          }}>
            {mobileMenuOpen ? "✕" : "☰"}
          </button>
          <Link href="/" style={{ textDecoration: "none", color: "#fff" }}>
            <span style={{ fontWeight: 800, fontSize: "16px", letterSpacing: "-0.3px" }}>CANVAS GUY</span>
            <span style={{ color: "#E8512A", fontSize: "10px", marginLeft: "8px", fontFamily: "'DM Mono', monospace", fontWeight: 600, letterSpacing: "2px" }}>TRACKER</span>
          </Link>
        </div>

        {/* Desktop nav */}
        <nav className="desktop-nav" style={{ display: "flex", gap: "4px", alignItems: "center" }}>
          {moduleList.filter(mod => mod.id !== "admin" || userRole === "admin").map((mod) =>
            mod.navItems.map((item) => {
              const active = pathname.startsWith(item.path);
              return (
                <Link key={item.path} href={item.path} style={{
                  padding: "6px 14px", borderRadius: "6px",
                  background: active ? "#333" : "transparent",
                  color: active ? "#fff" : "#999",
                  textDecoration: "none", fontSize: "13px", fontWeight: 500,
                  transition: "all 0.15s",
                }}>
                  <span style={{ marginRight: "6px" }}>{mod.icon}</span>
                  <span className="nav-label">{item.label}</span>
                </Link>
              );
            })
          )}
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {user && (
            <span className="user-email" style={{ fontSize: "11px", color: "#888", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {user.email}
            </span>
          )}
          <button onClick={handleLogout} style={{
            padding: "5px 12px", borderRadius: "5px", border: "1px solid #444",
            background: "transparent", color: "#999", fontSize: "11px", cursor: "pointer",
            fontWeight: 500,
          }}>Sign Out</button>
        </div>
      </header>

      {/* Mobile dropdown menu */}
      {mobileMenuOpen && (
        <div style={{
          position: "fixed", top: "52px", left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.5)", zIndex: 99,
        }} onClick={() => setMobileMenuOpen(false)}>
          <div style={{
            background: "#1a1a1a", padding: "12px",
            borderBottom: "1px solid #333",
          }} onClick={e => e.stopPropagation()}>
            {moduleList.filter(mod => mod.id !== "admin" || userRole === "admin").map((mod) =>
              mod.navItems.map((item) => {
                const active = pathname.startsWith(item.path);
                return (
                  <Link key={item.path} href={item.path} style={{
                    display: "flex", alignItems: "center", gap: "10px",
                    padding: "12px 16px", borderRadius: "6px", marginBottom: "4px",
                    background: active ? "#333" : "transparent",
                    color: active ? "#fff" : "#999",
                    textDecoration: "none", fontSize: "15px", fontWeight: 500,
                  }}>
                    <span>{mod.icon}</span> <span>{item.label}</span>
                  </Link>
                );
              })
            )}
            {user && (
              <div style={{ padding: "12px 16px", fontSize: "12px", color: "#666", borderTop: "1px solid #333", marginTop: "8px" }}>
                {user.email}
              </div>
            )}
            <button onClick={handleLogout} style={{
              display: "block", width: "calc(100% - 16px)", margin: "8px 8px 12px",
              padding: "10px", borderRadius: "6px", border: "1px solid #444",
              background: "transparent", color: "#999", fontSize: "14px",
              cursor: "pointer", textAlign: "center",
            }}>Sign Out</button>
          </div>
        </div>
      )}

      {/* Main content */}
      <main style={{ maxWidth: "1200px", margin: "0 auto", minHeight: "calc(100vh - 52px)" }}>
        {children}
      </main>

      <style>{`
        @media (max-width: 640px) {
          .user-email { display: none !important; }
          .nav-label { display: none !important; }
        }
      `}</style>
    </div>
  );
}
