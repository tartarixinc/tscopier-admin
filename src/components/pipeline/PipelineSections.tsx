import { useState } from 'react';
import { Activity, Clock, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
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
  details?: string[];
}

const WATERFALL_STAGES = [
  { key: 'telegram_to_listener_ms', label: 'Telegram → listener' },
  { key: 'parse_ms', label: 'Parse' },
  { key: 'stage1_ms', label: 'Stage 1 · deterministic' },
  { key: 'stage2_ms', label: 'Stage 2 · OSS' },
  { key: 'stage3_ms', label: 'Stage 3 · GPT-4o' },
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
      details: Array.isArray(data.details) ? data.details : [],
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
          {ai.data.details && ai.data.details.length > 0 && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700/60 overflow-hidden">
              {ai.data.details.map((d, i) => (
                <p key={i} className="text-xs text-slate-600 dark:text-slate-300 px-3 py-2 leading-relaxed">
                  {d}
                </p>
              ))}
            </div>
          )}
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

interface AiVerificationEventDetail {
  signal_id?: unknown;
  reason?: unknown;
  ai_intent?: unknown;
  ai_source?: unknown;
  skip_reason?: unknown;
  review_required?: unknown;
  deterministic_status?: unknown;
  deterministic_action?: unknown;
}

interface AiVerificationSignal {
  parsed_data: unknown;
  skip_reason: string | null;
  status: string | null;
}

interface AiVerificationEvent {
  id: string;
  event_type: string;
  detail: unknown;
  created_at: string | null;
}

function lastAiEvent(events: AiVerificationEvent[], type: string): AiVerificationEvent | undefined {
  return [...events].reverse().find(event => event.event_type === type);
}

export interface VerificationStage {
  source: string;
  kind: string | null;
  side?: string | null;
  symbol?: string | null;
  confidence?: number | null;
  status?: string | null;
  skip_reason?: string | null;
  /** Wall-clock time this stage took (ms). */
  duration_ms?: number | null;
}

export interface VerificationChain {
  deterministic: VerificationStage | null;
  stage2: VerificationStage | null;
  stage3: VerificationStage | null;
  final: {
    path: string;
    source: string;
    kind: string;
    skip_reason?: string | null;
  };
}

const FINAL_PATH_LABELS: Record<string, string> = {
  fast_lane: 'Deterministic fast lane — dispatched without AI',
  stage2: 'Decided by stage 2 (OSS)',
  stage3: 'Decided by stage 3 (GPT-4o)',
  deterministic_fallback: 'AI unavailable — deterministic policy ran',
  veto_disabled: 'OSS veto disabled — deterministic result used',
  grounding_skip: 'Rejected by modification grounding',
  review: 'Escalated to human review',
  stage2_veto: 'Rejected by stage 2 (OSS)',
  no_ai: 'AI parsing disabled',
  shadow: 'Shadow mode — deterministic result used',
};

const SOURCE_BADGES: Record<string, { label: string; tone: 'emerald' | 'amber' | 'slate' | 'sky' }> = {
  deterministic: { label: 'Regex', tone: 'slate' },
  cerebras: { label: 'Cerebras OSS', tone: 'sky' },
  openai: { label: 'OpenAI (OSS fallback)', tone: 'sky' },
  gpt4o: { label: 'GPT-4o', tone: 'emerald' },
};

function sourceBadge(source: string): { label: string; tone: 'emerald' | 'amber' | 'slate' | 'sky' } {
  return SOURCE_BADGES[String(source ?? '').toLowerCase()] ?? { label: String(source ?? '—'), tone: 'slate' };
}

function stageConfidence(stage: VerificationStage | null): number | null {
  if (!stage) return null;
  const c = stage.confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

function ChainRow({ step, title, stage, note }: {
  step: string;
  title: string;
  stage: VerificationStage | null;
  note?: string | null;
}) {
  const badge = stage ? sourceBadge(stage.source) : null;
  const conf = stageConfidence(stage);
  const kind = stage?.kind ?? null;
  const dur = stage?.duration_ms;
  const durationLabel = typeof dur === 'number' && Number.isFinite(dur)
    ? `${dur < 1000 ? `${dur} ms` : `${(dur / 1000).toFixed(2)} s`}`
    : null;
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-700 text-[11px] font-bold text-slate-500 dark:text-slate-300">
          {step}
        </span>
        <span className="mt-1 h-full w-px bg-slate-200 dark:bg-slate-700" />
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{title}</p>
          {badge && (
            <span className={clsx(
              'rounded-full px-2 py-0.5 text-[10px] font-semibold',
              badge.tone === 'emerald' && 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
              badge.tone === 'amber' && 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
              badge.tone === 'sky' && 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300',
              badge.tone === 'slate' && 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
            )}>
              {badge.label}
            </span>
          )}
          {stage?.status && <StatusBadge status={stage.status} dot />}
          {durationLabel && (
            <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-500 dark:text-slate-300">
              {durationLabel}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-400">
          {kind != null && <span className="font-mono">{kind}</span>}
          {stage?.symbol && <span className="font-mono">{stage.symbol}</span>}
          {stage?.side && <span className="font-mono uppercase">{stage.side}</span>}
          {conf != null && <span className="font-mono">confidence {conf}</span>}
        </div>
        {stage?.skip_reason != null && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400 break-words">
            {stage.skip_reason}
          </p>
        )}
        {note != null && <p className="mt-1 text-[11px] text-slate-400">{note}</p>}
      </div>
    </div>
  );
}

/** Legacy fallback: derive the chain from parsed_data + listener events when
 *  the signal predates the `_verification` field. */
function chainFromLegacy(signal: { parsed_data: unknown; skip_reason: string | null; status: string | null; pipeline_ts?: unknown } | null, events: AiVerificationEvent[]): VerificationChain | null {
  if (!signal) return null;
  const parsed = (signal.parsed_data ?? {}) as Record<string, unknown>;
  const intent = (parsed._intent ?? null) as { kind?: unknown; confidence?: unknown } | null;
  const confidence = Number(parsed.confidence);
  const hasConf = Number.isFinite(confidence) && confidence > 0;
  const detStatus: 'parsed' | 'skipped' = hasConf && confidence >= 0.99 ? 'parsed' : 'skipped';
  const aiEntry = lastAiEvent(events, 'ai_entry_parsed') ?? lastAiEvent(events, 'ai_modification_parsed');
  const aiEntryDetail = aiEntry && typeof aiEntry.detail === 'object' && aiEntry.detail !== null
    ? aiEntry.detail as { ai_source?: unknown; intent?: unknown }
    : null;
  const aiSource = String(aiEntryDetail?.ai_source ?? '').toLowerCase();
  const stage2Source = aiSource === 'gpt4o' || aiSource === 'cerebras' || aiSource === 'openai' ? aiSource : null;
  const skip = String(signal.skip_reason ?? '').trim().toLowerCase();
  const finalPath = skip === 'ai classified as uncertain; human review required'
    ? 'review'
    : skip === 'ai_review_expired' || skip === 'ai_review_price_passed'
      ? 'review'
      : hasConf && confidence >= 0.99
        ? 'fast_lane'
        : stage2Source
          ? 'stage2'
          : skip
            ? 'stage2_veto'
            : 'no_ai';

  const pts = (signal.pipeline_ts ?? {}) as Record<string, number | undefined>;
  const p = (end: string | undefined, start: string | undefined): number | null => {
    if (end == null || start == null) return null;
    const a = pts[end];
    const b = pts[start];
    return typeof a === 'number' && typeof b === 'number' ? Math.max(0, a - b) : null;
  };
  // For fast-lane signals the entire parse WAS the deterministic stage — the
  // parse timestamps are an exact stand-in for the pre-timing-stamps era.
  const parseMs = p('parse_completed_at', 'parse_started_at');
  const stage1Ms = p('t_stage1_done_at', 't_stage1_started_at') ?? (finalPath === 'fast_lane' ? parseMs : null);

  return {
    deterministic: {
      source: 'deterministic',
      kind: String(parsed.action ?? 'ignore').toLowerCase(),
      symbol: String(parsed.symbol ?? '') || null,
      confidence: hasConf ? confidence : null,
      status: detStatus,
      skip_reason: null,
      duration_ms: stage1Ms,
    },
    stage2: stage2Source
      ? {
          source: stage2Source,
          kind: typeof intent?.kind === 'string' ? intent.kind : null,
          confidence: typeof intent?.confidence === 'number' ? intent.confidence : null,
          status: signal.status,
          skip_reason: skip || null,
          duration_ms: p('t_stage2_done_at', 't_stage2_started_at'),
        }
      : null,
    stage3: stage2Source === 'gpt4o'
      ? {
          source: 'gpt4o',
          kind: typeof intent?.kind === 'string' ? intent.kind : null,
          confidence: typeof intent?.confidence === 'number' ? intent.confidence : null,
          status: signal.status,
          skip_reason: skip || null,
          duration_ms: p('t_stage3_done_at', 't_stage3_started_at'),
        }
      : null,
    final: {
      path: finalPath,
      source: stage2Source ?? 'deterministic',
      kind: typeof intent?.kind === 'string' ? intent.kind : String(parsed.action ?? 'ignore').toLowerCase(),
      skip_reason: signal.skip_reason,
    },
  };
}

/** Model decision chain: ingestion → deterministic (regex) → OSS → GPT-4o → final. */
export function ModelDecisionChainSection({ signal, listenerEvents }: {
  signal: { parsed_data: unknown; skip_reason: string | null; status: string | null; pipeline_ts?: unknown } | null;
  listenerEvents: AiVerificationEvent[];
}) {
  if (!signal) return null;
  const parsed = (signal.parsed_data ?? {}) as Record<string, unknown>;
  const chain = (parsed._verification as VerificationChain | null) ?? chainFromLegacy(signal, listenerEvents);
  if (!chain) return null;

  const pipelineTs = (signal.pipeline_ts ?? {}) as Record<string, number | undefined>;
  const ingestedAt = pipelineTs.t_listener_received ?? pipelineTs.t_parse_started ?? null;
  const ingestedLabel = ingestedAt != null ? new Date(ingestedAt).toISOString().slice(11, 23) + 'Z' : null;
  const parseStart = pipelineTs.parse_started_at ?? pipelineTs.t_parse_started ?? null;
  const parseDone = pipelineTs.parse_completed_at ?? pipelineTs.t_parse_done ?? null;
  const parseMs = typeof parseStart === 'number' && typeof parseDone === 'number'
    ? Math.max(0, parseDone - parseStart)
    : null;
  const hasStageStamps = pipelineTs.t_stage1_started_at != null || chain.deterministic?.duration_ms != null;
  const stage1Ms = chain.deterministic?.duration_ms
    ?? (chain.final.path === 'fast_lane' ? parseMs : null);

  const fallbackEvt = lastAiEvent(listenerEvents, 'ai_parse_fallback');
  const fallbackEvtReason = fallbackEvt && typeof fallbackEvt.detail === 'object' && fallbackEvt.detail !== null
    ? (fallbackEvt.detail as { reason?: unknown }).reason
    : null;
  const stage2FallbackNote = chain.stage2?.source === 'openai'
    ? `Skipped stage 2 — Cerebras unavailable, fell back to OpenAI${fallbackEvtReason != null ? `: ${String(fallbackEvtReason)}` : ''}`
    : null;

  const finalPathLabel = FINAL_PATH_LABELS[chain.final.path] ?? `Path: ${chain.final.path}`;
  const finalBadge = sourceBadge(chain.final.source);

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <ShieldCheck className="w-4 h-4 text-primary-500" />
            Model decision chain
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">Ingestion → deterministic → OSS → GPT-4o → final decision.</p>
        </div>
        {ingestedLabel && <span className="text-[10px] font-mono text-slate-400">ingested {ingestedLabel}</span>}
      </div>

      <ChainRow
        step="1"
        title="Deterministic regex engine"
        stage={chain.deterministic ? { ...chain.deterministic, duration_ms: stage1Ms } : null}
        note={chain.final.path === 'fast_lane' ? 'Fast lane — this stage decided alone, no AI ran.' : null}
      />
      <ChainRow
        step="2"
        title="OSS context interpretation"
        stage={chain.stage2}
        note={stage2FallbackNote ?? (!chain.stage2 ? 'Not reached (fast lane / AI disabled).' : null)}
      />
      <ChainRow
        step="3"
        title="GPT-4o reconciliation"
        stage={chain.stage3}
        note={!chain.stage3 ? 'Not needed — stage 2 result was trusted.' : null}
      />

      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Final decision</span>
          <span className={clsx(
            'rounded-full px-2 py-0.5 text-[10px] font-semibold',
            finalBadge.tone === 'emerald' && 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
            finalBadge.tone === 'amber' && 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
            finalBadge.tone === 'sky' && 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300',
            finalBadge.tone === 'slate' && 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
          )}>
            {finalBadge.label}
          </span>
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{finalPathLabel}</span>
          {chain.final.kind && <span className="text-xs font-mono text-slate-500">{chain.final.kind}</span>}
        </div>
        {chain.final.skip_reason && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400 break-words">{chain.final.skip_reason}</p>
        )}
        {parseMs != null && !hasStageStamps && (
          <p className="mt-1 text-[11px] text-slate-400">
            Parse latency: {parseMs < 1000 ? `${parseMs} ms` : `${(parseMs / 1000).toFixed(2)} s`} total
            (deterministic + AI) — per-stage stamps start with newer signals.
          </p>
        )}
      </div>
    </section>
  );
}

function aiEventDetail(event: AiVerificationEvent | undefined): AiVerificationEventDetail | null {
  if (!event || typeof event.detail !== 'object' || event.detail === null) return null;
  return event.detail as AiVerificationEventDetail;
}

/** Parse-path and AI-verification evidence for a signal: who parsed it, what
 *  the AI said, and whether human review is pending, expired, or rejected. */
export function AiVerificationSection({
  signal,
  listenerEvents,
}: {
  signal: AiVerificationSignal | null;
  listenerEvents: AiVerificationEvent[];
}) {
  const parsed = (signal?.parsed_data ?? null) as Record<string, unknown> | null;
  const intent = (parsed?._intent ?? null) as { kind?: unknown; confidence?: unknown } | null;
  const aiKind = typeof intent?.kind === 'string' ? intent.kind : null;
  const confidence = Number(parsed?.confidence);
  const hasConfidence = Number.isFinite(confidence) && confidence > 0;
  const aiConfidence = typeof intent?.confidence === 'number' ? intent.confidence : null;

  const fallback = lastAiEvent(listenerEvents, 'ai_parse_fallback');
  const fallbackDetail = aiEventDetail(fallback);
  const reviewEvent = lastAiEvent(listenerEvents, 'ai_parse_review_required');
  const reviewDetail = aiEventDetail(reviewEvent);

  const skip = String(signal?.skip_reason ?? '').trim().toLowerCase();
  const reviewState = skip === 'ai classified as uncertain; human review required'
    ? 'pending'
    : skip === 'ai_review_expired'
      ? 'expired'
      : skip === 'ai_review_price_passed'
        ? 'price_passed'
        : null;

  if (!signal) return null;

  const pathBadge = aiKind
    ? { label: `AI parse — ${aiKind}`, tone: aiKind === 'entry' || aiKind === 'modify' || aiKind === 'close' || aiKind === 'breakeven' || aiKind === 'partial_close' || aiKind === 'cancel_pending'
      ? 'emerald'
      : aiKind === 'uncertain'
        ? 'amber'
        : 'slate' }
    : hasConfidence && confidence >= 0.99
      ? { label: 'Deterministic fast lane (0.99)', tone: 'emerald' }
      : hasConfidence
        ? { label: 'Deterministic — sent to AI verification', tone: 'slate' }
        : { label: 'Deterministic skip', tone: 'slate' };

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <ShieldCheck className="w-4 h-4 text-primary-500" />
            AI signal verification
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">Who parsed this message and what the AI decided.</p>
        </div>
        <span className={clsx(
          'rounded-full px-2.5 py-1 text-[10px] font-semibold',
          pathBadge.tone === 'emerald' && 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
          pathBadge.tone === 'amber' && 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
          pathBadge.tone === 'slate' && 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
        )}>
          {pathBadge.label}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <SummaryCell label="Signal status" value={signal.status ?? '—'} />
        <SummaryCell label="Confidence" value={aiConfidence != null ? String(aiConfidence) : hasConfidence ? String(confidence) : '—'} mono />
        <SummaryCell label="AI source" value={String(reviewDetail?.ai_source ?? fallbackDetail?.ai_source ?? '—')} />
        <SummaryCell label="Review state" value={reviewState === 'pending' ? 'Pending' : reviewState === 'expired' ? 'Expired' : reviewState === 'price_passed' ? 'Rejected (price)' : 'None'} tone={reviewState ? (reviewState === 'pending' ? undefined : 'error') : undefined} />
      </div>

      {fallbackDetail?.reason != null && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">AI was unavailable — deterministic policy ran</p>
            <p className="mt-0.5 break-words">Reason: {String(fallbackDetail.reason)}</p>
            {fallbackDetail.ai_intent != null && <p className="text-amber-600 dark:text-amber-400 mt-0.5">AI intent: {String(fallbackDetail.ai_intent)} · source: {String(fallbackDetail.ai_source ?? '—')}</p>}
          </div>
        </div>
      )}

      {reviewDetail && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <p className="font-semibold">AI was uncertain — human review required</p>
          {reviewDetail.ai_intent != null && <p className="mt-0.5">AI intent: {String(reviewDetail.ai_intent)} · source: {String(reviewDetail.ai_source ?? '—')}</p>}
          {reviewDetail.skip_reason != null && <p className="mt-0.5 break-words">Skip reason: {String(reviewDetail.skip_reason)}</p>}
        </div>
      )}

      {reviewState === 'expired' && (
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          The two-minute review window passed before approval — the signal was expired and not traded.
        </div>
      )}
      {reviewState === 'price_passed' && (
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          The market price moved outside the signal's entry range before approval — the review was rejected and not traded.
        </div>
      )}

      {!fallbackDetail && !reviewDetail && !reviewState && (
        <p className="text-[10px] text-slate-400">No AI fallback or review events recorded for this message.</p>
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
