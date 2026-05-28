PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pairs (
  pair_id TEXT PRIMARY KEY,
  focal_master_id TEXT NOT NULL,
  candidate_master_id TEXT NOT NULL,
  focal_title TEXT,
  candidate_title TEXT,
  focal_date TEXT,
  candidate_date TEXT,
  focal_source TEXT,
  candidate_source TEXT,
  focal_link TEXT,
  candidate_link TEXT,
  focal_content_excerpt TEXT,
  candidate_content_excerpt TEXT,
  focal_action_summary TEXT,
  candidate_action_summary TEXT,
  focal_action TEXT,
  candidate_action TEXT,
  focal_company TEXT,
  candidate_company TEXT,
  focal_gvkey TEXT,
  candidate_gvkey TEXT,
  focal_sic TEXT,
  candidate_sic TEXT,
  cosine_similarity REAL,
  delay_days REAL,
  rival_rank INTEGER,
  same_sic INTEGER,
  same_action INTEGER,
  focal_competitive_surprise INTEGER,
  candidate_competitive_surprise INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pairs_cosine ON pairs(cosine_similarity DESC);
CREATE INDEX IF NOT EXISTS idx_pairs_delay ON pairs(delay_days ASC);
CREATE INDEX IF NOT EXISTS idx_pairs_rank ON pairs(rival_rank ASC);
CREATE INDEX IF NOT EXISTS idx_pairs_same_sic ON pairs(same_sic);
CREATE INDEX IF NOT EXISTS idx_pairs_same_action ON pairs(same_action);
CREATE INDEX IF NOT EXISTS idx_pairs_focal_surprise ON pairs(focal_competitive_surprise);
CREATE INDEX IF NOT EXISTS idx_pairs_candidate_surprise ON pairs(candidate_competitive_surprise);

CREATE TABLE IF NOT EXISTS reviewers (
  reviewer_id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  role TEXT DEFAULT 'reviewer',
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS judgments (
  judgment_id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  focal_master_id TEXT NOT NULL,
  candidate_master_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_email TEXT,
  label TEXT NOT NULL CHECK (label IN (
    'DIRECT_RESPONSE',
    'PLAUSIBLE_RESPONSE',
    'COMMON_SHOCK',
    'UNRELATED',
    'INSUFFICIENT_EVIDENCE',
    'SKIP'
  )),
  confidence INTEGER CHECK (confidence BETWEEN 1 AND 5),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(pair_id, reviewer_id),
  FOREIGN KEY (pair_id) REFERENCES pairs(pair_id),
  FOREIGN KEY (reviewer_id) REFERENCES reviewers(reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_judgments_pair ON judgments(pair_id);
CREATE INDEX IF NOT EXISTS idx_judgments_reviewer ON judgments(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_judgments_label ON judgments(label);
CREATE INDEX IF NOT EXISTS idx_judgments_updated ON judgments(updated_at DESC);
