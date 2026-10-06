# v3b concurrency test (run on staging, two sessions)

pglite and unit tests are single-connection, so they cannot prove the lock. Prove it on staging with two SQL sessions.

Setup (once): pick one employee with two active assignments (A on job 1, B on job 2) and a date with no entries. Note `a_id`, `b_id`, the date, and any admin user id.

**Session 1**
```sql
BEGIN;
SELECT record_time_entry('<a_id>', '<date>', 0.6, false, NULL, NULL, true, '<user_id>', '<today>');
-- leave the transaction OPEN
```

**Session 2** (while session 1 is still open)
```sql
SELECT record_time_entry('<b_id>', '<date>', 0.6, false, NULL, NULL, true, '<user_id>', '<today>');
```

Expected with v3b: session 2 WAITS (blocked on the advisory lock). Now in session 1 run `COMMIT;`.
Session 2 then returns an error: `That worker already has 0.6 of a day booked on <date> — a day cannot exceed 1.00`.

Without v3b, session 2 returns immediately and succeeds, giving 1.2 days — the bug.

Cleanup: void the one entry created (admin `transition_time_entry(..., 'void', ...)`).
