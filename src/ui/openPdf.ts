// Opening a PDF replaces the app element's current PDF workspace.

import {
  createPdfWorkspaceState,
  type PdfWorkspaceState,
} from "../pdf/pdfWorkspace";
import { appRoot as root, appState as state } from "./appRoot";
import { clearNotification, notify } from "./notifications";
import { renderApp } from "./renderApp";
import { clearOcrRecognitionCache } from "./screens/analysis/ocr";
import { restorePracticeState } from "./screens/practice/restorePracticeState";
import { resetBoundaryDraft } from "./scriptEditor";
import { resetScriptDataCaches } from "./shared/correctedScriptBlocks";
import { refreshAutomaticRoles } from "./shared/scriptRoles";

export async function openPdf(file: File): Promise<void> {
  if (state.loading) return;
  const requestedResumeFingerprint = state.pendingResumeFingerprint;
  state.pendingResumeFingerprint = null;
  if (
    !file.name.toLocaleLowerCase("ja-JP").endsWith(".pdf") &&
    file.type !== "application/pdf"
  ) {
    state.error = "PDFファイルを選んでください。";
    if (requestedResumeFingerprint)
      notify("保存した台本と同じPDFを選んでください。", "warning");
    renderApp();
    return;
  }

  clearNotification();
  state.error = "";
  state.loading = true;
  state.loadingPurpose = "opening-pdf";
  state.progress = 0;
  state.progressLabel = "PDFを読み取っています";
  renderApp();

  let pdfWorkspace: PdfWorkspaceState | null = null;
  try {
    const { loadPdf } = await import("../pdf/loadPdf");
    const loaded = await loadPdf(file, (pageNumber, pageCount) => {
      state.progress = Math.round((pageNumber / pageCount) * 100);
      state.progressLabel = `${pageNumber} / ${pageCount}ページを読み取り中`;
      const bar = document.querySelector<HTMLDivElement>("#load-progress-bar");
      const label = document.querySelector<HTMLElement>("#load-progress-label");
      if (bar) bar.style.width = `${state.progress}%`;
      if (label) label.textContent = state.progressLabel;
    });

    clearOcrRecognitionCache();
    resetScriptDataCaches(root.pdfWorkspace.script);
    pdfWorkspace = createPdfWorkspaceState();
    pdfWorkspace.file.document = loaded.document;
    pdfWorkspace.file.disposePdf = loaded.dispose;
    pdfWorkspace.file.pdfFingerprint = loaded.fingerprint;
    pdfWorkspace.file.fileName = file.name;
    pdfWorkspace.file.fileSize = file.size;
    pdfWorkspace.script.pages = loaded.pages;
    pdfWorkspace.script.originalPages = [...loaded.pages];
    pdfWorkspace.analysis.previewPage = loaded.pages.length > 1 ? 2 : 1;
    root.pdfWorkspace = pdfWorkspace;
    resetBoundaryDraft();
    refreshAutomaticRoles();
    state.screen = "analysis";
    state.loading = Boolean(requestedResumeFingerprint);
    if (requestedResumeFingerprint) {
      state.loadingPurpose = "restoring-practice";
      state.progress = 100;
      state.progressLabel = "練習設定を復元しています";
    }
    renderApp();
    await restorePracticeState(
      pdfWorkspace,
      loaded.fingerprint,
      loaded.pages.length,
      requestedResumeFingerprint,
    );
  } catch {
    if (pdfWorkspace && root.pdfWorkspace !== pdfWorkspace) return;
    state.loading = false;
    state.error =
      "このPDFを読み取れませんでした。パスワードで保護されている場合は、保護を解除したPDFを選んでください。";
    if (requestedResumeFingerprint)
      notify(
        "このPDFを読み取れなかったため、前回の練習設定を復元できませんでした。",
        "warning",
      );
    renderApp();
  }
}
