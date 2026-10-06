/**
 * shared/lib/homeAccess.js
 *
 * Single source of truth for which roles can see which Home-page data.
 * Shared by /api/home/summary and /api/home/priorities so the two
 * endpoints never silently drift apart on who sees what.
 *
 * Note: this duplicates (rather than reads from) modules/registry's
 * per-module allowedRoles — that registry drives page/nav access,
 * this drives which aggregate counts/rows a role is shown on Home.
 * The two happen to agree today; if you change one, check the other.
 */

export const PRODUCTION_STATUSES = ['Material Check', 'Production', 'Quality Control', 'Ready for Delivery', 'Partially Delivered'];
export const DELIVERED_STATUSES  = ['Partially Delivered', 'Delivered'];

export const CAN_SEE_PRODUCTION  = ['admin', 'production_manager', 'head_of_sales', 'production_staff'];
export const CAN_SEE_CUSTOMERS   = ['admin', 'production_manager', 'head_of_sales', 'sales'];
export const CAN_SEE_SUPPLIERS   = ['admin', 'production_manager', 'head_of_sales'];
export const CAN_SEE_ACCOUNTING  = ['admin', 'production_manager', 'head_of_sales'];
export const CAN_SEE_ADMIN       = ['admin'];

// Narrower than CAN_SEE_ACCOUNTING on purpose: cashflow_v1_schema.sql's own
// security note says "Production roles get no access in Phase 1: BoQ
// commitments in purchase_boq_links expose supplier pricing."
export const CAN_SEE_CASHFLOW    = ['admin', 'head_of_sales'];
