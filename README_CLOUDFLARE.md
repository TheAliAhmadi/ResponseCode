# Pair Reviewer Cloudflare Deployment Guide

This document describes the Cloudflare-ready architecture for the online multi-reviewer annotation system.

## Architecture

- Frontend: React/Vite in [client/](client) (deploy to Cloudflare Pages)
- API: Cloudflare Worker in [worker/](worker)
- Database: Cloudflare D1 (`pairs`, `reviewers`, `judgments`)
- Source control/deploy source: GitHub repo
- Optional protection: Cloudflare Access (recommended)

## What Is Kept vs Replaced

Kept:
- [client/](client) frontend, now updated to call Worker API routes
- [setup.py](setup.py) as local sampling/builder utility
- [working_pairs.db](working_pairs.db) as local source for web-safe export

Replaced for cloud runtime:
- FastAPI backend in [server/main.py](server/main.py) (legacy local-only)
- Streamlit app in [app.py](app.py) (legacy local-only)

## Database Schema

- Canonical schema: [worker/schema.sql](worker/schema.sql)
- Migration: [worker/migrations/0001_initial.sql](worker/migrations/0001_initial.sql)

Tables:
- `pairs`: web-safe pair records only
- `reviewers`: reviewer identities
- `judgments`: one judgment per reviewer per pair via `UNIQUE(pair_id, reviewer_id)`

## Reviewer Identity

Worker identity order:
1. Cloudflare Access email header (`cf-access-authenticated-user-email`)
2. Local dev header `X-Dev-Reviewer-Email` (only when `APP_MODE` is not prod)
3. `DEV_REVIEWER_EMAIL` env var (only when `APP_MODE` is not prod)

Admin endpoints require reviewer email to be present in `ADMIN_EMAILS`.

## Environment and Config

Configure in [worker/wrangler.toml](worker/wrangler.toml):

- D1 binding: `DB`
- `ADMIN_EMAILS` comma-separated list
- `DEV_REVIEWER_EMAIL`
- `APP_MODE` (`dev` or `prod`)

For local Wrangler runs, you can also copy [worker/.dev.vars.example](worker/.dev.vars.example) to `.dev.vars` and set the same values there.

Frontend env example: [client/.env.example](client/.env.example)

## Local Setup Commands

## 1) Install dependencies

```bash
cd worker
npm install

cd ../client
npm install
```

## 2) Create D1 database

```bash
cd ../worker
npx wrangler d1 create pair-reviewer-db
```

Copy the returned `database_id` and update [worker/wrangler.toml](worker/wrangler.toml).

## 3) Apply schema

```bash
cd worker
npx wrangler d1 migrations apply pair-reviewer-db --local
npx wrangler d1 migrations apply pair-reviewer-db --remote
```

## 4) Build web-safe data export

```bash
cd ..
python scripts/export_web_safe_data.py \
  --working-db working_pairs.db \
  --master-db /path/to/master_data.db \
  --output-sql scripts/d1_pairs_seed.sql \
  --report-json scripts/export_report.json
```

## 5) Import web-safe data into D1

```bash
cd worker
npx wrangler d1 execute pair-reviewer-db --local --file ../scripts/d1_pairs_seed.sql
npx wrangler d1 execute pair-reviewer-db --remote --file ../scripts/d1_pairs_seed.sql
```

## 6) Run local Worker

```bash
cd worker
npx wrangler dev --local
```

## 7) Run local frontend

```bash
cd client
npm run dev
```

Frontend runs at `http://127.0.0.1:5173`, proxied to Worker `http://127.0.0.1:8787`.

## Deployment Commands

## Worker deploy

```bash
cd worker
npx wrangler deploy
```

## Frontend deploy (Cloudflare Pages)

```bash
cd client
npm run build
npx wrangler pages deploy dist --project-name pair-reviewer
```

Alternative: connect the GitHub repo in Cloudflare Pages and set build command `npm run build` with output directory `dist`.

## Cloudflare Access (Recommended)

Manual dashboard setup:
1. In Zero Trust, create an Access Application for reviewer paths (`/review*`, `/admin*`, `/api/*`).
2. Add identity provider (Google/Microsoft/Okta etc.).
3. Restrict allowed emails/groups.
4. Confirm Worker receives `cf-access-authenticated-user-email` header.

## Custom Domain

To connect `pairs.aliahmadi.site`:
1. In Cloudflare Pages project, add custom domain `pairs.aliahmadi.site`.
2. Ensure DNS is managed in Cloudflare and proxied.
3. If Worker is on a separate hostname, add route or set `VITE_API_BASE` to that Worker URL.

## API Surface

Implemented Worker routes:
- `GET /api/health`
- `GET /api/me`
- `GET /api/stats`
- `GET /api/pairs`
- `GET /api/pair/:pair_id`
- `GET /api/next-pair`
- `POST /api/judgments`
- `GET /api/admin/judgments`
- `GET /api/admin/judgments.csv`
- `GET /api/admin/disagreements`

## Security Notes

- Reviewer identity is required for review and write endpoints.
- Labels are validated server-side.
- Confidence is restricted to 1-5.
- Reviewer identity is server-derived (not trusted from client when Access headers exist).
- SQL is executed using D1 prepared statements.
- CSV export escapes fields safely.

## Data Safety Notes

- The export script writes only web-safe fields needed for annotation.
- Full parquet corpus and full master DB are never uploaded to production.
- Excerpt fields are truncated to safe lengths.
- No local absolute machine paths are required in deployed runtime code.

For import details see [scripts/import_to_d1.md](scripts/import_to_d1.md).
