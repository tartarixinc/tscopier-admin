import { classifyErrorSeverity } from './errors';
import { failureTitle } from './failureExplainer';
import type { ExecutionLogRow } from '../components/pipeline/PipelineSections';

export interface PipelineIssue {
  key: string;
  source: 'signal' | 'channel' | 'execution';
  action: string | null;
  severity: 'transient' | 'major';
  raw: string;
  title: string | null;
  at: string | null;
  embedded: boolean;
}

const PROBLEM_KEYS = new Set([
  'error',
  'error_message',
  'error_detail',
  'reason',
  'skip_reason',
  'fail_reason',
  'failure_reason',
  'note',
  'warning',
  'exception',
  'rejection_reason',
  'failure',
]);

const OK_STATUSES = new Set([
  'success',
  'ok',
  'okay',
  'done',
  'completed',
  'complete',
  'sent',
  'queued',
  'parsed',
  'created',
  'processing',
  'running',
  'pending',
  'active',
  'accepted',
  'scheduled',
  'noop',
  'no_op',
  'skip',
  'skipped',
]);

function isBenign(value: string): boolean {
  if (!value.trim()) return true;
  if (/^(success|ok|none|null|undefined|true|false)$/i.test(value.trim())) return true;
  if (/^[\d.,%-]+$/.test(value.trim())) return true;
  return false;
}

function walk(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach(v => walk(v, out));
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if (PROBLEM_KEYS.has(key) && typeof v === 'string' && !isBenign(v)) {
        out.push(v.trim());
      } else if (key === 'status' && typeof v === 'string' && !OK_STATUSES.has(v.toLowerCase()) && !isBenign(v)) {
        out.push(v.trim());
      } else if (key === 'success' && v === false) {
        out.push('operation returned success: false');
      } else if (key === 'ok' && v === false) {
        out.push('operation returned ok: false');
      }
      walk(v, out);
    }
  }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(v => {
    const n = v.toLowerCase();
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

function toIssue(
  raw: string,
  source: PipelineIssue['source'],
  action: string | null,
  at: string | null,
  embedded: boolean,
): PipelineIssue {
  return {
    key: `${source}:${action ?? ''}:${raw.toLowerCase()}`,
    source,
    action,
    severity: classifyErrorSeverity(raw).severity,
    raw,
    title: failureTitle(raw, 'signal'),
    at,
    embedded,
  };
}

export function collectExecutionIssues(logs: ExecutionLogRow[]): PipelineIssue[] {
  const out: PipelineIssue[] = [];
  for (const log of logs) {
    const status = String(log.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'error') {
      if (log.error_message?.trim()) {
        out.push(toIssue(log.error_message.trim(), 'execution', log.action, log.created_at, false));
      }
    }
    if (log.error_message?.trim()) {
      out.push(toIssue(log.error_message.trim(), 'execution', log.action, log.created_at, true));
    }
    const markers = unique(walkCollect(log.request_payload).concat(walkCollect(log.response_payload)));
    markers.forEach(m => out.push(toIssue(m, 'execution', log.action, log.created_at, true)));
  }
  return dedupeIssues(out);
}

function walkCollect(value: unknown): string[] {
  const out: string[] = [];
  walk(value, out);
  return out;
}

function dedupeIssues(issues: PipelineIssue[]): PipelineIssue[] {
  const seen = new Set<string>();
  return issues.filter(i => {
    const key = `${i.source}:${i.action ?? ''}:${i.raw.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function collectPipelineIssues(
  signalSkip: string | null,
  channelSkip: string | null,
  logs: ExecutionLogRow[],
): PipelineIssue[] {
  const out: PipelineIssue[] = [];
  if (channelSkip?.trim()) out.push(toIssue(channelSkip.trim(), 'channel', null, null, false));
  if (signalSkip?.trim() && signalSkip.trim() !== channelSkip?.trim()) {
    out.push(toIssue(signalSkip.trim(), 'signal', null, null, false));
  }
  out.push(...collectExecutionIssues(logs));
  return dedupeIssues(out);
}
