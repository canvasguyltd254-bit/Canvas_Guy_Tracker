"use client";
import { Suspense } from "react";
import Reports from "@/modules/reports/components/Reports";

export default function ReportsPage() {
  return (
    <Suspense fallback={<div style={{ padding: "40px", textAlign: "center", color: "#aaa" }}>Loading...</div>}>
      <Reports />
    </Suspense>
  );
}
