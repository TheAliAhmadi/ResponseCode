export const LABELS = [
  "DIRECT_RESPONSE",
  "PLAUSIBLE_RESPONSE",
  "COMMON_SHOCK",
  "UNRELATED",
  "INSUFFICIENT_EVIDENCE",
  "SKIP"
] as const;

export type JudgmentLabel = (typeof LABELS)[number];

export type PairRecord = {
  pair_id: string;
  focal_master_id: string;
  candidate_master_id: string;
  focal_title: string | null;
  candidate_title: string | null;
  focal_date: string | null;
  candidate_date: string | null;
  focal_source: string | null;
  candidate_source: string | null;
  focal_link: string | null;
  candidate_link: string | null;
  focal_content_excerpt: string | null;
  candidate_content_excerpt: string | null;
  focal_action_summary: string | null;
  candidate_action_summary: string | null;
  focal_action: string | null;
  candidate_action: string | null;
  focal_company: string | null;
  candidate_company: string | null;
  focal_gvkey: string | null;
  candidate_gvkey: string | null;
  focal_sic: string | null;
  candidate_sic: string | null;
  cosine_similarity: number | null;
  delay_days: number | null;
  rival_rank: number | null;
  same_sic: number | null;
  same_action: number | null;
  focal_competitive_surprise: number | null;
  candidate_competitive_surprise: number | null;
  my_label?: JudgmentLabel | null;
  my_confidence?: number | null;
  my_updated_at?: string | null;
};

export type JudgmentRecord = {
  judgment_id: string;
  pair_id: string;
  focal_master_id: string;
  candidate_master_id: string;
  reviewer_id: string;
  reviewer_email: string | null;
  label: JudgmentLabel;
  confidence: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewerIdentity = {
  reviewer_id: string;
  email: string;
  name: string | null;
  source: "access" | "dev_header" | "dev_env";
};

export type MeResponse = {
  authenticated: boolean;
  app_mode: string;
  is_admin: boolean;
  reviewer: ReviewerIdentity | null;
};

export type PairDetailsResponse = {
  pair: PairRecord | null;
  judgment: JudgmentRecord | null;
  reviewer: {
    reviewer_id: string;
    email: string;
  };
};

export type PairListResponse = {
  page: number;
  page_size: number;
  total: number;
  rows: PairRecord[];
};

export type StatsResponse = {
  totals: {
    pairs: number;
    judgments: number;
  };
  label_counts: Array<{
    label: JudgmentLabel;
    count: number;
  }>;
  progress_by_reviewer: Array<{
    reviewer_id: string;
    email: string | null;
    name: string | null;
    role: string;
    judgments: number;
    progress_pct: number;
  }>;
  me: {
    reviewer_id: string;
    email: string;
    judgments: number;
    is_admin: boolean;
  };
};

export type AdminJudgmentsResponse = {
  page: number;
  page_size: number;
  total: number;
  rows: Array<JudgmentRecord & {
    focal_title: string | null;
    candidate_title: string | null;
    cosine_similarity: number | null;
    delay_days: number | null;
    rival_rank: number | null;
  }>;
};

export type AdminDisagreementsResponse = {
  page: number;
  page_size: number;
  total: number;
  rows: Array<{
    pair_id: string;
    focal_master_id: string;
    candidate_master_id: string;
    focal_title: string | null;
    candidate_title: string | null;
    cosine_similarity: number | null;
    delay_days: number | null;
    rival_rank: number | null;
    reviewer_count: number;
    judgment_count: number;
    distinct_labels: number;
    judgments: Array<{
      pair_id: string;
      reviewer_id: string;
      reviewer_email: string | null;
      label: JudgmentLabel;
      confidence: number;
      notes: string | null;
      updated_at: string;
    }>;
  }>;
};
