# Sales Call Analyzer

A call review app that transcribes recordings, analyzes sales-rep tone, and extracts follow-up actions.

## Architecture

![Sales Call Analyzer system architecture](docs/architecture.png)

## Project structure

```text
.
├── backend/
│   ├── prisma/                 # Database schema and migrations
│   ├── scripts/                # Evaluation clip generation, evaluation, and load test
│   ├── src/                    # Express API and durable analysis pipeline
│   └── eval-results/           # Generated sample clips, manifest, and evaluation report
├── emotion-service/
│   ├── app.py                  # Private FastAPI emotion scoring service
│   └── requirements.txt
├── frontend/
│   ├── public/                 # Static assets and app icons
│   └── src/
│       ├── components/
│       ├── lib/                # API client and TanStack Query options
│       ├── routes/             # Calls list, call analysis, and settings
│       └── test/
├── docs/
│   └── architecture.png
└── .github/extensions/         # Excalidraw architecture extension
```

## Technology stack

- **Frontend:** React 19, TypeScript, Vite, TanStack Start/Router, TanStack Query, Tailwind CSS, Radix UI.
- **Backend:** Node.js, Express, TypeScript, Prisma, Zod, and the OpenAI SDK.
- **Database:** PostgreSQL, configured for Neon; Prisma schema and migrations live in `backend/prisma/`.
- **Voice emotion analysis:** Python, FastAPI, PyTorch, torchaudio, FunASR, and the `emotion2vec_plus_base` model served on CPU.
- **Media tools:** FFmpeg and FFprobe for decoding, segment extraction, format validation, and duration probing.

## External APIs and services

- **ElevenLabs Scribe** transcribes uploaded audio and returns speaker labels and word timestamps.
- **OpenAI-compatible GLM endpoint** generates action items and judges tone from transcript and voice scores. Configure the endpoint and model with `GLM_BASE_URL` and `GLM_MODEL`; the example config points to Experiential Labs.
- **Neon PostgreSQL** stores jobs, transcript words, scored segments, and analysis results.
- **ModelScope** provides the emotion2vec model assets used by FunASR.
- **ElevenLabs Text-to-Dialogue** is used by the evaluation clip generator to create synthetic two-speaker samples; it is not needed to run the app.

The backend stores original recordings in the local `UPLOAD_DIR` and stores their paths in PostgreSQL. The emotion service is private and is called only by the backend. The frontend talks to the backend through `VITE_API_URL` (default `http://localhost:4000`).

The backend REST API includes `POST /jobs` for uploads, paginated and filterable `GET /jobs`, `GET /jobs/:id` for a transcript and analysis, `GET /jobs/:id/audio` for playback, and endpoints for changing the rep speaker and retrying failed jobs. `/health` and `/metrics` expose service health and basic process metrics.

## Evaluation highlights

The checked-in evaluation report covers **15 synthetic scenarios run five times each** (75 completed analyses). All 75 runs completed without pipeline errors, and each scenario received the same verdict in all five runs.

| Measure | Result |
|---|---:|
| Combined tone verdict accuracy | 65/75 (86.7%) |
| Combined precision / recall | 100% / 81.8% |
| Text flag precision / recall | 100% / 100% |
| Voice flag precision / recall | 100% / 50% |
| Mean end-to-end processing time | 13.3 s per clip |

The combined classifier had no false positives in this sample. Its 10 false negatives were the five runs each of `08-angry-polite` and `15-calm-low-volume`. Voice-only flags also missed expected voice cues in `11-rude-angry`; its text flag still made the combined verdict RED. These synthetic, scripted clips are useful for regression checks, but they are a small test set and do not establish accuracy on real customer calls. Results are in `backend/eval-results/evaluation.json`; scenario labels and audio clips are in `backend/eval-results/clips/`.

## Run locally

Install Node dependencies once:

```powershell
npm ci --prefix backend
npm ci --prefix frontend
```

Create a Python environment and install the emotion service dependencies:

```powershell
python -m venv emo-env
.\emo-env\Scripts\python.exe -m pip install -r emotion-service/requirements.txt
```

Confirm FFmpeg and FFprobe are on `PATH` with `ffmpeg -version` and `ffprobe -version`.

Copy `backend/.env.example` to `backend/.env` and configure `DATABASE_URL`, ElevenLabs, and GLM settings. For local development without ElevenLabs and GLM credentials, set `MOCK_EXTERNAL=true`; the emotion service still runs normally. Optionally copy `emotion-service/.env.example` to `emotion-service/.env` to select a different emotion model.

Apply the database schema once:

```powershell
npm run db:migrate --prefix backend
```

Start each service in its own terminal from the project root:

```powershell
# 1. Emotion service (port 8001)
.\emo-env\Scripts\python.exe -m uvicorn app:app --app-dir emotion-service --host 127.0.0.1 --port 8001

# 2. Backend (port 4000)
npm run dev --prefix backend

# 3. Frontend (Vite prints its local URL)
npm run dev --prefix frontend
```

The uploader accepts WAV, MP3, M4A, MP4, OGG, and OPUS files up to 200 MB. Corrupt files and files without an audio stream are rejected before analysis.
