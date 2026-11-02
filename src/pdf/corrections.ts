import type { SourceBlock } from "./types";

export interface UnusualCharacter {
  character: string;
  count: number;
  exampleBlockId: string;
  examplePage: number;
  example: string;
}

export interface CharacterMappingEvidence {
  sourceCharacter: string;
  recognizedCharacter: string;
  pageNumber: number;
  blockId: string;
}

const SMALL_YOON_FOR_FULL: Record<string, string> = {
  や: "ゃ", ゆ: "ゅ", よ: "ょ",
  ヤ: "ャ", ユ: "ュ", ヨ: "ョ",
};

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
    .replace(/[!！](?:\s*[!！])+/gu, "！")
    .replace(/([きぎしじちぢにひびぴみりキギシジチヂニヒビピミリ])ー([ゃゅょャュョ])/gu, "$1$2ー")
    .replace(/\(([^()\n]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][^()\n]*)\)/gu, "（$1）")
    .replace(/[.．]\s*(?=[…⋯])/gu, "")
    .replace(/([きしちにひみりぎじぢびぴキシチニヒミリギジヂビピ])([ゃゅょャュョ])([ー〜])\1([やゆよヤユヨ])\3/gu, (match, firstBase: string, firstSmall: string, mark: string, secondFull: string) => {
      return SMALL_YOON_FOR_FULL[secondFull] === firstSmall
        ? `${firstBase}${firstSmall}${mark}${firstBase}${firstSmall}${mark}`
        : match;
    })
    .replace(/([きしちにひみりぎじぢびぴキシチニヒミリギジヂビピ])([やゆよヤユヨ])([ー〜])\1([ゃゅょャュョ])\3/gu, (match, firstBase: string, firstFull: string, mark: string, secondSmall: string) => {
      return SMALL_YOON_FOR_FULL[firstFull] === secondSmall
        ? `${firstBase}${secondSmall}${mark}${firstBase}${secondSmall}${mark}`
        : match;
    });
}

export function normalizeScriptPunctuation(value: string, speakerLabel?: string): string {
  let normalized = normalizeScriptText(value);
  const label = speakerLabel ? normalizeScriptText(speakerLabel) : "";

  let markerIndex = label && normalized.startsWith(label) ? label.length : 0;
  while (/\s/u.test(normalized[markerIndex] ?? "")) markerIndex += 1;
  const marker = Array.from(normalized.slice(markerIndex))[0] ?? "";
  if (label && isAmbiguousSpeakerQuoteMarker(marker)) {
    normalized = `${normalized.slice(0, markerIndex)}「${normalized.slice(markerIndex + marker.length)}`;
  }

  const japaneseCharacter = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵ]`;
  const verticalStrokes = String.raw`[|｜│┃︱︳∣丨]`;
  return normalized
    .replace(/[~～]/gu, "〜")
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵ])\s+(?=〜)/gu, "$1")
    .replace(/〜\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵ])/gu, "〜")
    .replace(new RegExp(`(${japaneseCharacter})\\s*${verticalStrokes}\\s*(?=${japaneseCharacter})`, "gu"), "$1ー")
    .replace(new RegExp(`(${japaneseCharacter})\\s*${verticalStrokes}\\s*(?=[…⋯])`, "gu"), "$1ー")
    .replace(new RegExp(`(ー)\\s*${verticalStrokes}\\s*(?=[…⋯])`, "gu"), "$1")
    .replace(/([きぎしじちぢにひびぴみりキギシジチヂニヒビピミリ])ー([ゃゅょャュョ])/gu, "$1$2ー");
}

/** Keeps readable PDF characters and uses OCR to fill text extraction failures. */
export function mergeReadableSourceText(
  sourceText: string,
  recognizedText: string,
  onCharacterMapping?: (sourceCharacter: string, recognizedCharacter: string) => void,
  characterCorrections: Readonly<Record<string, string>> = {},
): string {
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
        isAlignmentAnchor(sourceCharacter) &&
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
      isAlignmentAnchor(sourceCharacter) &&
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

  const pairedDelimiterReplacements = inferPairedUnreadableDelimiterReplacements(
    source,
    recognized,
    anchors,
  );
  let merged = "";
  let sourceStart = 0;
  let recognizedStart = 0;
  const appendGap = (sourceEnd: number, recognizedEnd: number) => {
    const sourceGap = source.slice(sourceStart, sourceEnd);
    const recognizedGap = recognized.slice(recognizedStart, recognizedEnd);
    const recognizedCharacters = recognizedGap
      .map((character, index) => ({ character, index }))
      .filter(({ character }) => !/\s/u.test(character) && !isUnreadableCharacter(character));
    const sourceCharacterPositions = new Map(
      sourceGap
        .map((character, index) => ({ character, index }))
        .filter(({ character }) => !/\s/u.test(character))
        .map(({ index }, position) => [index, position]),
    );
    const replacements = new Map<number, number>();
    const usedRecognizedIndexes = new Set<number>();

    sourceGap.forEach((_, sourceOffset) => {
      if (
        !isReplaceableSourceCharacter(source, sourceStart + sourceOffset) ||
        recognizedCharacters.length === 0
      ) return;
      const sourceCharacterPosition = sourceCharacterPositions.get(sourceOffset);
      if (sourceCharacterPosition === undefined) return;

      const sourceCharacterIndex = sourceStart + sourceOffset;
      if (pairedDelimiterReplacements.has(sourceCharacterIndex)) return;
      const sourceBoundary = unmatchedBoundaryKind(source, sourceCharacterIndex);
      const previousCharacter = adjacentNonWhitespaceCharacter(source, sourceCharacterIndex, -1);
      const nextCharacter = adjacentNonWhitespaceCharacter(source, sourceCharacterIndex, 1);
      const quoteEndingContext = /[。．!！?？…⋯]/u.test(previousCharacter) &&
        isJapaneseScriptCharacter(nextCharacter);
      const idealIndex = sourceBoundary === "start"
        ? 0
        : sourceBoundary === "end"
          ? recognizedCharacters.length - 1
          : Math.max(
              0,
              Math.min(
                recognizedCharacters.length - 1,
                Math.ceil(
                  ((sourceCharacterPosition + 0.5) * recognizedCharacters.length) /
                    sourceCharacterPositions.size - 1,
                ),
              ),
            );
      const embeddedStrokeContext = hasJapaneseNeighbors(source, sourceStart + sourceOffset);
      const hasOnlyUnreadableSourcePrefix = source
        .slice(0, sourceStart + sourceOffset + 1)
        .every((character) => /\s/u.test(character) || isUnreadableCharacter(character));
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      const quoteCandidate = quoteEndingContext || sourceBoundary === "end"
        ? lastIndexOfCharacter(recognizedCharacters, isClosingQuoteCharacter)
        : -1;
      const openingDelimiterCandidate = hasOnlyUnreadableSourcePrefix
        ? recognizedCharacters.find(({ character, index }) =>
            !usedRecognizedIndexes.has(index) && isOpeningDelimiterCharacter(character),
          )?.index ?? -1
        : -1;
      if (openingDelimiterCandidate >= 0) {
        bestIndex = openingDelimiterCandidate;
      } else if (quoteCandidate >= 0 && !usedRecognizedIndexes.has(quoteCandidate)) {
        bestIndex = quoteCandidate;
      } else if (embeddedStrokeContext) {
        recognizedCharacters.forEach(({ character, index }, candidateIndex) => {
          if (character !== "ー" || usedRecognizedIndexes.has(index)) return;
          const distance = Math.abs(candidateIndex - idealIndex);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        });
      }
      if (bestIndex < 0) {
        recognizedCharacters.forEach(({ index: recognizedOffset }, candidateIndex) => {
          if (usedRecognizedIndexes.has(recognizedOffset)) return;
          const distance = Math.abs(candidateIndex - idealIndex);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = recognizedOffset;
          }
        });
      }
      if (bestIndex >= 0) {
        replacements.set(sourceOffset, bestIndex);
        usedRecognizedIndexes.add(bestIndex);
      }
    });

    sourceGap.forEach((character, sourceOffset) => {
      const sourceCharacterIndex = sourceStart + sourceOffset;
      if (!isReplaceableSourceCharacter(source, sourceCharacterIndex)) {
        merged += character;
        return;
      }

      const pairedDelimiter = pairedDelimiterReplacements.get(sourceCharacterIndex);
      if (pairedDelimiter) {
        onCharacterMapping?.(character, pairedDelimiter);
        merged += pairedDelimiter;
        return;
      }

      const replacementIndex = replacements.get(sourceOffset);
      if (replacementIndex !== undefined) {
        const replacementCharacter = recognizedGap[replacementIndex] ?? "";
        const embeddedStrokeContext = hasJapaneseNeighbors(source, sourceCharacterIndex);
        if (isUnreadableCharacter(character)) {
          if (!isJapaneseScriptCharacter(replacementCharacter) || embeddedStrokeContext) {
            onCharacterMapping?.(character, replacementCharacter);
          }
          const correctedCharacter = characterCorrections[character] ?? replacementCharacter;
          merged += embeddedStrokeContext && isVerticalStrokeCharacter(correctedCharacter)
            ? "ー"
            : correctedCharacter;
        } else if (embeddedStrokeContext && replacementCharacter === "ー") {
          merged += "ー";
        } else {
          merged += character;
        }
      } else if (
        !isUnreadableCharacter(character) ||
        recognizedCharacters.length === 0 ||
        isUnmatchedBoundaryCharacter(source, sourceCharacterIndex)
      ) {
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

function inferPairedUnreadableDelimiterReplacements(
  source: string[],
  recognized: string[],
  anchors: Array<{ sourceIndex: number; recognizedIndex: number }>,
): Map<number, string> {
  const openingForClosing: Record<string, string> = {
    ")": "(", "）": "（", "]": "[", "］": "［", "】": "【", "}": "{",
    "〉": "〈", "》": "《",
  };
  const replacements = new Map<number, string>();

  for (let openingIndex = 0; openingIndex < source.length; openingIndex += 1) {
    if (!isUnreadableCharacter(source[openingIndex] ?? "")) continue;
    const previousCharacter = adjacentNonWhitespaceCharacter(source, openingIndex, -1);
    if (isJapaneseScriptCharacter(previousCharacter)) continue;

    for (let closingIndex = openingIndex + 1; closingIndex < source.length; closingIndex += 1) {
      const sourceCharacter = source[closingIndex] ?? "";
      if (isClosingQuoteCharacter(sourceCharacter)) break;
      if (!isUnreadableCharacter(sourceCharacter)) continue;

      const innerText = source.slice(openingIndex + 1, closingIndex);
      if (innerText.filter(isJapaneseScriptCharacter).length < 2) break;

      const previousAnchor = lastAnchorBefore(anchors, closingIndex);
      const nextAnchor = anchors.find((anchor) => anchor.sourceIndex > closingIndex);
      if (!previousAnchor || !nextAnchor) break;
      const closingGap = recognized.slice(previousAnchor.recognizedIndex + 1, nextAnchor.recognizedIndex);
      const closingDelimiter = [...closingGap].reverse().find((character) =>
        Object.hasOwn(openingForClosing, character),
      );
      const openingDelimiter = closingDelimiter ? openingForClosing[closingDelimiter] : undefined;
      if (!openingDelimiter || !closingDelimiter) break;

      replacements.set(openingIndex, openingDelimiter);
      replacements.set(closingIndex, closingDelimiter);
      break;
    }
  }

  return replacements;
}

function lastAnchorBefore(
  anchors: Array<{ sourceIndex: number; recognizedIndex: number }>,
  sourceIndex: number,
): { sourceIndex: number; recognizedIndex: number } | undefined {
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const anchor = anchors[index];
    if (anchor && anchor.sourceIndex < sourceIndex) return anchor;
  }
  return undefined;
}

export function applyCharacterCorrections(
  blocks: SourceBlock[],
  corrections: Record<string, string>,
): SourceBlock[] {
  const replaceCharacters = (value: string) =>
    Array.from(value).map((character) => corrections[character] ?? character).join("");

  return blocks.map((block) => {
    const speakerLabel = block.speakerLabel
      ? normalizeScriptText(replaceCharacters(block.speakerLabel))
      : undefined;
    const normalizedRawText = normalizeScriptPunctuation(block.rawText, speakerLabel);
    const replacedRawText = replaceCharacters(normalizedRawText);
    const correctedRawText = normalizeScriptText(replacedRawText);
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

export function startsWithUnreadableCharacter(value: string): boolean {
  const firstCharacter = Array.from(value.trimStart())[0] ?? "";
  return isUnreadableCharacter(firstCharacter);
}

/** Infers a replacement only when OCR agrees across independent lines and pages. */
export function inferDocumentCharacterCorrections(
  evidence: CharacterMappingEvidence[],
): Record<string, string> {
  const observations = new Map<string, Map<string, { count: number; blocks: Set<string>; pages: Set<number> }>>();

  for (const item of evidence) {
    if (
      !isUnreadableCharacter(item.sourceCharacter) ||
      Array.from(item.recognizedCharacter).length !== 1 ||
      isUnreadableCharacter(item.recognizedCharacter) ||
      /\s/u.test(item.recognizedCharacter)
    ) continue;

    let candidates = observations.get(item.sourceCharacter);
    if (!candidates) {
      candidates = new Map();
      observations.set(item.sourceCharacter, candidates);
    }
    let candidate = candidates.get(item.recognizedCharacter);
    if (!candidate) {
      candidate = { count: 0, blocks: new Set(), pages: new Set() };
      candidates.set(item.recognizedCharacter, candidate);
    }
    candidate.count += 1;
    candidate.blocks.add(`${item.pageNumber}:${item.blockId}`);
    candidate.pages.add(item.pageNumber);
  }

  const corrections: Record<string, string> = {};
  for (const [sourceCharacter, candidates] of observations) {
    const ranked = [...candidates.entries()].sort((a, b) => b[1].count - a[1].count);
    const [recognizedCharacter, winner] = ranked[0] ?? [];
    const totalCount = ranked.reduce((sum, [, candidate]) => sum + candidate.count, 0);
    if (
      recognizedCharacter &&
      winner &&
      winner.count >= 3 &&
      winner.blocks.size >= 2 &&
      winner.pages.size >= 2 &&
      winner.count / totalCount >= 0.8
    ) corrections[sourceCharacter] = recognizedCharacter;
  }
  return corrections;
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

function isAlignmentAnchor(character: string): boolean {
  return !isUnreadableCharacter(character) && !/\s/u.test(character);
}

function isReplaceableSourceCharacter(source: string[], index: number): boolean {
  const character = source[index] ?? "";
  if (isUnreadableCharacter(character)) return true;
  return isLineStrokeCharacter(character) && hasJapaneseNeighbors(source, index);
}

function isLineStrokeCharacter(character: string): boolean {
  return /[|｜│┃︱︳∣丨ー―—–‐‑−─━-]/u.test(character);
}

function isVerticalStrokeCharacter(character: string): boolean {
  return /[|｜│┃︱︳∣丨]/u.test(character);
}

function isUnmatchedBoundaryCharacter(source: string[], index: number): boolean {
  return unmatchedBoundaryKind(source, index) !== undefined;
}

function unmatchedBoundaryKind(source: string[], index: number): "start" | "end" | undefined {
  if (!isUnreadableCharacter(source[index] ?? "")) return undefined;
  let first = 0;
  let last = source.length - 1;
  while (first <= last && /\s/u.test(source[first] ?? "")) first += 1;
  while (last >= first && /\s/u.test(source[last] ?? "")) last -= 1;
  if (index === first) return "start";
  if (index === last) return "end";
  return undefined;
}

function lastIndexOfCharacter(
  characters: Array<{ character: string; index: number }>,
  predicate: (character: string) => boolean,
): number {
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    if (predicate(characters[index]?.character ?? "")) return characters[index]?.index ?? -1;
  }
  return -1;
}

function isClosingQuoteCharacter(character: string): boolean {
  return /[」』”"]/u.test(character);
}

function isOpeningDelimiterCharacter(character: string): boolean {
  return /[「『“"（(【［\[{〈《:：|｜│┃︱︳∣丨\-－―—–‐‑−─━]/u.test(character);
}

function hasJapaneseNeighbors(source: string[], index: number): boolean {
  const previous = adjacentNonWhitespaceCharacter(source, index, -1);
  const next = adjacentNonWhitespaceCharacter(source, index, 1);
  return isJapaneseScriptCharacter(previous) && isJapaneseScriptCharacter(next);
}

function adjacentNonWhitespaceCharacter(
  source: string[],
  index: number,
  step: -1 | 1,
): string {
  for (let cursor = index + step; cursor >= 0 && cursor < source.length; cursor += step) {
    const character = source[cursor] ?? "";
    if (!/\s/u.test(character)) return character;
  }
  return "";
}

function isJapaneseScriptCharacter(character: string): boolean {
  return !isUnreadableCharacter(character) &&
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵ]/u.test(character);
}

function isAmbiguousSpeakerQuoteMarker(character: string): boolean {
  return /[「『“"|｜│┃︱︳∣丨:：－―—–‐‑−─━-]/u.test(character);
}

function contextAround(value: string, target: string): string {
  const position = value.indexOf(target);
  const start = Math.max(0, position - 12);
  const end = Math.min(value.length, position + target.length + 18);
  return value.slice(start, end);
}
