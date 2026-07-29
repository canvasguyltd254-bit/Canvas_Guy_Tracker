"use client";
import CustomerProfile from "@/modules/customers/components/CustomerProfile";

export default function CustomerProfilePage({ params }) {
  return (
    <CustomerProfile customerId={params.id} />
  );
}
