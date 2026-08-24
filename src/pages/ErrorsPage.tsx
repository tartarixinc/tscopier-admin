import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, truncate } from '../lib/formatters';
import { UserLink } from '../components/UserLink';
import { Pagination } from '../components/DataTable';
import { ErrorDetailModal } from '../components/ErrorDetailModal';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { AlertTriangle, Search, Zap, Server, CopyX, BarChart3 } from 'lucide-react';
import clsx from 'clsx';
import {
  classifyErrorItemSeverity,
  errorDisplayForItem,
  extractTradeContext,
  categoryOf,
  executionLogToErrorItem,
  failedSignalToErrorItem,
  type EntryExecutionLogLike,
  type ErrorItem,
  type ErrorSource,
} from '../lib/errors';
import { applyBrokerCategory } from '../lib/brokerErrors';

const PAGE_SIZE = 50;
const LINKED_LOG_PAGE_SIZE = 1000;
const LINKED_LOG_SIGNAL_CHUNK_SIZE = 25;
const ENRICHMENT_FAILURE_BACKOFF_MS = 20_000;
const NO_EVIDENCE_TTL_MS = 40_000;

interface ExecutionRow {
  id: string;
  user_id: string | null;
  signal_id: string | null;
  broker_account_id: string | null;
  action: string | null;
  status: string;
  error_message: string | null;
  request_payload: unknown;
  response_payload: unknown;
  created_at: string;
}

interface SignalRow {
  id: string;
  user_id: string | null;
  status: string;
  skip_reason: string | null;
  raw_message: string | null;
  parsed_data: unknown;
  created_at: string;
}

interface BrokerRow {
  id: string;
  user_id: string | null;
  label: string | null;
  platform: string | null;
  broker_name: string | null;
  account_login: string | null;
  connection_error: string | null;
  fxsocket_status: string | null;
  terminal_connected: boolean | null;
  last_synced_at: string | null;
}

interface DeadLetterRow {
  id: string;
  user_id: string | null;
  signal_id: string | null;
  lane: string | null;
  attempts: number | null;
  reason: string | null;
  payload: unknown;
  status: string | null;
  created_at: string;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function itemNeedsLinkedExecutionEvidence(item: ErrorItem): boolean {
  return item.source === 'signal' && item.categoryKey === 'signal_entry_not_opened';
}

type EnrichmentStatus = 'with_evidence' | 'no_evidence';

interface EnrichmentCompletion {
  fingerprint: string;
  status: EnrichmentStatus;
  enrichedAt: number;
}

interface EnrichmentFailure {
  fingerprint: string;
  lastFailureAt: number;
  failureCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stableScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function signalEvidenceFingerprint(item: ErrorItem): string {
  const parsed = asRecord(item.detail);
  const verification = asRecord(parsed?._verification);
  const final = asRecord(verification?.final);
  const parts = [
    item.id,
    item.created_at ?? '',
    item.cause ?? '',
    stableScalar(final?.skip_reason),
    stableScalar(final?.reason_code ?? final?.reasonCode),
    stableScalar(final?.failure_reason ?? final?.failureReason),
    stableScalar(final?.status),
  ];
  return parts.join('|');
}

function completionStillValid(completion: EnrichmentCompletion | undefined, fingerprint: string, now: number): boolean {
  if (!completion || completion.fingerprint !== fingerprint) return false;
  if (completion.status === 'with_evidence') return true;
  return now - completion.enrichedAt < NO_EVIDENCE_TTL_MS;
}

function failureStillBackedOff(failure: EnrichmentFailure | undefined, fingerprint: string, now: number): boolean {
  return Boolean(failure && failure.fingerprint === fingerprint && now - failure.lastFailureAt < ENRICHMENT_FAILURE_BACKOFF_MS);
}

export function ErrorsPage() {
  const navigate = useNavigate();
  const [categoryFilter, setCategoryFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [causeFilter, setCauseFilter] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [items, setItems] = useState<ErrorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedErrorId, setSelectedErrorId] = useState<string | null>(null);
  const [enrichedSignalIds, setEnrichedSignalIds] = useState<Set<string>>(() => new Set());
  const [enrichingSignalIds, setEnrichingSignalIds] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const mountedRef = useRef(true);
  const itemsRef = useRef<ErrorItem[]>([]);
  const loadGenerationRef = useRef(0);
  const dataGenerationRef = useRef(0);
  const enrichmentCompletionsRef = useRef<Map<string, EnrichmentCompletion>>(new Map());
  const enrichmentFailuresRef = useRef<Map<string, EnrichmentFailure>>(new Map());
  const enrichingSignalIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      dataGenerationRef.current += 1;
      enrichingSignalIdsRef.current.clear();
      enrichmentFailuresRef.current.clear();
    };
  }, []);

  useEffect(() => { setPage(1); }, [categoryFilter, severityFilter, causeFilter, search, dateFrom, dateTo]);

  const loadErrors = useCallback(async () => {
    const loadGeneration = loadGenerationRef.current + 1;
    loadGenerationRef.current = loadGeneration;
    const from = dateFrom ? `${dateFrom}T00:00:00Z` : null;
    const to = dateTo ? `${dateTo}T23:59:59Z` : null;

    const execQ = adminSupabase
      .from('trade_execution_logs')
      .select('id, user_id, signal_id, broker_account_id, action, status, error_message, request_payload, response_payload, created_at')
      .in('status', ['failed', 'error'])
      .order('created_at', { ascending: false });
    if (from) execQ.gte('created_at', from);
    if (to) execQ.lte('created_at', to);

    const sigQ = adminSupabase
      .from('signals')
      .select('id, user_id, status, skip_reason, raw_message, parsed_data, created_at')
      .eq('status', 'failed')
      .order('created_at', { ascending: false });
    if (from) sigQ.gte('created_at', from);
    if (to) sigQ.lte('created_at', to);

    const brokerQ = adminSupabase
      .from('broker_accounts')
      .select('id, user_id, label, platform, broker_name, account_login, connection_error, fxsocket_status, terminal_connected, last_synced_at')
      .eq('connection_status', 'error')
      .order('last_synced_at', { ascending: false, nullsFirst: false });
    if (from) brokerQ.gte('last_synced_at', from);
    if (to) brokerQ.lte('last_synced_at', to);

    const deadQ = adminSupabase
      .from('signal_queue_dead_letters')
      .select('id, user_id, signal_id, lane, attempts, reason, payload, status, created_at')
      .neq('status', 'replayed')
      .order('created_at', { ascending: false });
    if (from) deadQ.gte('created_at', from);
    if (to) deadQ.lte('created_at', to);

    const [{ data: execRows }, { data: sigRows }, { data: brokerRows }, { data: deadRows }] = await Promise.all([
      execQ, sigQ, brokerQ, deadQ,
    ]);

    const userIds = new Set<string>();
    (execRows ?? []).forEach(r => r.user_id && userIds.add(r.user_id));
    (sigRows ?? []).forEach(r => r.user_id && userIds.add(r.user_id));
    (brokerRows ?? []).forEach(r => r.user_id && userIds.add(r.user_id));
    (deadRows ?? []).forEach(r => r.user_id && userIds.add(r.user_id));

    const displayNames = await fetchDisplayNames([...userIds]);

    const brokerIds = [...new Set(
      (execRows ?? [])
        .map(r => r.broker_account_id)
        .filter(Boolean),
    )];
    const brokerLabels: Record<string, string> = {};
    if (brokerIds.length > 0) {
      const { data: brokerLabelRows } = await adminSupabase
        .from('broker_accounts')
        .select('id, label')
        .in('id', brokerIds);
      (brokerLabelRows ?? []).forEach(b => { brokerLabels[b.id] = b.label ?? ''; });
    }

    const built: ErrorItem[] = [];

    (execRows ?? []).forEach((r: ExecutionRow) => {
      const item = executionLogToErrorItem({
        ...r,
        user_display_name: displayNames[r.user_id ?? ''] ?? null,
        broker_label: brokerLabels[r.broker_account_id ?? ''] ?? null,
      });
      built.push(item.structured_failure ? item : { ...item, ...applyBrokerCategory(item, item.cause) });
    });

    (sigRows ?? []).forEach((r: SignalRow) => {
      const item = failedSignalToErrorItem({
        ...r,
        user_display_name: displayNames[r.user_id ?? ''] ?? null,
      });
      built.push(item.diagnostics ? item : { ...item, ...applyBrokerCategory(item, item.cause) });
    });

    (brokerRows ?? []).forEach((r: BrokerRow) => {
      const { key, label } = categoryOf('broker', null);
      const item: ErrorItem = {
        id: r.id,
        source: 'broker',
        categoryKey: key,
        categoryLabel: label,
        user_id: r.user_id,
        user_display_name: displayNames[r.user_id ?? ""] ?? null,
        trade_context: r.label ?? null,
        cause: r.connection_error,
        detail: {
          label: r.label,
          platform: r.platform,
          broker_name: r.broker_name,
          account_login: r.account_login,
          fxsocket_status: r.fxsocket_status,
          terminal_connected: r.terminal_connected,
          last_synced_at: r.last_synced_at,
        },
        signal_id: null,
        broker_account_id: r.id,
        broker_label: r.label,
        created_at: r.last_synced_at,
      };
      built.push({ ...item, ...applyBrokerCategory(item, item.cause) });
    });

    (deadRows ?? []).forEach((r: DeadLetterRow) => {
      const { key, label } = categoryOf('dead_letter', null);
      const item: ErrorItem = {
        id: r.id,
        source: 'dead_letter',
        categoryKey: key,
        categoryLabel: label,
        user_id: r.user_id,
        user_display_name: displayNames[r.user_id ?? ""] ?? null,
        trade_context: extractTradeContext(r.payload, null) ?? (r.signal_id ? `signal ${r.signal_id.slice(0, 8)}` : null),
        cause: r.reason,
        detail: r.payload,
        signal_id: r.signal_id,
        broker_account_id: null,
        broker_label: null,
        attempts: r.attempts,
        created_at: r.created_at,
      };
      built.push({ ...item, ...applyBrokerCategory(item, item.cause) });
    });

    if (!mountedRef.current || loadGenerationRef.current !== loadGeneration) return;

    dataGenerationRef.current += 1;
    const now = Date.now();
    const baseById = new Map(built.map(item => [item.id, item]));
    const completions = new Map<string, EnrichmentCompletion>();
    for (const [id, completion] of enrichmentCompletionsRef.current) {
      const item = baseById.get(id);
      if (!item || !itemNeedsLinkedExecutionEvidence(item)) continue;
      const fingerprint = signalEvidenceFingerprint(item);
      if (completionStillValid(completion, fingerprint, now)) completions.set(id, completion);
    }
    enrichmentCompletionsRef.current = completions;
    const failures = new Map<string, EnrichmentFailure>();
    for (const [id, failure] of enrichmentFailuresRef.current) {
      const item = baseById.get(id);
      if (!item || !itemNeedsLinkedExecutionEvidence(item)) continue;
      const fingerprint = signalEvidenceFingerprint(item);
      if (failureStillBackedOff(failure, fingerprint, now)) failures.set(id, failure);
    }
    enrichmentFailuresRef.current = failures;
    const previousById = new Map(itemsRef.current.map(item => [item.id, item]));
    const next = built.map(item => {
      const previous = previousById.get(item.id);
      const fingerprint = signalEvidenceFingerprint(item);
      const completion = enrichmentCompletionsRef.current.get(item.id);
      const hasValidCompletedLinkedLogEnrichment = completionStillValid(completion, fingerprint, now);
      if (!hasValidCompletedLinkedLogEnrichment || !previous?.diagnostics || !itemNeedsLinkedExecutionEvidence(item)) return item;
      return {
        ...item,
        cause: previous.cause,
        diagnostics: previous.diagnostics,
      };
    });
    itemsRef.current = next;
    setItems(next);
    setEnrichedSignalIds(new Set(enrichmentCompletionsRef.current.keys()));
    enrichingSignalIdsRef.current.clear();
    setEnrichingSignalIds(new Set());
    setLoading(false);
  }, [dateFrom, dateTo]);

  const enrichSignalDiagnostics = useCallback(async (signalIds: string[]) => {
    const dataGeneration = dataGenerationRef.current;
    const loadGeneration = loadGenerationRef.current;
    const itemsById = new Map(itemsRef.current.map(item => [item.id, item]));
    const now = Date.now();
    const ids = [...new Set(signalIds)].filter(id => {
      if (enrichingSignalIdsRef.current.has(id)) return false;
      const item = itemsById.get(id);
      if (!item || !itemNeedsLinkedExecutionEvidence(item)) return false;
      const fingerprint = signalEvidenceFingerprint(item);
      if (completionStillValid(enrichmentCompletionsRef.current.get(id), fingerprint, now)) return false;
      if (failureStillBackedOff(enrichmentFailuresRef.current.get(id), fingerprint, now)) return false;
      return true;
    });
    if (ids.length === 0) return;

    enrichingSignalIdsRef.current = new Set([...enrichingSignalIdsRef.current, ...ids]);
    setEnrichingSignalIds(prev => new Set([...prev, ...ids]));
    try {
      const linkedLogRows: ExecutionRow[] = [];
      for (const signalChunk of chunk(ids, LINKED_LOG_SIGNAL_CHUNK_SIZE)) {
        let fromRow = 0;
        let hasMore = true;
        while (hasMore) {
          const { data, error } = await adminSupabase
            .from('trade_execution_logs')
            .select('id, user_id, signal_id, broker_account_id, action, status, error_message, request_payload, response_payload, created_at')
            .in('signal_id', signalChunk)
            .order('created_at', { ascending: false })
            .range(fromRow, fromRow + LINKED_LOG_PAGE_SIZE - 1);
          if (error) throw error;
          const pageRows = (data ?? []) as ExecutionRow[];
          linkedLogRows.push(...pageRows);
          hasMore = pageRows.length === LINKED_LOG_PAGE_SIZE;
          fromRow += LINKED_LOG_PAGE_SIZE;
        }
      }

      const brokerIds = [...new Set(linkedLogRows.map(r => r.broker_account_id).filter(Boolean))];
      const brokerLabels: Record<string, string> = {};
      if (brokerIds.length > 0) {
        const { data: brokerLabelRows, error } = await adminSupabase
          .from('broker_accounts')
          .select('id, label')
          .in('id', brokerIds);
        if (error) throw error;
        (brokerLabelRows ?? []).forEach(b => { brokerLabels[b.id] = b.label ?? ''; });
      }

      const linkedLogsBySignal = new Map<string, EntryExecutionLogLike[]>();
      linkedLogRows.forEach(r => {
        if (!r.signal_id) return;
        const logs = linkedLogsBySignal.get(r.signal_id) ?? [];
        logs.push({
          ...r,
          broker_label: brokerLabels[r.broker_account_id ?? ''] ?? null,
        });
        linkedLogsBySignal.set(r.signal_id, logs);
      });

      if (!mountedRef.current || dataGenerationRef.current !== dataGeneration || loadGenerationRef.current !== loadGeneration) return;

      const completedAt = Date.now();
      const next = itemsRef.current.map(item => {
        if (!ids.includes(item.id) || !itemNeedsLinkedExecutionEvidence(item)) return item;
        const logs = linkedLogsBySignal.get(item.id) ?? [];
        const enriched = failedSignalToErrorItem({
          id: item.id,
          user_id: item.user_id,
          user_display_name: item.user_display_name,
          status: 'failed',
          skip_reason: 'entry_not_opened',
          raw_message: item.raw_message ?? null,
          parsed_data: item.detail,
          created_at: item.created_at ?? '',
        }, logs);
        enrichmentCompletionsRef.current.set(item.id, {
          fingerprint: signalEvidenceFingerprint(item),
          status: logs.length > 0 ? 'with_evidence' : 'no_evidence',
          enrichedAt: completedAt,
        });
        enrichmentFailuresRef.current.delete(item.id);
        return enriched.diagnostics ? enriched : { ...enriched, ...applyBrokerCategory(enriched, enriched.cause) };
      });
      itemsRef.current = next;
      setItems(next);
      setEnrichedSignalIds(new Set(enrichmentCompletionsRef.current.keys()));
    } catch (error) {
      console.error('Failed to enrich error diagnostics', error);
      if (mountedRef.current && dataGenerationRef.current === dataGeneration && loadGenerationRef.current === loadGeneration) {
        const failedAt = Date.now();
        for (const id of ids) {
          const item = itemsRef.current.find(candidate => candidate.id === id);
          if (!item) continue;
          const previous = enrichmentFailuresRef.current.get(id);
          const fingerprint = signalEvidenceFingerprint(item);
          enrichmentFailuresRef.current.set(id, {
            fingerprint,
            lastFailureAt: failedAt,
            failureCount: previous?.fingerprint === fingerprint ? previous.failureCount + 1 : 1,
          });
        }
      }
    } finally {
      if (mountedRef.current && dataGenerationRef.current === dataGeneration && loadGenerationRef.current === loadGeneration) {
        ids.forEach(id => enrichingSignalIdsRef.current.delete(id));
        setEnrichingSignalIds(prev => {
          const next = new Set(prev);
          ids.forEach(id => next.delete(id));
          return next;
        });
      }
    }
  }, []);

  useEffect(() => {
    loadErrors();
    const timer = window.setInterval(() => { loadErrors(); }, 20_000);
    return () => window.clearInterval(timer);
  }, [loadErrors]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter(item => {
      if (categoryFilter && item.categoryKey !== categoryFilter) return false;
      if (severityFilter) {
        const sev = classifyErrorItemSeverity(item).severity;
        if (sev !== severityFilter) return false;
      }
      const display = errorDisplayForItem(item);
      if (causeFilter && display.causeKey !== causeFilter) return false;
      if (term) {
        const user = item.user_display_name?.toLowerCase() ?? '';
        const userId = item.user_id?.toLowerCase() ?? '';
        const trade = item.trade_context?.toLowerCase() ?? '';
        const cause = `${display.title} ${display.reason}`.toLowerCase();
        if (!user.includes(term) && !userId.includes(term) && !trade.includes(term) && !cause.includes(term)) return false;
      }
      return true;
    });
  }, [items, categoryFilter, severityFilter, causeFilter, search]);

  const causeBreakdown = useMemo(() => {
    const byCause = new Map<string, { reason: string; count: number; transient: number; major: number; title: string }>();
    filtered.forEach(item => {
      const display = errorDisplayForItem(item);
      const key = display.causeKey;
      const entry = byCause.get(key) ?? {
        reason: display.reason,
        count: 0,
        transient: 0,
        major: 0,
        title: display.title,
      };
      entry.count += 1;
      if (classifyErrorItemSeverity(item).severity === 'transient') entry.transient += 1;
      else entry.major += 1;
      byCause.set(key, entry);
    });
    return [...byCause.entries()]
      .map(([key, v]) => ({ ...v, key }))
      .sort((a, b) => b.count - a.count);
  }, [filtered]);

  const totals = useMemo(() => {
    const transient = filtered.filter(i => classifyErrorItemSeverity(i).severity === 'transient').length;
    const major = filtered.filter(i => classifyErrorItemSeverity(i).severity === 'major').length;
    const categoryCount = new Set(filtered.map(i => i.categoryKey)).size;
    return { total: filtered.length, transient, major, categoryCount };
  }, [filtered]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()),
    [filtered],
  );

  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const selectedError = useMemo(
    () => selectedErrorId ? items.find(item => item.id === selectedErrorId) ?? null : null,
    [items, selectedErrorId],
  );

  const visibleSignalIdsNeedingEvidence = useMemo(
    () => paged
      .filter(itemNeedsLinkedExecutionEvidence)
      .map(item => item.id)
      .filter(id => !enrichedSignalIds.has(id) && !enrichingSignalIds.has(id)),
    [paged, enrichedSignalIds, enrichingSignalIds],
  );

  useEffect(() => {
    if (!loading && visibleSignalIdsNeedingEvidence.length > 0) {
      void enrichSignalDiagnostics(visibleSignalIdsNeedingEvidence);
    }
  }, [loading, visibleSignalIdsNeedingEvidence, enrichSignalDiagnostics]);

  useEffect(() => {
    if (!loading && selectedError && itemNeedsLinkedExecutionEvidence(selectedError) && !enrichedSignalIds.has(selectedError.id) && !enrichingSignalIds.has(selectedError.id)) {
      void enrichSignalDiagnostics([selectedError.id]);
    }
  }, [loading, selectedError, enrichedSignalIds, enrichingSignalIds, enrichSignalDiagnostics]);

  const allCategories = useMemo(() => {
    const seen = new Map<string, string>();
    items.forEach(i => { if (!seen.has(i.categoryKey)) seen.set(i.categoryKey, i.categoryLabel); });
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [items]);

  const sourceIcon = (source: ErrorSource) => {
    if (source === 'execution') return <Zap className="w-3.5 h-3.5" />;
    if (source === 'signal') return <AlertTriangle className="w-3.5 h-3.5" />;
    if (source === 'broker') return <Server className="w-3.5 h-3.5" />;
    return <CopyX className="w-3.5 h-3.5" />;
  };

  const causeTitleFor = (item: ErrorItem): string | null => {
    return errorDisplayForItem(item).title;
  };

  const causeSubtitleFor = (item: ErrorItem): string => {
    return errorDisplayForItem(item).reason;
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Errors</h1>
          <p className="page-subtitle">Failed executions, failed signals, broker connection errors and dead letters</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/errors/analytics')}>
          <BarChart3 className="w-3.5 h-3.5" />
          Error analytics
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card">
          <p className="stat-label">Errors</p>
          <p className="stat-value text-2xl">{totals.total.toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-0.5">{totals.categoryCount} categor{totals.categoryCount !== 1 ? 'ies' : 'y'}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Transient</p>
          <p className="stat-value text-2xl text-amber-500">{totals.transient.toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-0.5">Likely self-resolving</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Major</p>
          <p className="stat-value text-2xl text-error-600">{totals.major.toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-0.5">Needs intervention</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Reviewed as major</p>
          <p className="stat-value text-2xl text-slate-900 dark:text-slate-100">{Math.round((totals.major / Math.max(1, totals.total)) * 100)}%</p>
          <p className="text-xs text-slate-400 mt-0.5">of all errors</p>
        </div>
      </div>

      <Card>
        <div className="px-4 pt-3 pb-2 border-b border-slate-100 dark:border-slate-700 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-error-500" />
            Failure causes
            <span className="text-xs font-normal text-slate-400">what exactly failed, across all sources</span>
          </h3>
          {causeFilter && (
            <button
              type="button"
              onClick={() => setCauseFilter('')}
              className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
            >
              Clear cause filter ({causeFilter})
            </button>
          )}
        </div>
        {causeBreakdown.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-8">No causes to show.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
            {causeBreakdown.slice(0, 15).map(c => {
              const pct = Math.round((c.count / Math.max(1, totals.total)) * 100);
              const active = causeFilter === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setCauseFilter(active ? '' : c.key)}
                  className={clsx(
                    'w-full text-left px-4 py-2.5 flex items-center gap-4 transition-colors',
                    active ? 'bg-primary-50 dark:bg-primary-900/30' : 'hover:bg-slate-50 dark:hover:bg-slate-700/40'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{c.title}</p>
                    <p className="text-xs text-slate-400 truncate">{c.reason}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="hidden sm:block w-40 h-1.5 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                      <div className="h-full bg-error-500" style={{ width: `${pct}%` }} />
                    </div>
                    {c.major > 0 && <Badge variant="error">{c.major} major</Badge>}
                    {c.transient > 0 && <Badge variant="warning">{c.transient} transient</Badge>}
                    <span className="text-sm font-semibold text-slate-700 dark:text-slate-200 w-12 text-right">{c.count}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <div className="filter-bar rounded-xl flex-wrap">
        <Input
          placeholder="Search user, trade, cause..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          prefix={<Search className="w-3.5 h-3.5" />}
          className="w-60"
        />
        <Select
          options={allCategories}
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          placeholder="All Categories"
          className="w-52"
        />
        <Select
          options={[{ value: 'transient', label: 'Transient' }, { value: 'major', label: 'Major' }]}
          value={severityFilter}
          onChange={e => setSeverityFilter(e.target.value)}
          placeholder="All Severities"
          className="w-40"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input-base py-1.5 text-xs w-36" />
          <label className="text-xs text-slate-500">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input-base py-1.5 text-xs w-36" />
        </div>
      </div>

      {loading ? (
        <Card>
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-12 rounded skeleton" />)}
          </div>
        </Card>
      ) : sorted.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-400 text-center py-16">No errors match the current filters.</p>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>User</th>
                  <th>Trade</th>
                  <th>Cause</th>
                  <th>Severity</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {paged.map(item => {
                  const severity = classifyErrorItemSeverity(item).severity;
                  return (
                    <tr key={item.id} onClick={() => setSelectedErrorId(item.id)} className="cursor-pointer">
                      <td>
                        <span className="flex items-center gap-1.5 text-xs text-slate-500">
                          <span className="text-primary-500">{sourceIcon(item.source)}</span>
                          {item.categoryLabel}
                        </span>
                      </td>
                      <td>
                        {item.user_id
                          ? <UserLink userId={item.user_id} displayName={item.user_display_name} />
                          : <span className="text-slate-400 text-xs">—</span>}
                      </td>
                      <td><span className="font-mono text-xs text-slate-500">{item.trade_context ?? '—'}</span></td>
                      <td>
                        <div className="max-w-xs">
                          {causeTitleFor(item) && (
                            <p className="text-xs text-slate-700 dark:text-slate-200 truncate">{causeTitleFor(item)}</p>
                          )}
                          <p className="text-[10px] text-slate-400 font-mono truncate" title={causeSubtitleFor(item)}>
                            {truncate(causeSubtitleFor(item), 60)}
                          </p>
                        </div>
                      </td>
                      <td>
                        {severity === 'transient'
                          ? <Badge variant="warning" dot>Transient</Badge>
                          : <Badge variant="error" dot>Major</Badge>}
                      </td>
                      <td><span className="text-xs text-slate-400">{formatDate(item.created_at)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))} totalCount={sorted.length} pageSize={PAGE_SIZE} onPageChange={setPage} />
        </Card>
      )}

      {selectedError && (
        <ErrorDetailModal
          error={selectedError}
          diagnosticsLoading={itemNeedsLinkedExecutionEvidence(selectedError) && enrichingSignalIds.has(selectedError.id)}
          safeDisplayOnly
          onClose={() => setSelectedErrorId(null)}
        />
      )}
    </div>
  );
}
