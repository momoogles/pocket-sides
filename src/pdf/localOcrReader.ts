// Create the local Tesseract worker and recognize PDF pages.
import type { PDFDocumentProxy } from "pdfjs-dist";
import { isMarginalPageNumber } from "./isMarginalPageNumber";
import { normalizeScriptPunctuation } from "./normalizeScriptText";
import {
  collectLines,
  lineWordCenterBounds,
  OCR_SCALE,
  removeMarginalPageNumber,
} from "./ocrPageLayout";
import { OCR_RECOGNITION_VERSION } from "./ocrRecognitionVersion";
import { findOcrSpeakerLabel } from "./ocrSpeakerLabel";
import type { ReadingDirection, SourceBlock, SourcePage } from "./sourcePage";

const MINIMUM_OCR_CONFIDENCE = 45;

export interface OcrProgress {
  status: string;
  progress: number;
}

export interface LocalOcrReader {
  readPage: (
    document: PDFDocumentProxy,
    pageNumber: number,
    direction: ReadingDirection,
    knownSpeakerAliasKeys?: ReadonlySet<string>,
  ) => Promise<SourcePage>;
  terminate: () => Promise<void>;
}

export class OcrInitializationError extends Error {
  constructor(cause: unknown) {
    super("画像解析の準備ができませんでした。", { cause });
    this.name = "OcrInitializationError";
  }
}

export async function createLocalOcrReader(
  onProgress: (progress: OcrProgress) => void,
): Promise<LocalOcrReader> {
  const { createWorker } = await import("tesseract.js").catch(
    (cause: unknown) => {
      throw new OcrInitializationError(cause);
    },
  );
  const assetBase = `${import.meta.env.BASE_URL}ocr/`;
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  let workerDirection: ReadingDirection | null = null;

  async function ensureWorker(direction: ReadingDirection) {
    if (worker && workerDirection === direction) return worker;
    if (worker) await worker.terminate();
    worker = null;

    worker = await new Promise<Awaited<ReturnType<typeof createWorker>>>(
      (resolve, reject) => {
        void createWorker(direction === "vertical" ? "jpn_vert" : "jpn", 1, {
          workerPath: `${assetBase}worker.min.js`,
          corePath: `${assetBase}core/`,
          langPath: `${assetBase}languages/`,
          workerBlobURL: false,
          cacheMethod: "none",
          gzip: true,
          logger: ({ status, progress }) => onProgress({ status, progress }),
          errorHandler: reject,
        }).then(resolve, reject);
      },
    ).catch((cause: unknown) => {
      throw new OcrInitializationError(cause);
    });
    workerDirection = direction;
    return worker;
  }

  return {
    async readPage(
      documentProxy,
      pageNumber,
      direction,
      knownSpeakerAliasKeys,
    ) {
      const page = await documentProxy.getPage(pageNumber);
      const pageViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: OCR_SCALE });
      const source = document.createElement("canvas");
      source.width = Math.ceil(viewport.width);
      source.height = Math.ceil(viewport.height);
      const sourceContext = source.getContext("2d", { alpha: false });
      if (!sourceContext) throw new Error("画像を準備できませんでした。");

      try {
        const renderTask = page.render({
          canvas: source,
          canvasContext: sourceContext,
          viewport,
          background: "#ffffff",
        });
        await renderTask.promise;

        const ocrCanvas =
          direction === "vertical" ? rotateCounterClockwise(source) : source;
        try {
          const activeWorker = await ensureWorker(direction);
          const result = await activeWorker.recognize(
            ocrCanvas,
            {},
            { blocks: true },
          );
          const confidence = result.data.confidence;
          const lines = collectLines(result.data.blocks ?? [])
            .map((line) =>
              removeMarginalPageNumber(
                line,
                pageNumber,
                direction,
                source.width,
                pageViewport.width,
                pageViewport.height,
              ),
            )
            .filter((line) => line.text.trim().length > 0);
          const recognizedCharacters = lines.reduce(
            (sum, line) => sum + Array.from(line.text.trim()).length,
            0,
          );

          if (lines.length === 0 || recognizedCharacters < 10) {
            throw new Error("このページから文字を読み取れませんでした。");
          }
          if (confidence < MINIMUM_OCR_CONFIDENCE) {
            throw new Error(
              `このページのOCR結果を確認できませんでした（認識度 ${Math.round(confidence)}%）。`,
            );
          }

          const orderedLines = [...lines].sort(
            (a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0,
          );
          const pageWidthPixels = source.width;
          const blocks: SourceBlock[] = orderedLines.flatMap((line, index) => {
            const rotatedCenterX = (line.bbox.x0 + line.bbox.x1) / 2;
            const rotatedCenterY = (line.bbox.y0 + line.bbox.y1) / 2;
            const x =
              direction === "vertical"
                ? (pageWidthPixels - rotatedCenterY) / OCR_SCALE
                : rotatedCenterX / OCR_SCALE;
            const y =
              direction === "vertical"
                ? pageViewport.height - rotatedCenterX / OCR_SCALE
                : pageViewport.height - rotatedCenterY / OCR_SCALE;
            const recognitionBounds =
              direction === "vertical"
                ? {
                    xMin: (pageWidthPixels - line.bbox.y1) / OCR_SCALE,
                    yMin: pageViewport.height - line.bbox.x1 / OCR_SCALE,
                    xMax: (pageWidthPixels - line.bbox.y0) / OCR_SCALE,
                    yMax: pageViewport.height - line.bbox.x0 / OCR_SCALE,
                  }
                : {
                    xMin: line.bbox.x0 / OCR_SCALE,
                    yMin: pageViewport.height - line.bbox.y1 / OCR_SCALE,
                    xMax: line.bbox.x1 / OCR_SCALE,
                    yMax: pageViewport.height - line.bbox.y0 / OCR_SCALE,
                  };
            const wordCenterBounds = lineWordCenterBounds(
              line,
              direction,
              pageWidthPixels,
              pageViewport.height,
            );
            if (wordCenterBounds && direction === "vertical") {
              recognitionBounds.xMin = wordCenterBounds.min;
              recognitionBounds.xMax = wordCenterBounds.max;
            } else if (wordCenterBounds) {
              recognitionBounds.yMin = wordCenterBounds.min;
              recognitionBounds.yMax = wordCenterBounds.max;
            }
            if (
              isMarginalPageNumber(
                line.text,
                x,
                y,
                pageViewport.width,
                pageViewport.height,
                pageNumber,
              )
            ) {
              return [];
            }
            const speaker =
              direction === "vertical"
                ? findOcrSpeakerLabel(line, knownSpeakerAliasKeys)
                : undefined;
            const speakerLabel = speaker?.label;
            const normalizedText = normalizeScriptPunctuation(
              line.text,
              speakerLabel,
            );
            const text =
              speakerLabel && normalizedText.startsWith(speakerLabel)
                ? normalizedText.slice(speakerLabel.length).trimStart()
                : normalizedText;

            return [
              {
                id: `p${pageNumber}-ocr-b${index + 1}`,
                pageNumber,
                orderOnPage: index + 1,
                direction,
                rawText: normalizedText.trim(),
                text,
                x,
                y,
                fontSize: (line.bbox.y1 - line.bbox.y0) / OCR_SCALE,
                itemIds: [],
                recognitionConfidence: line.confidence,
                recognitionBounds,
                ...(speakerLabel
                  ? { speakerLabel, speakerEvidence: speaker?.evidence }
                  : {}),
              },
            ];
          });

          blocks.forEach((block, index) => {
            const next = blocks[index + 1];
            if (!next) return;
            block.visualGapAfter =
              direction === "vertical"
                ? Math.abs(block.x - next.x)
                : Math.abs(block.y - next.y);
          });

          return {
            pageNumber,
            width: pageViewport.width,
            height: pageViewport.height,
            rotation: page.rotate,
            direction,
            textSource: "ocr",
            recognitionVersion: OCR_RECOGNITION_VERSION,
            recognitionConfidence: confidence,
            items: [],
            blocks,
          };
        } finally {
          if (ocrCanvas !== source) {
            ocrCanvas.width = 0;
            ocrCanvas.height = 0;
          }
        }
      } finally {
        source.width = 0;
        source.height = 0;
      }
    },
    async terminate() {
      if (worker) await worker.terminate();
      worker = null;
      workerDirection = null;
    },
  };
}

function rotateCounterClockwise(source: HTMLCanvasElement): HTMLCanvasElement {
  const rotated = document.createElement("canvas");
  rotated.width = source.height;
  rotated.height = source.width;
  const context = rotated.getContext("2d", { alpha: false });
  if (!context) throw new Error("画像を回転できませんでした。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, rotated.width, rotated.height);
  context.translate(0, rotated.height);
  context.rotate(-Math.PI / 2);
  context.drawImage(source, 0, 0);
  return rotated;
}
