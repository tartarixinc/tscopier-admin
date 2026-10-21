import { useCallback, useEffect, useState } from 'react';

export interface TestAccount {
  userId: string;
  name: string;
}

export const TEST_ACCOUNTS: TestAccount[] = [
  { userId: 'dd18ad68-cab1-4d02-8bd8-6d975db5f959', name: 'Luis ESp' },
  { userId: 'a23f24d9-1538-4dc1-956a-846b8e85d4e6', name: 'Martins' },
];

export const TEST_ACCOUNT_IDS: string[] = TEST_ACCOUNTS.map(account => account.userId);

const STORAGE_KEY = 'tscopier_admin_hide_test_accounts';

let storedValue = readStoredValue();
const listeners = new Set<(value: boolean) => void>();

function readStoredValue(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeStoredValue(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch (error) {
    console.warn('Could not save the test-account setting', error);
  }
}

export function useHideTestAccounts(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(storedValue);

  useEffect(() => {
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);

  const set = useCallback((next: boolean) => {
    storedValue = next;
    writeStoredValue(next);
    listeners.forEach(listener => listener(next));
  }, []);

  return [value, set];
}

interface NotFilter<Q> {
  not(column: string, operator: string, value: unknown): Q;
}

export function withoutTestAccounts<Q extends NotFilter<Q>>(query: Q, exclude: boolean): Q {
  if (!exclude) return query;
  return query.not('user_id', 'in', `(${TEST_ACCOUNT_IDS.join(',')})`);
}
