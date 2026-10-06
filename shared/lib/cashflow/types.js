/**
 * shared/lib/cashflow/types.js
 *
 * JSDoc typedefs ONLY — no runtime logic, no TypeScript, nothing imported or
 * exported at the value level. This file exists purely so every other
 * Stage 2 file (and the callers that build a CashflowSnapshot for them) can
 * reference one authoritative shape instead of re-describing it inline.
 *
 * Two object graphs are documented here:
 *   - CashflowSnapshot: the single, pre-built input `projectCashflow()`
 *     accepts. Building this snapshot (querying Supabase, applying the
 *     eligibility/exclusion rules described in confidence.js and elsewhere)
 *     is NOT this engine's job — the engine only ever receives an
 *     already-assembled plain object and returns a result, doing no I/O.
 *   - CashflowProjection: the complete output of `projectCashflow()`.
 */

// ── snapshot input ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} CashflowSnapshot
 * @property {string} as_of
 * @property {CashflowSettingsSnapshot} settings
 * @property {LedgerHealthSnapshot} ledger_health
 * @property {CashPoolSnapshot[]} cash_pools
 * @property {ReceiptSnapshot[]} receipts
 * @property {Record<string, CustomerHistorySnapshot>} customer_histories
 * @property {SupplierPurchaseSnapshot[]} supplier_purchases
 * @property {PayrollObligationSnapshot[]} payroll_obligations
 * @property {PayrollStatutorySnapshot[]} payroll_statutory_obligations
 * @property {ManualObligationSnapshot[]} manual_obligations
 * @property {CommittedBoqSnapshot[]} committed_boq
 * @property {CommittedBoqSnapshot[]} draft_boq_pipeline
 * @property {ReceiptMethodsSnapshot} [receipt_methods]  R2: customer payments by method / banked date
 */

/**
 * @typedef {Object} CashflowSettingsSnapshot
 * @property {number} horizon_weeks
 * @property {1} week_starts_on
 * @property {number} default_supplier_terms_days
 * @property {number} cash_reserve_threshold
 * @property {number} override_stale_after_days
 * @property {number} schedule_review_stale_after_days
 * @property {number} reconciliation_stale_after_days
 * @property {number} [unbanked_warn_after_days]      R2, default 3
 * @property {number} [concentration_threshold_pct]  R5, default 25
 */

/**
 * @typedef {Object} LedgerHealthSnapshot
 * @property {number} unposted_count
 * @property {number|null} oldest_unposted_days
 * @property {number} unresolved_error_count
 */

/**
 * @typedef {Object} CashPoolSnapshot
 * @property {string} account_id
 * @property {string} account_code
 * @property {string} name
 * @property {number} balance
 * @property {boolean} is_enabled
 * @property {string|null} last_reconciled_at
 * @property {number|null} reconciled_balance
 * @property {number} unresolved_posting_errors
 */

/**
 * @typedef {Object} ReceiptSnapshot
 * @property {string} order_id
 * @property {string} customer_id
 * @property {string} customer_name
 * @property {string} order_num
 * @property {number} total_value
 * @property {number} non_reversed_paid
 * @property {number} outstanding_amount
 * @property {string|null} payment_due_date
 * @property {string|null} invoice_issued_at
 * @property {string} created_at
 * @property {ScheduleSnapshot|null} schedule
 * @property {InstallmentSnapshot[]} installments
 */

/**
 * @typedef {Object} CustomerHistorySnapshot
 * @property {SettledOrderSnapshot[]} settled_orders
 */

/**
 * @typedef {Object} SettledOrderSnapshot
 * @property {string} order_id
 * @property {string} payment_due_date
 * @property {string} final_payment_date
 */

/**
 * customer_histories is keyed by customer_id:
 * {
 *   "customer-uuid": {
 *     settled_orders: [
 *       { order_id: "uuid", payment_due_date: "2026-07-01", final_payment_date: "2026-07-12" }
 *     ]
 *   }
 * }
 */

/**
 * @typedef {Object} SupplierPurchaseSnapshot
 * @property {string} purchase_id
 * @property {string} supplier_id
 * @property {string} supplier_name
 * @property {string} purchase_date
 * @property {string|null} due_date
 * @property {'explicit'|'supplier_terms'|null} due_date_source
 * @property {number|null} due_date_terms_days
 * @property {number|null} current_supplier_terms_days
 * @property {number} total_amount
 * @property {number} paid_amount
 * @property {number} outstanding_amount
 * @property {ScheduleSnapshot|null} schedule
 * @property {InstallmentSnapshot[]} installments
 */

/**
 * @typedef {Object} PayrollObligationSnapshot
 * @property {string} payroll_run_id
 * @property {string} label
 * @property {string} period_end
 * @property {number} net_pay
 * @property {number} paid_amount
 * @property {number} outstanding_amount
 * @property {ScheduleSnapshot|null} schedule
 * @property {InstallmentSnapshot[]} installments
 */

/**
 * SHA derived from payroll. PAYE, NSSF and AHL remain manual obligations
 * until payroll calculates them reliably — they are NOT represented here.
 *
 * @typedef {Object} PayrollStatutorySnapshot
 * @property {'payroll_sha'} source
 * @property {string} payroll_run_id
 * @property {string} label
 * @property {string} due_date
 * @property {number} outstanding_amount
 * @property {'must_pay'} priority
 * @property {ScheduleSnapshot|null} schedule
 * @property {InstallmentSnapshot[]} installments
 */

/**
 * @typedef {Object} ManualObligationSnapshot
 * @property {string} obligation_id
 * @property {string} name
 * @property {string|null} payee
 * @property {number} amount
 * @property {boolean} is_statutory
 * @property {'paye'|'nssf'|'ahl'|'sha'|'vat'|'wht'|'other'|null} [statutory_type]  R4 explicit tag, never inferred from name
 * @property {string|null} [paying_account_id]  R4 account that pays it; null = unrecorded
 * @property {'once'|'monthly'|'quarterly'|'annual'} recurrence
 * @property {number|null} day_of_month
 * @property {string} first_due_date
 * @property {string|null} ends_on
 * @property {boolean} is_active
 * @property {'must_pay'|'important'|'can_wait'} default_priority
 * @property {Record<string, ScheduleSnapshot>} occurrence_schedules
 */

/**
 * occurrence_schedules is keyed by the occurrence's ISO date:
 * {
 *   "2026-10-01": { id: "uuid", planned_date: "2026-10-05" }
 * }
 */

/**
 * @typedef {Object} ScheduleSnapshot
 * @property {string} id
 * @property {string} planned_date
 * @property {number|null} planned_amount
 * @property {number|null} minimum_amount
 * @property {'must_pay'|'important'|'can_wait'|'on_hold'} priority
 * @property {'confirmed'|'likely'|'uncertain'|null} confidence_override
 * @property {string|null} hold_reason
 * @property {string|null} notes
 * @property {string|null} last_reviewed_at
 * @property {string} updated_at
 * @property {InstallmentSnapshot[]} [installments] Present on manual-obligation occurrence schedules
 */

/**
 * @typedef {Object} InstallmentSnapshot
 * @property {string} id
 * @property {number} installment_number
 * @property {string} planned_date
 * @property {number} planned_amount
 * @property {'planned'|'cancelled'} status
 */

/**
 * Active rows enter `committed_boq`; Draft rows enter `draft_boq_pipeline`.
 * Rule: net_commitment = max(0, gross_commitment - linked_purchase_amount)
 *
 * @typedef {Object} CommittedBoqSnapshot
 * @property {string} material_estimate_id
 * @property {string} job_id
 * @property {string} order_id
 * @property {string|null} supplier_id
 * @property {'Active'|'Draft'} plan_status
 * @property {string} needed_by
 * @property {number} gross_commitment
 * @property {number} linked_purchase_amount
 * @property {number} net_commitment
 */

// ── projectCashflow() output ────────────────────────────────────────────────

/**
 * @typedef {Object} CashflowProjection
 * @property {string} as_of
 * @property {ProjectionHorizon} horizon
 * @property {ProjectedLedgerHealth} ledger_health
 * @property {ProjectedCashPool[]} cash_pools
 * @property {number} opening_cash
 * @property {ProjectedWeek[]} weeks
 * @property {FirstShortfall|null} first_shortfall_week
 * @property {ProjectionCounts} counts
 * @property {BoqProjectionSummary} boq_summary
 * @property {ProjectionWarning[]} warnings
 */

/**
 * @typedef {Object} ProjectionHorizon
 * @property {number} weeks
 * @property {string} first_week_start
 * @property {string} last_week_end
 */

/**
 * @typedef {Object} ProjectedLedgerHealth
 * @property {number} unposted_count
 * @property {number|null} oldest_unposted_days
 * @property {number} unresolved_error_count
 * @property {boolean} is_provisional
 */

/**
 * @typedef {Object} ProjectedCashPool
 * @property {string} account_id
 * @property {string} account_code
 * @property {string} name
 * @property {number} balance
 * @property {boolean} is_provisional
 * @property {string[]} provisional_reasons
 */

/**
 * @typedef {Object} ProjectedWeek
 * @property {number} index
 * @property {string} week_start
 * @property {string} week_end
 * @property {number} opening
 * @property {ProjectedMoneyIn} money_in
 * @property {ProjectedMoneyOut} money_out
 * @property {ProjectedBoq} committed_boq
 * @property {number} closing
 * @property {number} downside_opening
 * @property {number} downside_closing
 * @property {'normal'|'low_cash'|'shortfall'} state
 * @property {'Normal'|'Low cash'|'Shortfall'} state_label
 * @property {number} reserve_gap
 * @property {number} shortfall_amount
 */

/**
 * @typedef {Object} ProjectedMoneyIn
 * @property {number} gross
 * @property {number} weighted
 * @property {number} unplanned Amount still outstanding but not assigned to a dated receipt plan
 * @property {ProjectedReceiptItem[]} items
 */

/**
 * @typedef {Object} ProjectedMoneyOut
 * @property {number} must_pay
 * @property {number} important
 * @property {number} can_wait
 * @property {number} total_planned
 * @property {number} held
 * @property {number} unplanned
 * @property {ProjectedOutflowItem[]} items
 */

/**
 * @typedef {Object} ProjectedBoq
 * @property {number} gross
 * @property {number} linked
 * @property {number} net
 * @property {ProjectedBoqItem[]} items
 */

/**
 * @typedef {Object} ProjectedReceiptItem
 * @property {string} order_id
 * @property {string} order_num
 * @property {string} customer_id
 * @property {string} customer_name
 * @property {number} outstanding_amount
 * @property {number} weighted_amount
 * @property {string} expected_date
 * @property {Object|null} date_resolution
 * @property {'confirmed'|'likely'|'uncertain'} confidence
 * @property {number} confidence_weight
 * @property {Object} confidence_reason
 * @property {boolean} is_overdue
 * @property {number} days_overdue
 * @property {boolean} is_unplanned
 * @property {string|null} schedule_id
 * @property {string|null} installment_id
 */

/**
 * @typedef {Object} ProjectedOutflowItem
 * @property {'supplier_purchase'|'payroll'|'payroll_sha'|'manual_obligation'} source_type
 * @property {string} source_id
 * @property {string} label
 * @property {string|null} payee
 * @property {string} planned_date
 * @property {number} planned_amount
 * @property {number} outstanding_amount
 * @property {number} unplanned_amount
 * @property {'must_pay'|'important'|'can_wait'|'on_hold'} priority
 * @property {boolean} is_held
 * @property {string|null} hold_reason
 * @property {boolean} is_overdue
 * @property {number} days_overdue
 * @property {Object|null} date_resolution
 * @property {string|null} schedule_id
 * @property {string|null} installment_id
 */

/**
 * @typedef {Object} ProjectedBoqItem
 * @property {string} material_estimate_id
 * @property {string} job_id
 * @property {string} order_id
 * @property {string|null} supplier_id
 * @property {string} needed_by
 * @property {number} gross_commitment
 * @property {number} linked_amount
 * @property {number} net_commitment
 */

/**
 * The suggested deferrable item must come from the same shortfall week and
 * cannot be: statutory; `must_pay`; held; dated after that week.
 *
 * @typedef {Object} FirstShortfall
 * @property {string} week_start
 * @property {number} amount
 * @property {ProjectedOutflowItem|null} largest_deferrable_item
 */

/**
 * @typedef {Object} ProjectionCounts
 * @property {number} normal_weeks
 * @property {number} low_cash_weeks
 * @property {number} shortfall_weeks
 */

/**
 * Coverage: linked_amount / gross_commitment * 100. When gross_commitment is
 * zero, coverage is 0, not 100 (never divide by zero into a fabricated 100%).
 *
 * @typedef {Object} BoqProjectionSummary
 * @property {number} gross_commitment
 * @property {number} linked_amount
 * @property {number} net_commitment
 * @property {number} link_coverage_percent
 * @property {number} draft_pipeline
 */

/**
 * @typedef {Object} ProjectionWarning
 * @property {string} code
 * @property {'info'|'warning'|'critical'} severity
 * @property {string} message
 * @property {string|null} week_start
 * @property {string|null} source_type
 * @property {string|null} source_id
 * @property {Object|null} metadata
 */

export {};


/**
 * R2. `available:false` means the method/banked columns could not be read
 * (migration not applied) — distinct from "no unbanked receipts".
 * @typedef {Object} ReceiptMethodsSnapshot
 * @property {boolean} available
 * @property {{payment_id:string,order_id:string,order_num:string|null,customer_name:string|null,amount:number,payment_method:'cash'|'mpesa',payment_date:string}[]} unbanked
 * @property {number} unknown_method_count   non-reversed payments with NULL method (never assumed)
 * @property {number} unknown_method_amount
 */
