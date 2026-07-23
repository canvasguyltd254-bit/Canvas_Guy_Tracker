const ordersConfig = {
  id: "orders",
  name: "Orders",
  icon: "📋",
  description: "Track production orders across brands",
  allowedRoles: ["admin", "production_manager", "head_of_sales", "sales", "production_staff", "viewer"],
  navItems: [
    { label: "All Orders", path: "/orders" },
  ],
};
export default ordersConfig;
