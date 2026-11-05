// Reconciles local PDF text with local OCR output.

import {
  applyCharacterCorrections,
  type CharacterMappingEvidence,
  findUnusualCharacters,
  startsWithUnreadableCharacter,
} from "./characterCorrections";
import { isMarginalPageNumber } from "./isMarginalPageNumber";
import { mergeReadableSourceText } from "./mergeReadableSourceText";
import {
  normalizeScriptPunctuation,
  normalizeScriptText,
} from "./normalizeScriptText";
import { OCR_RECOGNITION_VERSION } from "./ocrRecognitionVersion";
import {
  cueAtStart,
  inferRecoveredClosingMarkers,
  stripDuplicateSpeakerCue,
} from "./quoteMarkers";
import type { RoleCandidate } from "./roleCandidate";
import type { SourceBlock, SourcePage } from "./sourcePage";
import { normalizeAlias } from "./speakerNames";
import {
  isClosingQuoteCharacter,
  isUnreadableCharacter,
} from "./unreadableCharacter";

export interface OcrReconciliationContext {
  recoveredOpeningMarkers: ReadonlySet<string>;
  roles: RoleCandidate[];
}

export function isOcrRecognizedPage(page: SourcePage): boolean {
  return (
    page.textSource === "ocr" ||
    page.textSource === "mixed" ||
    page.blocks.some((block) => block.recognitionConfidence !== undefined)
  );
}

export function reconcileOcrSpeakerLabels(
  sourcePage: SourcePage,
  recognizedPage: SourcePage,
  context: OcrReconciliationContext,
): SourcePage {
  const { recoveredOpeningMarkers } = context;
  const sourceSpeakers = sourcePage.blocks.flatMap((block) => {
    if (block.recognitionConfidence !== undefined) return [];
    const label =
      block.speakerLabel ??
      cueAtStart(block.rawText, recoveredOpeningMarkers)?.name;
    return label ? [{ block, label }] : [];
  });
  if (sourceSpeakers.length === 0) return recognizedPage;

  const matchTolerance = sourceBlockMatchTolerance(sourcePage);
  let changed = false;
  const blocks = recognizedPage.blocks.map((recognizedBlock) => {
    const confidence = recognizedBlock.recognitionConfidence ?? 0;
    const cue = cueAtStart(recognizedBlock.rawText, recoveredOpeningMarkers);
    if (!cue || confidence < 60) return recognizedBlock;

    const matchingLabels = new Map<string, string>();
    for (const sourceSpeaker of sourceSpeakers) {
      if (
        !isOneLatinHanSuffixOcrConfusion(
          sourceSpeaker.label,
          cue.name,
          confidence,
        )
      )
        continue;
      if (
        !isSafeRecognitionMatch(
          sourcePage,
          sourceSpeaker.block,
          { ...recognizedBlock, speakerLabel: cue.name },
          matchTolerance,
          context,
        )
      )
        continue;
      matchingLabels.set(
        normalizeAlias(sourceSpeaker.label),
        sourceSpeaker.label,
      );
    }
    if (matchingLabels.size !== 1) return recognizedBlock;

    const sourceSpeakerLabel = matchingLabels.values().next().value as
      | string
      | undefined;
    if (!sourceSpeakerLabel) return recognizedBlock;
    const normalizedRawText = normalizeScriptText(recognizedBlock.rawText);
    if (!normalizedRawText.startsWith(cue.name)) return recognizedBlock;

    const rawText = normalizeScriptPunctuation(
      `${sourceSpeakerLabel}${normalizedRawText.slice(cue.name.length)}`,
      sourceSpeakerLabel,
    );
    const text = rawText.startsWith(sourceSpeakerLabel)
      ? rawText.slice(sourceSpeakerLabel.length).trimStart()
      : recognizedBlock.text;
    changed = true;
    return {
      ...recognizedBlock,
      rawText,
      text,
      speakerLabel: sourceSpeakerLabel,
      speakerEvidence: "layout" as const,
    };
  });

  return changed ? { ...recognizedPage, blocks } : recognizedPage;
}

export function mergeRecognizedPage(
  sourcePage: SourcePage,
  recognizedPage: SourcePage,
  context: OcrReconciliationContext,
  characterMappingEvidence?: CharacterMappingEvidence[],
  characterCorrections: Readonly<Record<string, string>> = {},
  preserveRecognizedLayout = false,
): SourcePage {
  const { recoveredOpeningMarkers, roles } = context;
  if (sourcePage.blocks.length === 0) {
    return {
      ...recognizedPage,
      blocks: recognizedPage.blocks.filter(
        (block) =>
          !isMarginalPageNumber(
            block.rawText,
            block.x,
            block.y,
            sourcePage.width,
            sourcePage.height,
            sourcePage.pageNumber,
          ),
      ),
      textSource: "ocr",
      recognitionVersion: OCR_RECOGNITION_VERSION,
    };
  }

  const availableLines = recognizedPage.blocks.filter(
    (block) =>
      !isMarginalPageNumber(
        block.rawText,
        block.x,
        block.y,
        sourcePage.width,
        sourcePage.height,
        sourcePage.pageNumber,
      ),
  );
  let replacedBlockCount = 0;
  const correctedRecognizedBlocks = new Map<string, SourceBlock>();
  const matchTolerance = sourceBlockMatchTolerance(sourcePage);
  const blocks = sourcePage.blocks.map((sourceBlock) => {
    const preserveSidewaysText =
      sourceBlock.hasSidewaysHalfwidthKatakana === true;
    if (
      sourceBlock.recognitionConfidence !== undefined ||
      (!preserveSidewaysText &&
        findUnusualCharacters([sourceBlock], {}).length === 0)
    )
      return sourceBlock;

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let matchingLineCount = 0;
    availableLines.forEach((line, index) => {
      if (
        line.recognitionConfidence === undefined ||
        (!preserveSidewaysText && line.recognitionConfidence < 20)
      )
        return;
      if (
        !isSafeRecognitionMatch(
          sourcePage,
          sourceBlock,
          line,
          matchTolerance,
          context,
        )
      )
        return;
      matchingLineCount += 1;
      const distance =
        sourcePage.direction === "vertical"
          ? Math.abs(sourceBlock.x - line.x)
          : Math.abs(sourceBlock.y - line.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    if (
      bestIndex < 0 ||
      bestDistance > matchTolerance ||
      (preserveSidewaysText && matchingLineCount !== 1)
    )
      return sourceBlock;

    const recognizedBlock = availableLines.splice(bestIndex, 1)[0];
    if (!recognizedBlock) return sourceBlock;
    // 縦書き用OCRが横向きの文字を誤読した行では、文字補完にもOCRを使いません。
    const useSourceTextOnly =
      preserveSidewaysText && (recognizedBlock.recognitionConfidence ?? 0) < 20;
    replacedBlockCount += 1;
    const correctedSourceBlock =
      applyCharacterCorrections([sourceBlock], characterCorrections)[0] ??
      sourceBlock;
    const sourceSpeakerLabel =
      correctedSourceBlock.speakerLabel ??
      cueAtStart(correctedSourceBlock.text, recoveredOpeningMarkers, roles)
        ?.name ??
      (startsWithUnreadableCharacter(correctedSourceBlock.text)
        ? recognizedBlock.speakerLabel
        : undefined);
    const speakerLabel = sourceSpeakerLabel;
    const sourceText =
      !correctedSourceBlock.speakerLabel &&
      sourceSpeakerLabel &&
      correctedSourceBlock.text.startsWith(sourceSpeakerLabel)
        ? correctedSourceBlock.text.slice(sourceSpeakerLabel.length).trimStart()
        : correctedSourceBlock.text;
    const recognizedTextSource =
      sourceSpeakerLabel && recognizedBlock.speakerLabel
        ? recognizedBlock.text
        : recognizedBlock.rawText;
    const normalizedRecognizedText = normalizeScriptPunctuation(
      recognizedTextSource,
      speakerLabel,
    );
    const recognizedText = normalizeScriptText(
      sourceSpeakerLabel
        ? stripDuplicateSpeakerCue(
            normalizedRecognizedText,
            sourceSpeakerLabel,
            recoveredOpeningMarkers,
          )
        : normalizedRecognizedText,
    );
    const onCharacterMapping =
      characterMappingEvidence &&
      (recognizedBlock.recognitionConfidence ?? 0) >= 60
        ? (sourceCharacter: string, recognizedCharacter: string) => {
            characterMappingEvidence.push({
              sourceCharacter,
              recognizedCharacter,
              pageNumber: sourcePage.pageNumber,
              blockId: sourceBlock.id,
            });
          }
        : undefined;
    const mergedTextWithCue = useSourceTextOnly
      ? sourceText
      : mergeReadableSourceText(
          sourceText,
          recognizedText,
          onCharacterMapping,
          characterCorrections,
        );
    const mergedText = normalizeScriptText(
      speakerLabel
        ? stripDuplicateSpeakerCue(
            mergedTextWithCue,
            speakerLabel,
            recoveredOpeningMarkers,
          )
        : mergedTextWithCue,
    );
    const mergedRawText = normalizeScriptText(
      speakerLabel
        ? `${speakerLabel}${mergedTextWithCue}`
        : useSourceTextOnly
          ? correctedSourceBlock.text
          : mergeReadableSourceText(
              correctedSourceBlock.rawText,
              normalizeScriptPunctuation(recognizedBlock.rawText, speakerLabel),
              undefined,
              characterCorrections,
            ),
    );

    const mergedBlock: SourceBlock = {
      ...recognizedBlock,
      id: sourceBlock.id,
      orderOnPage: sourceBlock.orderOnPage,
      x: sourceBlock.x,
      y: sourceBlock.y,
      fontSize: sourceBlock.fontSize,
      itemIds: sourceBlock.itemIds,
      visualGapAfter: sourceBlock.visualGapAfter,
      rawText: mergedRawText,
      text: mergedText,
      speakerLabel,
      ...(preserveSidewaysText ? { hasSidewaysHalfwidthKatakana: true } : {}),
      ...(sourceBlock.speakerAliases
        ? { speakerAliases: sourceBlock.speakerAliases }
        : {}),
    };
    if (preserveRecognizedLayout) {
      correctedRecognizedBlocks.set(recognizedBlock.id, {
        ...recognizedBlock,
        rawText: mergedRawText,
        text: mergedText,
        speakerLabel,
        ...(preserveSidewaysText ? { hasSidewaysHalfwidthKatakana: true } : {}),
        ...(sourceBlock.speakerAliases
          ? { speakerAliases: sourceBlock.speakerAliases }
          : {}),
      });
    }
    return mergedBlock;
  });

  if (preserveRecognizedLayout) {
    const correctedBlocks = recognizedPage.blocks.map(
      (block) => correctedRecognizedBlocks.get(block.id) ?? block,
    );
    const restoredBlocks = restoreMissingDialogueEndings(
      sourcePage,
      correctedBlocks,
      context,
      characterCorrections,
      matchTolerance,
    );
    if (replacedBlockCount === 0 && restoredBlocks === correctedBlocks)
      return recognizedPage;
    return {
      ...recognizedPage,
      blocks: restoredBlocks,
      textSource: "mixed",
      recognitionVersion: OCR_RECOGNITION_VERSION,
    };
  }
  if (replacedBlockCount === 0) return sourcePage;
  return {
    ...sourcePage,
    blocks,
    textSource: "mixed",
    recognitionVersion: OCR_RECOGNITION_VERSION,
  };
}

/** OCRで列・行ごと欠落したセリフ末尾を、直前の対応するOCRブロックの後に補います。 */
function restoreMissingDialogueEndings(
  sourcePage: SourcePage,
  recognizedBlocks: SourceBlock[],
  context: OcrReconciliationContext,
  characterCorrections: Readonly<Record<string, string>>,
  matchTolerance: number,
): SourceBlock[] {
  const closingMarkers = inferRecoveredClosingMarkers(
    sourcePage.blocks,
    context.recoveredOpeningMarkers,
  );
  const afterBlock = new Map<string, SourceBlock>();
  const position = (block: SourceBlock) =>
    sourcePage.direction === "vertical" ? block.x : block.y;

  sourcePage.blocks.forEach((sourceBlock, index) => {
    const previousSource = sourcePage.blocks[index - 1];
    if (
      !previousSource ||
      sourceBlock.speakerLabel ||
      sourceBlock.recognitionConfidence !== undefined ||
      cueAtStart(sourceBlock.rawText, context.recoveredOpeningMarkers)
    )
      return;

    const corrected = applyCharacterCorrections(
      [sourceBlock],
      characterCorrections,
    )[0];
    if (!corrected) return;
    let text = corrected.text.trim();
    const ending = Array.from(text).at(-1) ?? "";
    if (
      closingMarkers.has(ending) &&
      !context.recoveredOpeningMarkers.has(ending)
    )
      text = `${text.slice(0, -ending.length)}」`;
    if (
      !isClosingQuoteCharacter(Array.from(text).at(-1) ?? "") ||
      Array.from(text).some(isUnreadableCharacter)
    )
      return;

    const sourcePosition = position(sourceBlock);
    // 隣の列・行をまとめたOCR結果がある場合は、重複を避けるため補いません。
    const alreadyCovered = recognizedBlocks.some((block) => {
      if (Math.abs(position(block) - sourcePosition) <= matchTolerance)
        return true;
      const bounds = block.recognitionBounds;
      if (!bounds) return false;
      const min =
        sourcePage.direction === "vertical" ? bounds.xMin : bounds.yMin;
      const max =
        sourcePage.direction === "vertical" ? bounds.xMax : bounds.yMax;
      return (
        min - matchTolerance <= sourcePosition &&
        sourcePosition <= max + matchTolerance
      );
    });
    if (alreadyCovered) return;

    const anchors = recognizedBlocks.filter(
      (block) =>
        (block.recognitionConfidence ?? 0) >= 60 &&
        isSafeRecognitionMatch(
          sourcePage,
          previousSource,
          block,
          matchTolerance,
          context,
        ),
    );
    const anchor = anchors[0];
    if (
      anchors.length !== 1 ||
      !anchor ||
      isClosingQuoteCharacter(Array.from(anchor.text.trimEnd()).at(-1) ?? "")
    )
      return;
    const next = recognizedBlocks[recognizedBlocks.indexOf(anchor) + 1];
    if (
      sourcePosition >= position(anchor) ||
      (next && sourcePosition <= position(next))
    )
      return;
    afterBlock.set(anchor.id, { ...sourceBlock, rawText: text, text });
  });

  if (afterBlock.size === 0) return recognizedBlocks;
  return recognizedBlocks
    .flatMap((block) => {
      const restored = afterBlock.get(block.id);
      return restored ? [block, restored] : [block];
    })
    .map((block, index) => ({ ...block, orderOnPage: index + 1 }));
}

function sourceBlockMatchTolerance(page: SourcePage): number {
  const positions = page.blocks
    .map((block) => (page.direction === "vertical" ? block.x : block.y))
    .sort((a, b) => a - b);
  const gaps = positions
    .slice(1)
    .map((position, index) => position - (positions[index] ?? position))
    .filter((gap) => gap > 0);
  const typicalGap = median(gaps);
  const typicalFontSize = median(
    page.blocks.map((block) => block.fontSize ?? 0).filter((size) => size > 0),
  );
  const fontTolerance = Math.max(4, typicalFontSize * 1.25);
  return typicalGap > 0
    ? Math.min(fontTolerance, typicalGap * 0.48)
    : fontTolerance;
}

function isSafeRecognitionMatch(
  page: SourcePage,
  sourceBlock: SourceBlock,
  recognizedBlock: SourceBlock,
  matchTolerance: number,
  context: OcrReconciliationContext,
): boolean {
  const { recoveredOpeningMarkers, roles } = context;
  if (sourceBlock.recognitionConfidence !== undefined) return false;

  const sourcePosition =
    page.direction === "vertical" ? sourceBlock.x : sourceBlock.y;
  const recognizedPosition =
    page.direction === "vertical" ? recognizedBlock.x : recognizedBlock.y;
  if (Math.abs(sourcePosition - recognizedPosition) > matchTolerance)
    return false;

  const bounds = recognizedBlock.recognitionBounds;
  if (bounds) {
    const crossAxisSpan =
      page.direction === "vertical"
        ? bounds.xMax - bounds.xMin
        : bounds.yMax - bounds.yMin;
    const sourceFontSize = Math.max(sourceBlock.fontSize ?? 0, 1);
    const pagePositions = page.blocks
      .map((block) => (page.direction === "vertical" ? block.x : block.y))
      .sort((a, b) => a - b);
    const gaps = pagePositions
      .slice(1)
      .map((position, index) => position - (pagePositions[index] ?? position))
      .filter((gap) => gap > 0);
    const typicalGap = median(gaps);
    const maximumCrossAxisSpan =
      typicalGap > 0
        ? Math.min(sourceFontSize * 2, typicalGap * 0.82)
        : sourceFontSize * 1.8;
    if (crossAxisSpan > maximumCrossAxisSpan) return false;
  }

  const sourceSpeaker =
    sourceBlock.speakerLabel ??
    cueAtStart(sourceBlock.text, recoveredOpeningMarkers, roles)?.name;
  const recognizedSpeaker =
    recognizedBlock.speakerLabel ??
    cueAtStart(recognizedBlock.text, recoveredOpeningMarkers, roles)?.name;
  if (
    sourceSpeaker &&
    recognizedSpeaker &&
    speakerLabelKey(sourceSpeaker) !== speakerLabelKey(recognizedSpeaker)
  ) {
    const sourceKey = normalizeAlias(sourceSpeaker);
    const recognizedKey = normalizeAlias(recognizedSpeaker);
    const extraCharacter = Array.from(recognizedKey.slice(sourceKey.length));
    const hasOneCjkOcrSuffix =
      recognizedKey.startsWith(sourceKey) &&
      extraCharacter.length === 1 &&
      /^\p{Script=Han}$/u.test(extraCharacter[0] ?? "");
    if (
      !hasOneCjkOcrSuffix &&
      !isOneLatinHanSuffixOcrConfusion(
        sourceSpeaker,
        recognizedSpeaker,
        recognizedBlock.recognitionConfidence ?? 0,
      )
    )
      return false;
  }

  return true;
}

function speakerLabelKey(value: string): string {
  const members = value
    .split(/[、,，・&＆/／\u3400-\u4dbf]/u)
    .map((member) => normalizeAlias(member));
  return members.length > 1 && members.every(Boolean)
    ? members.sort().join("\u0000")
    : normalizeAlias(value);
}

function isOneLatinHanSuffixOcrConfusion(
  sourceLabel: string,
  recognizedLabel: string,
  confidence: number,
): boolean {
  if (confidence < 60) return false;
  const source = Array.from(normalizeAlias(sourceLabel));
  const recognized = Array.from(normalizeAlias(recognizedLabel));
  if (source.length < 2 || source.length !== recognized.length) return false;

  const sourceSuffix = source.at(-1) ?? "";
  const recognizedSuffix = recognized.at(-1) ?? "";
  const sourceBase = source.slice(0, -1).join("");
  const recognizedBase = recognized.slice(0, -1).join("");
  const hasJapaneseBase =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sourceBase);
  const sourceIsLatin = /^[\p{Script=Latin}\p{Number}]$/u.test(sourceSuffix);
  const recognizedIsLatin = /^[\p{Script=Latin}\p{Number}]$/u.test(
    recognizedSuffix,
  );
  const sourceIsHan = /^\p{Script=Han}$/u.test(sourceSuffix);
  const recognizedIsHan = /^\p{Script=Han}$/u.test(recognizedSuffix);

  return (
    hasJapaneseBase &&
    sourceBase === recognizedBase &&
    ((sourceIsLatin && recognizedIsHan) || (sourceIsHan && recognizedIsLatin))
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}
