# Northline Shop (e-commerce platform)

Enterprise-grade multi-category store — **Mobile Phones, Clothing, Laptops, Audio, Footwear** — with JWT auth, persistent carts, atomic transactional checkout with row-level stock locking, full-text-ish product search with multi-facet filtering, and a comprehensive, async user-event audit system.

## Stack

- Node.js 20 + Express REST API
- PostgreSQL 16 (UUID keys, FK constraints, `pg_trgm` search, transactions)
- Redis 7 + BullMQ (async audit/impression event pipeline)
- Docker Compose (API + Postgres + Redis + background worker)

## Start locally

```bash
docker compose up --build
```

Open [http://localhost:3080](http://localhost:3080).

Host ports: API **3080**, Postgres **5433**, Redis **6380** (avoids colliding with local installs). Containers talk to each other over the compose network as `db:5432` / `redis:6379`.

Seeded demo account:

- Email: `demo@shop.local`
- Password: `Password123!`

Postgres init runs **only** on an empty volume. To re-seed from `init.sql`:

```bash
docker compose down -v
docker compose up --build
```

## Services

| Container      | Role                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `db`           | PostgreSQL 16, seeded from `init.sql` on first boot                   |
| `redis`        | Cache + BullMQ broker                                                 |
| `api`          | Express API + static storefront                                       |
| `audit-worker` | Drains the `audit-events` BullMQ queue and writes impressions to Postgres |

## Catalog

5 categories seeded with real-world products, prices, stock, ratings, and CDN image URLs, e.g.:

- **Mobile Phones** — iPhone 15 Pro Max, Samsung Galaxy S24 Ultra, Google Pixel 8 Pro
- **Laptops** — MacBook Pro 16" (M3 Pro), Dell XPS 15, Lenovo ThinkPad X1 Carbon
- **Audio** — Sony WH-1000XM5, Apple AirPods Pro (2nd Gen), Bose QuietComfort 45
- **Clothing** — Classic Denim Jacket, Essential Crewneck Tee, Fleece Pullover Hoodie
- **Footwear** — Nike Air Force 1 '07, Adidas Ultraboost 22, Timberland 6-Inch Boot

## API

| Method | Path                          | Auth | Notes |
| ------ | ----------------------------- | ---- | ----- |
| GET    | `/api/health`                 | no   | DB ping |
| POST   | `/api/auth/register`          | no   | `{ email, password, fullName }` |
| POST   | `/api/auth/login`             | no   | `{ email, password }` |
| GET    | `/api/auth/me`                | JWT  | Current user |
| POST   | `/api/auth/change-password`   | JWT  | `{ currentPassword, newPassword }` |
| GET    | `/api/categories`             | no   | Category list (Redis-cached, 60s) |
| GET    | `/api/products`               | no   | Query: `category`, `category_id`, `q`, `min_price`, `max_price`, `min_rating`, `in_stock=true`, `sort=price_asc\|price_desc\|rating` |
| GET    | `/api/products/:id`           | no*  | Detail; fires an async `PRODUCT_VIEW` audit event |
| GET    | `/api/cart`                   | JWT  | Persistent cart |
| POST   | `/api/cart/items`             | JWT  | `{ productId, quantity }` |
| PATCH  | `/api/cart/items/:productId`  | JWT  | `{ quantity }` |
| DELETE | `/api/cart/items/:productId`  | JWT  | Remove line |
| POST   | `/api/checkout`               | JWT  | Atomic purchase, row-level stock locking |
| GET    | `/api/orders`                 | JWT  | Order history |
| GET    | `/api/orders/:id`             | JWT  | Order detail |
| POST   | `/api/track/page-view`        | no*  | SPA navigation beacon (`sendBeacon`) |
| POST   | `/api/track/dwell`            | no*  | Product dwell-time beacon on navigate-away |

\* "no" auth-required routes still attribute the request to a logged-in user (via `optionalAuth`) when a valid bearer token is present, for accurate audit attribution.

Send `Authorization: Bearer <token>` after login/register.

### Search & multi-facet filtering

`GET /api/products?q=...` matches product name/description via `ILIKE` plus **`pg_trgm`** trigram similarity (GIN-indexed), so it tolerates partial and fuzzy matches, not just exact substrings. Combine with any of:

- `min_price` / `max_price` — price range (against sale price when active)
- `category` / `category_id` — category facet
- `in_stock=true` — stock-availability facet
- `min_rating` — ratings facet (`4.5`, `4`, etc.)
- `sort` — `price_asc`, `price_desc`, `rating`, or relevance (default)

### Checkout (atomic, race-safe)

Inside one database transaction the API:

1. Locks the cart's line items **and their product rows** with `SELECT ... FOR UPDATE OF p, ci`, so two concurrent checkouts against the same limited-stock SKU serialize instead of both reading stale stock.
2. Rejects the purchase with `409` if any SKU lacks sufficient stock at the time the lock is acquired.
3. Inserts `orders` + `order_items` with 8% tax.
4. Decrements `products.stock`.
5. Clears `cart_items`.
6. Writes `PURCHASE_COMPLETED` to `audit_logs`, in the same transaction.

Verified locally: firing two simultaneous checkouts against a SKU with insufficient combined stock, one commits and the other is correctly rejected with the up-to-date `available` count — no overselling.

### Audit & event logging

`audit_logs` captures **every** read and mutation event, split into two paths:

**Synchronous (critical, low-volume mutations)** — written inline, sometimes inside the same DB transaction as the mutation itself, via `writeAudit()`:
`USER_REGISTER`, `LOGIN`, `ADD_TO_CART`, `UPDATE_CART`, `REMOVE_FROM_CART`, `PURCHASE_COMPLETED`.

**Asynchronous (high-volume impressions)** — enqueued onto a Redis-backed **BullMQ** queue via `trackEvent()` and persisted out-of-band by the `audit-worker` process, so tracking never adds latency to the request/response cycle:
`PAGE_VIEW` (HOME, CATEGORY_LIST, CART, CHECKOUT, ORDERS — captured automatically by global middleware `src/middleware/pageImpression.js`, plus explicit SPA-navigation beacons from the frontend) and `PRODUCT_VIEW` (fired on every `GET /api/products/:id`, with `dwell_time_ms` reported afterward via a `sendBeacon` call when the shopper navigates away).

Every row stores `user_id`, `event_type`, `product_id`, `category_id`, `path`, `referrer`, `ip_address`, `user_agent`, `dwell_time_ms`, a JSON `payload`, and UTC `created_at`. Indexed on `(user_id, created_at)` and `(event_type, created_at)` per spec, plus `product_id` and a GIN index on `payload`.

```sql
SELECT event_type, user_id, product_id, dwell_time_ms, created_at
FROM audit_logs
ORDER BY id DESC
LIMIT 50;
```

## Admin Dashboard

A `/admin` SPA (Users, Products, Orders, Marketing Automation) sits alongside the storefront, backed by `/api/admin/*` routes guarded end-to-end by role-based access control.

### Access & first login

The database is seeded with one bootstrap admin account:

- Email: `admin@northline.shop`
- Password: `AdminSecure#2026!`

**This password is in source control and must be treated as compromised.** Logging in with it grants immediate admin access — there is no forced password-change gate. Rotate it yourself as soon as you're evaluating this beyond your own machine:

```bash
# 1. Log in with the seeded credentials
curl -X POST localhost:3080/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@northline.shop","password":"AdminSecure#2026!"}'

# 2. Rotate the password using the token from step 1 (POST /api/auth/change-password
#    is available to any authenticated user, admin or not)
curl -X POST localhost:3080/api/auth/change-password \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"currentPassword":"AdminSecure#2026!","newPassword":"<your own strong password>"}'
```

For anything beyond local evaluation, delete the seed `INSERT` in `init.sql`/`migrations/001_add_admin_rbac.sql` entirely and instead promote a normal, self-registered account:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@yourcompany.com';
```

### RBAC design

- `users.role` is a Postgres `ENUM ('user', 'admin')`, defaulting to `'user'`. Registration never accepts a client-supplied role.
- `requireAdmin` (`src/middleware/auth.js`) guards every `/api/admin/*` route. It re-checks the role against the database on every request rather than trusting the JWT's `role` claim, so a demotion or account deletion takes effect immediately instead of waiting for the token (`JWT_EXPIRES_IN`, 7 days by default) to expire.
- Any denied attempt — unauthenticated, wrong role, or a stale token for a deleted user — writes an `ADMIN_ACCESS_DENIED` row to `audit_logs` and returns a generic `403` (no detail on *why*, to avoid leaking account existence).
- `/admin` itself is an unauthenticated static route; `admin.js` calls `GET /api/auth/me` client-side and shows an "Admins only" screen for anyone who isn't an admin. That's UX only — the actual boundary is server-side `requireAdmin` on every API call.

### Users, Products, Orders

- `GET /api/admin/users` — paginated, `q` (name/email substring) and `role` filters, `totalOrders` per user via a join.
- `PATCH /api/admin/users/:id/role` — promote/demote; blocks an admin from demoting themselves.
- `GET/POST/PATCH/DELETE /api/admin/products` — full CRUD; `DELETE` is a soft delete (`is_active = false`) since `order_items.product_id` has `ON DELETE RESTRICT` and a hard delete would also erase the historical record on past orders. `stock < 10` is flagged `lowStock` in every response.
- `GET /api/admin/orders` + `GET /api/admin/orders/kpis` — paginated grid plus total revenue / active orders / average order value, computed directly from `orders`.

### Marketing Automation

`POST /api/admin/marketing/trigger` starts a fixed Python 3 worker (`scripts/marketing/workflow_backend.py`) through `src/services/marketingRunner.js`. The Node backend owns the durable run/approval state; the Python worker performs the pipeline and AAVA call, emits the AAVA result, and exits without waiting for the administrator. The browser receives live stdout/stderr over an authenticated fetch-based Server-Sent Events stream (`GET /api/admin/marketing/stream/:runId`) and uses `POST /api/admin/marketing/runs/:runId/approve` or `/reject` for the approval decision. After AAVA reports SUCCESS, the worker reads and verifies the latest `Content/Content.txt` generated by the AAVA workflow; that GitHub file is the single source of truth displayed in the AAVA approval panel. Rejection triggers a new AAVA attempt and the newly generated `Content/Content.txt` is verified before display. The AAVA response formatter is not part of the workflow. `GET /api/admin/marketing/pipeline` returns the pipeline's label/description for display; campaign name and details are optional.

The pipeline runs 4 hard-gated stages — a failure at any stage halts the run and no downstream stage executes:

1. `fetch_data.py` — exports every DB table to `scripts/marketing/database_export/*.csv` (via its own `MARKETING_DATABASE_URI`, not the app's `DATABASE_URL`), plus a filtered `audit_logs_product_views.csv` of the last 7 days of product-view/cart events. `password_hash` is stripped from the `users` export before anything is written to disk.
2. `utils/file_checker.py` — verifies every expected file is present and was written in the last 5 minutes; refuses to continue otherwise.
3. `github_writer.py` — syncs `database_export/` to an external GitHub repo (`GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME`) using `GITHUB_PAT`, deleting and re-uploading until the local and remote contents match.
4. `backend/api_client.py` — submits the AAVA Marketing Agent workflow with no uploaded files and no file-based user inputs (`AAVA_API_BASE`, `MARKETING_PIPELINE_ID`) and polls until it returns SUCCESS. The worker then reads the latest AAVA-generated `Content/Content.txt` from GitHub, emits it to Node, and exits; it does not wait for browser approval.

Security-relevant details:

- **Script identity is fixed**, not a client-supplied path — the trigger endpoint takes no filename or script choice from the request. There is no way to make this endpoint execute anything other than `workflow_backend.py`.
- `spawn()` is called with `shell: false`; campaign name/details are passed as ordinary argv values, never shell-interpolated.
- The child process gets a minimal, explicit environment — **not** a copy of the API's `process.env` — so `DATABASE_URL`, `JWT_SECRET`, and `REDIS_URL` never reach the Python script. It only receives the vars explicitly listed in `config/env.js`'s `marketingScriptEnv` (see `.env.example`): `MARKETING_DATABASE_URI`, `GITHUB_PAT`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `AAVA_API_BASE`, `AAVA_REALM_ID`, `AAVA_BEARER_TOKEN`, `AAVA_USER`, `MARKETING_PIPELINE_ID`. None of these have a hardcoded fallback in the Python source — an unset var fails the run immediately with a clear error naming it.
- Runs are capped at `MAX_CONCURRENT_RUNS = 3`; the AAVA status polling has no workflow timeout and continues until AAVA reports SUCCESS or FAILED.
- Every trigger writes an `ADMIN_MARKETING_TRIGGER` audit row (who, run id).

**Before pointing this at real data**, note that stage 1 exports full table contents (minus `password_hash`) and stage 3 pushes them to an external GitHub repo — treat `GITHUB_PAT` as giving that repo owner read access to your store's customer/order data, and scope/rotate it accordingly. `scripts/marketing/requirements.txt` lists the Python packages the pipeline needs (`pandas`, `SQLAlchemy`, `psycopg2-binary`, `PyGithub`, `requests`); the Dockerfile installs them, and local (non-Docker) runs need `pip install -r scripts/marketing/requirements.txt` once.

### RBAC migration for an existing deployment

`init.sql` only runs against a brand-new Postgres volume. If you already have this stack running, apply the migration instead:

```bash
psql "$DATABASE_URL" -f migrations/001_add_admin_rbac.sql
psql "$DATABASE_URL" -f migrations/002_add_campaign_execution_time.sql
psql "$DATABASE_URL" -f migrations/003_remove_campaign_segment_discount.sql
psql "$DATABASE_URL" -f migrations/004_add_marketing_workflow_runs.sql
```

It's additive and idempotent (`ADD COLUMN IF NOT EXISTS`, etc.) — safe to run more than once, and it only seeds the bootstrap admin if no admin exists yet, so it won't disturb one you've already created.

## Validation performed for the marketing workflow

The delivered build was validated in this environment with static checks and isolated lifecycle tests. A live Postgres/AAVA/GitHub/Docker integration run was not possible here because those services and credentials are not available in the build environment.

- Every JavaScript source file passed `node --check`.
- Every Marketing Automation Python source file passed Python compilation.
- The Node marketing-runner lifecycle was exercised with a controlled worker: first AAVA result → awaiting approval → reject → AAVA-only regeneration → awaiting approval → approve → GitHub Content.txt-backed email delivery.
- The Python full-pipeline control flow was exercised with controlled stage implementations: campaign TXT creation occurs before `fetch_data`, no files are uploaded to the AAVA call, and the AAVA workflow-generated reviewable payload is read from GitHub at `Content/Content.txt` without applying a freshness/version check.
- The Python AAVA-only regeneration path was exercised independently and does not require `MARKETING_RUN_ID`.
- AAVA response parsing was exercised for string, dictionary, list, and fenced-JSON content without calling string-only methods on structured values.
- The authenticated browser stream uses `fetch()` rather than `EventSource`, because the application's JWT is stored in localStorage and native `EventSource` cannot send the required Authorization header.

## Run without Docker

1. Create a Postgres database and run `init.sql` (requires the `pgcrypto` and `pg_trgm` extensions, both created by the script).
2. Start Redis locally (`redis-server`).
3. Copy `.env.example` to `.env` and set `DATABASE_URL` / `JWT_SECRET` / `REDIS_URL`. To use the admin Marketing Automation panel, also set the `MARKETING_*`/`GITHUB_*`/`AAVA_*` vars documented there — the pipeline fails fast with a clear error if any are missing, rather than falling back to a hardcoded value.
4. `npm install`, then `pip install -r scripts/marketing/requirements.txt` (only needed for the Marketing Automation panel; Docker does this automatically).
5. `npm start` — runs the API
6. `npm run worker` — runs the audit-event worker (separate process/terminal)

## Layout

```
init.sql                    schema, indexes, seed catalog (5 categories), RBAC + bootstrap admin
migrations/                  001_add_admin_rbac.sql, 002_add_campaign_execution_time.sql,
                              003_remove_campaign_segment_discount.sql, 004_add_marketing_workflow_runs.sql — idempotent migrations for existing DBs
docker-compose.yml           db + redis + api + audit-worker
Dockerfile                   node:20-alpine + python3/pip (installs scripts/marketing/requirements.txt)
scripts/marketing/           workflow_backend.py pipeline spawned by the admin Marketing panel (see README above)
src/config                   env, Postgres pool, Redis client(s)
src/middleware                JWT auth (+ optionalAuth, requireAdmin), page-impression logger, errors
src/routes                    auth, catalog, cart, checkout, orders, track
src/routes/admin              users, products, orders, marketing — all guarded by requireAdmin
src/services                   audit (sync + async), cart, checkout, cache, session, product mapping
src/services/marketingRunner.js  spawns/streams the workflow_backend.py pipeline
src/queues/auditQueue.js       BullMQ queue producer
src/workers/auditWorker.js     BullMQ queue consumer -> Postgres
public/                        storefront (search, facet filters, ratings, tracking beacons)
public/admin.html, admin.js, admin.css   admin dashboard SPA
```

## Approved Marketing Email Delivery

After an administrator approves the AAVA response, the Node.js marketing runner invokes `scripts/marketing/email_sender.py`. The sender reads the latest approved data from GitHub `Content/Content.txt` and processes every valid `email.email_address` in that output.

Configure Gmail SMTP credentials through environment variables only:

```env
APP_PASSWORD=your_gmail_app_password
SENDER_EMAIL=your_sender_email@example.com
```

Do not commit `.env` or `marketing_output.json`. Real credentials must never be placed in source code, logs, or GitHub.
