import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, subtitle, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={onClose} />
      <div className={clsx(
        'relative w-full sm:max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[92vh] flex flex-col animate-fade-in',
        className,
      )}>
        {(title || subtitle) && (
          <div className="px-5 pt-5 pb-4 border-b border-slate-200 dark:border-slate-700">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {title && <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">{title}</h2>}
                {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{subtitle}</p>}
              </div>
              <button
                onClick={onClose}
                className="shrink-0 p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}
