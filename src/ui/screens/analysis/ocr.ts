// Local image recognition workflows and their temporary OCR cache.

import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  type CharacterMappingEvidence,
  inferDocumentCharacterCorrections,
} from "../../../pdf/characterCorrections";
import {
  createLocalOcrReader,
  OcrInitializationError,
  type OcrProgress,
} from "../../../pdf/localOcrReader";
import {
  mergeRecognizedPage,
  reconcileOcrSpeakerLabels,
} from "../../../pdf/ocrReconciliation";
import type { PdfWorkspaceState } from "../../../pdf/pdfWorkspace";
import type { SourcePage } from "../../../pdf/sourcePage";
import { appRoot as root } from "../../appRoot";
import { notify } from "../../notifications";
import { renderApp, scrollToAnalysisPanel } from "../../renderApp";
import {
  blocks,
  getOcrReconciliationContext,
  knownOcrSpeakerAliasKeys,
} from "../../shared/correctedScriptBlocks";
import { refreshAutomaticRoles } from "../../shared/scriptRoles";

const recognizedPagesByDocument = new WeakMap<
  PDFDocumentProxy,
  Map<number, SourcePage>
>();

function recognizedPageCacheFor(
  document: PDFDocumentProxy,
): Map<number, SourcePage> {
  const current = recognizedPagesByDocument.get(document);
  if (current) return current;

  const cache = new Map<number, SourcePage>();
  recognizedPagesByDocument.set(document, cache);
  return cache;
}

export function applyTextOcrPreview(): void {
  const preview = root.pdfWorkspace.analysis.textOcrPreview;
  if (!preview || root.pdfWorkspace.analysis.ocrBusy) return;
  const recognized = new Map(
    preview.pages.map((page) => [page.pageNumber, page]),
  );
  const corrections = {
    ...preview.corrections,
    ...root.pdfWorkspace.script.corrections,
  };
  let replacedPages = 0;
  root.pdfWorkspace.script.pages = root.pdfWorkspace.script.pages.map(
    (page) => {
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
    },
  );
  root.pdfWorkspace.script.corrections = corrections;
  root.pdfWorkspace.analysis.textOcrCompletion = {
    pageCount: preview.pages.length,
    replacedPages,
  };
  root.pdfWorkspace.analysis.textOcrPreview = null;
  root.pdfWorkspace.practice.ranges = {};
  root.pdfWorkspace.practice.currentTargetIndex = 0;
  refreshAutomaticRoles();
  renderApp();
  scrollToAnalysisPanel("glyph-panel");
}

export async function readWithOcr(
  purpose: PdfWorkspaceState["analysis"]["ocrPurpose"],
): Promise<void> {
  const adjustLayout = purpose === "layout";
  if (
    root.pdfWorkspace.analysis.ocrBusy ||
    (adjustLayout && root.pdfWorkspace.analysis.layoutPreview) ||
    (!adjustLayout &&
      (root.pdfWorkspace.analysis.textOcrPreview ||
        root.pdfWorkspace.analysis.textOcrCompletion)) ||
    !root.pdfWorkspace.file.document
  )
    return;
  const document = root.pdfWorkspace.file.document;
  if (!document) return;
  const candidates = root.pdfWorkspace.script.pages;
  if (candidates.length === 0) return;

  root.pdfWorkspace.analysis.ocrBusy = true;
  root.pdfWorkspace.analysis.ocrPurpose = purpose;
  if (!adjustLayout) root.pdfWorkspace.analysis.textOcrCompletion = null;
  root.pdfWorkspace.analysis.ocrCancelRequested = false;
  root.pdfWorkspace.analysis.ocrProgress = 0;
  root.pdfWorkspace.analysis.ocrTotal = candidates.length;
  root.pdfWorkspace.analysis.ocrStatus = "画像解析の準備をしています";
  root.pdfWorkspace.analysis.ocrErrors[purpose] = "";
  if (adjustLayout) root.pdfWorkspace.analysis.layoutOcrCompletion = null;
  renderApp();

  let reader: Awaited<ReturnType<typeof createLocalOcrReader>> | null = null;
  const failedPages: number[] = [];
  let initializationFailed = false;
  const characterMappingEvidence: CharacterMappingEvidence[] = [];
  const recognizedPages = new Map<number, SourcePage>();
  const recognizedPageCache = recognizedPageCacheFor(document);
  const layoutResults: SourcePage[] = [];
  const reconciliationContext = getOcrReconciliationContext();
  const knownSpeakerAliasKeys = knownOcrSpeakerAliasKeys();

  try {
    for (const sourcePage of candidates) {
      if (root.pdfWorkspace.analysis.ocrCancelRequested) break;
      root.pdfWorkspace.analysis.ocrStatus = "文字を読み取っています";
      updateOcrProgress();

      try {
        let recognizedPage = recognizedPageCache.get(sourcePage.pageNumber);
        if (
          !recognizedPage ||
          recognizedPage.direction !== sourcePage.direction
        ) {
          reader ??= await createLocalOcrReader((progress: OcrProgress) => {
            root.pdfWorkspace.analysis.ocrStatus = readableOcrStatus(
              progress.status,
            );
            updateOcrProgress();
          });
          recognizedPage = await reader.readPage(
            document,
            sourcePage.pageNumber,
            sourcePage.direction,
            knownSpeakerAliasKeys,
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

      root.pdfWorkspace.analysis.ocrProgress += 1;
      root.pdfWorkspace.analysis.ocrStatus = "文字を読み取っています";
      updateOcrProgress();
    }

    if (layoutResults.length > 0 && !root.pdfWorkspace.analysis.layoutPreview) {
      root.pdfWorkspace.analysis.layoutPreview = layoutResults;
      if (
        !layoutResults.some(
          (page) => page.pageNumber === root.pdfWorkspace.analysis.previewPage,
        )
      ) {
        root.pdfWorkspace.analysis.previewPage = layoutResults[0].pageNumber;
      }
    }

    if (
      recognizedPages.size > 0 &&
      !root.pdfWorkspace.analysis.textOcrPreview &&
      !root.pdfWorkspace.analysis.textOcrCompletion
    ) {
      root.pdfWorkspace.analysis.textOcrPreview = {
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
      root.pdfWorkspace.analysis.ocrAnalysisComplete = true;
      root.pdfWorkspace.analysis.ocrErrors = { text: "", layout: "" };
    }

    if (root.pdfWorkspace.analysis.ocrCancelRequested) {
      const hasResults = adjustLayout
        ? layoutResults.length > 0
        : recognizedPages.size > 0;
      const resultMessage = "解析できたページの結果を確認できます。";
      root.pdfWorkspace.analysis.ocrErrors[purpose] = hasResults
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
      root.pdfWorkspace.analysis.ocrErrors[purpose] =
        `画像解析の準備ができなかったため、処理を停止しました。${retryMessage}`;
    } else if (failedPages.length > 0) {
      const pageList = failedPages
        .slice(0, 6)
        .map((page) => `${page}ページ目`)
        .join("、");
      const remaining =
        failedPages.length > 6 ? ` ほか ${failedPages.length - 6}ページ` : "";
      root.pdfWorkspace.analysis.ocrErrors[purpose] =
        `${failedPages.length}ページを解析できませんでした（${pageList}${remaining}）。解析できなかったページには、画像解析前の読み取り結果を表示しています。`;
    }
  } catch {
    root.pdfWorkspace.analysis.ocrErrors[purpose] =
      "画像解析を完了できませんでした。画像解析前の読み取り結果は残っています。";
  } finally {
    if (reader) {
      try {
        await reader.terminate();
      } catch {
        // 読み取り結果は保持したまま、後始末の失敗を画面に出さない。
      }
    }
    root.pdfWorkspace.analysis.ocrBusy = false;
    root.pdfWorkspace.analysis.ocrCancelRequested = false;
    root.pdfWorkspace.analysis.ocrStatus = "";
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
  const labels = document.querySelectorAll<HTMLElement>(
    ".image-analysis-progress-label",
  );
  const counts = document.querySelectorAll<HTMLElement>(
    ".image-analysis-progress-count",
  );
  const bars = document.querySelectorAll<HTMLDivElement>(
    ".image-analysis-progress-bar",
  );
  labels.forEach((label) => {
    label.textContent = root.pdfWorkspace.analysis.ocrStatus;
  });
  counts.forEach((count) => {
    count.textContent = `処理済み ${root.pdfWorkspace.analysis.ocrProgress} / ${root.pdfWorkspace.analysis.ocrTotal}ページ`;
  });
  const percent =
    root.pdfWorkspace.analysis.ocrTotal > 0
      ? Math.round(
          (root.pdfWorkspace.analysis.ocrProgress /
            root.pdfWorkspace.analysis.ocrTotal) *
            100,
        )
      : 0;
  bars.forEach((bar) => {
    bar.style.width = `${percent}%`;
    const progress = bar.closest<HTMLElement>("[role='progressbar']");
    progress?.setAttribute(
      "aria-valuenow",
      String(root.pdfWorkspace.analysis.ocrProgress),
    );
  });
}

export function replaceReadingPages(
  pages: SourcePage[],
  layoutOcrApplied = false,
): void {
  const restoresPdfText = pages.some((page) => page.textSource === "pdf-text");
  if (restoresPdfText) {
    root.pdfWorkspace.analysis.textOcrCompletion = null;
    root.pdfWorkspace.analysis.layoutOcrCompletion = null;
    root.pdfWorkspace.analysis.ocrErrors.text = "";
  }
  if (layoutOcrApplied)
    root.pdfWorkspace.analysis.layoutOcrCompletion = {
      pageCount: pages.length,
    };
  const originalPages = new Map(
    root.pdfWorkspace.script.originalPages.map((page) => [
      page.pageNumber,
      page,
    ]),
  );
  const corrections = {
    ...root.pdfWorkspace.analysis.textOcrPreview?.corrections,
    ...root.pdfWorkspace.script.corrections,
  };
  const reconciliationContext = getOcrReconciliationContext();
  const replacements = new Map(
    pages.map((page) => {
      const originalPage = originalPages.get(page.pageNumber);
      const replacement =
        originalPage &&
        (page.textSource === "ocr" || page.textSource === "mixed")
          ? mergeRecognizedPage(
              originalPage,
              page,
              reconciliationContext,
              undefined,
              corrections,
              true,
            )
          : page;
      return [page.pageNumber, replacement];
    }),
  );
  const replacedBlocks = blocks().filter((block) =>
    replacements.has(block.pageNumber),
  );
  const replacedBlockIds = new Set(replacedBlocks.map((block) => block.id));
  const replacedOrigins = new Set(
    replacedBlocks.map((block) => block.boundaryOrigin?.blockId ?? block.id),
  );
  root.pdfWorkspace.script.boundaryEdits =
    root.pdfWorkspace.script.boundaryEdits.filter(
      (edit) => !replacedOrigins.has(edit.blockId),
    );

  root.pdfWorkspace.script.manualSpeakers = Object.fromEntries(
    Object.entries(root.pdfWorkspace.script.manualSpeakers).filter(
      ([id]) => !replacedBlockIds.has(id),
    ),
  );
  root.pdfWorkspace.script.pages = root.pdfWorkspace.script.pages.map(
    (page) => replacements.get(page.pageNumber) ?? page,
  );
  root.pdfWorkspace.analysis.layoutPreview = null;
  root.pdfWorkspace.practice.ranges = {};
  root.pdfWorkspace.practice.currentTargetIndex = 0;
  root.pdfWorkspace.analysis.ocrErrors.layout = "";
  refreshAutomaticRoles();
  renderApp();
}

export function applyCachedImageAnalysis(showNotification = true): void {
  if (
    root.pdfWorkspace.analysis.ocrBusy ||
    root.pdfWorkspace.script.cachedOcrPages.length === 0
  )
    return;
  root.pdfWorkspace.analysis.textOcrCompletion = null;
  const savedPages = new Map(
    root.pdfWorkspace.script.cachedOcrPages.map((page) => [
      page.pageNumber,
      page,
    ]),
  );
  root.pdfWorkspace.script.pages = root.pdfWorkspace.script.pages.map(
    (page) => {
      const saved = savedPages.get(page.pageNumber);
      return saved?.textSource === "ocr"
        ? saved
        : saved
          ? mergeRecognizedPage(page, saved, getOcrReconciliationContext())
          : page;
    },
  );
  root.pdfWorkspace.script.corrections = {};
  root.pdfWorkspace.script.manualSpeakers = {};
  root.pdfWorkspace.practice.ranges = {};
  root.pdfWorkspace.practice.currentTargetIndex = 0;
  root.pdfWorkspace.script.selectedRoleId = "";
  root.pdfWorkspace.analysis.previewPage =
    root.pdfWorkspace.script.cachedOcrPages[0]?.pageNumber ??
    root.pdfWorkspace.analysis.previewPage;
  root.pdfWorkspace.analysis.ocrErrors = { text: "", layout: "" };
  root.pdfWorkspace.script.cachedOcrPages = [];
  if (showNotification)
    notify(
      "前回の画像解析結果を適用しました。練習する役を選んでください。",
      "success",
    );
  refreshAutomaticRoles();
  renderApp();
  scrollToAnalysisPanel("glyph-panel");
}

export function restoreSavedCorrections(): void {
  const savedCorrections =
    root.pdfWorkspace.practice.savedPractice?.settings.corrections;
  if (!savedCorrections || Object.keys(savedCorrections).length === 0) return;
  root.pdfWorkspace.script.corrections = {
    ...savedCorrections,
    ...root.pdfWorkspace.script.corrections,
  };
  notify("前回の文字の置換を適用しました。", "success");
  refreshAutomaticRoles();
  renderApp();
}

export function clearOcrRecognitionCache(): void {
  if (root.pdfWorkspace.file.document)
    recognizedPagesByDocument.delete(root.pdfWorkspace.file.document);
}
