"use client";
import { useState } from "react";
import { createClient } from "@/shared/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const supabase = createClient();

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      window.location.href = "/orders";
    }
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#1a1a1a", padding: "20px",
    }}>
      <div style={{
        background: "#fff", borderRadius: "12px", padding: "40px",
        width: "100%", maxWidth: "400px", boxShadow: "0 8px 40px rgba(0,0,0,0.3)",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{
            fontSize: "11px", fontWeight: 600, letterSpacing: "2px",
            textTransform: "uppercase", color: "#999", marginBottom: "4px",
            fontFamily: "'DM Mono', monospace",
          }}>
            PRODUCTION TRACKER
          </div>
          <div style={{ fontSize: "22px", fontWeight: 700, color: "#1a1a1a" }}>
            Canvas Guy Limited
          </div>
        </div>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: "16px" }}>
            <label style={{
              display: "block", fontSize: "11px", fontWeight: 600, color: "#888",
              marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px",
            }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@canvasguy.co.ke"
              style={{
                width: "100%", padding: "12px 14px", border: "1.5px solid #e0e0e0",
                borderRadius: "8px", fontSize: "14px", outline: "none",
                background: "#fafafa",
              }}
            />
          </div>

          <div style={{ marginBottom: "24px" }}>
            <label style={{
              display: "block", fontSize: "11px", fontWeight: 600, color: "#888",
              marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px",
            }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              style={{
                width: "100%", padding: "12px 14px", border: "1.5px solid #e0e0e0",
                borderRadius: "8px", fontSize: "14px", outline: "none",
                background: "#fafafa",
              }}
            />
          </div>

          {error && (
            <div style={{
              padding: "10px 14px", borderRadius: "8px", marginBottom: "16px",
              background: "#FFF0F0", color: "#C62828", fontSize: "13px",
              border: "1px solid #FFCDD2",
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%", padding: "12px", borderRadius: "8px", border: "none",
              background: loading ? "#ccc" : "#E8512A", color: "#fff",
              fontSize: "14px", fontWeight: 700, cursor: loading ? "wait" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p style={{
          textAlign: "center", marginTop: "24px", fontSize: "12px", color: "#bbb",
        }}>
          Contact admin to get your account set up
        </p>
      </div>
    </div>
  );
}
