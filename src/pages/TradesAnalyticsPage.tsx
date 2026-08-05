import { useState } from 'react';
import { PnlAnalyticsTab } from '../components/PnlAnalyticsTab';
import { LatencyAnalyticsTab } from '../components/LatencyAnalyticsTab';
import clsx from 'clsx';

type Tab = 'pnl' | 'latency';

const RANGE_OPTIONS: { label: string; days: number | null }[] = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '1y', days: 365 },
  { label: 'All', days: null },
];

export function TradesAnalyticsPage() {
  const [tab, setTab] = useState<Tab>('pnl');
  const [rangeDays, setRangeDays] = useState<number | null>(30);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Trade Analytics</h1>
        <p className="page-subtitle">Historical trade metrics — P&L and pipeline latency across live, closed, and past trades</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 text-sm font-medium">
          {([
            { key: 'pnl', label: 'P&L' },
            { key: 'latency', label: 'Latency' },
          ] as { key: Tab; label: string }[]).map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={clsx(
                'px-4 py-1.5 rounded-md transition-colors',
                tab === t.key
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 text-sm font-medium">
          {RANGE_OPTIONS.map(opt => (
            <button
              key={opt.label}
              type="button"
              onClick={() => setRangeDays(opt.days)}
              className={clsx(
                'px-3 py-1.5 rounded-md transition-colors text-xs',
                rangeDays === opt.days
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'latency' ? (
        <LatencyAnalyticsTab rangeDays={rangeDays} />
      ) : (
        <PnlAnalyticsTab rangeDays={rangeDays} />
      )}
    </div>
  );
}
