// Closing a PDF saves active practice settings, then releases its workspace.

import { createPdfWorkspaceState } from "../pdf/pdfWorkspace";
import { appRoot as root, appState as state } from "./appRoot";
import { clearNotification } from "./notifications";
import { cancelPdfPreview } from "./pdfPreview";
import { renderApp } from "./renderApp";
import { clearOcrRecognitionCache } from "./screens/analysis/ocr";
import {
  clearScheduledPracticeSave,
  saveCurrentPractice,
} from "./screens/practice/practiceHistory";
import { resetBoundaryDraft } from "./scriptEditor";
import { resetScriptDataCaches } from "./shared/correctedScriptBlocks";

export async function closePdf(): Promise<void> {
  if (
    state.loading ||
    root.pdfWorkspace.analysis.ocrBusy ||
    root.pdfWorkspace.practice.practiceSaveBusy
  )
    return;
  const pdfWorkspace = root.pdfWorkspace;
  clearScheduledPracticeSave();
  if (pdfWorkspace.practice.practiceHasStarted) {
    pdfWorkspace.practice.practiceSaveBusy = true;
    renderApp();
    try {
      await saveCurrentPractice(pdfWorkspace);
    } catch {
      if (
        !window.confirm(
          "練習設定を保存できませんでした。変更を保存せずに台本を閉じますか？",
        )
      ) {
        pdfWorkspace.practice.practiceSaveBusy = false;
        renderApp();
        return;
      }
    }
    if (root.pdfWorkspace !== pdfWorkspace) return;
  }
  cancelPdfPreview();
  const dispose = pdfWorkspace.file.disposePdf;
  clearOcrRecognitionCache();
  resetScriptDataCaches(pdfWorkspace.script);
  root.pdfWorkspace = createPdfWorkspaceState();
  resetBoundaryDraft();
  clearNotification();
  state.pendingResumeFingerprint = null;
  state.screen = "home";
  state.error = "";
  const fileInput = document.querySelector<HTMLInputElement>("#pdf-input");
  if (fileInput) fileInput.value = "";
  renderApp();
  if (dispose) await dispose();
}
