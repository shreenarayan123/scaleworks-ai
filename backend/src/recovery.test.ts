import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "./config.js";
import { isRecoverableJob } from "./pipeline.js";

const now = Date.parse("2026-11-23T06:00:00.000Z");
const fresh = new Date(now - 10_000);
const stale = new Date(now - config.staleHeartbeatMs - 1);

test("active job with no heartbeat is recoverable", () => {
  assert.equal(isRecoverableJob({ stage: "scoring_tone", heartbeatAt: null }, now), true);
});

test("active job with a fresh heartbeat is owned by a live worker", () => {
  assert.equal(isRecoverableJob({ stage: "scoring_tone", heartbeatAt: fresh }, now), false);
});

test("active job with a stale heartbeat is recoverable", () => {
  assert.equal(isRecoverableJob({ stage: "transcribing", heartbeatAt: stale }, now), true);
});

test("jobs at the stale boundary are recoverable", () => {
  const boundary = new Date(now - config.staleHeartbeatMs);
  assert.equal(isRecoverableJob({ stage: "analyzing", heartbeatAt: boundary }, now), true);
});

test("terminal stages are never recovered", () => {
  for (const stage of ["done", "failed", "needs_speaker_confirmation"]) {
    assert.equal(isRecoverableJob({ stage, heartbeatAt: null }, now), false, stage);
    assert.equal(isRecoverableJob({ stage, heartbeatAt: stale }, now), false, stage);
  }
});
