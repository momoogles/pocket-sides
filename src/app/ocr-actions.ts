// Local image recognition workflows and their temporary OCR cache.

import {
  type CharacterMappingEvidence,
  inferDocumentCharacterCorrections,
} from "../pdf/corrections";
import {
  createLocalOcrReader,
  OcrInitializationError,
  type OcrProgress,
} from "../pdf/ocr";
import {
  mergeRecognizedPage,
  reconcileOcrSpeakerLabels,
} from "../pdf/reconciliation";
import type { SourcePage } from "../pdf/types";
import { notify, renderApp } from "../ui/render";
import {
  blocks,
  getOcrReconciliationContext,
  refreshAutomaticRoles,
} from "./script-model";
import { type AppState, state } from "./state";

const recognizedPageCache = new Map<number, SourcePage>();

export function applyTextOcrPreview(): void {
  const preview = state.textOcrPreview;
  if (!preview || state.ocrBusy) return;
  const recognized = new Map(
    preview.pages.map((page) => [page.pageNumber, page]),
  );
  const corrections = { ...preview.corrections, ...state.corrections };
  let replacedPages = 0;
  state.pages = state.pages.map((page) => {
    const result = recognized.get(page.pageNumber);
    if (!result) return page;
    const merged = mergeRecognizedPage(
      page,
      result,
      getOcrReconciliationContext(),
      undefined,
      corrections,
    );
    if (merged !== page) replacedPages += 1;
    return merged;
  });
  state.corrections = corrections;
  state.textOcrCompletion = { pageCount: preview.pages.length, replacedPages };
  state.textOcrPreview = null;
  state.ranges = {};
  state.currentTargetIndex = 0;
  refreshAutomaticRoles();
  renderApp();
}

export async function readWithOcr(
  purpose: AppState["ocrPurpose"],
): Promise<void> {
  const adjustLayout = purpose === "layout";
  if (
    state.ocrBusy ||
    (adjustLayout && state.layoutPreview) ||
    (!adjustLayout && (state.textOcrPreview || state.textOcrCompletion)) ||
    !state.document
  )
    return;
  const candidates = state.pages;
  if (candidates.length === 0) return;

  state.ocrBusy = true;
  state.ocrPurpose = purpose;
  if (!adjustLayout) state.textOcrCompletion = null;
  state.ocrCancelRequested = false;
  state.ocrProgress = 0;
  state.ocrTotal = candidates.length;
  state.ocrStatus = "画像解析の準備をしています";
  state.ocrErrors[purpose] = "";
  renderApp();

  let reader: Awaited<ReturnType<typeof createLocalOcrReader>> | null = null;
  const failedPages: number[] = [];
  let initializationFailed = false;
  const characterMappingEvidence: CharacterMappingEvidence[] = [];
  const recognizedPages = new Map<number, SourcePage>();
  const layoutResults: SourcePage[] = [];
  const reconciliationContext = getOcrReconciliationContext();

  try {
    for (const sourcePage of candidates) {
      if (state.ocrCancelRequested) break;
      state.ocrStatus = "文字を読み取っています";
      updateOcrProgress();

      try {
        let recognizedPage = recognizedPageCache.get(sourcePage.pageNumber);
        if (
          !recognizedPage ||
          recognizedPage.direction !== sourcePage.direction
        ) {
          reader ??= await createLocalOcrReader((progress: OcrProgress) => {
            state.ocrStatus = readableOcrStatus(progress.status);
            updateOcrProgress();
          });
          recognizedPage = await reader.readPage(
            state.document,
            sourcePage.pageNumber,
            sourcePage.direction,
          );
          recognizedPageCache.set(sourcePage.pageNumber, recognizedPage);
        }
        recognizedPages.set(sourcePage.pageNumber, recognizedPage);
        mergeRecognizedPage(
          sourcePage,
          recognizedPage,
          reconciliationContext,
          characterMappingEvidence,
        );
        const preview = reconcileOcrSpeakerLabels(
          sourcePage,
          mergeRecognizedPage(
            { ...sourcePage, blocks: [] },
            recognizedPage,
            reconciliationContext,
          ),
          reconciliationContext,
        );
        if (preview.blocks.some((block) => block.text.trim()))
          layoutResults.push(preview);
        else failedPages.push(sourcePage.pageNumber);
      } catch (error) {
        if (error instanceof OcrInitializationError) {
          initializationFailed = true;
          break;
        }
        failedPages.push(sourcePage.pageNumber);
      }

      state.ocrProgress += 1;
      state.ocrStatus = "文字を読み取っています";
      updateOcrProgress();
    }

    if (layoutResults.length > 0 && !state.layoutPreview) {
      state.layoutPreview = layoutResults;
      if (
        !layoutResults.some((page) => page.pageNumber === state.previewPage)
      ) {
        state.previewPage = layoutResults[0].pageNumber;
      }
    }

    if (
      recognizedPages.size > 0 &&
      !state.textOcrPreview &&
      !state.textOcrCompletion
    ) {
      state.textOcrPreview = {
        pages: [...recognizedPages.values()],
        corrections: inferDocumentCharacterCorrections(
          characterMappingEvidence,
        ),
      };
    }
    if (
      recognizedPages.size === candidates.length &&
      !initializationFailed &&
      failedPages.length === 0
    ) {
      state.ocrAnalysisComplete = true;
      state.ocrErrors = { text: "", layout: "" };
    }

    if (state.ocrCancelRequested) {
      const hasResults = adjustLayout
        ? layoutResults.length > 0
        : recognizedPages.size > 0;
      const resultMessage = "解析できたページの結果を確認できます。";
      state.ocrErrors[purpose] = hasResults
        ? `画像解析を中止しました。${resultMessage}`
        : "画像解析を中止しました。";
    } else if (initializationFailed) {
      const hasResults = adjustLayout
        ? layoutResults.length > 0
        : recognizedPages.size > 0;
      const resultMessage = "解析できたページの結果を確認できます。";
      const retryMessage = hasResults
        ? resultMessage
        : "ページを開き直して、もう一度お試しください。";
      state.ocrErrors[purpose] =
        `画像解析の準備ができなかったため、処理を停止しました。${retryMessage}`;
    } else if (failedPages.length > 0) {
      const pageList = failedPages
        .slice(0, 6)
        .map((page) => `${page}ページ目`)
        .join("、");
      const remaining =
        failedPages.length > 6 ? ` ほか ${failedPages.length - 6}ページ` : "";
      state.ocrErrors[purpose] =
        `${failedPages.length}ページを解析できませんでした（${pageList}${remaining}）。解析できなかったページには、画像解析前の読み取り結果を表示しています。`;
    }
  } catch {
    state.ocrErrors[purpose] =
      "画像解析を完了できませんでした。画像解析前の読み取り結果は残っています。";
  } finally {
    if (reader) {
      try {
        await reader.terminate();
      } catch {
        // 読み取り結果は保持したまま、後始末の失敗を画面に出さない。
      }
    }
    state.ocrBusy = false;
    state.ocrCancelRequested = false;
    state.ocrStatus = "";
    renderApp();
  }
}

function readableOcrStatus(status: string): string {
  if (status === "loading tesseract core") return "画像解析の準備をしています";
  if (status === "loading language traineddata")
    return "日本語の文字データを準備しています";
  if (status === "recognizing text") return "文字を読み取っています";
  return "画像解析の準備をしています";
}

export function updateOcrProgress(): void {
  const label = document.querySelector<HTMLElement>(
    "#image-analysis-progress-label",
  );
  const count = document.querySelector<HTMLElement>(
    "#image-analysis-progress-count",
  );
  const bar = document.querySelector<HTMLDivElement>(
    "#image-analysis-progress-bar",
  );
  if (label) label.textContent = state.ocrStatus;
  if (count)
    count.textContent = `処理済み ${state.ocrProgress} / ${state.ocrTotal}ページ`;
  if (bar) {
    const percent =
      state.ocrTotal > 0
        ? Math.round((state.ocrProgress / state.ocrTotal) * 100)
        : 0;
    bar.style.width = `${percent}%`;
    const progress = bar.closest<HTMLElement>("[role='progressbar']");
    progress?.setAttribute("aria-valuenow", String(state.ocrProgress));
  }
}

export function replaceReadingPages(pages: SourcePage[]): void {
  const restoresPdfText = pages.some((page) => page.textSource === "pdf-text");
  if (restoresPdfText) {
    state.textOcrCompletion = null;
    state.ocrErrors.text = "";
  }
  const replacements = new Map(pages.map((page) => [page.pageNumber, page]));
  const replacedBlocks = blocks().filter((block) =>
    replacements.has(block.pageNumber),
  );
  const replacedBlockIds = new Set(replacedBlocks.map((block) => block.id));
  const replacedOrigins = new Set(
    replacedBlocks.map((block) => block.boundaryOrigin?.blockId ?? block.id),
  );
  state.boundaryEdits = state.boundaryEdits.filter(
    (edit) => !replacedOrigins.has(edit.blockId),
  );

  state.manualSpeakers = Object.fromEntries(
    Object.entries(state.manualSpeakers).filter(
      ([id]) => !replacedBlockIds.has(id),
    ),
  );
  state.pages = state.pages.map(
    (page) => replacements.get(page.pageNumber) ?? page,
  );
  state.layoutPreview = null;
  state.ranges = {};
  state.currentTargetIndex = 0;
  state.ocrErrors.layout = "";
  refreshAutomaticRoles();
  renderApp();
}

export function applyCachedImageAnalysis(showNotification = true): void {
  if (state.ocrBusy || state.cachedOcrPages.length === 0) return;
  state.textOcrCompletion = null;
  const savedPages = new Map(
    state.cachedOcrPages.map((page) => [page.pageNumber, page]),
  );
  state.pages = state.pages.map((page) => {
    const saved = savedPages.get(page.pageNumber);
    return saved?.textSource === "ocr"
      ? saved
      : saved
        ? mergeRecognizedPage(page, saved, getOcrReconciliationContext())
        : page;
  });
  state.corrections = {};
  state.manualSpeakers = {};
  state.ranges = {};
  state.currentTargetIndex = 0;
  state.selectedRoleId = "";
  state.previewPage = state.cachedOcrPages[0]?.pageNumber ?? state.previewPage;
  state.ocrErrors = { text: "", layout: "" };
  state.cachedOcrPages = [];
  if (showNotification)
    notify(
      "前回の画像解析結果を適用しました。練習する役を選んでください。",
      "success",
    );
  refreshAutomaticRoles();
  renderApp();
}

export function restoreSavedCorrections(): void {
  const savedCorrections = state.savedPractice?.settings.corrections;
  if (!savedCorrections || Object.keys(savedCorrections).length === 0) return;
  state.corrections = { ...savedCorrections, ...state.corrections };
  notify("前回の文字の置換を適用しました。", "success");
  refreshAutomaticRoles();
  renderApp();
}

export function clearOcrRecognitionCache(): void {
  recognizedPageCache.clear();
}
