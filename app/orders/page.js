"use client";
import AppShell from "@/shared/ui/AppShell";
import OrderTracker from "@/modules/orders/components/OrderTracker";

export default function OrdersPage() {
  return (
    <AppShell>
      <OrderTracker />
    </AppShell>
  );
}
