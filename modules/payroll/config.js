const payrollConfig = {
  id: 'payroll',
  name: 'Payroll',
  icon: '💰',
  description: 'Employee payroll, attendance, and statutory deductions',
  allowedRoles: ['admin', 'production_manager'],
  navItems: [
    { label: 'Payroll', path: '/payroll' },
  ],
};

export default payrollConfig;
