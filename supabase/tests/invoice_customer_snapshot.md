# Staging check — invoice customer snapshot (run after `invoice_customer_snapshot.sql`)

The trigger/constraint/legacy logic is covered by `invoice_customer_snapshot.pglite.mjs` (22 checks).
The two issuing RPCs need the full GL schema, so verify them once on staging:

1. **Legacy backfill** (read-only):
   ```sql
   select count(*) filter (where invoice_customer_snapshot_source = 'legacy_order_snapshot') as legacy,
          count(*) filter (where (invoice_journal_entry_id is not null or nullif(btrim(coalesce(invoice_number,'')),'') is not null)
                             and invoice_customer_snapshot_at is null) as issued_without_snapshot
   from orders;
   ```
   Expect `issued_without_snapshot = 0`.

2. **Issue through the real RPC.** Pick a staging order with a linked customer and no invoice, advance it
   (Deposit Paid for a cash order, Quote Approved for a credit order). Then:
   ```sql
   select invoice_number, invoice_customer_name_snapshot, invoice_customer_snapshot_source, invoice_customer_snapshot_at
   from orders where id = '<order id>';
   ```
   Expect source `customer_at_issue` and the customer's name at that moment.

3. **Rename, then regenerate.** Rename that customer in the Customers tab. Download the invoice PDF from
   CRM → Invoices and from the order page. Both must still show the OLD name and address.

4. **Immutability.**
   ```sql
   update orders set invoice_customer_name_snapshot = 'x' where id = '<order id>';   -- must raise INVOICE_SNAPSHOT_IMMUTABLE
   ```

5. **Atomic failure** (optional): temporarily rename account code 1100 in `accounting_accounts`, try to advance a fresh
   order — the RPC raises, and the order must still have `invoice_number` NULL and no snapshot. Restore the code.
