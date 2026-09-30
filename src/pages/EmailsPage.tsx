import { useCallback, useEffect, useMemo, useState } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Mail, Send, Eye } from 'lucide-react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { buildBroadcastPreviewHtml } from '../lib/broadcastEmailPreview';
import { formatDate } from '../lib/formatters';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Alert } from '../components/ui/Alert';
import { Modal } from '../components/ui/Modal';

const SEGMENTS = [
  { value: 'all', label: 'All users' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'basic', label: 'Basic' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'past_due', label: 'Past Due' },
  { value: 'copier_paused', label: 'Copier Paused' },
  { value: 'copier_engine_offline', label: 'Copier Engine Offline' },
  { value: 'no_active_subscription', label: 'No active subscription' },
] as const;

type Segment = typeof SEGMENTS[number]['value'];

interface PreviewResponse {
  count?: number;
  skipped_unsubscribed?: number;
  skipped_no_email?: number;
  error?: string;
}

interface SendResponse {
  success?: boolean;
  email?: string;
  broadcast_id?: string;
  sent?: number;
  already_sent?: number;
  skipped_unsubscribed?: number;
  skipped_no_email?: number;
  failed?: number;
  failures?: { user_id: string; error: string }[];
  error?: string;
}

interface LogRow {
  id: string;
  sent_at: string;
  metadata: {
    broadcast_id?: string;
    segment?: string;
    subject?: string;
    status?: string;
  } | null;
}

interface BroadcastGroup {
  id: string;
  subject: string;
  segment: string;
  segmentValue: string;
  sentAt: string;
  count: number;
}

const SEGMENT_LABEL = Object.fromEntries(SEGMENTS.map((item) => [item.value, item.label]));

async function readInvokeError(error: unknown, fallback?: { error?: string } | null): Promise<string> {
  if (fallback?.error) return fallback.error;
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json();
      if (body && typeof body === 'object' && typeof (body as { error?: string }).error === 'string') {
        return (body as { error: string }).error;
      }
    } catch {
      // fall through
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Request failed';
}

export function EmailsPage() {
  const [segment, setSegment] = useState<Segment>('all');
  const [subject, setSubject] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState<'test' | 'send' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewSubject, setPreviewSubject] = useState('');
  const [result, setResult] = useState<{ variant: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [retryBroadcastId, setRetryBroadcastId] = useState<string | null>(null);
  const [history, setHistory] = useState<BroadcastGroup[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data } = await adminSupabase
      .from('email_campaign_log')
      .select('id, sent_at, metadata')
      .eq('campaign_type', 'broadcast')
      .order('sent_at', { ascending: false })
      .limit(1000);

    const groups = new Map<string, BroadcastGroup>();
    for (const row of (data ?? []) as LogRow[]) {
      const id = row.metadata?.broadcast_id || row.id;
      const existing = groups.get(id);
      if (existing) {
        if (row.metadata?.status !== 'failed') existing.count += 1;
        if (row.sent_at > existing.sentAt) existing.sentAt = row.sent_at;
        continue;
      }
      groups.set(id, {
        id,
        subject: row.metadata?.subject || 'Untitled',
        segment: SEGMENT_LABEL[row.metadata?.segment ?? ''] ?? row.metadata?.segment ?? '—',
        segmentValue: row.metadata?.segment ?? '',
        sentAt: row.sent_at,
        count: row.metadata?.status === 'failed' ? 0 : 1,
      });
    }
    setHistory([...groups.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 20));
    setHistoryLoading(false);
  }, []);

  const refreshPreview = useCallback(async (nextSegment: Segment) => {
    setPreviewLoading(true);
    const { data, error } = await adminSupabase.functions.invoke<PreviewResponse>('send-broadcast-email', {
      body: { mode: 'preview', segment: nextSegment },
    });
    setPreviewLoading(false);
    if (error || data?.error) {
      setPreview(null);
      setResult({ variant: 'error', text: await readInvokeError(error, data) });
      return;
    }
    setPreview(data);
  }, []);

  useEffect(() => {
    refreshPreview(segment);
  }, [segment, refreshPreview]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const canCompose = subject.trim() && title.trim() && message.trim();
  const recipientCount = preview?.count ?? 0;

  const payload = useMemo(() => ({
    segment,
    subject: subject.trim(),
    title: title.trim(),
    message: message.trim(),
    cta_label: ctaLabel.trim(),
    cta_url: ctaUrl.trim(),
  }), [segment, subject, title, message, ctaLabel, ctaUrl]);

  function openPreview() {
    setConfirming(false);
    setTestOpen(false);
    setPreviewSubject(subject.trim());
    setPreviewHtml(buildBroadcastPreviewHtml({
      title,
      message,
      ctaLabel,
      ctaUrl,
      displayName: sessionStorage.getItem('admin_display_name'),
    }));
    setPreviewOpen(true);
  }

  async function sendTest() {
    const email = testEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setResult({ variant: 'error', text: 'Enter a valid email address' });
      return;
    }
    setSending('test');
    setResult(null);
    setConfirming(false);
    const { data, error } = await adminSupabase.functions.invoke<SendResponse>('send-broadcast-email', {
      body: { ...payload, mode: 'test', test_email: email },
    });
    setSending(null);
    if (error || data?.error) {
      setResult({ variant: 'error', text: await readInvokeError(error, data) });
      return;
    }
    setResult({ variant: 'success', text: `Test email sent to ${data?.email ?? email}.` });
  }

  async function sendBroadcast(broadcastId?: string, segmentOverride?: Segment) {
    setSending('send');
    setResult(null);
    const { data, error } = await adminSupabase.functions.invoke<SendResponse>('send-broadcast-email', {
      body: {
        ...payload,
        segment: segmentOverride ?? payload.segment,
        mode: 'send',
        broadcast_id: broadcastId || undefined,
      },
    });
    setSending(null);
    setConfirming(false);
    if (error || data?.error) {
      setResult({ variant: 'error', text: await readInvokeError(error, data) });
      return;
    }
    const failed = data?.failed ?? 0;
    const sent = data?.sent ?? 0;
    const already = data?.already_sent ?? 0;
    const skipped = (data?.skipped_unsubscribed ?? 0) + (data?.skipped_no_email ?? 0);
    const firstFail = data?.failures?.[0]?.error;
    if (data?.broadcast_id && failed > 0) setRetryBroadcastId(data.broadcast_id);
    else setRetryBroadcastId(null);
    setResult({
      variant: failed > 0 && sent === 0 ? 'error' : failed > 0 ? 'warning' : 'success',
      text: `Sent ${sent}${already ? `. Already had it: ${already}` : ''}. Skipped ${skipped}. Failed ${failed}${firstFail ? ` — ${firstFail}` : ''}.`,
    });
    loadHistory();
    refreshPreview(segment);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Emails</h1>
        <p className="page-subtitle">Send a newsletter or announcement to one audience</p>
      </div>

      {result && <Alert variant={result.variant}>{result.text}</Alert>}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2" padding="none">
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Compose</h2>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select
              label="Audience"
              value={segment}
              options={SEGMENTS.map((item) => ({ value: item.value, label: item.label }))}
              onChange={(e) => {
                setSegment(e.target.value as Segment);
                setConfirming(false);
              }}
            />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {previewLoading
                ? 'Counting recipients…'
                : `${recipientCount.toLocaleString()} will receive this email`}
              {preview && (preview.skipped_unsubscribed ?? 0) > 0
                ? ` · ${preview.skipped_unsubscribed} unsubscribed`
                : ''}
              {preview && (preview.skipped_no_email ?? 0) > 0
                ? ` · ${preview.skipped_no_email} without an email`
                : ''}
            </p>
            <Input label="Subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder="What the inbox shows" />
            <Input label="Heading" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Heading inside the email" />
            <div className="flex flex-col gap-1">
              <label htmlFor="email-message" className="text-xs font-medium text-slate-600 dark:text-slate-400">Message</label>
              <textarea
                id="email-message"
                value={message}
                maxLength={20000}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Write the announcement. Blank lines start a new paragraph."
                className="input-base min-h-[180px] resize-y"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Button label (optional)" value={ctaLabel} maxLength={80} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Open the app" />
              <Input label="Button link (optional)" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://app.tscopier.ai" />
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!canCompose || sending != null}
                onClick={() => {
                  setConfirming(false);
                  setTestOpen((open) => !open);
                }}
              >
                <Mail className="w-4 h-4" /> Send test
              </Button>
              <Button variant="secondary" size="sm" disabled={!canCompose || sending != null} onClick={openPreview}>
                <Eye className="w-4 h-4" /> Preview
              </Button>
              {!confirming ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canCompose || sending != null || previewLoading || recipientCount === 0}
                  onClick={() => setConfirming(true)}
                >
                  <Send className="w-4 h-4" /> Send
                </Button>
              ) : (
                <>
                  <Button variant="primary" size="sm" loading={sending === 'send'} disabled={sending != null} onClick={() => sendBroadcast()}>
                    Send to {recipientCount.toLocaleString()} {SEGMENT_LABEL[segment]}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={sending != null} onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
            {retryBroadcastId && canCompose && (
              <Button
                variant="secondary"
                size="sm"
                loading={sending === 'send'}
                disabled={sending != null}
                onClick={() => sendBroadcast(retryBroadcastId)}
              >
                Send to failed recipients
              </Button>
            )}
            {testOpen && (
              <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                <div className="flex-1">
                  <Input
                    label="Test email"
                    type="email"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    placeholder="name@example.com"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={sending === 'test'}
                  disabled={!canCompose || sending != null || !testEmail.trim()}
                  onClick={sendTest}
                >
                  Send test
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card padding="none">
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Recent sends</h2>
          </CardHeader>
          <div className="divide-y divide-slate-200 dark:divide-slate-700">
            {historyLoading ? (
              <p className="p-6 text-sm text-slate-400">Loading…</p>
            ) : history.length === 0 ? (
              <p className="p-6 text-sm text-slate-400">No broadcasts yet</p>
            ) : history.map((item) => (
              <div key={item.id} className="px-6 py-3">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{item.subject}</p>
                <p className="text-xs text-slate-400 mt-1">
                  {item.segment} · {item.count.toLocaleString()} sent · {formatDate(item.sentAt)}
                </p>
                <button
                  type="button"
                  className="mt-2 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline disabled:opacity-50"
                  disabled={!canCompose || sending != null}
                  onClick={() => {
                    const nextSegment = SEGMENTS.some((entry) => entry.value === item.segmentValue)
                      ? item.segmentValue as Segment
                      : undefined;
                    if (nextSegment) setSegment(nextSegment);
                    sendBroadcast(item.id, nextSegment);
                  }}
                >
                  Send to people who did not get this
                </button>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Email preview"
        subtitle={previewSubject}
        className="sm:max-w-3xl"
      >
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={previewHtml}
          className="w-full h-[70vh] rounded-lg border border-slate-200 dark:border-slate-700 bg-white"
        />
      </Modal>
    </div>
  );
}
