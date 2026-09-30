# ERP Backend (Automation Company)

NestJS 11 on Fastify, Prisma on PostgreSQL. Money is PKR, stored as `Decimal(18,2)` and returned as strings.
The API is stateless and deployed on its own. The web, desktop and mobile apps use the generated OpenAPI client (Orval).

- Swagger UI: `/docs`. OpenAPI 3.1 JSON: `/openapi.json`. Health check: `/health`.
- All routes live under `/api/v1`. Errors are RFC 7807 `application/problem+json`.
- Payments, quotation approval, goods receipts and vendor payments require an `Idempotency-Key` header.

## Local setup (no Docker needed)

```bash
corepack enable                 # Yarn 4
yarn install
cp .env.example .env
yarn db:local                   # terminal 1: embedded PostgreSQL on :5433 (data in .data/pg)
yarn prisma migrate deploy      # terminal 2
yarn db:seed --demo             # admin user, roles, chart of accounts, demo products/clients
yarn dev                        # http://localhost:4000/docs
```

If you have Docker, run `docker compose up -d postgres minio` instead of `yarn db:local`.
Postgres runs on `:5433`. MinIO runs on `:9000`, with its console on `:9001`.

Default login: `admin@erp.local` / `Admin@12345` (set by `SEED_ADMIN_*`). Change it after the first login.

## Scripts

| Script | Purpose |
| --- | --- |
| `yarn dev` | Watch mode |
| `yarn build` / `yarn start` | Compile to `dist/`, then run it |
| `yarn test` | Unit tests (quotation calculator) |
| `API_URL=http://localhost:4000 yarn test:e2e` | Full business workflow against a running API |
| `yarn openapi:export` | Writes `openapi.json`. The frontend's Orval config reads this file or `/openapi.json`. |
| `yarn db:migrate` | Create or apply a migration during development |
| `yarn db:seed [--demo]` | Idempotent seed |

## Accounting model

Every financial event posts a balanced double-entry journal. Client, site, project and vendor ledgers,
balances and aging are all derived from these journals. Corrections reverse the original entry and void it; nothing is deleted.

| Event | Journal |
| --- | --- |
| Quotation approved (`receivableOn=APPROVAL`, the default) | Dr AR / Cr Sales, Tax, charge income |
| Invoice issued (ADDITIONAL, or `receivableOn=INVOICE`) | Dr AR / Cr Sales or Other Income, Tax |
| PO sent to vendor | Dr Inventory / Cr AP |
| Delivery to site | Dr COGS / Cr Inventory (at the cost captured in the quotation) |
| Client payment | Dr Cash/Bank / Cr AR (per project allocation; any unallocated amount is held on the client) |
| Vendor payment | Dr AP / Cr Cash/Bank |
| Expense | Dr expense account / Cr Cash/Bank |
| Stock adjustment | Dr/Cr Inventory against Equity or Other Expense |

## Deployment (free tier)

- **API**: Render free web service using `render.yaml` (Docker). On start it runs `prisma migrate deploy` and the base seed.
- **Database**: Neon Postgres. Use the pooled connection string with `sslmode=require`.
- **Files and backups**: Cloudflare R2 (`STORAGE_DRIVER=s3`).
- **Scheduled jobs**: `.github/workflows/cron.yml` calls `POST /api/v1/system/jobs` every hour with `X-Cron-Secret`.
  Set the repo secrets `API_URL` and `CRON_SECRET`. The free instance sleeps when idle, and each call also wakes it.
- **CI**: `.github/workflows/ci.yml` builds, runs the unit and e2e tests against Postgres, and publishes `openapi.json`.
