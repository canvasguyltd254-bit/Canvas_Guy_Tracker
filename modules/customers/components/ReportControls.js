"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { C, Btn, Modal, Notice, TInput, Field } from "@/shared/ui/ds";
import {
  PERIOD_PRESETS, presetRange, matchPreset, describePeriod, validateRange,
  searchCustomers, customerOptionLabel,
} from "@/shared/lib/customerReport";

// ── Searchable customer picker ───────────────────────────────────────────────
// A combobox: type to filter by name, contact, phone or email; arrow keys and
// Enter to choose; Escape to close. Selection is by customer id, so two records
// with the same name stay distinct (the option shows the phone to tell them apart).
export function CustomerPicker({ customers, value, onChange, allLabel = "All customers" }) {
  const listId   = useId();
  const wrapRef  = useRef(null);
  const [query, setQuery]   = useState("");
  const [open, setOpen]     = useState(false);
  const [active, setActive] = useState(0);

  const selected = useMemo(() => (customers || []).find(c => c.id === value) || null, [customers, value]);
  const matches  = useMemo(() => searchCustomers(customers, query), [customers, query]);
  // Row 0 is always "All customers"; the matches follow.
  const options  = useMemo(() => [{ id: null, label: allLabel }, ...matches.map(c => ({ id: c.id, label: customerOptionLabel(c), customer: c }))], [matches, allLabel]);

  useEffect(() => { setActive(0); }, [query, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() { setOpen(false); setQuery(""); }
  function choose(opt) { onChange(opt.id); close(); }

  const inputText = open ? query : (selected ? selected.name : "");

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: "1 1 260px", minWidth: 200 }}>
      <TInput
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Customer"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        placeholder={allLabel}
        value={inputText}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, options.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && open) { e.preventDefault(); if (options[active]) choose(options[active]); }
          else if (e.key === "Escape") { e.preventDefault(); close(); }
        }}
        style={{ paddingRight: selected ? 34 : undefined }}
      />
      {selected && !open && (
        <button
          type="button"
          aria-label="Clear customer filter"
          onClick={() => onChange(null)}
          style={{
            position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
            border: "none", background: "transparent", color: C.muted, cursor: "pointer",
            fontSize: 16, lineHeight: 1, padding: "4px 6px", fontFamily: "inherit",
          }}
        >
          ×
        </button>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          style={{
            position: "absolute", zIndex: 30, left: 0, right: 0, top: "calc(100% + 4px)",
            margin: 0, padding: 4, listStyle: "none", maxHeight: 280, overflowY: "auto",
            background: C.card, border: `1px solid ${C.line}`, borderRadius: C.radiusSm,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          }}
        >
          {options.map((opt, i) => {
            const isSel = opt.id === value;
            return (
              <li
                key={opt.id ?? "__all"}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={isSel}
                onMouseDown={e => e.preventDefault()}
                onClick={() => choose(opt)}
                onMouseEnter={() => setActive(i)}
                style={{
                  padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 13,
                  background: i === active ? C.bg : "transparent",
                  fontWeight: isSel ? 700 : 400, color: C.ink,
                }}
              >
                {opt.customer ? (
                  <>
                    <span>{opt.customer.name}</span>
                    {opt.customer.phone && <span style={{ color: C.muted, marginLeft: 8, fontSize: 12 }}>{opt.customer.phone}</span>}
                  </>
                ) : opt.label}
              </li>
            );
          })}
          {matches.length === 0 && (
            <li role="presentation" style={{ padding: "8px 10px", color: C.muted, fontSize: 12.5 }}>
              No customers match “{query}”.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ── Date range modal ─────────────────────────────────────────────────────────
export function PeriodModal({ range, today, onApply, onClose }) {
  const [from, setFrom] = useState(range.from || "");
  const [to, setTo]     = useState(range.to || "");
  const [error, setError] = useState("");

  const current = { from: from || null, to: to || null };
  const preset  = matchPreset(current, today);

  const pick = key => {
    const r = presetRange(key, today);
    setFrom(r.from || ""); setTo(r.to || ""); setError("");
  };

  const apply = () => {
    const err = validateRange(current);
    if (err) { setError(err); return; }
    onApply(current);
  };

  return (
    <Modal
      title="Report period"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary onClick={apply}>Apply period</Btn>
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
        {PERIOD_PRESETS.map(p => {
          const on = preset === p.key;
          return (
            <button
              key={p.key}
              type="button"
              aria-pressed={on}
              onClick={() => pick(p.key)}
              style={{
                border: `1px solid ${on ? C.coral : C.line}`,
                background: on ? C.coral : C.card,
                color: on ? "#fff" : C.ink,
                borderRadius: 20, padding: "7px 14px", minHeight: 36,
                fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="form-grid">
        <Field label="From">
          <TInput type="date" value={from} max={to || undefined}
            onChange={e => { setFrom(e.target.value); setError(""); }} />
        </Field>
        <Field label="To">
          <TInput type="date" value={to} min={from || undefined}
            onChange={e => { setTo(e.target.value); setError(""); }} />
        </Field>
      </div>

      <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
        Showing orders dated <strong style={{ color: C.ink }}>{describePeriod(current)}</strong>
        {preset === "custom" ? " (custom range)" : ""}.
      </div>

      {error && <Notice color="red" style={{ marginTop: 14 }}>{error}</Notice>}
    </Modal>
  );
}
