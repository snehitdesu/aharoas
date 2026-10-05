-- RESTORA PostgreSQL roles, privileges and session safety limits.
--
-- Run ONCE per database as a superuser / the cloud "admin" role, AFTER the
-- first `npm run db:pg:deploy` (so the tables exist), and again after any
-- migration that adds tables if default privileges were not in effect:
--
--   psql "postgresql://admin@db-host/restora" -v ON_ERROR_STOP=1 \
--        -v owner_password="'...'" -v app_password="'...'" -v backup_password="'...'" \
--        -f scripts/ops/pg-roles.sql
--
-- Roles:
--   restora_owner  owns the schema; `prisma migrate deploy` runs as this role ONLY.
--   restora_app    the web app's DATABASE_URL: data access (DML) only — cannot
--                  create/alter/drop tables, and cannot UPDATE/DELETE/TRUNCATE the
--                  append-only AuditLog and InventoryLedger (verified: the app
--                  never does; the database now enforces it).
--   restora_backup pg_dump / monitoring: read-only (pg_read_all_data, PG 14+).
--
-- Session limits on restora_app (a runaway query or a stuck transaction cannot
-- hold locks / connections forever; the app's own interactive transactions time
-- out after 20 s):
--   statement_timeout 60s, lock_timeout 10s, idle_in_transaction_session_timeout 60s.

\set ON_ERROR_STOP on

SELECT current_database() AS db \gset

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restora_owner') THEN CREATE ROLE restora_owner LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restora_app') THEN CREATE ROLE restora_app LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restora_backup') THEN CREATE ROLE restora_backup LOGIN; END IF;
END $$;

ALTER ROLE restora_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :owner_password;
ALTER ROLE restora_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :app_password;
ALTER ROLE restora_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :backup_password;
GRANT pg_read_all_data TO restora_backup;

-- Ownership: the schema and every existing table / sequence belong to restora_owner.
ALTER SCHEMA public OWNER TO restora_owner;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO restora_owner', r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO restora_owner', r.sequence_name);
  END LOOP;
END $$;

-- Nobody else may create objects in public; the app only uses it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO restora_owner, restora_app;
GRANT CONNECT ON DATABASE :"db" TO restora_backup;
GRANT USAGE ON SCHEMA public TO restora_app, restora_backup;

-- App: DML on all tables (current and future ones created by restora_owner).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restora_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restora_app;
ALTER DEFAULT PRIVILEGES FOR ROLE restora_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO restora_app;
ALTER DEFAULT PRIVILEGES FOR ROLE restora_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO restora_app;

-- Append-only records: enforced by the database, not just the code.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog", "InventoryLedger" FROM restora_app;
-- Migration history is the owner's: the app only reads it (readiness check).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "_prisma_migrations" FROM restora_app;

-- Session safety limits for the app role (take effect on new connections).
ALTER ROLE restora_app SET statement_timeout = '60s';
ALTER ROLE restora_app SET lock_timeout = '10s';
ALTER ROLE restora_app SET idle_in_transaction_session_timeout = '60s';
-- Migrations may legitimately run long (index builds); only bound lock waits.
ALTER ROLE restora_owner SET lock_timeout = '30s';
