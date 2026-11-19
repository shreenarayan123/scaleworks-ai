"""
Private emotion-scoring service. Only the backend calls it.

POST /score
  form field "audio":    the original recording (any format ffmpeg can read)
  form field "segments": JSON list of {"id", "start", "end"} in seconds

For each segment we cut that slice out with ffmpeg (16 kHz mono WAV), run
emotion2vec on it on its own (segments are never concatenated), and return
the per-emotion scores.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, ValidationError

MODEL_ID = os.getenv("EMOTION_MODEL", "iic/emotion2vec_plus_base")

# Fail fast with a clear message if ffmpeg is missing.
if shutil.which("ffmpeg") is None:
    sys.exit(
        "ERROR: ffmpeg was not found on PATH. The emotion service needs it to cut "
        "audio segments. Install it (for example: winget install Gyan.FFmpeg), "
        "open a new terminal, and check with: ffmpeg -version"
    )

# Load the model once at startup, not per request.
from funasr import AutoModel  # noqa: E402  (imported after the ffmpeg check on purpose)

print(f"Loading {MODEL_ID} on CPU...", flush=True)
model = AutoModel(model=MODEL_ID, hub="ms", device="cpu", disable_update=True)
model_lock = threading.Lock()  # one inference at a time on the shared model
print("Model loaded.", flush=True)

app = FastAPI(title="emotion-service")
SERVICE_TOKEN = os.getenv("EMOTION_SERVICE_TOKEN", "")


class Segment(BaseModel):
    id: str
    start: float
    end: float


def cut_segment(src: str, start: float, end: float, dst: str) -> None:
    """Cut [start, end) from src into a 16 kHz mono 16-bit WAV."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", src,
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst,
        ],
        check=True,
    )


def score_file(path: str) -> dict[str, float]:
    """Run emotion2vec on one file and return {label: score}."""
    with model_lock:
        result = model.generate(
            path, granularity="utterance", extract_embedding=False, disable_pbar=True
        )[0]
    scores = {}
    for label, score in zip(result["labels"], result["scores"]):
        name = label.split("/")[-1]  # "生气/angry" -> "angry"
        if name == "<unk>":
            name = "unknown"
        scores[name] = round(float(score), 4)
    return scores


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID}


# A plain `def` (not async) so FastAPI runs this blocking work in a thread pool.
@app.post("/score")
def score(audio: UploadFile = File(...), segments: str = Form(...), authorization: str | None = Header(default=None)):
    if SERVICE_TOKEN and authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(401, "Unauthorized")
    try:
        items = [Segment(**s) for s in json.loads(segments)]
    except (json.JSONDecodeError, TypeError, ValidationError) as e:
        raise HTTPException(400, f"segments must be a JSON list of {{id, start, end}}: {e}")

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "input" + os.path.splitext(audio.filename or "")[1])
        with open(src, "wb") as f:
            shutil.copyfileobj(audio.file, f)

        results = []
        for i, seg in enumerate(items):
            if seg.end <= seg.start:
                raise HTTPException(400, f"segment {seg.id} has end <= start")
            clip = os.path.join(tmp, f"seg_{i:04d}.wav")
            try:
                cut_segment(src, seg.start, seg.end, clip)
            except subprocess.CalledProcessError:
                raise HTTPException(400, f"ffmpeg could not cut segment {seg.id}")
            results.append(
                {"id": seg.id, "start": seg.start, "end": seg.end, "scores": score_file(clip)}
            )

    return {"segments": results}
