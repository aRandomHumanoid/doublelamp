import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { boot } from "./live/session";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void boot();

// App-shell service worker (06 A.5). Not in dev, where it would cache Vite's modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e: unknown) => console.warn("service worker not registered", e));
  });
}
