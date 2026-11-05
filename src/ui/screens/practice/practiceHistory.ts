// Practice history listing, automatic saving, and deletion.

import type {
  PdfWorkspaceState,
  PracticeState,
} from "../../../pdf/pdfWorkspace";
import {
  canSavePracticeHistory,
  deleteAllSavedPracticeData,
  deleteSavedPractice,
  listSavedPractices,
  type SavedPractice,
  type SavedPracticeInput,
  savePractice,
} from "../../../pdf/practiceStorage";
import { listSavedReadings } from "../../../pdf/savedReadingStorage";
import { appRoot as root, appState as state } from "../../appRoot";
import { notify } from "../../notifications";
import { renderApp } from "../../renderApp";

const practiceSaveTimers = new WeakMap<PracticeState, number>();

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

function currentPracticeSnapshot(
  pdfWorkspace: PdfWorkspaceState,
): SavedPracticeInput | null {
  if (
    !pdfWorkspace.file.pdfFingerprint ||
    pdfWorkspace.script.pages.length === 0 ||
    !pdfWorkspace.script.selectedRoleId
  )
    return null;
  return {
    fingerprint: pdfWorkspace.file.pdfFingerprint,
    pageCount: pdfWorkspace.script.pages.length,
    pages: structuredClone(pdfWorkspace.script.pages),
    fileName: pdfWorkspace.file.fileName,
    settings: {
      roles: structuredClone(pdfWorkspace.script.roles),
      excludedRoleIds: [...pdfWorkspace.script.excludedRoleIds],
      selectedRoleId: pdfWorkspace.script.selectedRoleId,
      manualSpeakers: { ...pdfWorkspace.script.manualSpeakers },
      boundaryEdits: pdfWorkspace.script.boundaryEdits,
      manualRoleNumber: pdfWorkspace.script.manualRoleNumber,
      corrections: { ...pdfWorkspace.script.corrections },
      ranges: structuredClone(pdfWorkspace.practice.ranges),
      currentTargetIndex: pdfWorkspace.practice.currentTargetIndex,
      previewPage: pdfWorkspace.analysis.previewPage,
    },
  };
}

export async function saveCurrentPractice(
  pdfWorkspace: PdfWorkspaceState,
): Promise<SavedPractice> {
  if (!canSavePracticeHistory())
    throw new Error("このブラウザでは練習設定を保存できません。");
  const snapshot = currentPracticeSnapshot(pdfWorkspace);
  if (!snapshot) throw new Error("保存する練習設定が見つかりません。");
  const saved = await savePractice(snapshot);
  pdfWorkspace.practice.savedPractice = saved;
  await refreshSavedPracticeList();
  return saved;
}

export function schedulePracticeSave(): void {
  const pdfWorkspace = root.pdfWorkspace;
  if (
    state.screen !== "practice" ||
    !pdfWorkspace.practice.savedPractice ||
    pdfWorkspace.practice.practiceSaveBusy
  )
    return;
  const practice = pdfWorkspace.practice;
  const previousTimer = practiceSaveTimers.get(practice);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  const timer = window.setTimeout(() => {
    practiceSaveTimers.delete(practice);
    if (root.pdfWorkspace !== pdfWorkspace) return;
    void saveCurrentPractice(pdfWorkspace).catch(() => {
      notify("練習設定を保存できませんでした。", "warning");
      renderApp();
    });
  }, 600);
  practiceSaveTimers.set(practice, timer);
}

export function clearScheduledPracticeSave(
  practice: PracticeState = root.pdfWorkspace.practice,
): void {
  const timer = practiceSaveTimers.get(practice);
  if (timer !== undefined) window.clearTimeout(timer);
  practiceSaveTimers.delete(practice);
}

export async function deleteAllSavedPracticeDataFromDevice(): Promise<void> {
  const pdfWorkspace = root.pdfWorkspace;
  if (
    state.savedPractices.length + state.legacySavedReadings.length === 0 ||
    pdfWorkspace.analysis.ocrBusy ||
    pdfWorkspace.practice.practiceSaveBusy
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
    if (root.pdfWorkspace === pdfWorkspace) {
      pdfWorkspace.practice.savedPractice = null;
      pdfWorkspace.script.cachedOcrPages = [];
    }
    notify("保存した練習設定と読み取り結果をすべて削除しました。", "success");
  } catch {
    notify("保存した練習設定と読み取り結果を削除できませんでした。", "warning");
  }
  renderApp();
}

export async function deleteSavedPracticeFromHome(
  fingerprint: string,
): Promise<void> {
  const pdfWorkspace = root.pdfWorkspace;
  const reading = [...state.savedPractices, ...state.legacySavedReadings].find(
    (candidate) => candidate.fingerprint === fingerprint,
  );
  if (
    !reading ||
    pdfWorkspace.analysis.ocrBusy ||
    pdfWorkspace.practice.practiceSaveBusy
  )
    return;
  const name = reading.fileName || "ファイル名未登録のPDF";
  if (
    !window.confirm(
      `「${name}」の練習設定と読み取り結果を、この端末から削除しますか？PDFファイルは削除されません。`,
    )
  )
    return;
  try {
    await deleteSavedPractice(fingerprint);
    if (
      root.pdfWorkspace === pdfWorkspace &&
      pdfWorkspace.file.pdfFingerprint === fingerprint
    ) {
      pdfWorkspace.practice.savedPractice = null;
      pdfWorkspace.script.cachedOcrPages = [];
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
