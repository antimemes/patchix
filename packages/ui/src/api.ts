/** The client of the server routes. The views get the client from `ClientProvider`, thus the stories can use a mock client. */
import type {
  BranchDetail,
  CampaignSummary,
  CampaignView,
  Commit,
  DraftInput,
  Event as ServerEvent,
  FreeRunInput,
  JobInput,
  JobsView,
  Label,
  PublishInput,
  RunInput,
  Settings,
  SettingsView,
  Worktree,
} from "@patchix/common";

/** The text files of a run that the page shows. `log.txt` stays in the run directory and in the zellij tab. */
export type RunFile = "prompt" | "reply" | "description" | "attrs";
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
  /** The branch of the key, with its entries and its draft. */
  branch(c: string, key: string): Promise<BranchDetail>;
  runFile(c: string, key: string, run: string, file: RunFile): Promise<string>;
  /** The commits of the branch, from its base to its tip. See `GET .../commits`. */
  commits(c: string, key: string): Promise<Commit[]>;
  /** `git diff <base> <tip>` of the branch, as text. */
  diff(c: string, key: string): Promise<string>;
  /** The output of the check `check` for the attribute `attr` in the run. */
  checkOutput(c: string, key: string, run: string, attr: string, check: string): Promise<string>;
  jobs(c: string): Promise<JobsView>;
  /** Adds the branches to the queue. The fleet starts their runs. */
  queueRuns(c: string, input: JobInput): Promise<JobsView>;
  /** Removes the branch and its question from the queue. When the branch is not in the queue, it stops the job of the branch. */
  stopJob(c: string, key: string): Promise<JobsView>;
  clearQueue(c: string): Promise<JobsView>;
  /** Adds the branch to the queue for one run, with the question of `input` or without a question. See `RunInput`. */
  startRun(c: string, key: string, input: RunInput): Promise<JobsView>;
  /** Adds the key of `input` to the queue. A key that is not there is a free-text run: the text is necessary. See `FreeRunInput`. */
  startFreeRun(c: string, input: FreeRunInput): Promise<JobsView>;
  /** Links the entry to the branch of the key, or removes its link with `null`. See `PUT .../tasks/:attr/branch`. */
  linkEntry(c: string, attr: string, key: string | null): Promise<CampaignView>;
  saveDraft(c: string, key: string, input: DraftInput): Promise<BranchDetail>;
  /** Makes the draft from the newest run with a description and from the tip of the branch. See `makeDraft` in the fleet package. */
  makeDraft(c: string, key: string): Promise<BranchDetail>;
  /** `input` shows that the person set the tick box: see `PublishInput`. */
  createPr(c: string, key: string, input: PublishInput): Promise<BranchDetail>;
  /** `publish.log` of the branch. While `createPr` operates, the file becomes longer. A branch without the file gives an error with the status 404. */
  publishLog(c: string, key: string): Promise<string>;
  makeWorktree(c: string, key: string): Promise<Worktree>;
  removeWorktree(c: string, key: string): Promise<BranchDetail>;
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
  const branch = (c: string, key: string) => `${campaign(c)}/branches/${s(key)}`;

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
    branch: (c, key) => json("GET", branch(c, key)),
    runFile: (c, key, run, file) => text(`${branch(c, key)}/runs/${s(run)}/${file}`),
    commits: (c, key) => json("GET", `${branch(c, key)}/commits`),
    diff: (c, key) => text(`${branch(c, key)}/diff`),
    checkOutput: (c, key, run, attr, check) => text(`${branch(c, key)}/runs/${s(run)}/checks/${s(attr)}/${s(check)}`),
    jobs: (c) => json("GET", `${campaign(c)}/jobs`),
    queueRuns: (c, input) => json("POST", `${campaign(c)}/jobs`, input),
    stopJob: (c, key) => json("DELETE", `${campaign(c)}/jobs/${s(key)}`),
    clearQueue: (c) => json("DELETE", `${campaign(c)}/queue`),
    startRun: (c, key, input) => json("POST", `${branch(c, key)}/run`, input),
    startFreeRun: (c, input) => json("POST", `${campaign(c)}/run`, input),
    linkEntry: (c, attr, key) => json("PUT", `${campaign(c)}/tasks/${s(attr)}/branch`, { key }),
    saveDraft: (c, key, input) => json("PUT", `${branch(c, key)}/draft`, input),
    makeDraft: (c, key) => json("POST", `${branch(c, key)}/draft`),
    createPr: (c, key, input) => json("POST", `${branch(c, key)}/pr`, input),
    publishLog: (c, key) => text(`${branch(c, key)}/publish-log`),
    makeWorktree: (c, key) => json("POST", `${branch(c, key)}/worktree`),
    removeWorktree: (c, key) => json("DELETE", `${branch(c, key)}/worktree`),
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
