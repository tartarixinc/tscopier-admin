import React, { useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import clsx from 'clsx';

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  className?: string;
  headerClassName?: string;
  render?: (row: T) => React.ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  skeletonRows?: number;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: string, dir: 'asc' | 'desc') => void;
  expandedRowKey?: string | null;
  expandedContent?: (row: T) => React.ReactNode;
}

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="skeleton h-4 w-full" />
        </td>
      ))}
    </tr>
  );
}

export function DataTable<T>({
  columns,
  data,
  loading,
  rowKey,
  onRowClick,
  emptyMessage = 'No data found',
  skeletonRows = 8,
  sortKey,
  sortDir,
  onSort,
  expandedRowKey,
  expandedContent,
}: DataTableProps<T>) {
  const [localSort, setLocalSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  const effectiveSortKey = sortKey ?? localSort?.key;
  const effectiveSortDir = sortDir ?? localSort?.dir;

  function handleSort(key: string) {
    const newDir = effectiveSortKey === key && effectiveSortDir === 'asc' ? 'desc' : 'asc';
    if (onSort) {
      onSort(key, newDir);
    } else {
      setLocalSort({ key, dir: newDir });
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} className={col.headerClassName}>
                {col.sortable ? (
                  <button
                    onClick={() => handleSort(col.key)}
                    className="flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                  >
                    {col.label}
                    {effectiveSortKey === col.key ? (
                      effectiveSortDir === 'asc'
                        ? <ChevronUp className="w-3 h-3" />
                        : <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronsUpDown className="w-3 h-3 opacity-40" />
                    )}
                  </button>
                ) : col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: skeletonRows }).map((_, i) => (
              <SkeletonRow key={i} cols={columns.length} />
            ))
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="text-center py-16 text-slate-400">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map(row => {
              const key = rowKey(row);
              const isExpanded = expandedRowKey === key;
              return (
                <React.Fragment key={key}>
                  <tr
                    onClick={() => onRowClick?.(row)}
                    className={clsx(onRowClick && 'cursor-pointer')}
                  >
                    {columns.map(col => (
                      <td key={col.key} className={col.className}>
                        {col.render ? col.render(row) : (() => { const v = (row as Record<string, unknown>)[col.key]; return v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v); })()}
                      </td>
                    ))}
                  </tr>
                  {isExpanded && expandedContent && (
                    <tr>
                      <td colSpan={columns.length} className="bg-slate-50 dark:bg-slate-900/60 px-4 py-4">
                        {expandedContent(row)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange?: (s: number) => void;
}

export function Pagination({ page, totalPages, totalCount, pageSize, onPageChange, onPageSizeChange }: PaginationProps) {
  const start = Math.min((page - 1) * pageSize + 1, totalCount);
  const end = Math.min(page * pageSize, totalCount);

  const pages: (number | '...')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push('...');
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
    if (page < totalPages - 2) pages.push('...');
    pages.push(totalPages);
  }

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
        <span>{totalCount === 0 ? '0' : `${start}–${end}`} of {totalCount.toLocaleString()}</span>
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value))}
            className="input-base py-1 w-auto text-xs"
          >
            {[25, 50, 100, 200].map(s => <option key={s} value={s}>{s} / page</option>)}
          </select>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="btn btn-ghost btn-sm disabled:opacity-30"
        >
          ‹
        </button>
        {pages.map((p, i) =>
          p === '...'
            ? <span key={`ellipsis-${i}`} className="px-2 text-slate-400 hidden sm:inline">…</span>
            : <button
                key={p}
                onClick={() => onPageChange(p as number)}
                className={clsx(
                  'btn btn-sm min-w-[32px]',
                  p === page
                    ? 'btn-primary'
                    : 'btn-ghost hidden sm:inline-flex',
                  p === page && 'inline-flex'
                )}
              >
                {p}
              </button>
        )}
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="btn btn-ghost btn-sm disabled:opacity-30"
        >
          ›
        </button>
      </div>
    </div>
  );
}
