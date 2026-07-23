const reportsConfig = {
  id: "reports",
  name: "Reports",
  icon: "📊",
  description: "Production reports & PDF exports",
  allowedRoles: ["admin", "production_manager", "head_of_sales"],
  navItems: [
    { label: "Reports", path: "/reports" },
  ],
};
export default reportsConfig;
