/**
 * shared/lib/cashflow/classifyWeek.js
 *
 * The ONE place a week's cash state (Normal / Low cash / Shortfall) is
 * decided. Per the Stage 2 contract, the UI must never reproduce this
 * logic — every component reads `state` / `state_label` off the engine's
 * output instead of re-deriving it from a closing balance.
 *
 * This function classifies ONE balance number and knows nothing about weeks.
 * The caller decides which number: since Cashflow spec R3/R5, projectCashflow
 * passes the LOWEST DAY of the week across the official and downside daily
 * replays (not the weekly closing balance), so a mid-week dip is never hidden
 * by a recovery later in the same week. There is no hysteresis: a week's state
 * depends solely on its own worst day, independent of neighbouring weeks.
 */

/**
 * @param {number} closingBalance
 * @param {number} reserveThreshold  cashflow_settings.cash_reserve_threshold
 * @returns {{
 *   state: 'normal'|'low_cash'|'shortfall',
 *   label: 'Normal'|'Low cash'|'Shortfall',
 *   reserve_gap: number,
 *   shortfall_amount: number,
 * }}
 */
export function classifyWeek(closingBalance, reserveThreshold) {
  if (typeof closingBalance !== 'number' || !Number.isFinite(closingBalance)) {
    throw new RangeError(`classifyWeek: closingBalance must be a finite number, got ${JSON.stringify(closingBalance)}`);
  }
  if (typeof reserveThreshold !== 'number' || !Number.isFinite(reserveThreshold) || reserveThreshold < 0) {
    throw new RangeError(`classifyWeek: reserveThreshold must be a finite, non-negative number, got ${JSON.stringify(reserveThreshold)}`);
  }

  // Shortfall: closing balance is actually negative.
  if (closingBalance < 0) {
    return {
      state: 'shortfall',
      label: 'Shortfall',
      // reserve_gap is the full distance back to the reserve target,
      // including recovering from negative — always >= reserveThreshold here.
      reserve_gap: reserveThreshold - closingBalance,
      shortfall_amount: Math.abs(closingBalance),
    };
  }

  // Low cash: zero or positive, but below the configured reserve. A zero
  // balance is explicitly Low cash, not Shortfall (closingBalance < 0 is the
  // only shortfall test, and 0 fails it).
  if (closingBalance < reserveThreshold) {
    return {
      state: 'low_cash',
      label: 'Low cash',
      reserve_gap: reserveThreshold - closingBalance,
      shortfall_amount: 0,
    };
  }

  // Normal: at or above the reserve threshold.
  return {
    state: 'normal',
    label: 'Normal',
    reserve_gap: 0,
    shortfall_amount: 0,
  };
}
