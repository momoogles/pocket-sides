// Save the chosen scene before entering rehearsal.

import { appRoot as root, appState as state } from "../../appRoot";
import { notify } from "../../notifications";
import { renderApp } from "../../renderApp";
import { currentPracticeTargets } from "../../shared/currentPracticeTargets";
import {
  clearScheduledPracticeSave,
  saveCurrentPractice,
} from "./practiceHistory";

export async function beginPractice(targetIndex: number): Promise<void> {
  const pdfWorkspace = root.pdfWorkspace;
  const targetCount = currentPracticeTargets().length;
  if (targetCount === 0 || pdfWorkspace.practice.practiceSaveBusy) return;
  clearScheduledPracticeSave();
  pdfWorkspace.practice.currentTargetIndex = Math.min(
    Math.max(0, targetIndex),
    targetCount - 1,
  );
  pdfWorkspace.practice.practiceSaveBusy = true;
  renderApp();

  let saveError = false;
  try {
    await saveCurrentPractice(pdfWorkspace);
  } catch {
    saveError = true;
  }

  if (root.pdfWorkspace !== pdfWorkspace) return;
  pdfWorkspace.practice.practiceSaveBusy = false;
  state.screen = "practice";
  pdfWorkspace.practice.practiceHasStarted = true;
  if (saveError)
    notify(
      "練習は続けられますが、この端末内に設定を保存できませんでした。",
      "warning",
    );
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
