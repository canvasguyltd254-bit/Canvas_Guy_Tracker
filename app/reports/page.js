"use client";
import { Suspense } from "react";
import AppShell from "@/shared/ui/AppShell";
import Reports from "@/modules/reports/components/Reports";

function ReportsContent() {
  return <Reports />;
}

export default function ReportsPage() {
  return (
    <AppShell>
      <Suspense fallback={<div style={{ padding: "40px", textAlign: "center", color: "#aaa" }}>Loading...</div>}>
        <ReportsContent />
      </Suspense>
    </AppShell>
  );
}
