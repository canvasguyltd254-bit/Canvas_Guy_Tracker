const productionConfig = {
  id: "production",
  name: "Production",
  icon: "🏭",
  description: "Track production progress and quality control",
  allowedRoles: ["admin", "production_manager", "head_of_sales", "production_staff"],
  navItems: [
    { label: "Production", path: "/production" },
  ],
};
export default productionConfig;
