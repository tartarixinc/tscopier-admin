export interface PipelineTimelineEvent {
  key: string;
  label: string;
  at: number | null;
  offsetMs: number | null;
  durationMs: number | null;
}

export interface PipelineStageStat {
  key: string;
  label: string;
  value: number | null;
}

const TIMESTAMP_KEYS: string[] = [
  'telegram_source_message_at',
  'telegram_message_received_at',
  'message_normalized_at',
  'parse_started_at',
  'parse_completed_at',
  'signal_persist_started_at',
  'signal_persist_completed_at',
  'queue_publish_started_at',
  'queue_published_at',
  'queue_consumed_at',
  'execution_planning_started_at',
  'execution_planning_completed_at',
  'execution_claim_started_at',
  'execution_claim_acquired_at',
  'broker_resolution_started_at',
  'broker_ready_at',
  'broker_request_started_at',
  'broker_response_received_at',
  'broker_execution_confirmed_at',
  'execution_state_persisted_at',
  'reconciliation_started_at',
  'reconciliation_completed_at',
  't_ai_parse_done',
  't_stage1_started_at',
  't_stage1_done_at',
  't_stage2_started_at',
  't_stage2_done_at',
  't_stage3_started_at',
  't_stage3_done_at',
  't_telegram_event',
  't_listener_received',
  't_parse_done',
  't_dispatch_sent',
  't_dispatch_received',
  't_order_send_start',
  't_send_caches_resolved',
  't_session_resolved',
  't_symbol_resolved',
  't_params_resolved',
  't_first_broker_send',
  't_last_broker_send',
  't_order_send_done',
];

export function parsePipelineTimestamps(raw: unknown): Record<string, number> | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const ts: Record<string, number> = {};
  for (const key of TIMESTAMP_KEYS) {
    const value = o[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      ts[key] = value;
    }
  }
  if (ts.telegram_source_message_at == null) ts.telegram_source_message_at = ts.t_telegram_event;
  if (ts.telegram_message_received_at == null) ts.telegram_message_received_at = ts.t_listener_received;
  if (ts.parse_completed_at == null) ts.parse_completed_at = ts.t_parse_done;
  if (ts.queue_published_at == null) ts.queue_published_at = ts.t_dispatch_sent;
  if (ts.queue_consumed_at == null) ts.queue_consumed_at = ts.t_dispatch_received;
  if (ts.execution_planning_started_at == null) ts.execution_planning_started_at = ts.t_order_send_start;
  if (ts.broker_ready_at == null) ts.broker_ready_at = ts.t_send_caches_resolved;
  if (ts.broker_request_started_at == null) ts.broker_request_started_at = ts.t_first_broker_send;
  if (ts.broker_response_received_at == null) ts.broker_response_received_at = ts.t_last_broker_send;
  if (ts.execution_state_persisted_at == null) ts.execution_state_persisted_at = ts.t_order_send_done;
  return Object.values(ts).some(v => v != null) ? ts : undefined;
}

function duration(end: number | null | undefined, start: number | null | undefined): number | null {
  if (end == null || start == null) return null;
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, end - start);
}

function pick(ts: Record<string, number>, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = ts[key];
    if (v != null) return v;
  }
  return null;
}

export function computeStageDurations(ts: Record<string, number>): Record<string, number | null> {
  const t0 = pick(ts, 'telegram_source_message_at', 'telegram_message_received_at', 'queue_consumed_at');
  const tEnd = pick(
    ts,
    'reconciliation_completed_at',
    'execution_state_persisted_at',
    'broker_execution_confirmed_at',
    'broker_response_received_at',
    'queue_consumed_at',
  );
  return {
    telegram_to_listener_ms: duration(ts.telegram_message_received_at, ts.telegram_source_message_at),
    parse_ms: duration(ts.parse_completed_at, ts.parse_started_at ?? ts.telegram_message_received_at),
    stage1_ms: duration(ts.t_stage1_done_at, ts.t_stage1_started_at),
    stage2_ms: duration(ts.t_stage2_done_at, ts.t_stage2_started_at),
    stage3_ms: duration(ts.t_stage3_done_at, ts.t_stage3_started_at),
    signal_persist_ms: duration(ts.signal_persist_completed_at, ts.signal_persist_started_at),
    dispatch_ms: duration(ts.queue_published_at, ts.queue_publish_started_at),
    queue_wait_ms: duration(ts.queue_consumed_at, ts.queue_published_at),
    prep_ms: duration(ts.execution_planning_started_at, ts.queue_consumed_at),
    planning_ms: duration(ts.execution_planning_completed_at, ts.execution_planning_started_at),
    execution_claim_ms: duration(ts.execution_claim_acquired_at, ts.execution_claim_started_at),
    order_send_ms: duration(ts.execution_state_persisted_at, ts.execution_planning_started_at),
    broker_send_ms: duration(ts.broker_response_received_at, ts.broker_request_started_at),
    broker_ack_ms: duration(ts.broker_execution_confirmed_at, ts.broker_request_started_at),
    broker_resolve_ms: duration(ts.broker_ready_at, ts.broker_resolution_started_at ?? ts.execution_planning_started_at),
    reconciliation_ms: duration(ts.reconciliation_completed_at, ts.reconciliation_started_at),
    telegram_receipt_to_broker_request_ms: duration(ts.broker_request_started_at, ts.telegram_message_received_at),
    telegram_receipt_to_broker_confirmation_ms: duration(ts.broker_execution_confirmed_at, ts.telegram_message_received_at),
    total_ms: duration(tEnd, t0),
  };
}

export function buildPipelineTimeline(ts: Record<string, number>): PipelineTimelineEvent[] {
  const events: PipelineTimelineEvent[] = [
    { key: 'telegram_source_message_at', label: 'Telegram message sent', at: ts.telegram_source_message_at, offsetMs: null, durationMs: null },
    { key: 'telegram_message_received_at', label: 'Listener received message', at: ts.telegram_message_received_at, offsetMs: null, durationMs: duration(ts.telegram_message_received_at, ts.telegram_source_message_at) },
    { key: 'message_normalized_at', label: 'Message normalized', at: ts.message_normalized_at, offsetMs: null, durationMs: duration(ts.message_normalized_at, ts.telegram_message_received_at) },
    { key: 'parse_started_at', label: 'Parse started', at: ts.parse_started_at, offsetMs: null, durationMs: duration(ts.parse_started_at, ts.message_normalized_at ?? ts.telegram_message_received_at) },
    { key: 'parse_completed_at', label: 'Parse completed', at: ts.parse_completed_at, offsetMs: null, durationMs: duration(ts.parse_completed_at, ts.parse_started_at) },
    { key: 't_stage1_done_at', label: 'Stage 1 — deterministic regex decision', at: ts.t_stage1_done_at, offsetMs: null, durationMs: duration(ts.t_stage1_done_at, ts.t_stage1_started_at ?? ts.parse_started_at) },
    { key: 't_stage2_done_at', label: 'Stage 2 — OSS context interpretation', at: ts.t_stage2_done_at, offsetMs: null, durationMs: duration(ts.t_stage2_done_at, ts.t_stage2_started_at) },
    { key: 't_stage3_done_at', label: 'Stage 3 — GPT-4o reconciliation', at: ts.t_stage3_done_at, offsetMs: null, durationMs: duration(ts.t_stage3_done_at, ts.t_stage3_started_at) },
    { key: 'signal_persist_completed_at', label: 'Signal persisted', at: ts.signal_persist_completed_at, offsetMs: null, durationMs: duration(ts.signal_persist_completed_at, ts.signal_persist_started_at ?? ts.parse_completed_at) },
    { key: 'queue_published_at', label: 'Queue published', at: ts.queue_published_at, offsetMs: null, durationMs: duration(ts.queue_published_at, ts.queue_publish_started_at ?? ts.signal_persist_completed_at) },
    { key: 'queue_consumed_at', label: 'Queue consumed', at: ts.queue_consumed_at, offsetMs: null, durationMs: duration(ts.queue_consumed_at, ts.queue_published_at) },
    { key: 'execution_planning_completed_at', label: 'Execution planned', at: ts.execution_planning_completed_at, offsetMs: null, durationMs: duration(ts.execution_planning_completed_at, ts.execution_planning_started_at ?? ts.queue_consumed_at) },
    { key: 'execution_claim_acquired_at', label: 'Execution claim acquired', at: ts.execution_claim_acquired_at, offsetMs: null, durationMs: duration(ts.execution_claim_acquired_at, ts.execution_claim_started_at) },
    { key: 'broker_ready_at', label: 'Broker session ready', at: ts.broker_ready_at, offsetMs: null, durationMs: duration(ts.broker_ready_at, ts.broker_resolution_started_at ?? ts.execution_planning_completed_at) },
    { key: 'broker_request_started_at', label: 'Broker request sent', at: ts.broker_request_started_at, offsetMs: null, durationMs: duration(ts.broker_request_started_at, ts.broker_ready_at ?? ts.execution_planning_completed_at) },
    { key: 'broker_response_received_at', label: 'Broker response received', at: ts.broker_response_received_at, offsetMs: null, durationMs: duration(ts.broker_response_received_at, ts.broker_request_started_at) },
    { key: 'broker_execution_confirmed_at', label: 'Execution confirmed', at: ts.broker_execution_confirmed_at, offsetMs: null, durationMs: duration(ts.broker_execution_confirmed_at, ts.broker_request_started_at) },
    { key: 'execution_state_persisted_at', label: 'Execution state persisted', at: ts.execution_state_persisted_at, offsetMs: null, durationMs: duration(ts.execution_state_persisted_at, ts.broker_execution_confirmed_at ?? ts.broker_response_received_at) },
    { key: 'reconciliation_completed_at', label: 'Reconciliation completed', at: ts.reconciliation_completed_at, offsetMs: null, durationMs: duration(ts.reconciliation_completed_at, ts.reconciliation_started_at ?? ts.execution_state_persisted_at) },
  ];

  let t0 = pick(ts, 'telegram_source_message_at', 'telegram_message_received_at');
  if (t0 == null) {
    const first = events.find(e => e.at != null);
    t0 = first?.at ?? null;
  }

  for (const event of events) {
    event.offsetMs = event.at != null && t0 != null ? Math.max(0, event.at - t0) : null;
  }

  return events.filter(e => e.at != null || e.key === 'telegram_source_message_at');
}

export const STAGE_STAT_LABELS: Record<string, string> = {
  telegram_to_listener_ms: 'Telegram → listener',
  parse_ms: 'Parse',
  stage1_ms: 'Stage 1 — deterministic',
  stage2_ms: 'Stage 2 — OSS (Cerebras/OpenAI)',
  stage3_ms: 'Stage 3 — GPT-4o',
  signal_persist_ms: 'Signal persist',
  dispatch_ms: 'Dispatch to queue',
  queue_wait_ms: 'Queue wait',
  prep_ms: 'Pre-execution prep',
  planning_ms: 'Execution planning',
  execution_claim_ms: 'Execution claim',
  order_send_ms: 'Order send (planning→persist)',
  broker_send_ms: 'Broker request/response',
  broker_ack_ms: 'Broker ack (request→confirmed)',
  broker_resolve_ms: 'Broker session resolve',
  reconciliation_ms: 'Reconciliation',
  telegram_receipt_to_broker_request_ms: 'Receipt → broker request',
  telegram_receipt_to_broker_confirmation_ms: 'Receipt → broker confirmation',
  total_ms: 'Total (source → done)',
};

export function stageStats(ts: Record<string, number>): PipelineStageStat[] {
  const durations = computeStageDurations(ts);
  return Object.entries(durations)
    .filter(([, value]) => value != null)
    .map(([key, value]) => ({
      key,
      label: STAGE_STAT_LABELS[key] ?? key,
      value,
    }));
}
