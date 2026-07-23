const dashboardConfig = {
  id: "dashboard",
  name: "Dashboard",
  icon: "📊",
  description: "Overview of production status and alerts",
  allowedRoles: ["admin", "production_manager", "head_of_sales", "sales", "production_staff", "viewer"],
  navItems: [
    { label: "Dashboard", path: "/dashboard" },
  ],
};
export default dashboardConfig;
