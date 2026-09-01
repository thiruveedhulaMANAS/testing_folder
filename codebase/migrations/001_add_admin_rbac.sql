-- ============================================================================
-- Migration: 001_add_admin_rbac
-- For databases that already exist and were created before the admin
-- dashboard feature. A brand new database created via init.sql already has
-- this shape and does not need this file.
--
-- Safe to run more than once.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('user', 'admin');
  END IF;
END$$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'user';

-- Drops the forced-password-change flag from any deployment that already
-- ran an earlier version of this migration; the gate it powered has been
-- removed from requireAdmin.
ALTER TABLE users
  DROP COLUMN IF EXISTS must_change_password;

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc');

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = (NOW() AT TIME ZONE 'utc');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Bootstrap an admin only if one doesn't already exist, so re-running this
-- migration never overwrites an operator's own admin account. Rotate this
-- password immediately -- nothing in the API enforces that for you.
INSERT INTO users (email, password_hash, full_name, phone_number, role)
SELECT
  'admin@northline.shop',
  crypt('AdminSecure#2026!', gen_salt('bf', 12)),
  'Platform Administrator',
  '+1-555-010-9999',
  'admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
