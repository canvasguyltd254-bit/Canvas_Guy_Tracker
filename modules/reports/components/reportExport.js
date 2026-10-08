// Browser-side helpers shared by the Reports components: file download, PDF
// export through /api/reports/pdf, and CSV export. Errors are thrown so the
// caller can show them inline instead of a blocking alert().
import { toCsv } from "@/shared/lib/reports/csv";

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const slug = s => String(s || "Report").trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Report";

export async function exportPdf(payload, filename) {
  const res = await fetch("/api/reports/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.detail || err.error || "PDF generation failed");
  }
  downloadBlob(filename, await res.blob());
}

export function exportCsv(columns, rows, filename) {
  downloadBlob(filename, new Blob([toCsv(columns, rows)], { type: "text/csv;charset=utf-8" }));
}
