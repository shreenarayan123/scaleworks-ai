import "dotenv/config";

const mockExternal = process.env.MOCK_EXTERNAL === "true";
const scribeTimeoutMs = Number(process.env.SCRIBE_TIMEOUT_MS ?? 20 * 60 * 1000);
const emotionTimeoutMs = Number(process.env.EMOTION_TIMEOUT_MS ?? 20 * 60 * 1000);
if (!Number.isFinite(scribeTimeoutMs) || scribeTimeoutMs < 1_000) {
  throw new Error("SCRIBE_TIMEOUT_MS must be a number of at least 1000 milliseconds.");
}
if (!Number.isFinite(emotionTimeoutMs) || emotionTimeoutMs < 1_000) {
  throw new Error("EMOTION_TIMEOUT_MS must be a number of at least 1000 milliseconds.");
}

// Fail at startup with the names (never the values) of any missing variables.
const needed = ["DATABASE_URL"];
if (!mockExternal) needed.push("ELEVENLABS_API_KEY", "GLM_BASE_URL", "GLM_MODEL", "GLM_API_KEY");
const missing = needed.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables in backend/.env: ${missing.join(", ")}`);
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL!,
  uploadDir: process.env.UPLOAD_DIR ?? "uploads",
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 200 * 1024 * 1024),
  maxDurationSec: Number(process.env.MAX_DURATION_SEC ?? 60 * 60),
  externalTimeoutMs: Number(process.env.EXTERNAL_TIMEOUT_MS ?? 120_000),
  scribeTimeoutMs,
  emotionTimeoutMs,
  injectScribeTimeout: process.env.INJECT_SCRIBE_TIMEOUT === "true",
  injectGlmInvalidJson: process.env.INJECT_GLM_INVALID_JSON === "true",
  emotionServiceUrl: process.env.EMOTION_SERVICE_URL ?? "http://127.0.0.1:8001",
  emotionServiceToken: process.env.EMOTION_SERVICE_TOKEN ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  // true = canned Scribe and GLM responses (the emotion service is still called for real)
  mockExternal,
  elevenLabs: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    modelId: process.env.ELEVENLABS_MODEL_ID ?? "scribe_v3",
  },
  glm: {
    baseUrl: process.env.GLM_BASE_URL ?? "",
    model: process.env.GLM_MODEL ?? "",
    apiKey: process.env.GLM_API_KEY ?? "",
  },
};
