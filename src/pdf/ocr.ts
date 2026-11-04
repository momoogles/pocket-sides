import type { PDFDocumentProxy } from "pdfjs-dist";
import { normalizeScriptPunctuation, normalizeScriptText } from "./corrections";
import { isMarginalPageNumber } from "./layout";
import {
  OCR_RECOGNITION_VERSION,
  type ReadingDirection,
  type SourceBlock,
  type SourcePage,
} from "./types";

const OCR_SCALE = 3;
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
    async readPage(documentProxy, pageNumber, direction) {
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
              direction === "vertical" ? findOcrSpeakerLabel(line) : undefined;
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

interface OcrLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  words?: OcrWord[];
}

interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface OcrTextBlock {
  paragraphs: Array<{ lines: OcrLine[] }>;
}

function collectLines(blocks: OcrTextBlock[]): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        if (!line.text.trim()) continue;
        lines.push({
          text: line.text,
          confidence: line.confidence,
          bbox: line.bbox,
          words: line.words,
        });
      }
    }
  }
  return lines;
}

function lineWordCenterBounds(
  line: OcrLine,
  direction: ReadingDirection,
  pageWidthPixels: number,
  pageHeight: number,
): { min: number; max: number } | undefined {
  const words = (line.words ?? []).filter(
    (word) => word.text.trim().length > 0,
  );
  if (words.length === 0) return undefined;

  const centers = words.map((word) => {
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    return direction === "vertical"
      ? (pageWidthPixels - centerY) / OCR_SCALE
      : pageHeight - centerY / OCR_SCALE;
  });
  return {
    min: Math.min(...centers),
    max: Math.max(...centers),
  };
}

function removeMarginalPageNumber(
  line: OcrLine,
  pageNumber: number,
  direction: ReadingDirection,
  pageWidthPixels: number,
  pageWidth: number,
  pageHeight: number,
): OcrLine {
  const words = line.words ?? [];
  if (words.length === 0) return line;

  const boundaryWords = [words[0], words.at(-1)].filter(
    (word, index, candidates): word is OcrWord =>
      Boolean(word) && candidates.indexOf(word) === index,
  );
  const pageNumberWord = boundaryWords.find((word) => {
    const normalized = word.text.normalize("NFKC").replace(/[\s\u3000]/gu, "");
    if (!isPageNumberToken(normalized, pageNumber)) return false;

    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    const x =
      direction === "vertical"
        ? (pageWidthPixels - centerY) / OCR_SCALE
        : centerX / OCR_SCALE;
    const y =
      direction === "vertical"
        ? pageHeight - centerX / OCR_SCALE
        : pageHeight - centerY / OCR_SCALE;
    return isNearPageEdge(x, y, pageWidth, pageHeight);
  });
  if (!pageNumberWord) return line;

  const numberPattern = /[0-9０-９]{1,4}\s*$/u;
  const suffix = numberPattern.exec(line.text);
  const prefixPattern = /^\s*[0-9０-９]{1,4}/u;
  const prefix = prefixPattern.exec(line.text);
  const isLastWord = words.at(-1) === pageNumberWord;
  const match = isLastWord ? suffix : prefix;
  if (
    !match ||
    !isPageNumberToken(match[0].normalize("NFKC").trim(), pageNumber)
  )
    return line;

  const cleanedText = (
    isLastWord
      ? line.text.slice(0, match.index)
      : line.text.slice(match[0].length)
  ).trim();
  const remainingWords = isLastWord ? words.slice(0, -1) : words.slice(1);
  if (remainingWords.length === 0)
    return { ...line, text: cleanedText, words: [] };

  const bbox = remainingWords.reduce(
    (combined, word) => ({
      x0: Math.min(combined.x0, word.bbox.x0),
      y0: Math.min(combined.y0, word.bbox.y0),
      x1: Math.max(combined.x1, word.bbox.x1),
      y1: Math.max(combined.y1, word.bbox.y1),
    }),
    { ...remainingWords[0]!.bbox },
  );
  return { ...line, text: cleanedText, words: remainingWords, bbox };
}

function isPageNumberToken(value: string, pageNumber: number): boolean {
  if (!/^\d{1,4}$/u.test(value)) return false;
  if (Number(value) === pageNumber) return true;

  const expected = String(pageNumber);
  return (
    value.length < expected.length &&
    (expected.startsWith(value) || expected.endsWith(value))
  );
}

function isNearPageEdge(
  x: number,
  y: number,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const horizontalMargin = pageWidth * 0.15;
  const verticalMargin = pageHeight * 0.15;
  return (
    x <= horizontalMargin ||
    x >= pageWidth - horizontalMargin ||
    y <= verticalMargin ||
    y >= pageHeight - verticalMargin
  );
}

const OCR_ROLE_NAME_CHARACTER = String.raw`(?:(?![\u3400-\u4dbf])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}々ヶヵー])`;
const OCR_ROLE_MEMBER = String.raw`${OCR_ROLE_NAME_CHARACTER}{1,8}`;
const OCR_ROLE_SEPARATOR = String.raw`[、,，・&＆/／]`;
const OCR_ROLE_LABEL = new RegExp(
  `^${OCR_ROLE_MEMBER}(?:${OCR_ROLE_SEPARATOR}${OCR_ROLE_MEMBER})*$`,
  "u",
);
const OCR_ROLE_LABEL_CHARACTER = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}々ヶヵー・、,，&＆/／]`;
const OCR_OPENING_MARKERS = new Set([
  "「",
  "『",
  "“",
  '"',
  ":",
  "：",
  "|",
  "｜",
  "│",
  "┃",
  "︱",
  "︳",
  "∣",
  "丨",
  "-",
  "－",
  "―",
  "—",
  "–",
  "‐",
  "‑",
  "−",
  "─",
  "━",
]);

function findOcrSpeakerLabel(
  line: OcrLine,
): { label: string; evidence: "layout" | "quotation" } | undefined {
  const normalizedText = normalizeScriptText(line.text);
  const words = line.words ?? [];
  if (words.length < 2) return findQuotedOcrSpeakerLabel(normalizedText);
  const heights = words.map((word) => word.bbox.y1 - word.bbox.y0);
  const typicalHeight = median(heights);
  const gapThreshold = Math.max(10, typicalHeight * 1.8);
  let label = "";

  for (let index = 0; index < words.length - 1; index += 1) {
    label += words[index].text;
    const normalizedLabel = normalizeScriptText(label);
    if (!OCR_ROLE_LABEL.test(normalizedLabel))
      return findQuotedOcrSpeakerLabel(normalizedText);
    const current = words[index].bbox;
    const next = words[index + 1].bbox;
    const gap = Math.max(next.x0 - current.x1, current.x0 - next.x1, 0);
    if (gap >= gapThreshold) {
      const latinSuffix = normalizeScriptText(words[index + 1].text);
      const combined = normalizeScriptText(label + words[index + 1].text);
      const hasJapanese =
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
          normalizedLabel,
        );
      if (
        hasJapanese &&
        /^[\p{Script=Latin}\p{Number}０-９]{1,3}$/u.test(latinSuffix) &&
        OCR_ROLE_LABEL.test(combined)
      ) {
        return { label: combined, evidence: "layout" };
      }
      return { label: normalizedLabel, evidence: "layout" };
    }
  }
  return findQuotedOcrSpeakerLabel(normalizedText);
}

function findQuotedOcrSpeakerLabel(
  normalizedText: string,
): { label: string; evidence: "quotation" } | undefined {
  for (let index = 1; index < normalizedText.length; ) {
    const character = String.fromCodePoint(
      normalizedText.codePointAt(index) ?? 0,
    );
    if (OCR_OPENING_MARKERS.has(character)) {
      const label = normalizedText.slice(0, index).trim();
      if (OCR_ROLE_LABEL.test(label)) return { label, evidence: "quotation" };
    }
    index += character.length;
  }
  const quotedLabel = new RegExp(
    `^(${OCR_ROLE_LABEL_CHARACTER}{1,24})(?=[「『“"])`,
    "u",
  ).exec(normalizedText);
  if (quotedLabel?.[1] && OCR_ROLE_LABEL.test(quotedLabel[1]))
    return { label: quotedLabel[1], evidence: "quotation" };

  return undefined;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
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
