import type {
  AdminDisagreementsResponse,
  AdminJudgmentsResponse,
  JudgmentLabel,
  MeResponse,
  PairDetailsResponse,
  PairListResponse,
  PairRecord,
  StatsResponse
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";
const DEV_REVIEWER_STORAGE_KEY = "pair-reviewer.dev-email";

export type PairFilters = {
  page?: number;
  page_size?: number;
  min_cosine?: number;
  max_cosine?: number;
  min_delay?: number;
  max_delay?: number;
  max_rank?: number;
  same_sic?: boolean;
  same_action?: boolean;
  focal_surprise?: boolean;
  candidate_surprise?: boolean;
  label_status?: "all" | "unlabeled_by_me" | "labeled_by_me";
  sort?: "highest_cosine" | "lowest_cosine" | "shortest_delay" | "longest_delay";
};

function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    query.set(key, String(value));
  }
  return query.toString();
}

function requestHeaders(contentType = false): HeadersInit {
  const headers: Record<string, string> = {};
  if (contentType) {
    headers["Content-Type"] = "application/json";
  }

  const devEmail = getDevReviewerEmail();
  if (devEmail) {
    headers["X-Dev-Reviewer-Email"] = devEmail;
  }

  return headers;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...requestHeaders(false),
      ...(init?.headers || {})
    }
  });

  if (!response.ok) {
    const fallback = `Request failed (${response.status})`;
    let message = fallback;
    try {
      const errorJson = (await response.json()) as { error?: string; detail?: string };
      message = errorJson.detail || errorJson.error || fallback;
    } catch {
      // Ignore JSON parsing errors and keep fallback message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export function getDevReviewerEmail(): string {
  return localStorage.getItem(DEV_REVIEWER_STORAGE_KEY)?.trim().toLowerCase() || "";
}

export function setDevReviewerEmail(email: string): void {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    localStorage.removeItem(DEV_REVIEWER_STORAGE_KEY);
    return;
  }
  localStorage.setItem(DEV_REVIEWER_STORAGE_KEY, normalized);
}

export function clearDevReviewerEmail(): void {
  localStorage.removeItem(DEV_REVIEWER_STORAGE_KEY);
}

export function adminJudgmentsJsonUrl(): string {
  return `${API_BASE}/admin/judgments`;
}

export function adminJudgmentsCsvUrl(): string {
  return `${API_BASE}/admin/judgments.csv`;
}

export async function getHealth(): Promise<{ status: string; reviewer_email: string | null }> {
  return requestJson<{ status: string; reviewer_email: string | null }>("/health");
}

export async function getMe(): Promise<MeResponse> {
  return requestJson<MeResponse>("/me");
}

export async function getStats(): Promise<StatsResponse> {
  return requestJson<StatsResponse>("/stats");
}

export async function getPairs(filters: PairFilters): Promise<PairListResponse> {
  const query = buildQuery(filters as Record<string, string | number | boolean | null | undefined>);
  const suffix = query ? `?${query}` : "";
  return requestJson<PairListResponse>(`/pairs${suffix}`);
}

export async function getPair(pairId: string): Promise<PairDetailsResponse> {
  return requestJson<PairDetailsResponse>(`/pair/${encodeURIComponent(pairId)}`);
}

export async function getNextPair(filters: Omit<PairFilters, "page" | "page_size" | "label_status">): Promise<{
  pair: PairRecord | null;
}> {
  const query = buildQuery(filters as Record<string, string | number | boolean | null | undefined>);
  const suffix = query ? `?${query}` : "";
  return requestJson<{ pair: PairRecord | null }>(`/next-pair${suffix}`);
}

export async function saveJudgment(payload: {
  pair_id: string;
  label: JudgmentLabel;
  confidence: number;
  notes?: string;
}): Promise<{ ok: boolean }> {
  const response = await fetch(`${API_BASE}/judgments`, {
    method: "POST",
    headers: requestHeaders(true),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const fallback = `Failed to save judgment (${response.status})`;
    let message = fallback;
    try {
      const errorJson = (await response.json()) as { error?: string; detail?: string };
      message = errorJson.detail || errorJson.error || fallback;
    } catch {
      // Ignore JSON parsing errors and keep fallback message.
    }
    throw new Error(message);
  }

  return (await response.json()) as { ok: boolean };
}

export async function getAdminJudgments(
  page = 1,
  pageSize = 200
): Promise<AdminJudgmentsResponse> {
  return requestJson<AdminJudgmentsResponse>(
    `/admin/judgments?${buildQuery({ page, page_size: pageSize })}`
  );
}

export async function getAdminDisagreements(
  page = 1,
  pageSize = 100
): Promise<AdminDisagreementsResponse> {
  return requestJson<AdminDisagreementsResponse>(
    `/admin/disagreements?${buildQuery({ page, page_size: pageSize })}`
  );
}
