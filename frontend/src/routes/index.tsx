import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Upload, ShieldCheck, Search, ArrowUpDown, ArrowUpRight, AudioLines, Headphones, AlertTriangle, CheckCheck, ListChecks, Lightbulb, Loader2, CircleCheck, LockKeyhole, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, dateLabel, timeLabel, validateUpload, progressSteps } from '@/lib/api';
import { callsQuery, callStatsQuery } from '@/lib/queries';
import { EmptyCalls, ErrorState, PageSkeleton, Status, ToneBadge } from '@/components/review-ui';
export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: 'Calls · Callertone' }, { name: 'description', content: 'Review sales conversations, spot tone concerns, and keep track of every next step.' }, { property: 'og:title', content: 'Calls · Callertone' }, { property: 'og:description', content: 'A clearer view of your customer conversations.' }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary_large_image' }] }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(callsQuery({ page: 1, pageSize: 10, search: '', filter: 'all', sort: 'newest' })),
      context.queryClient.ensureQueryData(callStatsQuery()),
    ]);
  },
  pendingComponent: PageSkeleton,
  errorComponent: ({ error, reset }) => <ErrorState message={error instanceof Error ? error.message : 'The calls could not be loaded.'} retry={reset}/>,
  component: CallsPage,
});
function CallsPage() {
 const client = useQueryClient(); const input = useRef<HTMLInputElement>(null); const [dragging, setDragging] = useState(false); const [error, setError] = useState(''); const [search, setSearch] = useState(''); const [debouncedSearch, setDebouncedSearch] = useState(''); const [filter, setFilter] = useState('all'); const [newestFirst, setNewestFirst] = useState(true); const [page, setPage] = useState(1); const [success, setSuccess] = useState(false); const pageSize = 10;
 const { data: stats } = useSuspenseQuery({ ...callStatsQuery(), refetchInterval: query => query.state.data?.processing ? 2000 : false });
 useEffect(() => { const timer = window.setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300); return () => window.clearTimeout(timer); }, [search]);
 const pageQuery = useQuery({ ...callsQuery({ page, pageSize, search: debouncedSearch, filter, sort: newestFirst ? 'newest' : 'oldest' }), placeholderData: keepPreviousData, refetchInterval: query => query.state.data?.calls.some(c => c.status === 'processing') ? 2000 : false });
 const data = pageQuery.data ?? { calls: [], page, pageSize, total: 0, workspaceTotal: 0 };
 const calls = data.calls; const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
 const upload = useMutation({ mutationFn: api.uploadCall, onSuccess: () => { setPage(1); client.invalidateQueries({ queryKey: ['calls'] }); client.invalidateQueries({ queryKey: ['call-stats'] }); setSuccess(true); }, onError: e => setError(e.message) });
 function selectFile(file?: File) { if (!file) return; setSuccess(false); const issue = validateUpload(file); setError(issue ?? ''); if (!issue) upload.mutate(file); }
 return <main className="page-content">
   <div className="page-heading"><div><h1>Your calls, in focus.</h1><p>A clearer picture of every conversation. A better next step.</p></div><span className="heading-icon"><ShieldCheck size={14}/>Private by default</span></div>
   <div className={`upload-zone ${dragging ? 'drag-active' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!upload.isPending) selectFile(e.dataTransfer.files[0]); }}>
    <div className="upload-icon">{upload.isPending ? <Loader2 className="animate-spin" size={24}/> : <Upload size={24}/>}</div>
    <h2>{upload.isPending ? 'Uploading your recording…' : <>Drop a call recording here <span>or choose a file to get started</span></>}</h2>
    <Button size="sm" onClick={() => input.current?.click()} disabled={upload.isPending}><Upload size={14}/>Upload recording</Button>
    <input ref={input} type="file" accept=".wav,.mp3,.m4a,.mp4,.ogg,.opus,audio/*,video/mp4" aria-label="Upload audio recording" className="sr-only" onChange={e => { selectFile(e.target.files?.[0]); e.target.value = ''; }}/>
    <span className="upload-details">WAV, MP3, MP4<span>·</span>Up to 200 MB</span>
   </div>
   <div className="upload-note"><LockKeyhole size={11}/>Your recordings stay in your workspace. Only you can access them.</div>
   {error && <p className="inline-error" role="alert"><AlertTriangle size={15}/>{error}</p>}
   {success && <p className="save-notice" role="status"><CircleCheck size={15}/>Recording uploaded. Your analysis is on its way.</p>}
   <div className="stats-strip">
    <div className="stat"><div className="stat-label"><Headphones size={14}/>Total calls</div><div className="stat-value">{stats.totalCalls}<span>in your workspace</span></div></div>
    <div className="stat"><div className="stat-label"><AlertTriangle size={14}/>Needs attention</div><div className="stat-value stat-danger">{stats.needsAttention}<span>negative tone</span></div></div>
    <div className="stat"><div className="stat-label"><CheckCheck size={14}/>Tone OK</div><div className="stat-value stat-success">{stats.toneOk}<span>positive conversations</span></div></div>
    <div className="stat"><div className="stat-label"><ListChecks size={14}/>Action items</div><div className="stat-value">{stats.actionItems}<span>next steps identified</span></div></div>
   </div>
   <section aria-labelledby="recent-calls"><div className="section-heading"><h2 id="recent-calls">Recent calls<span className="count-chip">{data.total}</span></h2><div className="table-controls"><label className="search-input"><Search size={14}/><input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search recordings…" aria-label="Search recordings"/></label><select aria-label="Filter calls" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}><option value="all">All calls</option><option value="RED">Negative tone</option><option value="GREEN">Tone OK</option><option value="processing">Processing</option><option value="failed">Failed</option></select></div></div>
   {calls.length === 0 && stats.totalCalls === 0 && !search ? <EmptyCalls/> : calls.length === 0 ? <div className="empty-panel"><Search/><h2>No matching calls</h2><p>Try another search or change the filter.</p><Button variant="outline" onClick={() => { setSearch(''); setDebouncedSearch(''); setFilter('all'); setPage(1); }}>Clear filters</Button></div> : <div className="calls-table-wrap"><table className="calls-table"><thead><tr><th>Recording</th><th><Button variant="ghost" size="sm" className="h-auto p-0 text-[10px]" onClick={() => { setNewestFirst(!newestFirst); setPage(1); }}>Uploaded<ArrowUpDown size={11}/></Button></th><th>Duration</th><th>Sales representative tone</th><th>Action items</th><th>Status</th><th><span className="sr-only">Review call</span></th></tr></thead><tbody>{calls.map(call => <tr key={call.id}><td><Link to="/calls/$id" params={{ id: call.id }} className="file-cell"><span className="file-icon"><AudioLines size={17}/></span><div><span className="file-name" title={call.fileName}>{call.fileName.replace(/\.(wav|mp3|m4a|mp4|ogg|opus)$/i,'')}</span><span className="file-subtitle">Audio recording</span></div></Link></td><td className="muted-text">{dateLabel(call.uploadedAt)}</td><td className="muted-text">{timeLabel(call.durationSec)}</td><td>{call.status === 'ready' ? <ToneBadge verdict={call.verdict}/> : <span className="muted-text">—</span>}</td><td>{call.status === 'ready' ? <span className="inline-flex items-center gap-1.5"><ListChecks size={12} className="text-muted-foreground"/>{call.actionItemCount}<span className="muted-text">items</span></span> : <span className="muted-text">—</span>}</td><td><Status call={call}/>{call.status === 'processing' && <div className="processing-line"><progress aria-label="Analysis progress" value={progressSteps.indexOf(call.progressStep ?? 'Uploading')+1} max={5} className="sr-only"/><span className={`progress-step-${progressSteps.indexOf(call.progressStep ?? 'Uploading')}`}/></div>}</td><td><Button variant="ghost" size="icon" asChild><Link to="/calls/$id" params={{ id: call.id }} aria-label={`Review ${call.fileName}`}><ArrowUpRight size={15}/></Link></Button></td></tr>)}</tbody></table></div>}
   <div className="table-footer"><span>Showing {data.total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, data.total)} of {data.total} matching calls</span><div className="pagination-controls"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}><ChevronLeft size={14}/>Previous</Button><span>Page {page} of {totalPages}</span><Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(current => Math.min(totalPages, current + 1))}>Next<ChevronRight size={14}/></Button></div></div></section>
   <div className="insight-note"><Lightbulb size={18}/><div><h3>Small moments make a big difference.</h3><p>Review tone alongside the full conversation. Every flagged moment includes the words behind it, so you can coach with context, not just a score.</p></div></div>
 </main>;
}
