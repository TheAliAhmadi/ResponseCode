#!/usr/bin/env python3
"""Export a web-safe pairs dataset from local SQLite files into D1-compatible SQL.

This script intentionally exports only fields needed for online annotation.
It never exports full local databases and truncates content fields to excerpts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_OUTPUT_COLUMNS = [
    "pair_id",
    "focal_master_id",
    "candidate_master_id",
    "focal_title",
    "candidate_title",
    "focal_date",
    "candidate_date",
    "focal_source",
    "candidate_source",
    "focal_link",
    "candidate_link",
    "focal_content_excerpt",
    "candidate_content_excerpt",
    "focal_action_summary",
    "candidate_action_summary",
    "focal_action",
    "candidate_action",
    "focal_company",
    "candidate_company",
    "focal_gvkey",
    "candidate_gvkey",
    "focal_sic",
    "candidate_sic",
    "cosine_similarity",
    "delay_days",
    "rival_rank",
    "same_sic",
    "same_action",
    "focal_competitive_surprise",
    "candidate_competitive_surprise",
]

REQUIRED_PAIR_COLUMNS = [
    "focal_master_id",
    "candidate_master_id",
    "focal_title",
    "candidate_title",
    "focal_date",
    "candidate_date",
    "focal_action",
    "candidate_action",
    "focal_gvkey",
    "responder_gvkey",
    "focal_sic",
    "candidate_sic",
    "cosine_similarity",
    "delay_days",
    "rival_rank",
    "same_sic",
    "same_action",
    "focal_competitive_surprise",
    "candidate_competitive_surprise",
]

MASTER_CANDIDATE_COLUMNS = [
    "master_id",
    "title",
    "published_date",
    "name_source",
    "link",
    "description",
    "content",
    "gvkey",
    "company_name",
    "conm",
    "sic",
    "action_summary_1200",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export D1 seed SQL from working pair data."
    )
    parser.add_argument(
        "--working-db",
        default=str(ROOT / "working_pairs.db"),
        help="Path to working_pairs.db",
    )
    parser.add_argument(
        "--master-db",
        default="",
        help="Optional path to master_data.db for enrichment",
    )
    parser.add_argument(
        "--output-sql",
        default=str(ROOT / "scripts" / "d1_pairs_seed.sql"),
        help="Output SQL file path (D1 compatible)",
    )
    parser.add_argument(
        "--report-json",
        default=str(ROOT / "scripts" / "export_report.json"),
        help="Output JSON report path",
    )
    parser.add_argument(
        "--excerpt-length",
        type=int,
        default=1200,
        help="Maximum characters for excerpt and fallback summary text",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional max rows to export (0 = all rows)",
    )
    return parser.parse_args()


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def truncate_text(value: Any, max_len: int) -> str:
    text = clean_text(value)
    if len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "..."


def parse_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(num) or math.isinf(num):
        return None
    return num


def parse_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def parse_bool_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return 1 if value else 0

    text = clean_text(value).lower()
    if text in {"1", "true", "yes", "y"}:
        return 1
    if text in {"0", "false", "no", "n"}:
        return 0

    parsed = parse_int(value)
    if parsed is None:
        return None
    return 1 if parsed != 0 else 0


def to_sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return "NULL"
        return repr(value)

    text = str(value).replace("'", "''")
    return f"'{text}'"


def hash_pair_id(focal_master_id: str, candidate_master_id: str) -> str:
    payload = f"{focal_master_id}::{candidate_master_id}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def table_columns(conn: sqlite3.Connection, table_name: str) -> List[str]:
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return [str(row[1]) for row in rows]


def chunked(values: List[str], chunk_size: int) -> Iterable[List[str]]:
    for idx in range(0, len(values), chunk_size):
        yield values[idx : idx + chunk_size]


def detect_master_table(conn: sqlite3.Connection) -> Optional[str]:
    tables = [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    ]
    if not tables:
        return None

    if "master_data" in tables:
        return "master_data"

    for table in tables:
        cols = set(table_columns(conn, table))
        if "master_id" in cols:
            return table

    return None


def load_master_rows(
    master_db_path: Path, master_ids: List[str]
) -> Dict[str, Dict[str, Any]]:
    if not master_db_path.exists():
        return {}

    conn = sqlite3.connect(str(master_db_path))
    conn.row_factory = sqlite3.Row

    table = detect_master_table(conn)
    if not table:
        conn.close()
        return {}

    available_columns = set(table_columns(conn, table))
    selected_columns = [
        col for col in MASTER_CANDIDATE_COLUMNS if col in available_columns
    ]

    if "master_id" not in selected_columns:
        conn.close()
        return {}

    rows_by_id: Dict[str, Dict[str, Any]] = {}

    for batch in chunked(master_ids, 400):
        placeholders = ",".join("?" for _ in batch)
        sql = (
            f"SELECT {', '.join(selected_columns)} "
            f"FROM {table} "
            f"WHERE master_id IN ({placeholders})"
        )
        for row in conn.execute(sql, batch).fetchall():
            row_dict = dict(row)
            key = clean_text(row_dict.get("master_id"))
            if key:
                rows_by_id[key] = row_dict

    conn.close()
    return rows_by_id


def choose_company(master_row: Dict[str, Any]) -> str:
    return clean_text(master_row.get("company_name") or master_row.get("conm"))


def choose_summary(master_row: Dict[str, Any], excerpt_len: int) -> str:
    explicit = clean_text(master_row.get("action_summary_1200"))
    if explicit:
        return truncate_text(explicit, excerpt_len)

    fallback = clean_text(master_row.get("description") or master_row.get("content"))
    return truncate_text(fallback, excerpt_len)


def choose_excerpt(master_row: Dict[str, Any], excerpt_len: int) -> str:
    # Prefer concise description over full content to keep data web-safe.
    preferred = clean_text(master_row.get("description"))
    if preferred:
        return truncate_text(preferred, excerpt_len)

    fallback = clean_text(master_row.get("content"))
    return truncate_text(fallback, excerpt_len)


def validate_required_columns(output_rows: List[Dict[str, Any]]) -> None:
    for row_idx, row in enumerate(output_rows, start=1):
        missing = [col for col in REQUIRED_OUTPUT_COLUMNS if col not in row]
        if missing:
            raise ValueError(
                f"Output row {row_idx} missing required columns: {', '.join(missing)}"
            )


def export_pairs(args: argparse.Namespace) -> Dict[str, Any]:
    working_db = Path(args.working_db).resolve()
    if not working_db.exists():
        raise FileNotFoundError(f"working DB not found: {working_db}")

    conn = sqlite3.connect(str(working_db))
    conn.row_factory = sqlite3.Row

    pair_columns = set(table_columns(conn, "pairs"))
    missing_source_columns = [
        col for col in REQUIRED_PAIR_COLUMNS if col not in pair_columns
    ]
    if missing_source_columns:
        raise ValueError(
            "pairs table is missing required source columns: "
            + ", ".join(missing_source_columns)
        )

    sql = f"SELECT {', '.join(REQUIRED_PAIR_COLUMNS)} FROM pairs"
    params: List[Any] = []
    if args.limit and args.limit > 0:
        sql += " LIMIT ?"
        params.append(args.limit)

    raw_pairs = [dict(row) for row in conn.execute(sql, params).fetchall()]
    conn.close()

    unique_master_ids = sorted(
        {
            clean_text(row["focal_master_id"])
            for row in raw_pairs
            if clean_text(row["focal_master_id"])
        }
        | {
            clean_text(row["candidate_master_id"])
            for row in raw_pairs
            if clean_text(row["candidate_master_id"])
        }
    )

    master_rows: Dict[str, Dict[str, Any]] = {}
    master_db_used: Optional[str] = None
    if args.master_db:
        master_db_path = Path(args.master_db).resolve()
        master_rows = load_master_rows(master_db_path, unique_master_ids)
        if master_rows:
            master_db_used = str(master_db_path)

    output_rows: List[Dict[str, Any]] = []
    pair_ids_seen = set()
    duplicate_pair_ids = []

    missing_counts: Dict[str, int] = defaultdict(int)

    for src in raw_pairs:
        focal_master_id = clean_text(src.get("focal_master_id"))
        candidate_master_id = clean_text(src.get("candidate_master_id"))

        if not focal_master_id or not candidate_master_id:
            continue

        pair_id = hash_pair_id(focal_master_id, candidate_master_id)
        if pair_id in pair_ids_seen:
            duplicate_pair_ids.append(pair_id)
            continue

        pair_ids_seen.add(pair_id)

        focal_master = master_rows.get(focal_master_id, {})
        candidate_master = master_rows.get(candidate_master_id, {})

        row: Dict[str, Any] = {
            "pair_id": pair_id,
            "focal_master_id": focal_master_id,
            "candidate_master_id": candidate_master_id,
            "focal_title": clean_text(
                src.get("focal_title") or focal_master.get("title")
            )
            or None,
            "candidate_title": clean_text(
                src.get("candidate_title") or candidate_master.get("title")
            )
            or None,
            "focal_date": clean_text(
                src.get("focal_date") or focal_master.get("published_date")
            )
            or None,
            "candidate_date": clean_text(
                src.get("candidate_date") or candidate_master.get("published_date")
            )
            or None,
            "focal_source": clean_text(focal_master.get("name_source")) or None,
            "candidate_source": clean_text(candidate_master.get("name_source")) or None,
            "focal_link": clean_text(focal_master.get("link")) or None,
            "candidate_link": clean_text(candidate_master.get("link")) or None,
            "focal_content_excerpt": choose_excerpt(focal_master, args.excerpt_length)
            or None,
            "candidate_content_excerpt": choose_excerpt(
                candidate_master, args.excerpt_length
            )
            or None,
            "focal_action_summary": choose_summary(focal_master, args.excerpt_length)
            or None,
            "candidate_action_summary": choose_summary(
                candidate_master, args.excerpt_length
            )
            or None,
            "focal_action": clean_text(src.get("focal_action")) or None,
            "candidate_action": clean_text(src.get("candidate_action")) or None,
            "focal_company": choose_company(focal_master) or None,
            "candidate_company": choose_company(candidate_master) or None,
            "focal_gvkey": clean_text(
                src.get("focal_gvkey") or focal_master.get("gvkey")
            )
            or None,
            "candidate_gvkey": clean_text(
                src.get("responder_gvkey") or candidate_master.get("gvkey")
            )
            or None,
            "focal_sic": clean_text(src.get("focal_sic") or focal_master.get("sic"))
            or None,
            "candidate_sic": clean_text(
                src.get("candidate_sic") or candidate_master.get("sic")
            )
            or None,
            "cosine_similarity": parse_float(src.get("cosine_similarity")),
            "delay_days": parse_float(src.get("delay_days")),
            "rival_rank": parse_int(src.get("rival_rank")),
            "same_sic": parse_bool_int(src.get("same_sic")),
            "same_action": parse_bool_int(src.get("same_action")),
            "focal_competitive_surprise": parse_bool_int(
                src.get("focal_competitive_surprise")
            ),
            "candidate_competitive_surprise": parse_bool_int(
                src.get("candidate_competitive_surprise")
            ),
        }

        for col in REQUIRED_OUTPUT_COLUMNS:
            value = row.get(col)
            if value is None or (isinstance(value, str) and value.strip() == ""):
                missing_counts[col] += 1

        output_rows.append(row)

    if duplicate_pair_ids:
        sample = ", ".join(duplicate_pair_ids[:10])
        raise ValueError(
            f"pair_id collision detected for {len(duplicate_pair_ids)} rows; sample: {sample}"
        )

    validate_required_columns(output_rows)

    output_sql = Path(args.output_sql).resolve()
    output_sql.parent.mkdir(parents=True, exist_ok=True)

    with output_sql.open("w", encoding="utf-8") as f:
        f.write("-- D1 seed data generated by scripts/export_web_safe_data.py\n")
        f.write("PRAGMA foreign_keys = ON;\n")
        f.write("BEGIN TRANSACTION;\n")
        f.write("DELETE FROM pairs;\n")

        column_list = ", ".join(REQUIRED_OUTPUT_COLUMNS)
        for row in output_rows:
            values = ", ".join(
                to_sql_literal(row.get(col)) for col in REQUIRED_OUTPUT_COLUMNS
            )
            f.write(f"INSERT INTO pairs ({column_list}) VALUES ({values});\n")

        f.write("COMMIT;\n")

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "working_db": str(working_db),
        "master_db_used": master_db_used,
        "output_sql": str(output_sql),
        "rows_exported": len(output_rows),
        "required_columns": REQUIRED_OUTPUT_COLUMNS,
        "missingness": {
            col: {
                "missing_count": int(missing_counts.get(col, 0)),
                "missing_pct": (
                    (float(missing_counts.get(col, 0)) / float(len(output_rows)))
                    * 100.0
                    if output_rows
                    else 0.0
                ),
            }
            for col in REQUIRED_OUTPUT_COLUMNS
        },
    }

    report_json_path = Path(args.report_json).resolve()
    report_json_path.parent.mkdir(parents=True, exist_ok=True)
    report_json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    return report


def main() -> None:
    args = parse_args()
    report = export_pairs(args)

    print("Web-safe export complete")
    print(f"Rows exported: {report['rows_exported']:,}")
    print(f"SQL output: {report['output_sql']}")
    print(f"Report output: {Path(args.report_json).resolve()}")

    missing_summary = report["missingness"]
    print("Top missing columns:")
    top = sorted(
        missing_summary.items(),
        key=lambda item: item[1]["missing_count"],
        reverse=True,
    )[:8]
    for col, stats in top:
        print(
            f"  - {col}: {stats['missing_count']:,} missing "
            f"({stats['missing_pct']:.2f}%)"
        )


if __name__ == "__main__":
    main()
