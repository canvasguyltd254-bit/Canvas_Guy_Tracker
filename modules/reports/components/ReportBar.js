"use client";
import { useState } from "react";
import { C, Btn } from "@/shared/ui/ds";
import { describePeriod, matchPreset, PERIOD_PRESETS } from "@/shared/lib/customerReport";
import { PeriodModal } from "@/modules/customers/components/ReportControls";

// The row of controls above a report: period button (opens the shared period
// modal), plus whatever filters the report passes in as children.
export function PeriodButton({ range, today, onChange, subject, title }) {
  const [open, setOpen] = useState(false);
  const preset = matchPreset(range, today);
  const label = preset === "custom" ? "Custom range" : (PERIOD_PRESETS.find(p => p.key === preset)?.label || "Custom range");
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        style={{
          display: "inline-flex", alignItems: "center", gap: 10, minHeight: 38,
          background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radiusSm,
          padding: "6px 12px", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".05em" }}>Period</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{label}</span>
        <span style={{ fontSize: 12, color: C.muted }}>{describePeriod(range)}</span>
        <span aria-hidden="true" style={{ color: C.muted, fontSize: 11 }}>▾</span>
      </button>
      {open && (
        <PeriodModal
          range={range}
          today={today}
          subject={subject}
          title={title}
          onClose={() => setOpen(false)}
          onApply={r => { onChange(r); setOpen(false); }}
        />
      )}
    </>
  );
}

export function ExportButtons({ onPdf, onCsv, busy, disabled }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {onCsv && <Btn onClick={onCsv} disabled={disabled || busy}>Export CSV</Btn>}
      {onPdf && <Btn primary onClick={onPdf} disabled={disabled || busy}>{busy ? "Generating…" : "Download PDF"}</Btn>}
    </div>
  );
}

export function Segmented({ value, options, onChange, label }) {
  return (
    <div role="group" aria-label={label} style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: C.radiusSm, overflow: "hidden", background: C.card }}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            style={{
              border: "none", padding: "8px 14px", minHeight: 38, fontSize: 12.5, fontWeight: 700,
              cursor: o.disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
              background: on ? C.ink : "transparent", color: on ? "#fff" : o.disabled ? C.faint : C.ink,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
