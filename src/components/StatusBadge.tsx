import { Badge } from './ui/Badge';

// Re-exporting as type since Badge doesn't export it directly
type Variant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary' | 'muted';

const STATUS_MAP: Record<string, Variant> = {
  // connection_status
  connected: 'success',
  error: 'error',
  pending: 'warning',
  pending_open: 'warning',
  disconnected: 'muted',
  // signal status
  parsed: 'info',
  executed: 'success',
  skipped: 'warning',
  failed: 'error',
  // trade status
  open: 'primary',
  closed: 'muted',
  cancelled: 'muted',
  // subscription status
  active: 'success',
  trialing: 'info',
  past_due: 'warning',
  canceled: 'muted',
  incomplete: 'warning',
  incomplete_expired: 'error',
  // subscription plan
  basic: 'info',
  advanced: 'primary',
  // trade direction
  buy: 'success',
  // copier log status
  success: 'success',
  // generic
  true: 'success',
  false: 'muted',
  // backtest status
  running: 'warning',
  completed: 'success',
  // listener engine
  active_session: 'success',
  online: 'success',
  offline: 'error',
};

interface StatusBadgeProps {
  status: string | boolean | null | undefined;
  dot?: boolean;
}

export function StatusBadge({ status, dot }: StatusBadgeProps) {
  if (status === null || status === undefined) return <span className="text-slate-400 text-xs">—</span>;
  const str = String(status);
  const variant = STATUS_MAP[str.toLowerCase()] ?? 'default';
  return <Badge variant={variant} dot={dot}>{str}</Badge>;
}
