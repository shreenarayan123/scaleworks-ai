# Callertone

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

For Cloud Run and Vercel deployment configuration, see [DEPLOYMENT.md](DEPLOYMENT.md).

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

## Long-call chunking POC

The app accepts calls up to one hour by default (and files up to 200 MB). Scribe's batch API documents larger provider limits, but those are not app limits. Each call is one Scribe request, preserving one diarization namespace. Before sending, FFmpeg makes a temporary mono 16 kHz Opus copy at 24 kbps; the original remains stored for playback and retries. Scribe uses `SCRIBE_TIMEOUT_MS` (20 minutes by default). Node 22.23.2 bundles Undici 6.28.0, whose default 300-second header and body timers are overridden for Scribe with a dedicated Agent set 30 seconds above that deadline. Structured `[scribe]` logs record file sizes, duration, compression/upload/response times, status, and classified failures. The app uses Scribe diarization and assesses the rep role itself; it does not enable the provider's optional `detect_speaker_roles` mode. See the [Scribe API limits and parameters](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) and [batch concurrency guidance](https://elevenlabs.io/docs/overview/capabilities/speech-to-text/).

### Current one-hour call capability and limits

- **Upload ceiling:** one hour and 200 MB by default; both are configurable with `MAX_DURATION_SEC` and `MAX_FILE_SIZE_BYTES`. A 56:08 test recording (53.9 MB) passed validation.
- **Transcription:** a single synchronous Scribe request for the whole call. In that test, FFmpeg preparation took 36.6 seconds, upload took 2.8 seconds, and Scribe returned 9,764 words about 31 seconds after the request began. The configured request timeout is 20 minutes. This is one successful measurement, not a guaranteed latency.
- **Voice scoring:** calls longer than 5.5 minutes are cut into silence-aligned chunks around five minutes each. The one-hour call produced 11 chunks; up to three chunks are sent concurrently by default. Only rep speech is scored; utterances shorter than 1.5 seconds are dropped and long utterances are divided into at most 10-second segments. One observed chunk took about 130 seconds, but full voice-stage duration was not captured.
- **Speaker choice:** Scribe supplies speaker IDs and word timestamps. The backend assesses who is the sales rep from speaker evidence and conversational patterns. If the top candidate is weak or too close to another candidate, analysis pauses at `needs_speaker_confirmation`; a reviewer chooses the rep, then the app reruns analysis without retranscribing. This is a heuristic with no measured real-call accuracy yet. A wrong rep selection affects which voice is scored and which lines are treated as the rep in tone/action analysis.
- **Recovery and persistence:** transcript and scores are checkpointed. A worker heartbeat runs every 10 seconds; startup and periodic sweeps reclaim jobs with no heartbeat for 60 seconds. Interrupted emotion work recomputes the stage's chunks. Original audio must remain available in `UPLOAD_DIR` or the configured Cloud Storage mount for retries.
- **Important service limits:** the emotion model runs on CPU, and actual throughput depends on the host and model service capacity. The 20-minute emotion timeout applies per chunk request. The observed first run also hit a Prisma transaction-start failure while writing the transcript; word writes have since been changed to batches of 1,000, but the shared log does not show a complete successful one-hour end-to-end run after that fix.

### Future improvements

1. Move job execution to a durable queue (for example Cloud Tasks plus a worker) so provider work survives process/container shutdown independently of the API process.
2. Persist emotion chunk completion/results incrementally so a retry can resume at the first unfinished chunk instead of repeating the entire emotion stage.
3. Validate representative-speaker selection against labeled real calls; consider a reviewer-friendly confidence explanation and retain the manual override.
4. Run repeat end-to-end one-hour tests while collecting stage-level timing, memory, database pool/transaction metrics, transcription quality, and rep-selection accuracy.
5. Tune emotion concurrency from measured CPU/memory and latency; current default 3 is configurable and should be reduced for constrained machines.

The standalone POC normalizes audio to mono 16 kHz Opus, places approximately five-minute cuts at detected silence midpoints (±30 seconds, hard-cut fallback), processes chunks with concurrency three, shifts word timestamps, and reports process RSS. It uses an offline mock downstream worker by default, so running it makes no API calls.

Example test file from the labeled evaluation clips (43 repetitions produces about one hour). The backend already pins `tsx` at version 4.23.15, so the POC adds no dependency:

```bash
for i in $(seq 1 43); do
  for f in backend/eval-results/clips/[0-9][0-9]-*.mp3; do
    printf "file '%s'\n" "$PWD/$f"
  done
done > /tmp/callertone-list.txt
ffmpeg -f concat -safe 0 -i /tmp/callertone-list.txt -ar 16000 -ac 1 -c:a libopus -b:a 24k /tmp/callertone-long.opus
npx --prefix backend tsx backend/scripts/poc-chunking.ts /tmp/callertone-long.opus
```

Measured on the generated evaluation-clip file:

| Audio length | Chunks | Wall time | Peak RSS | Stitched words | Timeline |
|---:|---:|---:|---:|---:|---|
| 29.6 min | 6 | 25.97 s | 47 MB | 6 (mock) | Monotonic |
| 60.5 min | 13 | 51.38 s | 46 MB | 13 (mock) | Monotonic |

The 60.5-minute internal cuts were at 292.58, 589.41, 883.94, 1180.77, 1475.30, 1772.13, 2066.66, 2363.49, 2658.02, 2954.85, 3249.38, and 3546.21 seconds. Each coincided with an FFmpeg silence midpoint detected in the normalized test file. Peak RSS remained 46–47 MB as duration doubled in these runs. The POC's mock worker emits one synthetic word per chunk; it verifies bounded scheduling and timestamp offsets, not ASR boundary accuracy. No live Scribe request was made, so this run does not validate real transcription or diarization output.

A failed job's Retry action resumes from its last saved checkpoint. A heartbeat lease (`HEARTBEAT_INTERVAL_MS`, default 10 seconds) lets startup and periodic recovery sweeps reclaim jobs whose worker stopped refreshing it (`STALE_HEARTBEAT_MS`, default 60 seconds). The claim is atomic across backend instances. Partial emotion chunks are recomputed after a crash because scores are committed when the full emotion stage finishes. A failure during transcription resumes from `uploaded`, recreates the compact Scribe copy, and re-sends the preserved original; a failure in a later stage does not repeat transcription.

Emotion scoring runs on CPU in the private emotion service. The backend processes up to `EMOTION_CONCURRENCY` chunks at once (default 3), and the service independently bounds inference with `EMOTION_INFERENCE_CONCURRENCY` (default 3). Keep these values aligned and lower them on machines with limited CPU or memory. `EMOTION_TIMEOUT_MS` defaults to 20 minutes per chunk, and the emotion service's HTTP header/body timers are set 30 seconds higher. A live 56:08 test showed an individual emotion chunk taking about 130 seconds at concurrency 3; this is one chunk's elapsed time, not the full emotion stage duration.

### Observed live 56-minute call

The tested recording was 56:08 (3,368 seconds), 53.9 MB original and 9.8 MB compressed for Scribe. FFmpeg preparation took 36.6 seconds. Scribe upload took 2.8 seconds, and the API returned successfully about 28 seconds after the upload finished (31.0 seconds from request start through response parsing), producing 9,764 words. So in this run, Scribe itself was not the slowest stage: emotion scoring was the longest measured part, with a chunk taking approximately 130 seconds. The full emotion stage time was not captured in the shared log excerpt, so no end-to-end completion time can be stated from it.

The first run then failed while saving transcript words: Prisma could not start a database transaction. The job was recovered from its last committed checkpoint after the backend restarted, demonstrating recovery through transcription and into emotion scoring; the available log excerpt does not show the whole job reaching `done`. This indicates database connection/transaction availability is another runtime dependency to monitor for long jobs. The above is one observed run, not a performance guarantee or an accuracy evaluation. ElevenLabs also supports asynchronous Scribe webhooks, but enabling them requires a publicly reachable HTTPS callback and webhook signature verification; this app uses the bounded synchronous request.

The job pipeline uses one whole-call Scribe request, then creates silence-aligned emotion audio chunks for calls longer than 5.5 minutes. `chunkTotal` and `chunkDone` are stored on the job and shown during voice analysis. Tone findings and action-item extraction are processed in five-minute transcript windows and merged using absolute timestamps. Because Scribe sees the complete recording in one request, its speaker IDs do not reset at our emotion chunk boundaries. Memory scales with the bounded audio chunk working set and model service, rather than buffering the full recording in application memory; chunk files are temporary and removed after scoring.

The current POC does not include a real-Scribe speaker-identity accuracy score. The generated clips are labeled, but validating role accuracy requires sending the full concatenated file through the billable transcription endpoint and comparing Scribe's diarization to those labels. The one live call above confirms that Scribe returned a transcript and diarization payload, but no ground-truth speaker labels were available to score diarization accuracy.
