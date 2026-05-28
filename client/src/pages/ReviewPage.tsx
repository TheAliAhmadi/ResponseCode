import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  clearDevReviewerEmail,
  getDevReviewerEmail,
  getMe,
  getNextPair,
  getPair,
  getPairs,
  getStats,
  saveJudgment,
  setDevReviewerEmail,
  type PairFilters
} from "../api";
import type {
  JudgmentLabel,
  MeResponse,
  PairDetailsResponse,
  PairListResponse,
  PairRecord,
  StatsResponse
} from "../types";
import { LABELS } from "../types";

const DEFAULT_FILTERS: PairFilters = {
  page: 1,
  page_size: 25,
  label_status: "unlabeled_by_me",
  sort: "highest_cosine"
};

function boolToSelect(value: boolean | undefined): "any" | "true" | "false" {
  if (value === true) return "true";
  if (value === false) return "false";
  return "any";
}

function selectToBool(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function toOptionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function numberInputValue(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(digits);
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleDateString();
}

function boolTag(value: number | null | undefined): string {
  if (value === 1) return "Yes";
  if (value === 0) return "No";
  return "-";
}

function compactText(value: string | null | undefined, fallback = "-"): string {
  if (!value || !value.trim()) return fallback;
  return value.trim();
}

function shortTitle(pair: PairRecord): string {
  const focal = compactText(pair.focal_title, "(untitled focal)");
  const candidate = compactText(pair.candidate_title, "(untitled candidate)");
  return `${focal} -> ${candidate}`;
}

function nextPairFilters(filters: PairFilters): Omit<PairFilters, "page" | "page_size" | "label_status"> {
  const { page: _page, page_size: _pageSize, label_status: _labelStatus, ...rest } = filters;
  return rest;
}

export default function ReviewPage() {
  const navigate = useNavigate();
  const { pair_id } = useParams<{ pair_id: string }>();
  const pairId = pair_id;

  const [me, setMe] = useState<MeResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [draftFilters, setDraftFilters] = useState<PairFilters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<PairFilters>(DEFAULT_FILTERS);
  const [pairList, setPairList] = useState<PairListResponse | null>(null);
  const [pairDetails, setPairDetails] = useState<PairDetailsResponse | null>(null);
  const [label, setLabel] = useState<JudgmentLabel>("PLAUSIBLE_RESPONSE");
  const [confidence, setConfidence] = useState<number>(3);
  const [notes, setNotes] = useState<string>("");
  const [devEmailInput, setDevEmailInput] = useState<string>(getDevReviewerEmail());
  const [loadingIdentity, setLoadingIdentity] = useState<boolean>(true);
  const [loadingList, setLoadingList] = useState<boolean>(false);
  const [loadingPair, setLoadingPair] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const autoLoadedNextRef = useRef<boolean>(false);

  const page = filters.page || 1;
  const pageSize = filters.page_size || 25;
  const totalPages = useMemo(() => {
    if (!pairList) return 1;
    return Math.max(1, Math.ceil(pairList.total / pageSize));
  }, [pairList, pageSize]);

  const selectedPair = pairDetails?.pair || null;

  const loadIdentity = useCallback(async () => {
    setLoadingIdentity(true);
    setError("");
    try {
      const meResponse = await getMe();
      setMe(meResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reviewer identity");
    } finally {
      setLoadingIdentity(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const statsResponse = await getStats();
      setStats(statsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    }
  }, []);

  const loadPairs = useCallback(async () => {
    setLoadingList(true);
    setError("");
    try {
      const listResponse = await getPairs(filters);
      setPairList(listResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pairs");
    } finally {
      setLoadingList(false);
    }
  }, [filters]);

  const loadPairDetails = useCallback(async (id: string) => {
    setLoadingPair(true);
    setError("");
    try {
      const details = await getPair(id);
      setPairDetails(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pair details");
      setPairDetails(null);
    } finally {
      setLoadingPair(false);
    }
  }, []);

  const loadNextPair = useCallback(async () => {
    setError("");
    try {
      const next = await getNextPair(nextPairFilters(filters));
      if (!next.pair) {
        setError("No unlabeled pair found for the current filter set.");
        return;
      }
      navigate(`/review/${next.pair.pair_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load next pair");
    }
  }, [filters, navigate]);

  useEffect(() => {
    void loadIdentity();
  }, [loadIdentity]);

  useEffect(() => {
    if (!me?.authenticated) return;
    void loadStats();
  }, [me?.authenticated, loadStats]);

  useEffect(() => {
    if (!me?.authenticated) return;
    void loadPairs();
  }, [me?.authenticated, loadPairs]);

  useEffect(() => {
    if (!me?.authenticated) return;
    if (!pairId) return;
    void loadPairDetails(pairId);
  }, [me?.authenticated, pairId, loadPairDetails]);

  useEffect(() => {
    if (!me?.authenticated) return;
    if (pairId || autoLoadedNextRef.current) return;
    autoLoadedNextRef.current = true;
    void loadNextPair();
  }, [me?.authenticated, pairId, loadNextPair]);

  useEffect(() => {
    if (!pairDetails) return;
    if (pairDetails.judgment) {
      setLabel(pairDetails.judgment.label);
      setConfidence(pairDetails.judgment.confidence || 3);
      setNotes(pairDetails.judgment.notes || "");
      return;
    }
    setLabel("PLAUSIBLE_RESPONSE");
    setConfidence(3);
    setNotes("");
  }, [pairDetails]);

  async function handleSave(goNextAfterSave: boolean): Promise<void> {
    if (!selectedPair) return;
    setSaving(true);
    setError("");
    try {
      await saveJudgment({
        pair_id: selectedPair.pair_id,
        label,
        confidence,
        notes
      });

      await Promise.all([loadStats(), loadPairs(), loadPairDetails(selectedPair.pair_id)]);

      if (goNextAfterSave) {
        await loadNextPair();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save judgment");
    } finally {
      setSaving(false);
    }
  }

  function setFilterPage(newPage: number): void {
    const safePage = Math.max(1, Math.min(newPage, totalPages));
    setFilters((prev) => ({ ...prev, page: safePage }));
    setDraftFilters((prev) => ({ ...prev, page: safePage }));
  }

  function applyFilters(): void {
    setFilters({ ...draftFilters, page: 1 });
  }

  function resetFilters(): void {
    setDraftFilters(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
  }

  function handleDevSignIn(): void {
    if (!devEmailInput.trim()) {
      setError("Enter a reviewer email or configure Cloudflare Access.");
      return;
    }
    setDevReviewerEmail(devEmailInput);
    autoLoadedNextRef.current = false;
    void loadIdentity();
  }

  function handleDevSignOut(): void {
    clearDevReviewerEmail();
    setDevEmailInput("");
    setMe(null);
    setStats(null);
    setPairList(null);
    setPairDetails(null);
    autoLoadedNextRef.current = false;
    void loadIdentity();
  }

  if (loadingIdentity) {
    return <div className="workspace-empty">Loading reviewer identity...</div>;
  }

  if (!me?.authenticated) {
    return (
      <div className="workspace-empty">
        <div className="empty-card">
          <h2>Reviewer Identity Required</h2>
          <p>
            In production, reviewer identity should come from Cloudflare Access headers. For local development,
            provide a dev reviewer email.
          </p>
          <div className="inline-form">
            <input
              type="email"
              placeholder="reviewer@example.com"
              value={devEmailInput}
              onChange={(event) => setDevEmailInput(event.target.value)}
            />
            <button className="btn btn-primary" onClick={handleDevSignIn}>
              Use This Reviewer
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="workspace review-layout">
      <aside className="panel sidebar-panel">
        <div className="identity-card">
          <div className="eyebrow">Reviewer</div>
          <h3>{me.reviewer?.email}</h3>
          <p>
            Mode: <strong>{me.app_mode}</strong>
          </p>
          <p>
            My judgments: <strong>{stats?.me.judgments ?? "-"}</strong>
          </p>
          {me.reviewer?.source !== "access" && (
            <button className="btn btn-ghost" onClick={handleDevSignOut}>
              Clear Dev Reviewer
            </button>
          )}
        </div>

        <div className="section-title">Filters</div>
        <div className="field-grid">
          <label>
            Min cosine
            <input
              type="number"
              step="0.01"
              value={numberInputValue(draftFilters.min_cosine)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, min_cosine: toOptionalNumber(event.target.value) }))
              }
            />
          </label>

          <label>
            Max cosine
            <input
              type="number"
              step="0.01"
              value={numberInputValue(draftFilters.max_cosine)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, max_cosine: toOptionalNumber(event.target.value) }))
              }
            />
          </label>

          <label>
            Min delay
            <input
              type="number"
              step="1"
              value={numberInputValue(draftFilters.min_delay)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, min_delay: toOptionalNumber(event.target.value) }))
              }
            />
          </label>

          <label>
            Max delay
            <input
              type="number"
              step="1"
              value={numberInputValue(draftFilters.max_delay)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, max_delay: toOptionalNumber(event.target.value) }))
              }
            />
          </label>

          <label>
            Max rival rank
            <input
              type="number"
              step="1"
              value={numberInputValue(draftFilters.max_rank)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, max_rank: toOptionalNumber(event.target.value) }))
              }
            />
          </label>

          <label>
            Label status
            <select
              value={draftFilters.label_status || "all"}
              onChange={(event) =>
                setDraftFilters((prev) => ({
                  ...prev,
                  label_status: event.target.value as PairFilters["label_status"]
                }))
              }
            >
              <option value="all">All pairs</option>
              <option value="unlabeled_by_me">Unlabeled by me</option>
              <option value="labeled_by_me">Labeled by me</option>
            </select>
          </label>

          <label>
            Same SIC
            <select
              value={boolToSelect(draftFilters.same_sic)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, same_sic: selectToBool(event.target.value) }))
              }
            >
              <option value="any">Any</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>

          <label>
            Same action
            <select
              value={boolToSelect(draftFilters.same_action)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, same_action: selectToBool(event.target.value) }))
              }
            >
              <option value="any">Any</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>

          <label>
            Focal surprise
            <select
              value={boolToSelect(draftFilters.focal_surprise)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, focal_surprise: selectToBool(event.target.value) }))
              }
            >
              <option value="any">Any</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>

          <label>
            Candidate surprise
            <select
              value={boolToSelect(draftFilters.candidate_surprise)}
              onChange={(event) =>
                setDraftFilters((prev) => ({
                  ...prev,
                  candidate_surprise: selectToBool(event.target.value)
                }))
              }
            >
              <option value="any">Any</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>

          <label>
            Sort
            <select
              value={draftFilters.sort || "highest_cosine"}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, sort: event.target.value as PairFilters["sort"] }))
              }
            >
              <option value="highest_cosine">Highest cosine</option>
              <option value="lowest_cosine">Lowest cosine</option>
              <option value="shortest_delay">Shortest delay</option>
              <option value="longest_delay">Longest delay</option>
            </select>
          </label>

          <label>
            Page size
            <input
              type="number"
              step="1"
              min={1}
              max={200}
              value={numberInputValue(draftFilters.page_size)}
              onChange={(event) =>
                setDraftFilters((prev) => ({ ...prev, page_size: toOptionalNumber(event.target.value) }))
              }
            />
          </label>
        </div>

        <div className="button-row">
          <button className="btn btn-primary" onClick={applyFilters}>
            Apply Filters
          </button>
          <button className="btn btn-ghost" onClick={resetFilters}>
            Reset
          </button>
        </div>

        <div className="section-title">Pair Queue</div>
        <div className="queue-meta">
          {loadingList ? "Loading..." : `${pairList?.total.toLocaleString() || 0} pairs matched`}
        </div>

        <div className="queue-list">
          {(pairList?.rows || []).map((row) => (
            <button
              key={row.pair_id}
              className={`queue-item ${row.pair_id === pairId ? "selected" : ""}`}
              onClick={() => navigate(`/review/${row.pair_id}`)}
            >
              <div className="queue-title">{shortTitle(row)}</div>
              <div className="queue-subtitle">
                cosine {fmtNumber(row.cosine_similarity, 4)} | delay {fmtNumber(row.delay_days)} | rank {fmtNumber(row.rival_rank)}
              </div>
              <div className="queue-subtitle">
                {row.my_label ? `My label: ${row.my_label}` : "Unlabeled by me"}
              </div>
            </button>
          ))}
        </div>

        <div className="pagination-row">
          <button className="btn btn-ghost" onClick={() => setFilterPage(page - 1)} disabled={page <= 1}>
            Prev
          </button>
          <span>
            Page {page} / {totalPages}
          </span>
          <button
            className="btn btn-ghost"
            onClick={() => setFilterPage(page + 1)}
            disabled={page >= totalPages}
          >
            Next
          </button>
        </div>
      </aside>

      <main className="panel main-panel">
        {error && <div className="error-banner">{error}</div>}

        <div className="header-row">
          <div>
            <h2>Review Pair</h2>
            <p>
              Select a pair from the queue or jump to the next unlabeled pair for your reviewer identity.
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => void loadNextPair()}>
            Next Unlabeled Pair
          </button>
        </div>

        {!selectedPair && !loadingPair && (
          <div className="empty-card">No pair is selected. Choose one from the queue or click Next Unlabeled Pair.</div>
        )}

        {loadingPair && <div className="empty-card">Loading pair details...</div>}

        {selectedPair && (
          <>
            <section className="pair-overview">
              <div>
                <div className="eyebrow">Pair ID</div>
                <strong>{selectedPair.pair_id}</strong>
              </div>
              <div>
                <div className="eyebrow">Cosine similarity</div>
                <strong>{fmtNumber(selectedPair.cosine_similarity, 4)}</strong>
              </div>
              <div>
                <div className="eyebrow">Delay days</div>
                <strong>{fmtNumber(selectedPair.delay_days)}</strong>
              </div>
              <div>
                <div className="eyebrow">Rival rank</div>
                <strong>{fmtNumber(selectedPair.rival_rank)}</strong>
              </div>
            </section>

            <section className="chip-row">
              <span className="chip">Same SIC: {boolTag(selectedPair.same_sic)}</span>
              <span className="chip">Same action: {boolTag(selectedPair.same_action)}</span>
              <span className="chip">Focal surprise: {boolTag(selectedPair.focal_competitive_surprise)}</span>
              <span className="chip">Candidate surprise: {boolTag(selectedPair.candidate_competitive_surprise)}</span>
            </section>

            <section className="event-grid">
              <article className="event-card">
                <h3>Focal Event</h3>
                <h4>{compactText(selectedPair.focal_title)}</h4>
                <p>
                  <strong>Company:</strong> {compactText(selectedPair.focal_company)}
                  <br />
                  <strong>Date:</strong> {fmtDate(selectedPair.focal_date)}
                  <br />
                  <strong>Source:</strong> {compactText(selectedPair.focal_source)}
                  <br />
                  <strong>GVKEY:</strong> {compactText(selectedPair.focal_gvkey)} | <strong>SIC:</strong>{" "}
                  {compactText(selectedPair.focal_sic)}
                  <br />
                  <strong>Action:</strong> {compactText(selectedPair.focal_action)}
                </p>
                {selectedPair.focal_link && (
                  <a href={selectedPair.focal_link} target="_blank" rel="noreferrer">
                    Open source link
                  </a>
                )}
                <div className="text-block">
                  <div className="eyebrow">Action summary</div>
                  {compactText(selectedPair.focal_action_summary)}
                </div>
                <div className="text-block">
                  <div className="eyebrow">Content excerpt</div>
                  {compactText(selectedPair.focal_content_excerpt)}
                </div>
              </article>

              <article className="event-card candidate">
                <h3>Candidate Response</h3>
                <h4>{compactText(selectedPair.candidate_title)}</h4>
                <p>
                  <strong>Company:</strong> {compactText(selectedPair.candidate_company)}
                  <br />
                  <strong>Date:</strong> {fmtDate(selectedPair.candidate_date)}
                  <br />
                  <strong>Source:</strong> {compactText(selectedPair.candidate_source)}
                  <br />
                  <strong>GVKEY:</strong> {compactText(selectedPair.candidate_gvkey)} | <strong>SIC:</strong>{" "}
                  {compactText(selectedPair.candidate_sic)}
                  <br />
                  <strong>Action:</strong> {compactText(selectedPair.candidate_action)}
                </p>
                {selectedPair.candidate_link && (
                  <a href={selectedPair.candidate_link} target="_blank" rel="noreferrer">
                    Open source link
                  </a>
                )}
                <div className="text-block">
                  <div className="eyebrow">Action summary</div>
                  {compactText(selectedPair.candidate_action_summary)}
                </div>
                <div className="text-block">
                  <div className="eyebrow">Content excerpt</div>
                  {compactText(selectedPair.candidate_content_excerpt)}
                </div>
              </article>
            </section>

            <section className="judgment-card">
              <div className="header-row compact">
                <div>
                  <h3>Your Judgment</h3>
                  <p>
                    {pairDetails?.judgment
                      ? `Already labeled by you as ${pairDetails.judgment.label} (updated ${fmtDate(
                          pairDetails.judgment.updated_at
                        )}).`
                      : "Not labeled by you yet."}
                  </p>
                </div>
              </div>

              <div className="judgment-grid">
                <label>
                  Label
                  <select value={label} onChange={(event) => setLabel(event.target.value as JudgmentLabel)}>
                    {LABELS.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Confidence ({confidence}/5)
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={confidence}
                    onChange={(event) => setConfidence(Number(event.target.value))}
                  />
                </label>

                <label className="full-width">
                  Notes (optional)
                  <textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Brief justification for the classification..."
                  />
                </label>
              </div>

              <div className="button-row">
                <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave(false)}>
                  {saving ? "Saving..." : "Save"}
                </button>
                <button className="btn btn-ghost" disabled={saving} onClick={() => void handleSave(true)}>
                  Save + Next
                </button>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
