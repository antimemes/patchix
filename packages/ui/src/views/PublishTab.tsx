import { Fragment, useState } from "react";
import { tipChecks, tipProblem, type TipCheck } from "@patchix/common/status";
import type { BranchDetail, DraftInput, Pr, Run } from "@patchix/common";
import { ApiError } from "../api.ts";
import { Badge, STATE_TONE } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { ChipsInput } from "../components/ChipsInput.tsx";
import { CodeBlock } from "../components/CodeBlock.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { TextArea, TextField } from "../components/Field.tsx";
import { LabelsPicker } from "../components/LabelsPicker.tsx";
import { Link } from "../components/Link.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Notice } from "../components/Notice.tsx";
import { useToast } from "../components/Toast.tsx";
import { useClient } from "../client.tsx";
import { plural, pullUrl, short, time } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import "./views.css";

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameDraft = (a: DraftInput, b: DraftInput) => a.title === b.title && a.description === b.description && sameList(a.labels, b.labels) && sameList(a.words, b.words);

/** The `publish_log` of the error body of `POST .../pr` (`PublishError`), or `null`. */
function publishLogOf(error: unknown): string | null {
  const body = error instanceof ApiError ? error.body : null;
  return typeof body === "object" && body !== null && "publish_log" in body && typeof body.publish_log === "string" ? body.publish_log : null;
}

/** The time between two reads of `publish.log` while the request of the button operates. */
const POLL_MS = 1000;
const sleep = (ms: number) => new Promise<false>((resolve) => window.setTimeout(() => resolve(false), ms));

/** The output of the newest click on the pull request button. */
interface Attempt {
  /** `publish.log` of the branch at the time of the click: the log of a previous request. */
  before: string | null;
  /** The log of the click. It is `null` until the first command starts, and when no command started. */
  log: string | null;
}

/**
 * The text below the button. After a click, it is the log of the click. When the request stopped, `publish.log` of
 * the branch replaces it. But the previous log and a part of the log of the click do not replace it.
 */
function shownOutput(file: string | null, attempt: Attempt | null, pending: boolean): string | null {
  if (attempt === null) return file;
  const old = file === attempt.before || (file !== null && attempt.log?.startsWith(file) === true);
  return pending || old ? attempt.log : file;
}

export interface PrState {
  hasDraft: boolean;
  draftDirty: boolean;
  /** The checks of the tip for each entry of the branch. See `tipChecks`. */
  tip: readonly TipCheck<Run>[];
  /** See `BranchDetail.clean`. */
  clean: boolean;
  jobRunning: boolean;
  /** The state of the pull request on GitHub, or `null` when the draft has no pull request. */
  prState: Pr["state"] | null;
  /** The tick box above the button. See `Pr.confirmed`. */
  confirmed: boolean;
  /** The commits of the branch with a problem. See `BranchDetail.commit_problems`. */
  commitProblems: BranchDetail["commit_problems"];
  /** The problems of the marks of the draft on the server. See `BranchDetail.mark_problems`. */
  markProblems: BranchDetail["mark_problems"];
}

/** The text after the commit problems: the instruction for the person. */
const AMEND_HINT = "Amend the commit in the worktree, then reload.";

/** Each condition that stops the pull request button, as a text for the person. The server examines the same conditions. */
export function prBlockers(s: PrState): string[] {
  const reasons: string[] = [];
  for (const p of s.commitProblems) reasons.push(`Commit ${short(p.sha)} (${p.subject}): ${p.problems.join(", ")}.`);
  if (s.commitProblems.length > 0) reasons.push(AMEND_HINT);
  if (!s.hasDraft) reasons.push("Make a draft first.");
  if (s.draftDirty) reasons.push("Save the changes of the draft.");
  reasons.push(...s.markProblems);
  const tip = tipProblem(s.tip);
  if (tip !== null) reasons.push(`${tip.charAt(0).toUpperCase()}${tip.slice(1)}.`);
  if (!s.clean) reasons.push("The worktree has changes without a commit. Commit them or remove them, then reload.");
  if (s.jobRunning) reasons.push("A job of this branch operates.");
  if (s.prState === "merged") reasons.push("The pull request is merged. patchix does not change a merged pull request.");
  if (s.prState === "closed") reasons.push("The pull request is closed. Open it again on GitHub, then refresh the campaign.");
  if (!s.confirmed) reasons.push("Confirm that you established confidence in this output.");
  return reasons;
}

export interface PublishTabProps {
  detail: BranchDetail;
  jobRunning: boolean;
  onDetail: (detail: BranchDetail) => void;
}

/** The draft of the pull request: the editor on the left, the preview on the right, and the button that makes the pull request. */
export function PublishTab({ detail, jobRunning, onDetail }: PublishTabProps) {
  const client = useClient();
  const toast = useToast();
  const { campaign, branch } = detail;
  const c = campaign.name;
  const key = branch.key;
  const meta = branch.pr_meta;
  const tip = tipChecks(branch.runs, branch.head, branch.covers);
  const unmet = tip.flatMap((t) => t.checks.filter((r) => r.status === "fail").map((r) => `${r.name} of ${t.attr}`));
  const labels = useLoad(() => client.labels(c), `labels:${c}`);
  const settings = useLoad(() => client.settings(), "settings");
  const fork = settings.data?.fork_effective ?? null;

  const saved: DraftInput | null = meta !== null && detail.draft !== null ? { title: meta.title, labels: meta.labels, description: detail.draft, words: meta.words } : null;
  const [edit, setEdit] = useState<DraftInput | null>(null);
  const draft = edit ?? saved;
  const draftDirty = edit !== null && saved !== null && !sameDraft(edit, saved);
  const change = (patch: Partial<DraftInput>) => {
    if (draft !== null) setEdit({ ...draft, ...patch });
  };

  // The server lints the draft when it writes the draft and when it gives the branch.
  const findings = detail.lint?.findings ?? null;
  /** The flags of each check for the Marks line, for example `harness: --force-build --shim VALUE`. See `Check.flags`. */
  const flagHints = campaign.checks.flatMap((c) => (c.flags !== undefined && c.flags.length > 0 ? [`${c.name}: ${c.flags.map((f) => (f.value ? `${f.name} VALUE` : f.name)).join(" ")}`] : []));

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  /** The number of clicks on the button. After each click, the output opens. */
  const [attempts, setAttempts] = useState(0);
  /** The tick box above the button. It is clear when the page opens, and again after each click of the button that gave no error. */
  const [confirmed, setConfirmed] = useState(false);
  /**
   * The tick box `Force push` after the button: the push replaces the branch on the fork. See `PublishInput.force`. It
   * is clear when the page opens, and again after each click of the button.
   */
  const [force, setForce] = useState(false);

  const save = useAction(async (input: DraftInput) => {
    onDetail(await client.saveDraft(c, key, { ...input, title: input.title.trim() }));
    setEdit(null);
    toast("Draft saved");
  });
  const seed = useAction(async () => {
    onDetail(await client.makeDraft(c, key));
    setEdit(null);
    toast("Draft made");
  });
  const publish = useAction(async () => {
    const updating = meta?.number != null;
    const before = detail.publish_log;
    setAttempt({ before, log: null });
    setAttempts((n) => n + 1);
    const request = client.createPr(c, key, { confirmed: true, force });
    const stopped = request.then(
      () => true,
      () => true,
    );
    // While the request operates, the page reads `publish.log` each second. Until the request examined its
    // conditions, the file has the log of a previous request.
    while (!(await Promise.race([stopped, sleep(POLL_MS)]))) {
      const log = await client.publishLog(c, key).catch(() => null);
      if (log !== null && log !== before) setAttempt({ before, log });
    }
    try {
      const next = await request;
      setAttempt({ before, log: next.publish_log });
      onDetail(next);
      setConfirmed(false);
      toast(updating ? "Pull request updated" : "Pull request created");
    } catch (error) {
      setAttempt({ before, log: publishLogOf(error) });
      throw error;
    } finally {
      setForce(false);
    }
  });
  const output = shownOutput(detail.publish_log, attempt, publish.pending);

  const blockers = prBlockers({ hasDraft: saved !== null, draftDirty, tip, clean: detail.clean, jobRunning, prState: meta?.number != null ? meta.state : null, confirmed, commitProblems: detail.commit_problems, markProblems: detail.mark_problems });

  if (draft === null) {
    return (
      <section className="panel" aria-label="Pull request">
        <h2>Pull request</h2>
        <p className="muted">No draft.</p>
        <div className="row">
          <Button variant="primary" pending={seed.pending} onClick={() => void seed.run()}>
            Make draft
          </Button>
        </div>
        <p className="small muted">
          The draft gets the description of the newest run with a description that is not wontfix, the title of the tip of the branch and the labels of the campaign:{" "}
          {campaign.labels.join(", ") || "none"}.
        </p>
        {seed.error !== null && <Notice tone="error">{seed.error}</Notice>}
      </section>
    );
  }

  return (
    <div className="stack-lg">
      {meta !== null && meta.number !== null && <PrDone meta={meta} number={meta.number} repo={campaign.issue.repo} />}
      {seed.error !== null && <Notice tone="error">{seed.error}</Notice>}
      <div className="publish">
        <section className="panel stack" aria-label="Draft">
          <h2>Draft</h2>
          <TextField label="Title" value={draft.title} onValueChange={(title) => change({ title })} />
          <LabelsPicker
            label="Labels"
            options={labels.data ?? []}
            value={draft.labels}
            onValueChange={(next) => change({ labels: next })}
            description={labels.loading && labels.data === null ? "Loading the labels of the repository." : `The labels of ${campaign.issue.repo}. A new draft has the labels of the campaign.`}
          />
          {labels.error !== null && <Notice tone="warning">The labels of the repository did not load: {labels.error}</Notice>}
          <TextArea
            label="Description"
            mono
            rows={22}
            value={draft.description}
            onValueChange={(description) => change({ description })}
            description={
              <>
                Marks: <code>{"{{disclosure}}"}</code> <code>{"{{check:NAME}}"}</code> <code>{"{{check:NAME [flags of the check]}}"}</code> <code>{"{{template}}"}</code> <code>{"{pr}"}</code>
                {flagHints.length > 0 && " · Flags:"}
                {flagHints.map((h) => (
                  <Fragment key={h}>
                    {" "}
                    <code>{h}</code>
                  </Fragment>
                ))}
              </>
            }
          />
          <ChipsInput
            label="Extra words"
            values={draft.words}
            onValueChange={(words) => change({ words })}
            placeholder="Add a word, then Enter"
            description={`memelint accepts these technical names in this description, and the ${plural(detail.campaign_words.length, "word")} of the campaign.`}
          />
          {detail.campaign_words.length > 0 && (
            <Disclosure label={`Campaign words (${detail.campaign_words.length})`}>
              <p className="small mono break">{detail.campaign_words.join(", ")}</p>
            </Disclosure>
          )}
          <div className="row">
            <Button variant="primary" disabled={!draftDirty || draft.title.trim() === ""} pending={save.pending} onClick={() => void save.run(draft)}>
              Save draft
            </Button>
            <Button variant="ghost" disabled={!draftDirty} onClick={() => setEdit(null)}>
              Discard changes
            </Button>
            <ConfirmDialog
              trigger={
                <Button variant="ghost" pending={seed.pending}>
                  Make draft again
                </Button>
              }
              title="Replace the draft?"
              description="The new draft gets the description of the newest run with a description, and the title of the tip of the branch. The labels and the pull request number stay."
              confirmLabel="Replace"
              onConfirm={() => void seed.run()}
            />
            {draftDirty && <span className="small muted">Changes not saved</span>}
          </div>
          {save.error !== null && <Notice tone="error">{save.error}</Notice>}

          <section className="subsection" aria-label="Lint">
            <h3>Lint</h3>
            {draftDirty && <p className="small muted">Lint runs when you save the draft.</p>}
            {findings === null ? (
              <p className="small muted">memelint gave no result. The server log has the error.</p>
            ) : findings.length === 0 ? (
              <Notice tone="success">No findings.</Notice>
            ) : (
              <ul className="findings">
                {findings.map((f, i) => (
                  <li key={i}>
                    <span className="mono">
                      {f.file}:{f.line}
                    </span>{" "}
                    {f.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="subsection" aria-label="Create">
            {unmet.length > 0 && (
              <Notice tone="warning">
                A check of the tip is unverified: the output of {unmet.join(", ")} did not agree with the pass expression. Examine the check output on the Work tab, then make the decision.
              </Notice>
            )}
            <Checkbox
              className="publish-confirm"
              checked={confirmed}
              onCheckedChange={setConfirmed}
              label="I established confidence in this output: I reviewed the code change and this description, and the verification tooling is disclosed."
            />
            <div className="row">
              <Button variant="primary" disabled={blockers.length > 0} pending={publish.pending} onClick={() => void publish.run()}>
                {meta?.number != null ? "Push and update pull request" : "Push and create pull request"}
              </Button>
              <span className="small muted">
                to {fork === null ? "the fork of the settings" : <span className="mono">{`${fork}/${campaign.issue.repo.split("/")[1] ?? ""}`}</span>}
              </span>
              <Checkbox checked={force} onCheckedChange={setForce} disabled={publish.pending} label="Force push" />
            </div>
            {blockers.length > 0 && (
              <ul className="reasons" aria-label="Reasons that the button is disabled">
                {blockers.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {publish.error !== null && <Notice tone="error">{publish.error}</Notice>}
            {(output !== null || attempt !== null) && (
              <Disclosure key={attempts} label="Output" defaultOpen={attempts > 0}>
                <CodeBlock label="Output of the publish" wrap follow text={output} loading={publish.pending} empty="No command started." maxHeight="24rem" />
              </Disclosure>
            )}
          </section>
        </section>

        <section className="panel publish-preview" aria-label="Preview">
          <div className="panel-head">
            <h2>Preview</h2>
            {draftDirty && <span className="small muted">The preview shows the saved draft.</span>}
          </div>
          {detail.mark_problems.length > 0 && (
            <Notice tone="error" aria-label="Mark problems">
              <p>GitHub shows a mark with a problem as text. Correct the marks of the draft: until then, the pull request button stays disabled.</p>
              <ul className="reasons">
                {detail.mark_problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Notice>
          )}
          {detail.rendered === null ? <p className="muted">No preview.</p> : <Markdown text={detail.rendered} aria-label="Preview of the description" />}
          {detail.rendered !== null && (
            <Disclosure label="Markdown text">
              <CodeBlock label="Markdown text of the description" wrap text={detail.rendered} maxHeight="32rem" />
            </Disclosure>
          )}
        </section>
      </div>
    </div>
  );
}

function PrDone({ meta, number, repo }: { meta: Pr; number: number; repo: string }) {
  return (
    <section className={`pr-done pr-done--${meta.state}`} aria-label="Pull request on GitHub">
      <div className="row">
        <Link href={meta.url ?? pullUrl(repo, number)}>
          <strong>#{number}</strong> {meta.title}
        </Link>
        <Badge tone={STATE_TONE[meta.state === "open" ? "pr" : meta.state]}>{meta.state}</Badge>
        {meta.confirmed != null && <span className="small muted">Confidence confirmed {time(meta.confirmed)}</span>}
      </div>
      <dl className="meta">
        {meta.state === "merged" && (
          <>
            <dt>Merged</dt>
            <dd>{time(meta.merged)}</dd>
          </>
        )}
        <dt>Created</dt>
        <dd>{time(meta.created)}</dd>
        <dt>Updated</dt>
        <dd>{time(meta.updated)}</dd>
        <dt>Pushed</dt>
        <dd className="mono">{meta.pushed === null ? "never" : short(meta.pushed)}</dd>
      </dl>
    </section>
  );
}
