"use client";
import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/shared/supabase/client";
import * as modules from "@/modules/registry";
import { useAuth } from "@/shared/context/AuthContext";

const moduleList = Object.values(modules);
// NOTE: modules without an allowedRoles array are hidden for ALL roles.
// Every module config MUST declare allowedRoles to appear in nav and on Home.

export default function AppShell({ children }) {
  const pathname = usePathname();
  const router   = useRouter();

  // Auth comes from context — fetched once in AuthProvider (app/layout.js),
  // not re-fetched on every AppShell mount. This eliminates the nav-bar flash
  // and the two Supabase round-trips that previously happened on every navigation.
  const { user, userRole, displayName, loaded } = useAuth();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [moreOpen,       setMoreOpen]       = useState(false);

  // Prefetch all permitted module routes as soon as auth resolves.
  // This loads the JS chunk for each page in the background so the first
  // click into any module is near-instant rather than waiting for the chunk.
  useEffect(() => {
    if (!loaded) return;
    moduleList
      .filter(mod => mod.allowedRoles?.includes(userRole))
      .forEach(mod => mod.navItems?.forEach(item => router.prefetch(item.path)));
  }, [loaded, userRole]);

  useEffect(() => { setMobileMenuOpen(false); setMoreOpen(false); }, [pathname]);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  // Nav layout: Modules home + 3 primary links + More dropdown for the rest
  const PRIMARY_MODULE_IDS = ['dashboard', 'orders', 'production'];
  const accessibleModules = moduleList.filter(mod => mod.allowedRoles?.includes(userRole));
  const primaryModules    = accessibleModules.filter(mod => PRIMARY_MODULE_IDS.includes(mod.id));
  const moreModules       = accessibleModules.filter(mod => !PRIMARY_MODULE_IDS.includes(mod.id));
  const moreActive        = moreModules.some(mod => mod.navItems?.some(item => pathname.startsWith(item.path)));

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

        {/* Desktop nav — Modules | Dashboard · Orders · Production | More ▾ */}
        <nav className="desktop-nav" style={{ display: "flex", gap: "2px", alignItems: "center" }}>

          {/* Home / Modules link */}
          <Link href="/" style={{
            padding: "6px 14px", borderRadius: "4px", background: "transparent",
            color: pathname === "/" ? "#fff" : "#999",
            textDecoration: "none", fontSize: "13px",
            fontWeight: pathname === "/" ? 700 : 500,
            borderBottom: pathname === "/" ? "2px solid #E8512A" : "2px solid transparent",
            transition: "all 0.15s",
          }}>
            Modules
          </Link>

          {/* Primary module links */}
          {primaryModules.map((mod) =>
            mod.navItems.map((item) => {
              const active = pathname.startsWith(item.path);
              return (
                <Link key={item.path} href={item.path} style={{
                  padding: "6px 14px", borderRadius: "4px", background: "transparent",
                  color: active ? "#fff" : "#999",
                  textDecoration: "none", fontSize: "13px",
                  fontWeight: active ? 700 : 500,
                  borderBottom: active ? "2px solid #E8512A" : "2px solid transparent",
                  transition: "all 0.15s",
                }}>
                  <span style={{ marginRight: "6px" }}>{mod.icon}</span>
                  <span className="nav-label">{item.label}</span>
                </Link>
              );
            })
          )}

          {/* More ▾ dropdown — remaining permitted modules */}
          {moreModules.length > 0 && (
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setMoreOpen(o => !o)}
                style={{
                  padding: "6px 14px", borderRadius: "4px", background: "transparent",
                  color: (moreOpen || moreActive) ? "#fff" : "#999",
                  border: "none", fontSize: "13px",
                  fontWeight: (moreOpen || moreActive) ? 700 : 500,
                  cursor: "pointer", display: "flex", alignItems: "center", gap: "4px",
                  borderBottom: moreActive ? "2px solid #E8512A" : "2px solid transparent",
                  transition: "all 0.15s",
                }}
              >
                <span className="nav-label">More</span>
                <span style={{ fontSize: "10px", opacity: 0.7, marginLeft: "2px" }}>▾</span>
              </button>

              {moreOpen && (
                <>
                  {/* Invisible backdrop closes dropdown on outside click */}
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 199 }}
                    onClick={() => setMoreOpen(false)}
                  />
                  <div style={{
                    position: "absolute", top: "calc(100% + 6px)", left: "50%",
                    transform: "translateX(-50%)",
                    background: "#252525", border: "1px solid #333",
                    borderRadius: "8px", padding: "6px",
                    minWidth: "176px", zIndex: 200,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  }}>
                    {moreModules.map((mod) =>
                      mod.navItems.map((item) => {
                        const active = pathname.startsWith(item.path);
                        return (
                          <Link key={item.path} href={item.path}
                            style={{
                              display: "flex", alignItems: "center", gap: "10px",
                              padding: "9px 12px", borderRadius: "6px",
                              color: active ? "#fff" : "#bbb",
                              textDecoration: "none", fontSize: "13px",
                              fontWeight: active ? 700 : 400,
                              background: active ? "rgba(232,81,42,0.15)" : "transparent",
                            }}
                            onClick={() => setMoreOpen(false)}
                          >
                            <span>{mod.icon}</span>
                            <span>{item.label}</span>
                          </Link>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {user && (
            <div className="user-info" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{
                width: "30px", height: "30px", borderRadius: "50%",
                background: "#E8512A", color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "12px", fontWeight: 700, flexShrink: 0,
              }}>
                {(displayName || user.email).charAt(0).toUpperCase()}
              </div>
              <div className="user-email" style={{ lineHeight: 1.2 }}>
                <div style={{ fontSize: "11px", color: "#ddd", fontWeight: 600, maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {displayName || user.email.split("@")[0]}
                </div>
                <div style={{ fontSize: "9px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {userRole.replace("_", " ")}
                </div>
              </div>
            </div>
          )}
          <button onClick={handleLogout} style={{
            padding: "5px 12px", borderRadius: "5px", border: "1px solid #555",
            background: "transparent", color: "#ccc", fontSize: "12px", cursor: "pointer",
            fontWeight: 500,
          }}>Sign out</button>
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
            {moduleList.filter(mod => mod.allowedRoles?.includes(userRole)).map((mod) =>
              mod.navItems.map((item) => {
                const active = pathname.startsWith(item.path);
                return (
                  <Link key={item.path} href={item.path} style={{
                    display: "flex", alignItems: "center", gap: "10px",
                    padding: "12px 16px", borderRadius: "6px", marginBottom: "4px",
                    background: active ? "#2a1f1b" : "transparent",
                    borderLeft: active ? "3px solid #E8512A" : "3px solid transparent",
                    color: active ? "#fff" : "#999",
                    textDecoration: "none", fontSize: "15px", fontWeight: active ? 700 : 500,
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
              padding: "10px", borderRadius: "6px", border: "1px solid #555",
              background: "transparent", color: "#ccc", fontSize: "14px",
              cursor: "pointer", textAlign: "center",
            }}>Sign out</button>
          </div>
        </div>
      )}

      {/* Main content */}
      <main style={{ maxWidth: "1200px", margin: "0 auto", minHeight: "calc(100vh - 52px)", paddingBottom: "32px" }}>
        {children}
      </main>

      {/* Trademark — fixed bottom-right */}
      <div style={{
        position: "fixed", bottom: "10px", right: "14px",
        fontSize: "10px", color: "#bbb", letterSpacing: "0.3px",
        pointerEvents: "none", userSelect: "none", zIndex: 50,
        fontFamily: "'DM Mono', 'Courier New', monospace",
      }}>
        © {new Date().getFullYear()} Canvas Guy Limited. All rights reserved.
      </div>

      <style>{`
        @media (max-width: 640px) {
          .user-email { display: none !important; }
          .nav-label { display: none !important; }
        }
      `}</style>
    </div>
  );
}
