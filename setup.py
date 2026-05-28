"""
Pair Reviewer — One-Time Setup
================================
Reads the 25M-row parquet dataset ONCE, extracts a filtered working subset,
and writes it to a small SQLite database.  After this runs (~1-3 min), the
app.py never touches parquet again and starts in under a second.

LOCAL PREPROCESSING UTILITY:
This script is for local data preparation and is not deployed to Cloudflare runtime.

Usage
-----
    python setup.py                         # defaults
    python setup.py --min-cosine 0.5        # stricter similarity threshold
    python setup.py --max-rank 5            # only top-5 rivals per focal event
    python setup.py --limit 200000          # larger working set
    python setup.py --min-cosine 0.3 --max-rank 10 --limit 100000
"""

import argparse
import math
import sys
import time
from pathlib import Path

import duckdb
import sqlite3

# ── paths (same as app.py) ─────────────────────────────────────────────────
PAIRS_PATH = "/Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/Pairs_and_similarity/v2/candidate_response_pairs_all_parts"
WORKING_DB = "/Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/App/working_pairs.db"


def bar(label: str, width: int = 52) -> None:
    print(f"\n{'─'*width}\n  {label}\n{'─'*width}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the working-pairs SQLite DB.")
    ap.add_argument(
        "--min-cosine",
        type=float,
        default=None,
        help="Minimum cosine_similarity to include (default: no minimum)",
    )
    ap.add_argument(
        "--max-rank",
        type=int,
        default=10,
        help="Maximum rival_rank to include          (default 10)",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=100_000,
        help="Max rows to keep (sorted by cosine DESC, default 100000)",
    )
    ap.add_argument(
        "--stratified",
        action="store_true",
        help="Use stratified sampling across cosine ranges",
    )
    ap.add_argument(
        "--bins",
        type=int,
        default=5,
        help="Number of cosine bins for stratified sampling (default 5)",
    )
    args = ap.parse_args()

    bar("Pair Reviewer — One-Time Setup")
    if args.min_cosine is None:
        print("  cosine_similarity ≥ (no minimum)")
    else:
        print(f"  cosine_similarity ≥ {args.min_cosine}")
    print(f"  rival_rank        ≤ {args.max_rank}")
    print(f"  row limit           {args.limit:,}")
    if args.stratified:
        print(f"  stratified bins     {args.bins}")
    print(f"  output              {WORKING_DB}")

    t0 = time.time()

    # ── Step 1: open parquet files with DuckDB ──────────────────────────────
    print("\n[1/3] Opening parquet files …", end=" ", flush=True)
    p = Path(PAIRS_PATH)
    if not p.exists():
        sys.exit(f"\nERROR: PAIRS_PATH not found:\n  {PAIRS_PATH}")
    glob = str(p / "*.parquet") if p.is_dir() else str(p)

    con = duckdb.connect()
    con.execute(f"""
        CREATE VIEW pairs AS
        SELECT * FROM read_parquet('{glob}', union_by_name=True)
    """)
    print("done")

    # ── Step 2: query the filtered subset ──────────────────────────────────
    print(f"[2/3] Querying {args.limit:,} pairs (may take 1-3 min) …", flush=True)
    t1 = time.time()

    where_parts = [f"rival_rank <= {args.max_rank}"]
    if args.min_cosine is not None:
        where_parts.append(f"cosine_similarity >= {args.min_cosine}")
    where = " AND ".join(where_parts) if where_parts else "1=1"

    if args.stratified:
        per_bin = max(1, math.ceil(args.limit / args.bins))
        con.execute(f"""
            SELECT * EXCLUDE (bin, rn) FROM (
                SELECT *,
                       ROW_NUMBER() OVER (PARTITION BY bin ORDER BY RANDOM()) AS rn
                FROM (
                    SELECT *,
                           NTILE({args.bins}) OVER (
                               ORDER BY CAST(cosine_similarity AS DOUBLE)
                           ) AS bin
                    FROM pairs
                    WHERE {where}
                )
            )
            WHERE rn <= {per_bin}
            LIMIT {args.limit}
        """)
    else:
        con.execute(f"""
            SELECT * FROM pairs
            WHERE {where}
            ORDER BY cosine_similarity DESC
            LIMIT {args.limit}
        """)
    rows = con.fetchall()
    cols = [d[0] for d in con.description]
    con.close()

    print(f"      → {len(rows):,} rows  ({time.time()-t1:.1f} s)")

    if not rows:
        sys.exit("ERROR: query returned 0 rows — try a lower --min-cosine value.")

    # ── Step 3: write to SQLite ─────────────────────────────────────────────
    print("[3/3] Writing to SQLite …", end=" ", flush=True)
    t2 = time.time()

    out = Path(WORKING_DB)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    db = sqlite3.connect(WORKING_DB)

    # Detect boolean columns (stored as 1/0 integer in SQLite)
    # We normalise them while inserting so no post-processing needed.
    db.execute(f"CREATE TABLE pairs ({', '.join(f'{c} TEXT' for c in cols)})")

    # Determine which positions are bool/flag columns from their values
    # (DuckDB returns Python bool objects for boolean columns)
    bool_positions = set()
    if rows:
        first = rows[0]
        bool_positions = {i for i, val in enumerate(first) if isinstance(val, bool)}

    def norm_row(r):
        return tuple(
            int(val) if i in bool_positions and isinstance(val, bool) else val
            for i, val in enumerate(r)
        )

    db.executemany(
        f"INSERT INTO pairs VALUES ({','.join('?'*len(cols))})",
        (norm_row(r) for r in rows),
    )

    # Recreate table with proper types by re-importing via pandas (cleaner)
    # Actually just create useful indexes — SQLite handles type affinity fine
    db.execute("CREATE INDEX idx_cosine  ON pairs(cosine_similarity DESC)")
    db.execute("CREATE INDEX idx_rank    ON pairs(rival_rank)")
    db.execute("CREATE INDEX idx_delay   ON pairs(delay_days)")
    db.execute("CREATE INDEX idx_faction ON pairs(focal_action)")
    db.execute("CREATE INDEX idx_caction ON pairs(candidate_action)")
    db.execute("CREATE INDEX idx_fid     ON pairs(focal_master_id)")
    db.execute("CREATE INDEX idx_cid     ON pairs(candidate_master_id)")

    # Judgments table (migrated from pair_judgments.db if it exists)
    db.execute("""
        CREATE TABLE IF NOT EXISTS judgments (
            focal_master_id     TEXT,
            candidate_master_id TEXT,
            cosine_similarity   REAL,
            delay_days          REAL,
            label               TEXT,
            confidence          INTEGER,
            notes               TEXT,
            timestamp           TEXT,
            PRIMARY KEY (focal_master_id, candidate_master_id)
        )
    """)

    db.commit()
    size_mb = out.stat().st_size / 1e6
    db.close()

    print(f"done  ({time.time()-t2:.1f} s)  →  {size_mb:.1f} MB")

    # ── Done ────────────────────────────────────────────────────────────────
    bar(f"Setup complete in {time.time()-t0:.0f} s")
    print(f"  {len(rows):,} pairs  ·  {size_mb:.1f} MB  ·  {WORKING_DB}")
    print(f"\n  Next step:")
    print(f"    streamlit run app.py\n")


if __name__ == "__main__":
    main()
