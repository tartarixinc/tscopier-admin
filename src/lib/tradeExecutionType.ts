export interface TradeExecutionEvidenceLog {
  action: string;
  status: string;
  request_payload: unknown;
  response_payload: unknown;
}

export type TradeExecutionType =
  | 'single'
  | 'range'
  | 'range + layered'
  | 'layered'
  | 'multi'
  | 'duplicate replay candidate'
  | 'unknown';

function successfulOrderComment(logs: TradeExecutionEvidenceLog[], ticket: string | null): string {
  const orderLogs = logs.filter(log => log.action === 'order_send' && log.status === 'success');
  const matching = orderLogs.find(log => {
    const response = log.response_payload as { ticket?: unknown } | null;
    return ticket != null && response?.ticket != null && String(response.ticket) === ticket;
  });
  const log = matching ?? orderLogs[0];
  const request = log?.request_payload as { comment?: unknown } | null;
  return typeof request?.comment === 'string' ? request.comment.toLowerCase() : '';
}

export function classifyTradeExecutionType({
  logs,
  ticket,
  linkedTradeCount,
  duplicateSignature,
}: {
  logs: TradeExecutionEvidenceLog[];
  ticket: string | null;
  linkedTradeCount: number;
  duplicateSignature?: boolean;
}): TradeExecutionType {
  const comment = successfulOrderComment(logs, ticket);
  const rangeEvidence = logs.some(log =>
    ['virtual_pending_fired', 'range_basket_tp_rebalance', 'range_broker_pending_inserted', 'multi_range_plan'].includes(log.action),
  );

  if (comment.includes(':rg') && (comment.includes(':tp') || comment.includes('layer_'))) return 'range + layered';
  if (comment.includes(':rg') || rangeEvidence) return 'range';
  if (comment.includes(':tp') || comment.includes('layer_')) return 'layered';
  if (duplicateSignature && linkedTradeCount > 1) return 'duplicate replay candidate';
  if (linkedTradeCount > 1) return 'multi';
  if (logs.some(log => log.action === 'order_send' && log.status === 'success')) return 'single';
  return 'unknown';
}
