export const PAUSE_REASON_LABELS: Record<string, string> = {
  user_paused: 'User action',
  trial_expired: 'Trial expired',
  payment_failed: 'Payment failed',
  subscription_ended: 'Subscription ended',
  admin: 'Admin',
  unknown: 'Unknown',
  unrecorded: 'Not recorded',
};

export function pauseReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Not recorded';
  return PAUSE_REASON_LABELS[reason] ?? reason;
}
