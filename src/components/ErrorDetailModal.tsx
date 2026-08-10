import { useEffect } from 'react';
import { X, User, Crosshair, AlertTriangle, Activity, Info, HelpCircle } from 'lucide-react';
import { formatDate } from '../lib/formatters';
import { classifyErrorSeverity, SOURCE_LABELS, type ErrorItem } from '../lib/errors';
import { explainFailure } from '../lib/failureExplainer';
import { useSignalPipeline } from '../hooks/useSignalPipeline';
import { SignalPipelineBody } from './pipeline/SignalPipelineBody';
import { SummaryCell } from './pipeline/PipelineSections';
import { JsonViewer } from './JsonViewer';
import { UserLink } from './UserLink';
import { Badge } from './ui/Badge';
import clsx from 'clsx';

interface ErrorDetailModalProps {
  error: ErrorItem;
  onClose: () => void;
}

function SeverityBadge({ severity }: { severity: 'transient' | 'major' }) {
  return (
    <Badge variant={severity === 'transient' ? 'warning' : 'error'} dot>
      {severity === 'transient' ? 'Transient' : 'Major'}
    </Badge>
  );
}

export function ErrorDetailModal({ error, onClose }: ErrorDetailModalProps) {
  const pipeline = useSignalPipeline(error.signal_id);
  const classification = classifyErrorSeverity(error.cause);
  const explanation = explainFailure(error.cause, error.source);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const detailViews = (() => {
    if (error.source === 'execution') {
      const record = error.detail as { request_payload?: unknown; response_payload?: unknown } | null;
      return (
        <div className="space-y-3">
          <JsonViewer data={record?.request_payload ?? null} label="Request payload" />
          <JsonViewer data={record?.response_payload ?? null} label="Response payload" />
        </div>
      );
    }
    if (error.source === 'signal') {
      const parsed = (error.detail ?? {}) as Record<string, unknown>;
      const raw = error.raw_message ?? (typeof parsed.raw_instruction === 'string' ? parsed.raw_instruction : null);
      return (
        <div className="space-y-3">
          <JsonViewer data={raw ?? null} label="Raw message" />
          <JsonViewer data={error.detail ?? null} label="Parsed data" />
        </div>
      );
    }
    if (error.source === 'broker') {
      return <JsonViewer data={error.detail ?? null} label="Broker account" collapsed={false} />;
    }
    return <JsonViewer data={error.detail ?? null} label="Dead letter payload" />;
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
              Transient = likely self-resolves on retry (timeouts, HTTP 5xx, throttling). Major = likely needs intervention (rejection, config, invalid state).
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
              {error.cause ?? 'No error message recorded.'}
            </p>
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
                      <span className="text-primary-500 font-bold shrink-0">→</span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
              <SignalPipelineBody {...pipeline} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
