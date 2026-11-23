import { describe, expect, it } from 'vitest';
import { toCall, toCallDetail, validateUpload, type Job } from '@/lib/api';
describe('Recording validation', () => {
 it('accepts supported audio files', () => { for (const extension of ['WAV','mp3','m4a','mp4','ogg','opus']) expect(validateUpload({ name: `call.${extension}`, size: 100 })).toBeNull(); });
 it('rejects unsupported file types', () => { expect(validateUpload({ name: 'call.flac', size: 100 })).not.toBeNull(); });
 it('accepts exactly 200 MB', () => { expect(validateUpload({ name: 'call.wav', size: 200*1024*1024 })).toBeNull(); });
 it('rejects files larger than 200 MB', () => { expect(validateUpload({ name: 'call.wav', size: 200*1024*1024+1 })).not.toBeNull(); });
});
const job: Job = {
 id: 'j1', fileName: 'call.wav', stage: 'done', error: null, durationSec: 30, createdAt: '2026-11-18T09:00:00Z',
 repSpeaker: 'speaker_1', speakers: ['speaker_1', 'speaker_0'],
 turns: [{ speaker: 'speaker_1', start: 0.5, end: 5, text: 'Hi there.' }, { speaker: 'speaker_0', start: 5.5, end: 9, text: 'Hello.' }, { speaker: 'speaker_1', start: 9.5, end: 14, text: 'Just follow the guide.' }],
 result: {
  overallEmotions: { neutral: 0.7, angry: 0.2, other: 0.1 },
  actionItems: [{ owner: 'Sales rep', task: 'Send the checklist', due: null, quote: 'I will send it', timestamp: 2 }],
  verdict: { verdict: 'RED', score: 85, summary: 'Dismissive.', flags: [{ timestamp: 11, source: 'text', quote: 'Just follow the guide.', reason: 'Dismissive' }] },
 },
};
describe('Backend job mapping', () => {
 it('maps backend stages to UI status and progress', () => {
  const base = { ...job, verdict: null, actionItemCount: 0 };
  expect(toCall({ ...base, stage: 'scoring_tone' })).toMatchObject({ status: 'processing', progressStep: 'Analyzing voice' });
  expect(toCall({ ...base, stage: 'done' }).status).toBe('ready');
  expect(toCall({ ...base, stage: 'failed' }).status).toBe('failed');
  expect(toCall({ ...base, stage: 'needs_speaker_confirmation' }).status).toBe('needs_confirmation');
 });
 it('names speakers by order of first appearance and marks the rep', () => {
  const call = toCallDetail(job);
  expect(call.repSpeakerId).toBe('speaker-1');
  expect(call.transcript.map(t => t.role)).toEqual(['rep', 'customer', 'rep']);
 });
 it('maps flags, action items and voice scores', () => {
  const call = toCallDetail(job);
  expect(call.tone).toMatchObject({ verdict: 'RED', confidence: 0.85, explanation: 'Dismissive.' });
  expect(call.tone.evidence[0]).toMatchObject({ behavior: 'Wording', startSec: 9.5 }); // snapped to the containing turn
  expect(call.tone.voice).toEqual({ neutral: 0.7, angry: 0.2 });
  expect(call.actionItems[0]).toMatchObject({ text: 'Send the checklist', deadline: null, startSec: 0.5 });
 });
});
