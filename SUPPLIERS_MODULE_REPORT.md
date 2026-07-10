# Suppliers Module — Completion Report
**Date:** 2026-07-09  
**Built by:** Claude (Cowork session)

---

## What was built

### One action required from you first
Before the module works, run the SQL migration in your Supabase dashboard:

**Supabase Dashboard → SQL Editor → paste and run:**
`supabase/migrations/suppliers_module.sql`

You also need to create the storage bucket manually in Supabase Dashboard → Storage → New bucket:
- Name: `supplier-files`
- Public: OFF

---

## Files created

| File | Purpose |
|------|---------|
| `supabase/migrations/suppliers_module.sql` | Creates `suppliers`, `supplier_purchases`, `supplier_attachments` tables with RLS policies |
| `app/api/suppliers/route.js` | GET list, POST create |
| `app/api/suppliers/[id]/route.js` | GET single, PATCH update, DELETE |
| `app/api/purchases/route.js` | GET list (with optional ?supplier_id filter), POST create |
| `app/api/purchases/[id]/route.js` | GET single, PATCH update, DELETE |
| `modules/suppliers/config.js` | Nav config — adds "Suppliers 🏭" to top nav |
| `modules/suppliers/components/SuppliersModule.js` | Full page UI |
| `app/suppliers/page.js` | Next.js page route |
| `modules/registry.js` | Updated — suppliers added to nav |

---

## What the module does

### Suppliers tab
- List of all suppliers with name, contact, phone, materials supplied
- Expandable card shows full profile + a mini purchase history
- "Add Purchase" shortcut from within the supplier card
- Add / Edit / Delete supplier via modal form
- Search by name, contact, phone, materials, notes

### Purchases tab
- Summary bar: total spend, total paid, outstanding balance, count of unpaid bills
- Each purchase shows supplier, date, items bought, amount, and payment status badge
- Expandable detail: full breakdown including linked customer order, balance, notes
- Filters: by status (Unpaid / Part Paid / Paid) and by supplier
- Search across supplier name, order number, items bought, notes

### Purchase form
- Supplier selector (required)
- Optional link to a customer order (pulls from live orders list)
- Purchase date
- Items bought (free text)
- Total amount + Amount paid → balance and status calculated live in the form
- Payment status is auto-derived — never set manually (Unpaid / Part Paid / Paid)
- Notes

---

## Access control

| Role | Suppliers | Purchases |
|------|-----------|-----------|
| admin | Read + Write + Delete | Read + Write + Delete |
| production_manager | Read + Write | Read + Write |
| head_of_sales | Read + Write | Read + Write |
| sales | Read only | Read only |
| viewer / production_staff | Read only | Read only |

Deleting a supplier with existing purchases is blocked by the API (returns a 409 error with count).

---

## Database schema summary

```sql
suppliers (
  id, name, contact_person, phone, email,
  materials_supplied, notes, created_at, created_by
)

supplier_purchases (
  id, supplier_id → suppliers,
  order_id → orders (nullable),
  purchase_date, items_bought,
  total_amount, invoice_path, invoice_name,
  amount_paid, payment_status CHECK IN ('Unpaid','Part Paid','Paid'),
  notes, created_at, created_by,
  CONSTRAINT paid ≤ total
)
```

---

## Known limitation
Invoice attachment upload (uploading a PDF file to storage) is not yet wired — the `invoice_path` and `invoice_name` fields exist in the DB and API but there is no file upload button in the UI yet. This can be added in the next session alongside the broader document upload pattern.
