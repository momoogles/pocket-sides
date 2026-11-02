import type { SourceBlock } from "./types";

export interface UnusualCharacter {
  character: string;
  count: number;
  exampleBlockId: string;
  examplePage: number;
  example: string;
}

export function normalizeScriptText(value: string): string {
  return value.trim()
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー0-9０-９])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー0-9０-９])/gu, "$1")
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー・]{1,8})\s+([\p{Script=Latin}\p{Number}０-９]{1,3})(?=\s*[「『（(【])/gu, "$1$2")
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー・]{1,8}[\p{Script=Latin}\p{Number}０-９]{1,3})\s+(?=[「『（(【])/gu, "$1")
    .replace(/(?<![\p{Script=Latin}])\p{Script=Latin}(?:\s+\p{Script=Latin}){1,}(?![\p{Script=Latin}])/gu, (letters) => letters.replace(/\s+/gu, ""))
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー])\s+(?=[\p{Script=Latin}\p{Number}０-９])/gu, "$1")
    .replace(/([\p{Script=Latin}\p{Number}０-９])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー])/gu, "$1")
    .replace(/\s+([」』）)】、。，．,!?！？:：…])/gu, "$1")
    .replace(/([「『（(【])\s+/gu, "$1")
    .replace(/([。．.!！?？、，…」』）)\]】：:；;])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵー0-9０-９])/gu, "$1")
    .replace(/[?？](?:\s*[?？])+/gu, "？")
    .replace(/[!！](?:\s*[!！])+/gu, "！");
}

/** Keeps readable PDF characters and uses OCR to fill text extraction failures. */
export function mergeReadableSourceText(sourceText: string, recognizedText: string): string {
  const source = Array.from(sourceText);
  const recognized = Array.from(recognizedText);
  if (source.length === 0) return recognizedText;
  if (recognized.length === 0) return sourceText;

  const width = recognized.length + 1;
  const cells = (source.length + 1) * width;
  if (cells > 1_000_000) {
    return sourceText;
  }

  const commonLength = new Uint32Array(cells);
  for (let sourceIndex = source.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    for (let recognizedIndex = recognized.length - 1; recognizedIndex >= 0; recognizedIndex -= 1) {
      const sourceCharacter = source[sourceIndex] ?? "";
      const cellIndex = sourceIndex * width + recognizedIndex;
      if (
        !isUnreadableCharacter(sourceCharacter) &&
        sourceCharacter === recognized[recognizedIndex]
      ) {
        commonLength[cellIndex] = 1 + commonLength[(sourceIndex + 1) * width + recognizedIndex + 1];
      } else {
        commonLength[cellIndex] = Math.max(
          commonLength[(sourceIndex + 1) * width + recognizedIndex],
          commonLength[sourceIndex * width + recognizedIndex + 1],
        );
      }
    }
  }

  const anchors: Array<{ sourceIndex: number; recognizedIndex: number }> = [];
  let sourceIndex = 0;
  let recognizedIndex = 0;
  while (sourceIndex < source.length && recognizedIndex < recognized.length) {
    const sourceCharacter = source[sourceIndex] ?? "";
    if (
      !isUnreadableCharacter(sourceCharacter) &&
      sourceCharacter === recognized[recognizedIndex]
    ) {
      anchors.push({ sourceIndex, recognizedIndex });
      sourceIndex += 1;
      recognizedIndex += 1;
    } else if (
      commonLength[(sourceIndex + 1) * width + recognizedIndex] >=
      commonLength[sourceIndex * width + recognizedIndex + 1]
    ) {
      sourceIndex += 1;
    } else {
      recognizedIndex += 1;
    }
  }

  let merged = "";
  let sourceStart = 0;
  let recognizedStart = 0;
  const appendGap = (sourceEnd: number, recognizedEnd: number) => {
    const sourceGap = source.slice(sourceStart, sourceEnd);
    const recognizedGap = recognized.slice(recognizedStart, recognizedEnd);
    const replacements = new Map<number, number>();
    const usedRecognizedIndexes = new Set<number>();

    sourceGap.forEach((character, sourceOffset) => {
      if (!isUnreadableCharacter(character) || recognizedGap.length === 0) return;

      const idealIndex = Math.max(
        0,
        Math.min(
          recognizedGap.length - 1,
          Math.round(((sourceOffset + 0.5) * recognizedGap.length) / sourceGap.length - 0.5),
        ),
      );
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      recognizedGap.forEach((_, recognizedOffset) => {
        if (usedRecognizedIndexes.has(recognizedOffset)) return;
        const distance = Math.abs(recognizedOffset - idealIndex);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = recognizedOffset;
        }
      });
      if (bestIndex >= 0) {
        replacements.set(sourceOffset, bestIndex);
        usedRecognizedIndexes.add(bestIndex);
      }
    });

    sourceGap.forEach((character, sourceOffset) => {
      if (!isUnreadableCharacter(character)) {
        merged += character;
        return;
      }

      const replacementIndex = replacements.get(sourceOffset);
      if (replacementIndex !== undefined) {
        merged += recognizedGap[replacementIndex] ?? "";
      } else if (recognizedGap.length === 0) {
        merged += character;
      }
    });

    sourceStart = sourceEnd;
    recognizedStart = recognizedEnd;
  };

  for (const anchor of anchors) {
    appendGap(anchor.sourceIndex, anchor.recognizedIndex);
    merged += source[anchor.sourceIndex] ?? "";
    sourceStart = anchor.sourceIndex + 1;
    recognizedStart = anchor.recognizedIndex + 1;
  }
  appendGap(source.length, recognized.length);
  return merged;
}

export function applyCharacterCorrections(
  blocks: SourceBlock[],
  corrections: Record<string, string>,
): SourceBlock[] {
  const replaceCharacters = (value: string) =>
    Array.from(value).map((character) => corrections[character] ?? character).join("");

  return blocks.map((block) => {
    const replacedRawText = replaceCharacters(block.rawText);
    const correctedRawText = normalizeScriptText(replacedRawText);
    const speakerLabel = block.speakerLabel
      ? normalizeScriptText(replaceCharacters(block.speakerLabel))
      : undefined;
    const text = speakerLabel && correctedRawText.startsWith(speakerLabel)
      ? correctedRawText.slice(speakerLabel.length).trimStart()
      : correctedRawText;

    return {
      ...block,
      ...(speakerLabel ? { speakerLabel } : {}),
      text,
    };
  });
}

export function findUnusualCharacters(
  blocks: SourceBlock[],
  corrections: Record<string, string>,
): UnusualCharacter[] {
  const found = new Map<string, UnusualCharacter>();

  for (const block of blocks) {
    const reviewText = block.rawText;
    for (const character of Array.from(reviewText)) {
      if (!isUnusualCharacter(character) || corrections[character]?.trim()) continue;
      const entry = found.get(character);
      if (entry) {
        entry.count += 1;
        continue;
      }
      found.set(character, {
        character,
        count: 1,
        exampleBlockId: block.id,
        examplePage: block.pageNumber,
        example: contextAround(reviewText, character),
      });
    }
  }

  return [...found.values()].sort(
    (a, b) => b.count - a.count || a.character.localeCompare(b.character, "ja"),
  );
}

function isUnusualCharacter(character: string): boolean {
  return isUnreadableCharacter(character);
}

function isUnreadableCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    codePoint === 0xfffd ||
    codePoint === 0x25a1 ||
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

function contextAround(value: string, target: string): string {
  const position = value.indexOf(target);
  const start = Math.max(0, position - 12);
  const end = Math.min(value.length, position + target.length + 18);
  return value.slice(start, end);
}
