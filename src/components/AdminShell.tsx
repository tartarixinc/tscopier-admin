import { useState, useEffect, useRef, useCallback } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Server, MessageSquare, Zap, TrendingUp,
  FlaskConical, LogOut,
  Search, UserCircle, Activity, DollarSign, Cog, Menu, X, AlertTriangle,
  Copy, Cpu
} from 'lucide-react';
import { ThemeToggle } from './ui/ThemeToggle';
import { authSupabase } from '../lib/adminSupabase';
import { shortId } from '../lib/formatters';
import clsx from 'clsx';

interface NavItem {
  label: string;
  to: string;
  icon: React.ElementType;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navigation: NavGroup[] = [
  {
    title: '',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard },
      { label: 'Copier Logs', to: '/copier-logs', icon: Copy },
    ],
  },
  {
    title: 'Users',
    items: [
      { label: 'All Users', to: '/users', icon: Users },
    ],
  },
  {
    title: 'Brokers',
    items: [
      { label: 'All Accounts', to: '/brokers', icon: Server },
      { label: 'Connection Errors', to: '/brokers/errors', icon: AlertTriangle },
    ],
  },
  {
    title: 'Telegram',
    items: [
      { label: 'Sessions', to: '/telegram/sessions', icon: MessageSquare },
      { label: 'Channels', to: '/telegram/channels', icon: MessageSquare },
      { label: 'Signal Profiles', to: '/telegram/profiles', icon: MessageSquare },
      { label: 'Auth Pending', to: '/telegram/auth-pending', icon: MessageSquare },
    ],
  },
  {
    title: 'Signals',
    items: [
      { label: 'All Signals', to: '/signals', icon: Zap },
      { label: 'Stats & Charts', to: '/signals/stats', icon: Zap },
    ],
  },
  {
    title: 'Trades',
    items: [
      { label: 'All Trades', to: '/trades', icon: TrendingUp },
      { label: 'Open Positions', to: '/trades/open', icon: TrendingUp },
      { label: 'Execution Logs', to: '/trades/execution-logs', icon: TrendingUp },
      { label: 'Analytics', to: '/trades/analytics', icon: TrendingUp },
    ],
  },
  {
    title: 'Backtesting',
    items: [
      { label: 'All Runs', to: '/backtests', icon: FlaskConical },
    ],
  },
  {
    title: 'Monitoring',
    items: [
      { label: 'Listener Events', to: '/monitoring/listener-events', icon: Activity },
      { label: 'Worker Leases', to: '/monitoring/workers', icon: Activity },
      { label: 'Copier Engine', to: '/monitoring/copier-engine', icon: Cpu },
      { label: 'Dead Letters', to: '/monitoring/dead-letters', icon: Activity },
    ],
  },
  {
    title: 'Affiliates',
    items: [
      { label: 'Affiliate Profiles', to: '/affiliates', icon: DollarSign },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Trading Presets', to: '/presets', icon: Cog },
      { label: 'App Settings', to: '/settings', icon: Cog },
    ],
  },
];

interface AdminShellProps {
  children: React.ReactNode;
}

interface SearchResult {
  category: 'user' | 'broker' | 'channel' | 'trade';
  id: string;
  label: string;
  sublabel: string;
  path: string;
}

export function AdminShell({ children }: AdminShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [globalSearch, setGlobalSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const adminName = sessionStorage.getItem('admin_display_name') ?? 'Admin';

  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchResults = useCallback(async (term: string) => {
    const t = term.trim();
    if (t.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);

    const isUuid = /^[0-9a-f]{8}-/i.test(t);
    const items: SearchResult[] = [];

    const [usersRes, brokersRes, channelsRes, tradesRes] = await Promise.all([
      authSupabase
        .from('user_profiles')
        .select('user_id, display_name')
        .or(isUuid ? `display_name.ilike.%${t}%,user_id.eq.${t}` : `display_name.ilike.%${t}%`)
        .order('created_at', { ascending: false })
        .limit(5),
      authSupabase
        .from('broker_accounts')
        .select('id, label, broker, user_id')
        .ilike('label', `%${t}%`)
        .limit(5),
      authSupabase
        .from('telegram_channels')
        .select('id, display_name, channel_username')
        .or(`display_name.ilike.%${t}%,channel_username.ilike.%${t}%`)
        .limit(5),
      authSupabase
        .from('trades')
        .select('id, symbol, side, user_id')
        .ilike('symbol', `%${t}%`)
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    (usersRes.data ?? []).forEach((u: any) => {
      items.push({
        category: 'user',
        id: u.user_id,
        label: u.display_name ?? 'Unnamed',
        sublabel: shortId(u.user_id),
        path: `/users/${u.user_id}`,
      });
    });

    (brokersRes.data ?? []).forEach((b: any) => {
      items.push({
        category: 'broker',
        id: b.id,
        label: b.label ?? 'Unnamed',
        sublabel: b.broker ?? '',
        path: `/brokers?search=${encodeURIComponent(b.label ?? '')}`,
      });
    });

    (channelsRes.data ?? []).forEach((c: any) => {
      items.push({
        category: 'channel',
        id: c.id,
        label: c.display_name ?? c.channel_username ?? 'Unnamed',
        sublabel: c.channel_username ? `@${c.channel_username}` : '',
        path: `/telegram/channels?search=${encodeURIComponent(c.display_name ?? c.channel_username ?? '')}`,
      });
    });

    (tradesRes.data ?? []).forEach((tr: any) => {
      items.push({
        category: 'trade',
        id: tr.id,
        label: tr.symbol,
        sublabel: tr.side ?? '',
        path: `/trades?search=${encodeURIComponent(tr.symbol)}`,
      });
    });

    setResults(items);
    setSearching(false);
  }, []);

  const handleSearchInput = (value: string) => {
    setGlobalSearch(value);
    setActiveIndex(-1);
    setShowResults(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResults(value), 250);
  };

  const selectResult = (result: SearchResult) => {
    setShowResults(false);
    setResults([]);
    setGlobalSearch('');
    navigate(result.path);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!showResults || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      selectResult(results[activeIndex]);
    } else if (e.key === 'Escape') {
      setShowResults(false);
    }
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (resultsRef.current && !resultsRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = globalSearch.trim();
    if (q) {
      if (activeIndex >= 0 && results[activeIndex]) {
        selectResult(results[activeIndex]);
      } else {
        setShowResults(false);
        setResults([]);
        navigate(`/users?search=${encodeURIComponent(q)}`);
        setGlobalSearch('');
      }
    }
  }

  async function handleLogout() {
    await authSupabase.auth.signOut();
    sessionStorage.removeItem('admin_authed');
    sessionStorage.removeItem('admin_user_id');
    sessionStorage.removeItem('admin_display_name');
    navigate('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-900">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 w-60 flex flex-col bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 shrink-0 transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-4 h-14 border-b border-slate-200 dark:border-slate-700 shrink-0">
          <img src="/tscopier-light copy.png" alt="TScopier" className="h-7 w-auto block dark:hidden" />
          <img src="/tscopier-dark copy.png" alt="TScopier" className="h-7 w-auto hidden dark:block" />
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-2 px-3">
          {navigation.map((group, gi) => (
            <div key={gi} className={clsx(gi > 0 && 'mt-4')}>
              {group.title && (
                <p className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  {group.title}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      onClick={() => setSidebarOpen(false)}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors duration-100',
                          isActive
                            ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400'
                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/60 hover:text-slate-900 dark:hover:text-slate-200'
                        )
                      }
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0 opacity-70" />
                      {item.label}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200 dark:border-slate-700 shrink-0">
          <div className="flex items-center gap-2 px-2 py-1 mb-2">
            <UserCircle className="w-4 h-4 text-slate-400 shrink-0" />
            <span className="text-xs text-slate-600 dark:text-slate-400 truncate font-medium">{adminName}</span>
          </div>
          <div className="flex items-center justify-between">
            <ThemeToggle />
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-error-600 dark:hover:text-error-400 transition-colors px-2 py-1.5 rounded-lg hover:bg-error-50 dark:hover:bg-error-900/20"
            >
              <LogOut className="w-3.5 h-3.5" />
              Logout
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <header className="h-14 flex items-center gap-3 px-4 lg:px-6 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <Menu className="w-5 h-5" />
          </button>
          <form onSubmit={handleSearch} className="flex-1 max-w-md relative">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                ref={inputRef}
                value={globalSearch}
                onChange={e => handleSearchInput(e.target.value)}
                onFocus={() => { if (results.length > 0) setShowResults(true); }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search users, brokers, channels, trades..."
                className="input-base pl-10 py-1.5 text-sm"
              />
            </div>
            {showResults && (results.length > 0 || (searching && globalSearch.trim().length >= 2)) && (
              <div
                ref={resultsRef}
                className="absolute z-50 top-full mt-1 w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden max-h-80 overflow-y-auto"
              >
                {searching && results.length === 0 && (
                  <div className="px-3 py-3 text-xs text-slate-400 text-center">Searching...</div>
                )}
                {(() => {
                  const categories: { key: SearchResult['category']; label: string; icon: React.ElementType }[] = [
                    { key: 'user', label: 'Users', icon: Users },
                    { key: 'broker', label: 'Broker Accounts', icon: Server },
                    { key: 'channel', label: 'Telegram Channels', icon: MessageSquare },
                    { key: 'trade', label: 'Trades', icon: TrendingUp },
                  ];
                  let flatIdx = -1;
                  return categories.map(cat => {
                    const catResults = results.filter(r => r.category === cat.key);
                    if (catResults.length === 0) return null;
                    const CatIcon = cat.icon;
                    return (
                      <div key={cat.key}>
                        <div className="px-3 py-1.5 bg-slate-50 dark:bg-slate-750 border-b border-slate-100 dark:border-slate-700 flex items-center gap-2">
                          <CatIcon className="w-3 h-3 text-slate-400" />
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">{cat.label}</span>
                        </div>
                        {catResults.map(r => {
                          flatIdx++;
                          const idx = flatIdx;
                          return (
                            <button
                              key={r.id}
                              type="button"
                              className={clsx(
                                'w-full text-left px-3 py-2 flex items-center gap-3 transition-colors',
                                idx === activeIndex
                                  ? 'bg-primary-50 dark:bg-primary-900/30'
                                  : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                              )}
                              onMouseDown={(e) => { e.preventDefault(); selectResult(r); }}
                              onMouseEnter={() => setActiveIndex(idx)}
                            >
                              <div className="w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-[10px] font-medium text-slate-600 dark:text-slate-300 shrink-0">
                                {r.label[0]?.toUpperCase()}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{r.label}</p>
                                {r.sublabel && <p className="text-xs text-slate-400 font-mono truncate">{r.sublabel}</p>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </form>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}
