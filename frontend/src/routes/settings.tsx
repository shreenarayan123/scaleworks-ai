import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Settings2, ListChecks, Check, RotateCcw, Save, Loader2, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { api, defaultSettings, type Behavior, type Settings } from '@/lib/api';
import { settingsQuery } from '@/lib/queries';
import { ErrorState, PageSkeleton } from '@/components/review-ui';

export const Route = createFileRoute('/settings')({
  head: () => ({ meta: [{ title: 'Workspace settings · Callertone' }, { name: 'description', content: 'Set the tone criteria and action item rules for your sales call reviews.' }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery()).then(() => undefined),
  pendingComponent: PageSkeleton,
  errorComponent: ({ error, reset }) => <ErrorState message={error instanceof Error ? error.message : 'Settings could not be loaded.'} retry={reset} />,
  component: SettingsPage,
});

const behaviors: Behavior[] = ['Rude', 'Hostile', 'Sarcastic', 'Condescending'];
function SettingsPage() {
  const { data } = useSuspenseQuery(settingsQuery());
  const [draft, setDraft] = useState<Settings>(defaultSettings);
  const [saved, setSaved] = useState(false);
  const [lintProblems, setLintProblems] = useState<{ rules: number[]; message: string }[]>([]);
  const [lintNotices, setLintNotices] = useState<{ rules: number[]; message: string }[]>([]);
  const client = useQueryClient();
  useEffect(() => { setDraft(api.restoreSettings()); }, [data]);
  const mutation = useMutation({
    mutationFn: async (value: Settings) => {
      const lint = await api.lintToneRules(value.toneRules, value.negativeBehaviors);
      if (lint.problems.length) return { value: null, problems: lint.problems, notices: lint.notices };
      return { value: await api.saveSettings(value), problems: [], notices: lint.notices };
    },
    onSuccess: ({ value, problems, notices }) => {
      setLintProblems(problems); setLintNotices(notices);
      if (!value) { setSaved(false); return; }
      client.setQueryData(['settings'], value); setDraft(value); setSaved(true);
    },
  });
  function update<K extends keyof Settings>(key: K, value: Settings[K]) { setDraft(prev => ({ ...prev, [key]: value })); setSaved(false); setLintProblems([]); setLintNotices([]); }
  function updateRule(index: number, text: string) { update('toneRules', draft.toneRules.map((rule, i) => i === index ? text : rule)); }
  function addRule() { if (draft.toneRules.length < 10) update('toneRules', [...draft.toneRules, '']); }
  return <main className="page-content settings-page">
    <div className="page-heading settings-heading"><div><h1>Workspace settings</h1><p>A good review starts with what matters to your team.</p></div></div>
    <form onSubmit={e => { e.preventDefault(); mutation.mutate(draft); }}>
      <section className="settings-section">
        <div className="settings-description"><h2><Settings2 />Tone criteria</h2><p>Choose built-in behaviors and add precise team rules.</p></div>
        <div className="settings-controls">
          <div className="toggle-grid">{behaviors.map(behavior => <label className="toggle-row" key={behavior} htmlFor={`behavior-${behavior}`}>{behavior}<Switch id={`behavior-${behavior}`} checked={draft.negativeBehaviors.includes(behavior)} onCheckedChange={checked => update('negativeBehaviors', checked ? [...draft.negativeBehaviors, behavior] : draft.negativeBehaviors.filter(b => b !== behavior))} /></label>)}</div>
          <div className="flex items-center justify-between"><label className="field-label">Custom tone rules</label><Button type="button" variant="outline" size="sm" disabled={draft.toneRules.length >= 10} onClick={addRule}><Plus />Add rule</Button></div>
          {draft.toneRules.map((rule, index) => <div key={index} className="grid gap-2 rounded-md border p-3">
            <label className="field-label" htmlFor={`tone-rule-${index}`}>Rule {index + 1}</label>
            <div className="flex items-center gap-2"><span className="shrink-0">Flag the call if</span><input className="tone-rule-input" id={`tone-rule-${index}`} maxLength={300} value={rule} onChange={e => updateRule(index, e.target.value)} placeholder="the rep pushes the customer to decide on the spot" /></div>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove rule ${index + 1}`} onClick={() => update('toneRules', draft.toneRules.filter((_, i) => i !== index))}><Trash2 />Remove</Button>
            {lintProblems.filter(problem => problem.rules.includes(index)).map((problem, i) => <div className="inline-error" role="alert" key={`${index}-${i}`}><AlertTriangle size={15} />{problem.message}</div>)}
            {lintNotices.filter(notice => notice.rules.includes(index)).map((notice, i) => <p className="field-hint" role="status" key={`${index}-notice-${i}`}>{notice.message}</p>)}
          </div>)}
          <p className="field-hint">Example: “Flag the call if the rep interrupts the customer.” Each rule can be up to 300 characters; add up to 10 rules. Saving checks that rules are clear and do not contradict each other.</p>
          {lintProblems.filter(problem => problem.rules.length === 0).map((problem, i) => <div className="inline-error" role="alert" key={`general-${i}`}><AlertTriangle size={15} />{problem.message}</div>)}
        </div>
      </section>
      <section className="settings-section"><div className="settings-description"><h2><ListChecks />Action items</h2><p>Decide which next steps make it into your review.</p></div><div className="settings-controls">
        <label className="toggle-row" htmlFor="customer-requests">Include customer requests<Switch id="customer-requests" checked={draft.includeCustomerRequests} onCheckedChange={v => update('includeCustomerRequests', v)} /></label>
        <label className="toggle-row" htmlFor="implied-commitments">Include implied commitments<Switch id="implied-commitments" checked={draft.includeImpliedCommitments} onCheckedChange={v => update('includeImpliedCommitments', v)} /></label>
        <div><div className="slider-label"><label id="confidence-label">Minimum confidence</label><span>{draft.minConfidence}%</span></div><Slider aria-labelledby="confidence-label" min={0} max={100} step={5} value={[draft.minConfidence]} onValueChange={v => update('minConfidence', v[0] ?? 70)} /><div className="slider-ends"><span>More items</span><span>Higher certainty</span></div></div>
        <div><label className="field-label" htmlFor="action-rules">What counts as an action item</label><textarea id="action-rules" value={draft.actionItemRules} onChange={e => update('actionItemRules', e.target.value)} placeholder="e.g. Follow-up emails, promised documents, and agreed next meetings." /></div>
      </div></section>
      <div className="settings-footer"><p>Changes apply to new analyses. To use these settings for an existing call, choose Re-analyze.</p><div className="settings-buttons"><Button variant="outline" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(structuredClone(defaultSettings))}><RotateCcw />Reset to defaults</Button><Button disabled={mutation.isPending} type="submit">{mutation.isPending ? <Loader2 className="animate-spin" /> : <Save />}Save changes</Button></div></div>
      {saved && <p role="status" className="save-notice"><Check size={15} />Workspace settings saved.</p>}{mutation.error && <p className="inline-error" role="alert"><AlertTriangle size={15} />{mutation.error.message}</p>}
    </form>
  </main>;
}
