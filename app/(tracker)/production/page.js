"use client";

import { Suspense } from "react";
import ProductionBoard from "@/modules/production/components/ProductionBoard";

/**
 * ProductionBoard reads ?tab= and ?plan= via useSearchParams, which Next
 * requires to sit inside a Suspense boundary or the prerender build fails.
 * Same pattern as the customers and crm pages.
 */
export default function ProductionPage() {
  return (
    <Suspense fallback={null}>
      <ProductionBoard />
    </Suspense>
  );
}
