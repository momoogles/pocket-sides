// Save the current rehearsal before opening the scene list.

import { appRoot as root, appState as state } from "../../appRoot";
import { notify } from "../../notifications";
import { renderApp } from "../../renderApp";
import { currentPracticeTargets } from "../../shared/currentPracticeTargets";
import {
  clearScheduledPracticeSave,
  saveCurrentPractice,
} from "./practiceHistory";

export async function continueToAppearances(): Promise<void> {
  const pdfWorkspace = root.pdfWorkspace;
  if (
    currentPracticeTargets().length === 0 ||
    pdfWorkspace.analysis.ocrBusy ||
    pdfWorkspace.analysis.layoutPreview ||
    pdfWorkspace.analysis.textOcrPreview ||
    pdfWorkspace.practice.practiceSaveBusy
  )
    return;
  let saveError = false;
  if (pdfWorkspace.practice.practiceHasStarted) {
    clearScheduledPracticeSave();
    pdfWorkspace.practice.practiceSaveBusy = true;
    renderApp();
    try {
      await saveCurrentPractice(pdfWorkspace);
    } catch {
      saveError = true;
    }
    if (root.pdfWorkspace !== pdfWorkspace) return;
    pdfWorkspace.practice.practiceSaveBusy = false;
    if (saveError)
      notify(
        "練習設定を保存できませんでした。前回保存した設定は残っています。",
        "warning",
      );
  }
  state.screen = "appearances";
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
