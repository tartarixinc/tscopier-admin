import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import {
  Card, CardHeader, CardContent,
} from '../ui/Card';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { StatusBadge } from '../StatusBadge';
import { DateRangeFilter } from './DateRangeFilter';
import { useCachedQuery } from '../../hooks/useCachedQuery';
import { getAdminEnv } from '../../lib/environment';
import { fetchUserStatistics, type UserStatistics } from '../../lib/userStatistics';
import {
  formatDate, formatDateOnly, formatCurrency, formatNumber, formatPercent, formatLots,
} from '../../lib/formatters';
import { CHART_COLORS, tooltipStyle, gridStyle, axisStyle } from '../../lib/chartTheme';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';

interface UserStatisticsTabProps {
  userId: string;
}

const UNLINKED_CURRENCY = '__none__';
const NO_GROUP = '__none__';

type GroupMode = 'account' | 'channel';
type ChartMode = 'daily' | 'cumulative';

interface ChartGroup {
  key: string;
  label: string;
  daily: Array<{ currency: string | null; points: Array<{ date: string; pnl: number; cumulative: number }> }>;
  closedTrades: number;
}

/** Money never crosses currencies: an unknown currency prints as a plain
 *  number, and a code Intl rejects falls back to a prefixed amount instead of
 *  throwing and blanking the page. */
function money(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null) return '—';
  if (!currency) return formatNumber(value, 2);
  try {
    return formatCurrency(value, currency);
  } catch {
    return `${currency} ${formatNumber(value, 2)}`;
  }
}

function currencyKey(currency: string | null): string {
  return currency ?? UNLINKED_CURRENCY;
}

function shortDate(value: string | null | undefined): string {
  return value ? formatDateOnly(value) : '—';
}

/** Daily buckets are UTC date keys ('YYYY-MM-DD'). Feeding them through
 *  `new Date(value)` would re-render them in local time and disagree with the
 *  axis tick, so build the label from the string itself. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(value: string): string {
  const parts = value.split('-');
  if (parts.length !== 3) return value;
  const monthIndex = Number(parts[1]) - 1;
  const month = MONTHS[monthIndex] ?? parts[1];
  return `${month} ${Number(parts[2])}, ${parts[0]}`;
}

interface StatsControlsProps {
  rangeFrom: string;
  rangeTo: string;
  onChangeFrom: (value: string) => void;
  onChangeTo: (value: string) => void;
  rangeInvalid: boolean;
  env: string;
  loading: boolean;
  refreshing: boolean;
  lastUpdated: number | null;
  onRefresh: () => void;
  rangeLabel: string;
}

/** Kept outside the loading/error branches so the date inputs and the refresh
 *  button stay on screen while data is in flight or has failed to load. */
function StatsControls(props: StatsControlsProps) {
  return (
    <>
      <div className="filter-bar rounded-xl flex-wrap justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <DateRangeFilter
            from={props.rangeFrom}
            to={props.rangeTo}
            onChangeFrom={props.onChangeFrom}
            onChangeTo={props.onChangeTo}
          />
          <span className="text-xs text-slate-400">{props.rangeLabel}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {props.env}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {props.refreshing && (
            <span className="text-xs text-warning-600 dark:text-warning-400">Refreshing…</span>
          )}
          <span className="text-xs text-slate-400">
            {props.lastUpdated ? `Updated ${formatDate(new Date(props.lastUpdated).toISOString())}` : ''}
          </span>
          <Button variant="secondary" size="sm" onClick={props.onRefresh}>
            <RefreshCw className={clsx('w-4 h-4', props.loading && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>
      {props.rangeInvalid && (
        <div className="rounded-xl border border-error-300 dark:border-error-700 bg-error-50 dark:bg-error-900/20 px-4 py-3 text-xs text-error-700 dark:text-error-300">
          The “From” date is after the “To” date, so this range returns nothing. Swap the two dates.
        </div>
      )}
    </>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value mt-1">{value}</p>
      {sub && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

function SectionTitle({ title, note }: { title: string; note?: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {note && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{note}</p>}
    </div>
  );
}

function PnlCell({ entries, currency }: { entries: Array<{ currency: string | null; net: number }>; currency?: string | null }) {
  const rows = currency !== undefined
    ? entries.filter(e => e.currency === currency)
    : entries;
  if (rows.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <span className="space-y-0.5">
      {rows.map(row => (
        <span
          key={row.currency ?? UNLINKED_CURRENCY}
          className={clsx(
            'block text-sm font-medium',
            row.net >= 0 ? 'text-success-600 dark:text-success-400' : 'text-error-600 dark:text-error-400',
          )}
        >
          {money(row.net, row.currency)}
        </span>
      ))}
    </span>
  );
}

function pickDefaultGroup(groups: ChartGroup[]): ChartGroup | null {
  if (groups.length === 0) return null;
  return [...groups].sort((a, b) => b.closedTrades - a.closedTrades)[0];
}

export function UserStatisticsTab({ userId }: UserStatisticsTabProps) {
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [groupMode, setGroupMode] = useState<GroupMode>('account');
  const [groupKey, setGroupKey] = useState<string>(NO_GROUP);
  const [currency, setCurrency] = useState<string>(UNLINKED_CURRENCY);
  const [chartMode, setChartMode] = useState<ChartMode>('daily');

  const cacheKey = `user-stats:${getAdminEnv()}:${userId}:${rangeFrom}:${rangeTo}`;
  const { data, loading, error, refresh, lastUpdated, isRefreshing, beyondMaxStale } =
    useCachedQuery<UserStatistics>(
      cacheKey,
      () => fetchUserStatistics(userId, { from: rangeFrom || null, to: rangeTo || null }),
      { ttlMs: 60_000, maxStaleMs: 10 * 60_000, tags: ['trades', 'signals'] },
    );

  const stats = data;

  const groups: ChartGroup[] = useMemo(() => {
    if (!stats) return [];
    if (groupMode === 'account') {
      return stats.accounts.map(account => ({
        key: account.key,
        label: account.label,
        daily: account.daily,
        closedTrades: account.closedTrades,
      }));
    }
    return stats.channels.map(channel => ({
      key: channel.key,
      label: channel.name,
      daily: channel.daily,
      closedTrades: channel.pnlByCurrency.reduce((sum, p) => sum + p.closedTrades, 0),
    }));
  }, [stats, groupMode]);

  const activeGroup = useMemo(() => {
    const found = groups.find(g => g.key === groupKey);
    return found ?? pickDefaultGroup(groups);
  }, [groups, groupKey]);

  const activeSeries = useMemo(() => {
    if (!activeGroup || activeGroup.daily.length === 0) return null;
    const match = activeGroup.daily.find(s => currencyKey(s.currency) === currency);
    return match ?? activeGroup.daily[0];
  }, [activeGroup, currency]);

  useEffect(() => {
    if (activeSeries && currencyKey(activeSeries.currency) !== currency) {
      setCurrency(currencyKey(activeSeries.currency));
    }
  }, [activeSeries, currency]);

  const chartPoints = useMemo(() => {
    if (!activeSeries) return [];
    return activeSeries.points.map(point => ({
      date: point.date,
      value: chartMode === 'daily' ? point.pnl : point.cumulative,
      pnl: point.pnl,
      cumulative: point.cumulative,
    }));
  }, [activeSeries, chartMode]);

  const rangeInvalid = Boolean(rangeFrom && rangeTo && rangeFrom > rangeTo);
  const controls = (
    <StatsControls
      rangeFrom={rangeFrom}
      rangeTo={rangeTo}
      onChangeFrom={setRangeFrom}
      onChangeTo={setRangeTo}
      rangeInvalid={rangeInvalid}
      env={stats ? stats.env : getAdminEnv()}
      loading={loading}
      refreshing={isRefreshing || beyondMaxStale}
      lastUpdated={lastUpdated}
      onRefresh={refresh}
      rangeLabel={rangeFrom || rangeTo
        ? `Range: ${shortDate(rangeFrom || null)} → ${shortDate(rangeTo || null)}`
        : 'All time'}
    />
  );

  if (!stats) {
    // Keep the date inputs and the refresh button on screen: an admin who
    // typed a range that fails must be able to change it.
    return (
      <div className="space-y-6">
        {controls}
        {error && !loading ? (
          <div className="card p-6 text-sm text-error-600 dark:text-error-400">
            <p>Statistics could not be loaded: {error}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={refresh}>
              <RefreshCw className="w-4 h-4" /> Try again
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="card p-6 skeleton h-28" />)}
          </div>
        )}
      </div>
    );
  }

  const { summary, signals, copierHealth } = stats;
  const executed = signals.byStatus.find(s => s.name === 'executed')?.count ?? 0;
  const skipped = signals.byStatus.find(s => s.name === 'skipped')?.count ?? 0;
  const failedSignals = signals.byStatus.find(s => s.name === 'failed')?.count ?? 0;
  const cappedTrades = stats.caps.trades;
  const idleAccounts = cappedTrades
    ? []
    : stats.accounts.filter(a => stats.idleAccountKeys.includes(a.key));
  const unknownClosed = stats.totalsByCurrency.reduce((sum, p) => sum + p.unknown, 0);
  const openWithProfit = summary.openPnlByCurrency.filter(p => p.net !== null);
  const openPnlText = openWithProfit
    .map(p => `${p.currency ?? 'currency unknown'} ${formatNumber(p.net, 2)}`)
    .join(' · ');
  const openTileSub = summary.openTrades === 0
    ? (cappedTrades
      ? 'none in the newest rows read'
      : summary.pendingTrades > 0
        ? `${summary.pendingTrades} pending, not yet open`
        : 'none open')
    : openWithProfit.length > 0
      ? `floating ${openPnlText}`
      : 'floating profit is not reported for open trades';

  return (
    <div className="space-y-6">
      {controls}

      {stats.errors.length > 0 && (
        <div className="rounded-xl border border-warning-300 dark:border-warning-700 bg-warning-50 dark:bg-warning-900/20 px-4 py-3 text-xs text-warning-700 dark:text-warning-300">
          Some sources could not be read: {stats.errors.join(' · ')}
        </div>
      )}

      {(stats.caps.trades || stats.caps.signals) && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
          Only the newest rows were read so this page stays fast —
          {stats.caps.trades && ' trades: newest 5,000'}
          {stats.caps.signals && ' · signals: newest 5,000'}.
          Counts below are therefore a lower bound, and anything older than that window is missing.
        </div>
      )}

      {/* --- Summary --- */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatTile
          label="Closed trades"
          value={summary.closedTrades.toLocaleString()}
          sub={[
            `${summary.wins}W · ${summary.losses}L · ${summary.flat} flat`,
            summary.unknownProfits > 0 ? `${summary.unknownProfits} without profit` : null,
            summary.cancelledTrades > 0 ? `${summary.cancelledTrades} cancelled` : null,
            summary.pendingTrades > 0 ? `${summary.pendingTrades} pending` : null,
          ].filter(Boolean).join(' · ')}
        />
        <StatTile
          label="Win rate"
          value={summary.winRate == null ? '—' : formatPercent(summary.winRate)}
          sub="wins ÷ closed trades"
        />
        <StatTile
          label="Open trades"
          value={summary.openTrades.toLocaleString()}
          sub={openTileSub}
        />
        <StatTile
          label="Signals received"
          value={signals.total.toLocaleString()}
          sub={signals.firstAt
            ? `${shortDate(signals.firstAt)} → ${shortDate(signals.lastAt)}`
            : 'none in range'}
        />
        <StatTile
          label="Signals executed"
          value={executed.toLocaleString()}
          sub={signals.total > 0 ? `${((executed / signals.total) * 100).toFixed(1)}% of received` : '—'}
        />
        <StatTile
          label="Signals not taken"
          value={(skipped + failedSignals).toLocaleString()}
          sub={`${skipped} skipped · ${failedSignals} failed`}
        />
      </div>

      {/* --- Copied P&L, never mixed across currencies --- */}
      <Card>
        <CardHeader>
          <SectionTitle
            title="Copied P&L by currency"
            note={`Profit and loss recorded by the copier. One row per currency — amounts in different currencies are never added together. Trades are counted by the day they opened and grouped by the day they closed; closed trades span ${shortDate(summary.firstTradeAt)} → ${shortDate(summary.lastTradeAt)}.`}
          />
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Closed</th>
                  <th>Wins</th>
                  <th>Losses</th>
                  <th>Flat</th>
                  <th>No profit recorded</th>
                  <th>Net P&amp;L</th>
                  <th>Best</th>
                  <th>Worst</th>
                </tr>
              </thead>
              <tbody>
                {stats.totalsByCurrency.length === 0 ? (
                  <tr><td colSpan={9} className="text-center py-6 text-slate-400">No closed trades in range</td></tr>
                ) : stats.totalsByCurrency.map(row => (
                  <tr key={currencyKey(row.currency)}>
                    <td className="font-medium">
                      {row.currency ?? (
                        <span className="text-slate-400 font-normal">
                          {row.unlinked ? 'No linked account' : 'Currency unknown'}
                        </span>
                      )}
                    </td>
                    <td>{row.closedTrades}</td>
                    <td className="text-success-600 dark:text-success-400">{row.wins}</td>
                    <td className="text-error-600 dark:text-error-400">{row.losses}</td>
                    <td>{row.flat}</td>
                    <td>{row.unknown}</td>
                    <td><PnlCell entries={[{ currency: row.currency, net: row.net }]} /></td>
                    <td className="text-success-600 dark:text-success-400">{money(row.best, row.currency)}</td>
                    <td className="text-error-600 dark:text-error-400">{money(row.worst, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unknownClosed > 0 && (
            <p className="px-6 py-3 text-xs text-slate-400 border-t border-slate-100 dark:border-slate-800">
              {unknownClosed} closed trade(s) have no recorded profit, so they are counted in Closed but
              not in wins, losses or flat.
            </p>
          )}
        </CardContent>
      </Card>

      {/* --- Daily P&L chart, by account or by channel --- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SectionTitle
              title="Profit and loss over time"
              note="Pick a group to see which account, or which channel, produced the result. The currency selector keeps one money unit on the axis. A trade is counted in the range by the day it opened, and its profit lands on the day it closed."
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select
                label="Group by"
                value={groupMode}
                onChange={e => { setGroupMode(e.target.value as GroupMode); setGroupKey(NO_GROUP); }}
                options={[
                  { value: 'account', label: 'Broker account' },
                  { value: 'channel', label: 'Channel' },
                ]}
                className="w-40"
              />
              <Select
                label={groupMode === 'account' ? 'Account' : 'Channel'}
                value={activeGroup ? activeGroup.key : ''}
                onChange={e => setGroupKey(e.target.value)}
                options={groups.map(g => ({ value: g.key, label: g.label }))}
                placeholder="None"
                className="w-56"
              />
              <Select
                label="Currency"
                value={currencyKey(activeSeries?.currency ?? null)}
                onChange={e => setCurrency(e.target.value)}
                options={(activeGroup?.daily ?? []).map(s => ({
                  value: currencyKey(s.currency),
                  label: s.currency ?? 'Currency unknown',
                }))}
                className="w-44"
              />
              <Select
                label="Show"
                value={chartMode}
                onChange={e => setChartMode(e.target.value as ChartMode)}
                options={[
                  { value: 'daily', label: 'Daily' },
                  { value: 'cumulative', label: 'Cumulative' },
                ]}
                className="w-36"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {chartPoints.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">
              No closed trades for this group in the selected range.
            </p>
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid {...gridStyle} vertical={false} />
                  <XAxis dataKey="date" {...axisStyle} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis {...axisStyle} width={70} tickFormatter={(v: number) => formatNumber(v, 0)} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v, n) => [
                      money(Number(v), activeSeries?.currency ?? null),
                      n === 'value'
                        ? (chartMode === 'daily' ? 'Daily P&L' : 'Cumulative P&L')
                        : String(n ?? ''),
                    ]}
                    labelFormatter={l => dayLabel(String(l))}
                  />
                  <ReferenceLine y={0} stroke="#94a3b8" />
                  <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                    {chartPoints.map(point => (
                      <Cell
                        key={point.date}
                        fill={point.value >= 0 ? CHART_COLORS.success : CHART_COLORS.error}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">
            {activeGroup
              ? `${activeGroup.label} — ${activeGroup.closedTrades} closed trade(s), one series per currency.`
              : 'No groups with trades in range.'}
          </p>
        </CardContent>
      </Card>

      {/* --- Accounts --- */}
      <Card>
        <CardHeader>
          <SectionTitle
            title="Broker accounts"
            note={stats.range.from || stats.range.to
              ? 'Balance figures are lifetime — the broker baseline was captured when the account was first connected, and the balance is the latest sync. Copied P&L and the trade counts below follow the selected date range, so the two columns are not comparable while a range is set.'
              : 'Balance columns come from the broker (baseline captured at first connection → latest sync). Copied P&L comes from the copier\u2019s own trade records. A difference badge means money moved that the copied trades do not explain — for example manual trading on the account, or a broker-side reset.'}
          />
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Balance (baseline → now)</th>
                  <th>Account change</th>
                  <th>Copied P&amp;L</th>
                  <th>Trades</th>
                  <th>Win rate</th>
                  <th>Last trade</th>
                  <th>Channels and risk</th>
                </tr>
              </thead>
              <tbody>
                {stats.accounts.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-6 text-slate-400">
                      {stats.errors.some(e => e.startsWith('broker_accounts'))
                        ? 'Broker accounts could not be read — see the banner above.'
                        : 'No broker accounts'}
                    </td>
                  </tr>
                ) : stats.accounts.map(account => (
                  <tr key={account.key}>
                    <td>
                      <p className="font-medium">{account.label}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {[account.platform, account.accountType].filter(Boolean).join(' · ') || '—'}
                      </p>
                      <StatusBadge status={account.connectionStatus} dot />
                    </td>
                    <td>
                      <span className="text-sm">
                        {money(account.baselineBalance, account.currency)}
                        <span className="text-slate-400"> → </span>
                        {money(account.currentBalance, account.currency)}
                      </span>
                      <p className="text-xs text-slate-400">
                        captured {shortDate(account.baselineCapturedAt)} · synced {shortDate(account.lastSyncedAt)}
                      </p>
                    </td>
                    <td>
                      {account.accountChange == null ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <>
                          <span className={clsx(
                            'block text-sm font-medium',
                            account.accountChange >= 0 ? 'text-success-600 dark:text-success-400' : 'text-error-600 dark:text-error-400',
                          )}>
                            {money(account.accountChange, account.currency)}
                          </span>
                          {account.accountChangePercent != null && (
                            <span className="text-xs text-slate-400">
                              {formatPercent(account.accountChangePercent)}
                            </span>
                          )}
                          {account.unexplained && account.unexplainedDelta != null && (
                            <span
                              className="mt-1 inline-block rounded-full bg-warning-100 px-2 py-0.5 text-[10px] font-semibold text-warning-700 dark:bg-warning-900/40 dark:text-warning-300"
                              title={`Balance moved by ${money(account.accountChange, account.currency)} while copied trades recorded ${money(account.recordedPnl, account.currency)} — a difference of ${money(account.unexplainedDelta, account.currency)} the copier did not account for.`}
                            >
                              Gap not from copied trades
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td><PnlCell entries={account.pnlByCurrency} /></td>
                    <td>
                      <span className="text-sm">{account.closedTrades} closed</span>
                      <p className="text-xs text-slate-400">
                        {account.totalTrades} total · {account.wins}W {account.losses}L {account.flat}F
                        {account.unknownProfits > 0 ? ` ${account.unknownProfits}?` : ''}
                        {account.openTrades > 0 ? ` · ${account.openTrades} open` : ''}
                        {account.pendingTrades > 0 ? ` · ${account.pendingTrades} pending` : ''}
                        {account.cancelledTrades > 0 ? ` · ${account.cancelledTrades} cancelled` : ''}
                      </p>
                    </td>
                    <td>{account.winRate == null ? '—' : formatPercent(account.winRate)}</td>
                    <td className="text-xs text-slate-400">{shortDate(account.lastTradeAt)}</td>
                    <td className="text-xs text-slate-500 dark:text-slate-400">
                      {account.configs.length === 0
                        ? <span className="text-slate-400">No channel linked</span>
                        : account.configs.map(config => (
                          <span key={config.channelId} className="block">
                            {config.channelName}
                            <span className="text-slate-400">
                              {' · '}{[
                                config.riskMode,
                                config.fixedLot != null ? `${formatLots(config.fixedLot)} lots` : null,
                                config.tradeStyle,
                              ].filter(Boolean).join(' · ') || 'no risk settings'}
                            </span>
                          </span>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {idleAccounts.length > 0 && (
        <div className="rounded-xl border border-warning-300 dark:border-warning-700 bg-warning-50 dark:bg-warning-900/20 px-4 py-3 text-xs text-warning-700 dark:text-warning-300">
          <span className="font-semibold">Connected but never traded: </span>
          {idleAccounts.map(a => a.label).join(', ')}
          {stats.range.from || stats.range.to
            ? ' in the selected range.'
            : ' since the account was added. Check whether its channel is linked to a broker account.'}
        </div>
      )}

      {summary.unlinkedTrades > 0 && (
        <div className="rounded-xl border border-warning-300 dark:border-warning-700 bg-warning-50 dark:bg-warning-900/20 px-4 py-3 text-xs text-warning-700 dark:text-warning-300">
          <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
          {summary.unlinkedTrades} trade(s) are recorded without a broker account, so their currency
          cannot be established. They are listed as “No linked broker account”.
        </div>
      )}

      {/* --- Channels --- */}
      <Card>
        <CardHeader>
          <SectionTitle
            title="Channels"
            note="Which signal channels produced profits and which produced losses, with how many signals each one sent and how many became trades. A channel with signals but no trades is usually not linked to a broker account."
          />
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Signals</th>
                  <th>Skipped: no account link</th>
                  <th>Trades</th>
                  <th>Net P&amp;L</th>
                  <th>Win rate</th>
                  <th>Last signal</th>
                  <th>Last trade</th>
                </tr>
              </thead>
              <tbody>
                {stats.channels.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-6 text-slate-400">No channels in range</td></tr>
                ) : stats.channels.map(channel => (
                  <tr key={channel.key}>
                    <td>
                      <p className="font-medium">{channel.name}</p>
                      <p className="text-xs text-slate-400">
                        {channel.linked
                          ? `Linked to ${channel.linkedAccountLabels.join(', ')}`
                          : 'Not linked to any broker account'}
                      </p>
                    </td>
                    <td>
                      <span className="text-sm">{channel.signals}</span>
                      <p className="text-xs text-slate-400">
                        {channel.signalsExecuted} executed · {channel.signalsSkipped} skipped · {channel.signalsFailed} failed
                      </p>
                    </td>
                    <td className={channel.noBrokerMatchSkips > 0 ? 'text-warning-600 dark:text-warning-400 font-medium' : undefined}>
                      {channel.noBrokerMatchSkips > 0 ? channel.noBrokerMatchSkips : '—'}
                    </td>
                    <td>
                      <span className="text-sm">{channel.trades}</span>
                      {(channel.openTrades > 0 || channel.pendingTrades > 0) && (
                        <p className="text-xs text-slate-400">
                          {[
                            channel.openTrades > 0 ? `${channel.openTrades} open` : null,
                            channel.pendingTrades > 0 ? `${channel.pendingTrades} pending` : null,
                          ].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </td>
                    <td><PnlCell entries={channel.pnlByCurrency} /></td>
                    <td>{channel.winRate == null ? '—' : formatPercent(channel.winRate)}</td>
                    <td className="text-xs text-slate-400">{shortDate(channel.lastSignalAt)}</td>
                    <td className="text-xs text-slate-400">{shortDate(channel.lastTradeAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* --- Signal funnel and failures --- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <SectionTitle
              title="Signal outcome"
              note="How many received signals became trades. Signals left in an early state (parsed, pending) after the listener went quiet are worth cross-checking on the Copier Logs page."
            />
          </CardHeader>
          <CardContent className="p-0">
            <table className="table-base">
              <thead>
                <tr><th>Outcome</th><th>Count</th><th>Last seen</th></tr>
              </thead>
              <tbody>
                {signals.byStatus.length === 0 ? (
                  <tr><td colSpan={3} className="text-center py-6 text-slate-400">No signals in range</td></tr>
                ) : signals.byStatus.map(row => (
                  <tr key={row.name}>
                    <td><StatusBadge status={row.name} /></td>
                    <td>{row.count}</td>
                    <td className="text-xs text-slate-400">{shortDate(row.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionTitle title="Why signals were skipped" note="Every skip reason recorded for this user." />
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr><th>Reason</th><th>Count</th><th>Last seen</th></tr>
                </thead>
                <tbody>
                  {signals.bySkipReason.length === 0 ? (
                    <tr><td colSpan={3} className="text-center py-6 text-slate-400">Nothing was skipped</td></tr>
                  ) : signals.bySkipReason.map(row => (
                    <tr key={row.name}>
                      <td className="text-xs font-mono">{row.name}</td>
                      <td className={row.name === 'no_broker_channel_match' && row.count > 0
                        ? 'text-warning-600 dark:text-warning-400 font-medium'
                        : undefined}
                      >
                        {row.count}
                      </td>
                      <td className="text-xs text-slate-400">{shortDate(row.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-6 py-3 text-xs text-slate-400 border-t border-slate-100 dark:border-slate-800">
              Reasons that are only written to the copier logs — for example a listener that was
              briefly offline — are not stored on the signal row and do not appear here. Check the
              Copier Logs tab for those.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <SectionTitle
            title="Execution failures"
            note="Calls that reached the broker or the trade worker and came back with an error. Execution logs are pruned to the newest few hundred rows per user, so failures older than the retention window have already been deleted and cannot be shown here."
          />
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Action</th><th>Error</th><th>Count</th><th>First seen</th><th>Last seen</th></tr>
              </thead>
              <tbody>
                {stats.failures.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-6 text-slate-400">No execution failures in range</td></tr>
                ) : stats.failures.map(row => (
                  <tr key={`${row.action}::${row.message}`}>
                    <td><span className="text-xs font-mono">{row.action}</span></td>
                    <td className="text-xs font-mono text-slate-500 dark:text-slate-400 max-w-md break-words">{row.message}</td>
                    <td className="font-medium">{row.count}</td>
                    <td className="text-xs text-slate-400">{shortDate(row.firstAt)}</td>
                    <td className="text-xs text-slate-400">{shortDate(row.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* --- Copier health --- */}
      <Card>
        <CardHeader>
          <SectionTitle
            title="Copier health"
            note="Reported by the listener worker. This is the direct answer to “is anything copying right now”."
          />
        </CardHeader>
        <CardContent className="p-4">
          {copierHealth.access === 'error' ? (
            <div className="rounded-lg border border-error-300 dark:border-error-700 bg-error-50 dark:bg-error-900/20 px-4 py-3 text-xs text-error-700 dark:text-error-300">
              The health row could not be read: {copierHealth.error ?? 'unknown error'}.
            </div>
          ) : copierHealth.access === 'unknown' ? (
            <div className="rounded-lg border border-warning-300 dark:border-warning-700 bg-warning-50 dark:bg-warning-900/20 px-4 py-3 text-xs text-warning-700 dark:text-warning-300">
              This database does not prove whether health rows can be read. Either the admin read
              policy on <span className="font-mono">copier_listener_health</span> has not been
              applied here, or the table holds no rows at all. Nothing is shown rather than
              reporting a status that has not been observed. Check the Listener Events and Worker
              Leases pages instead, and apply
              <span className="font-mono"> 20261018120000_admin_read_copier_listener_health </span>
              to this database to fill this card in.
            </div>
          ) : copierHealth.row == null ? (
            <p className="text-sm text-slate-400">
              Read access is confirmed, and this user has no copier health row — their listener has
              never reported.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatTile
                  label="Listener"
                  value={copierHealth.row.listener_status ?? 'unknown'}
                  sub={copierHealth.row.health_reason ?? undefined}
                />
                <StatTile
                  label="Copier engine"
                  value={copierHealth.row.copier_engine_status ?? 'unknown'}
                  sub={copierHealth.row.worker_ownership_status ?? undefined}
                />
                <StatTile
                  label="MTProto"
                  value={copierHealth.row.mtproto_connected == null
                    ? 'unknown'
                    : copierHealth.row.mtproto_connected ? 'connected' : 'not connected'}
                  sub={copierHealth.row.telegram_account_status ?? undefined}
                />
                <StatTile
                  label="Reported at"
                  value={formatDate(copierHealth.row.updated_at)}
                  sub={copierHealth.row.last_connected_at
                    ? `last connected ${formatDate(copierHealth.row.last_connected_at)}`
                    : 'never connected'}
                />
              </div>
              {copierHealth.row.recovery_exhausted && (
                <p className="mt-3 text-xs text-error-600 dark:text-error-400">
                  Reconnect attempts are exhausted — this account will not come back on its own.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
