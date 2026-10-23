import "./theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { httpClient } from "./api.ts";
import { App } from "./app.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>
    <App client={httpClient()} />
  </StrictMode>,
);
