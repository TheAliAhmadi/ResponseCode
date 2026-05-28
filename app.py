"""
Competitive Response Pair Reviewer
====================================
Run setup.py once first, then:  streamlit run app.py

LEGACY LOCAL TOOLING ONLY:
This Streamlit entrypoint is not part of the Cloudflare deployment.
"""

import streamlit as st
import pandas as pd
import sqlite3
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

# ── Config ─────────────────────────────────────────────────────────────────
MASTER_DB_PATH = "/Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/master_data/master_data.db"
WORKING_DB = "/Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/App/working_pairs.db"
DISPLAY_CAP = 50_000

LABEL_OPTIONS = [
    "—",
    "DIRECT_RESPONSE",
    "PLAUSIBLE_RESPONSE",
    "COMMON_SHOCK",
    "UNRELATED",
    "INSUFFICIENT_EVIDENCE",
    "SKIP",
]
LABEL_COLORS = {
    "DIRECT_RESPONSE": ("#166534", "#dcfce7"),
    "PLAUSIBLE_RESPONSE": ("#1e40af", "#dbeafe"),
    "COMMON_SHOCK": ("#92400e", "#fef3c7"),
    "UNRELATED": ("#991b1b", "#fee2e2"),
    "INSUFFICIENT_EVIDENCE": ("#5b21b6", "#ede9fe"),
    "SKIP": ("#4b5563", "#f3f4f6"),
    "—": ("#6b7280", "#f9fafb"),
}
SORT_SQL = {
    "Highest cosine": "cosine_similarity DESC NULLS LAST",
    "Lowest cosine": "cosine_similarity ASC NULLS LAST",
    "Shortest delay": "delay_days ASC NULLS LAST",
    "Longest delay": "delay_days DESC NULLS LAST",
    "By focal ID": "focal_master_id ASC",
}


# ── CSS ─────────────────────────────────────────────────────────────────────
def inject_css():
    st.markdown(
        """<style>
/* ── layout ── */
.block-container { padding-top:0.75rem !important; padding-bottom:2rem; max-width:1380px; }
footer, [data-testid="stDecoration"] { display:none !important; }

/* ── force light text on all custom white-background elements ── */
.ecard, .pbanner, .sbox, .jcard {
    color: #111827 !important;
}

/* ── event card ── */
.ecard {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 1rem 1.2rem 0.8rem;
    margin-bottom: 0.5rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.ecard-focal      { border-top: 3px solid #2563eb; }
.ecard-candidate  { border-top: 3px solid #16a34a; }
.ecard-title {
    font-size: 0.97rem;
    font-weight: 700;
    line-height: 1.45;
    margin: 0.4rem 0 0.55rem;
    color: #111827;
}
.ecard-meta {
    font-size: 0.82rem;
    color: #4b5563;
    margin-bottom: 0.4rem;
    line-height: 1.7;
}
.ecard-meta b { color: #1e293b; }

/* ── pair banner ── */
.pbanner {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 0.6rem 1rem;
    margin-bottom: 0.9rem;
    font-size: 0.875rem;
    line-height: 1.9;
    color: #1e293b;
}
.pbanner b { color: #111827; }

/* ── summary box ── */
.sbox {
    background: #f0f9ff;
    border-left: 3px solid #0ea5e9;
    border-radius: 0 6px 6px 0;
    padding: 0.55rem 0.85rem;
    margin: 0.45rem 0;
    font-size: 0.855rem;
    line-height: 1.6;
    color: #0c4a6e;
}

/* ── judgment card ── */
.jcard {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 1rem 1.2rem;
    margin-top: 0.25rem;
}

/* ── pills ── */
.pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 20px;
    font-size: 0.72rem;
    font-weight: 600;
    margin: 1px 2px 1px 0;
    white-space: nowrap;
    line-height: 1.6;
}
.p-surp    { background:#fef2f2; color:#dc2626; border:1px solid #fca5a5; }
.p-nosurp  { background:#f0fdf4; color:#16a34a; border:1px solid #86efac; }
.p-dataset { background:#f5f3ff; color:#7c3aed; border:1px solid #c4b5fd; }
.p-match   { background:#ecfdf5; color:#15803d; border:1px solid #6ee7b7; }
.p-nomatch { background:#f9fafb; color:#6b7280; border:1px solid #d1d5db; }
.p-term    { background:#f8fafc; color:#475569; border:1px solid #cbd5e1; font-weight:400; }
.p-action  { background:#eff6ff; color:#1d4ed8; border:1px solid #93c5fd; }

/* ── section label ── */
.slbl {
    font-size: 0.67rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #94a3b8;
    display: block;
    margin-bottom: 1px;
}

/* ── label badge ── */
.lbadge {
    display: inline-block;
    padding: 3px 12px;
    border-radius: 20px;
    font-size: 0.82rem;
    font-weight: 700;
}

/* ── divider ── */
.divider { border:none; border-top:1px solid #e5e7eb; margin:0.6rem 0; }
</style>""",
        unsafe_allow_html=True,
    )


# ── Working pairs DB (read-only) ────────────────────────────────────────────
@st.cache_resource(show_spinner=False)
def get_pairs_conn():
    return sqlite3.connect(
        f"file:{WORKING_DB}?mode=ro", uri=True, check_same_thread=False
    )


@st.cache_data(show_spinner=False)
def get_filter_stats() -> dict:
    conn = get_pairs_conn()
    row = conn.execute("""
        SELECT MIN(cosine_similarity), MAX(cosine_similarity),
               MIN(delay_days),        MAX(delay_days),
               MIN(CAST(rival_rank AS INTEGER)), MAX(CAST(rival_rank AS INTEGER))
        FROM pairs
    """).fetchone()

    def sf(v, d):
        return d if v is None else v

    stats = {
        "cosine": (float(sf(row[0], 0.0)), float(sf(row[1], 1.0))),
        "delay": (float(sf(row[2], 0.0)), float(sf(row[3], 730.0))),
        "rank": (int(sf(row[4], 1)), int(sf(row[5], 20))),
    }
    for col, key in [
        ("focal_action", "focal_actions"),
        ("candidate_action", "cand_actions"),
        ("focal_dataset_type", "focal_datasets"),
        ("candidate_dataset_type", "cand_datasets"),
    ]:
        try:
            rows = conn.execute(
                f"SELECT DISTINCT {col} FROM pairs WHERE {col} IS NOT NULL ORDER BY 1"
            ).fetchall()
            stats[key] = [r[0] for r in rows if r[0] is not None]
        except Exception:
            stats[key] = []
    return stats


@st.cache_data(show_spinner="Filtering pairs…")
def load_filtered(where_sql: str, order_sql: str) -> pd.DataFrame:
    conn = get_pairs_conn()
    df = pd.read_sql(
        f"SELECT * FROM pairs WHERE {where_sql} ORDER BY {order_sql} LIMIT {DISPLAY_CAP}",
        conn,
    )
    for col in (
        "cosine_similarity",
        "delay_days",
        "rival_rank",
        "same_sic",
        "same_action",
        "focal_competitive_surprise",
        "candidate_competitive_surprise",
    ):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in ("focal_master_id", "candidate_master_id"):
        if col in df.columns:
            df[col] = df[col].astype(str).str.strip()
    return df


# ── Master DB ───────────────────────────────────────────────────────────────
@st.cache_resource(show_spinner=False)
def get_master_conn():
    conn = sqlite3.connect(
        f"file:{MASTER_DB_PATH}?mode=ro", uri=True, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    tables = [
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    ]
    tname = (
        "master_data" if "master_data" in tables else (tables[0] if tables else None)
    )
    query = None
    if tname:
        want = [
            "master_id",
            "title",
            "published_date",
            "name_source",
            "link",
            "description",
            "content",
            "gvkey",
            "conm",
            "company_name",
            "sic",
            "primary_action_type",
            "action",
            "competitive_surprise",
            "surprise_type",
            "surprise_element",
            "is_surprise",
            "dataset_type",
            "action_summary_1200",
            "competitive_move",
            "product_service_terms",
            "market_domain_terms",
            "technology_terms",
            "geography_terms",
            "customer_segment_terms",
            "strategic_purpose",
        ]
        avail = {r[1] for r in conn.execute(f"PRAGMA table_info({tname})").fetchall()}
        cols = ", ".join(c for c in want if c in avail)
        query = f"SELECT {cols} FROM {tname} WHERE master_id = ? LIMIT 1"
    return SimpleNamespace(conn=conn, tname=tname, query=query)


@st.cache_data(max_entries=1024, show_spinner=False)
def get_event(master_id: str):
    if not master_id:
        return None
    db = get_master_conn()
    if not db.query:
        return None
    row = db.conn.execute(db.query, (master_id,)).fetchone()
    return dict(row) if row else None


# ── Judgments ───────────────────────────────────────────────────────────────
@st.cache_resource
def get_judgments_conn():
    conn = sqlite3.connect(WORKING_DB, check_same_thread=False)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS judgments (
            focal_master_id TEXT, candidate_master_id TEXT,
            cosine_similarity REAL, delay_days REAL,
            label TEXT, confidence INTEGER, notes TEXT, timestamp TEXT,
            PRIMARY KEY (focal_master_id, candidate_master_id)
        )""")
    conn.commit()
    return conn


def save_judgment(fid, cid, sim, delay, label, conf, notes):
    def sf(val):
        try:
            f = float(val)
            return None if f != f else f
        except Exception:
            return None

    ts = datetime.now().isoformat(timespec="seconds")
    get_judgments_conn().execute(
        """
        INSERT INTO judgments VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(focal_master_id,candidate_master_id) DO UPDATE SET
            label=excluded.label, confidence=excluded.confidence,
            notes=excluded.notes, timestamp=excluded.timestamp
    """,
        (str(fid), str(cid), sf(sim), sf(delay), label, int(conf), notes, ts),
    )
    get_judgments_conn().commit()
    _export_csv()


def load_judgment(fid, cid):
    row = (
        get_judgments_conn()
        .execute(
            "SELECT label,confidence,notes FROM judgments "
            "WHERE focal_master_id=? AND candidate_master_id=?",
            (str(fid), str(cid)),
        )
        .fetchone()
    )
    return (
        {"label": row[0], "confidence": int(row[1] or 3), "notes": row[2] or ""}
        if row
        else None
    )


def _export_csv():
    try:
        df = pd.read_sql(
            "SELECT * FROM judgments ORDER BY timestamp DESC", get_judgments_conn()
        )
        path = str(Path(WORKING_DB).parent / "pair_judgments.csv")
        df.to_csv(path, index=False)
        return path
    except Exception:
        return None


def count_judgments():
    try:
        return (
            get_judgments_conn()
            .execute(
                "SELECT COUNT(*) FROM judgments WHERE label IS NOT NULL AND label != '—'"
            )
            .fetchone()[0]
        )
    except Exception:
        return 0


# ── Rendering helpers ────────────────────────────────────────────────────────
def v(rec, key, default="—"):
    if not rec:
        return default
    val = rec.get(key)
    if val is None:
        return default
    if isinstance(val, float) and val != val:
        return default
    s = str(val).strip()
    return s if s not in ("", "None", "nan", "NaN") else default


def parse_json_list(s):
    if not s or s == "—":
        return []
    try:
        r = json.loads(s)
        if isinstance(r, list):
            return [str(x) for x in r if x]
    except Exception:
        pass
    return [x.strip() for x in s.strip("[]\"'").split(",") if x.strip()]


def pill(text, cls):
    return f'<span class="pill {cls}">{text}</span>'


def label_badge(label):
    fg, bg = LABEL_COLORS.get(label, ("#6b7280", "#f9fafb"))
    return (
        f'<span class="lbadge" '
        f'style="background:{bg};color:{fg};border:1px solid {fg}55">{label}</span>'
    )


def fmt_num(val, d=0):
    if val is None:
        return "—"
    try:
        f = float(val)
        return "—" if f != f else f"{f:.{d}f}"
    except (ValueError, TypeError):
        return "—"


def terms_pills(rec, key, limit=8):
    items = parse_json_list(v(rec, key))
    return " ".join(pill(t, "p-term") for t in items[:limit]) if items else ""


# ── Event card ───────────────────────────────────────────────────────────────
def event_card(rec, side: str):
    is_focal = side == "focal"
    cls = "ecard-focal" if is_focal else "ecard-candidate"
    side_label = "🔵 FOCAL EVENT" if is_focal else "🟢 CANDIDATE RESPONSE"

    if not rec:
        st.markdown(
            f'<div class="ecard {cls}">'
            f'<span class="slbl">{side_label}</span>'
            f'<p style="color:#9ca3af;font-style:italic;margin:0.5rem 0">Event not found in master DB.</p>'
            f"</div>",
            unsafe_allow_html=True,
        )
        return

    title = v(rec, "title", "*(no title)*")
    company = (
        v(rec, "company_name") if v(rec, "company_name") != "—" else v(rec, "conm", "—")
    )
    gvkey = v(rec, "gvkey")
    sic = v(rec, "sic")
    date = v(rec, "published_date")
    source = v(rec, "name_source")
    link = v(rec, "link")
    action = (
        v(rec, "primary_action_type")
        if v(rec, "primary_action_type") != "—"
        else v(rec, "action", "—")
    )
    summary = v(rec, "action_summary_1200", "")
    move = v(rec, "competitive_move", "")
    stype = v(rec, "surprise_type", "")
    selement = v(rec, "surprise_element", "")
    purpose = v(rec, "strategic_purpose", "")

    is_surp = str(
        v(rec, "is_surprise", v(rec, "competitive_surprise", "0"))
    ).lower() in ("1", "true", "yes")
    surp_pill = (
        pill("⚡ SURPRISE", "p-surp") if is_surp else pill("no surprise", "p-nosurp")
    )
    ds_pill = pill(v(rec, "dataset_type", "?").upper(), "p-dataset")
    act_pill = pill(action, "p-action")
    link_html = (
        f' · <a href="{link}" target="_blank" style="color:#2563eb;font-size:0.8rem">↗ article</a>'
        if link and link != "—"
        else ""
    )

    surp_extra = ""
    if stype and stype != "—":
        se = f" ({selement})" if selement and selement != "—" else ""
        surp_extra = f'<div style="font-size:0.82rem;color:#4b5563;margin:3px 0">⚡ {stype}{se}</div>'

    t_products = terms_pills(rec, "product_service_terms")
    t_market = terms_pills(rec, "market_domain_terms")
    t_tech = terms_pills(rec, "technology_terms")
    t_geo = terms_pills(rec, "geography_terms")
    t_cust = terms_pills(rec, "customer_segment_terms")

    def terms_row_html(label, pills_html):
        if not pills_html:
            return ""
        return (
            f'<div style="margin:3px 0">'
            f'<span class="slbl">{label}</span>{pills_html}</div>'
        )

    terms_html = "".join(
        [
            terms_row_html("Products / Services", t_products),
            terms_row_html("Market domains", t_market),
            terms_row_html("Technology", t_tech),
            terms_row_html("Geography", t_geo),
            terms_row_html("Customer segments", t_cust),
        ]
    )

    move_html = (
        f'<div style="margin:4px 0">{pill("↪ "+move,"p-action")}</div>'
        if move and move != "—"
        else ""
    )
    purpose_html = (
        (
            f'<div style="font-size:0.83rem;color:#6b7280;font-style:italic;margin-top:5px">'
            f"🎯 {purpose}</div>"
        )
        if purpose and purpose != "—"
        else ""
    )
    summary_html = (
        (
            f'<div class="sbox">'
            f'<span class="slbl">Action Summary</span>{summary}</div>'
        )
        if summary and summary != "—"
        else ""
    )

    st.markdown(
        f"""
<div class="ecard {cls}">
  <span class="slbl">{side_label}</span>
  <div class="ecard-title">{title}</div>
  <div>{surp_pill}&nbsp;{ds_pill}&nbsp;{act_pill}</div>
  {surp_extra}
  <hr class="divider">
  <div class="ecard-meta">
    <b>{company}</b> &nbsp;·&nbsp; GVKEY: {gvkey} &nbsp;·&nbsp; SIC: {sic}<br>
    {date} &nbsp;·&nbsp; {source}{link_html}
  </div>
  {summary_html}
  {move_html}
  {terms_html}
  {purpose_html}
</div>""",
        unsafe_allow_html=True,
    )

    desc = v(rec, "description", "")
    content = v(rec, "content", "")
    if desc or content:
        with st.expander("📄 Description / Content"):
            if desc and desc != "—":
                st.write(desc)
            if content and content != "—":
                words = content.split()[:250]
                st.caption(" ".join(words) + (" …" if len(words) == 250 else ""))


# ── Pair banner ──────────────────────────────────────────────────────────────
def render_pair_banner(row: dict, existing):
    sim = row.get("cosine_similarity")
    delay = row.get("delay_days")
    rank = row.get("rival_rank")

    same_sic = str(row.get("same_sic", "")).lower() in ("1", "true", "yes")
    same_action = str(row.get("same_action", "")).lower() in ("1", "true", "yes")
    is_fsurp = str(row.get("focal_competitive_surprise", "")).lower() in (
        "1",
        "true",
        "yes",
    )
    is_csurp = str(row.get("candidate_competitive_surprise", "")).lower() in (
        "1",
        "true",
        "yes",
    )

    pills = " ".join(
        filter(
            None,
            [
                (
                    pill("Same SIC ✓", "p-match")
                    if same_sic
                    else pill("Diff SIC", "p-nomatch")
                ),
                (
                    pill("Same Action ✓", "p-match")
                    if same_action
                    else pill("Diff Action", "p-nomatch")
                ),
                pill("⚡ Focal Surprise", "p-surp") if is_fsurp else "",
                pill("⚡ Candidate Surprise", "p-surp") if is_csurp else "",
            ],
        )
    )

    f_act = row.get("focal_action", "—") or "—"
    c_act = row.get("candidate_action", "—") or "—"
    f_gv = row.get("focal_gvkey", "—") or "—"
    r_gv = row.get("responder_gvkey", "—") or "—"

    labeled_html = (
        label_badge(existing["label"])
        if existing
        else '<span style="color:#9ca3af">unlabeled</span>'
    )

    st.markdown(
        f"""
<div class="pbanner">
  <b>Cosine:</b> {fmt_num(sim,4)} &ensp;
  <b>Delay:</b> {fmt_num(delay,0)} days &ensp;
  <b>Rival rank:</b> {fmt_num(rank,0)} &ensp;
  {pills} &ensp; {labeled_html}
  <br>
  <span style="font-size:0.82rem;color:#6b7280">
    Focal GVKEY: <b style="color:#374151">{f_gv}</b> &nbsp;→&nbsp;
    Responder: <b style="color:#374151">{r_gv}</b> &nbsp;·&nbsp;
    Action: <b style="color:#374151">{f_act}</b> → <b style="color:#374151">{c_act}</b>
  </span>
</div>""",
        unsafe_allow_html=True,
    )


# ── Sidebar ───────────────────────────────────────────────────────────────────
def render_sidebar(stats: dict, n_filtered: int):
    sb = st.sidebar

    sb.markdown("## 🔍 Pair Reviewer")
    judged = count_judgments()
    c1, c2 = sb.columns(2)
    c1.metric("Judged", judged)
    cap_note = " ⚠️" if n_filtered >= DISPLAY_CAP else ""
    c2.metric("Filtered", f"{n_filtered:,}{cap_note}")

    sb.divider()

    # Pair navigation
    if "pair_idx" not in st.session_state:
        st.session_state.pair_idx = 0
    idx = st.session_state.pair_idx

    nav1, nav2, nav3 = sb.columns([1, 2, 1])
    if nav1.button(
        "◀", use_container_width=True, disabled=(idx == 0 or n_filtered == 0)
    ):
        st.session_state.pair_idx = idx - 1
        st.rerun()
    if n_filtered > 0:
        new_idx = nav2.number_input(
            "Go to pair",
            min_value=1,
            max_value=n_filtered,
            value=idx + 1,
            label_visibility="collapsed",
            key="nav_num",
        )
        if int(new_idx) - 1 != idx:
            st.session_state.pair_idx = int(new_idx) - 1
            st.rerun()
    else:
        nav2.write("")
    if nav3.button(
        "▶",
        use_container_width=True,
        disabled=(idx >= n_filtered - 1 or n_filtered == 0),
    ):
        st.session_state.pair_idx = idx + 1
        st.rerun()

    if n_filtered > 0:
        sb.caption(f"Pair **{idx+1:,}** of **{n_filtered:,}**")

    sb.divider()

    sort_label = sb.selectbox("↕ Sort by", list(SORT_SQL.keys()), key="f_sort")
    order_sql = SORT_SQL[sort_label]

    with sb.expander("🔍 Filters", expanded=False):
        cmin, cmax = stats["cosine"]
        cosine = st.slider(
            "Cosine similarity",
            cmin,
            cmax,
            (max(cmin, 0.3), cmax),
            0.01,
            "%.3f",
            key="f_cos",
        )

        dmin, dmax = stats["delay"]
        delay = st.slider(
            "Delay (days)", dmin, dmax, (dmin, dmax), 1.0, "%.0f", key="f_del"
        )

        rmin, rmax = stats["rank"]
        rank = st.slider("Max rival rank", rmin, rmax, min(rmax, 5), key="f_rnk")

        same_sic_opt = st.radio(
            "Same SIC", ["Any", "Yes", "No"], horizontal=True, key="f_sic"
        )
        same_action_opt = st.radio(
            "Same action", ["Any", "Yes", "No"], horizontal=True, key="f_act"
        )
        focal_surp_opt = st.radio(
            "Focal surprise", ["Any", "Yes", "No"], horizontal=True, key="f_fsp"
        )
        cand_surp_opt = st.radio(
            "Cand. surprise", ["Any", "Yes", "No"], horizontal=True, key="f_csp"
        )

        focal_acts = st.multiselect("Focal action", stats["focal_actions"], key="f_fa")
        cand_acts = st.multiselect(
            "Candidate action", stats["cand_actions"], key="f_ca"
        )
        focal_dsets = st.multiselect(
            "Focal dataset", stats["focal_datasets"], key="f_fd"
        )
        cand_dsets = st.multiselect("Cand. dataset", stats["cand_datasets"], key="f_cd")
        kw = st.text_input("🔎 Keyword in title", key="f_kw")

        if st.button("↺ Reset", use_container_width=True):
            for k in [
                "f_cos",
                "f_del",
                "f_rnk",
                "f_sic",
                "f_act",
                "f_fsp",
                "f_csp",
                "f_fa",
                "f_ca",
                "f_fd",
                "f_cd",
                "f_kw",
            ]:
                st.session_state.pop(k, None)
            st.rerun()

    sb.divider()
    if sb.button("📥 Export judgments CSV", use_container_width=True):
        path = _export_csv()
        if path:
            sb.success(f"Saved: {Path(path).name}")

    with sb.expander("📋 Last 10 judgments"):
        try:
            jdf = pd.read_sql(
                "SELECT focal_master_id,candidate_master_id,label,confidence,timestamp "
                "FROM judgments ORDER BY timestamp DESC LIMIT 10",
                get_judgments_conn(),
            )
            if not jdf.empty:
                st.dataframe(jdf, use_container_width=True, hide_index=True)
            else:
                st.caption("No judgments yet.")
        except Exception:
            st.caption("No judgments yet.")

    # Build WHERE
    parts = []
    if cosine[0] > cmin + 0.001:
        parts.append(f"CAST(cosine_similarity AS REAL) >= {cosine[0]:.4f}")
    if cosine[1] < cmax - 0.001:
        parts.append(f"CAST(cosine_similarity AS REAL) <= {cosine[1]:.4f}")
    if delay[0] > dmin + 0.5:
        parts.append(f"CAST(delay_days AS REAL) >= {delay[0]:.0f}")
    if delay[1] < dmax - 0.5:
        parts.append(f"CAST(delay_days AS REAL) <= {delay[1]:.0f}")
    if rank < rmax:
        parts.append(f"CAST(rival_rank AS INTEGER) <= {rank}")

    for opt, col in [(same_sic_opt, "same_sic"), (same_action_opt, "same_action")]:
        if opt == "Yes":
            parts.append(f"(CAST({col} AS INTEGER) = 1)")
        elif opt == "No":
            parts.append(f"(CAST({col} AS INTEGER) = 0 OR {col} IS NULL)")

    for opt, col in [
        (focal_surp_opt, "focal_competitive_surprise"),
        (cand_surp_opt, "candidate_competitive_surprise"),
    ]:
        if opt == "Yes":
            parts.append(f"(CAST({col} AS INTEGER) = 1)")
        elif opt == "No":
            parts.append(f"(CAST({col} AS INTEGER) = 0 OR {col} IS NULL)")

    for sel, col in [
        (focal_acts, "focal_action"),
        (cand_acts, "candidate_action"),
        (focal_dsets, "focal_dataset_type"),
        (cand_dsets, "candidate_dataset_type"),
    ]:
        if sel:
            quoted = ", ".join(f"'{s.replace(chr(39),chr(39)*2)}'" for s in sel)
            parts.append(f"{col} IN ({quoted})")

    if kw:
        esc = kw.replace("'", "''")
        parts.append(f"LOWER(focal_title) LIKE LOWER('%{esc}%')")

    return " AND ".join(parts) if parts else "1=1", order_sql


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    st.set_page_config(
        page_title="Pair Reviewer",
        page_icon="🔍",
        layout="wide",
        initial_sidebar_state="expanded",
    )
    inject_css()

    if not Path(WORKING_DB).exists():
        st.error("**Working database not found.** Run `python setup.py` first.")
        st.stop()

    get_master_conn()
    get_judgments_conn()
    stats = get_filter_stats()

    # First pass with no filter to get total count for sidebar
    filtered = load_filtered("1=1", "cosine_similarity DESC NULLS LAST")
    n = len(filtered)

    where_sql, order_sql = render_sidebar(stats, n)

    # Reload with actual filters
    filtered = load_filtered(where_sql, order_sql)
    n = len(filtered)

    if n == 0:
        st.warning(
            "No pairs match the current filters. Try relaxing the filters in the sidebar."
        )
        return

    if "pair_idx" not in st.session_state:
        st.session_state.pair_idx = 0
    st.session_state.pair_idx = max(0, min(st.session_state.pair_idx, n - 1))
    idx = st.session_state.pair_idx

    row = filtered.iloc[idx]
    fid = str(row.get("focal_master_id", "")).strip()
    cid = str(row.get("candidate_master_id", "")).strip()
    f_rec = get_event(fid)
    c_rec = get_event(cid)
    existing = load_judgment(fid, cid)

    render_pair_banner(row.to_dict(), existing)

    col_f, col_c = st.columns(2, gap="medium")
    with col_f:
        event_card(f_rec, "focal")
    with col_c:
        event_card(c_rec, "candidate")

    st.divider()

    prev_label = (existing or {}).get("label", "—")
    prev_conf = int((existing or {}).get("confidence", 3) or 3)
    prev_notes = (existing or {}).get("notes", "") or ""
    if prev_label not in LABEL_OPTIONS:
        prev_label = "—"
    if prev_conf not in range(1, 6):
        prev_conf = 3

    sim_val = row.get("cosine_similarity")
    delay_val = row.get("delay_days")

    st.markdown('<div class="jcard">', unsafe_allow_html=True)
    st.markdown("#### 🏷️ Label this pair")

    with st.form(key=f"j_{fid}_{cid}"):
        new_label = st.radio(
            "Label",
            LABEL_OPTIONS,
            index=LABEL_OPTIONS.index(prev_label),
            horizontal=True,
            label_visibility="collapsed",
        )
        jc1, jc2 = st.columns([4, 1])
        with jc1:
            new_notes = st.text_area(
                "Notes (optional)",
                value=prev_notes,
                height=68,
                placeholder="Why this label? Any context…",
            )
        with jc2:
            new_conf = st.slider(
                "Confidence",
                1,
                5,
                prev_conf,
                help="1 = very uncertain  ·  5 = very certain",
            )
            st.caption(f"{'★'*new_conf}{'☆'*(5-new_conf)}")

        bc1, bc2, _ = st.columns([1, 1, 3])
        save_btn = bc1.form_submit_button("💾 Save", use_container_width=True)
        save_next_btn = bc2.form_submit_button(
            "Save + Next ▶", use_container_width=True, type="primary"
        )

    if save_btn or save_next_btn:
        save_judgment(fid, cid, sim_val, delay_val, new_label, new_conf, new_notes)
        st.toast(f"Saved: {new_label}", icon="✅")
        if save_next_btn and idx < n - 1:
            st.session_state.pair_idx += 1
            st.rerun()

    st.markdown("</div>", unsafe_allow_html=True)

    judged = count_judgments()
    pct = judged / max(n, 1)
    st.progress(
        min(pct, 1.0),
        text=f"**{judged:,}** labeled of **{n:,}** pairs ({pct*100:.1f}%)",
    )


if __name__ == "__main__":
    main()
