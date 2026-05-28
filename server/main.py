"""Legacy local FastAPI backend.

Do not deploy this module to Cloudflare. The cloud runtime lives in worker/src/index.ts.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

APP_DIR = Path(__file__).resolve().parents[1]
WORKING_DB = Path(os.environ.get("WORKING_DB", str(APP_DIR / "working_pairs.db")))
MASTER_DB_PATH = Path(
    os.environ.get(
        "MASTER_DB_PATH",
        "/Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/master_data/master_data.db",
    )
)

app = FastAPI(title="Pair Reviewer API", version="0.1.0")
api = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _conn_pairs_ro() -> sqlite3.Connection:
    return sqlite3.connect(
        f"file:{WORKING_DB}?mode=ro", uri=True, check_same_thread=False
    )


def _conn_pairs_rw() -> sqlite3.Connection:
    conn = sqlite3.connect(str(WORKING_DB), check_same_thread=False)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS judgments (
            focal_master_id TEXT, candidate_master_id TEXT,
            cosine_similarity REAL, delay_days REAL,
            label TEXT, confidence INTEGER, notes TEXT, timestamp TEXT,
            PRIMARY KEY (focal_master_id, candidate_master_id)
        )
        """)
    conn.commit()
    return conn


def _conn_master_ro() -> sqlite3.Connection:
    conn = sqlite3.connect(
        f"file:{MASTER_DB_PATH}?mode=ro", uri=True, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    return conn


def _pair_columns() -> List[str]:
    return [
        "focal_master_id",
        "candidate_master_id",
        "cosine_similarity",
        "delay_days",
        "rival_rank",
        "same_sic",
        "same_action",
        "focal_competitive_surprise",
        "candidate_competitive_surprise",
        "focal_action",
        "candidate_action",
        "focal_gvkey",
        "responder_gvkey",
        "focal_title",
    ]


def _row_to_dict(cols: List[str], row: Tuple[Any, ...]) -> Dict[str, Any]:
    return {cols[i]: row[i] for i in range(len(cols))}


@api.get("/health")
def health() -> Dict[str, str]:
    return {"ok": "true"}


@api.get("/stats")
def stats() -> Dict[str, Any]:
    conn = _conn_pairs_ro()
    row = conn.execute("""
        SELECT MIN(cosine_similarity), MAX(cosine_similarity),
               MIN(delay_days), MAX(delay_days),
               MIN(CAST(rival_rank AS INTEGER)), MAX(CAST(rival_rank AS INTEGER))
        FROM pairs
        """).fetchone()

    def sf(v, d):
        return d if v is None else v

    stats_out = {
        "cosine": [float(sf(row[0], 0.0)), float(sf(row[1], 1.0))],
        "delay": [float(sf(row[2], 0.0)), float(sf(row[3], 730.0))],
        "rank": [int(sf(row[4], 1)), int(sf(row[5], 20))],
    }

    def distinct(col: str) -> List[str]:
        rows = conn.execute(
            f"SELECT DISTINCT {col} FROM pairs WHERE {col} IS NOT NULL ORDER BY 1"
        ).fetchall()
        return [r[0] for r in rows if r[0] is not None]

    stats_out["focal_actions"] = distinct("focal_action")
    stats_out["cand_actions"] = distinct("candidate_action")
    stats_out["focal_datasets"] = distinct("focal_dataset_type")
    stats_out["cand_datasets"] = distinct("candidate_dataset_type")
    conn.close()
    return stats_out


@api.get("/pairs")
def list_pairs(
    cosine_min: Optional[float] = None,
    cosine_max: Optional[float] = None,
    delay_min: Optional[float] = None,
    delay_max: Optional[float] = None,
    rank_max: Optional[int] = None,
    same_sic: Optional[str] = Query(None, pattern="^(yes|no|any)?$"),
    same_action: Optional[str] = Query(None, pattern="^(yes|no|any)?$"),
    focal_surprise: Optional[str] = Query(None, pattern="^(yes|no|any)?$"),
    cand_surprise: Optional[str] = Query(None, pattern="^(yes|no|any)?$"),
    focal_action: Optional[List[str]] = Query(None),
    cand_action: Optional[List[str]] = Query(None),
    focal_dataset: Optional[List[str]] = Query(None),
    cand_dataset: Optional[List[str]] = Query(None),
    keyword: Optional[str] = None,
    sort: Optional[str] = None,
    sample_size: Optional[int] = None,
    offset: int = 0,
    limit: int = 50,
) -> Dict[str, Any]:
    conn = _conn_pairs_ro()
    where: List[str] = []
    params: List[Any] = []

    if cosine_min is not None:
        where.append("CAST(cosine_similarity AS REAL) >= ?")
        params.append(cosine_min)
    if cosine_max is not None:
        where.append("CAST(cosine_similarity AS REAL) <= ?")
        params.append(cosine_max)
    if delay_min is not None:
        where.append("CAST(delay_days AS REAL) >= ?")
        params.append(delay_min)
    if delay_max is not None:
        where.append("CAST(delay_days AS REAL) <= ?")
        params.append(delay_max)
    if rank_max is not None:
        where.append("CAST(rival_rank AS INTEGER) <= ?")
        params.append(rank_max)

    def bool_clause(val: Optional[str], col: str):
        if val == "yes":
            where.append(f"(CAST({col} AS INTEGER) = 1)")
        elif val == "no":
            where.append(f"(CAST({col} AS INTEGER) = 0 OR {col} IS NULL)")

    bool_clause(same_sic, "same_sic")
    bool_clause(same_action, "same_action")
    bool_clause(focal_surprise, "focal_competitive_surprise")
    bool_clause(cand_surprise, "candidate_competitive_surprise")

    def in_clause(values: Optional[List[str]], col: str):
        if values:
            placeholders = ",".join(["?"] * len(values))
            where.append(f"{col} IN ({placeholders})")
            params.extend(values)

    in_clause(focal_action, "focal_action")
    in_clause(cand_action, "candidate_action")
    in_clause(focal_dataset, "focal_dataset_type")
    in_clause(cand_dataset, "candidate_dataset_type")

    if keyword:
        where.append("LOWER(focal_title) LIKE LOWER(?)")
        params.append(f"%{keyword}%")

    where_sql = " AND ".join(where) if where else "1=1"

    allowed_sorts = {
        "cosine_similarity DESC",
        "cosine_similarity ASC",
        "delay_days ASC",
        "delay_days DESC",
        "focal_master_id ASC",
    }
    order_sql = sort if sort in allowed_sorts else "cosine_similarity DESC"
    cols = _pair_columns()
    select_cols = ", ".join(cols)

    if sample_size is not None and sample_size > 0:
        bounds = conn.execute(
            f"SELECT MIN(CAST(cosine_similarity AS REAL)), MAX(CAST(cosine_similarity AS REAL)) FROM pairs WHERE {where_sql}",
            params,
        ).fetchone()
        cmin, cmax = bounds[0], bounds[1]
        if cmin is None or cmax is None:
            conn.close()
            return {"total": 0, "rows": []}

        bin_count = 5
        span = (cmax - cmin) / bin_count if cmax > cmin else 0.0
        per_bin = max(1, int(sample_size / bin_count))

        unions: List[str] = []
        union_params: List[Any] = []
        for i in range(bin_count):
            lo = cmin + (span * i)
            hi = cmax if i == bin_count - 1 else cmin + (span * (i + 1))
            unions.append(
                "SELECT * FROM ("
                f"SELECT {select_cols} FROM pairs WHERE {where_sql} "
                f"AND CAST(cosine_similarity AS REAL) >= ? AND CAST(cosine_similarity AS REAL) <= ? "
                f"ORDER BY RANDOM() LIMIT {per_bin}"
                ")"
            )
            union_params.extend(params + [lo, hi])

        rows = conn.execute(" UNION ALL ".join(unions), union_params).fetchall()
        rows = rows[:sample_size]
        total = len(rows)
    else:
        total = conn.execute(
            f"SELECT COUNT(*) FROM pairs WHERE {where_sql}", params
        ).fetchone()[0]

        rows = conn.execute(
            f"SELECT {select_cols} FROM pairs WHERE {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()

    conn.close()
    return {"total": total, "rows": [_row_to_dict(cols, r) for r in rows]}


@api.get("/pair/{focal_id}/{candidate_id}")
def pair_details(focal_id: str, candidate_id: str) -> Dict[str, Any]:
    conn = _conn_pairs_ro()
    cols = _pair_columns()
    row = conn.execute(
        f"SELECT {', '.join(cols)} FROM pairs WHERE focal_master_id = ? AND candidate_master_id = ? LIMIT 1",
        (focal_id, candidate_id),
    ).fetchone()
    conn.close()
    pair = _row_to_dict(cols, row) if row else None

    mconn = _conn_master_ro()
    focal = mconn.execute(
        "SELECT * FROM master_data WHERE master_id = ? LIMIT 1", (focal_id,)
    ).fetchone()
    candidate = mconn.execute(
        "SELECT * FROM master_data WHERE master_id = ? LIMIT 1", (candidate_id,)
    ).fetchone()
    mconn.close()

    jconn = _conn_pairs_rw()
    jrow = jconn.execute(
        "SELECT focal_master_id,candidate_master_id,cosine_similarity,delay_days,label,confidence,notes,timestamp "
        "FROM judgments WHERE focal_master_id=? AND candidate_master_id=?",
        (focal_id, candidate_id),
    ).fetchone()
    jconn.close()

    judgment = None
    if jrow:
        judgment = {
            "focal_master_id": jrow[0],
            "candidate_master_id": jrow[1],
            "cosine_similarity": jrow[2],
            "delay_days": jrow[3],
            "label": jrow[4],
            "confidence": jrow[5],
            "notes": jrow[6],
            "timestamp": jrow[7],
        }

    return {
        "pair": pair,
        "focal": dict(focal) if focal else None,
        "candidate": dict(candidate) if candidate else None,
        "judgment": judgment,
    }


@api.get("/judgments")
def list_judgments(limit: int = 1000, offset: int = 0) -> List[Dict[str, Any]]:
    conn = _conn_pairs_rw()
    rows = conn.execute(
        "SELECT focal_master_id,candidate_master_id,cosine_similarity,delay_days,label,confidence,notes,timestamp "
        "FROM judgments ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        (limit, offset),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        out.append(
            {
                "focal_master_id": r[0],
                "candidate_master_id": r[1],
                "cosine_similarity": r[2],
                "delay_days": r[3],
                "label": r[4],
                "confidence": r[5],
                "notes": r[6],
                "timestamp": r[7],
            }
        )
    return out


@api.post("/judgments")
def save_judgment(payload: Dict[str, Any]) -> Dict[str, Any]:
    required = ["focal_master_id", "candidate_master_id", "label", "confidence"]
    if any(k not in payload for k in required):
        raise HTTPException(status_code=400, detail="Missing required fields")

    conn = _conn_pairs_rw()
    conn.execute(
        """
        INSERT INTO judgments VALUES (?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(focal_master_id,candidate_master_id) DO UPDATE SET
            label=excluded.label,
            confidence=excluded.confidence,
            notes=excluded.notes,
            timestamp=datetime('now')
        """,
        (
            payload.get("focal_master_id"),
            payload.get("candidate_master_id"),
            payload.get("cosine_similarity"),
            payload.get("delay_days"),
            payload.get("label"),
            int(payload.get("confidence", 3)),
            payload.get("notes", ""),
        ),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


app.include_router(api)
