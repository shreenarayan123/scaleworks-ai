# Callertone backend

The Node.js and Express API accepts recordings, stores job metadata in PostgreSQL, and runs a durable analysis pipeline. It coordinates transcription, voice emotion scoring, tone review, and action item extraction.

## Requirements

- Node.js and npm
- PostgreSQL (the example configuration uses Neon)
- FFmpeg and FFprobe on `PATH`
- The private Python emotion service running at `http://127.0.0.1:8001`

## Setup

From the project root:

```powershell
npm ci --prefix backend
Copy-Item backend/.env.example backend/.env
```

Set `DATABASE_URL` in `backend/.env`. For external analysis, also configure the ElevenLabs and GLM variables in that file. To use canned transcription and language-model outputs for local development, set `MOCK_EXTERNAL=true`; the emotion service still runs and requires the emotion model.

Apply the schema and generate the Prisma client:

```powershell
npm run db:migrate --prefix backend
```

Start the API:

```powershell
npm run dev --prefix backend
```

The API listens on port `4000` by default. Set `PORT` to change it.

## API routes

- `GET /health` — backend health and mock-mode status.
- `GET /metrics` — basic process memory and uptime metrics.
- `POST /jobs` — upload WAV, MP3, M4A, MP4, OGG, or OPUS audio (up to 200 MB).
- `GET /jobs?page=1&pageSize=10&search=&filter=all&sort=newest` — paginated and filterable call list.
- `GET /jobs/:id` — job, word-level transcript, speaker turns, voice scores, and final analysis.
- `GET /jobs/:id/audio` — stream the original recording.
- `PATCH /jobs/:id/rep-speaker` — set the representative speaker and rerun analysis.
- `POST /jobs/:id/retry` — resume a failed job from its last completed checkpoint.

## Pipeline

The job moves through `uploaded → transcribing → scoring_tone → analyzing → done` (or `failed`). Checkpoints let retries reuse committed transcript or voice-score data instead of repeating completed work.

- ElevenLabs Scribe returns speaker diarization and word timestamps.
- The local emotion service uses FFmpeg to cut rep speech segments and emotion2vec to score them.
- The configured OpenAI-compatible GLM API extracts action items and assesses tone.
- Zod validates the language-model responses before they are saved.

Uploaded recordings are stored in `UPLOAD_DIR` (default `backend/uploads`) and referenced by path from PostgreSQL. Keep this directory available for playback, retries, and reanalysis.

## Checks and evaluation tools

```powershell
npm run typecheck --prefix backend
npm test --prefix backend
```

The `scripts/` directory contains evaluation clip generation, evaluation, and load-test runners. See the root README for evaluation results and for starting all three services.
