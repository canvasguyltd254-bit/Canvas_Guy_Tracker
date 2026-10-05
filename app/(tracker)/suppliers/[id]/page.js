"use client";
import { use } from "react";
import SupplierProfile from "@/modules/suppliers/components/SupplierProfile";

export default function SupplierProfilePage(props) {
  const params = use(props.params);
  return (
    <SupplierProfile supplierId={params.id} />
  );
}
