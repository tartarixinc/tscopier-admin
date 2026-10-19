/*
 * Per-user statistics: fetch + compute.
 *
 * The statistics page answers one operator question — "is this user's copier
 * earning or losing money, and if so why?" — so it reports four separate
 * things and never blends them:
 *   1. what happened on the broker account (balance since baseline),
 *   2. what the copier recorded (trades rows),
 *   3. which channel produced each result,
 *   4. which signals never became a trade, and why.
 *
 * Money is never summed across currencies: every group (account, channel,
 * total) keeps one row per currency, because broker accounts hold different
 * currencies and demo accounts are denominated in them too.
 */

import { authSupabase as adminSupabase } from './adminSupabase';
import { getAdminEnv } from './environment';

export interface StatsRange {
  /** YYYY-MM-DD, inclusive start of day. Null = no lower bound. */
  from: string | null;
  /** YYYY-MM-DD, inclusive end of day. Null = no upper bound. */
  to: string | null;
}

export interface BrokerAccountRow {
  id: string;
  label: string;
  platform: string | null;
  connection_status: string | null;
  linked_account_type: string | null;
  provider: string | null;
  mtapi_status: string | null;
  last_balance: number | null;
  last_equity: number | null;
  last_currency: string | null;
  performance_baseline_balance: number | null;
  performance_baseline_captured_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  channel_trading_configs: unknown;
}

export interface TradeRow {
  id: string;
  broker_account_id: string | null;
  telegram_channel_id: string | null;
  signal_id: string | null;
  symbol: string | null;
  direction: string | null;
  lot_size: number | null;
  status: string | null;
  profit: number | null;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface SignalRow {
  id: string;
  channel_id: string | null;
  status: string;
  skip_reason: string | null;
  created_at: string;
}

export interface ExecutionLogRow {
  id: string;
  action: string | null;
  status: string | null;
  error_message: string | null;
  signal_id: string | null;
  broker_account_id: string | null;
  created_at: string;
}

export interface ListenerHealthRow {
  listener_status: string | null;
  copier_engine_status: string | null;
  worker_ownership_status: string | null;
  telegram_account_status: string | null;
  mtproto_connected: boolean | null;
  health_reason: string | null;
  last_connected_at: string | null;
  consecutive_probe_failures: number | null;
  recovery_exhausted: boolean | null;
  updated_at: string;
}

export interface ChannelConfigSummary {
  channelId: string;
  channelName: string;
  copierMode: string | null;
  riskMode: string | null;
  fixedLot: number | null;
  tradeStyle: string | null;
}

export interface DailyPoint {
  date: string;
  pnl: number;
  cumulative: number;
}

/** One currency's daily profit and loss, in ascending date order. */
export interface DailySeries {
  currency: string | null;
  points: DailyPoint[];
}

/** Floating profit on open trades, one row per currency. `net` is null when no
 *  open trade in that currency reports a profit — the copier only writes
 *  `profit` when a trade closes, so a null must not be printed as `0.00`. */
export interface OpenPnl {
  currency: string | null;
  openTrades: number;
  net: number | null;
}

/** Profit totals for one group, in one currency.
 *  `currency: null` = no currency could be established.
 *  `unlinked` tells the two null cases apart: `true` when the trade has no
 *  broker account at all, `false` when the account exists but reports no
 *  currency. `unknown` counts closed trades whose profit was never recorded,
 *  so Wins + Losses + Flat + Unknown always equals Closed. */
export interface CurrencyPnl {
  currency: string | null;
  unlinked: boolean;
  closedTrades: number;
  net: number;
  wins: number;
  losses: number;
  flat: number;
  unknown: number;
  best: number | null;
  worst: number | null;
}

export interface AccountStats {
  /** Broker account id, or the pseudo key `UNLINKED` for trades with no account. */
  key: string;
  label: string;
  platform: string | null;
  accountType: string | null;
  connectionStatus: string | null;
  provider: string | null;
  createdAt: string | null;
  currency: string | null;
  baselineBalance: number | null;
  baselineCapturedAt: string | null;
  currentBalance: number | null;
  currentEquity: number | null;
  lastSyncedAt: string | null;
  accountChange: number | null;
  accountChangePercent: number | null;
  recordedPnl: number | null;
  unexplainedDelta: number | null;
  unexplained: boolean;
  /** True when a date range is set: balance figures are lifetime, trade figures
   *  are not, so the two must not be compared. */
  rangeActive: boolean;
  totalTrades: number;
  openTrades: number;
  pendingTrades: number;
  closedTrades: number;
  cancelledTrades: number;
  wins: number;
  losses: number;
  flat: number;
  unknownProfits: number;
  winRate: number | null;
  pnlByCurrency: CurrencyPnl[];
  daily: DailySeries[];
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  configs: ChannelConfigSummary[];
}

export interface ChannelStats {
  /** Telegram channel id, or the pseudo key `UNLINKED` for rows with no channel. */
  key: string;
  channelId: string | null;
  name: string;
  linked: boolean;
  linkedAccountLabels: string[];
  signals: number;
  signalsExecuted: number;
  signalsSkipped: number;
  signalsFailed: number;
  noBrokerMatchSkips: number;
  trades: number;
  openTrades: number;
  pendingTrades: number;
  pnlByCurrency: CurrencyPnl[];
  daily: DailySeries[];
  winRate: number | null;
  firstSignalAt: string | null;
  lastSignalAt: string | null;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
}

export interface NamedCount {
  name: string;
  count: number;
  lastAt: string | null;
}

export interface FailureRow {
  action: string;
  message: string;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
}

export type HealthAccess =
  /** Other users' health rows are visible — the admin read policy is in force. */
  | 'readable'
  /** The query itself failed. */
  | 'error'
  /** Cannot be determined: nothing visible proves either way — typically the
   *  admin read policy is missing, or the table has no rows at all. Never
   *  render a definite cause from this state. */
  | 'unknown';

export interface CopierHealthView {
  access: HealthAccess;
  row: ListenerHealthRow | null;
  error: string | null;
}

export interface UserStatistics {
  fetchedAt: string;
  env: string;
  range: StatsRange;
  accounts: AccountStats[];
  channels: ChannelStats[];
  /** Account keys that produced no trades in range. */
  idleAccountKeys: string[];
  totalsByCurrency: CurrencyPnl[];
  summary: {
    totalTrades: number;
    closedTrades: number;
    openTrades: number;
    pendingTrades: number;
    cancelledTrades: number;
    wins: number;
    losses: number;
    flat: number;
    unknownProfits: number;
    winRate: number | null;
    openPnlByCurrency: OpenPnl[];
    firstTradeAt: string | null;
    lastTradeAt: string | null;
    unlinkedTrades: number;
  };
  signals: {
    total: number;
    byStatus: NamedCount[];
    bySkipReason: NamedCount[];
    firstAt: string | null;
    lastAt: string | null;
  };
  failures: FailureRow[];
  copierHealth: CopierHealthView;
  caps: { trades: boolean; signals: boolean; logs: boolean };
  errors: string[];
}

const PAGE_SIZE = 1000;
const TRADE_CAP = 5000;
const SIGNAL_CAP = 5000;
const LOG_CAP = 3000;
const UNLINKED = 'UNLINKED';

interface PagedResult {
  rows: Array<Record<string, unknown>>;
  capped: boolean;
}

interface QueryLike {
  range: (from: number, to: number) => PromiseLike<{
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  }>;
}

/** Reads rows in pages until `cap` is reached, so a heavy user cannot pull an
 *  unbounded result set into the browser. `capped` tells the UI to say the
 *  numbers are a lower bound. */
async function fetchPaged(
  makeQuery: () => QueryLike,
  cap: number,
): Promise<PagedResult> {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 0; page < Math.ceil(cap / PAGE_SIZE); page += 1) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await makeQuery().range(from, to);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) return { rows, capped: false };
    if (rows.length >= cap) return { rows, capped: true };
  }
  return { rows, capped: true };
}

function rangeFromIso(range: StatsRange): string | null {
  return range.from ? `${range.from}T00:00:00Z` : null;
}

function rangeToIso(range: StatsRange): string | null {
  return range.to ? `${range.to}T23:59:59Z` : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function dateMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function earliest(a: string | null, b: string | null): string | null {
  const av = dateMs(a);
  const bv = dateMs(b);
  if (!Number.isFinite(av)) return b;
  if (!Number.isFinite(bv)) return a;
  return av <= bv ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  const av = dateMs(a);
  const bv = dateMs(b);
  if (!Number.isFinite(av)) return b;
  if (!Number.isFinite(bv)) return a;
  return av >= bv ? a : b;
}

function dayKey(value: string | null): string | null {
  const ms = dateMs(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Win rate over every closed trade. A closed trade whose profit was never
 *  recorded counts against the rate (it is not a win) but is reported
 *  separately as `unknown`, so Wins + Losses + Flat + Unknown = Closed. */
export function winRateOf(wins: number, losses: number, flat: number, unknown = 0): number | null {
  const decided = wins + losses + flat + unknown;
  if (decided === 0) return null;
  return (wins / decided) * 100;
}

export interface ClosedTally {
  wins: number;
  losses: number;
  flat: number;
  unknown: number;
}

export function classifyClosed(rows: TradeRow[]): ClosedTally {
  const tally: ClosedTally = { wins: 0, losses: 0, flat: 0, unknown: 0 };
  for (const row of rows) {
    const profit = num(row.profit);
    if (profit === null) tally.unknown += 1;
    else if (profit > 0) tally.wins += 1;
    else if (profit < 0) tally.losses += 1;
    else tally.flat += 1;
  }
  return tally;
}

function currencyMapOf(accounts: BrokerAccountRow[]): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const account of accounts) map[account.id] = account.last_currency ?? null;
  return map;
}

export function summarizeByCurrency(
  rows: TradeRow[],
  currencyOf: Record<string, string | null>,
): CurrencyPnl[] {
  const buckets = new Map<string, CurrencyPnl>();
  for (const row of rows) {
    if (row.status !== 'closed') continue;
    const currency = row.broker_account_id
      ? (currencyOf[row.broker_account_id] ?? null)
      : null;
    const key = `${row.broker_account_id ? 'linked' : 'unlinked'}:${currency ?? ''}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        currency,
        unlinked: !row.broker_account_id,
        closedTrades: 0,
        net: 0,
        wins: 0,
        losses: 0,
        flat: 0,
        unknown: 0,
        best: null,
        worst: null,
      };
      buckets.set(key, bucket);
    }
    bucket.closedTrades += 1;
    const profit = num(row.profit);
    if (profit === null) {
      bucket.unknown += 1;
      continue;
    }
    bucket.net += profit;
    if (profit > 0) bucket.wins += 1;
    else if (profit < 0) bucket.losses += 1;
    else bucket.flat += 1;
    bucket.best = bucket.best === null ? profit : Math.max(bucket.best, profit);
    bucket.worst = bucket.worst === null ? profit : Math.min(bucket.worst, profit);
  }
  return [...buckets.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

/** Floating profit on open trades, one row per currency. */
export function summarizeOpenByCurrency(
  rows: TradeRow[],
  currencyOf: Record<string, string | null>,
): OpenPnl[] {
  type Bucket = { currency: string | null; openTrades: number; net: number; reported: number };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const currency = row.broker_account_id
      ? (currencyOf[row.broker_account_id] ?? null)
      : null;
    const key = `${row.broker_account_id ? 'linked' : 'unlinked'}:${currency ?? ''}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { currency, openTrades: 0, net: 0, reported: 0 };
      buckets.set(key, bucket);
    }
    bucket.openTrades += 1;
    const profit = num(row.profit);
    if (profit !== null) {
      bucket.net += profit;
      bucket.reported += 1;
    }
  }
  return [...buckets.values()].map(({ reported, ...bucket }) => ({
    ...bucket,
    net: reported > 0 ? bucket.net : null,
  }));
}

/** Daily net P&L for one group in one currency. `UNLINKED` currency (`null`)
 *  is accepted too: it is plotted without a currency label. */
export function dailyPnl(
  rows: TradeRow[],
  currencyOf: Record<string, string | null>,
  currency: string | null,
): DailyPoint[] {
  const days = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== 'closed') continue;
    const rowCurrency = row.broker_account_id
      ? (currencyOf[row.broker_account_id] ?? null)
      : null;
    if (rowCurrency !== currency) continue;
    const key = dayKey(row.closed_at) ?? dayKey(row.opened_at);
    if (!key) continue;
    days.set(key, (days.get(key) ?? 0) + (num(row.profit) ?? 0));
  }
  let running = 0;
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, pnl]) => {
      running += pnl;
      return { date, pnl, cumulative: running };
    });
}

/** One daily series per currency present in the group. */
function dailySeriesFor(
  rows: TradeRow[],
  currencyOf: Record<string, string | null>,
): DailySeries[] {
  return summarizeByCurrency(rows, currencyOf).map(pnl => ({
    currency: pnl.currency,
    points: dailyPnl(rows, currencyOf, pnl.currency),
  }));
}

function parseChannelConfigs(
  raw: unknown,
  channelNames: Record<string, string>,
): ChannelConfigSummary[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).map(([channelId, value]) => {
    const cfg = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const manual = cfg.manual_settings && typeof cfg.manual_settings === 'object'
      && !Array.isArray(cfg.manual_settings)
      ? cfg.manual_settings as Record<string, unknown>
      : {};
    return {
      channelId,
      channelName: channelNames[channelId] ?? channelId.slice(0, 8),
      copierMode: text(cfg.copier_mode),
      riskMode: text(manual.risk_mode),
      fixedLot: num(manual.fixed_lot),
      tradeStyle: text(manual.trade_style),
    };
  });
}

function groupTrades(
  rows: TradeRow[],
  keyOf: (row: TradeRow) => string,
): Map<string, TradeRow[]> {
  const groups = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function tradeDates(rows: TradeRow[]): { first: string | null; last: string | null } {
  let first: string | null = null;
  let last: string | null = null;
  for (const row of rows) {
    first = earliest(first, row.opened_at ?? row.created_at);
    last = latest(last, row.closed_at ?? row.opened_at ?? row.created_at);
  }
  return { first, last };
}

export interface ComputeInput {
  range: StatsRange;
  env: string;
  accounts: BrokerAccountRow[];
  trades: TradeRow[];
  signals: SignalRow[];
  logs: ExecutionLogRow[];
  health: CopierHealthView;
  channelNames: Record<string, string>;
  caps: { trades: boolean; signals: boolean; logs: boolean };
  errors: string[];
}

export function computeUserStatistics(input: ComputeInput): UserStatistics {
  const { accounts, trades, signals, logs, range } = input;
  const currencyOf = currencyMapOf(accounts);
  const rangeActive = Boolean(range.from || range.to);

  const linkedChannelIds = new Set<string>();
  const configsByAccount = new Map<string, ChannelConfigSummary[]>();
  for (const account of accounts) {
    const configs = parseChannelConfigs(account.channel_trading_configs, input.channelNames);
    configsByAccount.set(account.id, configs);
    for (const config of configs) linkedChannelIds.add(config.channelId);
  }

  const accountGroups = groupTrades(trades, row => row.broker_account_id ?? UNLINKED);
  const channelGroups = groupTrades(trades, row => row.telegram_channel_id ?? UNLINKED);

  const accountStats: AccountStats[] = accounts.map(account => {
    const rows = accountGroups.get(account.id) ?? [];
    const closed = rows.filter(r => r.status === 'closed');
    const pnl = summarizeByCurrency(rows, currencyOf);
    const recordedPnl = closed.length > 0 ? pnl.reduce((sum, p) => sum + p.net, 0) : null;
    const baseline = num(account.performance_baseline_balance);
    const current = num(account.last_balance);
    const change = baseline !== null && current !== null ? current - baseline : null;
    const changePct = change !== null && baseline !== null && baseline !== 0
      ? (change / baseline) * 100
      : null;
    // Balance change is lifetime (baseline snapshot → now) while the copied
    // trades follow the selected date range, so the comparison — and the
    // "unexplained" flag — is only meaningful when no range is set.
    const delta = change !== null && recordedPnl !== null && !rangeActive
      ? change - recordedPnl
      : null;
    const threshold = baseline !== null ? Math.abs(baseline) * 0.01 : null;
    const dates = tradeDates(rows);
    const tally = classifyClosed(closed);
    const pending = rows.filter(r => r.status === 'pending').length;
    return {
      key: account.id,
      label: account.label,
      platform: account.platform,
      accountType: account.linked_account_type,
      connectionStatus: account.connection_status,
      provider: account.provider,
      createdAt: account.created_at,
      currency: account.last_currency ?? null,
      baselineBalance: baseline,
      baselineCapturedAt: account.performance_baseline_captured_at,
      currentBalance: current,
      currentEquity: num(account.last_equity),
      lastSyncedAt: account.last_synced_at,
      accountChange: change,
      accountChangePercent: changePct,
      recordedPnl,
      unexplainedDelta: delta,
      unexplained: delta !== null && threshold !== null && Math.abs(delta) > threshold,
      rangeActive,
      totalTrades: rows.length,
      openTrades: rows.filter(r => r.status === 'open').length,
      pendingTrades: pending,
      closedTrades: closed.length,
      cancelledTrades: rows.filter(r => r.status === 'cancelled').length,
      wins: tally.wins,
      losses: tally.losses,
      flat: tally.flat,
      unknownProfits: tally.unknown,
      winRate: winRateOf(tally.wins, tally.losses, tally.flat, tally.unknown),
      pnlByCurrency: pnl,
      daily: dailySeriesFor(rows, currencyOf),
      firstTradeAt: dates.first,
      lastTradeAt: dates.last,
      configs: configsByAccount.get(account.id) ?? [],
    };
  });

  const orphanRows = accountGroups.get(UNLINKED) ?? [];
  if (orphanRows.length > 0) {
    const closed = orphanRows.filter(r => r.status === 'closed');
    const tally = classifyClosed(closed);
    const dates = tradeDates(orphanRows);
    accountStats.push({
      key: UNLINKED,
      label: 'No linked broker account',
      platform: null,
      accountType: null,
      connectionStatus: null,
      provider: null,
      createdAt: null,
      currency: null,
      baselineBalance: null,
      baselineCapturedAt: null,
      currentBalance: null,
      currentEquity: null,
      lastSyncedAt: null,
      accountChange: null,
      accountChangePercent: null,
      recordedPnl: closed.length > 0
        ? summarizeByCurrency(orphanRows, currencyOf).reduce((s, p) => s + p.net, 0)
        : null,
      unexplainedDelta: null,
      unexplained: false,
      rangeActive,
      totalTrades: orphanRows.length,
      openTrades: orphanRows.filter(r => r.status === 'open').length,
      pendingTrades: orphanRows.filter(r => r.status === 'pending').length,
      closedTrades: closed.length,
      cancelledTrades: orphanRows.filter(r => r.status === 'cancelled').length,
      wins: tally.wins,
      losses: tally.losses,
      flat: tally.flat,
      unknownProfits: tally.unknown,
      winRate: winRateOf(tally.wins, tally.losses, tally.flat, tally.unknown),
      pnlByCurrency: summarizeByCurrency(orphanRows, currencyOf),
      daily: dailySeriesFor(orphanRows, currencyOf),
      firstTradeAt: dates.first,
      lastTradeAt: dates.last,
      configs: [],
    });
  }

  // --- Channels: signals and trades, per channel, per currency.
  const signalGroups = groupSignals(signals);
  const signalChannels = [...signalGroups.keys()];
  const tradeChannels = [...channelGroups.keys()];
  const allChannelKeys = new Set([...signalChannels, ...tradeChannels]);
  const channelStats: ChannelStats[] = [];

  for (const key of allChannelKeys) {
    const channelId = key === UNLINKED ? null : key;
    const tradeRows = channelGroups.get(key) ?? [];
    const signalRows = signalGroups.get(key) ?? [];
    const closed = tradeRows.filter(r => r.status === 'closed');
    const pnl = summarizeByCurrency(tradeRows, currencyOf);
    const tally = classifyClosed(closed);
    const tradeDatesForChannel = tradeDates(tradeRows);
    const linkedAccountLabels = channelId
      ? accounts
        .filter(a => (configsByAccount.get(a.id) ?? []).some(c => c.channelId === channelId))
        .map(a => a.label)
      : [];

    channelStats.push({
      key,
      channelId,
      name: channelId ? (input.channelNames[channelId] ?? 'Unnamed channel') : 'No channel',
      linked: linkedAccountLabels.length > 0,
      linkedAccountLabels,
      signals: signalRows.length,
      signalsExecuted: signalRows.filter(s => s.status === 'executed').length,
      signalsSkipped: signalRows.filter(s => s.status === 'skipped').length,
      signalsFailed: signalRows.filter(s => s.status === 'failed').length,
      noBrokerMatchSkips: signalRows.filter(s => s.skip_reason === 'no_broker_channel_match').length,
      trades: tradeRows.length,
      openTrades: tradeRows.filter(r => r.status === 'open').length,
      pendingTrades: tradeRows.filter(r => r.status === 'pending').length,
      pnlByCurrency: pnl,
      daily: dailySeriesFor(tradeRows, currencyOf),
      winRate: winRateOf(tally.wins, tally.losses, tally.flat, tally.unknown),
      firstSignalAt: signalRows.reduce<string | null>((acc, s) => earliest(acc, s.created_at), null),
      lastSignalAt: signalRows.reduce<string | null>((acc, s) => latest(acc, s.created_at), null),
      firstTradeAt: tradeDatesForChannel.first,
      lastTradeAt: tradeDatesForChannel.last,
    });
  }

  channelStats.sort((a, b) => {
    const aPnl = a.pnlByCurrency.reduce((s, p) => s + Math.abs(p.net), 0);
    const bPnl = b.pnlByCurrency.reduce((s, p) => s + Math.abs(p.net), 0);
    if (aPnl !== bPnl) return bPnl - aPnl;
    if (a.trades !== b.trades) return b.trades - a.trades;
    return b.signals - a.signals;
  });

  // --- Signal funnel.
  const statusCounts = new Map<string, NamedCount>();
  const skipCounts = new Map<string, NamedCount>();
  let signalsFirst: string | null = null;
  let signalsLast: string | null = null;
  for (const signal of signals) {
    const status = signal.status || 'unknown';
    const existing = statusCounts.get(status);
    if (existing) {
      existing.count += 1;
      existing.lastAt = latest(existing.lastAt, signal.created_at);
    } else {
      statusCounts.set(status, { name: status, count: 1, lastAt: signal.created_at });
    }
    if (signal.skip_reason) {
      const reason = signal.skip_reason;
      const skip = skipCounts.get(reason);
      if (skip) {
        skip.count += 1;
        skip.lastAt = latest(skip.lastAt, signal.created_at);
      } else {
        skipCounts.set(reason, { name: reason, count: 1, lastAt: signal.created_at });
      }
    }
    signalsFirst = earliest(signalsFirst, signal.created_at);
    signalsLast = latest(signalsLast, signal.created_at);
  }

  // --- Execution failures.
  const failureMap = new Map<string, FailureRow>();
  for (const log of logs) {
    if (log.status !== 'failed') continue;
    const action = log.action ?? 'unknown';
    const message = log.error_message ?? 'no message recorded';
    const key = `${action}::${message}`;
    const existing = failureMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.firstAt = earliest(existing.firstAt, log.created_at);
      existing.lastAt = latest(existing.lastAt, log.created_at);
    } else {
      failureMap.set(key, { action, message, count: 1, firstAt: log.created_at, lastAt: log.created_at });
    }
  }
  const failures = [...failureMap.values()].sort((a, b) => b.count - a.count);

  // --- Totals.
  const closedAll = trades.filter(r => r.status === 'closed');
  const tallyAll = classifyClosed(closedAll);
  const overallDates = tradeDates(trades);

  const idleAccountKeys = accountStats
    .filter(a => a.key !== UNLINKED && a.totalTrades === 0)
    .map(a => a.key);

  return {
    fetchedAt: new Date().toISOString(),
    env: input.env,
    range,
    accounts: accountStats,
    channels: channelStats,
    idleAccountKeys,
    totalsByCurrency: summarizeByCurrency(trades, currencyOf),
    summary: {
      totalTrades: trades.length,
      closedTrades: closedAll.length,
      openTrades: trades.filter(r => r.status === 'open').length,
      pendingTrades: trades.filter(r => r.status === 'pending').length,
      cancelledTrades: trades.filter(r => r.status === 'cancelled').length,
      wins: tallyAll.wins,
      losses: tallyAll.losses,
      flat: tallyAll.flat,
      unknownProfits: tallyAll.unknown,
      winRate: winRateOf(tallyAll.wins, tallyAll.losses, tallyAll.flat, tallyAll.unknown),
      openPnlByCurrency: summarizeOpenByCurrency(
        trades.filter(r => r.status === 'open'),
        currencyOf,
      ),
      firstTradeAt: overallDates.first,
      lastTradeAt: overallDates.last,
      unlinkedTrades: orphanRows.length,
    },
    signals: {
      total: signals.length,
      byStatus: [...statusCounts.values()].sort((a, b) => b.count - a.count),
      bySkipReason: [...skipCounts.values()].sort((a, b) => b.count - a.count),
      firstAt: signalsFirst,
      lastAt: signalsLast,
    },
    failures,
    copierHealth: input.health,
    caps: input.caps,
    errors: input.errors,
  };
}

function groupSignals(rows: SignalRow[]): Map<string, SignalRow[]> {
  const groups = new Map<string, SignalRow[]>();
  for (const row of rows) {
    const key = row.channel_id ?? UNLINKED;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** Reads everything the statistics page shows for one user. */
export async function fetchUserStatistics(
  userId: string,
  range: StatsRange,
): Promise<UserStatistics> {
  const errors: string[] = [];
  const fromIso = rangeFromIso(range);
  const toIso = rangeToIso(range);

  const [accountsRes, tradesRes, signalsRes, logsRes, healthProbe, healthRowRes] = await Promise.all([
    adminSupabase
      .from('broker_accounts')
      .select('id, label, platform, connection_status, linked_account_type, provider, last_balance, last_equity, last_currency, performance_baseline_balance, performance_baseline_captured_at, last_synced_at, created_at, channel_trading_configs')
      .eq('user_id', userId)
      .order('created_at', { ascending: true }),
    // Newest rows first: when a heavy user hits a cap the page must keep the
    // most recent activity (open trades, last trade date, recent failures),
    // not the oldest.
    fetchPaged(() => {
      let q = adminSupabase
        .from('trades')
        .select('id, broker_account_id, telegram_channel_id, status, profit, opened_at, closed_at, created_at')
        .eq('user_id', userId)
        .order('opened_at', { ascending: false, nullsFirst: false });
      if (fromIso) q = q.gte('opened_at', fromIso);
      if (toIso) q = q.lte('opened_at', toIso);
      return q;
    }, TRADE_CAP),
    fetchPaged(() => {
      let q = adminSupabase
        .from('signals')
        .select('id, channel_id, status, skip_reason, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (fromIso) q = q.gte('created_at', fromIso);
      if (toIso) q = q.lte('created_at', toIso);
      return q;
    }, SIGNAL_CAP),
    fetchPaged(() => {
      let q = adminSupabase
        .from('trade_execution_logs')
        .select('id, action, status, error_message, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (fromIso) q = q.gte('created_at', fromIso);
      if (toIso) q = q.lte('created_at', toIso);
      return q;
    }, LOG_CAP),
    // Visibility probe: how many health rows this signed-in admin can see at
    // all. Two or more proves the admin read policy is in force (a user owns
    // only their own row). Fewer proves nothing — see the branch below.
    adminSupabase
      .from('copier_listener_health')
      .select('user_id', { count: 'exact', head: true }),
    adminSupabase
      .from('copier_listener_health')
      .select('listener_status, copier_engine_status, worker_ownership_status, telegram_account_status, mtproto_connected, health_reason, last_connected_at, consecutive_probe_failures, recovery_exhausted, updated_at')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  if (accountsRes.error) errors.push(`broker_accounts: ${accountsRes.error.message}`);

  const accounts = (accountsRes.data ?? []) as BrokerAccountRow[];
  const trades = tradesRes.rows as unknown as TradeRow[];
  const signals = signalsRes.rows as unknown as SignalRow[];
  const logs = logsRes.rows as unknown as ExecutionLogRow[];

  // Channel names for channels the user follows (they can belong to someone
  // else's row in telegram_channels, which is why they are read separately).
  const channelIds = [...new Set([
    ...signals.map(s => s.channel_id),
    ...trades.map(t => t.telegram_channel_id),
  ].filter((id): id is string => Boolean(id)))];

  const channelNames: Record<string, string> = {};
  if (channelIds.length > 0) {
    const { data: channelRows, error: channelError } = await adminSupabase
      .from('telegram_channels')
      .select('id, display_name, channel_username')
      .in('id', channelIds);
    if (channelError) errors.push(`telegram_channels: ${channelError.message}`);
    for (const row of (channelRows ?? []) as Array<{ id: string; display_name: string | null; channel_username: string | null }>) {
      channelNames[row.id] = row.display_name ?? row.channel_username ?? 'Unnamed channel';
    }
  }

  // Health access: a row belonging to this user proves the read works, and so
  // does seeing two rows at once (a user owns only their own). Anything else
  // is undecidable from the client, so it is reported as `unknown` instead of
  // being read as "the copier is down" or "the policy is missing".
  let health: CopierHealthView;
  if (healthRowRes.error) {
    health = { access: 'error', row: null, error: healthRowRes.error.message };
    errors.push(`copier_listener_health: ${healthRowRes.error.message}`);
  } else if (healthRowRes.data) {
    health = { access: 'readable', row: healthRowRes.data as ListenerHealthRow, error: null };
  } else if ((healthProbe.count ?? 0) >= 2) {
    health = { access: 'readable', row: null, error: null };
  } else {
    health = { access: 'unknown', row: null, error: null };
  }

  return computeUserStatistics({
    range,
    env: getAdminEnv(),
    accounts,
    trades,
    signals,
    logs,
    health,
    channelNames,
    caps: {
      trades: tradesRes.capped,
      signals: signalsRes.capped,
      logs: logsRes.capped,
    },
    errors,
  });
}
