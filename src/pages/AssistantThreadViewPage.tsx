import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { Card } from '../components/ui/Card';
import { UserLink } from '../components/UserLink';
import { ArrowLeft, AlertTriangle, User, Sparkles } from 'lucide-react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  tool_results?: Array<{ tool: string; result: string }>;
}

interface ThreadData {
  id: string;
  user_id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export function AssistantThreadViewPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      const { data, error: qErr } = await adminSupabase
        .from('assistant_threads')
        .select('id, user_id, title, messages, created_at, updated_at')
        .eq('id', threadId)
        .maybeSingle();

      if (cancelled) return;
      if (qErr) { setError(qErr.message); setLoading(false); return; }
      if (!data) { setError('Thread not found'); setLoading(false); return; }

      setThread(data as ThreadData);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [threadId]);

  if (loading) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center gap-2">
          <Link to="/assistant-chats" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="skeleton h-6 w-48" />
        </div>
        <Card>
          <div className="space-y-4 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <div className="skeleton h-8 w-8 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-24" />
                  <div className="skeleton h-16 w-full rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  if (error || !thread) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center gap-2">
          <Link to="/assistant-chats" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <span className="text-sm font-medium text-slate-600 dark:text-slate-300">Assistant Chat</span>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-sm border border-red-200 dark:border-red-800">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error ?? 'Thread not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Link to="/assistant-chats" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="page-title truncate">{thread.title || '(untitled)'}</h1>
          <div className="flex items-center gap-3 text-xs text-slate-400 mt-0.5">
            <UserLink userId={thread.user_id} />
            <span>·</span>
            <span>{thread.messages.length} messages</span>
            <span>·</span>
            <span>{formatDate(thread.updated_at)}</span>
          </div>
        </div>
      </div>

      <Card padding="none">
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {thread.messages.map((msg, idx) => (
            <MessageBubble key={idx} message={msg} />
          ))}
          {thread.messages.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-sm">
              No messages in this thread.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>({});

  const toggleTool = (i: number) => {
    setExpandedTools(prev => ({ ...prev, [i]: !prev[i] }));
  };

  return (
    <div className={`flex gap-3 px-4 py-4 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-emerald-100 dark:bg-emerald-900/50">
          <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        </div>
      )}
      <div className={`max-w-[75%] min-w-0 ${isUser ? 'order-1' : ''}`}>
        <p className={`text-xs font-medium mb-1 ${isUser ? 'text-right text-blue-600 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {isUser ? 'User' : 'Assistant'}
        </p>
        <div className={`whitespace-pre-wrap break-words text-sm leading-relaxed rounded-xl px-4 py-3 ${
          isUser
            ? 'bg-blue-50 text-blue-900 dark:bg-blue-950/60 dark:text-blue-100 border border-blue-200 dark:border-blue-800'
            : 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100 border border-emerald-200 dark:border-emerald-800'
        }`}>
          {renderContent(message.content)}
        </div>

        {message.images && message.images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={img}
                alt={`Image ${i + 1}`}
                className="max-w-[200px] max-h-[150px] rounded-lg border border-slate-200 dark:border-slate-700 object-cover"
              />
            ))}
          </div>
        )}

        {message.tool_results && message.tool_results.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.tool_results.map((tr, i) => (
              <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                <button
                  onClick={() => toggleTool(i)}
                  className="w-full text-left px-3 py-2 bg-slate-50 dark:bg-slate-800 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors flex items-center justify-between"
                >
                  <span>Tool: {tr.tool}</span>
                  <span className="text-slate-400">{expandedTools[i] ? '▼' : '▶'}</span>
                </button>
                {expandedTools[i] && (
                  <pre className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900 overflow-x-auto max-h-64 overflow-y-auto">
                    {formatToolResult(tr.result)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function renderContent(content: string): React.ReactNode {
  if (!content) return null;

  const parts = content.split(/(\n)/g);
  return parts.map((part, i) => {
    if (part === '\n') return <br key={i} />;
    return <span key={i}>{part}</span>;
  });
}

function formatToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return result;
  }
}
