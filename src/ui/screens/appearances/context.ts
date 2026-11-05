import { appRoot as root, appState as state } from "../../appRoot";
import { renderApp } from "../../renderApp";
import { beginPractice } from "../practice/beginPractice";

export function bindAppearancesContext(signal: AbortSignal): void {
  root.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLElement>("[data-action]");
      if (!button) return;

      switch (button.dataset.action) {
        case "back-to-analysis":
          state.screen = "analysis";
          renderApp();
          break;
        case "start-practice":
          void beginPractice(Number(button.dataset.targetIndex ?? 0));
          break;
      }
    },
    { signal },
  );
}
