"use client";
import { useState, useCallback } from "react";

// Sort state: click a header to sort ascending, again for descending.
export function useSort(initial = { field: null, dir: "asc" }) {
  const [sort, setSort] = useState(initial);
  const toggle = useCallback(field => {
    setSort(s => (s.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" }));
  }, []);
  return { sort, setSort, toggle };
}

// A sortable <th>. Keyboard-operable (a real button) with aria-sort.
export function SortTh({ field, sort, onSort, children, right, style }) {
  const active = sort.field === field;
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      style={{ padding: "10px 12px", textAlign: right ? "right" : "left", fontWeight: 600, ...style }}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        style={{
          all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4,
          textTransform: "inherit", letterSpacing: "inherit", fontWeight: "inherit",
        }}
      >
        {children}
        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.4, fontSize: 10 }}>{active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
      </button>
    </th>
  );
}
