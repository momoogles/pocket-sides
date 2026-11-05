import { appRoot as root, appState as state } from "../../appRoot";
import {
  deleteAllSavedPracticeDataFromDevice,
  deleteSavedPracticeFromHome,
} from "../practice/practiceHistory";

export function bindHomeContext(signal: AbortSignal): void {
  root.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLElement>("[data-action]");
      if (!button) return;

      switch (button.dataset.action) {
        case "choose-pdf": {
          state.pendingResumeFingerprint = null;
          const fileInput =
            document.querySelector<HTMLInputElement>("#pdf-input");
          if (fileInput) fileInput.value = "";
          fileInput?.click();
          break;
        }
        case "resume-saved-practice":
        case "open-saved-reading": {
          state.pendingResumeFingerprint = button.dataset.fingerprint ?? null;
          const fileInput =
            document.querySelector<HTMLInputElement>("#pdf-input");
          if (fileInput) fileInput.value = "";
          fileInput?.click();
          break;
        }
        case "delete-saved-practice-from-home":
          void deleteSavedPracticeFromHome(button.dataset.fingerprint ?? "");
          break;
        case "delete-all-saved-practices":
          void deleteAllSavedPracticeDataFromDevice();
          break;
      }
    },
    { signal },
  );
}
