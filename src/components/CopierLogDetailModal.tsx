import { useState } from 'react';
import { X, Sparkles, CheckCircle2, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { interpretCopierLog, type LogVerdict } from '../lib/copierLogInterpreter';
import { JsonViewer } from './JsonViewer';
import { StatusBadge } from './StatusBadge';
import clsx from 'clsx';

export interface CopierLogDetailRow {
  id: string;
  signal_id: string | null;
  broker_account_id: string | null;
  broker_label: string | null;
  action: string;
  status: string;
  error_message: string | null;
  request_payload: unknown;
  response_payload: unknown;
  created_at: string | null;
}

interface CopierLogDetailModalProps {
  log: CopierLogDetailRow;
  onClose: () => void;
}

interface AiLogResult {
  explanation: string;
  details: string[];
}

const logAiCache = new Map<string, AiLogResult>();

const VERDICT_STYLE: Record<LogVerdict, { icon: typeof CheckCircle2; ring: string; label: string }> = {
  success: { icon: CheckCircle2, ring: 'border-success-500/40 bg-success-500/10 text-success-700 dark:text-success-300', label: 'Succeeded' },
  error: { icon: XCircle, ring: 'border-error-500/40 bg-error-500/10 text-error-700 dark:text-error-300', label: 'Failed' },
  warning: { icon: AlertTriangle, ring: 'border-warning-500/40 bg-warning-500/10 text-warning-700 dark:text-warning-300', label: 'Skipped' },
  info: { icon: HelpCircle, ring: 'border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-700/40 text-slate-600 dark:text-slate-300', label: 'Information' },
};

function FieldGrid({ title, fields }: { title: string; fields: { key: string; label: string; value: unknown }[] }) {
  if (fields.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">{title}</p>
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700/60 overflow-hidden">
        {fields.map(f => (
          <div key={f.key} className="flex items-start gap-3 px-3 py-1.5 bg-slate-50/60 dark:bg-slate-900/40">
            <span className="w-36 shrink-0 text-[11px] font-medium text-slate-500 dark:text-slate-400 pt-0.5">{f.label}</span>
            <span className="text-xs text-slate-800 dark:text-slate-100 font-mono break-all">{String(f.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CopierLogDetailModal({ log, onClose }: CopierLogDetailModalProps) {
  const interpretation = interpretCopierLog(log);
  const [ai, setAi] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; data?: AiLogResult; message?: string }>({ status: 'idle' });
  const style = VERDICT_STYLE[interpretation.verdict];
  const VerdictIcon = style.icon;

  async function explainWithAi() {
    const cached = logAiCache.get(log.id);
    if (cached) {
      setAi({ status: 'done', data: cached });
      return;
    }
    setAi({ status: 'loading' });
    const { data, error } = await adminSupabase.functions.invoke('trade-pipeline-explainer', {
      body: { log_id: log.id },
    });
    if (error || !data?.explanation) {
      setAi({ status: 'error', message: (error as { message?: string })?.message ?? (data as { error?: string })?.error ?? 'Failed to generate explanation.' });
      return;
    }
    const result: AiLogResult = {
      explanation: data.explanation,
      details: Array.isArray(data.details) ? data.details : [],
    };
    logAiCache.set(log.id, result);
    setAi({ status: 'done', data: result });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-6" onClick={onClose}>
      <div
        className="w-full max-w-4xl my-4 sm:my-8 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800 rounded-t-xl z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                <span className="font-mono text-sm">{log.action}</span>
              </h2>
              <StatusBadge status={log.status} dot />
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {log.created_at ? formatDate(log.created_at) : ''}
              {log.broker_label ? ` · ${log.broker_label}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[calc(100vh-12rem)] overflow-y-auto">
          <div className={clsx('rounded-lg border px-3 py-2.5', style.ring)}>
            <p className="text-[10px] font-semibold uppercase tracking-wider opacity-80 flex items-center gap-1.5">
              <VerdictIcon className="w-3.5 h-3.5" /> {style.label}
            </p>
            <p className="text-sm font-medium mt-0.5">{interpretation.actionMeaning}</p>
            <p className="text-xs opacity-80 mt-0.5">{interpretation.statusMeaning}</p>
            {interpretation.skipReason && (
              <p className="text-xs mt-1.5 opacity-90">
                <span className="font-semibold">Skip reason: </span>{interpretation.skipReason}
              </p>
            )}
            {interpretation.errorPlain && (
              <p className="text-xs mt-1.5 opacity-90">
                <span className="font-semibold">Error: </span>{interpretation.errorPlain}
              </p>
            )}
          </div>

          <section>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-primary-500" />
              What this log means (AI)
            </h3>
            {ai.status === 'idle' && (
              <button
                type="button"
                onClick={() => void explainWithAi()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 hover:bg-primary-100 dark:hover:bg-primary-900/50 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Explain this log entry
              </button>
            )}
            {ai.status === 'loading' && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="w-3 h-3 rounded-full border-2 border-slate-300 border-t-primary-500 animate-spin" />
                Analyzing log entry…
              </div>
            )}
            {ai.status === 'done' && ai.data && (
              <div className="space-y-2">
                <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">{ai.data.explanation}</p>
                {ai.data.details.length > 0 && (
                  <ul className="space-y-1">
                    {ai.data.details.map((d, i) => (
                      <li key={i} className="text-xs text-slate-600 dark:text-slate-300 flex items-start gap-1.5">
                        <span className="mt-1 w-1.5 h-1.5 rounded-full bg-primary-500 shrink-0" />
                        {d}
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <FieldGrid title="Request details" fields={interpretation.requestFields} />
            <FieldGrid title="Response details" fields={interpretation.responseFields} />
          </div>

          <section>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Raw payloads</h3>
            <div className="space-y-2">
              <JsonViewer data={interpretation.rawRequest ?? null} label="Request payload" />
              <JsonViewer data={interpretation.rawResponse ?? null} label="Response payload" />
              {log.error_message && <JsonViewer data={log.error_message} label="Error message" />}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}