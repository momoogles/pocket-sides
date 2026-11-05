// Align local PDF text with local OCR output.

import {
  adjacentNonWhitespaceCharacter,
  hasJapaneseNeighbors,
  isAlignmentAnchor,
  isClosingQuoteCharacter,
  isJapaneseScriptCharacter,
  isOpeningDelimiterCharacter,
  isReplaceableSourceCharacter,
  isUnmatchedBoundaryCharacter,
  isUnreadableCharacter,
  isVerticalStrokeCharacter,
  lastIndexOfCharacter,
  unmatchedBoundaryKind,
} from "./unreadableCharacter";

/** Keeps readable PDF characters and uses OCR to fill text extraction failures. */
export function mergeReadableSourceText(
  sourceText: string,
  recognizedText: string,
  onCharacterMapping?: (
    sourceCharacter: string,
    recognizedCharacter: string,
  ) => void,
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
  for (
    let sourceIndex = source.length - 1;
    sourceIndex >= 0;
    sourceIndex -= 1
  ) {
    for (
      let recognizedIndex = recognized.length - 1;
      recognizedIndex >= 0;
      recognizedIndex -= 1
    ) {
      const sourceCharacter = source[sourceIndex] ?? "";
      const cellIndex = sourceIndex * width + recognizedIndex;
      if (
        isAlignmentAnchor(sourceCharacter) &&
        sourceCharacter === recognized[recognizedIndex]
      ) {
        commonLength[cellIndex] =
          1 + commonLength[(sourceIndex + 1) * width + recognizedIndex + 1];
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

  const pairedDelimiterReplacements =
    inferPairedUnreadableDelimiterReplacements(source, recognized, anchors);
  let merged = "";
  let sourceStart = 0;
  let recognizedStart = 0;
  const appendGap = (sourceEnd: number, recognizedEnd: number) => {
    const sourceGap = source.slice(sourceStart, sourceEnd);
    const recognizedGap = recognized.slice(recognizedStart, recognizedEnd);
    const recognizedCharacters = recognizedGap
      .map((character, index) => ({ character, index }))
      .filter(
        ({ character }) =>
          !/\s/u.test(character) && !isUnreadableCharacter(character),
      );
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
      )
        return;
      const sourceCharacterPosition =
        sourceCharacterPositions.get(sourceOffset);
      if (sourceCharacterPosition === undefined) return;

      const sourceCharacterIndex = sourceStart + sourceOffset;
      if (pairedDelimiterReplacements.has(sourceCharacterIndex)) return;
      const sourceBoundary = unmatchedBoundaryKind(
        source,
        sourceCharacterIndex,
      );
      const previousCharacter = adjacentNonWhitespaceCharacter(
        source,
        sourceCharacterIndex,
        -1,
      );
      const nextCharacter = adjacentNonWhitespaceCharacter(
        source,
        sourceCharacterIndex,
        1,
      );
      const quoteEndingContext =
        /[。．!！?？…⋯]/u.test(previousCharacter) &&
        isJapaneseScriptCharacter(nextCharacter);
      const idealIndex =
        sourceBoundary === "start"
          ? 0
          : sourceBoundary === "end"
            ? recognizedCharacters.length - 1
            : Math.max(
                0,
                Math.min(
                  recognizedCharacters.length - 1,
                  Math.ceil(
                    ((sourceCharacterPosition + 0.5) *
                      recognizedCharacters.length) /
                      sourceCharacterPositions.size -
                      1,
                  ),
                ),
              );
      const embeddedStrokeContext = hasJapaneseNeighbors(
        source,
        sourceStart + sourceOffset,
      );
      const hasOnlyUnreadableSourcePrefix = source
        .slice(0, sourceStart + sourceOffset + 1)
        .every(
          (character) =>
            /\s/u.test(character) || isUnreadableCharacter(character),
        );
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      const quoteCandidate =
        quoteEndingContext || sourceBoundary === "end"
          ? lastIndexOfCharacter(recognizedCharacters, isClosingQuoteCharacter)
          : -1;
      const openingDelimiterCandidate = hasOnlyUnreadableSourcePrefix
        ? (recognizedCharacters.find(
            ({ character, index }) =>
              !usedRecognizedIndexes.has(index) &&
              isOpeningDelimiterCharacter(character),
          )?.index ?? -1)
        : -1;
      if (openingDelimiterCandidate >= 0) {
        bestIndex = openingDelimiterCandidate;
      } else if (
        quoteCandidate >= 0 &&
        !usedRecognizedIndexes.has(quoteCandidate)
      ) {
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
        recognizedCharacters.forEach(
          ({ index: recognizedOffset }, candidateIndex) => {
            if (usedRecognizedIndexes.has(recognizedOffset)) return;
            const distance = Math.abs(candidateIndex - idealIndex);
            if (distance < bestDistance) {
              bestDistance = distance;
              bestIndex = recognizedOffset;
            }
          },
        );
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

      const pairedDelimiter =
        pairedDelimiterReplacements.get(sourceCharacterIndex);
      if (pairedDelimiter) {
        onCharacterMapping?.(character, pairedDelimiter);
        merged += pairedDelimiter;
        return;
      }

      const replacementIndex = replacements.get(sourceOffset);
      if (replacementIndex !== undefined) {
        const replacementCharacter = recognizedGap[replacementIndex] ?? "";
        const embeddedStrokeContext = hasJapaneseNeighbors(
          source,
          sourceCharacterIndex,
        );
        if (isUnreadableCharacter(character)) {
          if (
            !isJapaneseScriptCharacter(replacementCharacter) ||
            embeddedStrokeContext
          ) {
            onCharacterMapping?.(character, replacementCharacter);
          }
          const correctedCharacter =
            characterCorrections[character] ?? replacementCharacter;
          merged +=
            embeddedStrokeContext &&
            isVerticalStrokeCharacter(correctedCharacter)
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
    ")": "(",
    "）": "（",
    "]": "[",
    "］": "［",
    "】": "【",
    "}": "{",
    "〉": "〈",
    "》": "《",
  };
  const replacements = new Map<number, string>();

  for (let openingIndex = 0; openingIndex < source.length; openingIndex += 1) {
    if (!isUnreadableCharacter(source[openingIndex] ?? "")) continue;
    const previousCharacter = adjacentNonWhitespaceCharacter(
      source,
      openingIndex,
      -1,
    );
    if (isJapaneseScriptCharacter(previousCharacter)) continue;

    for (
      let closingIndex = openingIndex + 1;
      closingIndex < source.length;
      closingIndex += 1
    ) {
      const sourceCharacter = source[closingIndex] ?? "";
      if (isClosingQuoteCharacter(sourceCharacter)) break;
      if (!isUnreadableCharacter(sourceCharacter)) continue;

      const innerText = source.slice(openingIndex + 1, closingIndex);
      if (innerText.filter(isJapaneseScriptCharacter).length < 2) break;

      const previousAnchor = lastAnchorBefore(anchors, closingIndex);
      const nextAnchor = anchors.find(
        (anchor) => anchor.sourceIndex > closingIndex,
      );
      if (!previousAnchor || !nextAnchor) break;
      const closingGap = recognized.slice(
        previousAnchor.recognizedIndex + 1,
        nextAnchor.recognizedIndex,
      );
      const closingDelimiter = [...closingGap]
        .reverse()
        .find((character) => Object.hasOwn(openingForClosing, character));
      const openingDelimiter = closingDelimiter
        ? openingForClosing[closingDelimiter]
        : undefined;
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
