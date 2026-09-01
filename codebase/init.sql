-- ============================================================================
-- Northline Shop — schema, indexes, and seed data
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), crypt()/gen_salt()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram indexes for full-text-ish search

-- ----------------------------------------------------------------------------
-- Core relational tables
-- ----------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('user', 'admin');

CREATE TABLE users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  VARCHAR(255) NOT NULL UNIQUE,
  password_hash          VARCHAR(255) NOT NULL,
  full_name              VARCHAR(120) NOT NULL,
  phone_number           VARCHAR(20) NOT NULL,
  role                   user_role NOT NULL DEFAULT 'user',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE INDEX idx_users_role ON users (role);

CREATE TABLE categories (
  id          SERIAL PRIMARY KEY,
  slug        VARCHAR(80) NOT NULL UNIQUE,
  name        VARCHAR(120) NOT NULL,
  description TEXT
);

CREATE TABLE products (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  sku           VARCHAR(64) NOT NULL UNIQUE,
  name          VARCHAR(200) NOT NULL,
  description   TEXT NOT NULL,
  price         NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  sale_price    NUMERIC(12, 2) CHECK (sale_price IS NULL OR (sale_price >= 0 AND sale_price < price)),
  stock         INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  rating        NUMERIC(2, 1) NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  rating_count  INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  image_url     TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

-- Keeps products.updated_at current automatically so the admin products
-- grid's "Updated At" column reflects every stock/price edit without every
-- call site having to remember to set it by hand.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = (NOW() AT TIME ZONE 'utc');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE carts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE cart_items (
  id         SERIAL PRIMARY KEY,
  cart_id    UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (cart_id, product_id)
);

CREATE TABLE orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status       VARCHAR(32) NOT NULL DEFAULT 'completed'
               CHECK (status IN ('pending', 'completed', 'cancelled')),
  subtotal     NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
  tax          NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total        NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE TABLE order_items (
  id           SERIAL PRIMARY KEY,
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name VARCHAR(200) NOT NULL,
  unit_price   NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  line_total   NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
);

-- ----------------------------------------------------------------------------
-- audit_logs — unified event/impression store.
--
-- Mutation events (USER_REGISTER, LOGIN, ADD_TO_CART, UPDATE_CART,
-- REMOVE_FROM_CART, PURCHASE_COMPLETED) are written synchronously, inline
-- with the request (see src/services/audit.js -> writeAudit), often inside
-- the same DB transaction as the mutation itself.
--
-- High-volume read/impression events (PAGE_VIEW, PRODUCT_VIEW) are written
-- asynchronously by a BullMQ worker (see src/workers/auditWorker.js) so
-- tracking never adds latency to the request/response cycle.
-- ----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type    VARCHAR(64) NOT NULL,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  path          TEXT,
  referrer      TEXT,
  ip_address    VARCHAR(64),
  user_agent    TEXT,
  dwell_time_ms INTEGER CHECK (dwell_time_ms IS NULL OR dwell_time_ms >= 0),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

-- ----------------------------------------------------------------------------
-- Records the moment each admin clicks "Trigger" on a marketing script in
-- /admin#/marketing (POST /api/admin/marketing/trigger), independent of
-- whether the underlying Python subprocess later succeeds or fails. This
-- is a click-timestamp log, not a run-outcome log -- see marketingRunner's
-- in-memory run tracking (and audit_logs' ADMIN_MARKETING_TRIGGER event)
-- for status/exit-code detail per run.
-- ----------------------------------------------------------------------------
CREATE TABLE campaign_execution_time (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL,
  script_id         VARCHAR(64) NOT NULL,
  triggered_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  executed_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE INDEX idx_campaign_execution_time_run_id ON campaign_execution_time (run_id);
CREATE INDEX idx_campaign_execution_time_executed_at ON campaign_execution_time (executed_at DESC);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
CREATE INDEX idx_products_category      ON products (category_id);
CREATE INDEX idx_products_active_stock  ON products (is_active, stock);
CREATE INDEX idx_products_rating        ON products (rating);
CREATE INDEX idx_products_price         ON products (COALESCE(sale_price, price));
CREATE INDEX idx_products_name_trgm     ON products USING GIN (name gin_trgm_ops);
CREATE INDEX idx_products_desc_trgm     ON products USING GIN (description gin_trgm_ops);

CREATE INDEX idx_cart_items_cart        ON cart_items (cart_id);
CREATE INDEX idx_orders_user            ON orders (user_id, created_at DESC);
CREATE INDEX idx_order_items_order      ON order_items (order_id);

-- Required by spec: audit_logs indexed on user_id & event_type.
CREATE INDEX idx_audit_user_time        ON audit_logs (user_id, created_at DESC);
CREATE INDEX idx_audit_event_time       ON audit_logs (event_type, created_at DESC);
CREATE INDEX idx_audit_product          ON audit_logs (product_id, created_at DESC);
CREATE INDEX idx_audit_payload_gin      ON audit_logs USING GIN (payload);

-- ----------------------------------------------------------------------------
-- Seed data — 5 categories, real-world product names
-- ----------------------------------------------------------------------------
INSERT INTO categories (slug, name, description) VALUES
  ('mobile-phones', 'Mobile Phones', 'Smartphones from the world''s leading manufacturers'),
  ('clothing',      'Clothing',      'Apparel for everyday wear'),
  ('laptops',       'Laptops',       'Notebooks and ultrabooks for work and play'),
  ('audio',         'Audio',        'Headphones, earbuds, and speakers'),
  ('footwear',      'Footwear',     'Sneakers, boots, and everyday shoes');

-- Mobile Phones
INSERT INTO products (category_id, sku, name, description, price, sale_price, stock, rating, rating_count, image_url) VALUES
  (1, 'PHN-APL-15PM-256',  'iPhone 15 Pro Max 256GB',        'Apple''s titanium flagship with A17 Pro chip, 5x telephoto camera, and Action Button.', 1199.00, 1099.00, 18, 4.8, 2140, 'https://images.unsplash.com/photo-1695048133142-1a20484d2569?w=640&h=480&fit=crop'),
  (1, 'PHN-SAM-S24U-512',  'Samsung Galaxy S24 Ultra 512GB', 'Snapdragon 8 Gen 3, built-in S Pen, 200MP camera, and a titanium frame.', 1299.00, 1199.00, 22, 4.7, 1876, 'https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=640&h=480&fit=crop'),
  (1, 'PHN-GGL-P8P-128',   'Google Pixel 8 Pro 128GB',       'Tensor G3 chip with Google AI, a 50MP main sensor, and 7 years of OS updates.', 999.00, NULL, 30, 4.6, 942, 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=640&h=480&fit=crop'),
  (1, 'PHN-APL-SE3-128',   'iPhone SE (3rd Gen) 128GB',      'Compact 4.7" iPhone with the A15 Bionic chip and Touch ID at a lower price.', 429.00, 379.00, 45, 4.3, 610, 'https://images.unsplash.com/photo-1580910051074-3eb694886505?w=640&h=480&fit=crop'),
  (1, 'PHN-OPO-12-256',    'OnePlus 12 256GB',               'Snapdragon 8 Gen 3 with 100W fast charging and a Hasselblad-tuned camera system.', 799.00, NULL, 27, 4.5, 388, 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=640&h=480&fit=crop');

-- Clothing
INSERT INTO products (category_id, sku, name, description, price, sale_price, stock, rating, rating_count, image_url) VALUES
  (2, 'CLT-DNM-JKT-CLS',  'Classic Denim Jacket',        'Mid-weight stonewashed cotton denim jacket with button front and chest pockets.', 89.00, 69.00, 40, 4.4, 512, 'https://images.unsplash.com/photo-1543076447-215ad9ba6923?w=640&h=480&fit=crop'),
  (2, 'CLT-TEE-CREW-WHT', 'Essential Crewneck Tee',      'Heavyweight 100% cotton crewneck tee, unisex regular fit, pre-shrunk.', 24.00, NULL, 120, 4.2, 890, 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=640&h=480&fit=crop'),
  (2, 'CLT-HOOD-CHR-GRY', 'Fleece Pullover Hoodie',      'Brushed-back fleece hoodie with kangaroo pocket and adjustable drawstring hood.', 55.00, 44.00, 65, 4.5, 674, 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=640&h=480&fit=crop'),
  (2, 'CLT-DNM-JEAN-IND', 'Slim Fit Indigo Jeans',       'Stretch denim with a mid rise and tapered leg for an everyday slim fit.', 79.00, NULL, 55, 4.1, 421, 'https://images.unsplash.com/photo-1542272604-787c3835535d?w=640&h=480&fit=crop'),
  (2, 'CLT-JKT-PUF-BLK',  'Packable Puffer Jacket',      'Lightweight water-resistant puffer with recycled fill, packs into its own pocket.', 129.00, 99.00, 30, 4.6, 358, 'https://images.unsplash.com/photo-1544923246-77307dd654cb?w=640&h=480&fit=crop');

-- Laptops
INSERT INTO products (category_id, sku, name, description, price, sale_price, stock, rating, rating_count, image_url) VALUES
  (3, 'LAP-APL-MBP16-M3P', 'MacBook Pro 16" M3 Pro',        'Apple M3 Pro chip, 16-core GPU, Liquid Retina XDR display, up to 22 hours of battery.', 2499.00, 2299.00, 10, 4.9, 1320, 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=640&h=480&fit=crop'),
  (3, 'LAP-DEL-XPS15-i7',  'Dell XPS 15 (Intel i7, RTX 4060)', 'InfinityEdge 3.5K OLED display, 32GB RAM, RTX 4060 for creative and gaming workloads.', 1899.00, NULL, 14, 4.5, 706, 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=640&h=480&fit=crop'),
  (3, 'LAP-LEN-X1C-G11',   'Lenovo ThinkPad X1 Carbon Gen 11', 'Ultralight magnesium chassis, Intel Core i7, MIL-SPEC durability for business travel.', 1649.00, 1499.00, 16, 4.6, 533, 'https://images.unsplash.com/photo-1588872657578-7efd1f1555ed?w=640&h=480&fit=crop'),
  (3, 'LAP-ASU-ROG-G16',   'ASUS ROG Zephyrus G16',          'RTX 4070, 240Hz OLED display, and a slim aluminum chassis built for gaming.', 2099.00, 1899.00, 12, 4.4, 289, 'https://images.unsplash.com/photo-1603302576837-37561b2e2302?w=640&h=480&fit=crop'),
  (3, 'LAP-HP-SPX13-2N1',  'HP Spectre x360 13 2-in-1',      'Convertible OLED touchscreen laptop with Intel Evo certification and Bang & Olufsen audio.', 1449.00, NULL, 20, 4.3, 402, 'https://images.unsplash.com/photo-1541807084-5c52b6b3adef?w=640&h=480&fit=crop');

-- Audio
INSERT INTO products (category_id, sku, name, description, price, sale_price, stock, rating, rating_count, image_url) VALUES
  (4, 'AUD-SNY-XM5-BLK',  'Sony WH-1000XM5',              'Industry-leading noise cancellation with 30-hour battery and crystal-clear calls.', 399.00, 349.00, 34, 4.8, 3120, 'https://images.unsplash.com/photo-1583394838336-acd977736f90?w=640&h=480&fit=crop'),
  (4, 'AUD-APL-APP2-USB', 'Apple AirPods Pro (2nd Gen)',   'Adaptive Audio, active noise cancellation, and a USB-C charging case.', 249.00, 219.00, 60, 4.7, 4210, 'https://images.unsplash.com/photo-1600294037681-c80b4cb5b434?w=640&h=480&fit=crop'),
  (4, 'AUD-BOS-QC45-BLK', 'Bose QuietComfort 45',          'Balanced audio with adjustable noise cancellation and 24-hour battery life.', 329.00, NULL, 25, 4.6, 1890, 'https://images.unsplash.com/photo-1546435770-a3e426bf472b?w=640&h=480&fit=crop'),
  (4, 'AUD-JBL-FLIP6-BLU','JBL Flip 6 Portable Speaker',   'Waterproof IP67 Bluetooth speaker with punchy bass and 12-hour playtime.', 129.00, 99.00, 48, 4.5, 2260, 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=640&h=480&fit=crop'),
  (4, 'AUD-SNS-WF1000XM5','Sonos Era 100 Smart Speaker',   'Rich stereo sound with Trueplay tuning and multi-room streaming via Wi-Fi.', 249.00, NULL, 20, 4.4, 512, 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=640&h=481&fit=crop');

-- Footwear
INSERT INTO products (category_id, sku, name, description, price, sale_price, stock, rating, rating_count, image_url) VALUES
  (5, 'FTW-NKE-AF1-WHT',  'Nike Air Force 1 ''07',        'The iconic basketball-original silhouette in classic white leather.', 115.00, NULL, 70, 4.8, 5230, 'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=640&h=480&fit=crop'),
  (5, 'FTW-ADI-UB22-BLK', 'Adidas Ultraboost 22',         'Responsive Boost midsole with a Primeknit upper for all-day running comfort.', 190.00, 149.00, 38, 4.6, 2870, 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=640&h=480&fit=crop'),
  (5, 'FTW-CNV-CTAS-BLK', 'Converse Chuck Taylor All Star', 'The timeless canvas high-top sneaker with a rubber toe cap and vulcanized sole.', 65.00, 55.00, 90, 4.5, 4120, 'https://images.unsplash.com/photo-1607522370275-f14206abe5d3?w=640&h=480&fit=crop'),
  (5, 'FTW-NKE-PGSY-GRY', 'Nike Pegasus 40 Running Shoe',  'Responsive React foam cushioning designed for daily training miles.', 130.00, NULL, 42, 4.4, 1560, 'https://images.unsplash.com/photo-1595341888016-a392ef81b7de?w=640&h=480&fit=crop'),
  (5, 'FTW-TIM-6IN-WHT',  'Timberland 6-Inch Premium Boot','Waterproof nubuck leather boot with padded collar and rugged lug outsole.', 198.00, 169.00, 25, 4.7, 1980, 'https://images.unsplash.com/photo-1520639888713-7851133b1ed0?w=640&h=480&fit=crop');

-- Demo account: demo@shop.local / Password123!
INSERT INTO users (email, password_hash, full_name, phone_number, role) VALUES
  (
    'demo@shop.local',
    crypt('Password123!', gen_salt('bf')),
    'Demo Shopper',
    '+1-555-010-1234',
    'user'
  );

-- ----------------------------------------------------------------------------
-- Bootstrap admin account.
--
-- SECURITY NOTE (read before deploying anywhere near production):
-- This account exists only so there is *one* way into /admin on a brand
-- new database. gen_salt('bf', 12) is pgcrypto's bcrypt implementation at
-- 12 rounds -- the same cost factor src/routes/auth.js uses for bcrypt.hash()
-- at registration, so this hash is byte-for-byte interchangeable with the
-- app's own password hashing.
--
-- Because the plaintext below necessarily lives in source control, treat
-- this email/password pair as compromised on day one. Rotate the password
-- immediately via POST /api/auth/change-password, or better, delete this
-- INSERT and provision admins via `UPDATE users SET role = 'admin' WHERE
-- email = '...'` after normal registration, before any non-local
-- deployment. Nothing in the API enforces a rotation for you.
-- ----------------------------------------------------------------------------
INSERT INTO users (email, password_hash, full_name, phone_number, role) VALUES
  (
    'admin@northline.shop',
    crypt('AdminSecure#2026!', gen_salt('bf', 12)),
    'Platform Administrator',
    '+1-555-010-9999',
    'admin'
  );

-- Durable state for the Admin Marketing Automation approval workflow.
CREATE TABLE IF NOT EXISTS marketing_workflow_runs (
  run_id UUID PRIMARY KEY,
  script_id VARCHAR(64) NOT NULL,
  triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  campaign_name TEXT NOT NULL DEFAULT '',
  campaign_details TEXT NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL,
  approval_status VARCHAR(32) NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_workflow_runs_updated_at
  ON marketing_workflow_runs (updated_at DESC);
