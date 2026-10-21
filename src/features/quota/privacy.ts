/**
 * "Show emails" on the Quota page: account emails are masked by default
 * wherever the page names an account (cards, timeline, summary). Search keeps
 * matching the full values; only rendering is masked.
 *
 * The choice is remembered per browser through the storage service.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { obfuscatedStorage } from '@/services/storage/secureStorage';

export const QUOTA_SHOW_EMAILS_KEY = 'quotaPage.showEmails';

const MASK = '•••';

/**
 * Mask every email inside `text`, keeping its first character, the first
 * character of its domain, and the rest of the domain after the first label:
 * `claude-90b1d5e2-szymon@herocoders.com.json` → `claude-90b1d5e2-s•••@h•••.com.json`.
 * The local part stops at `-` so a filename's prefix stays readable.
 */
export function maskEmails(text: string): string {
  return text.replace(
    /([A-Za-z0-9._%+])[A-Za-z0-9._%+]*@([A-Za-z0-9])[A-Za-z0-9-]*/g,
    (_match, first: string, domainFirst: string) => `${first}${MASK}@${domainFirst}${MASK}`
  );
}

const listeners = new Set<() => void>();

export function readShowEmails(): boolean {
  try {
    return obfuscatedStorage.getItem<boolean>(QUOTA_SHOW_EMAILS_KEY, { obfuscate: false }) === true;
  } catch {
    return false;
  }
}

export function writeShowEmails(show: boolean): void {
  try {
    obfuscatedStorage.setItem(QUOTA_SHOW_EMAILS_KEY, show, { obfuscate: false });
  } catch {
    // Storage unavailable (private mode, quota): the toggle still works for this page view.
  }
  current = show;
  listeners.forEach((listener) => listener());
}

let current: boolean | null = null;
const getSnapshot = () => {
  if (current === null) current = typeof window === 'undefined' ? false : readShowEmails();
  return current;
};
const getServerSnapshot = () => false;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Outside React (toasts, confirmations): mask unless the viewer chose to show emails. */
export function formatAccountName(text: string): string {
  return getSnapshot() ? text : maskEmails(text);
}

/** `[showEmails, setShowEmails, formatName]`: formatName masks unless emails are shown. */
export function useShowEmails(): [boolean, (show: boolean) => void, (text: string) => string] {
  const show = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const formatName = useCallback((text: string) => (show ? text : maskEmails(text)), [show]);
  return [show, writeShowEmails, formatName];
}
