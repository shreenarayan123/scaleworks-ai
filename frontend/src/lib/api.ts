// Typed client for the sales-call backend (backend/ in this repo).
// The UI uses the Call / CallDetail shapes below; toCall / toCallDetail map backend jobs onto them.

export type Behavior = 'Rude' | 'Hostile' | 'Dismissive' | 'Sarcastic' | 'Interrupting' | 'Condescending';
export type ProgressStep = 'Uploading' | 'Transcribing' | 'Analyzing voice' | 'Analyzing tone' | 'Extracting action items';
export interface Settings {
  negativeBehaviors: Behavior[]; customRules: string; sensitivity: 'Lenient' | 'Balanced' | 'Strict';
  voiceEnabled: boolean; voiceWeight: number; includeCustomerRequests: boolean;
  includeImpliedCommitments: boolean; minConfidence: number; actionItemRules: string;
}
export interface Call {
  id: string; fileName: string; uploadedAt: string; durationSec: number;
  status: 'processing' | 'ready' | 'failed'; progressStep?: ProgressStep;
  verdict: 'RED' | 'GREEN'; actionItemCount: number;
}
export interface CallDetail extends Call {
  repSpeakerId: string;
  tone: { verdict: 'RED' | 'GREEN'; confidence: number; explanation: string;
    evidence: { id: string; quote: string; behavior: string; severity?: 1 | 2 | 3; startSec: number; reason: string }[];
    voice: Record<string, number> | null };
  transcript: { speakerId: string; role: 'rep' | 'customer'; startSec: number; endSec: number; text: string }[];
  actionItems: { id: string; text: string; quote: string; startSec: number; owner: string | null; deadline: string | null; confidence: number | null }[];
}
export const progressSteps: ProgressStep[] = ['Uploading', 'Transcribing', 'Analyzing voice', 'Analyzing tone', 'Extracting action items'];
export const defaultSettings: Settings = {
  negativeBehaviors: ['Rude', 'Hostile', 'Dismissive', 'Sarcastic', 'Interrupting', 'Condescending'], customRules: '', sensitivity: 'Balanced',
  voiceEnabled: true, voiceWeight: 25, includeCustomerRequests: true, includeImpliedCommitments: false, minConfidence: 70,
  actionItemRules: '',
};

// ---------- Backend response shapes ----------

type Stage = 'uploaded' | 'transcribing' | 'scoring_tone' | 'analyzing' | 'done' | 'failed';
export interface JobSummary {
  id: string; fileName: string; stage: Stage; error: string | null; durationSec: number; createdAt: string;
  verdict: 'RED' | 'GREEN' | null; actionItemCount: number;
}
export interface CallsPage {
  calls: Call[];
  page: number;
  pageSize: number;
  total: number;
  workspaceTotal: number;
}
export interface CallsPageParams {
  page?: number;
  pageSize?: number;
  search?: string;
  filter?: string;
  sort?: 'newest' | 'oldest';
}
export interface CallStats {
  totalCalls: number;
  needsAttention: number;
  toneOk: number;
  actionItems: number;
  processing: number;
}
export interface Flag { timestamp: number; source: 'text' | 'voice'; quote: string; reason: string }
export interface Job extends Omit<JobSummary, 'verdict' | 'actionItemCount'> {
  repSpeaker: string | null;
  speakers: string[]; // backend speaker ids in order of first appearance
  turns: { speaker: string; start: number; end: number; text: string }[];
  result: {
    overallEmotions: Record<string, number>;
    actionItems: { owner: string; task: string; due: string | null; quote: string; timestamp: number }[];
    verdict: { verdict: 'RED' | 'GREEN'; score: number; summary: string; flags: Flag[] };
  } | null;
}

export const API_URL: string = import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `The server returned ${res.status}.`);
  return body as T;
}

// ---------- Mapping backend jobs onto the UI's shapes ----------

const stepForStage: Partial<Record<Stage, ProgressStep>> = {
  uploaded: 'Uploading', transcribing: 'Transcribing', scoring_tone: 'Analyzing voice', analyzing: 'Analyzing tone',
};
function statusOf(stage: Stage): Pick<Call, 'status' | 'progressStep'> {
  if (stage === 'done') return { status: 'ready' };
  if (stage === 'failed') return { status: 'failed' };
  return { status: 'processing', progressStep: stepForStage[stage] ?? 'Uploading' };
}

export function toCall(job: JobSummary): Call {
  return { id: job.id, fileName: job.fileName, uploadedAt: job.createdAt, durationSec: job.durationSec,
    ...statusOf(job.stage), verdict: job.verdict ?? 'GREEN', actionItemCount: job.actionItemCount };
}

// The UI's speaker picker uses "speaker-1" (first to talk), "speaker-2", ...; the backend uses Scribe ids like "speaker_0".
const uiSpeakerId = (job: Job, speaker: string) => `speaker-${job.speakers.indexOf(speaker) + 1}`;

export function toCallDetail(job: Job): CallDetail {
  const rep = job.repSpeaker ?? '';
  const transcript = job.turns.map(t => ({ speakerId: uiSpeakerId(job, t.speaker), role: t.speaker === rep ? 'rep' as const : 'customer' as const, startSec: t.start, endSec: t.end, text: t.text }));
  // Jumping from a flag or action item scrolls to the transcript turn that contains its timestamp.
  const turnStart = (sec: number) => [...transcript].reverse().find(t => t.startSec <= sec + 0.05)?.startSec ?? transcript[0]?.startSec ?? 0;
  const result = job.result;
  const verdict = result?.verdict;
  const voice = result && Object.keys(result.overallEmotions).length > 0
    ? Object.fromEntries(Object.entries(result.overallEmotions).filter(([emotion]) => emotion !== 'other' && emotion !== 'unknown').sort((a, b) => b[1] - a[1]))
    : null;
  return {
    ...toCall({ ...job, verdict: verdict?.verdict ?? null, actionItemCount: result?.actionItems.length ?? 0 }),
    repSpeakerId: rep ? uiSpeakerId(job, rep) : 'speaker-1',
    tone: {
      verdict: verdict?.verdict ?? 'GREEN',
      confidence: (verdict?.score ?? 0) / 100,
      explanation: verdict?.summary ?? '',
      evidence: (verdict?.flags ?? []).map((f, i) => ({
        id: `flag-${i}`, quote: f.quote, startSec: turnStart(f.timestamp), reason: f.reason,
        behavior: f.source === 'voice' ? 'Vocal tone' : 'Wording',
      })),
      voice,
    },
    transcript,
    actionItems: (result?.actionItems ?? []).map((a, i) => ({
      id: `action-${i}`, text: a.task, quote: a.quote, startSec: turnStart(a.timestamp), owner: a.owner || null, deadline: a.due, confidence: null,
    })),
  };
}

// ---------- Public API used by the pages ----------

export function validateUpload(file: Pick<File, 'name' | 'size'>): string | null {
  if (!/\.(wav|mp3|m4a|mp4|ogg|opus)$/i.test(file.name)) return 'Choose a WAV, MP3, M4A, MP4, OGG, or OPUS audio recording.';
  if (file.size > 200 * 1024 * 1024) return 'This file is too large. Choose a recording under 200 MB.';
  return null;
}

let settings = structuredClone(defaultSettings);

export const api = {
  async uploadCall(file: File): Promise<{ id: string }> {
    const error = validateUpload(file); if (error) throw new Error(error);
    const form = new FormData(); form.append('file', file);
    const { jobId } = await request<{ jobId: string }>('/jobs', { method: 'POST', body: form });
    return { id: jobId };
  },
  async getCalls(params: CallsPageParams = {}): Promise<CallsPage> {
    const query = new URLSearchParams({
      page: String(params.page ?? 1),
      pageSize: String(params.pageSize ?? 10),
      search: params.search ?? '',
      filter: params.filter ?? 'all',
      sort: params.sort ?? 'newest',
    });
    const result = await request<{ jobs: JobSummary[]; page: number; pageSize: number; total: number; workspaceTotal: number }>(`/jobs?${query}`);
    return { ...result, calls: result.jobs.map(toCall) };
  },
  async getCallStats(): Promise<CallStats> { return request<CallStats>('/jobs/stats'); },
  async getCall(id: string): Promise<CallDetail> { return toCallDetail(await request<Job>(`/jobs/${id}`)); },
  // Re-runs tone scoring and both LLM steps. With repSpeakerId it also changes who the rep is.
  async reanalyzeCall(id: string, input: { repSpeakerId?: string } = {}): Promise<void> {
    const job = await request<Job>(`/jobs/${id}`);
    const speaker = input.repSpeakerId ? job.speakers[Number(input.repSpeakerId.replace('speaker-', '')) - 1] : job.repSpeaker;
    if (!speaker) throw new Error('That speaker does not appear in this call.');
    await request(`/jobs/${id}/rep-speaker`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speaker }) });
  },
  // Workspace settings still live in this browser only; the backend does not use them yet.
  async getSettings(): Promise<Settings> { return structuredClone(settings); },
  restoreSettings(): Settings {
    const saved = localStorage.getItem('call-review-settings');
    if (saved) { try { settings = { ...defaultSettings, ...JSON.parse(saved) }; } catch { settings = structuredClone(defaultSettings); } }
    return structuredClone(settings);
  },
  async saveSettings(value: Settings): Promise<Settings> { settings = structuredClone(value); if (typeof window !== 'undefined') localStorage.setItem('call-review-settings', JSON.stringify(settings)); return structuredClone(settings); },
  getAudioUrl(id: string) { return `${API_URL}/jobs/${id}/audio`; },
};
export const timeLabel = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
export const dateLabel = (date: string) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
