export type AdminEnv = 'prod' | 'staging' | 'migration';

export interface EnvironmentConfig {
  label: string;
  shortLabel: string;
  url: string;
  anonKey: string;
}

const STORAGE_KEY = 'tscopier_admin_env';

// The "migration" environment is a Supabase branch of the production project
// (branch ref supmsgcubipmmowrzoub). Unlike the older assumption, branches do
// NOT share the parent project's JWT secret: the branch has its own anon key,
// so VITE_SUPABASE_ANON_KEY_MIGRATION must be set. The URL is a public project
// endpoint, not a secret.
const MIGRATION_BRANCH_URL = 'https://supmsgcubipmmowrzoub.supabase.co';

export const ADMIN_ENVS: AdminEnv[] = ['prod', 'staging', 'migration'];

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
  migration: {
    label: 'Migration',
    shortLabel: 'MIGRATION',
    url: import.meta.env.VITE_SUPABASE_URL_MIGRATION ?? MIGRATION_BRANCH_URL,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY_MIGRATION ?? '',
  },
};

export function isEnvConfigured(env: AdminEnv): boolean {
  return Boolean(ENVIRONMENTS[env].url && ENVIRONMENTS[env].anonKey);
}

export function availableEnvs(): AdminEnv[] {
  return ADMIN_ENVS.filter(isEnvConfigured);
}

export function getAdminEnv(): AdminEnv {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (stored && (ADMIN_ENVS as string[]).includes(stored) && isEnvConfigured(stored as AdminEnv)) {
    return stored as AdminEnv;
  }
  return availableEnvs()[0] ?? 'prod';
}

export function getAdminEnvConfig(): EnvironmentConfig {
  return ENVIRONMENTS[getAdminEnv()];
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
