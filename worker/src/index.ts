import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";

type Bindings = {
  DB: D1Database;
  ADMIN_EMAILS?: string;
  DEV_REVIEWER_EMAIL?: string;
  APP_MODE?: string;
};

type ReviewerIdentity = {
  reviewerId: string;
  email: string;
  name: string | null;
  source: "access" | "dev_header" | "dev_env";
};

type ReviewerProgressRow = {
  reviewer_id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  judgments: number;
};

type PairFilters = {
  page: number;
  pageSize: number;
  minCosine?: number;
  maxCosine?: number;
  minDelay?: number;
  maxDelay?: number;
  maxRank?: number;
  sameSic?: number;
  sameAction?: number;
  focalSurprise?: number;
  candidateSurprise?: number;
  labelStatus: "all" | "unlabeled_by_me" | "labeled_by_me";
  sort: "highest_cosine" | "lowest_cosine" | "shortest_delay" | "longest_delay";
};

const LABELS = [
  "DIRECT_RESPONSE",
  "PLAUSIBLE_RESPONSE",
  "COMMON_SHOCK",
  "UNRELATED",
  "INSUFFICIENT_EVIDENCE",
  "SKIP"
] as const;

const LABEL_SET = new Set<string>(LABELS);
const MAX_PAGE_SIZE = 200;
type AppContext = Context<{ Bindings: Bindings }>;

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Dev-Reviewer-Email"]
  })
);

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  return trimmed;
}

function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseMode(env: Bindings): string {
  return (env.APP_MODE || "dev").trim().toLowerCase();
}

function isProdMode(env: Bindings): boolean {
  const mode = parseMode(env);
  return mode === "prod" || mode === "production";
}

function parseAdminEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
  );
}

function isAdmin(identity: ReviewerIdentity | null, env: Bindings): boolean {
  if (!identity) return false;
  const admins = parseAdminEmails(env.ADMIN_EMAILS);
  return admins.has(identity.email);
}

async function ensureReviewer(db: D1Database, identity: ReviewerIdentity): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO reviewers (reviewer_id, email, name, role, created_at, last_seen_at)
      VALUES (?, ?, ?, 'reviewer', datetime('now'), datetime('now'))
      ON CONFLICT(reviewer_id) DO UPDATE SET
        email = excluded.email,
        name = COALESCE(excluded.name, reviewers.name),
        last_seen_at = datetime('now')
      `
    )
    .bind(identity.reviewerId, identity.email, identity.name)
    .run();
}

async function resolveIdentity(c: AppContext): Promise<ReviewerIdentity | null> {
  const req = c.req.raw;
  const env = c.env;

  const accessEmail = normalizeEmail(req.headers.get("cf-access-authenticated-user-email"));
  const accessName = normalizeName(req.headers.get("cf-access-authenticated-user-name"));

  if (accessEmail) {
    return {
      reviewerId: accessEmail,
      email: accessEmail,
      name: accessName,
      source: "access"
    };
  }

  if (isProdMode(env)) {
    return null;
  }

  const headerEmail = normalizeEmail(req.headers.get("x-dev-reviewer-email"));
  if (headerEmail) {
    return {
      reviewerId: headerEmail,
      email: headerEmail,
      name: null,
      source: "dev_header"
    };
  }

  const fallbackEmail = normalizeEmail(env.DEV_REVIEWER_EMAIL);
  if (fallbackEmail) {
    return {
      reviewerId: fallbackEmail,
      email: fallbackEmail,
      name: null,
      source: "dev_env"
    };
  }

  return null;
}

async function requireReviewer(c: AppContext): Promise<ReviewerIdentity | Response> {
  const identity = await resolveIdentity(c);
  if (!identity) {
    return c.json(
      {
        error: "Reviewer identity required",
        detail:
          "Cloudflare Access identity was not found. In local dev, set DEV_REVIEWER_EMAIL or send X-Dev-Reviewer-Email."
      },
      401
    );
  }

  await ensureReviewer(c.env.DB, identity);
  return identity;
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseOptionalInt(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.trunc(num);
}

function parseOptionalBoolToInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return 1;
  if (["0", "false", "no"].includes(normalized)) return 0;
  return undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function readPairFilters(url: URL): PairFilters {
  const page = clampInt(parseOptionalInt(url.searchParams.get("page")), 1, 1, 1_000_000);
  const pageSize = clampInt(
    parseOptionalInt(url.searchParams.get("page_size")),
    25,
    1,
    MAX_PAGE_SIZE
  );

  const labelStatusRaw = (url.searchParams.get("label_status") || "all").trim().toLowerCase();
  const sortRaw = (url.searchParams.get("sort") || "highest_cosine").trim().toLowerCase();

  const labelStatus: PairFilters["labelStatus"] =
    labelStatusRaw === "unlabeled_by_me" || labelStatusRaw === "labeled_by_me"
      ? labelStatusRaw
      : "all";

  const sort: PairFilters["sort"] =
    sortRaw === "lowest_cosine" || sortRaw === "shortest_delay" || sortRaw === "longest_delay"
      ? sortRaw
      : "highest_cosine";

  return {
    page,
    pageSize,
    minCosine: parseOptionalNumber(url.searchParams.get("min_cosine")),
    maxCosine: parseOptionalNumber(url.searchParams.get("max_cosine")),
    minDelay: parseOptionalNumber(url.searchParams.get("min_delay")),
    maxDelay: parseOptionalNumber(url.searchParams.get("max_delay")),
    maxRank: parseOptionalInt(url.searchParams.get("max_rank")),
    sameSic: parseOptionalBoolToInt(url.searchParams.get("same_sic")),
    sameAction: parseOptionalBoolToInt(url.searchParams.get("same_action")),
    focalSurprise: parseOptionalBoolToInt(url.searchParams.get("focal_surprise")),
    candidateSurprise: parseOptionalBoolToInt(url.searchParams.get("candidate_surprise")),
    labelStatus,
    sort
  };
}

function pairSortSql(sort: PairFilters["sort"]): string {
  switch (sort) {
    case "lowest_cosine":
      return "p.cosine_similarity ASC, p.pair_id ASC";
    case "shortest_delay":
      return "p.delay_days ASC, p.pair_id ASC";
    case "longest_delay":
      return "p.delay_days DESC, p.pair_id ASC";
    case "highest_cosine":
    default:
      return "p.cosine_similarity DESC, p.pair_id ASC";
  }
}

function buildPairsWhere(filters: PairFilters, params: Array<string | number>): string {
  const clauses: string[] = [];

  if (filters.minCosine !== undefined) {
    clauses.push("p.cosine_similarity >= ?");
    params.push(filters.minCosine);
  }
  if (filters.maxCosine !== undefined) {
    clauses.push("p.cosine_similarity <= ?");
    params.push(filters.maxCosine);
  }
  if (filters.minDelay !== undefined) {
    clauses.push("p.delay_days >= ?");
    params.push(filters.minDelay);
  }
  if (filters.maxDelay !== undefined) {
    clauses.push("p.delay_days <= ?");
    params.push(filters.maxDelay);
  }
  if (filters.maxRank !== undefined) {
    clauses.push("p.rival_rank <= ?");
    params.push(filters.maxRank);
  }
  if (filters.sameSic !== undefined) {
    clauses.push("p.same_sic = ?");
    params.push(filters.sameSic);
  }
  if (filters.sameAction !== undefined) {
    clauses.push("p.same_action = ?");
    params.push(filters.sameAction);
  }
  if (filters.focalSurprise !== undefined) {
    clauses.push("p.focal_competitive_surprise = ?");
    params.push(filters.focalSurprise);
  }
  if (filters.candidateSurprise !== undefined) {
    clauses.push("p.candidate_competitive_surprise = ?");
    params.push(filters.candidateSurprise);
  }

  return clauses.length > 0 ? clauses.join(" AND ") : "1=1";
}

function buildLabelStatusClause(labelStatus: PairFilters["labelStatus"]): string {
  if (labelStatus === "unlabeled_by_me") return "mj.judgment_id IS NULL";
  if (labelStatus === "labeled_by_me") return "mj.judgment_id IS NOT NULL";
  return "1=1";
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.includes(",") || text.includes("\n") || text.includes("\r") || text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

app.get("/api/health", async (c) => {
  const identity = await resolveIdentity(c);
  return c.json({
    status: "ok",
    app_mode: parseMode(c.env),
    reviewer_email: identity?.email ?? null,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/me", async (c) => {
  const identity = await resolveIdentity(c);
  if (!identity) {
    return c.json({
      authenticated: false,
      app_mode: parseMode(c.env),
      is_admin: false,
      reviewer: null
    });
  }

  await ensureReviewer(c.env.DB, identity);

  return c.json({
    authenticated: true,
    app_mode: parseMode(c.env),
    is_admin: isAdmin(identity, c.env),
    reviewer: {
      reviewer_id: identity.reviewerId,
      email: identity.email,
      name: identity.name,
      source: identity.source
    }
  });
});

app.get("/api/stats", async (c) => {
  const reviewerResult = await requireReviewer(c);
  if (reviewerResult instanceof Response) return reviewerResult;
  const reviewer = reviewerResult;

  const totalPairsRow = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM pairs").first<{ count: number }>();
  const totalJudgmentsRow = await c.env.DB
    .prepare("SELECT COUNT(*) AS count FROM judgments")
    .first<{ count: number }>();

  const totalPairs = Number(totalPairsRow?.count || 0);
  const totalJudgments = Number(totalJudgmentsRow?.count || 0);

  const rawLabelRows = await c.env.DB
    .prepare("SELECT label, COUNT(*) AS count FROM judgments GROUP BY label ORDER BY count DESC")
    .all<{ label: string; count: number }>();

  const labelCountMap = new Map<string, number>(
    (rawLabelRows.results || []).map((row) => [row.label, Number(row.count || 0)])
  );

  const label_counts = LABELS.map((label) => ({ label, count: labelCountMap.get(label) || 0 }));

  const reviewerRows = await c.env.DB
    .prepare(
      `
      SELECT
        r.reviewer_id,
        r.email,
        r.name,
        r.role,
        COUNT(j.judgment_id) AS judgments
      FROM reviewers r
      LEFT JOIN judgments j ON j.reviewer_id = r.reviewer_id
      GROUP BY r.reviewer_id, r.email, r.name, r.role
      ORDER BY judgments DESC, r.email ASC
      `
    )
    .all<ReviewerProgressRow>();

  const progress_by_reviewer = (reviewerRows.results || []).map((row) => {
    const judgments = Number(row.judgments || 0);
    const progress_pct = totalPairs > 0 ? (judgments / totalPairs) * 100 : 0;
    return {
      reviewer_id: row.reviewer_id,
      email: row.email,
      name: row.name,
      role: row.role || "reviewer",
      judgments,
      progress_pct
    };
  });

  const myJudgmentRow = await c.env.DB
    .prepare("SELECT COUNT(*) AS count FROM judgments WHERE reviewer_id = ?")
    .bind(reviewer.reviewerId)
    .first<{ count: number }>();

  return c.json({
    totals: {
      pairs: totalPairs,
      judgments: totalJudgments
    },
    label_counts,
    progress_by_reviewer,
    me: {
      reviewer_id: reviewer.reviewerId,
      email: reviewer.email,
      judgments: Number(myJudgmentRow?.count || 0),
      is_admin: isAdmin(reviewer, c.env)
    }
  });
});

app.get("/api/pairs", async (c) => {
  const reviewerResult = await requireReviewer(c);
  if (reviewerResult instanceof Response) return reviewerResult;
  const reviewer = reviewerResult;

  const url = new URL(c.req.url);
  const filters = readPairFilters(url);

  const whereParams: Array<string | number> = [];
  const whereSql = buildPairsWhere(filters, whereParams);
  const labelStatusSql = buildLabelStatusClause(filters.labelStatus);

  const countSql = `
    SELECT COUNT(*) AS count
    FROM pairs p
    LEFT JOIN judgments mj ON mj.pair_id = p.pair_id AND mj.reviewer_id = ?
    WHERE ${whereSql} AND ${labelStatusSql}
  `;

  const countParams: Array<string | number> = [reviewer.reviewerId, ...whereParams];
  const totalRow = await c.env.DB.prepare(countSql).bind(...countParams).first<{ count: number }>();
  const total = Number(totalRow?.count || 0);

  const offset = (filters.page - 1) * filters.pageSize;

  const rowsSql = `
    SELECT
      p.pair_id,
      p.focal_master_id,
      p.candidate_master_id,
      p.focal_title,
      p.candidate_title,
      p.focal_date,
      p.candidate_date,
      p.focal_source,
      p.candidate_source,
      p.focal_link,
      p.candidate_link,
      p.focal_content_excerpt,
      p.candidate_content_excerpt,
      p.focal_action_summary,
      p.candidate_action_summary,
      p.focal_action,
      p.candidate_action,
      p.focal_company,
      p.candidate_company,
      p.focal_gvkey,
      p.candidate_gvkey,
      p.focal_sic,
      p.candidate_sic,
      p.cosine_similarity,
      p.delay_days,
      p.rival_rank,
      p.same_sic,
      p.same_action,
      p.focal_competitive_surprise,
      p.candidate_competitive_surprise,
      mj.label AS my_label,
      mj.confidence AS my_confidence,
      mj.updated_at AS my_updated_at
    FROM pairs p
    LEFT JOIN judgments mj ON mj.pair_id = p.pair_id AND mj.reviewer_id = ?
    WHERE ${whereSql} AND ${labelStatusSql}
    ORDER BY ${pairSortSql(filters.sort)}
    LIMIT ? OFFSET ?
  `;

  const rowsParams: Array<string | number> = [
    reviewer.reviewerId,
    ...whereParams,
    filters.pageSize,
    offset
  ];

  const rows = await c.env.DB.prepare(rowsSql).bind(...rowsParams).all<Record<string, unknown>>();

  return c.json({
    page: filters.page,
    page_size: filters.pageSize,
    total,
    rows: rows.results || []
  });
});

app.get("/api/pair/:pair_id", async (c) => {
  const reviewerResult = await requireReviewer(c);
  if (reviewerResult instanceof Response) return reviewerResult;
  const reviewer = reviewerResult;

  const pairId = c.req.param("pair_id");

  const pair = await c.env.DB
    .prepare(
      `
      SELECT
        pair_id,
        focal_master_id,
        candidate_master_id,
        focal_title,
        candidate_title,
        focal_date,
        candidate_date,
        focal_source,
        candidate_source,
        focal_link,
        candidate_link,
        focal_content_excerpt,
        candidate_content_excerpt,
        focal_action_summary,
        candidate_action_summary,
        focal_action,
        candidate_action,
        focal_company,
        candidate_company,
        focal_gvkey,
        candidate_gvkey,
        focal_sic,
        candidate_sic,
        cosine_similarity,
        delay_days,
        rival_rank,
        same_sic,
        same_action,
        focal_competitive_surprise,
        candidate_competitive_surprise
      FROM pairs
      WHERE pair_id = ?
      LIMIT 1
      `
    )
    .bind(pairId)
    .first<Record<string, unknown>>();

  if (!pair) {
    return c.json({ error: "Pair not found", pair_id: pairId }, 404);
  }

  const judgment = await c.env.DB
    .prepare(
      `
      SELECT
        judgment_id,
        pair_id,
        reviewer_id,
        reviewer_email,
        label,
        confidence,
        notes,
        created_at,
        updated_at
      FROM judgments
      WHERE pair_id = ? AND reviewer_id = ?
      LIMIT 1
      `
    )
    .bind(pairId, reviewer.reviewerId)
    .first<Record<string, unknown>>();

  return c.json({
    pair,
    judgment: judgment || null,
    reviewer: {
      reviewer_id: reviewer.reviewerId,
      email: reviewer.email
    }
  });
});

app.get("/api/next-pair", async (c) => {
  const reviewerResult = await requireReviewer(c);
  if (reviewerResult instanceof Response) return reviewerResult;
  const reviewer = reviewerResult;

  const url = new URL(c.req.url);
  const filters = readPairFilters(url);

  const whereParams: Array<string | number> = [];
  const whereSql = buildPairsWhere(filters, whereParams);

  const sql = `
    SELECT
      p.pair_id,
      p.focal_master_id,
      p.candidate_master_id,
      p.focal_title,
      p.candidate_title,
      p.focal_date,
      p.candidate_date,
      p.focal_source,
      p.candidate_source,
      p.focal_link,
      p.candidate_link,
      p.focal_content_excerpt,
      p.candidate_content_excerpt,
      p.focal_action_summary,
      p.candidate_action_summary,
      p.focal_action,
      p.candidate_action,
      p.focal_company,
      p.candidate_company,
      p.focal_gvkey,
      p.candidate_gvkey,
      p.focal_sic,
      p.candidate_sic,
      p.cosine_similarity,
      p.delay_days,
      p.rival_rank,
      p.same_sic,
      p.same_action,
      p.focal_competitive_surprise,
      p.candidate_competitive_surprise
    FROM pairs p
    LEFT JOIN judgments mj ON mj.pair_id = p.pair_id AND mj.reviewer_id = ?
    WHERE ${whereSql} AND mj.judgment_id IS NULL
    ORDER BY ${pairSortSql(filters.sort)}
    LIMIT 1
  `;

  const result = await c.env.DB
    .prepare(sql)
    .bind(reviewer.reviewerId, ...whereParams)
    .first<Record<string, unknown>>();

  return c.json({
    pair: result || null
  });
});

app.post("/api/judgments", async (c) => {
  const reviewerResult = await requireReviewer(c);
  if (reviewerResult instanceof Response) return reviewerResult;
  const reviewer = reviewerResult;

  const payload = (await c.req.json().catch(() => null)) as
    | {
        pair_id?: unknown;
        label?: unknown;
        confidence?: unknown;
        notes?: unknown;
      }
    | null;

  if (!payload || typeof payload.pair_id !== "string") {
    return c.json({ error: "pair_id is required" }, 400);
  }

  if (typeof payload.label !== "string" || !LABEL_SET.has(payload.label)) {
    return c.json({ error: "Invalid label", allowed_labels: LABELS }, 400);
  }

  const confidence = Number(payload.confidence);
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    return c.json({ error: "confidence must be an integer between 1 and 5" }, 400);
  }

  let notes = "";
  if (typeof payload.notes === "string") {
    notes = payload.notes.slice(0, 5000);
  }

  const pair = await c.env.DB
    .prepare(
      "SELECT pair_id, focal_master_id, candidate_master_id FROM pairs WHERE pair_id = ? LIMIT 1"
    )
    .bind(payload.pair_id)
    .first<{ pair_id: string; focal_master_id: string; candidate_master_id: string }>();

  if (!pair) {
    return c.json({ error: "pair_id not found" }, 404);
  }

  const nowIso = new Date().toISOString();
  const judgmentId = crypto.randomUUID();

  await c.env.DB
    .prepare(
      `
      INSERT INTO judgments (
        judgment_id,
        pair_id,
        focal_master_id,
        candidate_master_id,
        reviewer_id,
        reviewer_email,
        label,
        confidence,
        notes,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_id, reviewer_id) DO UPDATE SET
        label = excluded.label,
        confidence = excluded.confidence,
        notes = excluded.notes,
        reviewer_email = excluded.reviewer_email,
        updated_at = excluded.updated_at
      `
    )
    .bind(
      judgmentId,
      pair.pair_id,
      pair.focal_master_id,
      pair.candidate_master_id,
      reviewer.reviewerId,
      reviewer.email,
      payload.label,
      confidence,
      notes,
      nowIso,
      nowIso
    )
    .run();

  const saved = await c.env.DB
    .prepare(
      `
      SELECT
        judgment_id,
        pair_id,
        focal_master_id,
        candidate_master_id,
        reviewer_id,
        reviewer_email,
        label,
        confidence,
        notes,
        created_at,
        updated_at
      FROM judgments
      WHERE pair_id = ? AND reviewer_id = ?
      LIMIT 1
      `
    )
    .bind(pair.pair_id, reviewer.reviewerId)
    .first<Record<string, unknown>>();

  return c.json({ ok: true, judgment: saved });
});

app.get("/api/admin/judgments", async (c) => {
  const reviewerResult = await requireReviewer(c);
  if (reviewerResult instanceof Response) return reviewerResult;
  const reviewer = reviewerResult;

  if (!isAdmin(reviewer, c.env)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const url = new URL(c.req.url);
  const hasPaging = url.searchParams.has("page") || url.searchParams.has("page_size");
  const page = clampInt(parseOptionalInt(url.searchParams.get("page")), 1, 1, 1_000_000);
  const pageSize = clampInt(parseOptionalInt(url.searchParams.get("page_size")), 200, 1, 2000);
  const offset = (page - 1) * pageSize;

  const totalRow = await c.env.DB
    .prepare("SELECT COUNT(*) AS count FROM judgments")
    .first<{ count: number }>();
  const total = Number(totalRow?.count || 0);

  const baseSql = `
      SELECT
        j.judgment_id,
        j.pair_id,
        j.focal_master_id,
        j.candidate_master_id,
        j.reviewer_id,
        j.reviewer_email,
        j.label,
        j.confidence,
        j.notes,
        j.created_at,
        j.updated_at,
        p.focal_title,
        p.candidate_title,
        p.cosine_similarity,
        p.delay_days,
        p.rival_rank
      FROM judgments j
      LEFT JOIN pairs p ON p.pair_id = j.pair_id
      ORDER BY j.updated_at DESC
    `;

  const rows = hasPaging
    ? await c.env.DB
        .prepare(`${baseSql}\nLIMIT ? OFFSET ?`)
        .bind(pageSize, offset)
        .all<Record<string, unknown>>()
    : await c.env.DB.prepare(baseSql).all<Record<string, unknown>>();

  return c.json({
    page: hasPaging ? page : 1,
    page_size: hasPaging ? pageSize : total,
    total,
    rows: rows.results || []
  });
});

app.get("/api/admin/judgments.csv", async (c) => {
  const reviewerResult = await requireReviewer(c);
  if (reviewerResult instanceof Response) return reviewerResult;
  const reviewer = reviewerResult;

  if (!isAdmin(reviewer, c.env)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const rows = await c.env.DB
    .prepare(
      `
      SELECT
        j.judgment_id,
        j.pair_id,
        j.focal_master_id,
        j.candidate_master_id,
        j.reviewer_id,
        j.reviewer_email,
        j.label,
        j.confidence,
        j.notes,
        j.created_at,
        j.updated_at,
        p.focal_title,
        p.candidate_title,
        p.cosine_similarity,
        p.delay_days,
        p.rival_rank
      FROM judgments j
      LEFT JOIN pairs p ON p.pair_id = j.pair_id
      ORDER BY j.updated_at DESC
      `
    )
    .all<Record<string, unknown>>();

  const columns = [
    "judgment_id",
    "pair_id",
    "focal_master_id",
    "candidate_master_id",
    "reviewer_id",
    "reviewer_email",
    "label",
    "confidence",
    "notes",
    "created_at",
    "updated_at",
    "focal_title",
    "candidate_title",
    "cosine_similarity",
    "delay_days",
    "rival_rank"
  ];

  const bodyLines: string[] = [columns.join(",")];
  for (const row of rows.results || []) {
    bodyLines.push(columns.map((column) => csvEscape(row[column])).join(","));
  }

  return new Response(bodyLines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=pair_judgments.csv"
    }
  });
});

app.get("/api/admin/disagreements", async (c) => {
  const reviewerResult = await requireReviewer(c);
  if (reviewerResult instanceof Response) return reviewerResult;
  const reviewer = reviewerResult;

  if (!isAdmin(reviewer, c.env)) {
    return c.json({ error: "Admin access required" }, 403);
  }

  const url = new URL(c.req.url);
  const page = clampInt(parseOptionalInt(url.searchParams.get("page")), 1, 1, 1_000_000);
  const pageSize = clampInt(parseOptionalInt(url.searchParams.get("page_size")), 50, 1, 500);
  const offset = (page - 1) * pageSize;

  const totalRow = await c.env.DB
    .prepare(
      `
      SELECT COUNT(*) AS count FROM (
        SELECT p.pair_id
        FROM pairs p
        JOIN judgments j ON j.pair_id = p.pair_id
        GROUP BY p.pair_id
        HAVING COUNT(DISTINCT j.reviewer_id) >= 2 AND COUNT(DISTINCT j.label) > 1
      ) t
      `
    )
    .first<{ count: number }>();

  const pairRows = await c.env.DB
    .prepare(
      `
      SELECT
        p.pair_id,
        p.focal_master_id,
        p.candidate_master_id,
        p.focal_title,
        p.candidate_title,
        p.cosine_similarity,
        p.delay_days,
        p.rival_rank,
        COUNT(DISTINCT j.reviewer_id) AS reviewer_count,
        COUNT(*) AS judgment_count,
        COUNT(DISTINCT j.label) AS distinct_labels
      FROM pairs p
      JOIN judgments j ON j.pair_id = p.pair_id
      GROUP BY p.pair_id
      HAVING COUNT(DISTINCT j.reviewer_id) >= 2 AND COUNT(DISTINCT j.label) > 1
      ORDER BY judgment_count DESC, p.cosine_similarity DESC
      LIMIT ? OFFSET ?
      `
    )
    .bind(pageSize, offset)
    .all<Record<string, unknown>>();

  const pairs = pairRows.results || [];
  if (pairs.length === 0) {
    return c.json({
      page,
      page_size: pageSize,
      total: Number(totalRow?.count || 0),
      rows: []
    });
  }

  const pairIds = pairs.map((row) => String(row.pair_id));
  const placeholders = pairIds.map(() => "?").join(",");

  const judgmentRows = await c.env.DB
    .prepare(
      `
      SELECT
        pair_id,
        reviewer_id,
        reviewer_email,
        label,
        confidence,
        notes,
        updated_at
      FROM judgments
      WHERE pair_id IN (${placeholders})
      ORDER BY pair_id ASC, updated_at DESC
      `
    )
    .bind(...pairIds)
    .all<Record<string, unknown>>();

  const judgmentsByPair = new Map<string, Array<Record<string, unknown>>>();
  for (const row of judgmentRows.results || []) {
    const pairId = String(row.pair_id);
    const list = judgmentsByPair.get(pairId) || [];
    list.push(row);
    judgmentsByPair.set(pairId, list);
  }

  const rows = pairs.map((pair) => ({
    ...pair,
    judgments: judgmentsByPair.get(String(pair.pair_id)) || []
  }));

  return c.json({
    page,
    page_size: pageSize,
    total: Number(totalRow?.count || 0),
    rows
  });
});

app.onError((err, c) => {
  console.error("Unhandled worker error", err);
  return c.json(
    {
      error: "Internal server error",
      detail: err.message
    },
    500
  );
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
