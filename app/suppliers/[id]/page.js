import SupplierProfile from "@/modules/suppliers/components/SupplierProfile";

export default function SupplierProfilePage({ params }) {
  return <SupplierProfile supplierId={params.id} />;
}
