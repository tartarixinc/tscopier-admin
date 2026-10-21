export const CHART_COLORS = {
  primary: '#14b8a6',
  secondary: '#0d9488',
  accent: '#5eead4',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#3b82f6',
  purple: '#8b5cf6',
  pink: '#ec4899',
  orange: '#f97316',
};

export const CHART_PALETTE = [
  CHART_COLORS.primary,
  CHART_COLORS.info,
  CHART_COLORS.warning,
  CHART_COLORS.error,
  CHART_COLORS.success,
  CHART_COLORS.purple,
  CHART_COLORS.pink,
  CHART_COLORS.orange,
  CHART_COLORS.secondary,
  CHART_COLORS.accent,
];

export const STATUS_COLORS: Record<string, string> = {
  pending: CHART_COLORS.warning,
  parsed: CHART_COLORS.info,
  executed: CHART_COLORS.success,
  skipped: '#94a3b8',
  failed: CHART_COLORS.error,
  open: CHART_COLORS.primary,
  closed: '#94a3b8',
  connected: CHART_COLORS.success,
  error: CHART_COLORS.error,
  active: CHART_COLORS.success,
  inactive: '#94a3b8',
  basic: CHART_COLORS.info,
  advanced: CHART_COLORS.primary,
  trialing: CHART_COLORS.purple,
  past_due: CHART_COLORS.warning,
  canceled: '#94a3b8',
  incomplete: CHART_COLORS.pink,
  incomplete_expired: '#64748b',
  unpaid: CHART_COLORS.error,
  unknown: '#475569',
};

export const REASON_COLORS: Record<string, string> = {
  user_paused: CHART_COLORS.info,
  trial_expired: CHART_COLORS.purple,
  payment_failed: CHART_COLORS.error,
  subscription_ended: '#94a3b8',
  admin: CHART_COLORS.warning,
  unknown: '#64748b',
  unrecorded: '#475569',
};

export const tooltipStyle = {
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#f1f5f9',
  fontSize: 12,
};

export const tooltipItemStyle = {
  color: '#f1f5f9',
};

export const tooltipLabelStyle = {
  color: '#cbd5e1',
};

export const gridStyle = {
  strokeDasharray: '3 3',
  stroke: '#334155',
};

export const axisStyle = {
  tick: { fill: '#94a3b8', fontSize: 11 },
  tickLine: false as const,
  axisLine: { stroke: '#334155' },
};
