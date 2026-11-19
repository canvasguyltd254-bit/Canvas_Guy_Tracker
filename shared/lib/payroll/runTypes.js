/**
 * Payroll run eligibility: which employee pay-basis types may sit in which run.
 *
 *   casual         run -> casual workers only
 *   permanent      run -> permanent workers only
 *   skilled_casual run -> skilled-casual workers only
 *   combined       run -> any of the three standard types, nothing else
 *
 * Anything else (an unknown or future type, null, undefined) is never eligible,
 * in any run. Pure and client-safe: no imports, so the API, the approval
 * checks and the UI all apply the same rule. The database enforces the same
 * rule in payroll_run_type_allows() (see payroll_run_type_guard.sql); keep the
 * two in step.
 */

export const STANDARD_EMPLOYEE_TYPES = Object.freeze(['casual', 'permanent', 'skilled_casual']);
export const RUN_TYPES = Object.freeze([...STANDARD_EMPLOYEE_TYPES, 'combined']);

/** Employee types accepted by a run type. Unknown run types accept nothing. */
export function allowedTypesForRun(runType) {
  if (runType === 'combined') return STANDARD_EMPLOYEE_TYPES;
  return STANDARD_EMPLOYEE_TYPES.includes(runType) ? [runType] : [];
}

export function isTypeAllowedInRun(runType, employeeType) {
  return allowedTypesForRun(runType).includes(employeeType);
}

/** Human-readable reason, or null when the employee may be added. */
export function runTypeMismatchMessage(runType, employeeType) {
  if (isTypeAllowedInRun(runType, employeeType)) return null;
  if (!RUN_TYPES.includes(runType)) return `Unknown run type "${runType}"`;
  if (!STANDARD_EMPLOYEE_TYPES.includes(employeeType)) {
    return `Employee type "${employeeType ?? 'none'}" cannot be paid through a payroll run`;
  }
  return `A ${runType} run cannot include a ${employeeType} employee. Use a ${employeeType} run or a combined run.`;
}

/**
 * Entry snapshot types that would be invalid if a run were switched to
 * `newRunType`. Empty array means the switch is safe.
 */
export function entryTypesConflictingWithRun(newRunType, entrySnapshotTypes = []) {
  const bad = new Set();
  for (const t of entrySnapshotTypes) {
    if (!isTypeAllowedInRun(newRunType, t)) bad.add(t ?? 'none');
  }
  return [...bad];
}
