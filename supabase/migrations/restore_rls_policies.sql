-- ============================================================
-- restore_rls_policies.sql
--
-- PURPOSE
--   schema.sql previously contained a global DROP POLICY loop that
--   wiped every RLS policy in the public schema before re-creating
--   only those it defines itself.  Re-running schema.sql on an existing
--   database would silently remove all policies defined in the
--   individual migration files below.
--
--   Run this migration AFTER schema.sql if you ever need to re-apply
--   schema.sql to an existing database.  It is idempotent — each
--   CREATE POLICY is guarded by a prior DROP IF EXISTS so it is safe
--   to run more than once.
--
-- COVERS
--   suppliers_module.sql        → suppliers, supplier_purchases, supplier_attachments
--   payments_module.sql         → chatpesa_imports, chatpesa_transactions,
--                                  chatpesa_payment_allocations, manual_supplier_payments
--   accounting_foundation.sql   → accounting_accounts, accounting_categories,
--                                  journal_entries, journal_lines, accounting_posting_errors
--   customers_module.sql        → customers, customer_notes, contacts
--   purchase_order_links.sql +
--   purchase_order_links_add_amount.sql → purchase_order_links
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- 1. SUPPLIERS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "suppliers_select" ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_insert" ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_update" ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_delete" ON public.suppliers;

CREATE POLICY "suppliers_select" ON public.suppliers
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "suppliers_insert" ON public.suppliers
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "suppliers_update" ON public.suppliers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "suppliers_delete" ON public.suppliers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );


-- ──────────────────────────────────────────────────────────
-- 2. SUPPLIER_PURCHASES
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.supplier_purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supplier_purchases_select" ON public.supplier_purchases;
DROP POLICY IF EXISTS "supplier_purchases_insert" ON public.supplier_purchases;
DROP POLICY IF EXISTS "supplier_purchases_update" ON public.supplier_purchases;
DROP POLICY IF EXISTS "supplier_purchases_delete" ON public.supplier_purchases;

CREATE POLICY "supplier_purchases_select" ON public.supplier_purchases
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "supplier_purchases_insert" ON public.supplier_purchases
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "supplier_purchases_update" ON public.supplier_purchases
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "supplier_purchases_delete" ON public.supplier_purchases
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );


-- ──────────────────────────────────────────────────────────
-- 3. SUPPLIER_ATTACHMENTS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.supplier_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supplier_attachments_select" ON public.supplier_attachments;
DROP POLICY IF EXISTS "supplier_attachments_insert" ON public.supplier_attachments;
DROP POLICY IF EXISTS "supplier_attachments_delete" ON public.supplier_attachments;

CREATE POLICY "supplier_attachments_select" ON public.supplier_attachments
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "supplier_attachments_insert" ON public.supplier_attachments
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "supplier_attachments_delete" ON public.supplier_attachments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager')
    )
  );


-- ──────────────────────────────────────────────────────────
-- 4. CHATPESA_IMPORTS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.chatpesa_imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chatpesa_imports_select" ON public.chatpesa_imports;
DROP POLICY IF EXISTS "chatpesa_imports_insert" ON public.chatpesa_imports;

CREATE POLICY "chatpesa_imports_select" ON public.chatpesa_imports
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "chatpesa_imports_insert" ON public.chatpesa_imports
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales'))
  );


-- ──────────────────────────────────────────────────────────
-- 5. CHATPESA_TRANSACTIONS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.chatpesa_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chatpesa_transactions_select" ON public.chatpesa_transactions;
DROP POLICY IF EXISTS "chatpesa_transactions_insert" ON public.chatpesa_transactions;
DROP POLICY IF EXISTS "chatpesa_transactions_update" ON public.chatpesa_transactions;

CREATE POLICY "chatpesa_transactions_select" ON public.chatpesa_transactions
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "chatpesa_transactions_insert" ON public.chatpesa_transactions
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales'))
  );

CREATE POLICY "chatpesa_transactions_update" ON public.chatpesa_transactions
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales'))
  );


-- ──────────────────────────────────────────────────────────
-- 6. CHATPESA_PAYMENT_ALLOCATIONS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.chatpesa_payment_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allocations_select" ON public.chatpesa_payment_allocations;
DROP POLICY IF EXISTS "allocations_insert" ON public.chatpesa_payment_allocations;
DROP POLICY IF EXISTS "allocations_delete" ON public.chatpesa_payment_allocations;

CREATE POLICY "allocations_select" ON public.chatpesa_payment_allocations
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "allocations_insert" ON public.chatpesa_payment_allocations
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales'))
  );

CREATE POLICY "allocations_delete" ON public.chatpesa_payment_allocations
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager'))
  );


-- ──────────────────────────────────────────────────────────
-- 7. MANUAL_SUPPLIER_PAYMENTS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.manual_supplier_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manual_payments_select" ON public.manual_supplier_payments;
DROP POLICY IF EXISTS "manual_payments_insert" ON public.manual_supplier_payments;
DROP POLICY IF EXISTS "manual_payments_delete" ON public.manual_supplier_payments;

CREATE POLICY "manual_payments_select" ON public.manual_supplier_payments
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "manual_payments_insert" ON public.manual_supplier_payments
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales'))
  );

CREATE POLICY "manual_payments_delete" ON public.manual_supplier_payments
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager'))
  );


-- ──────────────────────────────────────────────────────────
-- 8. ACCOUNTING TABLES
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.accounting_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_categories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_posting_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accounts_select_authenticated"    ON public.accounting_accounts;
DROP POLICY IF EXISTS "categories_select_authenticated"  ON public.accounting_categories;
DROP POLICY IF EXISTS "journal_entries_accounting_roles" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_lines_accounting_roles"   ON public.journal_lines;
DROP POLICY IF EXISTS "posting_errors_admin_only"        ON public.accounting_posting_errors;

-- All authenticated users can read accounts + categories (needed for dropdowns)
CREATE POLICY "accounts_select_authenticated"
  ON public.accounting_accounts FOR SELECT TO authenticated USING (true);

CREATE POLICY "categories_select_authenticated"
  ON public.accounting_categories FOR SELECT TO authenticated USING (true);

-- Journal entries/lines: admin and production_manager only
CREATE POLICY "journal_entries_accounting_roles"
  ON public.journal_entries FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'production_manager')
    )
  );

CREATE POLICY "journal_lines_accounting_roles"
  ON public.journal_lines FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'production_manager')
    )
  );

-- Posting errors: admin only
CREATE POLICY "posting_errors_admin_only"
  ON public.accounting_posting_errors FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- NOTE: No client-side INSERT/UPDATE policies for journal tables.
-- All writes go through the service_role client or post_journal_entry() RPC.


-- ──────────────────────────────────────────────────────────
-- 9. CUSTOMERS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_select" ON public.customers;
DROP POLICY IF EXISTS "customers_insert" ON public.customers;
DROP POLICY IF EXISTS "customers_update" ON public.customers;
DROP POLICY IF EXISTS "customers_delete" ON public.customers;

CREATE POLICY "customers_select" ON public.customers
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "customers_insert" ON public.customers
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales', 'sales'))
  );

CREATE POLICY "customers_update" ON public.customers
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales', 'sales'))
  );

CREATE POLICY "customers_delete" ON public.customers
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );


-- ──────────────────────────────────────────────────────────
-- 10. CUSTOMER_NOTES
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_notes_select" ON public.customer_notes;
DROP POLICY IF EXISTS "customer_notes_insert" ON public.customer_notes;
DROP POLICY IF EXISTS "customer_notes_delete" ON public.customer_notes;

CREATE POLICY "customer_notes_select" ON public.customer_notes
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "customer_notes_insert" ON public.customer_notes
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "customer_notes_delete" ON public.customer_notes
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales'))
  );


-- ──────────────────────────────────────────────────────────
-- 11. CONTACTS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contacts_select" ON public.contacts;
DROP POLICY IF EXISTS "contacts_insert" ON public.contacts;
DROP POLICY IF EXISTS "contacts_update" ON public.contacts;
DROP POLICY IF EXISTS "contacts_delete" ON public.contacts;

CREATE POLICY "contacts_select" ON public.contacts
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "contacts_insert" ON public.contacts
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "contacts_update" ON public.contacts
  FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "contacts_delete" ON public.contacts
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin', 'production_manager', 'head_of_sales'))
  );


-- ──────────────────────────────────────────────────────────
-- 12. PURCHASE_ORDER_LINKS
-- ──────────────────────────────────────────────────────────

ALTER TABLE public.purchase_order_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pol_pol_select" ON public.purchase_order_links;
DROP POLICY IF EXISTS "pol_pol_insert" ON public.purchase_order_links;
DROP POLICY IF EXISTS "pol_pol_update" ON public.purchase_order_links;
DROP POLICY IF EXISTS "pol_pol_delete" ON public.purchase_order_links;

CREATE POLICY "pol_pol_select" ON public.purchase_order_links
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "pol_pol_insert" ON public.purchase_order_links
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "pol_pol_update" ON public.purchase_order_links
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id   = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "pol_pol_delete" ON public.purchase_order_links
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );
