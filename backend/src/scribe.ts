import { randomUUID } from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
import { openAsBlob } from "node:fs";
import { stat, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Agent } from "undici";
import { z } from "zod";
import { config } from "./config.js";
import { createScribeAudioCopy } from "./audio.js";
import { mockTranscript } from "./mocks.js";
import type { TimedWord } from "./segments.js";

// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const scribeAgent = new Agent({
  // Node 22's bundled Undici defaults both values to 300s. Keep them above the
  // Scribe-wide AbortSignal deadline so only the explicit Scribe timeout wins.
  headersTimeout: config.scribeTimeoutMs + 30_000,
  bodyTimeout: config.scribeTimeoutMs + 30_000,
});

const ScribeResponse = z.object({
  text: z.string(),
  words: z.array(
    z.object({
      text: z.string(),
      type: z.enum(["word", "spacing", "audio_event"]),
      start: z.number().nullish(),
      end: z.number().nullish(),
      speaker_id: z.string().nullish(),
    }),
  ),
});

export interface Transcript {
  text: string;
  words: TimedWord[];
}

export type ScribeFailureType = "timeout" | "quota" | "http_4xx" | "http_5xx" | "network" | "invalid_response" | "audio_preparation";

export class ScribeRequestError extends Error {
  constructor(
    readonly failureType: ScribeFailureType,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ScribeRequestError";
  }
}

type UndiciRequest = {
  origin?: string | URL;
  method?: string;
  path?: string;
  headers?: string | string[];
};

function hasHeader(request: UndiciRequest, targetName: string, targetValue: string): boolean {
  const headers = request.headers;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length - 1; i += 2) {
      if (headers[i]?.toLowerCase() === targetName && headers[i + 1] === targetValue) return true;
    }
    return false;
  }
  return typeof headers === "string" && new RegExp(`(?:^|\\r\\n)${targetName}:\\s*${targetValue}(?:\\r\\n|$)`, "i").test(headers);
}

/** Observe the exact request-body-sent event without logging body contents or credentials. */
function observeUpload(requestId: string, onBodySent: () => void): () => void {
  const matched = new WeakSet<object>();
  const createChannel = diagnosticsChannel.channel("undici:request:create");
  const bodySentChannel = diagnosticsChannel.channel("undici:request:bodySent");
  const onCreate = (message: unknown) => {
    const request = (message as { request?: UndiciRequest }).request;
    if (!request) return;
    if (
      String(request.origin).replace(/\/$/, "") === "https://api.elevenlabs.io" &&
      request.method === "POST" &&
      request.path?.startsWith("/v1/speech-to-text") &&
      hasHeader(request, "x-callertone-request-id", requestId)
    ) matched.add(request as object);
  };
  const onSent = (message: unknown) => {
    const request = (message as { request?: object }).request;
    if (!request || !matched.has(request)) return;
    matched.delete(request);
    onBodySent();
  };
  createChannel.subscribe(onCreate);
  bodySentChannel.subscribe(onSent);
  return () => {
    createChannel.unsubscribe(onCreate);
    bodySentChannel.unsubscribe(onSent);
  };
}

function logScribe(event: string, details: Record<string, unknown>) {
  console.info(`[scribe] ${JSON.stringify({ event, ...details })}`);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === "string") return value.code;
  return errorCode(value.cause);
}

function classifyFetchError(error: unknown, signal: AbortSignal): ScribeFailureType {
  const name = error instanceof Error ? error.name : "";
  const code = errorCode(error) ?? "";
  if (signal.aborted || name === "TimeoutError" || name === "AbortError" || code.includes("TIMEOUT")) return "timeout";
  return "network";
}

function publicMessage(failureType: ScribeFailureType, timeoutMs: number, statusCode?: number): string {
  switch (failureType) {
    case "timeout": return `ElevenLabs transcription timed out after ${Math.round(timeoutMs / 60_000)} minutes. Retry the call; the original recording is preserved.`;
    case "quota": return "ElevenLabs has insufficient credits to transcribe this recording. Check the account balance before retrying.";
    case "http_4xx": return `ElevenLabs rejected the transcription request (HTTP ${statusCode}). Check the audio and API settings before retrying.`;
    case "http_5xx": return `ElevenLabs transcription is temporarily unavailable (HTTP ${statusCode}). Retry the call later.`;
    case "audio_preparation": return "The backend could not prepare a compact transcription copy. The original recording is preserved.";
    case "invalid_response": return "ElevenLabs returned an invalid transcription response. Retry the call later.";
    case "network": return "The backend could not connect to ElevenLabs. Check the network and retry the call.";
  }
}

function getHttpFailureType(statusCode: number, responseBody: string): ScribeFailureType {
  if (/quota_exceeded|insufficient[_ ]credits|credits? remaining/i.test(responseBody)) return "quota";
  return statusCode >= 500 ? "http_5xx" : "http_4xx";
}

/** Send a speech-optimized copy to Scribe and retain the uploaded source for playback/retry. */
export async function transcribe(jobId: string, filePath: string, fileName: string, durationSec: number): Promise<Transcript> {
  if (config.mockExternal) return mockTranscript(durationSec);
  if (config.injectScribeTimeout) throw new ScribeRequestError("timeout", "Injected Scribe timeout.");

  const requestId = randomUUID();
  const originalStats = await stat(filePath);
  const prepareStarted = performance.now();
  const copy = await createScribeAudioCopy(filePath).catch((error: unknown) => {
    const errorType: ScribeFailureType = "audio_preparation";
    logScribe("failed", {
      jobId, requestId, errorType, errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationSec, originalFileSizeBytes: originalStats.size,
      preparationMs: Math.round(performance.now() - prepareStarted),
    });
    throw new ScribeRequestError(errorType, publicMessage(errorType, config.scribeTimeoutMs));
  });

  const requestStartedAt = new Date().toISOString();
  const requestStarted = performance.now();
  const requestDetails = {
    jobId,
    requestId,
    modelId: config.elevenLabs.modelId,
    nodeVersion: process.version,
    undiciVersion: process.versions.undici ?? "unknown",
    timeoutMs: config.scribeTimeoutMs,
    undiciHeadersTimeoutMs: config.scribeTimeoutMs + 30_000,
    undiciBodyTimeoutMs: config.scribeTimeoutMs + 30_000,
    durationSec,
    originalFileSizeBytes: originalStats.size,
    scribeFileSizeBytes: copy.sizeBytes,
    compressionMs: Math.round(requestStarted - prepareStarted),
    requestStartedAt,
  };

  let uploadFinishedAt: string | undefined;
  let uploadMs: number | undefined;
  logScribe("request_started", requestDetails);
  const stopObserving = observeUpload(requestId, () => {
    uploadFinishedAt = new Date().toISOString();
    uploadMs = Math.round(performance.now() - requestStarted);
    logScribe("upload_finished", { jobId, requestId, uploadFinishedAt, uploadMs, scribeFileSizeBytes: copy.sizeBytes });
  });

  const controller = AbortSignal.timeout(config.scribeTimeoutMs);
  try {
    const form = new FormData();
    form.append("model_id", config.elevenLabs.modelId);
    form.append("diarize", "true");
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", "false");
    form.append("file", await openAsBlob(copy.filePath, { type: "audio/ogg" }), `${path.parse(fileName).name}.opus`);

    const response = await fetch(SCRIBE_URL, {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabs.apiKey,
        "x-callertone-request-id": requestId,
      },
      body: form,
      signal: controller,
      dispatcher: scribeAgent,
    } as RequestInit & { dispatcher: Agent });
    const responseReceivedAt = new Date().toISOString();
    const responseReceivedMs = Math.round(performance.now() - requestStarted);
    logScribe("response_received", {
      jobId, requestId, statusCode: response.status, responseReceivedAt, responseReceivedMs,
      uploadFinishedAt: uploadFinishedAt ?? null, uploadMs: uploadMs ?? null,
    });

    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 2_000);
      const failureType = getHttpFailureType(response.status, responseBody);
      logScribe("failed", {
        ...requestDetails, errorType: failureType, statusCode: response.status,
        responseReceivedAt, responseReceivedMs, uploadFinishedAt: uploadFinishedAt ?? null,
        uploadMs: uploadMs ?? null, responseBody,
      });
      throw new ScribeRequestError(failureType, publicMessage(failureType, config.scribeTimeoutMs, response.status), response.status);
    }

    const responseText = await response.text();
    let responseJson: unknown;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = undefined;
    }
    const parsed = ScribeResponse.safeParse(responseJson);
    if (!parsed.success) {
      const failureType: ScribeFailureType = "invalid_response";
      logScribe("failed", {
        ...requestDetails, errorType: failureType, statusCode: response.status,
        responseReceivedAt, responseReceivedMs, uploadFinishedAt: uploadFinishedAt ?? null,
        uploadMs: uploadMs ?? null, responseBody: responseText.slice(0, 2_000), validationError: parsed.error.message,
      });
      throw new ScribeRequestError(failureType, publicMessage(failureType, config.scribeTimeoutMs), response.status);
    }

    const words: TimedWord[] = parsed.data.words
      .filter((word) => word.type === "word" && word.start != null && word.end != null)
      .map((word) => ({ text: word.text, start: word.start!, end: word.end!, speaker: word.speaker_id ?? "speaker_0" }));
    logScribe("completed", {
      ...requestDetails, statusCode: response.status,
      responseReceivedAt, responseReceivedMs, uploadFinishedAt: uploadFinishedAt ?? null,
      uploadMs: uploadMs ?? null, completedAt: new Date().toISOString(),
      totalMs: Math.round(performance.now() - requestStarted), wordCount: words.length,
    });
    return { text: parsed.data.text, words };
  } catch (error) {
    if (error instanceof ScribeRequestError) throw error;
    const failureType = classifyFetchError(error, controller);
    logScribe("failed", {
      ...requestDetails, errorType: failureType,
      errorClass: error instanceof Error ? error.name : typeof error,
      errorCode: errorCode(error) ?? null,
      errorMessage: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(), totalMs: Math.round(performance.now() - requestStarted),
      uploadFinishedAt: uploadFinishedAt ?? null, uploadMs: uploadMs ?? null,
    });
    throw new ScribeRequestError(failureType, publicMessage(failureType, config.scribeTimeoutMs));
  } finally {
    stopObserving();
    await rm(copy.directory, { recursive: true, force: true });
  }
}
