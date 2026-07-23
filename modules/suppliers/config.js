const suppliersConfig = {
  id: "suppliers",
  name: "Suppliers",
  icon: "🏭",
  description: "Supplier directory and purchase records",
  allowedRoles: ["admin", "production_manager", "head_of_sales"],
  navItems: [
    { label: "Suppliers", path: "/suppliers" },
  ],
};
export default suppliersConfig;
