import { useState } from "react";
import type { JobsView } from "@patchix/common";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { TextArea, TextField } from "../components/Field.tsx";
import { Notice } from "../components/Notice.tsx";
import { useToast } from "../components/Toast.tsx";
import { useClient } from "../client.tsx";
import { ago, time } from "../format.ts";
import { useAction } from "../hooks.ts";
import "./views.css";

/** The longest text: see `RunInput`. */
const MAX_TEXT = 4000;
/** The signs of a key: see `KEY` of `@patchix/common`. The client does not import the schemas. */
const KEY_SIGNS = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** The text below the Run button when a click adds the branch to the queue. */
const RUN_HINT = "The branch goes into the queue. With a question, the next run continues the session of the agent.";

export interface RunControlProps {
  campaign: string;
  /** The key of the branch. `null`: the control has a key field, and a key that is not in `known` makes a new branch. */
  branch: string | null;
  /** The keys of the branches and the attributes of the entries. Only for the key field. */
  known?: ReadonlySet<string> | undefined;
  jobs: JobsView;
  onJobs: (view: JobsView) => void;
}

/**
 * The text for the agent and the Run button. Also the Stop button, the job of the branch and its position in the
 * queue. Without a text, the run is a usual run. With a text, the next run continues the session of `claude` in the
 * worktree with the text as a question. With the key field, a new key is a free-text run: the text is necessary, and
 * it is the work of the agent. The server rejects a run for a branch with a job or with an entry.
 */
export function RunControl({ campaign, branch, known, jobs, onJobs }: RunControlProps) {
  const client = useClient();
  const toast = useToast();
  const [field, setField] = useState("");
  const [text, setText] = useState("");
  const key = (branch ?? field).trim();
  const job = jobs.jobs.find((j) => j.key === key) ?? null;
  const place = key === "" ? -1 : jobs.queue.indexOf(key);
  const fresh = branch === null && key !== "" && !(known?.has(key) ?? false);
  const start = useAction(async () => {
    const question = text.trim();
    onJobs(branch === null ? await client.startFreeRun(campaign, { key, question }) : await client.startRun(campaign, key, { question }));
    setText("");
    if (branch === null) setField("");
    toast(`${key} is in the queue`, fresh ? "The fleet makes the branch from the base and gives the text to the agent." : question === "" ? "The fleet starts the run in a free job place." : "The next run of the branch gets the question.");
  });
  const stop = useAction(async () => {
    const queued = place >= 0;
    onJobs(await client.stopJob(campaign, key));
    toast(queued ? `${key} is not in the queue now` : `The job of ${key} stops`);
  });
  const reason =
    key === ""
      ? "Write the key of the branch."
      : !KEY_SIGNS.test(key)
        ? "A key has only the signs A-Z, a-z, 0-9, _, . and -, and it does not start with . or -."
        : job !== null
          ? "A job of this branch operates."
          : place >= 0
            ? "The branch is in the queue."
            : text.length > MAX_TEXT
              ? `The text has more than ${MAX_TEXT} characters.`
              : fresh && text.trim() === ""
                ? "A new branch must have a text: the work for the agent."
                : null;
  const hint = branch !== null ? RUN_HINT : fresh ? "A new branch from the base. The text is the work for the agent." : `A run of the branch ${key}. The text is a question.`;
  return (
    <div className="stack" aria-label={branch === null ? "Run" : "Next run"}>
      {branch === null && <TextField label="Key" value={field} onValueChange={setField} placeholder="An attribute, or a new name, for example ruby-gem-hook" className="run-key" />}
      <TextArea
        label={branch === null ? "Text" : "Question"}
        hideLabel={branch !== null}
        rows={3}
        maxLength={MAX_TEXT}
        value={text}
        onValueChange={setText}
        placeholder={branch === null ? "The work for the agent, or a question about the branch" : "A question for the agent (optional)"}
        // `Cmd+Enter` (or `Ctrl+Enter`) starts the run, the same as the button.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reason === null && !start.pending) {
            e.preventDefault();
            void start.run();
          }
        }}
      />
      <div className="row">
        <Button variant="primary" disabled={reason !== null} pending={start.pending} onClick={() => void start.run()}>
          Run
        </Button>
        {job === null && place >= 0 && (
          <>
            <Button variant="danger" pending={stop.pending} onClick={() => void stop.run()}>
              Remove from queue
            </Button>
            <span className="small muted">{place === 0 ? "The branch is the first in the queue." : `The queue has ${place} ${place === 1 ? "entry" : "entries"} before this branch.`}</span>
          </>
        )}
        {job !== null && (
          <>
            <ConfirmDialog
              trigger={
                <Button variant="danger" pending={stop.pending}>
                  Stop
                </Button>
              }
              title={`Stop the run ${job.id}?`}
              description="The agent stops. The worktree and the files of the job stay."
              confirmLabel="Stop"
              onConfirm={() => void stop.run()}
            />
            <span className="small muted">
              The run <span className="mono">{job.id}</span> operates. It started <span title={time(job.started)}>{ago(job.started)}</span>.
            </span>
          </>
        )}
      </div>
      <span className="small muted">{reason ?? hint}</span>
      {start.error !== null && <Notice tone="error">Run: {start.error}</Notice>}
      {stop.error !== null && <Notice tone="error">Stop: {stop.error}</Notice>}
    </div>
  );
}
