'use client';

import { Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import CustomersModule from '@/modules/customers/components/CustomersModule';

function CustomersPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const newParam     = searchParams.get('new');
  const prospectName = searchParams.get('prospect_name') || undefined;
  const phone        = searchParams.get('phone')         || undefined;

  // Strip ?new= after reading so Back doesn't re-trigger the form
  useEffect(() => {
    if (newParam) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('new');
      const qs = params.toString();
      router.replace(qs ? `/customers?${qs}` : '/customers', { scroll: false });
    }
  }, []);

  const defaultAction = newParam === 'customer' ? 'customer' : undefined;

  return (
    <CustomersModule
      defaultAction={defaultAction}
      defaultProspectName={prospectName}
      defaultPhone={phone}
    />
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <CustomersPageContent />
    </Suspense>
  );
}
