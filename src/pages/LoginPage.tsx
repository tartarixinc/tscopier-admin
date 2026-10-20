import { useState } from 'react';
import { Eye, EyeOff, Mail, Lock } from 'lucide-react';
import { authSupabase } from '../lib/adminSupabase';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import {
  adminEnvSessionKey, getAdminEnv, availableEnvs, setAdminEnv, ENVIRONMENTS, projectRefOf,
} from '../lib/environment';
import clsx from 'clsx';

const activeEnv = getAdminEnv();
const activeEnvs = availableEnvs();

const ENV_BADGE_CLASS: Record<typeof activeEnv, string> = {
  prod: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400',
  staging: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400',
  migration: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-400',
};

const ENV_DOT_CLASS: Record<typeof activeEnv, string> = {
  prod: 'bg-emerald-500',
  staging: 'bg-amber-500',
  migration: 'bg-violet-500',
};

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    // 1. Authenticate with Supabase
    const { data: authData, error: authError } = await authSupabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      setError(authError?.message ?? 'Invalid credentials.');
      setLoading(false);
      return;
    }

    // 2. Verify the user has is_admin = true in user_profiles
    // Use authSupabase (has the live session) so RLS passes for this user's own row
    const { data: profile, error: profileError } = await authSupabase
      .from('user_profiles')
      .select('is_admin, display_name')
      .eq('user_id', authData.user.id)
      .maybeSingle();

    if (profileError || !profile?.is_admin) {
      await authSupabase.auth.signOut();
      setError('Access denied. This account does not have admin privileges.');
      setLoading(false);
      return;
    }

    // 3. Store per-env session flag with display name for the shell header
    sessionStorage.setItem(adminEnvSessionKey('admin_authed'), 'true');
    sessionStorage.setItem(adminEnvSessionKey('admin_user_id'), authData.user.id);
    sessionStorage.setItem(adminEnvSessionKey('admin_display_name'), profile.display_name ?? authData.user.email ?? '');
    window.location.href = '/';
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-4">
            <img src="/tscopier-light copy.png" alt="TScopier Admin" className="h-10 w-auto block dark:hidden" />
            <img src="/tscopier-dark copy.png" alt="TScopier Admin" className="h-10 w-auto hidden dark:block" />
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Sign in with your admin account
          </p>
          <span className={`inline-flex items-center gap-1.5 mt-3 px-2.5 py-1 rounded-full text-[11px] font-semibold ${ENV_BADGE_CLASS[activeEnv]}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${ENV_DOT_CLASS[activeEnv]}`} />
            {ENVIRONMENTS[activeEnv].label} environment · {projectRefOf(activeEnv)}
          </span>

          {activeEnvs.length > 1 && (
            <div
              className="flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700/60 p-0.5 text-xs font-semibold mt-3 mx-auto w-fit"
              role="group"
              aria-label="Select environment"
            >
              {activeEnvs.map(envKey => (
                <button
                  key={envKey}
                  type="button"
                  onClick={() => {
                    if (envKey !== activeEnv) setAdminEnv(envKey);
                  }}
                  aria-pressed={envKey === activeEnv}
                  className={clsx(
                    'px-2.5 py-1 rounded-md transition-colors',
                    envKey === activeEnv
                      ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
                    envKey === 'staging' && envKey === activeEnv && 'bg-amber-500 text-white dark:bg-amber-500 shadow-none',
                    envKey === 'migration' && envKey === activeEnv && 'bg-violet-600 text-white dark:bg-violet-600 shadow-none',
                  )}
                >
                  {ENVIRONMENTS[envKey].shortLabel}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Card */}
        <div className="card p-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && <Alert variant="error">{error}</Alert>}

            <Input
              label="Email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@example.com"
              autoFocus
              autoComplete="email"
              required
              prefix={<Mail className="w-3.5 h-3.5" />}
            />

            <div className="relative">
              <Input
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                prefix={<Lock className="w-3.5 h-3.5" />}
              />
              <button
                type="button"
                onClick={() => setShowPassword(prev => !prev)}
                className="absolute right-3 bottom-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              disabled={!email || !password}
              className="w-full mt-1"
            >
              Sign In
            </Button>
          </form>
        </div>
        
      </div>
    </div>
  );
}
