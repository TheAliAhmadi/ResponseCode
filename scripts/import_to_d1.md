# Import Web-Safe Pair Data Into D1

This guide assumes you already created the D1 database and updated [worker/wrangler.toml](../worker/wrangler.toml) with real `database_id` values.

## 1) Apply Schema

From [worker/](../worker):

```bash
npx wrangler d1 execute pair-reviewer-db --local --file schema.sql
npx wrangler d1 execute pair-reviewer-db --remote --file schema.sql
```

Or use migrations:

```bash
npx wrangler d1 migrations apply pair-reviewer-db --local
npx wrangler d1 migrations apply pair-reviewer-db --remote
```

## 2) Generate Web-Safe Seed SQL

From repo root:

```bash
python scripts/export_web_safe_data.py \
  --working-db working_pairs.db \
  --master-db /path/to/master_data.db \
  --output-sql scripts/d1_pairs_seed.sql \
  --report-json scripts/export_report.json
```

If you do not have master data available locally yet:

```bash
python scripts/export_web_safe_data.py --working-db working_pairs.db
```

## 3) Import Pairs Into D1

Local D1:

```bash
cd worker
npx wrangler d1 execute pair-reviewer-db --local --file ../scripts/d1_pairs_seed.sql
```

Remote D1:

```bash
cd worker
npx wrangler d1 execute pair-reviewer-db --remote --file ../scripts/d1_pairs_seed.sql
```

## 4) Validate Counts

```bash
cd worker
npx wrangler d1 execute pair-reviewer-db --remote --command "SELECT COUNT(*) AS pairs FROM pairs;"
npx wrangler d1 execute pair-reviewer-db --remote --command "SELECT COUNT(*) AS judgments FROM judgments;"
```

The script report in [scripts/export_report.json](export_report.json) includes missingness percentages and exported row count.
