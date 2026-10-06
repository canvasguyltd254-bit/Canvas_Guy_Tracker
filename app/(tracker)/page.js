"use client";

import { useState, useEffect } from "react";
import Link                    from "next/link";
import { useAuth }             from "@/shared/context/AuthContext";
import {
  C, StatCard, Panel, PanelHead, Badge, Empty, Loading, MetricBar, Btn, fmtKes,
} from "@/shared/ui/ds";

// ─── Greeting ─────────────────────────────────────────────────────────────────
function greetingFor(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const CHIP_COLOR = { red: "red", amber: "amber", blue: "blue", green: "green" };

// ─── Needs-attention row ──────────────────────────────────────────────────────
function QueueRow({ item }) {
  return (
    <Link href={item.source.path} style={{ textDecoration: "none", color: "inherit" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "13px 18px", borderTop: `1px solid ${C.line}`,
          cursor: "pointer",
        }}
        onMouseEnter={e => { e.currentTarget.style.background = C.bg; }}
        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>{item.title}</div>
          <div style={{
            fontSize: 12, color: C.muted, marginTop: 2,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {item.subtitle}
          </div>
        </div>
        <Badge color={CHIP_COLOR[item.chip.tone] || "gray"} style={{ flexShrink: 0 }}>
          {item.chip.label}
        </Badge>
      </div>
    </Link>
  );
}

// ─── Production floor card ────────────────────────────────────────────────────
function FloorRow({ job }) {
  const label = `${job.jobNum} · ${job.description || job.category || "Job"}`;
  const value = job.blocked ? "Blocked" : `${job.acceptedQty}/${job.plannedQuantity}`;
  return (
    <div style={{ padding: "0 18px" }}>
      <MetricBar
        label={label}
        value={value}
        pct={job.blocked ? 6 : job.pct}
        style={{
          paddingTop: 12, paddingBottom: 12,
          borderTop: `1px solid ${C.line}`,
          marginBottom: 0,
        }}
      />
    </div>
  );
}

export default function HomeDashboard() {
  const { userRole, displayName, loaded } = useAuth();
  const [summary,    setSummary]    = useState(null);
  const [priorities, setPriorities] = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [showAllQueue, setShowAllQueue] = useState(false);

  useEffect(() => {
    if (!loaded || !userRole) return;
    Promise.all([
      fetch("/api/home/summary").then(r => r.json()),
      fetch("/api/home/priorities").then(r => r.json()),
    ])
      .then(([summaryRes, prioritiesRes]) => {
        if (summaryRes.success)    setSummary(summaryRes.data);
        if (prioritiesRes.success) setPriorities(prioritiesRes.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [loaded, userRole]);

  if (loading || !userRole) {
    return (
      <div style={{ padding: "24px 20px 40px" }}>
        <Loading />
      </div>
    );
  }

  const customers  = summary?.customers;
  const production = summary?.production;
  const cashflow   = summary?.cashflow; // always present: { connected: false, reason }

  const queue = priorities?.queue || [];
  const floor = priorities?.floor || [];
  const visibleQueue = showAllQueue ? queue : queue.slice(0, 4);

  return (
    <div style={{ padding: "24px 20px 40px" }}>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: C.ink, letterSpacing: "-0.3px" }}>
          {greetingFor()}{displayName ? `, ${displayName}` : ""}
        </h1>
        <p style={{ margin: "5px 0 0", color: C.muted, fontSize: 13 }}>
          Here is what needs attention today.
        </p>
      </div>

      {/* ── KPI cards ─────────────────────────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 14, marginBottom: 20,
      }}>
        {customers && (
          <StatCard
            label="Collections due"
            value={fmtKes(customers.overdueAmount)}
            sub={`${customers.overdue} overdue · ${customers.dueThisWeek} due this week`}
            alert={customers.overdue > 0}
          />
        )}
        {production && (
          <StatCard
            label="Production active"
            value={`${production.in_production} order${production.in_production === 1 ? "" : "s"}`}
            sub={
              `${production.unitsInProduction} units moving · ${production.unitsAwaitingQc} awaiting QC` +
              (production.jobsBlocked > 0 ? ` · ${production.jobsBlocked} blocked` : "")
            }
            alert={production.jobsBlocked > 0}
          />
        )}
        {/* Cashflow — real Stage 2 forecast when the caller has access and the
            engine ran cleanly; otherwise honestly "not connected" rather than
            a fabricated number (see /api/home/summary's cashflow section). */}
        {cashflow?.connected ? (
          <>
            <StatCard
              label="Payments planned"
              value={fmtKes(cashflow.thisWeekPlanned)}
              sub={
                cashflow.shortfallWeeks > 0
                  ? `This week · ${cashflow.shortfallWeeks} shortfall week${cashflow.shortfallWeeks === 1 ? "" : "s"} ahead`
                  : "This week · no shortfalls ahead"
              }
              alert={cashflow.shortfallWeeks > 0}
            />
            <StatCard
              label="Available cash"
              value={fmtKes(cashflow.openingCash)}
              sub={cashflow.isProvisional ? "As of today · provisional (review required)" : "As of today"}
              alert={cashflow.isProvisional}
            />
          </>
        ) : (
          <>
            <StatCard
              label="Payments planned"
              value="Not connected"
              sub={cashflow?.reason || "Cashflow forecast is not wired up yet"}
            />
            <StatCard
              label="Available cash"
              value="Not connected"
              sub={cashflow?.reason || "Cashflow forecast is not wired up yet"}
            />
          </>
        )}
      </div>

      {/* ── Needs your attention ─────────────────────────────────────────── */}
      <Panel>
        <PanelHead
          title="Needs your attention"
          sub="One queue, drawn from every module"
          actions={queue.length > 4 && (
            <Btn small onClick={() => setShowAllQueue(v => !v)}>
              {showAllQueue ? "Show fewer" : `View all ${queue.length}`}
            </Btn>
          )}
        />
        {visibleQueue.length === 0
          ? <Empty message="Nothing needs your attention right now." />
          : visibleQueue.map(item => <QueueRow key={`${item.type}-${item.id}`} item={item} />)}
      </Panel>

      {/* ── Production floor ─────────────────────────────────────────────── */}
      {production && (
        <Panel>
          <PanelHead
            title="Production floor"
            sub="Jobs currently in motion"
            actions={
              <Link href="/production" style={{ textDecoration: "none" }}>
                <Btn small>Open production</Btn>
              </Link>
            }
          />
          {floor.length === 0
            ? <Empty message="No active jobs on the floor right now." />
            : (
              <div style={{ paddingBottom: 12 }}>
                {floor.map(job => <FloorRow key={job.jobId} job={job} />)}
              </div>
            )}
        </Panel>
      )}
    </div>
  );
}
