// Restore the saved rehearsal state for the PDF that was just opened.

import { OCR_RECOGNITION_VERSION } from "../../../pdf/ocrRecognitionVersion";
import { isOcrRecognizedPage } from "../../../pdf/ocrReconciliation";
import type { PdfWorkspaceState } from "../../../pdf/pdfWorkspace";
import type { SavedPractice } from "../../../pdf/practiceStorage";
import { getSavedPractice } from "../../../pdf/practiceStorage";
import { getSavedReading } from "../../../pdf/savedReadingStorage";
import { normalizeAlias } from "../../../pdf/speakerNames";
import { appRoot as root, appState as state } from "../../appRoot";
import { notify } from "../../notifications";
import { renderApp } from "../../renderApp";
import { currentPracticeTargets } from "../../shared/currentPracticeTargets";
import { refreshAutomaticRoles, selectedRole } from "../../shared/scriptRoles";
import { applyCachedImageAnalysis } from "../analysis/ocr";
import { refreshSavedPracticeList } from "./practiceHistory";

function applySavedPractice(saved: SavedPractice): void {
  if (
    root.pdfWorkspace.analysis.ocrBusy ||
    root.pdfWorkspace.practice.practiceSaveBusy
  )
    return;
  const outdatedRecognition = saved.pages.some(
    (page) =>
      isOcrRecognizedPage(page) &&
      page.recognitionVersion !== OCR_RECOGNITION_VERSION,
  );
  state.loading = false;
  root.pdfWorkspace.practice.savedPractice = saved;
  root.pdfWorkspace.script.pages = saved.pages.map((page) => {
    if (
      !isOcrRecognizedPage(page) ||
      page.recognitionVersion === OCR_RECOGNITION_VERSION
    ) {
      return structuredClone(page);
    }
    return structuredClone(
      root.pdfWorkspace.script.originalPages[page.pageNumber - 1] ?? page,
    );
  });
  root.pdfWorkspace.script.roles = structuredClone(saved.settings.roles);
  root.pdfWorkspace.script.excludedRoleIds = new Set(
    saved.settings.excludedRoleIds,
  );
  root.pdfWorkspace.script.selectedRoleId = saved.settings.selectedRoleId;
  root.pdfWorkspace.script.manualSpeakers = {
    ...saved.settings.manualSpeakers,
  };
  root.pdfWorkspace.script.boundaryEdits = saved.settings.boundaryEdits ?? [];

  root.pdfWorkspace.script.manualRoleNumber = saved.settings.manualRoleNumber;
  root.pdfWorkspace.script.corrections = { ...saved.settings.corrections };
  root.pdfWorkspace.practice.ranges = structuredClone(saved.settings.ranges);
  root.pdfWorkspace.practice.currentTargetIndex = 0;
  root.pdfWorkspace.analysis.previewPage = Math.min(
    Math.max(1, saved.settings.previewPage),
    root.pdfWorkspace.script.pages.length,
  );
  root.pdfWorkspace.script.cachedOcrPages = [];
  root.pdfWorkspace.practice.practiceHasStarted = false;
  refreshAutomaticRoles();

  if (
    !root.pdfWorkspace.script.roles.some(
      (role) => role.id === root.pdfWorkspace.script.selectedRoleId,
    )
  ) {
    const previousRole = saved.settings.roles.find(
      (role) => role.id === saved.settings.selectedRoleId,
    );
    if (previousRole) {
      const previousNames = new Set(
        [previousRole.label, ...previousRole.aliases].map(normalizeAlias),
      );
      const matchingRole = root.pdfWorkspace.script.roles.find((role) =>
        [role.label, ...role.aliases].some((name) =>
          previousNames.has(normalizeAlias(name)),
        ),
      );
      if (matchingRole)
        root.pdfWorkspace.script.selectedRoleId = matchingRole.id;
    }
  }

  const targetCount = currentPracticeTargets().length;
  if (targetCount === 0) {
    state.screen = "analysis";
    notify(
      outdatedRecognition
        ? "役の設定は復元しました。文字の読み取り方法が変わったため、画像解析をやり直してください。"
        : "前回の練習設定は復元しましたが、練習シーンが見つかりませんでした。読み取り結果を確認してください。",
      "warning",
    );
  } else {
    root.pdfWorkspace.practice.currentTargetIndex = Math.min(
      Math.max(0, saved.settings.currentTargetIndex),
      targetCount - 1,
    );
    state.screen = "appearances";
    root.pdfWorkspace.practice.practiceHasStarted = true;
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

export async function restorePracticeState(
  pdfWorkspace: PdfWorkspaceState,
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
    if (root.pdfWorkspace !== pdfWorkspace) return;
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
    if (
      root.pdfWorkspace !== pdfWorkspace ||
      pdfWorkspace.file.pdfFingerprint !== fingerprint
    )
      return;
    if (savedPractice && savedPractice.pageCount === pageCount) {
      pdfWorkspace.practice.savedPractice = savedPractice;
      if (requestedResumeFingerprint === fingerprint) {
        await keepRestorationVisible();
        if (root.pdfWorkspace !== pdfWorkspace) return;
        applySavedPractice(savedPractice);
        return;
      }
      const recognizedPages = savedPractice.pages.filter(isOcrRecognizedPage);
      const savedOcrPages = recognizedPages.filter(
        (page) => page.recognitionVersion === OCR_RECOGNITION_VERSION,
      );
      if (savedOcrPages.length > 0) {
        pdfWorkspace.script.cachedOcrPages = savedOcrPages;
      } else {
        const legacyReading = await getSavedReading(fingerprint);
        if (
          root.pdfWorkspace !== pdfWorkspace ||
          pdfWorkspace.file.pdfFingerprint !== fingerprint
        )
          return;
        if (legacyReading && legacyReading.pageCount === pageCount)
          pdfWorkspace.script.cachedOcrPages = legacyReading.pages;
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
      if (
        root.pdfWorkspace !== pdfWorkspace ||
        pdfWorkspace.file.pdfFingerprint !== fingerprint
      )
        return;
      if (legacyReading && legacyReading.pageCount === pageCount) {
        pdfWorkspace.script.cachedOcrPages = legacyReading.pages;
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
    if (
      root.pdfWorkspace !== pdfWorkspace ||
      pdfWorkspace.file.pdfFingerprint !== fingerprint
    )
      return;
    notify(
      "前回の練習設定を復元できませんでした。このPDFで練習を始められます。",
      "warning",
    );
  }

  await refreshSavedPracticeList();
  if (
    root.pdfWorkspace === pdfWorkspace &&
    pdfWorkspace.file.pdfFingerprint === fingerprint
  ) {
    await keepRestorationVisible();
    if (root.pdfWorkspace !== pdfWorkspace) return;
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
