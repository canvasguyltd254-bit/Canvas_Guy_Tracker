'use client';

import { Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import CrmModule from '@/modules/crm/components/CrmModule';

function CrmPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const newParam     = searchParams.get('new');       // 'enquiry' | 'quote'
  const customerId   = searchParams.get('customer_id') || undefined;
  const enquiryId    = searchParams.get('enquiry_id')  || undefined;
  const tabParam     = searchParams.get('tab')    || undefined;   // e.g. Quotations
  const filterParam  = searchParams.get('filter') || undefined;   // e.g. followup
  const openParam    = searchParams.get('open')   || undefined;   // enquiry id to expand and scroll to

  // Strip ?new= after reading so Back doesn't re-trigger the modal
  useEffect(() => {
    if (newParam) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('new');
      const qs = params.toString();
      router.replace(qs ? `/crm?${qs}` : '/crm', { scroll: false });
    }
  }, []);  // run once on mount

  const defaultAction = newParam === 'enquiry' || newParam === 'quote' ? newParam : undefined;

  return (
    <CrmModule
      defaultAction={defaultAction}
      defaultCustomerId={customerId}
      defaultEnquiryId={enquiryId}
      defaultTab={tabParam}
      defaultFilter={filterParam}
      defaultOpen={openParam}
    />
  );
}

export default function CrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmPageContent />
    </Suspense>
  );
}
