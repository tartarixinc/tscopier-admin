export type AdminEnv = 'prod' | 'staging';

export interface EnvironmentConfig {
  label: string;
  shortLabel: string;
  url: string;
  anonKey: string;
}

const STORAGE_KEY = 'tscopier_admin_env';

export const ENVIRONMENTS: Record<AdminEnv, EnvironmentConfig> = {
  prod: {
    label: 'Production',
    shortLabel: 'PROD',
    url: import.meta.env.VITE_SUPABASE_URL ?? '',
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
  },
  staging: {
    label: 'Staging',
    shortLabel: 'STAGING',
    url: import.meta.env.VITE_SUPABASE_URL_STAGING ?? '',
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY_STAGING ?? '',
  },
};

export function isEnvConfigured(env: AdminEnv): boolean {
  return Boolean(ENVIRONMENTS[env].url && ENVIRONMENTS[env].anonKey);
}

export function getAdminEnv(): AdminEnv {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  return stored === 'staging' && isEnvConfigured('staging') ? 'staging' : 'prod';
}

export function setAdminEnv(env: AdminEnv): void {
  if (!isEnvConfigured(env)) return;
  localStorage.setItem(STORAGE_KEY, env);
  window.location.reload();
}

export function adminEnvSessionKey(key: string): string {
  return `${key}_${getAdminEnv()}`;
}

export function projectRefOf(env: AdminEnv): string {
  try {
    const host = new URL(ENVIRONMENTS[env].url).hostname;
    return host.split('.')[0] ?? '';
  } catch {
    return '';
  }
}

export function projectRefOfCurrentEnv(): string {
  return projectRefOf(getAdminEnv());
}
