// V7.1: The standalone detail page has been removed.
// Orders now go directly from the list to /orders/[id]/form.
// This redirect ensures any stale links still work.

import { redirect } from 'next/navigation';

export default function OrderDetailRedirect({ params }) {
  redirect(`/orders/${params.id}/form`);
}
