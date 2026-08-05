import clsx from 'clsx';

export interface TabItem<T extends string = string> {
  value: T;
  label: string;
  count?: number;
  icon?: React.ReactNode;
}

interface TabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  tabs: TabItem<T>[];
  className?: string;
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: TabsProps<T>) {
  return (
    <div className={clsx('flex items-center gap-1 border-b border-slate-200 dark:border-slate-700 overflow-x-auto', className)}>
      {tabs.map(tab => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={clsx(
            'flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px',
            value === tab.value
              ? 'border-primary-500 text-primary-700 dark:text-primary-400'
              : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50'
          )}
        >
          {tab.icon}
          {tab.label}
          {tab.count != null && (
            <span className={clsx(
              'text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
              value === tab.value ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400' : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
            )}>
              {tab.count.toLocaleString()}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}