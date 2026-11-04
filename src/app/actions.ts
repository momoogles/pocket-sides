// PDF lifecycle and local practice-history workflows.

import { loadPdf } from "../pdf/extract";
import { getSavedReading, listSavedReadings } from "../pdf/ocr-cache";
import {
  canSavePracticeHistory,
  deleteAllSavedPracticeData,
  deleteSavedPractice,
  getSavedPractice,
  listSavedPractices,
  type SavedPractice,
  type SavedPracticeInput,
  savePractice,
} from "../pdf/practice-cache";
import { isOcrRecognizedPage } from "../pdf/reconciliation";
import { normalizeAlias } from "../pdf/segments";
import { OCR_RECOGNITION_VERSION } from "../pdf/types";
import {
  cancelPdfPreview,
  clearNotification,
  notify,
  renderApp,
  resetBoundaryDraft,
} from "../ui/render";
import {
  applyCachedImageAnalysis,
  clearOcrRecognitionCache,
} from "./ocr-actions";
import {
  practiceTargets,
  refreshAutomaticRoles,
  resetScriptModelCaches,
  selectedRole,
} from "./script-model";
import { state } from "./state";

let practiceSaveTimer: number | null = null;

export async function openPdf(file: File): Promise<void> {
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

  try {
    const loaded = await loadPdf(file, (pageNumber, pageCount) => {
      state.progress = Math.round((pageNumber / pageCount) * 100);
      state.progressLabel = `${pageNumber} / ${pageCount}ページを読み取り中`;
      const bar = document.querySelector<HTMLDivElement>("#load-progress-bar");
      const label = document.querySelector<HTMLElement>("#load-progress-label");
      if (bar) bar.style.width = `${state.progress}%`;
      if (label) label.textContent = state.progressLabel;
    });

    state.document = loaded.document;
    state.disposePdf = loaded.dispose;
    state.pages = loaded.pages;
    state.originalPages = [...loaded.pages];
    clearOcrRecognitionCache();
    resetBoundaryDraft();
    state.pdfFingerprint = loaded.fingerprint;
    state.cachedOcrPages = [];
    state.savedPractice = null;
    state.practiceHasStarted = false;
    state.fileName = file.name;
    state.fileSize = file.size;
    state.corrections = {};
    state.roles = [];
    state.excludedRoleIds = new Set();
    state.selectedRoleId = "";
    state.manualSpeakers = {};
    state.boundaryEdits = [];

    state.ranges = {};
    state.currentTargetIndex = 0;
    state.revealed = false;
    state.showOriginal = false;
    state.previewPage = loaded.pages.length > 1 ? 2 : 1;
    state.originalPage = 1;
    state.ocrBusy = false;
    state.ocrCancelRequested = false;
    state.ocrProgress = 0;
    state.ocrTotal = 0;
    state.ocrStatus = "";
    state.ocrErrors = { text: "", layout: "" };
    state.textOcrCompletion = null;
    state.layoutPreview = null;
    state.ocrAnalysisComplete = false;
    state.textOcrPreview = null;
    refreshAutomaticRoles();
    state.screen = "analysis";
    state.loading = Boolean(requestedResumeFingerprint);
    if (requestedResumeFingerprint) {
      state.loadingPurpose = "restoring-practice";
      state.progress = 100;
      state.progressLabel = "練習設定を復元しています";
    }
    renderApp();
    await findSavedPractice(
      loaded.fingerprint,
      loaded.pages.length,
      requestedResumeFingerprint,
    );
  } catch {
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

async function findSavedPractice(
  fingerprint: string | null,
  pageCount: number,
  requestedResumeFingerprint: string | null,
): Promise<void> {
  const restorationStartedAt = requestedResumeFingerprint
    ? performance.now()
    : null;
  const keepRestorationVisible = async (): Promise<void> => {
    if (restorationStartedAt === null) return;
    const remaining = 1000 - (performance.now() - restorationStartedAt);
    if (remaining > 0)
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, remaining),
      );
  };
  let restoredPreviousImageAnalysis = false;

  if (!fingerprint) {
    await keepRestorationVisible();
    state.loading = false;
    if (requestedResumeFingerprint) {
      state.screen = "analysis";
      notify(
        "このPDFを照合できないため、前回の練習設定を復元できませんでした。",
        "warning",
      );
    }
    renderApp();
    return;
  }

  try {
    const savedPractice = await getSavedPractice(fingerprint);
    if (state.pdfFingerprint !== fingerprint) return;
    if (savedPractice && savedPractice.pageCount === pageCount) {
      state.savedPractice = savedPractice;
      if (requestedResumeFingerprint === fingerprint) {
        await keepRestorationVisible();
        applySavedPractice(savedPractice);
        return;
      }
      const recognizedPages = savedPractice.pages.filter(isOcrRecognizedPage);
      const savedOcrPages = recognizedPages.filter(
        (page) => page.recognitionVersion === OCR_RECOGNITION_VERSION,
      );
      if (savedOcrPages.length > 0) {
        state.cachedOcrPages = savedOcrPages;
      } else {
        const legacyReading = await getSavedReading(fingerprint);
        if (state.pdfFingerprint !== fingerprint) return;
        if (legacyReading && legacyReading.pageCount === pageCount)
          state.cachedOcrPages = legacyReading.pages;
      }
      if (
        recognizedPages.some(
          (page) => page.recognitionVersion !== OCR_RECOGNITION_VERSION,
        ) &&
        !requestedResumeFingerprint
      ) {
        notify(
          "画像解析の仕組みを更新しました。前回の結果は使わず、必要なページを読み直してください。",
          "info",
        );
      }
    } else {
      const legacyReading = await getSavedReading(fingerprint);
      if (state.pdfFingerprint !== fingerprint) return;
      if (legacyReading && legacyReading.pageCount === pageCount) {
        state.cachedOcrPages = legacyReading.pages;
        if (requestedResumeFingerprint === fingerprint) {
          applyCachedImageAnalysis(false);
          restoredPreviousImageAnalysis = true;
        }
      } else if (requestedResumeFingerprint === fingerprint) {
        notify(
          "この台本の練習設定は保存されていません。役を選んで練習を始めてください。",
          "info",
        );
      }
    }
    if (
      requestedResumeFingerprint &&
      requestedResumeFingerprint !== fingerprint
    ) {
      notify(
        "選んだPDFが前回の台本と一致しませんでした。保存した設定は使わず、このPDFを開きました。",
        "warning",
      );
    }
  } catch {
    if (state.pdfFingerprint !== fingerprint) return;
    notify(
      "前回の練習設定を復元できませんでした。このPDFで練習を始められます。",
      "warning",
    );
  }

  await refreshSavedPracticeList();
  if (state.pdfFingerprint === fingerprint) {
    await keepRestorationVisible();
    state.loading = false;
    if (requestedResumeFingerprint && state.screen !== "appearances")
      state.screen = "analysis";
    if (restoredPreviousImageAnalysis) {
      notify(
        "前回の画像解析結果を適用しました。練習する役を選んでください。",
        "success",
      );
    }
    renderApp();
  }
}

export async function refreshSavedPracticeList(): Promise<void> {
  try {
    const [practices, readings] = await Promise.all([
      listSavedPractices(),
      listSavedReadings(),
    ]);
    state.savedPractices = practices;
    const practiceFingerprints = new Set(
      practices.map((practice) => practice.fingerprint),
    );
    state.legacySavedReadings = readings.filter(
      (reading) => !practiceFingerprints.has(reading.fingerprint),
    );
    if (state.screen === "home") renderApp();
  } catch {
    state.savedPractices = [];
    state.legacySavedReadings = [];
  }
}

function applySavedPractice(saved: SavedPractice): void {
  if (state.ocrBusy || state.practiceSaveBusy) return;
  const outdatedRecognition = saved.pages.some(
    (page) =>
      isOcrRecognizedPage(page) &&
      page.recognitionVersion !== OCR_RECOGNITION_VERSION,
  );
  state.loading = false;
  state.savedPractice = saved;
  state.pages = saved.pages.map((page) => {
    if (
      !isOcrRecognizedPage(page) ||
      page.recognitionVersion === OCR_RECOGNITION_VERSION
    ) {
      return structuredClone(page);
    }
    return structuredClone(state.originalPages[page.pageNumber - 1] ?? page);
  });
  state.roles = structuredClone(saved.settings.roles);
  state.excludedRoleIds = new Set(saved.settings.excludedRoleIds);
  state.selectedRoleId = saved.settings.selectedRoleId;
  state.manualSpeakers = { ...saved.settings.manualSpeakers };
  state.boundaryEdits = saved.settings.boundaryEdits ?? [];

  state.manualRoleNumber = saved.settings.manualRoleNumber;
  state.corrections = { ...saved.settings.corrections };
  state.ranges = structuredClone(saved.settings.ranges);
  state.currentTargetIndex = 0;
  state.previewPage = Math.min(
    Math.max(1, saved.settings.previewPage),
    state.pages.length,
  );
  state.cachedOcrPages = [];
  state.practiceHasStarted = false;
  state.revealed = false;
  state.showOriginal = false;
  refreshAutomaticRoles();

  if (!state.roles.some((role) => role.id === state.selectedRoleId)) {
    const previousRole = saved.settings.roles.find(
      (role) => role.id === saved.settings.selectedRoleId,
    );
    if (previousRole) {
      const previousNames = new Set(
        [previousRole.label, ...previousRole.aliases].map(normalizeAlias),
      );
      const matchingRole = state.roles.find((role) =>
        [role.label, ...role.aliases].some((name) =>
          previousNames.has(normalizeAlias(name)),
        ),
      );
      if (matchingRole) state.selectedRoleId = matchingRole.id;
    }
  }

  const targetCount = practiceTargets().length;
  if (targetCount === 0) {
    state.screen = "analysis";
    notify(
      outdatedRecognition
        ? "役の設定は復元しました。文字の読み取り方法が変わったため、画像解析をやり直してください。"
        : "前回の練習設定は復元しましたが、練習シーンが見つかりませんでした。読み取り結果を確認してください。",
      "warning",
    );
  } else {
    state.currentTargetIndex = Math.min(
      Math.max(0, saved.settings.currentTargetIndex),
      targetCount - 1,
    );
    state.screen = "appearances";
    state.practiceHasStarted = true;
    notify(
      outdatedRecognition
        ? `前回の「${selectedRole()?.label ?? "選んだ役"}」の練習設定を復元しました。読み取り結果から画像解析をやり直せます。`
        : `前回の「${selectedRole()?.label ?? "選んだ役"}」の練習設定を復元しました。`,
      outdatedRecognition ? "info" : "success",
    );
  }
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function currentPracticeSnapshot(): SavedPracticeInput | null {
  if (
    !state.pdfFingerprint ||
    state.pages.length === 0 ||
    !state.selectedRoleId
  )
    return null;
  return {
    fingerprint: state.pdfFingerprint,
    pageCount: state.pages.length,
    pages: structuredClone(state.pages),
    fileName: state.fileName,
    settings: {
      roles: structuredClone(state.roles),
      excludedRoleIds: [...state.excludedRoleIds],
      selectedRoleId: state.selectedRoleId,
      manualSpeakers: { ...state.manualSpeakers },
      boundaryEdits: state.boundaryEdits,
      manualRoleNumber: state.manualRoleNumber,
      corrections: { ...state.corrections },
      ranges: structuredClone(state.ranges),
      currentTargetIndex: state.currentTargetIndex,
      previewPage: state.previewPage,
    },
  };
}

async function saveCurrentPractice(): Promise<SavedPractice> {
  if (!canSavePracticeHistory())
    throw new Error("このブラウザでは練習設定を保存できません。");
  const snapshot = currentPracticeSnapshot();
  if (!snapshot) throw new Error("保存する練習設定が見つかりません。");
  const saved = await savePractice(snapshot);
  state.savedPractice = saved;
  await refreshSavedPracticeList();
  return saved;
}

export async function continueToAppearances(): Promise<void> {
  if (
    practiceTargets().length === 0 ||
    state.ocrBusy ||
    state.layoutPreview ||
    state.textOcrPreview ||
    state.practiceSaveBusy
  )
    return;
  let saveError = false;
  if (state.practiceHasStarted) {
    clearScheduledPracticeSave();
    state.practiceSaveBusy = true;
    renderApp();
    try {
      await saveCurrentPractice();
    } catch {
      saveError = true;
    }
    state.practiceSaveBusy = false;
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

export async function beginPractice(targetIndex: number): Promise<void> {
  const targetCount = practiceTargets().length;
  if (targetCount === 0 || state.practiceSaveBusy) return;
  clearScheduledPracticeSave();
  state.currentTargetIndex = Math.min(
    Math.max(0, targetIndex),
    targetCount - 1,
  );
  state.practiceSaveBusy = true;
  renderApp();

  let saveError = false;
  try {
    await saveCurrentPractice();
  } catch {
    saveError = true;
  }

  state.practiceSaveBusy = false;
  state.screen = "practice";
  state.practiceHasStarted = true;
  state.revealed = false;
  state.showOriginal = false;
  if (saveError)
    notify(
      "練習は続けられますが、この端末内に設定を保存できませんでした。",
      "warning",
    );
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export function schedulePracticeSave(): void {
  if (
    state.screen !== "practice" ||
    !state.savedPractice ||
    state.practiceSaveBusy
  )
    return;
  if (practiceSaveTimer !== null) window.clearTimeout(practiceSaveTimer);
  practiceSaveTimer = window.setTimeout(() => {
    practiceSaveTimer = null;
    void saveCurrentPractice().catch(() => {
      notify("練習設定を保存できませんでした。", "warning");
      renderApp();
    });
  }, 600);
}

function clearScheduledPracticeSave(): void {
  if (practiceSaveTimer !== null) window.clearTimeout(practiceSaveTimer);
  practiceSaveTimer = null;
}

export async function deleteAllSavedPracticeDataFromDevice(): Promise<void> {
  if (
    state.savedPractices.length + state.legacySavedReadings.length === 0 ||
    state.ocrBusy ||
    state.practiceSaveBusy
  )
    return;
  if (
    !window.confirm(
      "この端末内に保存した練習設定と読み取り結果をすべて削除しますか？PDFファイルは削除されません。",
    )
  )
    return;
  try {
    await deleteAllSavedPracticeData();
    state.savedPractices = [];
    state.legacySavedReadings = [];
    state.savedPractice = null;
    state.cachedOcrPages = [];
    notify("保存した練習設定と読み取り結果をすべて削除しました。", "success");
  } catch {
    notify("保存した練習設定と読み取り結果を削除できませんでした。", "warning");
  }
  renderApp();
}

export async function deleteSavedPracticeFromHome(
  fingerprint: string,
): Promise<void> {
  const reading = [...state.savedPractices, ...state.legacySavedReadings].find(
    (candidate) => candidate.fingerprint === fingerprint,
  );
  if (!reading || state.ocrBusy || state.practiceSaveBusy) return;
  const name = reading.fileName || "ファイル名未登録のPDF";
  if (
    !window.confirm(
      `「${name}」の練習設定と読み取り結果を、この端末から削除しますか？PDFファイルは削除されません。`,
    )
  )
    return;
  try {
    await deleteSavedPractice(fingerprint);
    if (state.pdfFingerprint === fingerprint) {
      state.savedPractice = null;
      state.cachedOcrPages = [];
    }
    await refreshSavedPracticeList();
    notify("この台本の練習設定と読み取り結果を削除しました。", "success");
  } catch {
    notify(
      "この台本の練習設定と読み取り結果を削除できませんでした。",
      "warning",
    );
  }
  renderApp();
}

export async function closePdf(): Promise<void> {
  if (state.loading || state.ocrBusy || state.practiceSaveBusy) return;
  clearScheduledPracticeSave();
  if (state.practiceHasStarted) {
    state.practiceSaveBusy = true;
    renderApp();
    try {
      await saveCurrentPractice();
    } catch {
      if (
        !window.confirm(
          "練習設定を保存できませんでした。変更を保存せずに台本を閉じますか？",
        )
      ) {
        state.practiceSaveBusy = false;
        renderApp();
        return;
      }
    }
  }
  cancelPdfPreview();
  const dispose = state.disposePdf;
  state.document = null;
  state.disposePdf = null;
  state.pages = [];
  state.originalPages = [];
  resetBoundaryDraft();
  state.ocrAnalysisComplete = false;
  state.textOcrPreview = null;
  state.textOcrCompletion = null;
  clearOcrRecognitionCache();
  state.boundaryEdits = [];

  state.layoutPreview = null;
  state.pdfFingerprint = null;
  state.cachedOcrPages = [];
  state.savedPractice = null;
  clearNotification();
  state.practiceHasStarted = false;
  state.pendingResumeFingerprint = null;
  state.practiceSaveBusy = false;
  state.fileName = "";
  state.fileSize = 0;
  state.corrections = {};
  state.roles = [];
  state.excludedRoleIds = new Set();
  state.selectedRoleId = "";
  state.manualSpeakers = {};
  state.ranges = {};
  resetScriptModelCaches();
  state.currentTargetIndex = 0;
  state.revealed = false;
  state.showOriginal = false;
  state.screen = "home";
  state.error = "";
  state.ocrBusy = false;
  state.ocrCancelRequested = false;
  state.ocrProgress = 0;
  state.ocrTotal = 0;
  state.ocrStatus = "";
  state.ocrErrors = { text: "", layout: "" };
  const fileInput = document.querySelector<HTMLInputElement>("#pdf-input");
  if (fileInput) fileInput.value = "";
  renderApp();
  if (dispose) await dispose();
}
