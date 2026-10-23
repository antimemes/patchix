import { createContext, useContext, type ReactNode } from "react";
import type { Client } from "./api.ts";

const ClientContext = createContext<Client | null>(null);

export function ClientProvider({ client, children }: { client: Client; children: ReactNode }) {
  return <ClientContext value={client}>{children}</ClientContext>;
}

export function useClient(): Client {
  const client = useContext(ClientContext);
  if (client === null) throw new Error("useClient: no ClientProvider above this component");
  return client;
}
