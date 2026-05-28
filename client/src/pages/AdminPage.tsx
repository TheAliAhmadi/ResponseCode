import { useCallback, useEffect, useState } from "react";
import {
  adminJudgmentsCsvUrl,
  adminJudgmentsJsonUrl,
  getAdminDisagreements,
  getAdminJudgments,
  getMe,
  getStats
} from "../api";
import type {
  AdminDisagreementsResponse,
  AdminJudgmentsResponse,
  MeResponse,
  StatsResponse
} from "../types";

function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  return `${value.toFixed(1)}%`;
}

function fmtNum(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(digits);
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`;
}

export default function AdminPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [judgments, setJudgments] = useState<AdminJudgmentsResponse | null>(null);
  const [disagreements, setDisagreements] = useState<AdminDisagreementsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const meResponse = await getMe();
      setMe(meResponse);

      if (!meResponse.authenticated || !meResponse.is_admin) {
        setStats(null);
        setJudgments(null);
        setDisagreements(null);
        return;
      }

      const [statsResponse, judgmentsResponse, disagreementsResponse] = await Promise.all([
        getStats(),
        getAdminJudgments(),
        getAdminDisagreements()
      ]);

      setStats(statsResponse);
      setJudgments(judgmentsResponse);
      setDisagreements(disagreementsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  if (loading) {
    return <div className="workspace-empty">Loading admin dashboard...</div>;
  }

  if (!me?.authenticated) {
    return (
      <div className="workspace-empty">
        <div className="empty-card">
          <h2>Sign-in Required</h2>
          <p>Admin routes require reviewer identity. Use Cloudflare Access or local dev identity setup.</p>
        </div>
      </div>
    );
  }

  if (!me.is_admin) {
    return (
      <div className="workspace-empty">
        <div className="empty-card">
          <h2>Admin Access Required</h2>
          <p>
            Current reviewer: <strong>{me.reviewer?.email}</strong>
          </p>
          <p>Add this email to ADMIN_EMAILS in worker configuration to access admin exports and dashboards.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace admin-layout">
      <main className="panel main-panel full-width">
        {error && <div className="error-banner">{error}</div>}

        <div className="header-row">
          <div>
            <h2>Admin Dashboard</h2>
            <p>Track reviewer progress, inspect disagreement pairs, and export all judgments.</p>
          </div>
          <div className="button-row">
            <a className="btn btn-ghost" href={adminJudgmentsJsonUrl()} target="_blank" rel="noreferrer">
              Export JSON
            </a>
            <a className="btn btn-primary" href={adminJudgmentsCsvUrl()} target="_blank" rel="noreferrer">
              Export CSV
            </a>
          </div>
        </div>

        <section className="stats-cards">
          <article>
            <div className="eyebrow">Total pairs</div>
            <strong>{stats?.totals.pairs.toLocaleString() || 0}</strong>
          </article>
          <article>
            <div className="eyebrow">Total judgments</div>
            <strong>{stats?.totals.judgments.toLocaleString() || 0}</strong>
          </article>
          <article>
            <div className="eyebrow">Disagreement pairs</div>
            <strong>{disagreements?.total.toLocaleString() || 0}</strong>
          </article>
        </section>

        <section className="admin-grid">
          <article className="admin-card">
            <h3>Label Distribution</h3>
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.label_counts || []).map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td>{row.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>

          <article className="admin-card">
            <h3>Progress by Reviewer</h3>
            <table>
              <thead>
                <tr>
                  <th>Reviewer</th>
                  <th>Judgments</th>
                  <th>Progress</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.progress_by_reviewer || []).map((row) => (
                  <tr key={row.reviewer_id}>
                    <td>{row.email || row.reviewer_id}</td>
                    <td>{row.judgments.toLocaleString()}</td>
                    <td>{fmtPct(row.progress_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        </section>

        <section className="admin-card">
          <h3>Disagreements</h3>
          <p>
            Pairs shown below have at least 2 reviewers and conflicting labels. Count: {disagreements?.total || 0}
          </p>
          <div className="disagreement-list">
            {(disagreements?.rows || []).map((pair) => (
              <article key={pair.pair_id} className="disagreement-item">
                <div className="disagreement-head">
                  <strong>{pair.focal_title || "(missing focal title)"}</strong>
                  <span>vs</span>
                  <strong>{pair.candidate_title || "(missing candidate title)"}</strong>
                </div>
                <div className="disagreement-meta">
                  pair_id {pair.pair_id} | cosine {fmtNum(pair.cosine_similarity, 4)} | delay {fmtNum(pair.delay_days)}
                  | rank {fmtNum(pair.rival_rank)}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Reviewer</th>
                      <th>Label</th>
                      <th>Confidence</th>
                      <th>Updated</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pair.judgments.map((judgment) => (
                      <tr key={`${pair.pair_id}-${judgment.reviewer_id}-${judgment.updated_at}`}>
                        <td>{judgment.reviewer_email || judgment.reviewer_id}</td>
                        <td>{judgment.label}</td>
                        <td>{judgment.confidence}</td>
                        <td>{fmtDate(judgment.updated_at)}</td>
                        <td>{judgment.notes || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
          </div>
        </section>

        <section className="admin-card">
          <h3>Recent Judgments</h3>
          <p>Showing {judgments?.rows.length || 0} rows from the admin endpoint.</p>
          <table>
            <thead>
              <tr>
                <th>Updated</th>
                <th>Reviewer</th>
                <th>Label</th>
                <th>Confidence</th>
                <th>Pair</th>
              </tr>
            </thead>
            <tbody>
              {(judgments?.rows || []).map((row) => (
                <tr key={row.judgment_id}>
                  <td>{fmtDate(row.updated_at)}</td>
                  <td>{row.reviewer_email || row.reviewer_id}</td>
                  <td>{row.label}</td>
                  <td>{row.confidence}</td>
                  <td>{row.pair_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
