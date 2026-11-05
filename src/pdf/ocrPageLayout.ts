// Convert Tesseract line geometry into PDF page coordinates.
import type { ReadingDirection } from "./sourcePage";

export const OCR_SCALE = 3;

export interface OcrLine {
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

export function collectLines(blocks: OcrTextBlock[]): OcrLine[] {
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

export function lineWordCenterBounds(
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

export function removeMarginalPageNumber(
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
  const firstWord = remainingWords[0];
  if (!firstWord) return { ...line, text: cleanedText, words: [] };

  const bbox = remainingWords.reduce(
    (combined, word) => ({
      x0: Math.min(combined.x0, word.bbox.x0),
      y0: Math.min(combined.y0, word.bbox.y0),
      x1: Math.max(combined.x1, word.bbox.x1),
      y1: Math.max(combined.y1, word.bbox.y1),
    }),
    { ...firstWord.bbox },
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
