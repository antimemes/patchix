import { useState } from "react";
import type { Ask } from "@patchix/common";
import { StatusBadge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { TextArea } from "../components/Field.tsx";
import { Notice } from "../components/Notice.tsx";
import { Progress } from "../components/Progress.tsx";
import { useToast } from "../components/Toast.tsx";
import { useClient } from "../client.tsx";
import { time } from "../format.ts";
import { useAction } from "../hooks.ts";
import { AttachNotice, RemoteText } from "./shared.tsx";
import "./views.css";

const MAX_QUESTION = 4000;

export interface AsksSectionProps {
  campaign: string;
  attr: string;
  asks: readonly Ask[];
  onAsked: () => void;
}

export function AsksSection({ campaign, attr, asks, onAsked }: AsksSectionProps) {
  const client = useClient();
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const ask = useAction(async () => {
    await client.ask(campaign, attr, { question: question.trim() });
    setQuestion("");
    onAsked();
    toast("The agent got the question", "The reply comes in the asks below.");
  });
  const reason = question.length > MAX_QUESTION ? `The question has more than ${MAX_QUESTION} characters.` : null;
  return (
    <section className="panel" aria-label="Asks">
      <div className="panel-head">
        <h2>Asks</h2>
        <span className="muted small">{asks.length}</span>
      </div>
      <p className="small muted">The agent answers in the worktree of the task and can change files there.</p>
      <TextArea label="Question" hideLabel rows={3} maxLength={MAX_QUESTION} value={question} onValueChange={setQuestion} placeholder="A question for the agent" />
      <div className="row">
        <Button variant="primary" disabled={reason !== null || question.trim() === ""} pending={ask.pending} onClick={() => void ask.run()}>
          Ask
        </Button>
        {reason !== null && <span className="small muted">{reason}</span>}
      </div>
      {ask.error !== null && <Notice tone="error">{ask.error}</Notice>}
      {asks.length > 0 && (
        <ul className="plain stack">
          {asks.map((a) => (
            <AskItem key={a.id} campaign={campaign} attr={attr} ask={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AskItem({ campaign, attr, ask }: { campaign: string; attr: string; ask: Ask }) {
  const client = useClient();
  const running = ask.status === "running";
  const version = `${campaign}/${attr}/${ask.id}/${ask.finished ?? "running"}`;
  return (
    <li className="ask">
      <div className="row">
        <span className="mono small">{ask.id}</span>
        <span className="small muted">{time(ask.started)}</span>
        <StatusBadge status={ask.status} />
      </div>
      <p className="ask-question">{ask.question}</p>
      {ask.error !== null && <Notice tone="error">{ask.error}</Notice>}
      {running ? (
        <>
          <Progress value={null} label="The agent writes the reply" />
          <AttachNotice tab={`${campaign}/${attr}/ask`} />
        </>
      ) : (
        <RemoteText label={`Reply to ask ${ask.id}`} wrap loadKey={`reply:${version}`} load={() => client.askFile(campaign, attr, ask.id, "reply")} empty="No reply." maxHeight="24rem" />
      )}
      {ask.files.length > 0 && (
        <div className="stack">
          <span className="small muted">Changed files</span>
          <ul className="paths">
            {ask.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      <Disclosure label="Diff">
        <RemoteText label={`Diff of ask ${ask.id}`} diff loadKey={`diff:${version}`} load={() => client.askFile(campaign, attr, ask.id, "diff")} empty="No diff." />
      </Disclosure>
      <Disclosure label="Prompt">
        <RemoteText label={`Prompt of ask ${ask.id}`} wrap loadKey={`prompt:${version}`} load={() => client.askFile(campaign, attr, ask.id, "prompt")} empty="No prompt." />
      </Disclosure>
    </li>
  );
}
