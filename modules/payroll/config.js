const payrollConfig = {
  id: 'payroll',
  name: 'Payroll',
  icon: '💰',
  description: 'Employee payroll, attendance, and statutory deductions',
  allowedRoles: ['admin', 'head_of_sales', 'production_manager'],
  navItems: [
    { label: 'Payroll', path: '/payroll' },
  ],
};

export default payrollConfig;
