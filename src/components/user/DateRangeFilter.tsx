interface DateRangeFilterProps {
  from: string;
  to: string;
  onChangeFrom: (value: string) => void;
  onChangeTo: (value: string) => void;
}

export function DateRangeFilter({ from, to, onChangeFrom, onChangeTo }: DateRangeFilterProps) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-500">From</label>
      <input type="date" value={from} onChange={e => onChangeFrom(e.target.value)} className="input-base py-1.5 text-xs w-36" />
      <label className="text-xs text-slate-500">To</label>
      <input type="date" value={to} onChange={e => onChangeTo(e.target.value)} className="input-base py-1.5 text-xs w-36" />
    </div>
  );
}