/**
 * shared/lib/accountingService.js
 *
 * Business-logic helpers that build correct debit/credit lines for each
 * posting pattern and call postJournal. All functions return
 * { id: uuid, error: null } on success or { id: null, error: string }
 * on failure — they NEVER throw.
 *
 * Signed-amount model (inherited from postJournal):
 *   positive = debit, negative = credit, SUM(lines) must = 0
 *
 * ── Posting patterns ─────────────────────────────────────────
 *
 *  Purchase (goods received on account):
 *    DR expense account (from accounting_category)   +total_amount
 *    CR Accounts Payable (2000)                      -total_amount
 *
 *  Manual payment (cash / M-Pesa / bank):
 *    DR Accounts Payable (2000)                      +amount
 *    CR payment asset (1000 / 1010 / 1020)           -amount
 *
 *  Chatpesa — supplier purchase or opening balance:
 *    DR Accounts Payable (2000)                      +amount
 *    CR Chatpesa / M-Pesa Float (1010)               -amount
 *
 *  Chatpesa — petty cash:
 *    DR expense account (from accounting_category)   +amount
 *    CR Chatpesa / M-Pesa Float (1010)               -amount
 *
 * ── Payment method → asset account ──────────────────────────
 *   Cash          → 1000 Cash on Hand
 *   M-Pesa        → 1010 Chatpesa / M-Pesa Float
 *   Bank Transfer → 1020 Default Bank Account (ABSA)
 *   Cheque        → 1020 Default Bank Account (ABSA) — cheques drawn on bank
 *   Other         → no mapping; caller must skip or handle manually
 */

import { postJournal } from './postJournal.js';

// ─────────────────────────────────────────────────────────────
// 0. postOpeningBalanceJournal
//
//    Call once when a supplier's opening balance is first set.
//    Records the pre-existing liability the business had before
//    the accounting system started tracking.
//
//    DR: 3000 Opening Balance Equity  +opening_balance
//    CR: 2000 Accounts Payable        -opening_balance
//
//    source_type = 'supplier_opening_balance', source_id = supplier.id
//    UNIQUE constraint blocks double-posting automatically.
//
// @param {object} opts
//   supplierId      — suppliers.id
//   openingBalance  — numeric (must be > 0)
//   balanceDate     — 'YYYY-MM-DD' (opening_balance_date or today)
//   supplierName    — string (used in description)
//   postedBy        — auth.users.id
//   client          — serviceClient
// ─────────────────────────────────────────────────────────────
export async function postOpeningBalanceJournal({
  supplierId, openingBalance, balanceDate, supplierName, postedBy, client,
}) {
  if (!openingBalance || openingBalance <= 0) {
    return { id: null, error: 'SKIP: opening_balance is zero or negative' };
  }

  try {
    const [obeId, apId] = await Promise.all([
      _getAccountId('3000', client),   // Opening Balance Equity
      _getAccountId('2000', client),   // Accounts Payable
    ]);

    const label = supplierName ? `Opening balance — ${supplierName}` : 'Supplier opening balance';
    const lines = [
      { account_id: obeId, amount:  openingBalance, description: label },             // DR Opening Balance Equity
      { account_id: apId,  amount: -openingBalance, description: `AP — ${label}` },   // CR Accounts Payable
    ];

    return postJournal({
      sourceType:  'supplier_opening_balance',
      sourceId:    supplierId,
      entryDate:   balanceDate || new Date().toISOString().split('T')[0],
      description: label,
      lines,
      postedBy,
      client,
    });
  } catch (err) {
    return { id: null, error: err.message };
  }
}

// ── Payment method → account code mapping ────────────────────
const PAYMENT_ACCOUNT_CODE = {
  'Cash':          '1000',
  'M-Pesa':        '1010',
  'Bank Transfer': '1020',
  'Cheque':        '1020',  // cheques drawn on the Default Bank account
};

// ── Internal helper — fetch one account ID by code ───────────
async function _getAccountId(code, client) {
  const { data, error } = await client
    .from('accounting_accounts')
    .select('id')
    .eq('code', code)
    .single();
  if (error || !data) throw new Error(`Account ${code} not found in Chart of Accounts`);
  return data.id;
}

// ── Internal helper — fetch the expense account from a category
async function _getCategoryAccountId(categoryId, client) {
  const { data, error } = await client
    .from('accounting_categories')
    .select('account_id')
    .eq('id', categoryId)
    .single();
  if (error || !data) throw new Error(`accounting_category ${categoryId} not found`);
  return data.account_id;
}

// ─────────────────────────────────────────────────────────────
// 1. postPurchaseJournal
//
//    Call after a supplier_purchase is inserted AND the user has
//    selected an accounting_category_id. Skip if no category.
//
// @param {object} opts
//   purchaseId    — supplier_purchases.id
//   purchaseDate  — 'YYYY-MM-DD'
//   totalAmount   — numeric
//   categoryId    — accounting_categories.id (nullable — skip if null)
//   description   — items_bought or similar label
//   postedBy      — auth.users.id
//   client        — serviceClient
// ─────────────────────────────────────────────────────────────
export async function postPurchaseJournal({
  purchaseId, purchaseDate, totalAmount, categoryId, description, postedBy, client,
}) {
  if (!categoryId) {
    return { id: null, error: 'SKIP: no accounting_category_id — journal not posted' };
  }

  try {
    const [expenseAccountId, apId] = await Promise.all([
      _getCategoryAccountId(categoryId, client),
      _getAccountId('2000', client),
    ]);

    const label = description?.trim() || 'Supplier purchase';
    const lines = [
      { account_id: expenseAccountId, amount:  totalAmount, description: label },            // DR expense
      { account_id: apId,             amount: -totalAmount, description: `AP — ${label}` }, // CR Accounts Payable
    ];

    return postJournal({
      sourceType:  'purchase',
      sourceId:    purchaseId,
      entryDate:   purchaseDate,
      description: `Purchase: ${label}`,
      lines,
      postedBy,
      client,
    });
  } catch (err) {
    return { id: null, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 2. postManualPaymentJournal
//
//    Call after a manual_supplier_payments row is inserted.
//    Payment method 'Other' has no account mapping — returns
//    a SKIP error; caller should not log this as a real error.
//
// @param {object} opts
//   paymentId     — manual_supplier_payments.id
//   paymentDate   — 'YYYY-MM-DD'
//   amount        — numeric
//   paymentMethod — 'Cash' | 'M-Pesa' | 'Bank Transfer' | 'Cheque' | 'Other'
//   postedBy      — auth.users.id
//   client        — serviceClient
// ─────────────────────────────────────────────────────────────
export async function postManualPaymentJournal({
  paymentId, paymentDate, amount, paymentMethod, postedBy, client,
}) {
  const accountCode = PAYMENT_ACCOUNT_CODE[paymentMethod];
  if (!accountCode) {
    // 'Other' — no system account mapping; needs manual posting
    return { id: null, error: `SKIP: no account mapped for payment_method "${paymentMethod}"` };
  }

  try {
    const [apId, cashId] = await Promise.all([
      _getAccountId('2000',       client),
      _getAccountId(accountCode,  client),
    ]);

    const lines = [
      { account_id: apId,   amount:  amount, description: 'Supplier payment — reduce AP' },  // DR AP
      { account_id: cashId, amount: -amount, description: `Paid via ${paymentMethod}` },      // CR cash/bank
    ];

    return postJournal({
      sourceType:  'manual_payment',
      sourceId:    paymentId,
      entryDate:   paymentDate,
      description: `Supplier payment — ${paymentMethod}`,
      lines,
      postedBy,
      client,
    });
  } catch (err) {
    return { id: null, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 3. postChatpesaAllocationJournal
//
//    Call after a chatpesa_payment_allocations row is inserted.
//    Handles all three allocation types:
//      - supplier_purchase  → AP + Chatpesa
//      - opening_balance    → AP + Chatpesa
//      - petty_cash         → expense account + Chatpesa
//                            (requires categoryId)
//
// @param {object} opts
//   allocationId   — chatpesa_payment_allocations.id
//   allocationDate — 'YYYY-MM-DD'
//   amount         — numeric
//   allocationType — 'supplier_purchase' | 'opening_balance' | 'petty_cash'
//   categoryId     — accounting_categories.id (required for petty_cash)
//   pettyLabel     — petty_cash_category text (used as line description)
//   postedBy       — auth.users.id
//   client         — serviceClient
// ─────────────────────────────────────────────────────────────
export async function postChatpesaAllocationJournal({
  allocationId, allocationDate, amount, allocationType,
  categoryId, pettyLabel, postedBy, client,
}) {
  try {
    const chatpesaId = await _getAccountId('1010', client);

    // ── Supplier purchase or opening balance ─────────────────
    if (allocationType === 'supplier_purchase' || allocationType === 'opening_balance') {
      const apId = await _getAccountId('2000', client);
      const label = allocationType === 'opening_balance'
        ? 'Opening balance — Chatpesa payment'
        : 'Supplier purchase — Chatpesa payment';
      const lines = [
        { account_id: apId,       amount:  amount, description: 'Chatpesa payment — reduce AP' }, // DR AP
        { account_id: chatpesaId, amount: -amount, description: 'Chatpesa debit' },                // CR Chatpesa
      ];
      return postJournal({
        sourceType:  'chatpesa_allocation',
        sourceId:    allocationId,
        entryDate:   allocationDate,
        description: label,
        lines,
        postedBy,
        client,
      });
    }

    // ── Petty cash ───────────────────────────────────────────
    if (allocationType === 'petty_cash') {
      if (!categoryId) {
        return { id: null, error: 'SKIP: no accounting_category_id for petty_cash allocation — journal not posted' };
      }
      const expenseAccountId = await _getCategoryAccountId(categoryId, client);
      const label = pettyLabel?.trim() || 'Petty cash';
      const lines = [
        { account_id: expenseAccountId, amount:  amount, description: label },        // DR expense
        { account_id: chatpesaId,       amount: -amount, description: 'Chatpesa debit' }, // CR Chatpesa
      ];
      return postJournal({
        sourceType:  'chatpesa_allocation',
        sourceId:    allocationId,
        entryDate:   allocationDate,
        description: `Petty cash — ${label}`,
        lines,
        postedBy,
        client,
      });
    }

    return { id: null, error: `Unknown allocation_type: ${allocationType}` };
  } catch (err) {
    return { id: null, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 4. postCustomerOpeningBalanceJournal
//
//    Call once per customer when the GL is activated, to establish
//    the pre-existing receivable balance in the new GL system.
//
//    DR: 1100 Accounts Receivable  +opening_balance
//    CR: 3000 Opening Balance Equity -opening_balance
//
//    source_type = 'customer_opening_balance', source_id = customer.id
//
// @param {object} opts
//   customerId      — customers.id
//   amount          — numeric (must be > 0)
//   balanceDate     — 'YYYY-MM-DD'
//   customerName    — string (used in description)
//   postedBy        — auth.users.id
//   client          — serviceClient
// ─────────────────────────────────────────────────────────────
export async function postCustomerOpeningBalanceJournal({
  customerId, amount, balanceDate, customerName, postedBy, client,
}) {
  if (!amount || amount <= 0) {
    return { id: null, error: 'SKIP: amount is zero or negative' };
  }

  try {
    const [arId, obeId] = await Promise.all([
      _getAccountId('1100', client),   // Accounts Receivable
      _getAccountId('3000', client),   // Opening Balance Equity
    ]);

    const label = customerName
      ? `Customer opening balance — ${customerName}`
      : 'Customer opening balance';

    const lines = [
      { account_id: arId,  amount:  amount, description: label },             // DR AR
      { account_id: obeId, amount: -amount, description: `OBE — ${label}` },  // CR OBE
    ];

    return postJournal({
      sourceType:  'customer_opening_balance',
      sourceId:    customerId,
      entryDate:   balanceDate || new Date().toISOString().split('T')[0],
      description: label,
      lines,
      postedBy,
      client,
    });
  } catch (err) {
    return { id: null, error: err.message };
  }
}

// ── Payment method → asset account code (for direct expense cash payments) ───
const DIRECT_EXPENSE_PAYMENT_ACCOUNT = {
  cash:      '1000',  // Cash on Hand
  mpesa:     '1010',  // Chatpesa / M-Pesa Float
  bank:      '1020',  // Default Bank Account (ABSA)
  chatpesa:  '1010',  // Chatpesa / M-Pesa Float
};

// ─────────────────────────────────────────────────────────────
// 5. postDirectExpenseJournal
//
//    Call immediately after a direct order expense is inserted.
//
//    Posting patterns:
//      If payment_status = 'paid' AND a known payment_method:
//        DR expense account (from accounting_category_id)
//        CR cash/bank account (based on payment_method)
//      Otherwise (unpaid or unknown method):
//        DR expense account
//        CR Accounts Payable (2000)  — liability until settled
//
//    source_type = 'direct_expense', source_id = expense.id
//
// @param {object} opts
//   expenseId       — order_direct_expenses.id
//   expenseDate     — 'YYYY-MM-DD'
//   amount          — numeric (total expense amount)
//   categoryId      — accounting_categories.id (required; skip if null)
//   description     — human-readable label
//   paymentStatus   — 'paid' | 'unpaid'
//   paymentMethod   — 'cash' | 'mpesa' | 'bank' | 'chatpesa' | null
//   postedBy        — auth.users.id
//   client          — serviceClient
// ─────────────────────────────────────────────────────────────
export async function postDirectExpenseJournal({
  expenseId, expenseDate, amount, categoryId, description,
  paymentStatus, paymentMethod, postedBy, client,
}) {
  if (!categoryId) {
    return { id: null, error: 'SKIP: no accounting_category_id — journal not posted' };
  }

  try {
    const expenseAccountId = await _getCategoryAccountId(categoryId, client);

    const label = description?.trim() || 'Direct order expense';
    let creditAccountId;
    let creditLabel;

    const assetCode = paymentStatus === 'paid'
      ? DIRECT_EXPENSE_PAYMENT_ACCOUNT[paymentMethod?.toLowerCase()]
      : null;

    if (assetCode) {
      creditAccountId = await _getAccountId(assetCode, client);
      creditLabel = `Paid via ${paymentMethod}`;
    } else {
      // Unpaid or unknown payment method → credit Accounts Payable
      creditAccountId = await _getAccountId('2000', client);
      creditLabel = 'AP — direct expense accrual';
    }

    const lines = [
      { account_id: expenseAccountId, amount:  amount, description: label },
      { account_id: creditAccountId,  amount: -amount, description: creditLabel },
    ];

    return postJournal({
      sourceType:  'direct_expense',
      sourceId:    expenseId,
      entryDate:   expenseDate,
      description: `Direct expense: ${label}`,
      lines,
      postedBy,
      client,
    });
  } catch (err) {
    return { id: null, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 6. reverseDirectExpenseJournal
//
//    Call when a direct expense is reversed.
//    Negates all lines from the original journal entry.
//    source_type = 'direct_expense_reversal', source_id = reversal expense row id
//
// @param {object} opts
//   reversalExpenseId — order_direct_expenses.id of the reversed record
//   originalJournalId — journal_entries.id of the original posting
//   reversalDate      — 'YYYY-MM-DD'
//   description       — reversal reason or label
//   postedBy          — auth.users.id
//   client            — serviceClient
// ─────────────────────────────────────────────────────────────
export async function reverseDirectExpenseJournal({
  reversalExpenseId, originalJournalId, reversalDate, description, postedBy, client,
}) {
  if (!originalJournalId) {
    return { id: null, error: 'SKIP: no original journal_entry_id to reverse' };
  }

  try {
    // Fetch original lines to negate
    const { data: origLines, error: linesErr } = await client
      .from('journal_lines')
      .select('account_id, amount, description')
      .eq('journal_entry_id', originalJournalId);

    if (linesErr || !origLines?.length) {
      return { id: null, error: `Cannot fetch original journal lines: ${linesErr?.message || 'no lines found'}` };
    }

    const reversalLines = origLines.map(l => ({
      account_id:  l.account_id,
      amount:      -Number(l.amount),   // negate: DR→CR, CR→DR
      description: `Reversal: ${l.description || ''}`.trim(),
    }));

    return postJournal({
      sourceType:  'direct_expense_reversal',
      sourceId:    reversalExpenseId,
      entryDate:   reversalDate,
      description: `Expense reversal: ${description || ''}`,
      lines:       reversalLines,
      postedBy,
      client,
    });
  } catch (err) {
    return { id: null, error: err.message };
  }
}
