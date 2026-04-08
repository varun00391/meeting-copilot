# Meeting Copilot

A small full-stack app that listens to meeting audio in the browser, transcribes it with **Deepgram** (including **speaker diarization**), and uses a **Groq LLM** to suggest concise replies you can read aloud when someone asks a question or expects a response.

- **Backend:** Python 3.12, FastAPI, SQLAlchemy (SQLite), Deepgram + Groq SDKs  
- **Frontend:** React (Vite), Tailwind CSS, Recharts (usage chart)  
- **Deployment:** Separate Dockerfiles plus `docker-compose.yml`

## Features

- **Live copilot:** Microphone capture → periodic audio chunks → transcription → rolling transcript.  
- **Suggested replies:** Calls the chat model with the latest transcript (and optional context you provide).  
- **Token usage:** Server logs tokens per API call; the **Token usage** page shows daily totals and a chart for a selected UTC date range.  
- **Landing page:** Product-style hero, steps, and CTAs.

## Prerequisites

- [Groq API key](https://console.groq.com/) (chat / suggestions)  
- [Deepgram API key](https://console.deepgram.com/) (speech-to-text)  
- For local dev: Node 20+ and Python 3.12+  
- For Docker: Docker and Docker Compose

## Quick start (local)

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export GROQ_API_KEY="your-key"
export DEEPGRAM_API_KEY="your-deepgram-key"
mkdir -p data
export DATABASE_URL="sqlite+aiosqlite:///./data/usage.db"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` to `http://127.0.0.1:8000`.

## Docker Compose

From the repo root:

```bash
cp .env.example .env
# Edit .env and set GROQ_API_KEY and DEEPGRAM_API_KEY

docker compose up --build
```

- **Frontend (with API proxy):** [http://localhost:8080](http://localhost:8080)  
- **Backend (direct):** [http://localhost:8000/api/health](http://localhost:8000/api/health)  

Nginx serves the React app and proxies `/api/*` to the backend container.

## Environment variables

| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | Required for chat / suggested replies. |
| `DEEPGRAM_API_KEY` | Required for transcription (with diarization). |
| `DATABASE_URL` | Optional; default is SQLite under `./data` (local) or `/app/data` (Docker). |
| `CORS_ORIGINS` | Comma-separated origins for direct browser access to the API (dev). |
| `DEEPGRAM_MODEL` / `CHAT_MODEL` | Optional overrides (see `backend/app/config.py`). |

Frontend: `VITE_API_URL` — leave empty for same-origin `/api` (Docker/nginx). Set to `http://localhost:8000` only if you serve the UI without the proxy.

## API overview

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness check |
| `POST` | `/api/transcribe` | Multipart `file` → `{ "text", "utterances", "duration_sec" }` |
| `POST` | `/api/suggest` | JSON `{ "transcript": "...", "context": null }` → `{ "suggestion": "..." }` |
| `GET` | `/api/usage/summary?start=YYYY-MM-DD&end=YYYY-MM-DD` | Aggregated usage (UTC days) |

## Notes

- **Second device:** The UI runs in a browser; open it on the device whose microphone picks up the meeting (for example, placed near speakers). You can also paste transcript text from elsewhere.  
- **HTTPS:** Browsers require a secure context for `getUserMedia` except on `localhost`. Use HTTPS in production.  
- **Limits:** Deepgram prerecorded supports large files; the app still sends short chunks for live UX. See Deepgram docs for per-request timeouts on very long single uploads.

## License

MIT (or your choice—this template ships without a formal license file unless you add one).
