/**
 * Poller summary for the active provider tab (`GET /v8/management/quota/<provider>`).
 *
 * A snapshot read, no upstream call, so it is refetched freely: when the tab
 * opens and whenever `reloadKey` changes (file list reloaded, a card settled).
 * Stale responses are dropped by request id and session generation, like the
 * file list on this page. A failed read keeps the last good summary, so a
 * missing endpoint (older backend) or a blip never blanks the page.
 */

import { useEffect, useRef, useState } from 'react';
import { quotaSummaryApi } from '@/services/api/quotaSummary';
import { useQuotaStore } from '@/stores';
import type { QuotaSummary } from '@/types';
import type { QuotaSummaryProvider } from '../summary';

export interface QuotaSummaryResult {
  summary: QuotaSummary | null;
  loading: boolean;
}

export function useQuotaSummary(
  provider: QuotaSummaryProvider | null,
  enabled: boolean,
  reloadKey: string
): QuotaSummaryResult {
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [state, setState] = useState<{
    key: string;
    summary: QuotaSummary | null;
    loading: boolean;
  }>({ key: '', summary: null, loading: false });
  const requestRef = useRef(0);
  const scope = provider && enabled ? `${sessionGeneration}:${provider}` : '';

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!provider || !enabled) return;
    const isCurrent = () =>
      requestId === requestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setState((prev) =>
      prev.key === scope ? { ...prev, loading: true } : { key: scope, summary: null, loading: true }
    );
    quotaSummaryApi
      .get(provider)
      .then((summary) => {
        if (isCurrent()) setState({ key: scope, summary, loading: false });
      })
      .catch(() => {
        if (isCurrent()) setState((prev) => ({ ...prev, loading: false }));
      });
    return () => {
      requestRef.current += 1;
    };
  }, [enabled, provider, reloadKey, scope, sessionGeneration]);

  if (!scope || state.key !== scope) return { summary: null, loading: Boolean(scope) };
  return { summary: state.summary, loading: state.loading };
}
