-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration B: CRM tables + FK wiring
--
-- Run AFTER quotes_crm_migration_a.sql
-- Safe to re-run: tables use IF NOT EXISTS; policies use DROP IF EXISTS before CREATE.
--
-- Sections:
--   1. FK: orders.quote_id → quotations(id)   (deferred from A)
--   2. enquiries
--   3. quotations
--   4. quote_items
--   5. followups
--   6. quote_activities
--   7. Indexes
--   8. RLS policies
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. WIRE FK: orders.quote_id → quotations(id)
--    The column was created in Migration A as a plain uuid.
--    Now that quotations exists (created below), we add the
--    constraint. ADD CONSTRAINT IF NOT EXISTS requires PG 9.6+
--    which Supabase satisfies.
-- ────────────────────────────────────────────────────────────

-- quotations must be created before this ALTER is reached,
-- so it appears AFTER the CREATE TABLE quotations block below.
-- We use a DO block at the end of this file to add the FK after
-- all tables are in place (see Section 1b at bottom).


-- ────────────────────────────────────────────────────────────
-- 2. ENQUIRIES
--    One row per sales enquiry, whether from an existing customer
--    or a prospect not yet in the customers table.
--
--    Stage transitions:
--      new       → manual (sales team)
--      contacted → manual (sales team)
--      quoted    → auto  (set when a quotation is linked and sent)
--      won       → auto  (set when a quotation converts to an order)
--      lost      → manual + requires lost_reason
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enquiries (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  enq_num          text        NOT NULL UNIQUE,
  -- Customer link: either an existing customer profile OR free-text prospect
  customer_id      uuid        REFERENCES customers(id) ON DELETE SET NULL,
  prospect_name    text,
  prospect_contact text,
  -- Enquiry details
  source           text        NOT NULL
                     CHECK (source IN (
                       'whatsapp','email','walk_in','referral',
                       'instagram','website','architect'
                     )),
  category         text,       -- e.g. "Mirrors", "Furniture", "Frames"
  description      text        NOT NULL,
  estimated_value  integer     NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  -- Assignment and pipeline
  assigned_to      uuid        REFERENCES auth.users(id),
  stage            text        NOT NULL DEFAULT 'new'
                     CHECK (stage IN ('new','contacted','quoted','won','lost')),
  lost_reason      text,       -- required when stage = 'lost'
  -- Timestamps
  created_by       uuid        REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- A lost enquiry must have a reason
  CONSTRAINT enquiries_lost_requires_reason
    CHECK (stage <> 'lost' OR lost_reason IS NOT NULL),

  -- Must have either a linked customer or a prospect name
  CONSTRAINT enquiries_requires_customer_or_prospect
    CHECK (customer_id IS NOT NULL OR prospect_name IS NOT NULL)
);

COMMENT ON TABLE  enquiries IS 'CRM enquiry / lead. Optional first step before a quotation.';
COMMENT ON COLUMN enquiries.enq_num          IS 'System-generated: ENQ-YYYY-NNNN via next_enq_num().';
COMMENT ON COLUMN enquiries.customer_id      IS 'Existing customer profile. NULL if prospect.';
COMMENT ON COLUMN enquiries.prospect_name    IS 'Free-text name when no customer profile exists yet.';
COMMENT ON COLUMN enquiries.prospect_contact IS 'Phone / email for prospect. Not validated.';
COMMENT ON COLUMN enquiries.stage            IS 'new | contacted | quoted (auto) | won (auto) | lost (manual + reason).';
COMMENT ON COLUMN enquiries.lost_reason      IS 'Required when stage = lost. E.g. "Budget", "Went to competitor".';
COMMENT ON COLUMN enquiries.estimated_value  IS 'Approximate order value in KES. Used for pipeline reporting.';


-- ────────────────────────────────────────────────────────────
-- 3. QUOTATIONS
--    Revision model: revisions share a quote_group_id.
--    Unique constraint on (quote_group_id, revision) ensures
--    no two rows represent the same revision of the same quote.
--
--    Status transitions:
--      draft      → fully editable
--      sent       → items/prices locked; changes require new revision
--      accepted   → immutable; can convert to order
--      rejected   → immutable
--      expired    → immutable (set by admin or scheduled job)
--      superseded → immutable; set automatically when a new revision
--                   is created from a sent/accepted/rejected quote
--
--    VAT snapshot fields:
--      tax_status   — copied from customer at creation; never updated
--      pricing_mode — vat_exclusive | vat_inclusive
--      subtotal     — sum of quote_items.net_amount
--      vat_amount   — sum of quote_items.vat_amount
--      total        — sum of quote_items.gross_amount
--
--    Conversion:
--      converted_order_id — set by convert_quote_to_order RPC (atomic)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quotations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_num          text        NOT NULL UNIQUE,
  quote_group_id     uuid        NOT NULL DEFAULT gen_random_uuid(),
  revision           integer     NOT NULL DEFAULT 0 CHECK (revision >= 0),
  -- CRM link (optional)
  enquiry_id         uuid        REFERENCES enquiries(id) ON DELETE SET NULL,
  -- Customer: nullable for drafts; required before conversion
  customer_id        uuid        REFERENCES customers(id) ON DELETE SET NULL,
  prospect_name      text,
  prospect_contact   text,
  -- Content
  project_description text       NOT NULL,
  payment_terms      text,
  valid_until        date,
  -- VAT snapshot (set at creation, never recalculated)
  tax_status         text        NOT NULL DEFAULT 'taxable'
                       CHECK (tax_status IN ('taxable', 'exempt')),
  pricing_mode       text        NOT NULL DEFAULT 'vat_exclusive'
                       CHECK (pricing_mode IN ('vat_exclusive', 'vat_inclusive')),
  -- Computed totals (sum of quote_items, stored for display and GL)
  subtotal           numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount         numeric(14,2) NOT NULL DEFAULT 0,
  total              numeric(14,2) NOT NULL DEFAULT 0,
  -- Status
  status             text        NOT NULL DEFAULT 'draft'
                       CHECK (status IN (
                         'draft','sent','accepted','rejected','expired','superseded'
                       )),
  -- Conversion link (set atomically by convert_quote_to_order RPC)
  converted_order_id uuid,       -- FK to orders added after orders table confirmed
  -- Audit
  created_by         uuid        REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Each revision of a group is unique
  CONSTRAINT quotations_unique_revision UNIQUE (quote_group_id, revision),

  -- Accepted quotes must have a real customer (prospect must be resolved first)
  CONSTRAINT quotations_accepted_requires_customer
    CHECK (status NOT IN ('accepted') OR customer_id IS NOT NULL),

  -- Must have either a customer or a prospect name
  CONSTRAINT quotations_requires_customer_or_prospect
    CHECK (customer_id IS NOT NULL OR prospect_name IS NOT NULL)
);

COMMENT ON TABLE  quotations IS 'Client quotation with revision history. Revisions share quote_group_id.';
COMMENT ON COLUMN quotations.quote_num       IS 'System-generated: QT-YYYY-NNNN via next_qt_num(). Unique per revision row.';
COMMENT ON COLUMN quotations.quote_group_id  IS 'Groups all revisions of the same original quote. All revisions share this UUID.';
COMMENT ON COLUMN quotations.revision        IS 'Starts at 0. Incremented on each revision. Unique within quote_group_id.';
COMMENT ON COLUMN quotations.tax_status      IS 'Snapshotted from customer.tax_status at creation. Immutable post-acceptance.';
COMMENT ON COLUMN quotations.pricing_mode    IS 'vat_exclusive: prices are net. vat_inclusive: prices include VAT.';
COMMENT ON COLUMN quotations.status          IS 'draft/sent: mutable. accepted/rejected/expired/superseded: immutable.';
COMMENT ON COLUMN quotations.converted_order_id IS 'Set by convert_quote_to_order RPC. Non-null means this quote has been converted.';


-- ────────────────────────────────────────────────────────────
-- 4. QUOTE_ITEMS
--    Line items for a quotation. Mirrored into order_items on
--    conversion, carrying all VAT snapshot columns.
--
--    VAT calculation (stored, never recomputed post-acceptance):
--
--    Effective VAT rate:
--      customer.tax_status = 'exempt'              → vat_rate = 0
--      customer.tax_status = 'taxable'
--        AND tax_treatment = 'standard'            → vat_rate = 0.16
--        AND tax_treatment = 'exempt'              → vat_rate = 0
--
--    VAT Exclusive (pricing_mode = 'vat_exclusive'):
--      entered_price = unit_price (net)
--      net_amount    = qty × unit_price × (1 − discount_pct/100)
--      vat_amount    = ROUND(net_amount × vat_rate, 2)
--      gross_amount  = net_amount + vat_amount
--
--    VAT Inclusive (pricing_mode = 'vat_inclusive'):
--      entered_price = unit_price (gross)
--      gross_amount  = qty × unit_price × (1 − discount_pct/100)
--      net_amount    = ROUND(gross_amount / 1.16, 2)   [if taxable standard]
--                    = gross_amount                     [if exempt]
--      vat_amount    = gross_amount − net_amount
--
--    line_type → revenue account:
--      product  → 4000 Direct Sales
--      delivery → 4600 Delivery & Installation Income
--      design   → 4700 Design Services Income
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quote_items (
  id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id       uuid           NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  sort_order     integer        NOT NULL DEFAULT 0,
  -- Content
  line_type      text           NOT NULL DEFAULT 'product'
                   CHECK (line_type IN ('product', 'delivery', 'design')),
  description    text           NOT NULL,
  quantity       integer        NOT NULL DEFAULT 1 CHECK (quantity > 0),
  size           text,
  material       text,
  finish         text,
  -- Pricing
  unit_price     numeric(14,2)  NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  discount_pct   numeric(5,2)   NOT NULL DEFAULT 0
                   CHECK (discount_pct >= 0 AND discount_pct <= 100),
  -- VAT snapshot (computed and stored at line creation; never recomputed post-acceptance)
  tax_treatment  text           NOT NULL DEFAULT 'standard'
                   CHECK (tax_treatment IN ('standard', 'exempt')),
  vat_rate       numeric(5,4)   NOT NULL DEFAULT 0,   -- 0.1600 or 0.0000
  net_amount     numeric(14,2)  NOT NULL DEFAULT 0,
  vat_amount     numeric(14,2)  NOT NULL DEFAULT 0,
  gross_amount   numeric(14,2)  NOT NULL DEFAULT 0,
  -- Audit
  created_at     timestamptz    NOT NULL DEFAULT now()
);

COMMENT ON TABLE  quote_items IS 'Line items for a quotation. VAT snapshot is computed at creation and immutable post-acceptance.';
COMMENT ON COLUMN quote_items.line_type     IS 'Revenue account mapping: product=4000, delivery=4600, design=4700.';
COMMENT ON COLUMN quote_items.tax_treatment IS 'standard = eligible for 16% VAT if customer is taxable. exempt = always 0%.';
COMMENT ON COLUMN quote_items.vat_rate      IS 'Effective rate snapshotted at creation (0.1600 or 0.0000). Never recalculated.';
COMMENT ON COLUMN quote_items.net_amount    IS 'Revenue before VAT. For vat_inclusive: gross / 1.16 (or gross if exempt).';
COMMENT ON COLUMN quote_items.vat_amount    IS 'VAT on this line. Rounded to 2dp per line. Summed to quotations.vat_amount.';
COMMENT ON COLUMN quote_items.gross_amount  IS 'net_amount + vat_amount. What the customer pays for this line.';


-- ────────────────────────────────────────────────────────────
-- 5. FOLLOWUPS
--    Dated task attached to either an enquiry or a quotation.
--    Exactly one of enquiry_id / quotation_id must be non-null
--    (enforced by CHECK constraint).
--
--    Completing a follow-up does not advance the pipeline stage —
--    stage changes are separate manual or automatic actions.
--    Completing a follow-up prompts the user for the next due date,
--    which creates a new follow-up row.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS followups (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one of these must be non-null
  enquiry_id     uuid        REFERENCES enquiries(id)  ON DELETE CASCADE,
  quotation_id   uuid        REFERENCES quotations(id) ON DELETE CASCADE,
  -- Task content
  due_date       date        NOT NULL,
  note           text,
  -- Completion
  completed_at   timestamptz,
  completed_by   uuid        REFERENCES auth.users(id),
  -- Audit
  created_by     uuid        REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT followups_exactly_one_parent
    CHECK (
      (enquiry_id IS NOT NULL AND quotation_id IS NULL) OR
      (enquiry_id IS NULL     AND quotation_id IS NOT NULL)
    )
);

COMMENT ON TABLE  followups IS 'Dated task attached to an enquiry or quotation. Exactly one parent is required.';
COMMENT ON COLUMN followups.enquiry_id   IS 'Set when follow-up is for an enquiry. Mutually exclusive with quotation_id.';
COMMENT ON COLUMN followups.quotation_id IS 'Set when follow-up is for a quotation. Mutually exclusive with enquiry_id.';
COMMENT ON COLUMN followups.completed_at IS 'NULL = pending. Non-null = completed. Completing prompts for a new follow-up date.';


-- ────────────────────────────────────────────────────────────
-- 6. QUOTE_ACTIVITIES
--    Audit trail for enquiry and quotation events.
--    Follows the same pattern as order_activities and
--    payroll_activities already in the codebase.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quote_activities (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    text        NOT NULL CHECK (entity_type IN ('enquiry', 'quotation')),
  entity_id      uuid        NOT NULL,
  activity_type  text        NOT NULL,  -- e.g. 'created','stage_changed','revised','converted','sent'
  description    text        NOT NULL,
  created_by     uuid        REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  quote_activities IS 'Append-only audit log for enquiry and quotation events.';
COMMENT ON COLUMN quote_activities.entity_type  IS 'enquiry | quotation';
COMMENT ON COLUMN quote_activities.entity_id    IS 'UUID of the enquiry or quotation row.';
COMMENT ON COLUMN quote_activities.activity_type IS 'created | stage_changed | revised | sent | accepted | rejected | converted | lost | follow_up_completed';


-- ────────────────────────────────────────────────────────────
-- 1b. FK: orders.quote_id → quotations(id)
--     Applied here, after quotations table is confirmed.
-- ────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  table_schema   = 'public'
      AND  table_name     = 'orders'
      AND  constraint_name = 'orders_quote_id_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_quote_id_fkey
      FOREIGN KEY (quote_id) REFERENCES quotations(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- FK: quotations.converted_order_id → orders(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  table_schema   = 'public'
      AND  table_name     = 'quotations'
      AND  constraint_name = 'quotations_converted_order_id_fkey'
  ) THEN
    ALTER TABLE quotations
      ADD CONSTRAINT quotations_converted_order_id_fkey
      FOREIGN KEY (converted_order_id) REFERENCES orders(id) ON DELETE SET NULL;
  END IF;
END;
$$;


-- ────────────────────────────────────────────────────────────
-- 7. INDEXES
-- ────────────────────────────────────────────────────────────

-- enquiries
CREATE INDEX IF NOT EXISTS idx_enquiries_customer    ON enquiries (customer_id);
CREATE INDEX IF NOT EXISTS idx_enquiries_stage       ON enquiries (stage);
CREATE INDEX IF NOT EXISTS idx_enquiries_assigned    ON enquiries (assigned_to);
CREATE INDEX IF NOT EXISTS idx_enquiries_created     ON enquiries (created_at DESC);

-- quotations
CREATE INDEX IF NOT EXISTS idx_quotations_group      ON quotations (quote_group_id);
CREATE INDEX IF NOT EXISTS idx_quotations_enquiry    ON quotations (enquiry_id);
CREATE INDEX IF NOT EXISTS idx_quotations_customer   ON quotations (customer_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status     ON quotations (status);
CREATE INDEX IF NOT EXISTS idx_quotations_created    ON quotations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotations_converted  ON quotations (converted_order_id)
  WHERE converted_order_id IS NOT NULL;

-- quote_items
CREATE INDEX IF NOT EXISTS idx_quote_items_quote     ON quote_items (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_items_sort      ON quote_items (quote_id, sort_order);

-- followups
CREATE INDEX IF NOT EXISTS idx_followups_enquiry     ON followups (enquiry_id)
  WHERE enquiry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_followups_quotation   ON followups (quotation_id)
  WHERE quotation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_followups_due         ON followups (due_date ASC)
  WHERE completed_at IS NULL;  -- pending follow-ups sorted by due date

-- quote_activities
CREATE INDEX IF NOT EXISTS idx_quote_activities_entity ON quote_activities (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_quote_activities_created ON quote_activities (created_at DESC);


-- ────────────────────────────────────────────────────────────
-- 8. RLS POLICIES
--    Access matrix:
--      enquiries/quotations/quote_items/followups:
--        SELECT: all authenticated
--        INSERT/UPDATE: admin, head_of_sales, sales
--        DELETE: admin only (hard deletes prevented by business
--                rules; use status = 'superseded'/'lost' instead)
--      quote_activities:
--        SELECT: all authenticated
--        INSERT: via service_role only (API routes)
--        No UPDATE or DELETE ever
-- ────────────────────────────────────────────────────────────

-- ── enquiries ───────────────────────────────────────────────

ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "enquiries_select" ON enquiries;
CREATE POLICY "enquiries_select"
  ON enquiries FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "enquiries_insert" ON enquiries;
CREATE POLICY "enquiries_insert"
  ON enquiries FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'head_of_sales', 'sales')
    )
  );

DROP POLICY IF EXISTS "enquiries_update" ON enquiries;
CREATE POLICY "enquiries_update"
  ON enquiries FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'head_of_sales', 'sales')
    )
  );

DROP POLICY IF EXISTS "enquiries_delete" ON enquiries;
CREATE POLICY "enquiries_delete"
  ON enquiries FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ── quotations ──────────────────────────────────────────────

ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quotations_select" ON quotations;
CREATE POLICY "quotations_select"
  ON quotations FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "quotations_insert" ON quotations;
CREATE POLICY "quotations_insert"
  ON quotations FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'head_of_sales', 'sales')
    )
  );

DROP POLICY IF EXISTS "quotations_update" ON quotations;
CREATE POLICY "quotations_update"
  ON quotations FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'head_of_sales', 'sales')
    )
  );

DROP POLICY IF EXISTS "quotations_delete" ON quotations;
CREATE POLICY "quotations_delete"
  ON quotations FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ── quote_items ─────────────────────────────────────────────

ALTER TABLE quote_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_items_select" ON quote_items;
CREATE POLICY "quote_items_select"
  ON quote_items FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "quote_items_insert" ON quote_items;
CREATE POLICY "quote_items_insert"
  ON quote_items FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'head_of_sales', 'sales')
    )
  );

DROP POLICY IF EXISTS "quote_items_update" ON quote_items;
CREATE POLICY "quote_items_update"
  ON quote_items FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'head_of_sales', 'sales')
    )
  );

DROP POLICY IF EXISTS "quote_items_delete" ON quote_items;
CREATE POLICY "quote_items_delete"
  ON quote_items FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ── followups ───────────────────────────────────────────────

ALTER TABLE followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "followups_select" ON followups;
CREATE POLICY "followups_select"
  ON followups FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "followups_insert" ON followups;
CREATE POLICY "followups_insert"
  ON followups FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'head_of_sales', 'sales')
    )
  );

DROP POLICY IF EXISTS "followups_update" ON followups;
CREATE POLICY "followups_update"
  ON followups FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'head_of_sales', 'sales')
    )
  );

DROP POLICY IF EXISTS "followups_delete" ON followups;
CREATE POLICY "followups_delete"
  ON followups FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ── quote_activities ────────────────────────────────────────

ALTER TABLE quote_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_activities_select" ON quote_activities;
CREATE POLICY "quote_activities_select"
  ON quote_activities FOR SELECT TO authenticated USING (true);

-- No client INSERT policy: all writes through service_role API routes only.
-- No UPDATE or DELETE policies: append-only audit log.

-- ── accounting_settings (already enabled in Migration A) ────
-- RLS was set in Migration A; no changes needed here.

COMMIT;
