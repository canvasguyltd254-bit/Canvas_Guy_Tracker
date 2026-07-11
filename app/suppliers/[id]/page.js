"use client";
import AppShell from "@/shared/ui/AppShell";
import SupplierProfile from "@/modules/suppliers/components/SupplierProfile";

export default function SupplierProfilePage({ params }) {
  return (
    <AppShell>
      <SupplierProfile supplierId={params.id} />
    </AppShell>
  );
}
