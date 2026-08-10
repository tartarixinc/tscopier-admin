import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { authSupabase } from '../lib/adminSupabase';
import { clearCache } from '../lib/queryCache';
import { adminEnvSessionKey, getAdminEnv } from '../lib/environment';

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);

  // Verify the actual Supabase session exists for the current env.
  // Without this, a stale flag would let the app render as anonymous —
  // RLS then silently returns 0 rows (e.g. "0 users") with no error.
  useEffect(() => {
    let cancelled = false;
    authSupabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (!data.session) clearCache();
      setHasSession(Boolean(data.session));
      setChecking(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (checking) return null;

  const flagOk = sessionStorage.getItem(adminEnvSessionKey('admin_authed')) === 'true'
    || (getAdminEnv() === 'prod' && sessionStorage.getItem('admin_authed') === 'true');

  if (!flagOk || !hasSession) return <Navigate to={`/login?env=${getAdminEnv()}`} replace />;
  return <>{children}</>;
}