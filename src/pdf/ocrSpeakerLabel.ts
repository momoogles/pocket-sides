// Infer speaker labels from OCR line spacing and quotation marks.
import { normalizeScriptText } from "./normalizeScriptText";
import type { OcrLine } from "./ocrPageLayout";

const OCR_ROLE_NAME_CHARACTER = String.raw`(?:(?![\u3400-\u4dbf])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}々ヶヵー])`;

const OCR_ROLE_MEMBER = `${OCR_ROLE_NAME_CHARACTER}{1,8}`;

const OCR_ROLE_SEPARATOR = `[、,，・&＆/／]`;

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

export function findOcrSpeakerLabel(
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
