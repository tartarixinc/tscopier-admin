import { useState } from 'react';
import { Activity, Clock, Sparkles } from 'lucide-react';
import { authSupabase as adminSupabase } from '../../lib/adminSupabase';
import { formatDate } from '../../lib/formatters';
import type { PipelineTimelineEvent, PipelineStageStat } from '../../lib/pipelineTimeline';
import { JsonViewer } from '../JsonViewer';
import { StatusBadge } from '../StatusBadge';
import { tooltipStyle, gridStyle, axisStyle } from '../../lib/chartTheme';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import clsx from 'clsx';

export interface ExecutionLogRow {
  id: string;
  action: string;
  status: string;
  error_message: string | null;
  request_payload: unknown;
  response_payload: unknown;
  created_at: string | null;
}

export interface AiExplanation {
  explanation: string;
  anomalies: string[];
  overall: 'fast' | 'normal' | 'slow';
}

const WATERFALL_STAGES = [
  { key: 'telegram_to_listener_ms', label: 'Telegram → listener' },
  { key: 'parse_ms', label: 'Parse' },
  { key: 'signal_persist_ms', label: 'Persist' },
  { key: 'queue_wait_ms', label: 'Queue wait' },
  { key: 'prep_ms', label: 'Prep' },
  { key: 'planning_ms', label: 'Planning' },
  { key: 'execution_claim_ms', label: 'Claim' },
  { key: 'broker_resolve_ms', label: 'Broker resolve' },
  { key: 'broker_send_ms', label: 'Broker send' },
];

const aiCache = new Map<string, AiExplanation>();

function formatTime(at: number | null): string {
  if (at == null) return '—';
  return new Date(at).toISOString().slice(11, 23) + 'Z';
}

function durationColor(ms: number | null): string {
  if (ms == null) return 'bg-slate-200 dark:bg-slate-700';
  if (ms < 500) return 'bg-success-500';
  if (ms < 2000) return 'bg-amber-500';
  return 'bg-error-500';
}

function durationText(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function plainFailureReason(log: ExecutionLogRow): string | null {
  if (log.status !== 'failed' || !log.error_message) return null;
  const message = log.error_message.toLowerCase();
  const request = log.request_payload as { ticket?: unknown; attempted_sl?: unknown; new_sl?: unknown } | null;
  if (message.includes('invalid stops')) {
    const attempted = request?.attempted_sl ?? request?.new_sl;
    const ticket = request?.ticket != null ? ` for broker ticket ${String(request.ticket)}` : '';
    return `The broker rejected this stop-loss price${ticket}. The requested stop was not accepted because it did not meet the broker's current price or minimum-distance rules. Exact market price and broker stop-distance values were not recorded.` + (attempted != null ? ` Requested stop: ${String(attempted)}.` : '');
  }
  return null;
}

export function PipelineTimelineSection({ events, finalStatus }: { events: PipelineTimelineEvent[]; finalStatus?: string | null }) {
  if (events.length === 0) return null;
  return (
    <ol className="relative border-l-2 border-slate-200 dark:border-slate-700 ml-2 space-y-3">
      {events.map((event, idx) => (
        <li key={event.key} className="ml-4 relative">
          <span
            className={clsx(
              'absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-slate-800',
              durationColor(event.durationMs),
            )}
          />
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{event.label}</span>
            {idx === events.length - 1 && finalStatus != null && (
              <StatusBadge status={finalStatus} />
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 text-xs text-slate-400">
            <span className="font-mono">{formatTime(event.at)}</span>
            {event.offsetMs != null && <span className="font-mono">+{event.offsetMs} ms</span>}
            {event.durationMs != null && (
              <span className={clsx('font-mono', event.durationMs >= 2000 ? 'text-error-500' : event.durationMs >= 500 ? 'text-amber-500' : 'text-slate-400')}>
                {durationText(event.durationMs)} after previous
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function LatencyGanttSection({ durations }: { durations?: Record<string, number> }) {
  if (!durations) return null;

  const waterfallRow: Record<string, number> = { name: 0 };
  WATERFALL_STAGES.forEach((s, i) => { waterfallRow[`s${i}`] = Math.round(durations[s.key] ?? 0); });

  const ganttData = (() => {
    let cumulative = 0;
    return WATERFALL_STAGES.map((s, i) => {
      const dur = waterfallRow[`s${i}`] ?? 0;
      const entry = { name: s.label, offset: cumulative, dur, key: s.key };
      cumulative += dur;
      return entry;
    });
  })();

  if (!ganttData.some(d => d.dur > 0)) return null;

  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">
        <Activity className="w-4 h-4 text-primary-500" />
        Latency graph
      </h3>
      <p className="text-xs text-slate-400 mb-3">
        Each stage on its own line — position shows when it happened, bar length shows how long it took. Total journey: {durationText(ganttData.reduce((a, d) => a + d.dur, 0))}.
      </p>
      <ResponsiveContainer width="100%" height={Math.max(220, ganttData.length * 30)}>
        <BarChart data={ganttData} layout="vertical" margin={{ left: 8, right: 24 }}>
          <CartesianGrid {...gridStyle} horizontal={false} />
          <XAxis type="number" dataKey="offset" {...axisStyle} tickFormatter={v => `+${durationText(Number(v))}`} />
          <YAxis type="category" dataKey="name" width={140} {...axisStyle} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v, name, item) => {
              const d = (item?.payload as { offset?: number; dur?: number } | undefined) ?? {};
              if (name === 'dur') return [durationText(d.dur ?? 0), 'Duration'];
              return [String(v), 'Starts at'];
            }}
            labelFormatter={label => String(label)}
          />
          <Bar dataKey="offset" stackId="g" fill="transparent" />
          <Bar dataKey="dur" stackId="g" radius={[0, 3, 3, 0]}>
            {ganttData.map((d, i) => (
              <Cell key={i} fill={d.dur < 500 ? '#22c55e' : d.dur < 2000 ? '#f59e0b' : '#ef4444'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] text-slate-400">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-success-500" /> Fast (&lt;500ms)</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" /> Slow (500ms–2s)</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-error-500" /> Critical (≥2s)</span>
      </div>
    </section>
  );
}

export function LatencyBreakdownSection({ stats }: { stats: PipelineStageStat[] }) {
  if (stats.length === 0) return null;
  const total = stats.find(s => s.key === 'total_ms')?.value;
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">
        <Clock className="w-4 h-4 text-primary-500" />
        Latency breakdown
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="py-2 font-semibold">Stage</th>
              <th className="py-2 font-semibold text-right">Duration</th>
              <th className="py-2 font-semibold w-1/2">Relative</th>
            </tr>
          </thead>
          <tbody>
            {stats.map(({ key, label, value }) => {
              const pct = total && value != null ? Math.round((value / total) * 100) : null;
              return (
                <tr key={key} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className={clsx('py-1.5', key === 'total_ms' && 'font-semibold text-slate-800 dark:text-slate-100')}>{label}</td>
                  <td className={clsx('py-1.5 text-right font-mono', key === 'total_ms' && 'font-bold text-primary-600 dark:text-primary-400')}>
                    {durationText(value)}
                  </td>
                  <td className="py-1.5 pl-3">
                    {pct != null && (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                          <div
                            className={clsx('h-full rounded-full', durationColor(value))}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="text-slate-400 font-mono w-8 text-right">{pct}%</span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AiExplainSection({
  signalId,
  tradeId,
  brokerAccountId,
}: {
  signalId: string | null;
  tradeId?: string | null;
  brokerAccountId?: string | null;
}) {
  const [ai, setAi] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; data?: AiExplanation; message?: string }>({ status: 'idle' });

  async function explainWithAi() {
    if (!signalId) return;
    const cacheKey = `${signalId}:${tradeId ?? 'signal'}`;
    const cached = aiCache.get(cacheKey);
    if (cached) {
      setAi({ status: 'done', data: cached });
      return;
    }
    setAi({ status: 'loading' });
    const { data, error } = await adminSupabase.functions.invoke('trade-pipeline-explainer', {
      body: { signal_id: signalId, trade_id: tradeId ?? undefined, broker_account_id: brokerAccountId ?? undefined },
    });
    if (error || !data?.explanation) {
      setAi({ status: 'error', message: (error as { message?: string })?.message ?? (data as { error?: string })?.error ?? 'Failed to generate explanation.' });
      return;
    }
    const result: AiExplanation = {
      explanation: data.explanation,
      anomalies: Array.isArray(data.anomalies) ? data.anomalies : [],
      overall: data.overall ?? 'normal',
    };
    aiCache.set(cacheKey, result);
    setAi({ status: 'done', data: result });
  }

  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">
        <Sparkles className="w-4 h-4 text-primary-500" />
        Plain-English explanation
      </h3>
      {ai.status === 'idle' && (
        <button
          type="button"
          onClick={() => void explainWithAi()}
          disabled={!signalId}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 hover:bg-primary-100 dark:hover:bg-primary-900/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Explain this trade
        </button>
      )}
      {ai.status === 'loading' && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="w-3 h-3 rounded-full border-2 border-slate-300 border-t-primary-500 animate-spin" />
          Reading the trade records…
        </div>
      )}
      {ai.status === 'done' && ai.data && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {ai.data.overall === 'slow' && <StatusBadge status="slow" />}
            {ai.data.overall === 'normal' && <StatusBadge status="normal" />}
            {ai.data.overall === 'fast' && <StatusBadge status="fast" />}
            {ai.data.anomalies.length > 0 && (
              <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                {ai.data.anomalies.length} anomaly{ai.data.anomalies.length > 1 ? 'ies' : 'y'} flagged
              </span>
            )}
          </div>
          <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">{ai.data.explanation}</p>
          {ai.data.anomalies.length > 0 && (
            <ul className="space-y-1">
              {ai.data.anomalies.map((a, i) => (
                <li key={i} className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                  <span className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                  {a}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {ai.status === 'error' && (
        <div className="space-y-2">
          <p className="text-xs text-error-600 dark:text-error-400">{ai.message}</p>
          <button
            type="button"
            onClick={() => void explainWithAi()}
            className="text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline"
          >
            Retry
          </button>
        </div>
      )}
    </section>
  );
}

export function ExecutionAttemptsSection({ logs }: { logs: ExecutionLogRow[] }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">
        Execution attempts ({logs.length})
        {logs.length > 1 && (
          <span className="ml-2 text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 rounded-full">
            retried — {(() => {
              const first = logs[logs.length - 1]?.created_at;
              const last = logs[0]?.created_at;
              if (!first || !last) return '';
              return `${durationText(new Date(last).getTime() - new Date(first).getTime())} across attempts`;
            })()}
          </span>
        )}
      </h3>
      {logs.length === 0 ? (
        <p className="text-xs text-slate-400">No execution log entries.</p>
      ) : (
        <div className="space-y-2">
          {logs.map((log, idx) => (
            <div key={log.id} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold text-slate-400">#{logs.length - idx}</span>
                <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{log.action}</span>
                <StatusBadge status={log.status} dot />
                <span className="text-[10px] text-slate-400 font-mono ml-auto">{formatDate(log.created_at)}</span>
              </div>
              {log.error_message && (
                <div className="space-y-1">
                  <p className="text-xs text-error-600 dark:text-error-400 break-words">Broker error: {log.error_message}</p>
                  {plainFailureReason(log) && (
                    <p className="text-xs text-slate-600 dark:text-slate-300 break-words"><span className="font-semibold">Failure reason:</span> {plainFailureReason(log)}</p>
                  )}
                </div>
              )}
              {log.request_payload != null && <JsonViewer data={log.request_payload} label="Request" />}
              {log.response_payload != null && <JsonViewer data={log.response_payload} label="Response" />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function SummaryCell({ label, value, mono, tone }: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'success' | 'error';
}) {
  return (
    <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={clsx(
        'text-sm mt-0.5 truncate',
        mono && 'font-mono text-xs',
        tone === 'success' && 'text-success-600 dark:text-success-400 font-medium',
        tone === 'error' && 'text-error-600 dark:text-error-400 font-medium',
        !tone && 'text-slate-800 dark:text-slate-100',
      )}>
        {value}
      </p>
    </div>
  );
}
