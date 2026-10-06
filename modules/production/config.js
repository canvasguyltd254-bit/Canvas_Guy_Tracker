const productionConfig = {
  id: "production",
  name: "Production",
  icon: "🏭",
  description: "Plan production jobs, assign work and track accepted quantities.",
  allowedRoles: ["admin", "production_manager", "head_of_sales", "production_staff"],
  navItems: [
    { label: "Production", path: "/production" },
  ],
};

export default productionConfig;
