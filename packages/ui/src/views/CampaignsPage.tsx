import { Badge, StateChip } from "../components/Badge.tsx";
import { Link } from "../components/Link.tsx";
import { Notice } from "../components/Notice.tsx";
import { Progress } from "../components/Progress.tsx";
import { useClient } from "../client.tsx";
import { STATES, issueUrl, time } from "../format.ts";
import { useDebounced, useLoad, useSignals } from "../hooks.ts";
import { href } from "../router.ts";

export function CampaignsPage() {
  const client = useClient();
  const campaigns = useLoad(() => client.campaigns(), "campaigns");
  const reload = useDebounced(campaigns.reload, 300);
  useSignals(reload);

  if (campaigns.data === null) {
    return campaigns.error !== null ? <Notice tone="error">{campaigns.error}</Notice> : <Progress value={null} label="Loading the campaigns" />;
  }
  return (
    <section className="stack">
      <h1>Campaigns</h1>
      {campaigns.error !== null && <Notice tone="error">{campaigns.error}</Notice>}
      {campaigns.data.length === 0 ? (
        <Notice>
          No campaigns. Add a directory to <code>campaigns/</code> and load this page again.
        </Notice>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Issue</th>
                <th>Synced</th>
                <th className="num">Jobs</th>
                <th className="num">Waiting</th>
                <th>Tasks</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.data.map((c) => {
                const total = STATES.reduce((n, s) => n + c.counts[s], 0);
                return (
                  <tr key={c.name}>
                    <td className="wrap">
                      <Link href={href.campaign(c.name)}>{c.title}</Link>
                      <div className="muted small mono">{c.name}</div>
                    </td>
                    <td>
                      <Link href={issueUrl(c.issue.repo, c.issue.number)}>
                        {c.issue.repo}#{c.issue.number}
                      </Link>
                    </td>
                    <td className="small">{time(c.synced)}</td>
                    <td className="num">{c.jobs > 0 ? <Badge tone="blue">{c.jobs}</Badge> : <span className="muted">0</span>}</td>
                    <td className="num">{c.queued > 0 ? <Badge tone="blue" dim>{c.queued}</Badge> : <span className="muted">0</span>}</td>
                    <td>
                      <div className="row">
                        <span className="small muted">{total}</span>
                        {STATES.map((s) => (
                          <StateChip key={s} state={s} count={c.counts[s]} />
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
