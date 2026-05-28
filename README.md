# Pair Reviewer (Legacy Local Setup)

This README describes the older local FastAPI workflow.

For the Cloudflare multi-reviewer deployment (Worker + D1 + Pages), use [README_CLOUDFLARE.md](README_CLOUDFLARE.md).

This app lets a reviewer compare a focal event with a candidate response event and label the pair. It runs completely locally and reads from SQLite that was built from a large Parquet corpus.

## Project layout (inside this folder)

- client/
   - React + Vite frontend (UI)
   - src/App.tsx (main UI), src/api.ts (API calls), src/styles.css (theme)
- server/
   - FastAPI backend (local API)
   - main.py (API routes that read SQLite and master DB)
- setup.py
   - One-time (or occasional) data builder
   - Reads Parquet pairs, creates working_pairs.db
- working_pairs.db
   - Local SQLite used by the API (pairs + judgments)
- pair_judgments.csv
   - CSV export of judgments (created on demand)

Other files:
- app.py (older Streamlit app, no longer used)
- requirements.txt (old Streamlit deps, no longer used)
- prompt_app.txt (legacy notes)

## Data sources and how they are built

### Source pairs (Parquet)
The raw pairs live here (large Parquet dataset):

/Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/Pairs_and_similarity/v2/candidate_response_pairs_all_parts

This is the full corpus of candidate-response pairs with similarity scores and metadata.

### One-time builder (setup.py)
setup.py reads the Parquet data once, applies optional filters, and writes a small local SQLite file:

working_pairs.db

This makes the UI fast and light. The app never reads the Parquet directly.

You can build a stratified sample across cosine ranges (recommended for coverage across all similarities):

python setup.py --limit 5000 --stratified --bins 5

Or keep a larger subset:

python setup.py --limit 20000 --stratified --bins 10

The output DB always lives here:

/Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/App/working_pairs.db

### Master event database
The API also looks up full event details from:

/Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/master_data/master_data.db

The backend only reads this file. It is not modified.

## How the app works (end to end)

1) setup.py creates working_pairs.db from the Parquet source.
2) server/main.py exposes API endpoints that read working_pairs.db and master_data.db.
3) client/src/App.tsx renders pairs and calls the API.
4) Judgments are saved back into working_pairs.db (table: judgments) and can be exported to CSV.

## API endpoints (server/main.py)

- GET /api/stats
   - Returns cosine/delay/rank ranges and list of actions/datasets.
- GET /api/pairs
   - Returns filtered pairs with pagination.
   - Supports sample_size for stratified sampling.
- GET /api/pair/{focal_id}/{candidate_id}
   - Returns full pair + master event details + existing judgment.
- POST /api/judgments
   - Saves judgment for the pair.
- GET /api/judgments
   - Lists saved judgments.

## Running the app

Backend (FastAPI):

cd /Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/App/server
uvicorn main:app --reload --host 127.0.0.1 --port 8000

Frontend (React + Vite):

cd /Users/aliahmadi/Surprise/Data/NewsCatcher_Alt_Sample/ResponseTime/data/App/client
npm install
npm run dev

Open:
http://localhost:5173

## Judgments and export

- Judgments are stored in working_pairs.db in a table named judgments.
- Export button downloads judgments as JSON from /api/judgments.
- A CSV export can be created by the app (pair_judgments.csv) if needed.

## Notes on performance

- The Parquet source is large, so the app never queries it directly.
- working_pairs.db is intentionally small and fast to query.
- Use stratified sampling to keep a lightweight but representative subset of pairs.
