import { useSyncExternalStore } from "react";

export type Route =
  | { page: "campaigns" }
  | { page: "campaign"; campaign: string }
  | { page: "task"; campaign: string; attr: string }
  | { page: "settings" }
  | { page: "missing"; path: string };

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string): void {
  if (to !== window.location.pathname + window.location.search) {
    window.history.pushState(null, "", to);
    window.scrollTo(0, 0);
  }
  for (const listener of listeners) listener();
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function route(path: string): Route {
  const parts = path.split("/").filter((p) => p !== "");
  const [a, c, t, attr, ...rest] = parts.map(decode);
  if (parts.length === 0) return { page: "campaigns" };
  if (a === "settings" && parts.length === 1) return { page: "settings" };
  if (a === "c" && c && t === undefined) return { page: "campaign", campaign: c };
  if (a === "c" && c && t === "t" && attr && rest.length === 0) return { page: "task", campaign: c, attr };
  return { page: "missing", path };
}

export const href = {
  home: () => "/",
  settings: () => "/settings",
  campaign: (c: string) => `/c/${encodeURIComponent(c)}`,
  task: (c: string, attr: string) => `/c/${encodeURIComponent(c)}/t/${encodeURIComponent(attr)}`,
};
