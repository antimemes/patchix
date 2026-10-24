/** The client of the server routes. The views get the client from `ClientProvider`, thus the stories can use a mock client. */
import type {
  Ask,
  AskInput,
  CampaignSummary,
  CampaignView,
  DraftFromRun,
  DraftInput,
  Event as ServerEvent,
  JobInput,
  JobsView,
  Label,
  PublishInput,
  RunCommits,
  Settings,
  SettingsView,
  TaskDetail,
  Worktree,
} from "@patchix/common";

/** The text files of a run that the page shows. `log.txt` stays in the run directory and in the zellij tab. */
export type RunFile = "prompt" | "diff" | "description";
export type AskFile = "reply" | "prompt" | "diff";
/** A server event, or `reconnect` after the event stream stops and starts again. */
export type Signal = ServerEvent | { type: "reconnect" };

export class ApiError extends Error {
  readonly status: number;
  /** The JSON body of the error, or `null` when the body is not JSON. */
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Client {
  campaigns(): Promise<CampaignSummary[]>;
  campaign(c: string): Promise<CampaignView>;
  sync(c: string): Promise<CampaignView>;
  refresh(c: string): Promise<CampaignView>;
  fetchBase(c: string): Promise<CampaignView>;
  labels(c: string): Promise<Label[]>;
  task(c: string, attr: string): Promise<TaskDetail>;
  runFile(c: string, attr: string, run: string, file: RunFile): Promise<string>;
  commits(c: string, attr: string, run: string): Promise<RunCommits>;
  checkOutput(c: string, attr: string, run: string, check: string): Promise<string>;
  jobs(c: string): Promise<JobsView>;
  /** Adds the tasks to the queue. The fleet starts their runs. */
  queueRuns(c: string, input: JobInput): Promise<JobsView>;
  /** Removes the task from the queue, or stops its job when it is not in the queue. */
  stopJob(c: string, attr: string): Promise<JobsView>;
  clearQueue(c: string): Promise<JobsView>;
  ask(c: string, attr: string, input: AskInput): Promise<Ask>;
  askFile(c: string, attr: string, id: string, file: AskFile): Promise<string>;
  saveDraft(c: string, attr: string, input: DraftInput): Promise<TaskDetail>;
  draftFromRun(c: string, attr: string, input: DraftFromRun): Promise<TaskDetail>;
  /** `input` shows that the person set the tick box: see `PublishInput`. */
  createPr(c: string, attr: string, input: PublishInput): Promise<TaskDetail>;
  /** `publish.log` of the task. While `createPr` operates, the file becomes longer. A task without the file gives an error with the status 404. */
  publishLog(c: string, attr: string): Promise<string>;
  makeWorktree(c: string, attr: string): Promise<Worktree>;
  removeWorktree(c: string, attr: string): Promise<TaskDetail>;
  /** The settings of this person and this host: see `SettingsView`. */
  settings(): Promise<SettingsView>;
  saveSettings(input: Settings): Promise<SettingsView>;
  subscribe(listener: (signal: Signal) => void): () => void;
}


async function readError(response: Response): Promise<ApiError> {
  const raw = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return new ApiError(response.status, body.error, body);
  return new ApiError(response.status, raw.trim() || `HTTP ${response.status} ${response.statusText}`, body);
}

export function httpClient(options: { base?: string } = {}): Client {
  const base = options.base ?? "";
  const s = encodeURIComponent;
  const campaign = (c: string) => `/api/campaigns/${s(c)}`;
  const task = (c: string, attr: string) => `${campaign(c)}/tasks/${s(attr)}`;

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers = new Headers();
    if (body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetch(base + path, { method, headers, body: body === undefined ? null : JSON.stringify(body) });
    } catch (error) {
      throw new ApiError(0, `no answer from the server: ${errorMessage(error)}`);
    }
    if (!response.ok) throw await readError(response);
    return response;
  }
  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await send(method, path, body);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(response.status, `${method} ${path}: the answer of the server is not JSON`);
    }
  };
  const text = async (path: string): Promise<string> => (await send("GET", path)).text();

  const listeners = new Set<(signal: Signal) => void>();
  let source: EventSource | null = null;
  let broken = false;
  const emit = (signal: Signal) => {
    for (const listener of listeners) listener(signal);
  };

  return {
    campaigns: () => json("GET", "/api/campaigns"),
    campaign: (c) => json("GET", campaign(c)),
    sync: (c) => json("POST", `${campaign(c)}/sync`),
    refresh: (c) => json("POST", `${campaign(c)}/refresh`),
    fetchBase: (c) => json("POST", `${campaign(c)}/base`),
    labels: (c) => json("GET", `${campaign(c)}/labels`),
    task: (c, attr) => json("GET", task(c, attr)),
    runFile: (c, attr, run, file) => text(`${task(c, attr)}/runs/${s(run)}/${file}`),
    commits: (c, attr, run) => json("GET", `${task(c, attr)}/runs/${s(run)}/commits`),
    checkOutput: (c, attr, run, check) => text(`${task(c, attr)}/runs/${s(run)}/checks/${s(check)}`),
    jobs: (c) => json("GET", `${campaign(c)}/jobs`),
    queueRuns: (c, input) => json("POST", `${campaign(c)}/jobs`, input),
    stopJob: (c, attr) => json("DELETE", `${campaign(c)}/jobs/${s(attr)}`),
    clearQueue: (c) => json("DELETE", `${campaign(c)}/queue`),
    ask: (c, attr, input) => json("POST", `${task(c, attr)}/ask`, input),
    askFile: (c, attr, id, file) => text(`${task(c, attr)}/asks/${s(id)}/${file}`),
    saveDraft: (c, attr, input) => json("PUT", `${task(c, attr)}/draft`, input),
    draftFromRun: (c, attr, input) => json("POST", `${task(c, attr)}/draft`, input),
    createPr: (c, attr, input) => json("POST", `${task(c, attr)}/pr`, input),
    publishLog: (c, attr) => text(`${task(c, attr)}/publish-log`),
    makeWorktree: (c, attr) => json("POST", `${task(c, attr)}/worktree`),
    removeWorktree: (c, attr) => json("DELETE", `${task(c, attr)}/worktree`),
    settings: () => json("GET", "/api/settings"),
    saveSettings: (input) => json("PUT", "/api/settings", input),
    subscribe(listener) {
      listeners.add(listener);
      if (source === null) {
        source = new EventSource(`${base}/api/events`);
        source.onmessage = (message: MessageEvent<string>) => {
          let event: ServerEvent;
          try {
            event = JSON.parse(message.data) as ServerEvent;
          } catch {
            return;
          }
          emit(event);
        };
        source.onerror = () => {
          broken = true;
        };
        source.onopen = () => {
          if (broken) emit({ type: "reconnect" });
          broken = false;
        };
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && source !== null) {
          source.close();
          source = null;
        }
      };
    },
  };
}
