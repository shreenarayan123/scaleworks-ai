import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Status } from '@/components/review-ui';
import type { Call } from '@/lib/api';

const call = (status: Call['status'], progressStep?: Call['progressStep']): Call => ({
  id: 'c1', fileName: 'call.wav', uploadedAt: '2026-11-23T00:00:00Z', durationSec: 30,
  status, verdict: 'GREEN', actionItemCount: 0, ...(progressStep ? { progressStep } : {}),
});

const html = (value: Call) => renderToStaticMarkup(<Status call={value} />);

describe('Status badge', () => {
  it('labels a job waiting for rep confirmation instead of calling it failed', () => {
    expect(html(call('needs_confirmation'))).toContain('Needs confirmation');
    expect(html(call('needs_confirmation'))).not.toContain('Failed');
  });

  it('still labels real failures', () => {
    expect(html(call('failed'))).toContain('Failed');
  });

  it('shows the current processing step', () => {
    expect(html(call('processing', 'Transcribing'))).toContain('Transcribing');
  });

  it('labels finished calls as ready', () => {
    expect(html(call('ready'))).toContain('Ready');
  });
});
