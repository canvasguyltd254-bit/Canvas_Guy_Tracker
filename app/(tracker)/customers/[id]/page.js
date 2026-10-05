"use client";
import { use } from "react";
import CustomerProfile from "@/modules/customers/components/CustomerProfile";

export default function CustomerProfilePage(props) {
  const params = use(props.params);
  return (
    <CustomerProfile customerId={params.id} />
  );
}
