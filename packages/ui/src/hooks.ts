import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type Signal } from "./api.ts";
import { useClient } from "./client.tsx";

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  replace: (data: T) => void;
}

interface LoadState<T> {
  key: string;
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Gets the data again when `key` changes and after `reload`. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<LoadState<T>>({ key, data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const latest = useRef(load);
  const sequence = useRef(0);
  useEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    const id = ++sequence.current;
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, data: null, error: null, loading: true }));
    latest.current().then(
      (data) => {
        if (id === sequence.current) setState({ key, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (id === sequence.current) setState((s) => ({ key, data: s.key === key ? s.data : null, error: errorMessage(error), loading: false }));
      },
    );
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const replace = useCallback(
    (data: T) => {
      sequence.current++;
      setState({ key, data, error: null, loading: false });
    },
    [key],
  );
  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: !current || state.loading, reload, replace };
}

export interface Action<A extends unknown[], T> {
  run: (...args: A) => Promise<T | undefined>;
  pending: boolean;
  error: string | null;
  clear: () => void;
}

export function useAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>): Action<A, T> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  const run = useCallback(async (...args: A) => {
    setPending(true);
    setError(null);
    try {
      return await latest.current(...args);
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { run, pending, error, clear };
}

export function useSignals(listener: (signal: Signal) => void): void {
  const client = useClient();
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => client.subscribe((signal) => latest.current(signal)), [client]);
}

export function useDebounced(fn: () => void, ms: number): () => void {
  const latest = useRef(fn);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => latest.current(), ms);
  }, [ms]);
}

export function useInterval(fn: () => void, ms: number | null): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    if (ms === null) return;
    const id = window.setInterval(() => latest.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/**
 * The tab of a page. The URL hash keeps it, for example `#publish`: thus a link to the page opens the same tab. A hash
 * that is not a tab of `tabs` gives the first tab.
 */
export function useHashTab<T extends string>(tabs: readonly [T, ...T[]]): [T, (tab: T) => void] {
  const [first] = tabs;
  const read = useCallback(() => tabs.find((t) => window.location.hash === `#${t}`) ?? first, [tabs, first]);
  const [tab, setTab] = useState<T>(read);
  useEffect(() => {
    const onHash = () => setTab(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [read]);
  const choose = useCallback((next: T) => {
    setTab(next);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}#${next}`);
  }, []);
  return [tab, choose];
}
