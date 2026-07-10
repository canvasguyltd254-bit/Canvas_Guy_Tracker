"use client";
import AppShell from "@/shared/ui/AppShell";
import CustomerProfile from "@/modules/customers/components/CustomerProfile";

export default function CustomerProfilePage({ params }) {
  return (
    <AppShell>
      <CustomerProfile customerId={params.id} />
    </AppShell>
  );
}
