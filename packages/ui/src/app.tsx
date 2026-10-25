import { useEffect } from "react";
import type { Client } from "./api.ts";
import { ClientProvider } from "./client.tsx";
import { Breadcrumbs, type Crumb } from "./components/Breadcrumbs.tsx";
import { Link } from "./components/Link.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { TooltipProvider } from "./components/Tooltip.tsx";
import { href, route, usePath, type Route } from "./router.ts";
import { CampaignPage } from "./views/CampaignPage.tsx";
import { CampaignsPage } from "./views/CampaignsPage.tsx";
import { NotFound } from "./views/NotFound.tsx";
import { SettingsPage } from "./views/SettingsPage.tsx";
import { BranchPage } from "./views/BranchPage.tsx";

function crumbs(r: Route): Crumb[] {
  switch (r.page) {
    case "campaigns":
      return [];
    case "campaign":
      return [{ label: "Campaigns", href: href.home() }, { label: r.campaign }];
    case "branch":
      return [{ label: "Campaigns", href: href.home() }, { label: r.campaign, href: href.campaign(r.campaign) }, { label: r.key }];
    case "settings":
      return [{ label: "Campaigns", href: href.home() }, { label: "Settings" }];
    case "missing":
      return [{ label: "Campaigns", href: href.home() }];
  }
}

function title(r: Route): string {
  switch (r.page) {
    case "campaigns":
      return "patchix";
    case "campaign":
      return `${r.campaign} · patchix`;
    case "branch":
      return `${r.key} · ${r.campaign} · patchix`;
    case "settings":
      return "Settings · patchix";
    case "missing":
      return "No such page · patchix";
  }
}

function Page({ r }: { r: Route }) {
  switch (r.page) {
    case "campaigns":
      return <CampaignsPage />;
    case "campaign":
      return <CampaignPage key={r.campaign} campaign={r.campaign} />;
    case "branch":
      return <BranchPage key={`${r.campaign}/${r.key}`} campaign={r.campaign} branch={r.key} />;
    case "settings":
      return <SettingsPage />;
    case "missing":
      return <NotFound path={r.path} />;
  }
}

export function App({ client }: { client: Client }) {
  const r = route(usePath());
  useEffect(() => {
    document.title = title(r);
  });
  return (
    <ClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <header className="app-header">
            <Link href={href.home()} className="app-brand">
              patchix
            </Link>
            <Breadcrumbs items={crumbs(r)} />
            <span className="spacer" />
            <Link href={href.settings()} aria-current={r.page === "settings" ? "page" : undefined}>
              Settings
            </Link>
          </header>
          <main className="page">
            <Page r={r} />
          </main>
        </ToastProvider>
      </TooltipProvider>
    </ClientProvider>
  );
}
