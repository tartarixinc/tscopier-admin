import { useEffect, useMemo, useState } from 'react';
import { X, User, Crosshair, AlertTriangle, Activity, Info, HelpCircle, Sparkles, MessageSquare } from 'lucide-react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate, formatNumber } from '../lib/formatters';
import { classifyErrorItemSeverity, errorDisplayForItem, SOURCE_LABELS, type ErrorItem } from '../lib/errors';
import { explainFailure, type FailureExplanation } from '../lib/failureExplainer';
import { useSignalPipeline, type SignalPipelineData } from '../hooks/useSignalPipeline';
import { SignalPipelineBody } from './pipeline/SignalPipelineBody';
import { SummaryCell } from './pipeline/PipelineSections';
import { JsonViewer } from './JsonViewer';
import { UserLink } from './UserLink';
import { Badge } from './ui/Badge';
import clsx from 'clsx';

interface ErrorDetailModalProps {
  error: ErrorItem;
  diagnosticsLoading?: boolean;
  safeDisplayOnly?: boolean;
  onClose: () => void;
}

type SafeAiScalar = string | number | boolean | null;
type SafeAiValue = SafeAiScalar | SafeAiValue[] | { [key: string]: SafeAiValue };

interface SafeSignalTradeSummary {
  symbol: string | null;
  side: string | null;
  entry: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  lot: string | null;
  signalTimestamp: string | null;
  channelName: string | null;
  brokerAccountLabel: string | null;
  operation: string | null;
  ticketReference: string | null;
  signalStatus: string | null;
  accountOutcome: string | null;
}

interface SafeAiContext {
  [key: string]: SafeAiValue;
}

function SeverityBadge({ severity }: { severity: 'transient' | 'major' }) {
  return (
    <Badge variant={severity === 'transient' ? 'warning' : 'error'} dot>
      {severity === 'transient' ? 'Transient' : 'Major'}
    </Badge>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cleanText(value: unknown, maxLength = 160): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.slice(0, maxLength);
}

function firstText(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const text = cleanText(record[key]);
    if (text) return text;
  }
  return null;
}

function nestedIntent(parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(parsed?._intent);
}

function normalizeSide(value: string | null): string | null {
  const side = value?.trim().toLowerCase();
  if (side === 'buy' || side === 'long') return 'BUY';
  if (side === 'sell' || side === 'short') return 'SELL';
  return null;
}

function formatNumericText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return formatNumber(value, 2);
  const text = cleanText(value, 80);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && /^[+-]?\d+(\.\d+)?$/.test(text) ? formatNumber(n, 2) : text;
}

function numberList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(formatNumericText).filter((v): v is string => Boolean(v));
  }
  const record = asRecord(value);
  if (record) {
    return Object.keys(record)
      .sort()
      .map(key => formatNumericText(record[key]))
      .filter((v): v is string => Boolean(v));
  }
  const single = formatNumericText(value);
  return single ? [single] : [];
}

function takeProfitSummary(parsed: Record<string, unknown> | null, tradeTp: number | null | undefined): string | null {
  const candidates = [
    parsed?.tp_levels,
    parsed?.take_profits,
    parsed?.takeProfits,
    parsed?.tps,
    parsed?.tp_targets,
    parsed?.targets,
    parsed?.tp,
    parsed?.take_profit,
    parsed?.takeProfit,
  ];
  const levels = candidates.flatMap(numberList);
  for (let i = 1; i <= 8; i += 1) {
    const level = formatNumericText(parsed?.[`tp${i}`] ?? parsed?.[`take_profit_${i}`]);
    if (level) levels.push(level);
  }
  if (levels.length === 0 && tradeTp != null) levels.push(formatNumber(tradeTp, 2));
  const unique = [...new Set(levels)];
  return unique.length > 0 ? unique.join(' / ') : null;
}

function entrySummary(parsed: Record<string, unknown> | null, tradeEntry: number | null | undefined): string | null {
  const direct = formatNumericText(
    parsed?.entry
      ?? parsed?.entry_price
      ?? parsed?.entryPrice
      ?? parsed?.entry_zone
      ?? parsed?.price,
  );
  if (direct) return direct;

  const entryRange = numberList(parsed?.entry_range ?? parsed?.entryRange);
  if (entryRange.length >= 2) return `${entryRange[0]}-${entryRange[1]}`;

  const low = formatNumericText(parsed?.entry_min ?? parsed?.entryMin ?? parsed?.entry_from ?? parsed?.from);
  const high = formatNumericText(parsed?.entry_max ?? parsed?.entryMax ?? parsed?.entry_to ?? parsed?.to);
  if (low && high) return `${low}-${high}`;

  return tradeEntry != null ? formatNumber(tradeEntry, 2) : null;
}

function buildSafeSignalTradeSummary(error: ErrorItem, pipeline: SignalPipelineData): SafeSignalTradeSummary {
  const parsed = asRecord(pipeline.signal?.parsed_data ?? error.detail);
  const intent = nestedIntent(parsed);
  const trade = pipeline.trade;
  const accountOutcomes = error.diagnostics?.accountDiagnostics ?? [];
  const outcomeCounts = accountOutcomes.reduce<Record<string, number>>((acc, account) => {
    acc[account.outcome] = (acc[account.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const accountOutcome = Object.keys(outcomeCounts).length > 0
    ? Object.entries(outcomeCounts).map(([outcome, count]) => `${count} ${outcome}`).join(', ')
    : null;

  return {
    symbol: cleanText(firstText(parsed, 'symbol', 'instrument', 'requested_symbol', 'broker_symbol') ?? trade?.symbol)?.toUpperCase() ?? null,
    side: normalizeSide(firstText(parsed, 'side', 'direction', 'order_side') ?? trade?.direction ?? null),
    entry: entrySummary(parsed, trade?.entry_price),
    stopLoss: formatNumericText(parsed?.sl ?? parsed?.stop_loss ?? parsed?.stopLoss ?? parsed?.stoploss ?? trade?.sl),
    takeProfit: takeProfitSummary(parsed, trade?.tp),
    lot: formatNumericText(parsed?.lot ?? parsed?.lots ?? parsed?.volume ?? parsed?.lot_size ?? parsed?.lotSize ?? trade?.lot_size),
    signalTimestamp: pipeline.signal?.created_at ?? error.created_at,
    channelName: cleanText(pipeline.signal?.telegram_channels?.[0]?.display_name ?? null, 120),
    brokerAccountLabel: cleanText(trade?.broker_label ?? error.broker_label ?? accountOutcomes.find(a => a.broker_label)?.broker_label ?? null, 120),
    operation: cleanText(firstText(intent, 'kind') ?? firstText(parsed, 'operation', 'action', 'type') ?? error.diagnostics?.rootCause.stage ?? null, 120),
    ticketReference: cleanText(trade?.metaapi_order_id ?? error.diagnostics?.rootCause.sourceLogId ?? error.id, 120),
    signalStatus: cleanText(pipeline.signalStatus ?? error.diagnostics?.rootCause.status ?? null, 120),
    accountOutcome,
  };
}

function buildSafeAiContext(error: ErrorItem, classification: ReturnType<typeof classifyErrorItemSeverity>, summary: SafeSignalTradeSummary): SafeAiContext {
  const rootCause = error.diagnostics?.rootCause ?? null;
  return {
    source: SOURCE_LABELS[error.source],
    normalizedCategory: error.categoryKey,
    category: error.categoryLabel,
    operation: summary.operation,
    status: rootCause?.status ?? (classification.severity === 'transient' ? 'Transient error' : 'Major error'),
    stage: rootCause?.stage ?? null,
    reasonCode: error.structured_failure?.reasonCode ?? rootCause?.safeContext.reasonCode ?? null,
    tradeFailureTitle: error.structured_failure?.title ?? rootCause?.reason ?? null,
    explanation: rootCause?.explanation ?? error.structured_failure?.explanation ?? null,
    recommendedAction: rootCause?.recommendedAction ?? error.structured_failure?.recommendedAction ?? null,
    retryable: rootCause?.retryable ?? error.structured_failure?.retryable ?? null,
    userActionRequired: rootCause?.userActionRequired ?? error.structured_failure?.userActionRequired ?? null,
    symbol: summary.symbol,
    side: summary.side,
    entry: summary.entry,
    stopLoss: summary.stopLoss,
    takeProfit: summary.takeProfit,
    lot: summary.lot,
    signalTimestamp: summary.signalTimestamp,
    channelName: summary.channelName,
    brokerAccountLabel: summary.brokerAccountLabel,
    ticketReference: summary.ticketReference,
    signalStatus: summary.signalStatus,
    accountOutcomeSummary: summary.accountOutcome,
    evidenceLabel: rootCause?.evidenceLabel ?? null,
    pipelineTrace: error.diagnostics?.trace.map(step => ({
      label: step.label,
      state: step.state,
      detail: step.detail,
    })) ?? [],
    accountOutcomes: error.diagnostics?.accountDiagnostics.map(account => ({
      brokerAccountLabel: account.broker_label,
      outcome: account.outcome,
      reason: account.rootCause?.reason ?? null,
      explanation: account.rootCause?.explanation ?? null,
      retryable: account.rootCause?.retryable ?? null,
      createdAt: account.created_at,
    })) ?? [],
    boundedDiagnostics: {
      selectionRule: error.diagnostics?.selectionRule ?? null,
      severityReason: classification.reason,
    },
  };
}

function SafeSignalTradeDetails({ summary }: { summary: SafeSignalTradeSummary }) {
  const hasAny = Object.values(summary).some(Boolean);
  if (!hasAny) {
    return (
      <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Signal / trade details</h3>
        <p className="text-xs text-slate-400">No safe parsed signal or trade fields were available for this error.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Crosshair className="w-4 h-4 text-primary-500" />
          Signal / trade details
        </h3>
        <p className="text-[11px] text-slate-400 mt-0.5">Safe parsed fields only. Raw Telegram text and payload JSON stay hidden.</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <SummaryCell label="Symbol" value={summary.symbol ?? '—'} mono />
        <SummaryCell label="Direction" value={summary.side ?? '—'} />
        <SummaryCell label="Entry" value={summary.entry ?? '—'} mono />
        <SummaryCell label="Stop loss" value={summary.stopLoss ?? '—'} mono />
        <SummaryCell label="Take profit" value={summary.takeProfit ?? '—'} mono />
        <SummaryCell label="Lot / volume" value={summary.lot ?? '—'} mono />
        <SummaryCell label="Signal time" value={summary.signalTimestamp ? formatDate(summary.signalTimestamp) : '—'} />
        <SummaryCell label="Channel" value={summary.channelName ?? '—'} />
        <SummaryCell label="Broker/account" value={summary.brokerAccountLabel ?? '—'} />
        <SummaryCell label="Operation" value={summary.operation ?? '—'} />
        <SummaryCell label="Ticket/reference" value={summary.ticketReference ?? '—'} mono />
        <SummaryCell label="Signal status" value={summary.signalStatus ?? '—'} />
      </div>
      {summary.accountOutcome && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Account outcome: <span className="font-medium text-slate-700 dark:text-slate-200">{summary.accountOutcome}</span>
        </p>
      )}
    </section>
  );
}

function TelegramSignalSummary({ summary }: { summary: SafeSignalTradeSummary }) {
  if (!summary.symbol && !summary.side && !summary.entry && !summary.stopLoss && !summary.takeProfit && !summary.channelName) return null;
  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
        <MessageSquare className="w-4 h-4 text-primary-500" />
        Telegram signal summary
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Signal</p>
          <p className="text-sm text-slate-800 dark:text-slate-100">{[summary.side, summary.symbol].filter(Boolean).join(' ') || '—'}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Entry</p>
          <p className="text-sm font-mono text-slate-800 dark:text-slate-100">{summary.entry ?? '—'}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Stop loss</p>
          <p className="text-sm font-mono text-slate-800 dark:text-slate-100">{summary.stopLoss ?? '—'}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Take profit</p>
          <p className="text-sm font-mono text-slate-800 dark:text-slate-100">{summary.takeProfit ?? '—'}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Channel</p>
          <p className="text-sm text-slate-800 dark:text-slate-100">{summary.channelName ?? '—'}</p>
        </div>
      </div>
    </section>
  );
}

function SafeAiExplainSection({ context }: { context: SafeAiContext }) {
  const [ai, setAi] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; data?: { explanation: string; details: string[]; anomalies: string[]; overall: string }; message?: string }>({ status: 'idle' });

  async function explainWithAi() {
    setAi({ status: 'loading' });
    const { data, error } = await adminSupabase.functions.invoke('trade-pipeline-explainer', {
      body: {
        safe_error_context: context,
      },
    });
    if (error || !data?.explanation) {
      setAi({ status: 'error', message: (error as { message?: string })?.message ?? (data as { error?: string })?.error ?? 'Failed to generate explanation.' });
      return;
    }
    setAi({
      status: 'done',
      data: {
        explanation: String(data.explanation),
        details: Array.isArray(data.details) ? data.details.map(String) : [],
        anomalies: Array.isArray(data.anomalies) ? data.anomalies.map(String) : [],
        overall: typeof data.overall === 'string' ? data.overall : 'normal',
      },
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
        <Sparkles className="w-4 h-4 text-primary-500" />
        AI explanation
      </h3>
      {ai.status === 'idle' && (
        <button
          type="button"
          onClick={() => void explainWithAi()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 hover:bg-primary-100 dark:hover:bg-primary-900/50 transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Explain with AI
        </button>
      )}
      {ai.status === 'loading' && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="w-3 h-3 rounded-full border-2 border-slate-300 border-t-primary-500 animate-spin" />
          Reading safe diagnostic context...
        </div>
      )}
      {ai.status === 'done' && ai.data && (
        <div className="space-y-2">
          <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">{ai.data.explanation}</p>
          {ai.data.details.length > 0 && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700/60 overflow-hidden">
              {ai.data.details.map((detail, index) => (
                <p key={index} className="text-xs text-slate-600 dark:text-slate-300 px-3 py-2 leading-relaxed">
                  {detail}
                </p>
              ))}
            </div>
          )}
          {ai.data.anomalies.length > 0 && (
            <ul className="space-y-1">
              {ai.data.anomalies.map((anomaly, index) => (
                <li key={index} className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                  <span className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                  {anomaly}
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

export function ErrorDetailModal({ error, diagnosticsLoading = false, safeDisplayOnly = false, onClose }: ErrorDetailModalProps) {
  const pipeline = useSignalPipeline(error.signal_id);
  const classification = classifyErrorItemSeverity(error);
  const display = useMemo(() => errorDisplayForItem(error), [error]);
  const safeSummary = useMemo(() => buildSafeSignalTradeSummary(error, pipeline), [error, pipeline]);
  const safeAiContext = useMemo(() => buildSafeAiContext(error, classification, safeSummary), [error, classification, safeSummary]);
  const rootCause = error.diagnostics?.rootCause ?? null;
  const safeDisplayExplanation: FailureExplanation = {
    title: display.title,
    explanation: display.explanation,
    actions: display.nextAction ? [display.nextAction] : undefined,
  };
  const structuredExplanation: FailureExplanation | null = rootCause
    ? {
      title: rootCause.reason,
      explanation: rootCause.explanation,
      actions: rootCause.recommendedAction ? [rootCause.recommendedAction] : undefined,
    }
    : error.structured_failure
    ? {
      title: error.structured_failure.title ?? error.structured_failure.reasonCode ?? 'Trade execution failed',
      explanation: error.structured_failure.explanation ?? 'Structured failure metadata was recorded for this event.',
      actions: error.structured_failure.recommendedAction ? [error.structured_failure.recommendedAction] : undefined,
    }
    : null;
  const explanation: FailureExplanation | null = safeDisplayOnly ? safeDisplayExplanation : structuredExplanation ?? explainFailure(error.cause, error.source);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const detailViews = (() => {
    if (rootCause) {
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <SummaryCell label="Status" value={rootCause.status} />
            <SummaryCell label="Stage" value={rootCause.stage} />
            <SummaryCell label="Reason" value={rootCause.reason} />
            <SummaryCell label="Evidence" value={rootCause.evidenceLabel} />
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Explanation</p>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{rootCause.explanation}</p>
            {rootCause.recommendedAction && (
              <>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mt-3 mb-1">Recommended action</p>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{rootCause.recommendedAction}</p>
              </>
            )}
          </div>
          {Object.keys(rootCause.safeContext).length > 0 && (
            <JsonViewer data={rootCause.safeContext} label="Safe context" />
          )}
        </div>
      );
    }
    if (error.source === 'signal') {
      return (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Raw Telegram and parsed payload data are not shown in this error view. Use the safe root-cause fields and linked pipeline evidence.
        </p>
      );
    }
    if (error.source === 'broker') {
      return <JsonViewer data={error.detail ?? null} label="Broker account" collapsed={false} />;
    }
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Raw dead-letter payload data is not shown in this error view.
      </p>
    );
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-6" onClick={onClose}>
      <div
        className="w-full max-w-6xl my-4 sm:my-8 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800 rounded-t-xl z-10">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                {error.categoryLabel}
              </h2>
              <SeverityBadge severity={classification.severity} />
              <Badge variant="muted">{SOURCE_LABELS[error.source]}</Badge>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-tight">
              {error.user_display_name ?? 'Unknown user'}
              {error.created_at ? ` · ${formatDate(error.created_at)}` : ''}
              <span className="font-mono ml-1.5">{error.id.slice(0, 8)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-6 max-h-[calc(100vh-12rem)] overflow-y-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                <User className="w-3 h-3" /> User involved
              </p>
              <p className="text-sm mt-0.5 truncate">
                {error.user_id
                  ? <UserLink userId={error.user_id} displayName={error.user_display_name} />
                  : <span className="text-slate-400">—</span>}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                <Crosshair className="w-3 h-3" /> Trade involved
              </p>
              <p className="text-sm mt-0.5 truncate font-mono text-xs text-slate-800 dark:text-slate-100">
                {error.trade_context ?? '—'}
              </p>
            </div>
            <SummaryCell label="Severity" value={classification.severity === 'transient' ? 'Transient' : 'Major'} />
            <SummaryCell label="Created" value={error.created_at ? formatDate(error.created_at) : '—'} />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Severity classification
              </p>
              <SeverityBadge severity={classification.severity} />
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed break-words">{classification.reason}</p>
            <p className="text-[10px] text-slate-400">
              {rootCause?.retryable === false
                ? 'This event is marked non-retryable by root-cause metadata.'
                : error.structured_failure?.retryable === false
                  ? 'This event is marked non-retryable by structured failure metadata.'
                : 'Transient = likely self-resolves on retry (timeouts, HTTP 5xx, throttling). Major = likely needs intervention (rejection, config, invalid state).'}
            </p>
          </div>

          <div className={clsx(
            'rounded-lg border px-3 py-2.5',
            classification.severity === 'transient'
              ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20'
              : 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
          )}>
            <p className={clsx(
              'text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5',
              classification.severity === 'transient' ? 'text-amber-600 dark:text-amber-400' : 'text-error-600 dark:text-error-400'
            )}>
              <AlertTriangle className="w-3.5 h-3.5" /> Why this error happened
            </p>
            <p className={clsx(
              'text-sm mt-1 break-words whitespace-pre-wrap',
              classification.severity === 'transient' ? 'text-amber-800 dark:text-amber-200' : 'text-error-700 dark:text-error-200'
            )}>
              {safeDisplayOnly ? display.reason : rootCause ? rootCause.reason : error.cause ?? 'No error message recorded.'}
            </p>
            {(rootCause?.retryable === false || error.structured_failure?.retryable === false) && (
              <p className="text-[10px] mt-2 text-error-700 dark:text-error-200">
                Retryable: false
              </p>
            )}
          </div>

          {explanation && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <HelpCircle className="w-3.5 h-3.5" /> What actually happened
              </p>
              <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{explanation.title}</h4>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{explanation.explanation}</p>
              {explanation.actions && explanation.actions.length > 0 && (
                <ul className="text-xs text-slate-600 dark:text-slate-300 space-y-1.5 pt-1">
                  {explanation.actions.map((a, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-primary-500 font-bold shrink-0">-&gt;</span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {diagnosticsLoading && (
            <div className="rounded-xl border border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-900/20 p-4 flex items-center gap-2 text-xs text-primary-700 dark:text-primary-300">
              <span className="w-3.5 h-3.5 rounded-full border-2 border-primary-200 border-t-primary-600 animate-spin" />
              Loading diagnostic evidence...
            </div>
          )}

          <SafeSignalTradeDetails summary={safeSummary} />

          <TelegramSignalSummary summary={safeSummary} />

          <SafeAiExplainSection context={safeAiContext} />

          {error.diagnostics && (
            <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Diagnostic trace</h3>
                <p className="text-[11px] text-slate-400 mt-1">{error.diagnostics.selectionRule}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-5">
                {error.diagnostics.trace.map(step => (
                  <div key={step.label} className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
                    <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{step.label}</p>
                    <Badge
                      variant={step.state === 'failed' ? 'error' : step.state === 'success' ? 'success' : step.state === 'pending' ? 'warning' : 'muted'}
                      dot
                      className="mt-1"
                    >
                      {step.state}
                    </Badge>
                    {step.detail && <p className="text-[10px] text-slate-400 mt-1 break-words">{step.detail}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {error.diagnostics && error.diagnostics.accountDiagnostics.length > 0 && (
            <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Broker account outcomes</h3>
              <div className="space-y-2">
                {error.diagnostics.accountDiagnostics.map((account, index) => (
                  <div key={`${account.broker_account_id ?? 'unknown'}-${index}`} className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                        {account.broker_label ?? account.broker_account_id ?? 'Unknown broker account'}
                      </p>
                      <Badge variant={account.outcome === 'failed' ? 'error' : account.outcome === 'success' ? 'success' : account.outcome === 'pending' ? 'warning' : 'muted'} dot>
                        {account.outcome}
                      </Badge>
                      {account.created_at && <span className="text-[10px] text-slate-400 ml-auto">{formatDate(account.created_at)}</span>}
                    </div>
                    {account.rootCause && (
                      <div className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                        <p className="font-medium text-slate-700 dark:text-slate-200">{account.rootCause.reason}</p>
                        <p className="mt-0.5 leading-relaxed">{account.rootCause.explanation}</p>
                        {account.rootCause.recommendedAction && (
                          <p className="mt-1"><span className="font-semibold">Next:</span> {account.rootCause.recommendedAction}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">What caused it</h3>
            {detailViews}
          </section>

          {error.signal_id && (
            <section>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">
                <Info className="w-4 h-4 text-primary-500" />
                Full signal pipeline
              </h3>
              <SignalPipelineBody {...pipeline} hideRawData context="ERROR DETAIL MODAL - the administrator opened this from an error report. Priorities: (1) lead with the failure using safe root-cause wording - which stage failed and the likely cause; (2) whether the error was recovered (retried and succeeded) or is still failing; (3) only then note latency or model-chain context if it contributed. Do not include raw payloads or arbitrary raw error text." />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
