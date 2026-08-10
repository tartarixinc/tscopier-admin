import { useEffect } from 'react';
import { X } from 'lucide-react';
import { formatDate } from '../lib/formatters';
import { useSignalPipeline } from '../hooks/useSignalPipeline';
import { SignalPipelineBody } from './pipeline/SignalPipelineBody';
import { StatusBadge } from './StatusBadge';

interface SignalDetailModalProps {
  signalId: string;
  onClose: () => void;
}

export function SignalDetailModal({ signalId, onClose }: SignalDetailModalProps) {
  const pipeline = useSignalPipeline(signalId);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-6" onClick={onClose}>
      <div
        className="w-full max-w-6xl my-4 sm:my-8 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800 rounded-t-xl z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Signal <span className="font-mono text-xs">{signalId.slice(0, 8)}</span>
              </h2>
              <StatusBadge status={pipeline.signalStatus} dot />
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-tight">
              {pipeline.signal?.telegram_channels?.[0]?.display_name ?? 'Unknown channel'}
              {pipeline.signal?.created_at ? ` · ${formatDate(pipeline.signal.created_at)}` : ''}
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

        <div className="px-5 py-4 max-h-[calc(100vh-12rem)] overflow-y-auto">
          <SignalPipelineBody {...pipeline} />
        </div>
      </div>
    </div>
  );
}
