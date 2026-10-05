-- Phase 9 (load test): KOT numbers come from a sequence on PostgreSQL.
--
-- They used to be max("number") + 1 read inside the SERIALIZABLE order
-- transaction; concurrent kitchen orders at one outlet then aborted each other
-- (read/write dependency cycles, P2034). nextval() takes no predicate lock and
-- never rolls back, so concurrent placements no longer conflict. Numbers stay
-- unique per outlet (@@unique([outletId, number]) is unchanged); a rolled-back
-- order may leave a gap, which is harmless for kitchen tickets (tax invoice
-- numbers do NOT use this and stay gap-free).
-- Additive and idempotent: no table is touched, existing numbers are kept.
CREATE SEQUENCE IF NOT EXISTS "kot_number_seq" AS INTEGER START WITH 1 MINVALUE 1;
SELECT setval('"kot_number_seq"', COALESCE((SELECT MAX("number") FROM "Kot"), 0) + 1, false);
