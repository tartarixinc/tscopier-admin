import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Bot, Send, Sparkles, Trash2, X } from 'lucide-react';
import {
  buildHealthAssistantSnapshot,
  sendHealthAssistantQuestion,
  type HealthAssistantTurn,
} from '../lib/healthAssistant';
import type { MonitoringOverlay } from '../lib/monitoringOverlay';
import type { SystemHealthReport, VerdictState } from '../lib/systemHealth';

const QUICK_PROMPTS = [
  'What needs attention first?',
  'Explain the current verdict',
  'Why are trades failing?',
  'Are the workers healthy?',
];

const MAX_QUESTION_CHARS = 2000;

const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-4 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-4 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  code: ({ children }) => (
    <code className="rounded bg-slate-200 dark:bg-slate-700 px-1 py-0.5 text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-slate-900 text-slate-100 dark:bg-slate-950 p-2 text-xs">
      {children}
    </pre>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary-600 dark:text-primary-400 underline">
      {children}
    </a>
  ),
  h1: ({ children }) => <h3 className="my-1 text-sm font-bold">{children}</h3>,
  h2: ({ children }) => <h3 className="my-1 text-sm font-bold">{children}</h3>,
  h3: ({ children }) => <h4 className="my-1 font-semibold">{children}</h4>,
  h4: ({ children }) => <h4 className="my-1 font-semibold">{children}</h4>,
  table: ({ children }) => <table className="my-1 text-xs border-collapse">{children}</table>,
  th: ({ children }) => <th className="border border-slate-300 dark:border-slate-600 px-1.5 py-0.5 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-slate-300 dark:border-slate-600 px-1.5 py-0.5">{children}</td>,
};

interface Props {
  report: SystemHealthReport;
  verdict: { state: VerdictState; sentence: string };
  overlay: MonitoringOverlay | null;
  envLabel: string;
}

export function HealthAssistantPanel({ report, verdict, overlay, envLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<HealthAssistantTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Let the modals own Escape while one is open on top of the panel.
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  const send = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: q }]);

    try {
      const snapshot = await buildHealthAssistantSnapshot(report, verdict, overlay, envLabel);
      const history = messages.slice(-10);
      const reply = await sendHealthAssistantQuestion({ question: q, history, snapshot });
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Drop the optimistic user bubble so a retry does not duplicate it,
      // and put the question back only if the input is still empty.
      setMessages(prev => prev.slice(0, -1));
      setInput(prev => prev || q);
    } finally {
      setBusy(false);
    }
  }, [busy, report, verdict, overlay, envLabel, messages]);

  const snapshotAgeSec = Math.max(0, Math.round((Date.now() - report.fetchedAt) / 1000));

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open health assistant"
        title="Ask the health assistant"
        className="fixed bottom-6 right-6 z-40 h-12 w-12 rounded-full bg-primary-600 text-white shadow-lg hover:bg-primary-700 transition-colors flex items-center justify-center"
      >
        <Sparkles className="w-5 h-5" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 w-[400px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100vh-6rem)] card shadow-xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-700 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="w-4 h-4 text-primary-600 dark:text-primary-400 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">Health assistant</p>
            <p className="text-[11px] text-slate-400 truncate">
              {envLabel} · snapshot {snapshotAgeSec}s old · read-only
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => { setMessages([]); setError(null); setInput(''); }}
            aria-label="Clear conversation"
            title="Clear conversation"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close health assistant"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div ref={listRef} role="log" aria-live="polite" aria-label="Assistant conversation" className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && !busy && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Ask anything about the current health snapshot — what is failing, why, and what to check first.
              It cannot take actions or see data outside this snapshot.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_PROMPTS.map(p => (
                <button
                  key={p}
                  onClick={() => void send(p)}
                  className="px-2.5 py-1 text-xs rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-primary-300 hover:text-primary-700 dark:hover:text-primary-300 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[90%] rounded-xl px-3 py-2 text-sm break-words ${
                m.role === 'user'
                  ? 'bg-primary-600 text-white'
                  : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100'
              }`}
            >
              {m.role === 'user' ? (
                <p className="whitespace-pre-wrap">{m.content}</p>
              ) : (
                <div className="leading-relaxed">
                  <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{m.content}</Markdown>
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex justify-start">
            <div className="rounded-xl bg-slate-100 dark:bg-slate-800 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
              Reading the snapshot…
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs text-error-600 dark:text-error-400">{error}</p>
        )}
      </div>

      <div className="border-t border-slate-200 dark:border-slate-700 px-3 py-2.5 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Ask about the current health state…"
            aria-label="Question for the health assistant"
            rows={2}
            maxLength={MAX_QUESTION_CHARS}
            className="flex-1 resize-none rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-sm"
          />
          <button
            onClick={() => void send(input)}
            disabled={busy || !input.trim()}
            aria-label="Send question"
            className="p-2 rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
