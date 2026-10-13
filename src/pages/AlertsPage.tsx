import { useCallback, useEffect, useState } from 'react';
import { authSupabase } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Alert } from '../components/ui/Alert';
import {
  acknowledgeAlert,
  deleteAlertRecipient,
  updateAlertRule,
  upsertAlertRecipient,
  type AlertEventRow,
  type AlertRecipientRow,
  type AlertRuleRow,
} from '../lib/monitoringOverlay';

const SEVERITIES = ['info', 'warning', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

const SEVERITY_PILL: Record<Severity, string> = {
  critical: 'bg-error-100 text-error-700 dark:bg-error-900/50 dark:text-error-300',
  warning: 'bg-warning-100 text-warning-700 dark:bg-warning-900/50 dark:text-warning-300',
  info: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

const STATE_PILL: Record<string, string> = {
  firing: 'bg-error-100 text-error-700 dark:bg-error-900/50 dark:text-error-300',
  acknowledged: 'bg-warning-100 text-warning-700 dark:bg-warning-900/50 dark:text-warning-300',
  resolved: 'bg-success-100 text-success-700 dark:bg-success-900/50 dark:text-success-300',
};

function SeverityPill({ severity }: { severity: string }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${SEVERITY_PILL[severity as Severity] ?? SEVERITY_PILL.info}`}>
      {severity}
    </span>
  );
}

interface RuleEditState {
  code: string;
  name: string;
  description: string;
  severity: Severity;
  enabled: boolean;
  thresholdText: string;
  windowMinutes: string;
  cooldownSeconds: string;
  reason: string;
}

export function AlertsPage() {
  const [rules, setRules] = useState<AlertRuleRow[]>([]);
  const [events, setEvents] = useState<AlertEventRow[]>([]);
  const [openAlerts, setOpenAlerts] = useState<AlertEventRow[]>([]);
  const [recipients, setRecipients] = useState<AlertRecipientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editRule, setEditRule] = useState<RuleEditState | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [ackEvent, setAckEvent] = useState<AlertEventRow | null>(null);
  const [ackReason, setAckReason] = useState('');

  const [newEmail, setNewEmail] = useState('');
  const [newMinSeverity, setNewMinSeverity] = useState<Severity>('warning');
  const [recipientError, setRecipientError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [rulesRes, openRes, eventsRes, recipRes] = await Promise.all([
      authSupabase.from('alert_rules').select('*').order('code'),
      // Open alerts have no date filter: an event firing for more than seven
      // days must stay visible here.
      authSupabase
        .from('alert_events')
        .select('*')
        .in('state', ['firing', 'acknowledged'])
        .order('created_at', { ascending: false })
        .limit(50),
      authSupabase
        .from('alert_events')
        .select('*')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200),
      authSupabase.from('alert_recipients').select('*').order('email'),
    ]);
    const firstError = rulesRes.error ?? openRes.error ?? eventsRes.error ?? recipRes.error;
    if (firstError) {
      setReadError(firstError.message);
    } else {
      setReadError(null);
      setRules(rulesRes.data ?? []);
      setOpenAlerts(openRes.data ?? []);
      setEvents(eventsRes.data ?? []);
      setRecipients(recipRes.data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const firingCount = openAlerts.filter(e => e.state === 'firing').length;
  const ackCount = openAlerts.length - firingCount;

  function startEdit(rule: AlertRuleRow) {
    setEditError(null);
    setEditRule({
      code: rule.code,
      name: rule.name,
      description: rule.description,
      severity: rule.severity,
      enabled: rule.enabled,
      thresholdText: JSON.stringify(rule.threshold, null, 2),
      windowMinutes: String(rule.window_minutes),
      cooldownSeconds: String(rule.cooldown_seconds),
      reason: '',
    });
  }

  async function saveRule() {
    if (!editRule) return;
    const reason = editRule.reason.trim();
    if (!reason) {
      setEditError('A reason is required — it is written to the audit log.');
      return;
    }
    let threshold: Record<string, unknown>;
    try {
      threshold = JSON.parse(editRule.thresholdText);
      if (threshold === null || typeof threshold !== 'object' || Array.isArray(threshold)) {
        throw new Error('threshold must be a JSON object');
      }
    } catch (err) {
      setEditError(`Threshold is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const windowMinutes = Number(editRule.windowMinutes);
    const cooldownSeconds = Number(editRule.cooldownSeconds);
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
      setEditError('Window must be a whole number of minutes between 1 and 1440.');
      return;
    }
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 86400) {
      setEditError('Cooldown must be whole seconds between 0 and 86400.');
      return;
    }
    setBusy(true);
    setEditError(null);
    try {
      await updateAlertRule(editRule.code, {
        name: editRule.name.trim() || editRule.code,
        description: editRule.description.trim(),
        severity: editRule.severity,
        enabled: editRule.enabled,
        threshold,
        window_minutes: windowMinutes,
        cooldown_seconds: cooldownSeconds,
      }, reason);
      setNotice(`Rule ${editRule.code} updated.`);
      setEditRule(null);
      await refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitAck() {
    if (!ackEvent) return;
    const reason = ackReason.trim() || 'acknowledged from Alerts console';
    setBusy(true);
    setEditError(null);
    try {
      await acknowledgeAlert(ackEvent.id, reason);
      setNotice('Alert acknowledged — re-firing is muted until the condition clears.');
      setAckEvent(null);
      setAckReason('');
      await refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addRecipient() {
    const email = newEmail.trim();
    if (!email || !email.includes('@')) {
      setRecipientError('Enter a valid email address.');
      return;
    }
    setRecipientError(null);
    setBusy(true);
    try {
      await upsertAlertRecipient({ email, min_severity: newMinSeverity, enabled: true });
      setNotice(`Recipient ${email} added.`);
      setNewEmail('');
      await refresh();
    } catch (err) {
      setRecipientError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecipient(r: AlertRecipientRow) {
    setRecipientError(null);
    setBusy(true);
    try {
      await upsertAlertRecipient({ email: r.email, min_severity: r.min_severity, enabled: !r.enabled });
      await refresh();
    } catch (err) {
      setRecipientError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeRecipient(r: AlertRecipientRow) {
    if (!window.confirm(`Remove ${r.email} from alert emails?`)) return;
    setRecipientError(null);
    setBusy(true);
    try {
      await deleteAlertRecipient(r.id);
      setNotice(`Recipient ${r.email} removed.`);
      await refresh();
    } catch (err) {
      setRecipientError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const th = 'text-left text-xs font-semibold uppercase tracking-wide text-slate-400 px-3 py-2';
  const td = 'px-3 py-2 text-sm align-top';

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Alerts</h1>
        <p className="page-subtitle">
          Server-side rules evaluated every minute. {firingCount} firing, {ackCount} acknowledged.
        </p>
      </div>

      {readError && (
        <Alert variant="error" title="Alert tables unreadable">
          {readError} — apply the TSCopier alerting migration and the admin read-policy migration first.
        </Alert>
      )}
      {notice && (
        <Alert variant="success" title={notice}>
          <button className="underline text-xs" onClick={() => setNotice(null)}>dismiss</button>
        </Alert>
      )}

      {/* Open alerts — acknowledge in place. */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Open alerts</h2>
        </CardHeader>
        <CardContent>
          {openAlerts.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing firing. The evaluator runs every minute and emails recipients on new firings.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>State</th>
                    <th className={th}>Severity</th>
                    <th className={th}>Rule</th>
                    <th className={th}>Message</th>
                    <th className={th}>Since</th>
                    <th className={th}>Email</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {openAlerts.map(e => (
                    <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className={td}>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${STATE_PILL[e.state] ?? ''}`}>{e.state}</span>
                      </td>
                      <td className={td}><SeverityPill severity={e.severity} /></td>
                      <td className={td}>{rules.find(r => r.code === e.rule_code)?.name ?? e.rule_code}</td>
                      <td className={`${td} text-slate-500 dark:text-slate-300 max-w-[420px]`}>{e.message}</td>
                      <td className={`${td} text-xs text-slate-400`}>{formatDate(e.created_at)}</td>
                      <td className={`${td} text-xs text-slate-400`}>
                        {e.email_sent_at ? `sent ${formatDate(e.email_sent_at)}` : e.email_attempts > 0
                          ? e.state === 'resolved' ? `retry ${e.email_attempts}/5` : `retry ${e.email_attempts}`
                          : 'pending'}
                      </td>
                      <td className={td}>
                        {e.state === 'firing' && (
                          <button
                            onClick={() => { setEditError(null); setAckReason(''); setAckEvent(e); }}
                            className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            Acknowledge
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rules editor. */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Rules — thresholds live in the database, not in code
          </h2>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="skeleton h-40 w-full" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Rule</th>
                    <th className={th}>Severity</th>
                    <th className={th}>On</th>
                    <th className={th}>Threshold</th>
                    <th className={th}>Window</th>
                    <th className={th}>Cooldown</th>
                    <th className={th}>Updated</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(r => (
                    <tr key={r.code} className="border-t border-slate-100 dark:border-slate-800">
                      <td className={td}>
                        <p className="font-medium">{r.name}</p>
                        <p className="text-[11px] font-mono text-slate-400">{r.code}</p>
                        <p className="text-[11px] text-slate-400 max-w-[320px]">{r.description}</p>
                      </td>
                      <td className={td}><SeverityPill severity={r.severity} /></td>
                      <td className={td}>
                        <span className={`text-xs font-medium ${r.enabled ? 'text-success-600 dark:text-success-400' : 'text-slate-400'}`}>
                          {r.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </td>
                      <td className={`${td} font-mono text-[11px] text-slate-500 dark:text-slate-300 max-w-[240px] whitespace-pre-wrap`}>
                        {JSON.stringify(r.threshold)}
                      </td>
                      <td className={`${td} text-xs`}>{r.window_minutes}m</td>
                      <td className={`${td} text-xs`}>{r.cooldown_seconds >= 3600 ? `${(r.cooldown_seconds / 3600).toFixed(1)}h` : `${Math.round(r.cooldown_seconds / 60)}m`}</td>
                      <td className={`${td} text-xs text-slate-400`}>{formatDate(r.updated_at)}</td>
                      <td className={td}>
                        <button
                          onClick={() => startEdit(r)}
                          className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Event history. */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">History — last 7 days</h2>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-slate-400">No alerts in the last 7 days.</p>
          ) : (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full">
                <thead>
                  <tr className="sticky top-0 bg-white dark:bg-slate-900">
                    <th className={th}>State</th>
                    <th className={th}>Severity</th>
                    <th className={th}>Rule</th>
                    <th className={th}>Message</th>
                    <th className={th}>Fired</th>
                    <th className={th}>Resolved</th>
                    <th className={th}>Email</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map(e => (
                    <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className={td}>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${STATE_PILL[e.state] ?? ''}`}>{e.state}</span>
                      </td>
                      <td className={td}><SeverityPill severity={e.severity} /></td>
                      <td className={td}>{rules.find(r => r.code === e.rule_code)?.name ?? e.rule_code}</td>
                      <td className={`${td} text-slate-500 dark:text-slate-300 max-w-[380px]`} title={e.email_last_error ?? undefined}>
                        {e.message}
                      </td>
                      <td className={`${td} text-xs text-slate-400`}>{formatDate(e.created_at)}</td>
                      <td className={`${td} text-xs text-slate-400`}>{e.resolved_at ? formatDate(e.resolved_at) : '—'}</td>
                      <td className={`${td} text-xs`}>
                        {e.email_sent_at ? (
                          <span className="text-success-600 dark:text-success-400">sent</span>
                        ) : e.email_attempts > 0 ? (
                          <span className="text-warning-600 dark:text-warning-400" title={e.email_last_error ?? ''}>
                            retry {e.email_attempts}{e.state === 'resolved' ? '/5' : ''}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Email recipients. */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Email recipients</h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-slate-400">
            Delivered through Resend from TScopier &lt;alerts@tscopier.ai&gt;. Each recipient has a minimum severity — lower-priority alerts are skipped for that address.
          </p>
          {recipientError && <p className="text-xs text-error-600 dark:text-error-400">{recipientError}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              placeholder="ops@example.com"
              className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm min-w-[220px]"
            />
            <select
              value={newMinSeverity}
              onChange={e => setNewMinSeverity(e.target.value as Severity)}
              className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm"
            >
              {SEVERITIES.map(s => <option key={s} value={s}>min {s}</option>)}
            </select>
            <button
              onClick={() => void addRecipient()}
              disabled={busy}
              className="px-3 py-1.5 text-xs rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
            >
              Add recipient
            </button>
          </div>
          {recipients.length === 0 && !loading ? (
            <p className="text-sm text-warning-600 dark:text-warning-400">
              No recipients — firing emails have nowhere to go. Add at least one address.
            </p>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Email</th>
                  <th className={th}>Min severity</th>
                  <th className={th}>Enabled</th>
                  <th className={th}>Added</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {recipients.map(r => (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className={td}>{r.email}</td>
                    <td className={td}><SeverityPill severity={r.min_severity} /></td>
                    <td className={td}>
                      <span className={`text-xs font-medium ${r.enabled ? 'text-success-600 dark:text-success-400' : 'text-slate-400'}`}>
                        {r.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </td>
                    <td className={`${td} text-xs text-slate-400`}>{formatDate(r.created_at)}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      <button
                        onClick={() => void toggleRecipient(r)}
                        disabled={busy}
                        className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 mr-2"
                      >
                        {r.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => void removeRecipient(r)}
                        disabled={busy}
                        className="text-xs px-2 py-1 rounded border border-error-300 text-error-600 dark:text-error-400 hover:bg-error-50 dark:hover:bg-error-900/30 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Rule edit dialog. */}
      <Modal
        open={editRule !== null}
        onClose={() => setEditRule(null)}
        title={editRule ? `Edit rule: ${editRule.code}` : ''}
        subtitle="Thresholds apply on the next evaluator run (every minute)."
        className="sm:max-w-2xl"
      >
        {editRule && (
          <div className="space-y-3">
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
              Name
              <input
                value={editRule.name}
                onChange={e => setEditRule({ ...editRule, name: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
              Description
              <textarea
                value={editRule.description}
                onChange={e => setEditRule({ ...editRule, description: e.target.value })}
                rows={2}
                className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100"
              />
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
                Severity
                <select
                  value={editRule.severity}
                  onChange={e => setEditRule({ ...editRule, severity: e.target.value as Severity })}
                  className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-slate-900 dark:text-slate-100"
                >
                  {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
                Window (minutes)
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={editRule.windowMinutes}
                  onChange={e => setEditRule({ ...editRule, windowMinutes: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100"
                />
              </label>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
                Cooldown (seconds)
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={editRule.cooldownSeconds}
                  onChange={e => setEditRule({ ...editRule, cooldownSeconds: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100"
                />
              </label>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
                Enabled
                <select
                  value={editRule.enabled ? 'yes' : 'no'}
                  onChange={e => setEditRule({ ...editRule, enabled: e.target.value === 'yes' })}
                  className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-slate-900 dark:text-slate-100"
                >
                  <option value="yes">enabled</option>
                  <option value="no">disabled</option>
                </select>
              </label>
            </div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
              Threshold (JSON object — keys are documented in the evaluator source)
              <textarea
                value={editRule.thresholdText}
                onChange={e => setEditRule({ ...editRule, thresholdText: e.target.value })}
                rows={5}
                spellCheck={false}
                className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm font-mono text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
              Reason (required — written to the audit log)
              <input
                value={editRule.reason}
                onChange={e => setEditRule({ ...editRule, reason: e.target.value })}
                placeholder="e.g. tuning queue threshold after staging review"
                className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100"
              />
            </label>
            {editError && <p className="text-xs text-error-600 dark:text-error-400">{editError}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setEditRule(null)}
                className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveRule()}
                disabled={busy}
                className="px-3 py-1.5 text-xs rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save rule'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Acknowledge dialog. */}
      <Modal
        open={ackEvent !== null}
        onClose={() => setAckEvent(null)}
        title={ackEvent ? `Acknowledge: ${rules.find(r => r.code === ackEvent.rule_code)?.name ?? ackEvent.rule_code}` : ''}
        subtitle="Acknowledging mutes re-firing until the condition clears. The action is written to the audit log."
        className="sm:max-w-lg"
      >
        {ackEvent && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">{ackEvent.message}</p>
            <textarea
              value={ackReason}
              onChange={e => setAckReason(e.target.value)}
              placeholder="Reason (required) — e.g. investigating, expected maintenance"
              rows={2}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
            />
            {editError && <p className="text-xs text-error-600 dark:text-error-400">{editError}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAckEvent(null)}
                className="px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={() => void submitAck()}
                disabled={busy}
                className="px-3 py-1.5 text-xs rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {busy ? 'Acknowledging…' : 'Acknowledge'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
