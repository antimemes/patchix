import { useState } from "react";
import type { Settings, SettingsView } from "@patchix/common";
import { Button } from "../components/Button.tsx";
import { TextField } from "../components/Field.tsx";
import { Notice } from "../components/Notice.tsx";
import { Progress } from "../components/Progress.tsx";
import { useToast } from "../components/Toast.tsx";
import { useClient } from "../client.tsx";
import { useAction, useLoad } from "../hooks.ts";
import "./views.css";

/** The settings of this person and this host: `settings.yaml` of the data directory of the server. */
export function SettingsPage() {
  const client = useClient();
  const settings = useLoad(() => client.settings(), "settings");
  if (settings.data === null) {
    return settings.error !== null ? <Notice tone="error">{settings.error}</Notice> : <Progress value={null} label="Loading the settings" />;
  }
  // A new view from the server gives new fields with its values.
  return <SettingsForm key={JSON.stringify(settings.data)} view={settings.data} onSaved={settings.replace} />;
}

/** `GITHUB_LOGIN` of `@patchix/common`. The client does not import the schemas: the server examines the body again. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** The values of the fields, as text. */
interface Draft {
  fork: string;
  model: string;
  concurrency: string;
}

/** The settings of the fields, or the error of each incorrect field. */
function check(d: Draft): { settings: Settings | null; errors: Partial<Record<keyof Draft, string>> } {
  const fork = d.fork.trim();
  const model = d.model.trim();
  const concurrency = Number(d.concurrency.trim());
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (fork !== "" && !LOGIN.test(fork)) errors.fork = "A GitHub login: letters, digits and -, 39 signs or less.";
  if (model === "" || /\s/.test(model)) errors.model = "A model id without spaces, for example claude-opus-5-5.";
  if (!/^\d+$/.test(d.concurrency.trim()) || concurrency < 1) errors.concurrency = "A number of 1 or more.";
  const ok = Object.keys(errors).length === 0;
  return { settings: ok ? { fork: fork === "" ? null : fork, model, concurrency } : null, errors };
}

function SettingsForm({ view, onSaved }: { view: SettingsView; onSaved: (view: SettingsView) => void }) {
  const client = useClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({ fork: view.fork ?? "", model: view.model, concurrency: String(view.concurrency) });
  const { settings, errors } = check(draft);
  const changed = settings !== null && (settings.fork !== view.fork || settings.model !== view.model || settings.concurrency !== view.concurrency);
  const save = useAction(async (next: Settings) => {
    onSaved(await client.saveSettings(next));
    toast("The settings are saved", "The next runs and asks use them.");
  });
  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const login = view.fork_effective ?? "";

  return (
    <section className="stack">
      <h1>Settings</h1>
      <p className="muted small">
        The values of this person and this machine, in <code>{view.data}/settings.yaml</code>. They are not in git.
      </p>
      <form
        className="stack-lg settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (settings !== null) void save.run(settings);
        }}
      >
        <TextField
          label="nixpkgs fork"
          value={draft.fork}
          onValueChange={set("fork")}
          placeholder={login}
          error={errors.fork}
          autoComplete="off"
          spellCheck={false}
          description={
            view.fork === null && view.fork_effective !== null
              ? `The GitHub user of the fork. Empty: the gh login, now ${view.fork_effective}.`
              : "The GitHub user of the fork. Empty: the gh login."
          }
        />
        <TextField label="model" value={draft.model} onValueChange={set("model")} error={errors.model} autoComplete="off" spellCheck={false} description="The claude model of the runs and the asks." />
        <TextField
          label="concurrency"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={draft.concurrency}
          onValueChange={set("concurrency")}
          error={errors.concurrency}
          description="The maximum number of runs and asks of one campaign at the same time."
        />
        {view.fork_effective === null && (
          <Notice tone="warning">No fork: the settings have no fork, and gh api user gave an error. Set the fork, or log in to gh.</Notice>
        )}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!changed} pending={save.pending}>
            Save
          </Button>
        </div>
        {save.error !== null && <Notice tone="error">{save.error}</Notice>}
      </form>
      <p className="small">
        <code>GH_TOKEN</code>: {view.token ? "set" : "not set"} — put it in <code>{view.data}/.env</code>. The server reads it when it starts.
      </p>
    </section>
  );
}
