const accountingConfig = {
  id: "accounting",
  name: "Accounting",
  icon: "📒",
  description: "GL review — unposted transactions, posting errors, reversal history",
  allowedRoles: ["admin", "production_manager", "head_of_sales"],
  navItems: [
    { label: "GL Review", path: "/accounting" },
  ],
};
export default accountingConfig;
