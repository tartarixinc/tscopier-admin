/**
 * Live monitoring overlay for the Systems Health page: probe targets
 * (bridge liveness, trade-worker heartbeat, evaluator dead-man), open alert
 * events, and the mutations the alert bar needs (acknowledge via admin-mutate).
 *
 * All reads go through authSupabase with the is_admin() SELECT policies from
 * supabase/migrations/20261012120000_admin_read_monitoring_tables.sql.
 */

import { authSupabase } from './adminSupabase';

export type ProbeState = 'up' | 'down' | 'unknown';

export interface ProbeStateRow {
  target: string;
  state: ProbeState;
  latency_ms: number | null;
  last_ok_at: string | null;
  down_since: string | null;
  consecutive_failures: number;
  detail: string | null;
  updated_at: string;
}

export interface ProbeSampleRow {
  target: string;
  state: 'up' | 'down';
  latency_ms: number | null;
  created_at: string;
}

export interface ProbeEventRow {
  target: string;
  state: 'up' | 'down';
  latency_ms: number | null;
  detail: string | null;
  created_at: string;
}

export interface AlertRuleRef {
  code: string;
  name: string;
  severity: 'info' | 'warning' | 'critical';
  description: string;
}

export interface OpenAlertEvent {
  id: string;
  rule_code: string;
  state: 'firing' | 'acknowledged';
  severity: 'info' | 'warning' | 'critical';
  value: number | null;
  message: string;
  email_sent_at: string | null;
  created_at: string;
  acknowledged_at: string | null;
  alert_rules: AlertRuleRef | null;
}

export interface ProbeTargetSummary {
  target: string;
  state: ProbeState;
  latencyMs: number | null;
  lastReportAt: string | null;
  downSince: string | null;
  consecutiveFailures: number;
  detail: string | null;
  /** Uptime % over the last 24h: minutes with an 'up' sample / minutes since tracking began, so both 'down' samples and silence count as downtime. Null when no samples exist. */
  uptime24hPct: number | null;
  p95LatencyMs: number | null;
  samples24h: number;
  recentEvents: ProbeEventRow[];
}

export interface MonitoringOverlay {
  probes: ProbeTargetSummary[];
  openAlerts: OpenAlertEvent[];
  /** True when the probe tables could not be read (RLS/migration missing). */
  probesReadable: boolean;
  alertsReadable: boolean;
  fetchedAt: number;
}

const PROBE_EVENTS_LIMIT = 20;
const SAMPLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export async function fetchMonitoringOverlay(): Promise<MonitoringOverlay> {
  const sinceIso = new Date(Date.now() - SAMPLE_LOOKBACK_MS).toISOString();

  const [stateRes, samplesRes, eventsRes, alertsRes] = await Promise.all([
    authSupabase.from('system_probe_state').select('*').order('target'),
    authSupabase
      .from('system_probe_samples')
      .select('target, state, latency_ms, created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .limit(20_000),
    authSupabase
      .from('system_probe_events')
      .select('target, state, latency_ms, detail, created_at')
      .order('created_at', { ascending: false })
      .limit(PROBE_EVENTS_LIMIT),
    authSupabase
      .from('alert_events')
      .select('*, alert_rules(code, name, severity, description)')
      .in('state', ['firing', 'acknowledged'])
      .order('created_at', { ascending: false })
      .limit(25),
  ]);

  const probesReadable = !stateRes.error;
  const alertsReadable = !alertsRes.error;

  const samplesByTarget = new Map<string, ProbeSampleRow[]>();
  for (const s of (samplesRes.data ?? []) as ProbeSampleRow[]) {
    const list = samplesByTarget.get(s.target);
    if (list) list.push(s);
    else samplesByTarget.set(s.target, [s]);
  }
  const eventsByTarget = new Map<string, ProbeEventRow[]>();
  for (const e of (eventsRes.data ?? []) as ProbeEventRow[]) {
    const list = eventsByTarget.get(e.target);
    if (list) list.push(e);
    else eventsByTarget.set(e.target, [e]);
  }

  const probes: ProbeTargetSummary[] = ((stateRes.data ?? []) as ProbeStateRow[]).map(row => {
    const samples = samplesByTarget.get(row.target) ?? [];
    const latencies = samples.map(s => s.latency_ms).filter((n): n is number => typeof n === 'number');

    // Coverage-based uptime: a dead heartbeat target stops producing samples
    // entirely (and bridge targets keep producing 'down' samples while
    // failing), so up/total would show ~100% exactly when things are broken.
    // Count distinct minutes that contain an 'up' sample instead — both
    // silence and 'down' samples read as downtime.
    const windowStart = Date.now() - SAMPLE_LOOKBACK_MS;
    const upMinutes = new Set<number>();
    let oldestSample = Number.POSITIVE_INFINITY;
    for (const s of samples) {
      const t = Date.parse(s.created_at);
      if (!Number.isFinite(t)) continue;
      if (t < oldestSample) oldestSample = t;
      if (s.state === 'up') upMinutes.add(Math.floor(t / 60_000));
    }
    const spanStart = Number.isFinite(oldestSample) ? Math.max(windowStart, oldestSample) : Date.now();
    const spanMin = Math.max(1, Math.min(1440, Math.ceil((Date.now() - spanStart) / 60_000)));

    return {
      target: row.target,
      state: row.state,
      latencyMs: row.latency_ms,
      lastReportAt: row.updated_at,
      downSince: row.down_since,
      consecutiveFailures: row.consecutive_failures,
      detail: row.detail,
      uptime24hPct: samples.length > 0 ? Math.min(100, Math.round((upMinutes.size / spanMin) * 1000) / 10) : null,
      p95LatencyMs: percentile(latencies, 95),
      samples24h: samples.length,
      recentEvents: eventsByTarget.get(row.target) ?? [],
    };
  });

  return {
    probes,
    openAlerts: (alertsRes.data ?? []) as OpenAlertEvent[],
    probesReadable,
    alertsReadable,
    fetchedAt: Date.now(),
  };
}

/** Acknowledge a firing alert through the audited admin-mutate action. */
export async function acknowledgeAlert(eventId: string, reason: string): Promise<void> {
  const { error } = await authSupabase.functions.invoke('admin-mutate', {
    body: { action: 'acknowledge_alert', alert_event_id: eventId, reason },
  });
  if (error) throw new Error(error.message ?? 'acknowledge failed');
}

export interface AlertRuleRow {
  code: string;
  name: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
  threshold: Record<string, unknown>;
  window_minutes: number;
  cooldown_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface AlertEventRow {
  id: string;
  rule_code: string;
  state: 'firing' | 'resolved' | 'acknowledged';
  severity: 'info' | 'warning' | 'critical';
  value: number | null;
  message: string;
  email_sent_at: string | null;
  email_attempts: number;
  email_last_error: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface AlertRecipientRow {
  id: string;
  email: string;
  min_severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
  created_at: string;
}

export interface AlertRulePatch {
  name?: string;
  description?: string;
  severity?: 'info' | 'warning' | 'critical';
  enabled?: boolean;
  threshold?: Record<string, unknown>;
  window_minutes?: number;
  cooldown_seconds?: number;
}

async function adminMutate(body: Record<string, unknown>): Promise<void> {
  const { error } = await authSupabase.functions.invoke('admin-mutate', { body });
  if (error) {
    // Surface the function's JSON error message when present.
    const context = (error as { context?: { json?: () => Promise<{ error?: string }> } }).context;
    if (context?.json) {
      try {
        const payload = await context.json();
        if (payload?.error) throw new Error(payload.error);
      } catch (e) {
        if (e instanceof Error && e.message !== (error.message ?? '')) throw e;
      }
    }
    throw new Error(error.message ?? 'mutation failed');
  }
}

export async function updateAlertRule(code: string, patch: AlertRulePatch, reason: string): Promise<void> {
  await adminMutate({ action: 'update_alert_rule', code, reason, ...patch });
}

export async function upsertAlertRecipient(input: {
  email: string;
  min_severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
}): Promise<void> {
  await adminMutate({
    action: 'upsert_alert_recipient',
    reason: `recipient managed from Alerts console (${input.enabled ? 'enabled' : 'disabled'})`,
    ...input,
  });
}

export async function deleteAlertRecipient(recipientId: string): Promise<void> {
  await adminMutate({
    action: 'delete_alert_recipient',
    recipient_id: recipientId,
    reason: 'recipient removed from Alerts console',
  });
}

export const PROBE_TARGET_LABELS: Record<string, string> = {
  bridge_mt5: 'MT5 bridge',
  bridge_mt4: 'MT4 bridge',
  worker_trade: 'Trade worker heartbeat',
  alert_evaluator: 'Alert evaluator',
};

export function probeTargetLabel(target: string): string {
  return PROBE_TARGET_LABELS[target] ?? target;
}
