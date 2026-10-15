/**
 * Shared copy and static wiring for the Systems Health connection map,
 * organ modals and probe readouts. Single source for the on-screen modal
 * text so the AI assistant (healthAssistant.ts) and the page (SystemHealthPage)
 * can never drift apart.
 */

import type { HealthState } from './systemHealth';
import type { ProbeTargetSummary } from './monitoringOverlay';

export function agoFmt(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

const BRIDGE_STALE_MS = 90_000;
const HEARTBEAT_STALE_MS = 180_000;

/** Probe summary → health state + the short value shown on the map box. */
export function probeHealth(p: ProbeTargetSummary | undefined, nowTick: number): { state: HealthState; value: string; title: string } {
  if (!p) return { state: 'unknown', value: '—', title: 'No probe data yet — the target may not be deployed, or the worker probe is not running.' };
  const staleAfter = p.target.startsWith('bridge_') ? BRIDGE_STALE_MS : HEARTBEAT_STALE_MS;
  const age = p.lastReportAt ? nowTick - Date.parse(p.lastReportAt) : Number.NaN;
  if (p.state === 'down') {
    const downFor = p.downSince ? nowTick - Date.parse(p.downSince) : null;
    return {
      state: 'fail',
      value: downFor != null ? `down ${agoFmt(downFor)}` : 'down',
      title: p.detail ?? 'Health check failing',
    };
  }
  if (p.state === 'up' && Number.isFinite(age) && age > staleAfter) {
    return {
      state: 'warn',
      value: `stale ${agoFmt(age)}`,
      title: `Last report ${agoFmt(age)} ago — unknown must not be treated as healthy.`,
    };
  }
  if (p.state === 'unknown') return { state: 'unknown', value: 'unknown', title: p.detail ?? '' };
  return {
    state: 'ok',
    value: p.latencyMs != null ? `${p.latencyMs}ms` : 'up',
    title: `Last report ${agoFmt(age)} ago`,
  };
}

export interface MapNodeCopy {
  label: string;
  what: string;
  impact: string;
  rules: string[];
}

/** Static parts of every connection-map node (the dynamic value/state stay with the caller). */
export const MAP_NODE_COPY: Record<string, MapNodeCopy> = {
  'telegram-src': {
    label: 'Telegram',
    what: 'The live MTProto session with Telegram — the source every trade signal comes from. The value is channels listening now vs channels linked in total.',
    impact: 'No new signals are received from your channels, so no new copies are opened. Existing open trades are unaffected until management actions also lose their source.',
    rules: ['telegram_gap'],
  },
  listeners: {
    label: 'Listeners',
    what: 'Listener processes (hosted on Railway) that hold a short renewable lease per shard and continuously pull messages from your Telegram channels. A live lease proves a worker is alive and owns that listening loop.',
    impact: 'Channels go unwatched. Signals arriving in that window are delayed or missed entirely until a listener takes the lease again.',
    rules: ['workers_offline', 'telegram_gap'],
  },
  signals: {
    label: 'Signals',
    what: 'Trade signals parsed from channel messages in the selected time window (regex → AI fallback pipeline). A dash means the count is not reliable for this window, not that nothing arrived.',
    impact: 'Message parsing stalls: raw channel text sits unparsed, so nothing enters the copy pipeline even though Telegram delivery is fine.',
    rules: ['dead_letters_high'],
  },
  queue: {
    label: 'Queue',
    what: 'Parsed signals waiting to be picked up for execution, including ones currently in flight through the trade worker.',
    impact: 'Parsed signals wait instead of executing: entries, exits and management actions all run late, or not at all if the backlog never drains.',
    rules: ['queue_stuck', 'dead_letters_high'],
  },
  'trade-workers': {
    label: 'Trade workers',
    what: 'The worker process that executes and manages trades. It writes a heartbeat every 30 seconds; silence longer than about 3 minutes is treated as down (unknown is never treated as healthy).',
    impact: 'Nothing executes: new copies, break-even/SL/TP moves, partial closes and full closes all stop until a worker heartbeats again.',
    rules: ['trade_workers_offline', 'probe_stale'],
  },
  'bridge-mt5': {
    label: 'Bridge MT5',
    what: 'The MT5 side of the MTAPI bridge: the worker hands each trade decision to it, and it places the actual orders in your MT5 terminals.',
    impact: 'Trades cannot reach MT5 terminals — opens, closes and management actions fail for every MT5 account until the bridge answers its health check again.',
    rules: ['bridge_down', 'probe_stale', 'mtapi_reconnect_storm'],
  },
  'bridge-mt4': {
    label: 'Bridge MT4',
    what: 'The MT4 side of the MTAPI bridge: same role as MT5, for MT4 terminals.',
    impact: 'Trades cannot reach MT4 terminals — opens, closes and management actions fail for every MT4 account until the bridge answers its health check again.',
    rules: ['bridge_down', 'probe_stale', 'mtapi_reconnect_storm'],
  },
  'broker-accounts': {
    label: 'Broker accounts',
    what: 'Broker accounts connected through MTAPI — each user account that receives copies. The number is the total in the current state summary (connected, recovering and error together).',
    impact: 'The affected accounts stop copying new signals and stop receiving management actions; other accounts are unaffected unless the cause is bridge-wide.',
    rules: ['mtapi_accounts_error', 'executions_failing'],
  },
  database: {
    label: 'Database',
    what: 'The Supabase Postgres database every component reads and writes: signals, broker accounts, leases, probe state and alert history all live here.',
    impact: 'The whole product stops — no signals can be stored, no leases renew, no trades are recorded. This is the single most critical dependency.',
    rules: [],
  },
  railway: {
    label: 'Railway',
    what: 'Railway is the hosting platform for the listener and trade-worker services. This box shows whether those processes are alive, derived from their own heartbeats and leases ("services up" means at least one of the two is alive). Full Railway deployment status (crashed deploys, deploy history) is not connected yet — it needs a Railway API token.',
    impact: 'Both the listener and the trade worker are the Railway-hosted services: if the platform is down, signals stop arriving and nothing executes. The failure shows up first as the Trade workers and Listeners boxes going red.',
    rules: ['workers_offline', 'trade_workers_offline'],
  },
  scheduler: {
    label: 'Scheduler',
    what: 'The cron-driven alert evaluator (edge function, runs every minute via pg_cron): it evaluates every alert rule, records firing/resolved events, and emails recipients. It also writes its own heartbeat, and the dead-man monitor pages if that heartbeat dies.',
    impact: 'Monitoring goes blind: no alerts fire and no email is sent while the rest of the product may look fine. A dedicated alert rule (probe stale) watches the evaluator itself and pages on its recovery.',
    rules: ['probe_stale'],
  },
  backtest: {
    label: 'Backtest',
    what: 'Backtest runs are triggered manually from the Backtests page and use historical data only. Idle is the normal state.',
    impact: 'Nothing in production — backtests never touch live signals or accounts.',
    rules: [],
  },
};

export type OrganId = 'workers' | 'telegram' | 'brokers' | 'railway';

/** Plain-English "what this is" shown at the top of each organ modal. */
export const ORGAN_COPY: Record<OrganId, { label: string; what: string }> = {
  workers: {
    label: 'Workers',
    what: 'Listener workers hold a renewable lease (≈45s TTL) for every Telegram account they actively poll. A live lease proves a worker is alive and owns that user\'s listening loop.',
  },
  telegram: {
    label: 'Telegram link',
    what: 'A linked session means the user connected their Telegram account once. Listening now means a worker is actively polling that account at this moment.',
  },
  brokers: {
    label: 'Broker links',
    what: 'Each user connects broker accounts through which trades execute. Recovering means auto-reconnect is in progress; error needs the user to reconnect.',
  },
  railway: {
    label: 'Worker process logs',
    what: 'Live Railway deployment logs watched for worker crashes, realtime subscription churn, and log rate-limits — the exact pattern of the Aug 25 retry storm.',
  },
};

export const MAP_KEY_TO_PROBE: Record<string, string> = {
  'trade-workers': 'worker_trade',
  'bridge-mt5': 'bridge_mt5',
  'bridge-mt4': 'bridge_mt4',
  scheduler: 'alert_evaluator',
};

export const MAP_KEY_TO_CHECK: Record<string, string> = {
  'telegram-src': 'telegram',
  listeners: 'workers',
  signals: 'copying',
  queue: 'queue',
  'broker-accounts': 'brokers',
};

/**
 * Railway box: single-sourced from trade-worker heartbeat + listener leases —
 * one derivation for both the map and the assistant snapshot so they can
 * never contradict each other.
 */
export function railwayBox(tradeState: HealthState, workersState: HealthState | undefined): { state: HealthState; value: string; title: string } {
  const anyOk = tradeState === 'ok' || workersState === 'ok';
  const anyFail = tradeState === 'fail' || workersState === 'fail';
  const anyWarn = tradeState === 'warn' || workersState === 'warn';
  const state: HealthState = anyOk ? 'ok' : anyFail ? 'fail' : anyWarn ? 'warn' : 'unknown';
  const value = anyOk ? 'services up' : anyFail ? 'services down' : anyWarn ? 'degraded' : 'no data';
  const title = anyOk
    ? 'At least one Railway-hosted service (trade worker or listener) is alive, based on its own heartbeat or lease.'
    : anyFail
      ? 'No heartbeat from the trade worker and no live listener leases — the processes Railway hosts appear down.'
      : anyWarn
        ? 'A Railway-hosted service is reporting but looks stale — last heartbeat or lease is ageing out.'
        : 'No service heartbeats available — cannot tell whether Railway-hosted services are running.';
  return { state, value, title };
}
