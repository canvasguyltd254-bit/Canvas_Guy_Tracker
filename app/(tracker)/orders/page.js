'use client';

import OrdersModule from '@/modules/orders/components/OrdersModule';

// When workspace is disabled (or the tab strip hasn't opened this as a tab yet),
// this page renders OrdersModule directly with workspaceActive=false so its
// sticky header sits at the correct 56px offset.
export default function OrdersPage() {
  return <OrdersModule />;
}
