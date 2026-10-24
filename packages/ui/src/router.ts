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

/** The path of the URL. The query and the hash are not in it: `route` does not read them. */
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

/** The value of the query parameter `name` of the URL of the page, or "" when the URL does not have it. */
export function param(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

/**
 * Write the query parameters of `values` into the URL of the page. An empty value removes its parameter. The other parameters do not change.
 * This replaces the URL and does not add a page to `history`. Thus Back goes to the previous page, not to the previous value.
 */
export function replaceParams(values: Record<string, string>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(values)) {
    if (value === "") params.delete(name);
    else params.set(name, value);
  }
  // Keep `,` in the query, not `%2C`: `?state=ready,merged`.
  const search = params.toString().replaceAll("%2C", ",");
  const { pathname, hash } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search === "" ? "" : `?${search}`}${hash}`);
}
