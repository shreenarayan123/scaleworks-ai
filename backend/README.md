# Callertone backend

The Node.js and Express API accepts recordings, stores job metadata in PostgreSQL, and runs a checkpointed analysis pipeline. It coordinates transcription, speaker selection, voice emotion scoring, tone review, and action-item extraction.

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
- `POST /jobs` — upload WAV, MP3, M4A, MP4, OGG, or OPUS audio (up to 200 MB and one hour by default).
- `GET /jobs?page=1&pageSize=10&search=&filter=all&sort=newest` — paginated and filterable call list.
- `GET /jobs/:id` — job, word-level transcript, speaker turns, voice scores, and final analysis.
- `GET /jobs/:id/audio` — stream the original recording.
- `PATCH /jobs/:id/rep-speaker` — set the representative speaker and rerun analysis.
- `POST /jobs/:id/retry` — resume a failed job from its last completed checkpoint.

## Pipeline

The job moves through `uploaded → transcribing → scoring_tone → analyzing → done` (or `failed`). Checkpoints let retries reuse committed transcript or voice-score data instead of repeating completed work.

- ElevenLabs Scribe returns speaker diarization and word timestamps.
- The backend estimates the rep among two speakers from the first five minutes; low confidence or a close result requires human confirmation.
- Calls over 5.5 minutes are split into silence-aligned, roughly five-minute audio chunks; emotion2vec scores rep speech with concurrency three by default.
- The configured OpenAI-compatible GLM API extracts action items and assesses tone from five-minute transcript windows plus voice scores; it does not receive audio.
- Zod validates the language-model responses before they are saved.

Workers heartbeat every 10 seconds by default. Startup and periodic sweeps reclaim jobs with stale heartbeats after 60 seconds; recovery resumes from the last checkpoint, though partial emotion-stage work may be repeated.

## Analysis settings

The frontend sends its tone criteria and action-item preferences with each upload and reanalysis. The backend snapshots those settings on the job and applies them when generating the final result. Tone criteria control which text behaviors can be flagged; custom tone rules are included in the tone review prompt. Action-item settings control customer requests, implied commitments, the minimum confidence threshold, and additional extraction rules. Existing jobs without a saved settings snapshot use the backend defaults when reanalyzed.

Custom rules allow up to 10 entries of 300 characters each. Saving runs quick local checks first, then one AI check for clear contradictions, unclear wording, and rules unrelated to the call. Successful AI results are cached in memory (up to 256 rule lists); if the AI check is unavailable, saving continues with a notice. Contradiction detection could move to a natural language inference (NLI) model in the future to reduce dependence on an LLM.

Uploaded recordings are stored in `UPLOAD_DIR` (default `backend/uploads`) and referenced by path from PostgreSQL. Keep this directory available for playback, retries, and reanalysis.

## Checks and evaluation tools

```powershell
npm run typecheck --prefix backend
npm test --prefix backend
```

The `scripts/` directory contains evaluation clip generation, evaluation, and load-test runners. See the root README for evaluation results and for starting all three services.
