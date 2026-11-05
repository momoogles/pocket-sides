// App-wide DOM events for opening, closing, and dismissing application UI.

import { appRoot as root, appState as state } from "./appRoot";
import { closePdf } from "./closePdf";
import { clearNotification } from "./notifications";
import { openPdf } from "./openPdf";
import { renderApp } from "./renderApp";

export function bindAppEvents(signal: AbortSignal): void {
  root.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const action =
        event.target.closest<HTMLElement>("[data-action]")?.dataset.action;

      switch (action) {
        case "go-home":
          state.screen =
            root.pdfWorkspace.script.pages.length > 0 ? "analysis" : "home";
          renderApp();
          break;
        case "close-pdf":
          void closePdf();
          break;
        case "dismiss-notification":
          clearNotification();
          renderApp();
          break;
      }
    },
    { signal },
  );

  root.addEventListener(
    "change",
    (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      if (event.target.id !== "pdf-input") return;

      const file = event.target.files?.[0];
      if (file) void openPdf(file);
    },
    { signal },
  );

  root.addEventListener(
    "dragover",
    (event) => {
      if (!state.loading && root.pdfWorkspace.script.pages.length === 0) {
        event.preventDefault();
        document.querySelector("#drop-zone")?.classList.add("drop-zone-active");
      }
    },
    { signal },
  );

  root.addEventListener(
    "dragleave",
    (event) => {
      const target = event.target;
      if (target instanceof Element && !target.closest("#drop-zone")) return;
      document
        .querySelector("#drop-zone")
        ?.classList.remove("drop-zone-active");
    },
    { signal },
  );

  root.addEventListener(
    "drop",
    (event) => {
      event.preventDefault();
      document
        .querySelector("#drop-zone")
        ?.classList.remove("drop-zone-active");
      const file = event.dataTransfer?.files[0];
      if (file && root.pdfWorkspace.script.pages.length === 0) {
        void openPdf(file);
      }
    },
    { signal },
  );
}
