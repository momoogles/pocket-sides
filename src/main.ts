import { applyBoundaryEdits, type BoundaryEdit } from "./pdf/boundaries";
import "@fontsource/ibm-plex-sans-jp/latin-400.css";
import "@fontsource/ibm-plex-sans-jp/latin-500.css";
import "@fontsource/ibm-plex-sans-jp/latin-ext-400.css";
import "@fontsource/ibm-plex-sans-jp/latin-ext-500.css";
import "@fontsource/ibm-plex-sans-jp/japanese-400.css";
import "@fontsource/ibm-plex-sans-jp/japanese-500.css";
import "./styles.css";
import practiceStyles from "./practice.module.css";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { OCR_RECOGNITION_VERSION } from "./pdf/types";
import { loadPdf } from "./pdf/extract";
import { createLocalOcrReader, OcrInitializationError, type OcrProgress } from "./pdf/ocr";
import { isMarginalPageNumber } from "./pdf/layout";
import {
  getSavedReading,
  listSavedReadings,
  type SavedReadingSummary,
} from "./pdf/ocr-cache";
import {
  canSavePracticeHistory,
  deleteAllSavedPracticeData,
  deleteSavedPractice,
  getSavedPractice,
  listSavedPractices,
  savePractice,
  type SavedPractice,
  type SavedPracticeInput,
  type SavedPracticeSummary,
} from "./pdf/practice-cache";
import {
  applyCharacterCorrections,
  findUnusualCharacters,
  inferDocumentCharacterCorrections,
  mergeReadableSourceText,
  normalizeScriptPunctuation,
  normalizeScriptText,
  startsWithUnreadableCharacter,
  type CharacterMappingEvidence,
} from "./pdf/corrections";
import {
  blockPosition,
  buildPracticeTargets,
  collectBlocks,
  cueAtStart,
  detectRoleCandidates,
  getSpeakerTurns,
  hasEnoughText,
  applyRecoveredQuoteMarkers,
  inferRecoveredClosingMarkers,
  inferRecoveredOpeningMarkers,
  isCastListEntry,
  isPlausibleSpeakerLabel,
  isStageDirectionBlock,
  normalizeAlias,
  splitStageDirectionText,
  splitInlineSpeakerBlocks,
  stripDuplicateSpeakerCue,
} from "./pdf/segments";
import type {
  PracticeTarget,
  RoleCandidate,
  SourceBlock,
  SourcePage,
  SpeakerTurn,
} from "./pdf/types";

type Screen = "home" | "analysis" | "appearances" | "practice";
type LoadingPurpose = "opening-pdf" | "restoring-practice";
type NotificationTone = "info" | "success" | "warning";

interface AppNotification {
  id: number;
  message: string;
  tone: NotificationTone;
}

interface PracticeRange {
  start: number;
  end: number;
}

interface AppState {
  screen: Screen;
  loading: boolean;
  loadingPurpose: LoadingPurpose;
  progress: number;
  progressLabel: string;
  error: string;
  fileName: string;
  fileSize: number;
  pages: SourcePage[];
  originalPages: SourcePage[];
  pdfFingerprint: string | null;
  cachedOcrPages: SourcePage[];
  legacySavedReadings: SavedReadingSummary[];
  savedPractices: SavedPracticeSummary[];
  savedPractice: SavedPractice | null;
  notification: AppNotification | null;
  practiceSaveBusy: boolean;
  pendingResumeFingerprint: string | null;
  practiceHasStarted: boolean;
  document: PDFDocumentProxy | null;
  disposePdf: (() => Promise<void>) | null;
  corrections: Record<string, string>;
  roles: RoleCandidate[];
  excludedRoleIds: Set<string>;
  selectedRoleId: string;
  manualSpeakers: Record<string, string>;
  boundaryEdits: BoundaryEdit[];
  manualRoleNumber: number;
  previewPage: number;
  previewZoom: number;
  currentTargetIndex: number;
  ranges: Record<string, PracticeRange>;
  revealed: boolean;
  showOriginal: boolean;
  originalPage: number;
  ocrBusy: boolean;
  ocrCancelRequested: boolean;
  ocrProgress: number;
  ocrTotal: number;
  ocrStatus: string;
  ocrErrors: Record<"text" | "layout", string>;
  textOcrCompletion: { pageCount: number; replacedPages: number } | null;
  ocrPurpose: "layout" | "text";
  layoutPreview: SourcePage[] | null;
  ocrAnalysisComplete: boolean;
  textOcrPreview: { pages: SourcePage[]; corrections: Record<string, string> } | null;
}

const state: AppState = {
  screen: "home",
  loading: false,
  loadingPurpose: "opening-pdf",
  progress: 0,
  progressLabel: "",
  error: "",
  fileName: "",
  fileSize: 0,
  pages: [],
  originalPages: [],
  pdfFingerprint: null,
  cachedOcrPages: [],
  legacySavedReadings: [],
  savedPractices: [],
  savedPractice: null,
  notification: null,
  practiceSaveBusy: false,
  pendingResumeFingerprint: null,
  practiceHasStarted: false,
  document: null,
  disposePdf: null,
  corrections: {},
  roles: [],
  excludedRoleIds: new Set(),
  selectedRoleId: "",
  manualSpeakers: {},
  boundaryEdits: [],
  manualRoleNumber: 0,
  previewPage: 1,
  previewZoom: 1,
  currentTargetIndex: 0,
  ranges: {},
  revealed: false,
  showOriginal: false,
  originalPage: 1,
  ocrBusy: false,
  ocrCancelRequested: false,
  ocrProgress: 0,
  ocrTotal: 0,
  ocrStatus: "",
  ocrErrors: { text: "", layout: "" },
  textOcrCompletion: null,
  ocrPurpose: "layout",
  layoutPreview: null,
  ocrAnalysisComplete: false,
  textOcrPreview: null,
};

const foundRoot = document.querySelector<HTMLDivElement>("#app");
if (!foundRoot) throw new Error("アプリの表示領域が見つかりません。");
const root: HTMLDivElement = foundRoot;

let previewTask: ReturnType<PDFPageProxy["render"]> | null = null;
let boundaryDraft: { source: string; text: string } | null = null;
let previewGeneration = 0;
let practiceSaveTimer: number | null = null;
let notificationTimer: number | null = null;
let notificationSequence = 0;
let previewPointerStart: { x: number; y: number } | null = null;
let lastPreviewWheelTurn = 0;
let cachedDerivedBlocks: {
  pages: SourcePage[];
  roles: string;
  corrections: string;
  boundaryEdits: BoundaryEdit[];
  unedited: SourceBlock[];
  value: SourceBlock[];
} | null = null;
let cachedSpeakerTurns: {
  blocks: SourceBlock[];
  roles: string;
  manualSpeakers: string;
  value: SpeakerTurn[];
} | null = null;
let cachedPracticeTargets: {
  blocks: SourceBlock[];
  turns: SpeakerTurn[];
  roleId: string;
  value: PracticeTarget[];
} | null = null;
const recognizedPageCache = new Map<number, SourcePage>();
let recoveredOpeningMarkers = new Set<string>();
let recoveredClosingMarkers = new Set<string>();

function notify(message: string, tone: NotificationTone = "info"): void {
  if (notificationTimer !== null) window.clearTimeout(notificationTimer);
  const id = ++notificationSequence;
  state.notification = { id, message, tone };
  notificationTimer = window.setTimeout(() => {
    if (state.notification?.id !== id) return;
    state.notification = null;
    notificationTimer = null;
    renderApp();
  }, tone === "warning" ? 7000 : 4500);
}

function clearNotification(): void {
  if (notificationTimer !== null) window.clearTimeout(notificationTimer);
  notificationTimer = null;
  state.notification = null;
}

function rawBlocks(): SourceBlock[] {
  return collectBlocks(state.pages);
}

function inferredMarkerCorrections(): Record<string, string> {
  const corrections: Record<string, string> = {};
  for (const marker of recoveredOpeningMarkers) {
    if (!recoveredClosingMarkers.has(marker)) corrections[marker] = "「";
  }
  for (const marker of recoveredClosingMarkers) {
    if (!recoveredOpeningMarkers.has(marker)) corrections[marker] = "」";
  }
  return corrections;
}

function blocks(includeBoundaryEdits = true): SourceBlock[] {
  const roleCandidates = usableRoleCandidates();
  const roleSignature = JSON.stringify(roleCandidates.map(({ id, label, aliases, manual }) => [id, label, aliases, manual]));
  const correctionsSignature = JSON.stringify(state.corrections);
  if (
    cachedDerivedBlocks &&
    cachedDerivedBlocks.pages === state.pages &&
    cachedDerivedBlocks.roles === roleSignature &&
    cachedDerivedBlocks.corrections === correctionsSignature &&
    cachedDerivedBlocks.boundaryEdits === state.boundaryEdits
  ) return includeBoundaryEdits ? cachedDerivedBlocks.value : cachedDerivedBlocks.unedited;

  const rawSourceBlocks = rawBlocks();
  const supportedNames = new Set(detectRoleCandidates(rawSourceBlocks).flatMap((role) => role.aliases.map(normalizeAlias)));
  const sourceBlocks = rawSourceBlocks.map((block) => {
    if (block.speakerEvidence !== "quotation" || !block.speakerLabel ||
      supportedNames.has(normalizeAlias(block.speakerLabel))) return block;
    return {
      ...block,
      text: block.speakerLabel + block.text,
      speakerLabel: undefined,
      speakerAliases: undefined,
      coSpeakers: undefined,
    };
  });
  recoveredOpeningMarkers = inferRecoveredOpeningMarkers(sourceBlocks);
  recoveredClosingMarkers = inferRecoveredClosingMarkers(sourceBlocks, recoveredOpeningMarkers);
  const corrected = applySeparatedLatinRoleSuffixes(
    applyRecoveredQuoteMarkers(
      applyCharacterCorrections(sourceBlocks, state.corrections),
      recoveredOpeningMarkers,
      recoveredClosingMarkers,
    ).map((block) => {
      if (isStageDirectionBlock(block, roleCandidates)) {
        const label = block.speakerLabel?.trim();
        const text = block.text.trimStart();
        const normalizedText = normalizeAlias(text);
        const normalizedLabel = label ? normalizeAlias(label) : "";
        const remainder = Array.from(normalizedText).slice(Array.from(normalizedLabel).length).join("");
        const textAlreadyHasLabel = Boolean(label && normalizedText.startsWith(normalizedLabel) && /^[、,，:：]/u.test(remainder));
        const textHasLeadingSeparator = /^[、,，:：]/u.test(text);
        return {
          ...block,
          speakerLabel: undefined,
          text: normalizeScriptText(
            !label || textAlreadyHasLabel || textHasLeadingSeparator
              ? `${label ?? ""}${text}`
              : `${label}、${text}`,
          ),
        };
      }
      if (!block.speakerLabel || isPlausibleSpeakerLabel(block.speakerLabel)) return block;
      return {
        ...block,
        speakerLabel: undefined,
        text: normalizeScriptText(block.speakerLabel + block.text),
      };
    }),
  );
  const withoutDuplicateCues = corrected.map((block) =>
    block.speakerLabel
      ? { ...block, text: stripDuplicateSpeakerCue(block.text, block.speakerLabel, recoveredOpeningMarkers) }
      : block,
  );
  const unedited = splitInlineSpeakerBlocks(withoutDuplicateCues, roleCandidates);
  const result = applyBoundaryEdits(unedited, state.boundaryEdits);
  cachedDerivedBlocks = {
    pages: state.pages,
    roles: roleSignature,
    corrections: correctionsSignature,
    boundaryEdits: state.boundaryEdits,
    unedited,
    value: result,
  };
  return includeBoundaryEdits ? result : unedited;
}

function usableRoleCandidates(): RoleCandidate[] {
  return state.roles
    .filter((role) => role.manual || isPlausibleSpeakerLabel(role.label))
    .map((role) => ({
      ...role,
      aliases: role.aliases.filter(isPlausibleSpeakerLabel),
    }));
}

function applySeparatedLatinRoleSuffixes(sourceBlocks: SourceBlock[]): SourceBlock[] {
  const result = sourceBlocks.map((block) => ({ ...block }));
  const inferredSuffixes = new Map<string, { baseName: string; suffix: string }>();
  for (let index = 0; index < result.length; index += 1) {
    const block = result[index];
    if (!block || block.direction !== "vertical") continue;
    const cue = block.speakerLabel
      ? { name: block.speakerLabel }
      : cueAtStart(block.text, recoveredOpeningMarkers, usableRoleCandidates());
    if (!cue || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(cue.name)) continue;

    for (const neighborIndex of [index - 1, index + 1]) {
      const neighbor = result[neighborIndex];
      if (!neighbor || neighbor.pageNumber !== block.pageNumber || neighbor.direction !== "vertical") continue;
      if (neighbor.speakerLabel || neighbor.isSpeakerSuffix) continue;
      const suffix = normalizeAlias(neighbor.text);
      if (!/^[\p{Script=Latin}\p{Number}]{1,2}$/u.test(suffix)) continue;

      const fontSize = Math.max(block.fontSize ?? 0, neighbor.fontSize ?? 0, 1);
      if (
        Math.abs(block.x - neighbor.x) > fontSize * 1.5 ||
        Math.abs(block.y - neighbor.y) > fontSize * 1.5
      ) continue;

      const fullName = cue.name + suffix;
      inferredSuffixes.set(normalizeAlias(cue.name), { baseName: cue.name, suffix });
      block.speakerAliases = [...new Set([...(block.speakerAliases ?? []), cue.name])];
      if (block.speakerLabel) {
        block.speakerLabel = fullName;
      } else {
        block.text = fullName + block.text.slice(cue.name.length);
      }
      neighbor.isSpeakerSuffix = true;
      neighbor.speakerAliases = [fullName];
      neighbor.text = "";
      break;
    }
  }

  for (const block of result) {
    if (block.isSpeakerSuffix) continue;
    const cue = block.speakerLabel
      ? { name: block.speakerLabel }
      : cueAtStart(block.text, recoveredOpeningMarkers, usableRoleCandidates());
    if (!cue) continue;
    const inferred = inferredSuffixes.get(normalizeAlias(cue.name));
    if (!inferred) continue;
    const fullName = inferred.baseName + inferred.suffix;
    block.speakerAliases = [...new Set([...(block.speakerAliases ?? []), cue.name])];
    if (block.speakerLabel) {
      block.speakerLabel = fullName;
    } else {
      block.text = fullName + block.text.slice(cue.name.length);
    }
  }
  return result;
}

function turns(): SpeakerTurn[] {
  return turnsForBlocks(blocks());
}

function turnsForBlocks(sourceBlocks: SourceBlock[]): SpeakerTurn[] {
  const roles = usableRoleCandidates();
  const roleSignature = JSON.stringify(roles.map(({ id, label, aliases, manual }) => [id, label, aliases, manual]));
  const manualSpeakersSignature = JSON.stringify(state.manualSpeakers);
  if (
    cachedSpeakerTurns &&
    cachedSpeakerTurns.blocks === sourceBlocks &&
    cachedSpeakerTurns.roles === roleSignature &&
    cachedSpeakerTurns.manualSpeakers === manualSpeakersSignature
  ) return cachedSpeakerTurns.value;

  const value = getSpeakerTurns(sourceBlocks, roles, state.manualSpeakers);
  cachedSpeakerTurns = {
    blocks: sourceBlocks,
    roles: roleSignature,
    manualSpeakers: manualSpeakersSignature,
    value,
  };
  return value;
}

function practiceTargets(): PracticeTarget[] {
  const sourceBlocks = blocks();
  const speakerTurns = turnsForBlocks(sourceBlocks);
  if (
    cachedPracticeTargets &&
    cachedPracticeTargets.blocks === sourceBlocks &&
    cachedPracticeTargets.turns === speakerTurns &&
    cachedPracticeTargets.roleId === state.selectedRoleId
  ) return cachedPracticeTargets.value;

  const value = buildPracticeTargets(sourceBlocks, speakerTurns, state.selectedRoleId);
  cachedPracticeTargets = { blocks: sourceBlocks, turns: speakerTurns, roleId: state.selectedRoleId, value };
  return value;
}

function isOcrRecognizedPage(page: SourcePage): boolean {
  return page.textSource === "ocr" ||
    page.textSource === "mixed" ||
    page.blocks.some((block) => block.recognitionConfidence !== undefined);
}

function mergeRecognizedPage(
  sourcePage: SourcePage,
  recognizedPage: SourcePage,
  characterMappingEvidence?: CharacterMappingEvidence[],
  characterCorrections: Readonly<Record<string, string>> = {},
): SourcePage {
  if (sourcePage.blocks.length === 0) {
    return {
      ...recognizedPage,
      blocks: recognizedPage.blocks.filter((block) =>
        !isMarginalPageNumber(block.rawText, block.x, block.y, sourcePage.width, sourcePage.height, sourcePage.pageNumber),
      ),
      textSource: "ocr",
      recognitionVersion: OCR_RECOGNITION_VERSION,
    };
  }

  const availableLines = recognizedPage.blocks.filter((block) =>
    !isMarginalPageNumber(block.rawText, block.x, block.y, sourcePage.width, sourcePage.height, sourcePage.pageNumber),
  );
  let replacedBlockCount = 0;
  const matchTolerance = sourceBlockMatchTolerance(sourcePage);
  const blocks = sourcePage.blocks.map((sourceBlock) => {
    if (
      sourceBlock.recognitionConfidence !== undefined ||
      findUnusualCharacters([sourceBlock], {}).length === 0
    ) return sourceBlock;

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    availableLines.forEach((line, index) => {
      if (line.recognitionConfidence === undefined || line.recognitionConfidence < 20) return;
      if (!isSafeRecognitionMatch(sourcePage, sourceBlock, line, matchTolerance)) return;
      const distance = sourcePage.direction === "vertical"
        ? Math.abs(sourceBlock.x - line.x)
        : Math.abs(sourceBlock.y - line.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    if (bestIndex < 0 || bestDistance > matchTolerance) return sourceBlock;

    const recognizedBlock = availableLines.splice(bestIndex, 1)[0];
    if (!recognizedBlock) return sourceBlock;
    replacedBlockCount += 1;
    const correctedSourceBlock = applyCharacterCorrections([sourceBlock], characterCorrections)[0] ?? sourceBlock;
    const sourceSpeakerLabel = correctedSourceBlock.speakerLabel ??
      cueAtStart(correctedSourceBlock.text, recoveredOpeningMarkers, usableRoleCandidates())?.name ??
      (startsWithUnreadableCharacter(correctedSourceBlock.text) ? recognizedBlock.speakerLabel : undefined);
    const speakerLabel = sourceSpeakerLabel;
    const sourceText = !correctedSourceBlock.speakerLabel && sourceSpeakerLabel &&
      correctedSourceBlock.text.startsWith(sourceSpeakerLabel)
      ? correctedSourceBlock.text.slice(sourceSpeakerLabel.length).trimStart()
      : correctedSourceBlock.text;
    const recognizedTextSource = sourceSpeakerLabel && recognizedBlock.speakerLabel
      ? recognizedBlock.text
      : recognizedBlock.rawText;
    const normalizedRecognizedText = normalizeScriptPunctuation(recognizedTextSource, speakerLabel);
    const recognizedText = normalizeScriptText(sourceSpeakerLabel
      ? stripDuplicateSpeakerCue(normalizedRecognizedText, sourceSpeakerLabel, recoveredOpeningMarkers)
      : normalizedRecognizedText);
    const onCharacterMapping = characterMappingEvidence &&
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
    const mergedTextWithCue = mergeReadableSourceText(
      sourceText,
      recognizedText,
      onCharacterMapping,
      characterCorrections,
    );
    const mergedText = normalizeScriptText(speakerLabel
      ? stripDuplicateSpeakerCue(mergedTextWithCue, speakerLabel, recoveredOpeningMarkers)
      : mergedTextWithCue);
    const mergedRawText = normalizeScriptText(speakerLabel
      ? `${speakerLabel}${mergedTextWithCue}`
      : mergeReadableSourceText(
          correctedSourceBlock.rawText,
          normalizeScriptPunctuation(recognizedBlock.rawText, speakerLabel),
          undefined,
          characterCorrections,
        ));

    return {
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
      ...(sourceBlock.speakerAliases
        ? { speakerAliases: sourceBlock.speakerAliases }
        : {}),
    };
  });

  if (replacedBlockCount === 0) return sourcePage;
  return {
    ...sourcePage,
    blocks,
    textSource: "mixed",
    recognitionVersion: OCR_RECOGNITION_VERSION,
  };
}

function sourceBlockMatchTolerance(page: SourcePage): number {
  const positions = page.blocks.map((block) =>
    page.direction === "vertical" ? block.x : block.y,
  ).sort((a, b) => a - b);
  const gaps = positions.slice(1)
    .map((position, index) => position - (positions[index] ?? position))
    .filter((gap) => gap > 0);
  const typicalGap = median(gaps);
  const typicalFontSize = median(page.blocks.map((block) => block.fontSize ?? 0).filter((size) => size > 0));
  const fontTolerance = Math.max(4, typicalFontSize * 1.25);
  return typicalGap > 0 ? Math.min(fontTolerance, typicalGap * 0.48) : fontTolerance;
}

function isSafeRecognitionMatch(
  page: SourcePage,
  sourceBlock: SourceBlock,
  recognizedBlock: SourceBlock,
  matchTolerance: number,
): boolean {
  if (sourceBlock.recognitionConfidence !== undefined) return false;

  const sourcePosition = page.direction === "vertical" ? sourceBlock.x : sourceBlock.y;
  const recognizedPosition = page.direction === "vertical" ? recognizedBlock.x : recognizedBlock.y;
  if (Math.abs(sourcePosition - recognizedPosition) > matchTolerance) return false;

  const bounds = recognizedBlock.recognitionBounds;
  if (bounds) {
    const crossAxisSpan = page.direction === "vertical"
      ? bounds.xMax - bounds.xMin
      : bounds.yMax - bounds.yMin;
    const sourceFontSize = Math.max(sourceBlock.fontSize ?? 0, 1);
    const pagePositions = page.blocks.map((block) =>
      page.direction === "vertical" ? block.x : block.y,
    ).sort((a, b) => a - b);
    const gaps = pagePositions.slice(1)
      .map((position, index) => position - (pagePositions[index] ?? position))
      .filter((gap) => gap > 0);
    const typicalGap = median(gaps);
    const maximumCrossAxisSpan = typicalGap > 0
      ? Math.min(sourceFontSize * 2, typicalGap * 0.82)
      : sourceFontSize * 1.8;
    if (crossAxisSpan > maximumCrossAxisSpan) return false;
  }

  const sourceSpeaker = sourceBlock.speakerLabel ?? cueAtStart(sourceBlock.text, recoveredOpeningMarkers, usableRoleCandidates())?.name;
  const recognizedSpeaker = recognizedBlock.speakerLabel ?? cueAtStart(recognizedBlock.text, recoveredOpeningMarkers, usableRoleCandidates())?.name;
  if (
    sourceSpeaker &&
    recognizedSpeaker &&
    speakerLabelKey(sourceSpeaker) !== speakerLabelKey(recognizedSpeaker)
  ) {
    const sourceKey = normalizeAlias(sourceSpeaker);
    const recognizedKey = normalizeAlias(recognizedSpeaker);
    const extraCharacter = Array.from(recognizedKey.slice(sourceKey.length));
    const hasOneCjkOcrSuffix = recognizedKey.startsWith(sourceKey) &&
      extraCharacter.length === 1 &&
      /^\p{Script=Han}$/u.test(extraCharacter[0] ?? "");
    if (
      !hasOneCjkOcrSuffix &&
      !isOneLatinHanSuffixOcrConfusion(
        sourceSpeaker,
        recognizedSpeaker,
        recognizedBlock.recognitionConfidence ?? 0,
      )
    ) return false;
  }

  return true;
}

function speakerLabelKey(value: string): string {
  const members = value.split(/[、,，・&＆/／\u3400-\u4dbf]/u).map((member) => normalizeAlias(member));
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
  const hasJapaneseBase = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sourceBase);
  const sourceIsLatin = /^[\p{Script=Latin}\p{Number}]$/u.test(sourceSuffix);
  const recognizedIsLatin = /^[\p{Script=Latin}\p{Number}]$/u.test(recognizedSuffix);
  const sourceIsHan = /^\p{Script=Han}$/u.test(sourceSuffix);
  const recognizedIsHan = /^\p{Script=Han}$/u.test(recognizedSuffix);

  return hasJapaneseBase && sourceBase === recognizedBase &&
    ((sourceIsLatin && recognizedIsHan) || (sourceIsHan && recognizedIsLatin));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function selectedRole(): RoleCandidate | undefined {
  return state.roles.find((role) => role.id === state.selectedRoleId);
}

function renderApp(): void {
  const previousCanvas = root.querySelector<HTMLCanvasElement>("#page-canvas");
  const previousCanvasKey = previousCanvas?.dataset.renderKey;
  const previousCanvasScroll = {
    left: previousCanvas?.parentElement?.scrollLeft ?? 0,
    top: previousCanvas?.parentElement?.scrollTop ?? 0,
  };
  const editorIds = ["manual-boundary-editor", "manual-glyph-editor"];
  const openEditors = editorIds.filter((id) => root.querySelector<HTMLDetailsElement>(`#${id}`)?.open);
  const previousEditorScroll = root.querySelector<HTMLTextAreaElement>("#full-script-editor")?.scrollTop ?? 0;
  const previousExtractedScroll = root.querySelector<HTMLElement>(".extracted-lines")?.scrollTop ?? 0;
  const previousPage = state.screen === "practice" ? state.originalPage : state.previewPage;
  const previousScreen = root.dataset.screen;
  const previousScroll = { left: window.scrollX, top: window.scrollY };
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusTarget = activeElement && root.contains(activeElement)
    ? {
        id: activeElement.id,
        action: activeElement.dataset.action,
        roleId: activeElement.dataset.roleId,
        blockId: activeElement.dataset.blockId,
      }
    : null;

  root.innerHTML = [renderTopbar(), renderScreen(), renderNotification()].join("");
  for (const id of openEditors) {
    const editor = root.querySelector<HTMLDetailsElement>(`#${id}`);
    if (editor) editor.open = true;
  }
  const textEditor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  scriptEditorResizeObserver.disconnect();
  if (textEditor) {
    textEditor.scrollTop = previousEditorScroll;
    scriptEditorResizeObserver.observe(textEditor);
    syncEditorHighlights();
  }
  root.querySelector("main")?.toggleAttribute("inert", state.practiceSaveBusy);
  root.dataset.screen = state.loading ? "loading" : state.screen;
  const requestedPage = state.screen === "practice" ? state.originalPage : state.previewPage;
  const newCanvas = root.querySelector<HTMLCanvasElement>("#page-canvas");
  const newCanvasContainer = newCanvas?.parentElement;
  const canReuseCanvas = Boolean(
    previousCanvas &&
    newCanvas &&
    previousCanvasKey === previewCanvasRenderKey(
      requestedPage,
      state.previewZoom,
      newCanvasContainer?.clientWidth ?? 0,
      window.devicePixelRatio || 1,
    ),
  );
  if (canReuseCanvas && previousCanvas && newCanvas) {
    newCanvas.replaceWith(previousCanvas);
    const container = previousCanvas.parentElement;
    if (container) {
      container.scrollLeft = previousCanvasScroll.left;
      container.scrollTop = previousCanvasScroll.top;
    }
  }

  if (previousScreen === state.screen && previousPage === requestedPage) {
    const extractedLines = root.querySelector<HTMLElement>(".extracted-lines");
    if (extractedLines) extractedLines.scrollTop = previousExtractedScroll;
  }
  window.scrollTo(previousScroll.left, previousScroll.top);

  if (focusTarget) {
    const selector = focusTarget.id
      ? `#${CSS.escape(focusTarget.id)}`
      : focusTarget.action
        ? `[data-action="${CSS.escape(focusTarget.action)}"]${focusTarget.roleId ? `[data-role-id="${CSS.escape(focusTarget.roleId)}"]` : ""}${focusTarget.blockId ? `[data-block-id="${CSS.escape(focusTarget.blockId)}"]` : ""}`
        : "";
    const replacement = selector ? root.querySelector<HTMLElement>(selector) : null;
    replacement?.focus({ preventScroll: true });
  }

  if (state.screen === "analysis" || (state.screen === "practice" && state.showOriginal)) {
    if (!canReuseCanvas) requestAnimationFrame(() => void renderPdfPreview());
  }
}

function previewCanvasRenderKey(pageNumber: number, zoom: number, width: number, pixelRatio: number): string {
  return `${pageNumber}:${zoom}:${Math.max(280, width - 28)}:${Math.min(2, pixelRatio)}`;
}

function goToPreviewPage(pageNumber: number): void {
  const nextPage = Math.max(1, Math.min(state.pages.length, pageNumber));
  if (nextPage === state.previewPage) return;
  state.previewPage = nextPage;

  renderApp();
}

function renderNotification(): string {
  if (state.practiceSaveBusy) {
    return `<div class="toast-notification toast-info toast-progress" role="status" aria-live="polite"><span class="toast-spinner" aria-hidden="true"></span><p>練習設定をこの端末内に保存しています。</p></div>`;
  }
  const notification = state.notification;
  if (!notification) return "";
  const role = notification.tone === "warning" ? "alert" : "status";
  return `<div class="toast-notification toast-${notification.tone}" role="${role}" aria-live="${notification.tone === "warning" ? "assertive" : "polite"}"><p>${escapeHtml(notification.message)}</p><button class="text-button toast-dismiss" data-action="dismiss-notification" aria-label="通知を閉じる">閉じる</button></div>`;
}

function renderTopbar(): string {
  const hasPdf = state.pages.length > 0;
  return `
    <header class="topbar">
      <span class="brand">
        <span class="brand-name">おぼえる台本</span>
      </span>
      <div class="topbar-right">
        ${hasPdf ? `<button class="secondary-button quiet-button close-script" data-action="close-pdf" ${state.loading || state.ocrBusy || state.practiceSaveBusy ? "disabled" : ""}>台本を閉じる</button>` : ""}
      </div>
    </header>`;
}

function renderScreen(): string {
  if (state.loading) return renderLoading();
  if (state.error && state.pages.length === 0) return renderLoadError();
  switch (state.screen) {
    case "analysis":
      return renderAnalysis();
    case "appearances":
      return renderAppearances();
    case "practice":
      return renderPractice();
    case "home":
    default:
      return renderHome();
  }
}

function renderHome(): string {
  const practiceFingerprints = new Set(state.savedPractices.map((reading) => reading.fingerprint));
  const recentItems = [
    ...state.savedPractices.map((reading) => ({ ...reading, kind: "practice" as const })),
    ...state.legacySavedReadings
      .filter((reading) => !practiceFingerprints.has(reading.fingerprint))
      .map((reading) => ({ ...reading, roleLabel: "", kind: "reading" as const })),
  ].sort((a, b) => b.savedAt - a.savedAt);
  return `
    <main class="home-page">
      <div class="home-grid">
        <section class="hero-copy">
          <h1><span>台本を開いて、</span><span>シーンごとに練習しよう</span></h1>
          <p class="hero-lead">前のセリフやト書きを読みながら、自分のセリフを思い出して答え合わせできます。</p>
        </section>
        <div class="upload-card" id="drop-zone">
          <p class="upload-label">台本PDFを開く</p>
          <p class="upload-description">「PDFを選ぶ」を押すか、ここに台本PDFをドロップしてください。</p>
          <input class="visually-hidden" type="file" id="pdf-input" accept="application/pdf,.pdf" />
          <button class="primary-button choose-button" data-action="choose-pdf">PDFを選ぶ</button>
          <p class="privacy-note">PDFはこの端末内で読み取り、サーバーには送信しません。練習を始めると、読み取り結果と練習設定をこの端末内にのみ保存します。</p>
        </div>
      </div>

      <section class="steps-strip" aria-labelledby="steps-heading">
        <h2 id="steps-heading">使い方</h2>
        <ol class="home-steps">
          <li>台本PDFを選ぶと、文字をブラウザ内で読み取ります。</li>
          <li>文字、読み順、セリフの区切り、役名を元のPDFと見比べ、必要に応じて直します。</li>
          <li>役を選び、「練習を始める」を押します。</li>
          <li>練習シーンを選び、前のセリフやト書きを読みます。</li>
          <li>自分のセリフを声に出してから「答えを確認する」を押します。自分のセリフの原文と次のセリフが表示されます。</li>
        </ol>
      </section>

      ${recentItems.length > 0 ? `<section class="recent-practices" aria-labelledby="saved-readings-heading">
        <div class="recent-practices-heading"><h2 id="saved-readings-heading">最近おぼえようとした台本</h2><button class="text-button" data-action="delete-all-saved-practices" aria-label="保存した練習設定と読み取り結果をすべて削除">すべて削除</button></div>
        <ul class="recent-practices-list">${recentItems.map((reading) => `<li class="recent-practices-item"><span><strong>${escapeHtml(reading.fileName || "ファイル名未登録")}</strong><small>${reading.kind === "practice" ? `練習する役：${escapeHtml(reading.roleLabel)} · ${reading.pageCount}ページ` : `${reading.pageCount}ページ · 練習設定は未保存`}</small></span><div class="recent-practices-actions"><button class="${reading.kind === "practice" ? "primary-button" : "secondary-button"}" data-action="${reading.kind === "practice" ? "resume-saved-practice" : "open-saved-reading"}" data-fingerprint="${escapeHtml(reading.fingerprint)}">${reading.kind === "practice" ? "PDFを選んで練習を再開する" : "PDFを選んで設定を作る"}</button><button class="text-button" data-action="delete-saved-practice-from-home" data-fingerprint="${escapeHtml(reading.fingerprint)}">削除</button></div></li>`).join("")}</ul>
      </section>` : ""}

    </main>
    <footer class="home-footer">
      <a href="${import.meta.env.BASE_URL}licenses.html">利用・保存とライセンス</a>
    </footer>`;
}

function renderLoading(): string {
  const restoringPractice = state.loadingPurpose === "restoring-practice";
  return `
    <main class="narrow-page loading-page">
      <h1>${restoringPractice ? "練習設定を復元しています" : "PDFを読み取っています"}</h1>
      <p>${restoringPractice ? "前回の役と練習範囲を復元しています。" : "ページ数によっては、少し時間がかかることがあります。"}</p>
      <div class="progress-shell"><div class="progress-bar" id="load-progress-bar" style="width:${state.progress}%"></div></div>
      <p class="progress-copy" id="load-progress-label">${escapeHtml(state.progressLabel || (restoringPractice ? "練習設定を復元しています" : "準備しています"))}</p>
    </main>`;
}

function renderLoadError(): string {
  return `
    <main class="narrow-page error-page">
      <h1>PDFを読み取れませんでした</h1>
      <p>${escapeHtml(state.error)}</p>
      <button class="primary-button" data-action="go-home">PDFを選び直す</button>
    </main>`;
}

function renderStepHeader(heading: string, description: string): string {
  return `
    <div class="step-heading">
      <div><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(description)}</p></div>
    </div>`;
}

function renderAnalysis(): string {
  const textBlocks = blocks();
  const characterCount = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
  const allGlyphs = findUnusualCharacters(rawBlocks(), {
    ...inferredMarkerCorrections(),
    ...state.corrections,
  });
  const ocrPageCount = state.pages.filter(isOcrRecognizedPage).length;
  const currentPage = state.pages[state.previewPage - 1];
  const foundTurns = turns();
  const selectedTurnCount = foundTurns.filter((turn) => turn.roleId === state.selectedRoleId).length;
  const enoughText = hasEnoughText(textBlocks);
  const blocksById = new Map(textBlocks.map((block) => [block.id, block]));
  const frequentRoles = state.roles.filter((role) => role.manual || role.occurrenceCount >= 2);
  const occasionalRoles = state.roles.filter((role) => !role.manual && role.occurrenceCount < 2);
  const canContinue = Boolean(
    state.selectedRoleId &&
      selectedTurnCount > 0 &&
      !state.ocrBusy &&
      !state.layoutPreview &&
      !state.textOcrPreview &&
      !state.practiceSaveBusy,
  );

  return `
    <main class="work-page analysis-page">
      ${renderStepHeader("読み取り結果を確認する", "元のPDFと見比べて文字や区切りを直し、練習する役を選びます。")}
      <section class="file-summary-panel">
        <div class="file-summary-copy"><span class="small-label">開いている台本</span><strong>${escapeHtml(state.fileName)}</strong><p>練習を始めると、読み取り結果と練習設定をこの端末内にのみ保存します。サーバーには送信しません。</p></div>
        <div class="file-summary-stats"><span>${state.pages.length}ページ</span><span>${characterCount.toLocaleString("ja-JP")}文字</span></div>
      </section>

      ${!enoughText ? `<div class="alert alert-warning notice-box" role="alert"><strong>PDFから文字を読み取れませんでした。</strong><p>「文字の置換」の画像解析で、読めなかった文字を補えます。</p></div>` : ""}

      ${renderReadingWarning(allGlyphs, ocrPageCount)}

      <section class="panel source-review-panel" id="source-review">
        <div class="panel-heading"><div><h2>元のPDFと読み取り結果</h2><p>ページを切り替えて、対応する箇所を見比べられます。</p></div></div>
        <div class="source-toolbar">
          <div class="page-navigation" aria-label="PDFのページ移動">
            <button class="secondary-button page-step-button" data-action="previous-preview-page" aria-label="前のページ" title="前のページ" ${state.previewPage <= 1 ? "disabled" : ""}><span aria-hidden="true">←</span></button>
            <label class="select-field"><span>表示するページ</span><select class="select-input" id="preview-page-select">${state.pages.map((page) => `<option value="${page.pageNumber}" ${page.pageNumber === state.previewPage ? "selected" : ""}>${page.pageNumber}ページ目</option>`).join("")}</select></label>
            <button class="secondary-button page-step-button" data-action="next-preview-page" aria-label="次のページ" title="次のページ" ${state.previewPage >= state.pages.length ? "disabled" : ""}><span aria-hidden="true">→</span></button>
          </div>
          <div class="zoom-controls"><button class="zoom-button secondary-button" data-action="zoom-out" aria-label="元のPDFを縮小">−</button><span>${Math.round(state.previewZoom * 100)}%</span><button class="zoom-button secondary-button" data-action="zoom-in" aria-label="元のPDFを拡大">＋</button></div>
        </div>
        <div class="source-compare-grid">
          <div class="pdf-preview-card"><span class="preview-label">元のPDF</span><div class="pdf-canvas-scroll"><canvas id="page-canvas" aria-label="元のPDFのページ"></canvas></div></div>
          <div class="extracted-page-card"><span class="preview-label">読み取り結果</span><div class="extracted-lines">${renderPageBlocks(state.previewPage)}</div></div>
        </div>
        ${currentPage && isOcrRecognizedPage(currentPage) ? `
          <div class="image-analysis-actions">
            <button class="text-button" data-action="restore-preview-page-text" ${state.ocrBusy || state.layoutPreview ? "disabled" : ""}>このページをPDFからの読み取り結果に戻す</button>
          </div>` : ""}
        <p class="panel-footnote">セリフは発話ごとにまとめ、位置はページ番号と列・行の番号で示します。</p>
      </section>

      ${renderCorrectionPanel(findUnusualCharacters(rawBlocks(), inferredMarkerCorrections()))}
      ${renderLayoutAdjustment()}

      <section class="panel role-panel">
        <div class="panel-heading">
          <div><span class="small-label">自分の役を選ぶ</span><h2>役名の候補</h2><p>候補から練習する役を選びます。同じ役の別表記を登録したり、見つからなかった役を追加したりできます。</p></div>
          <span class="count-pill">候補 ${state.roles.length}件</span>
        </div>
        ${frequentRoles.length > 0 ? `<div class="role-grid">${frequentRoles.map((role) => renderRoleCard(role, foundTurns, blocksById)).join("")}</div>` : `<div class="empty-state"><strong>2回以上見つかった役名はありません</strong><p>1回だけ見つかった役名を確認するか、役名を追加してください。「区切りの調整」でセリフに役を指定できます。</p></div>`}
        ${occasionalRoles.length > 0 ? `<details class="occasional-role-details"><summary>1回だけ見つかった役名を確認する（${occasionalRoles.length}件）</summary><p>セリフの一部を役名として読み取っている場合があります。元のPDFと見比べて選んでください。</p><div class="role-grid">${occasionalRoles.map((role) => renderRoleCard(role, foundTurns, blocksById)).join("")}</div></details>` : ""}

        <details class="manual-role-details">
          <summary>見つからない役を追加する</summary>
          <div class="manual-role-form">
            <label>画面に表示する役名<input class="text-input" id="new-role-label" type="text" placeholder="例：役名" maxlength="24" /></label>
            <label>台本での役名<input class="text-input" id="new-role-alias" type="text" placeholder="同じ名前でよければ空欄で構いません" maxlength="48" /></label>
            <button class="secondary-button" data-action="add-role">役名を追加</button>
          </div>
        </details>
      </section>

      <div class="sticky-action-bar">
        <p>${state.selectedRoleId ? selectedTurnCount > 0 ? `「${escapeHtml(selectedRole()?.label ?? "")}」のセリフを ${selectedTurnCount}件見つけました。` : `「${escapeHtml(selectedRole()?.label ?? "")}」のセリフを見つけられませんでした。「区切りの調整」で、セリフが始まる位置と役を指定してください。` : "練習する役を選んでください。"}</p>
        <button class="primary-button" data-action="continue-to-appearances" ${!canContinue || state.practiceSaveBusy ? "disabled" : ""}>${state.practiceHasStarted ? "練習を再開する" : "練習を始める"}</button>
      </div>
    </main>`;
}

function renderReadingWarning(
  glyphs: ReturnType<typeof findUnusualCharacters>,
  ocrPageCount: number,
): string {
  if (glyphs.length === 0 && ocrPageCount === 0) return "";
  const occurrenceCount = glyphs.reduce((sum, entry) => sum + entry.count, 0);
  return `
    <section class="alert alert-warning correction-warning" role="alert" aria-labelledby="correction-warning-heading">
      <h2 id="correction-warning-heading" class="correction-warning-title">読み取り結果を確認してください</h2>
      <p class="correction-warning-description">${glyphs.length > 0 ? `${occurrenceCount.toLocaleString("ja-JP")}か所に、元のPDFと異なる文字が含まれている可能性があります。` : "画像解析で読み直したページがあります。読み順や役名を元のPDFと見比べてください。"}</p>
    </section>`;
}

function renderImageAnalysisProgress(purpose: AppState["ocrPurpose"]): string {
  return state.ocrBusy && state.ocrPurpose === purpose ? `
    <div class="image-analysis-progress" role="status">
      <p id="image-analysis-progress-label" aria-live="polite">${escapeHtml(state.ocrStatus || "画像解析の準備をしています")}</p>
      <div class="image-analysis-progress-meter">
        <div class="progress-shell" role="progressbar" aria-label="画像解析の進捗" aria-valuemin="0" aria-valuemax="${state.ocrTotal}" aria-valuenow="${state.ocrProgress}">
          <div class="progress-bar" id="image-analysis-progress-bar" style="width:${state.ocrTotal ? Math.round((state.ocrProgress / state.ocrTotal) * 100) : 0}%"></div>
        </div>
        <span id="image-analysis-progress-count" aria-hidden="true">処理済み ${state.ocrProgress} / ${state.ocrTotal}ページ</span>
      </div>
      <button class="text-button" data-action="cancel-ocr">画像解析を中止する</button>
    </div>` : "";
}

interface ScriptEditorSpan {
  block: SourceBlock;
  start: number;
  end: number;
  prefixLength: number;
  speakerLength: number;
  roleId?: string;
}

function scriptEditorModel(): { text: string; spans: ScriptEditorSpan[]; breaks: Set<number> } {
  const sourceBlocks = blocks();
  const starts = new Map(turns().map((turn) => [turn.startIndex, turn.roleId]));
  const spans: ScriptEditorSpan[] = [];
  const breaks = new Set<number>();
  let text = "";
  let plainOffset = 0;
  let currentRole: string | undefined;
  sourceBlocks.forEach((block, index) => {
    if (block.isSpeakerSuffix || (!block.text && !block.speakerLabel)) return;
    if (starts.has(index)) {
      if (text) {
        text += "\n";
        breaks.add(plainOffset);
      }
      currentRole = starts.get(index);
    }
    const prefix = block.speakerLabel ?? "";
    const content = prefix + block.text;
    const role = state.roles.find((candidate) => candidate.id === starts.get(index));
    const speakerLength = starts.has(index)
      ? prefix.length || role?.aliases.find((alias) => content.startsWith(alias))?.length || 0
      : 0;
    spans.push({
      block,
      start: plainOffset,
      end: plainOffset + content.length,
      prefixLength: prefix.length,
      speakerLength,
      roleId: currentRole,
    });
    text += content;
    plainOffset += content.length;
  });
  return { text, spans, breaks };
}

function renderEditorHighlights(text: string, model: ReturnType<typeof scriptEditorModel>): string {
  if (text.replace(/\n/g, "") !== model.text.replace(/\n/g, "")) return escapeHtml(text);
  const labels = new Map(model.spans.filter((span) => span.speakerLength > 0)
    .map((span) => [span.start, span.speakerLength]));
  const parts: string[] = [];
  let plainOffset = 0;
  let unmarkedStart = 0;
  let index = 0;
  while (index < text.length) {
    const labelLength = text[index] === "\n" ? undefined : labels.get(plainOffset);
    if (labelLength) {
      parts.push(escapeHtml(text.slice(unmarkedStart, index)));
      const start = index;
      let remaining = labelLength;
      while (index < text.length && remaining > 0) {
        if (text[index] !== "\n") {
          remaining -= 1;
          plainOffset += 1;
        }
        index += 1;
      }
      parts.push(`<mark class="inline-role-highlight">${escapeHtml(text.slice(start, index))}</mark>`);
      unmarkedStart = index;
    } else {
      if (text[index] !== "\n") plainOffset += 1;
      index += 1;
    }
  }
  parts.push(escapeHtml(text.slice(unmarkedStart)));
  return parts.join("") + "\n";
}

function syncEditorHighlights(): void {
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  const highlights = root.querySelector<HTMLElement>("#full-script-highlights");
  const content = highlights?.firstElementChild;
  if (!editor || !highlights || !(content instanceof HTMLElement)) return;
  content.style.width = `${editor.clientWidth}px`;
  highlights.scrollTop = editor.scrollTop;
  highlights.scrollLeft = editor.scrollLeft;
}

const scriptEditorResizeObserver = new ResizeObserver(syncEditorHighlights);

function hideScriptSelectionToolbar(): void {
  const toolbar = root.querySelector<HTMLElement>("#script-selection-toolbar");
  if (toolbar) toolbar.hidden = true;
}

function showScriptSelectionToolbar(point?: { x: number; y: number }): void {
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  const toolbar = root.querySelector<HTMLElement>("#script-selection-toolbar");
  const label = root.querySelector<HTMLElement>("#script-selection-label");
  if (!editor || !toolbar || !label || state.ocrBusy) return;
  const model = scriptEditorModel();
  if (editor.selectionStart === editor.selectionEnd) {
    const plainOffset = editor.value.slice(0, editor.selectionStart).replace(/\n/g, "").length;
    const span = model.spans.find((item) => item.speakerLength > 0 &&
      plainOffset >= item.start && plainOffset < item.start + item.speakerLength);
    if (span) {
      let offset = 0;
      let start = 0;
      while (start < editor.value.length && offset < span.start) {
        if (editor.value[start] !== "\n") offset += 1;
        start += 1;
      }
      while (editor.value[start] === "\n") start += 1;
      editor.setSelectionRange(start, start + span.speakerLength);
    }
  }
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (!selected || selected.includes("\n") || !isPlausibleSpeakerLabel(selected)) {
    hideScriptSelectionToolbar();
    return;
  }
  const plainStart = editor.value.slice(0, editor.selectionStart).replace(/\n/g, "").length;
  const selectedSpeaker = model.spans.find((span) => span.start === plainStart &&
    span.speakerLength === selected.length && span.speakerLength > 0);
  const removeButton = toolbar.querySelector<HTMLButtonElement>('[data-action="unassign-selected-speaker"]');
  if (removeButton) removeButton.hidden = !selectedSpeaker;
  label.textContent = `「${selected}」`;
  toolbar.hidden = false;
  const bounds = editor.getBoundingClientRect();
  const toolbarBounds = toolbar.getBoundingClientRect();
  const x = point?.x ?? bounds.left + 12;
  const y = point?.y ?? Math.max(12, bounds.top) + 48;
  toolbar.style.left = `${Math.max(8, Math.min(x, window.innerWidth - toolbarBounds.width - 8))}px`;
  toolbar.style.top = `${Math.max(8, Math.min(y + 12, window.innerHeight - toolbarBounds.height - 8))}px`;
}

function unassignSelectedSpeaker(): void {
  if (state.ocrBusy) return;
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  const plainStart = editor.value.slice(0, editor.selectionStart).replace(/\n/g, "").length;
  const model = scriptEditorModel();
  const span = model.spans.find((item) => item.start === plainStart && item.speakerLength > 0 &&
    editor.selectionEnd - editor.selectionStart === item.speakerLength);
  if (!span) return;
  state.boundaryEdits = setBoundaryEdit(state.boundaryEdits, editorPosition(span, span.start), null);
  state.ranges = {};
  state.currentTargetIndex = 0;
  boundaryDraft = null;
  const scroll = editor.scrollTop;
  renderApp();
  const updated = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (updated) updated.scrollTop = scroll;
}

function renderBoundaryEditor(): string {
  const model = scriptEditorModel();
  if (boundaryDraft && boundaryDraft.source !== model.text) {
    boundaryDraft = null;
    notify("読み取り結果が変わったため、未反映の改行を元に戻しました。", "info");
  }
  const text = boundaryDraft?.text ?? model.text;
  return `
    <p class="panel-footnote">Enterでセリフを分け、改行を消すとつながります。役名はドラッグして指定し、背景色の付いた役名はクリックして解除できます。</p>
    <label class="script-editor-label" for="full-script-editor">台本の全文</label>
    <div class="script-editor-surface">
      <div id="full-script-highlights" class="full-script-highlights" aria-hidden="true"><div class="script-editor-highlight-content">${renderEditorHighlights(text, model)}</div></div>
      <textarea class="text-input full-script-editor" id="full-script-editor" spellcheck="false" ${state.ocrBusy ? "disabled" : ""}>${escapeHtml(text)}</textarea>
    </div>
    <div id="script-selection-toolbar" class="script-selection-toolbar" role="toolbar" aria-label="選択した文字の役名設定" hidden>
      <strong id="script-selection-label"></strong>
      <button class="primary-button" data-action="assign-selected-speaker">役名にする</button>
      <button class="secondary-button" data-action="unassign-selected-speaker" hidden>役名を解除</button>
    </div>
  `;
}

function editorPosition(span: ScriptEditorSpan, plainOffset: number): Omit<BoundaryEdit, "roleId"> {
  const localOffset = plainOffset - span.start;
  const origin = span.block.boundaryOrigin;
  const offset = Math.max(0, localOffset - span.prefixLength) +
    (localOffset >= span.prefixLength ? origin?.labelLength ?? 0 : 0);
  return {
    blockId: origin?.blockId ?? span.block.id,
    text: origin?.text ?? span.block.text,
    offset: (origin?.offset ?? 0) + offset,
  };
}

function setBoundaryEdit(edits: BoundaryEdit[], position: Omit<BoundaryEdit, "roleId">, roleId: string | null): BoundaryEdit[] {
  const remaining = edits.filter((edit) => edit.blockId !== position.blockId || edit.offset !== position.offset);
  return roleId || position.offset === 0 ? [...remaining, { ...position, roleId }] : remaining;
}

function showScriptEditorError(message: string): void {
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  editor.setCustomValidity(message);
  editor.reportValidity();
}

function applyScriptEditor(assignSpeaker: boolean): void {
  if (state.ocrBusy) return;
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  editor.setCustomValidity("");
  const model = scriptEditorModel();
  const plain = editor.value.replace(/\n/g, "");
  if (plain !== model.text.replace(/\n/g, "")) {
    showScriptEditorError("ここでは改行を追加・削除できます。本文の文字を元に戻してから適用してください。");
    return;
  }
  const wantedBreaks = new Set<number>();
  let offset = 0;
  for (const character of editor.value) {
    if (character === "\n") wantedBreaks.add(offset);
    else offset += character.length;
  }
  const findSpan = (position: number) => model.spans.find((span) => position >= span.start && position < span.end);
  let edits = [...state.boundaryEdits];
  for (const position of new Set([...model.breaks, ...wantedBreaks])) {
    if (model.breaks.has(position) === wantedBreaks.has(position) || position === 0 || position === plain.length) continue;
    const span = findSpan(position);
    if (!span) continue;
    if (position > span.start && position < span.start + span.prefixLength) {
      showScriptEditorError("役名の途中には改行を入れられません。");
      return;
    }
    const location = editorPosition(span, position);
    if (wantedBreaks.has(position)) {
      const roleId = span.roleId || state.selectedRoleId;
      if (!roleId) {
        showScriptEditorError("練習する役を選んでから改行してください。");
        return;
      }
      edits = setBoundaryEdit(edits, location, roleId);
    } else {
      edits = setBoundaryEdit(edits, location, null);
    }
  }

  if (assignSpeaker) {
    const start = editor.value.slice(0, editor.selectionStart).replace(/\n/g, "").length;
    const end = editor.value.slice(0, editor.selectionEnd).replace(/\n/g, "").length;
    const label = plain.slice(start, end);
    const span = findSpan(start);
    if (!span || !label || label !== label.trim() || !isPlausibleSpeakerLabel(label) || end > span.end) {
      showScriptEditorError("役名の文字だけを選択してください。");
      return;
    }
    const withinPrefix = start === span.start && end === span.start + span.prefixLength;
    if (start < span.start + span.prefixLength && !withinPrefix) {
      showScriptEditorError("役名は一部ではなく、名前全体を選択してください。");
      return;
    }
    let role = state.roles.find((candidate) =>
      candidate.aliases.some((alias) => normalizeAlias(alias) === normalizeAlias(label)));
    if (!role) {
      state.manualRoleNumber += 1;
      role = { id: `manual-${slug(label)}-${state.manualRoleNumber}`, label, aliases: [label], occurrenceCount: 0, exampleBlockIds: [], manual: true, evidence: "manual" };
      state.roles.push(role);
    } else if (!role.aliases.includes(label)) {
      role.aliases = [...role.aliases, label];
    }
    const location = editorPosition(span, start);
    edits = setBoundaryEdit(edits, { ...location, ...(!withinPrefix || span.block.boundaryOrigin?.labelLength ? { speakerText: label } : {}) }, role.id);
  }
  state.boundaryEdits = edits;
  state.ranges = {};
  state.currentTargetIndex = 0;
  boundaryDraft = null;
  const caret = editor.selectionStart;
  const scrollTop = editor.scrollTop;
  renderApp();
  const updated = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (updated) {
    updated.focus({ preventScroll: true });
    updated.setSelectionRange(Math.min(caret, updated.value.length), Math.min(caret, updated.value.length));
    updated.scrollTop = scrollTop;
  }
}

function renderLayoutAdjustment(): string {
  const previews = state.layoutPreview;
  const preview = previews?.find((page) => page.pageNumber === state.previewPage) ?? previews?.[0];
  return `
    <section class="panel layout-adjustment-panel" aria-labelledby="layout-adjustment-heading">
      <div class="panel-heading"><div><h2 id="layout-adjustment-heading">区切りの調整</h2><p>セリフを分ける位置や、話す役を調整します。</p></div></div>
      <div class="image-analysis-section">
        <h3 class="adjustment-mode-title"><span>おすすめ</span>画像解析して調整する</h3>
        <p class="panel-footnote">全ページを画像解析し、読み順やセリフの区切りを判定し直します。</p>
        <div class="image-analysis-actions">
          <button class="secondary-button" data-action="preview-ocr-layout" ${state.ocrBusy || preview || state.ocrAnalysisComplete ? "disabled" : ""}>${state.ocrAnalysisComplete ? "画像解析は完了しました" : "画像解析する"}</button>
          ${state.ocrAnalysisComplete && !preview ? `<button class="text-button" data-action="preview-ocr-layout" ${state.ocrBusy ? "disabled" : ""}>解析結果を確認する</button>` : ""}
        </div>
        <p class="panel-footnote">画像解析はこの端末内で行い、PDFや読み取り結果をサーバーに送信しません。</p>
        ${renderImageAnalysisProgress("layout")}
        ${preview && previews ? `
          <div class="layout-ocr-preview">
            <h3>画像解析の結果（${previews.length}ページ）</h3>
            <label class="select-field"><span>表示するページ</span><select class="select-input" id="layout-ocr-page-select">${previews.map((page) =>
              `<option value="${page.pageNumber}" ${page === preview ? "selected" : ""}>${page.pageNumber}ページ目</option>`,
            ).join("")}</select></label>
            <p>元のPDFと見比べ、読み順や役名を確認してから適用してください。</p>
            <div class="layout-preview-lines">${renderPageBlocks(preview.pageNumber, preview)}</div>
            ${state.boundaryEdits.length ? "<p>結果を適用したページでは、手動で変更した区切りが解除されます。</p>" : ""}
            ${Object.keys(state.ranges).length ? "<p>適用すると、調整した練習範囲が初期設定に戻ります。</p>" : ""}
            <div class="image-analysis-actions">
              <button class="primary-button" data-action="apply-ocr-layout" ${state.ocrBusy ? "disabled" : ""}>結果を適用する（${previews.length}ページ）</button>
              <button class="text-button" data-action="discard-ocr-layout">適用せずに閉じる</button>
            </div>
          </div>` : ""}
        ${state.ocrErrors.layout ? `<div class="alert alert-warning image-analysis-error" role="alert">${escapeHtml(state.ocrErrors.layout)}</div>` : ""}
      </div>
      <details id="manual-boundary-editor" class="manual-adjustment">
        <summary>手動で調整する</summary>
        ${renderBoundaryEditor()}
      </details>
    </section>`;
}

function renderTextOcrPreview(): string {
  const preview = state.textOcrPreview;
  if (!preview) return "";
  const sourcePage = state.pages.find((page) => page.pageNumber === state.previewPage);
  const recognized = preview.pages.find((page) => page.pageNumber === sourcePage?.pageNumber) ?? preview.pages[0];
  const source = state.pages.find((page) => page.pageNumber === recognized?.pageNumber);
  if (!recognized || !source) return "";
  const corrections = { ...preview.corrections, ...state.corrections };
  const merged = mergeRecognizedPage(source, recognized, undefined, corrections);
  const displayed = { ...merged, blocks: applyCharacterCorrections(merged.blocks, corrections) };
  return `
    <div class="layout-ocr-preview">
      <h3>画像解析の結果（${preview.pages.length}ページ）</h3>
      <label class="select-field"><span>表示するページ</span><select class="select-input" id="text-ocr-page-select">${preview.pages.map((page) =>
        `<option value="${page.pageNumber}" ${page.pageNumber === recognized.pageNumber ? "selected" : ""}>${page.pageNumber}ページ目</option>`,
      ).join("")}</select></label>
      <p>上の読み取り結果と見比べてから適用してください。</p>
      <div class="layout-preview-lines">${renderPageBlocks(displayed.pageNumber, displayed)}</div>
      ${Object.keys(state.ranges).length ? "<p>適用すると、調整した練習範囲が初期設定に戻ります。</p>" : ""}
      <div class="image-analysis-actions">
        <button class="primary-button" data-action="apply-ocr-text" ${state.ocrBusy ? "disabled" : ""}>結果を適用する（${preview.pages.length}ページ）</button>
        <button class="text-button" data-action="discard-ocr-text">適用せずに閉じる</button>
      </div>
    </div>`;
}

function applyTextOcrPreview(): void {
  const preview = state.textOcrPreview;
  if (!preview || state.ocrBusy) return;
  const recognized = new Map(preview.pages.map((page) => [page.pageNumber, page]));
  const corrections = { ...preview.corrections, ...state.corrections };
  let replacedPages = 0;
  state.pages = state.pages.map((page) => {
    const result = recognized.get(page.pageNumber);
    if (!result) return page;
    const merged = mergeRecognizedPage(page, result, undefined, corrections);
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

function renderCorrectionPanel(glyphs: ReturnType<typeof findUnusualCharacters>): string {
  const unresolved = glyphs.filter((entry) => !state.corrections[entry.character]?.trim()).length;
  const savedCorrectionCount = Object.values(state.savedPractice?.settings.corrections ?? {}).filter((value) => value.trim()).length;
  const glyphRows = glyphs.map((entry) => {
    const block = rawBlocks().find((item) => item.id === entry.exampleBlockId);
    return `<article class="glyph-row"><div class="glyph-sample"><span class="glyph-character">${escapeHtml(entry.character)}</span><span class="glyph-count">${entry.count.toLocaleString("ja-JP")}回</span></div><div class="glyph-context"><span class="small-label">${entry.examplePage}ページ目の例</span><p>${escapeHtml(entry.example)}</p><button class="text-button" data-action="preview-block" data-block-id="${escapeHtml(entry.exampleBlockId)}">${block ? escapeHtml(blockPosition(block)) : `${entry.examplePage}ページ目`}を元のPDFで見る</button></div><label class="glyph-replacement">正しい文字<input class="text-input" type="text" maxlength="8" data-correction-char="${escapeHtml(entry.character)}" value="${escapeHtml(state.corrections[entry.character] ?? "")}" placeholder="PDFを見て入力" /></label></article>`;
  }).join("");
  return `
      <section class="panel glyph-panel" aria-labelledby="glyph-panel-heading">
        <div class="panel-heading"><div><h2 id="glyph-panel-heading">文字の置換</h2><p>文字化けや、誤って読み取られた文字を置き換えます。</p></div>${glyphs.length > 0 ? `<span class="count-pill">${glyphs.length}種類 · 未設定 ${unresolved}種類</span>` : ""}</div>
        <div class="image-analysis-section">
          <h3 class="adjustment-mode-title"><span>おすすめ</span>画像解析して置換する</h3>
          <p class="panel-footnote">全ページを画像解析し、文字化けや読み取れなかった箇所を補います。</p>
          <div class="image-analysis-actions">
            <button class="secondary-button" data-action="read-with-ocr" ${state.ocrBusy || state.textOcrPreview || state.textOcrCompletion || state.ocrAnalysisComplete ? "disabled" : ""}>${state.ocrAnalysisComplete ? "画像解析は完了しました" : "画像解析する"}</button>
            ${state.ocrAnalysisComplete && !state.textOcrPreview && !state.textOcrCompletion ? `<button class="text-button" data-action="read-with-ocr" ${state.ocrBusy ? "disabled" : ""}>解析結果を確認する</button>` : ""}
            ${state.cachedOcrPages.length > 0 ? `<button class="text-button" data-action="use-previous-image-analysis" ${state.ocrBusy || state.layoutPreview ? "disabled" : ""}>前回の画像解析結果を適用する（${state.cachedOcrPages.length}ページ）</button>` : ""}
          </div>
          <p class="panel-footnote">画像解析はこの端末内で行い、PDFや読み取り結果をサーバーに送信しません。</p>
          ${renderImageAnalysisProgress("text")}
          ${renderTextOcrPreview()}
          ${state.textOcrCompletion ? `
            <div class="image-analysis-completion" role="status">
              <strong>画像解析の結果を適用しました</strong>
              <p>${state.textOcrCompletion.pageCount}ページの解析結果を適用しました。${state.textOcrCompletion.replacedPages > 0 ? `${state.textOcrCompletion.replacedPages}ページの文字を置換しました。` : "置換した文字はありません。"}</p>
            </div>` : ""}
          ${state.ocrErrors.text ? `<div class="alert alert-warning image-analysis-error" role="alert">${escapeHtml(state.ocrErrors.text)}</div>` : ""}
        </div>
        <details id="manual-glyph-editor" class="manual-adjustment">
          <summary>手動で調整する</summary>
        ${savedCorrectionCount > 0 ? `<div class="saved-corrections-option"><p>前回の文字の置換（${savedCorrectionCount}種類）</p><button class="text-button" data-action="restore-saved-corrections">前回の文字の置換を適用する</button></div>` : ""}
        ${glyphs.length > 0 ? `<div class="glyph-list">${glyphRows}</div><p class="glyph-footnote">元のPDFと見比べ、正しい文字を入力してください。入力内容は読み取り結果と練習画面に反映されます。</p>` : `<p class="glyph-empty-state">手動で置換する候補はありません。</p>`}
        </details>
      </section>
  `;
}

function renderRoleCard(role: RoleCandidate, allTurns: SpeakerTurn[], blocksById: Map<string, SourceBlock>): string {
  const count = allTurns.filter((turn) => turn.roleId === role.id).length;
  const example = role.exampleBlockIds
    .map((id) => blocksById.get(id))
    .filter((block): block is SourceBlock => Boolean(block))
    .slice(0, 2);
  const selected = state.selectedRoleId === role.id;
  const evidenceLabel = role.manual
    ? "手動で追加"
    : role.evidence === "layout"
      ? "文字の配置から検出"
      : role.evidence === "recovered"
        ? "役名の表記を要確認"
        : "役名と記号から検出";
  return `
    <article class="role-card ${selected ? "role-card-selected" : ""}">
      <div class="role-card-top"><span class="role-badge">${evidenceLabel}${role.manual ? "" : ` · ${role.occurrenceCount}回`}</span><button class="secondary-button small-button remove-role-button" data-action="remove-role" data-role-id="${escapeHtml(role.id)}">候補から外す</button></div>
      <label class="field-label">画面に表示する役名<input class="text-input" type="text" data-role-label="${escapeHtml(role.id)}" value="${escapeHtml(role.label)}" maxlength="24" /></label>
      <label class="field-label">台本での役名（複数の表記は「、」で区切る）<input class="text-input" type="text" data-role-aliases="${escapeHtml(role.id)}" value="${escapeHtml(role.aliases.join("、"))}" maxlength="120" /></label>
      <div class="role-card-meta"><span>セリフ <strong>${count}件</strong></span>${example[0] ? `<button class="text-button" data-action="preview-block" data-block-id="${escapeHtml(example[0].id)}">元のPDFで例を見る · ${escapeHtml(blockPosition(example[0]))}</button>` : ""}</div>
      ${example.length > 1 ? `<p class="role-example">例：${escapeHtml(example[1].text.slice(0, 52))}${example[1].text.length > 52 ? "…" : ""}</p>` : ""}
      <button class="role-select-button ${selected ? "primary-button" : "secondary-button"}" data-action="select-role" data-role-id="${escapeHtml(role.id)}" aria-pressed="${selected}">${selected ? "選択中" : "この役を選ぶ"}</button>
    </article>`;
}

function renderPageBlocks(pageNumber: number, preview?: SourcePage): string {
  const page = preview ?? state.pages.find((candidate) => candidate.pageNumber === pageNumber);
  if (!page || page.blocks.length === 0) return `<p class="muted-copy">このページから文字を読み取れませんでした。</p>`;
  const sourceNote = !preview && isOcrRecognizedPage(page)
    ? `<p class="image-analysis-page-note">画像解析の結果を含みます。元のPDFと見比べてください。</p>`
    : "";
  const allBlocks = preview?.blocks ?? blocks();
  const pageBlocks = allBlocks.filter((block) => block.pageNumber === pageNumber);
  const blockIndexById = new Map(allBlocks.map((block, index) => [block.id, index]));
  const turnByBlockId = new Map<string, SpeakerTurn>();
  const turnStartsByBlockId = new Set<string>();
  for (const turn of preview ? [] : turns()) {
    const startBlock = allBlocks[turn.startIndex];
    if (startBlock) turnStartsByBlockId.add(startBlock.id);
    for (let index = turn.startIndex; index <= turn.endIndex; index += 1) {
      const block = allBlocks[index];
      if (block) turnByBlockId.set(block.id, turn);
    }
  }

  const groups: Array<{ blocks: SourceBlock[]; speech: boolean; standalone: boolean; turn?: SpeakerTurn }> = [];
  for (const block of pageBlocks) {
    const standalone = isCastListEntry(block);
    const startsSpeech = !standalone && block.boundaryRoleId !== null && Boolean(
      block.speakerLabel || cueAtStart(block.text, recoveredOpeningMarkers, usableRoleCandidates()) || turnStartsByBlockId.has(block.id),
    );
    const turn = standalone ? undefined : turnByBlockId.get(block.id);
    const previousGroup = groups[groups.length - 1];
    const previousBlock = previousGroup?.blocks
      .filter((candidate) => !candidate.isSpeakerSuffix)
      .at(-1);
    const shouldJoin = Boolean(
      !standalone &&
      !startsSpeech &&
      previousGroup &&
      !previousGroup.standalone &&
      previousBlock &&
      canJoinUnassignedPreviewBlocks(previousBlock, block, previousGroup.blocks.length, previousGroup.speech),
    );

    if (shouldJoin) {
      previousGroup?.blocks.push(block);
    } else {
      groups.push({
        blocks: [block],
        speech: startsSpeech,
        standalone,
        ...(turn ? { turn } : {}),
      });
    }
  }

  return sourceNote + groups.map((group) => {
    const visibleBlocks = group.blocks.filter((block) => !block.isSpeakerSuffix);
    const firstBlock = visibleBlocks[0] ?? group.blocks[0];
    const lastBlock = visibleBlocks[visibleBlocks.length - 1] ?? firstBlock;
    if (!firstBlock) return "";
    const hasText = visibleBlocks.some((block) => block.text.trim() || block.speakerLabel?.trim());
    const hasSuffix = group.blocks.some((block) => block.isSpeakerSuffix);
    if (!hasText && !hasSuffix) return "";
    const position = blockRangePosition(firstBlock, lastBlock);
    const firstIndex = blockIndexById.get(firstBlock.id);
    const turnStartsHere = firstIndex !== undefined && firstIndex === group.turn?.startIndex;
    const cue = cueAtStart(firstBlock.text, recoveredOpeningMarkers, usableRoleCandidates());
    const sourceSpeakerLabel = firstBlock.boundaryRoleId === null ? undefined : firstBlock.coSpeakers && firstBlock.coSpeakers.length > 1
      ? firstBlock.coSpeakers.join("・")
      : firstBlock.speakerLabel;
    const roleLabel = group.turn
      ? state.roles.find((role) => role.id === group.turn?.roleId)?.label
      : undefined;
    const displayLabel = sourceSpeakerLabel
      ? `<strong class="extracted-speaker-label">${escapeHtml(sourceSpeakerLabel)}：</strong>`
      : group.turn && !turnStartsHere
        ? `<span class="extracted-continuation">続き${roleLabel ? ` · ${escapeHtml(roleLabel)}` : ""}</span>`
        : group.speech && !cue && roleLabel
          ? `<span class="extracted-continuation">役名候補 · ${escapeHtml(roleLabel)}</span>`
          : "";
    const content = renderScriptBlocks(visibleBlocks);
    const suffixNotes = group.blocks
      .filter((block) => block.isSpeakerSuffix)
      .map((block) => `<small class="extracted-suffix-note">「${escapeHtml(block.rawText.trim())}」を隣の役名「${escapeHtml(block.speakerAliases?.[0] ?? "")}」の一部として扱っています。</small>`)
      .join("");

    return `<article class="extracted-line"><span>${escapeHtml(position)}</span><div><p>${displayLabel}${content || "（文字なし）"}</p>${suffixNotes}</div></article>`;
  }).join("");
}

function canJoinUnassignedPreviewBlocks(
  previous: SourceBlock,
  next: SourceBlock,
  currentBlockCount: number,
  speech: boolean,
): boolean {
  if (previous.pageNumber !== next.pageNumber || (!speech && currentBlockCount >= 5)) return false;
  if (!speech && /[。．.!！?？…」』】]$/u.test(previous.text.trim())) return false;
  return next.orderOnPage === previous.orderOnPage + 1;
}

function blockRangePosition(first: SourceBlock, last: SourceBlock): string {
  if (first.orderOnPage === last.orderOnPage) return blockPosition(first);
  return first.direction === "vertical"
    ? `${first.pageNumber}ページ目 · 右から${first.orderOnPage}〜${last.orderOnPage}列目`
    : `${first.pageNumber}ページ目 · 上から${first.orderOnPage}〜${last.orderOnPage}行目`;
}

function renderAppearances(): string {
  const role = selectedRole();
  const targets = practiceTargets();
  const allBlocks = blocks();
  const allTurns = turnsForBlocks(allBlocks);
  const groups = new Map<string, PracticeTarget[]>();
  for (const target of targets) {
    const group = groups.get(target.sceneLabel) ?? [];
    group.push(target);
    groups.set(target.sceneLabel, group);
  }

  return `
    <main class="work-page appearances-page">
      ${renderStepHeader("練習シーンを選ぶ", `練習する役：${role?.label ?? "未選択"}`)}
      <div class="scene-explainer"><p>台本の区切りごとに練習シーンを表示します。前後に表示する範囲は練習画面で調整できます。</p></div>
      ${targets.length === 0 ? `<div class="empty-state"><strong>この役の練習シーンがありません</strong><p>読み取り結果に戻り、役名とセリフの対応を見直してください。</p><button class="secondary-button" data-action="back-to-analysis">読み取り結果に戻る</button></div>` : `<div class="appearance-groups">${[...groups.entries()].map(([sceneLabel, sceneTargets]) => `
        <section class="scene-group">
          <div class="scene-heading"><span>台本の区切り</span><h2>${escapeHtml(sceneLabel)}</h2><span class="scene-unit-count">練習シーン ${sceneTargets.length}件</span></div>
          <div class="appearance-list">${sceneTargets.map((target) => {
            const index = targets.findIndex((item) => item.id === target.id);
            const openingLine = appearanceOpeningLine(target, allBlocks, allTurns);
            return `<article class="appearance-row">
              <div class="appearance-copy"><span class="small-label">練習シーン ${index + 1} · ${escapeHtml(formatPageRange(target.turn.startPage, target.turn.endPage))}</span><p class="appearance-opening-line">${escapeHtml(openingLine || "前のセリフがありません")}</p></div>
              <button class="secondary-button appearance-start" data-action="start-practice" data-target-index="${index}" ${state.practiceSaveBusy ? "disabled" : ""}>この練習シーンから始める</button>
            </article>`;
          }).join("")}</div>
        </section>`).join("")}</div>`}
      <div class="bottom-actions sticky-action-bar"><button class="text-button" data-action="back-to-analysis">読み取り結果に戻る</button><button class="primary-button" data-action="start-practice" data-target-index="${state.practiceHasStarted ? Math.min(state.currentTargetIndex, Math.max(0, targets.length - 1)) : 0}" ${targets.length === 0 || state.practiceSaveBusy ? "disabled" : ""}>${state.practiceHasStarted ? "前回の練習シーンから始める" : "最初の練習シーンから始める"}</button></div>
    </main>`;
}

function appearanceOpeningLine(
  target: PracticeTarget,
  allBlocks: SourceBlock[],
  allTurns: SpeakerTurn[],
): string {
  const selectedStarts = new Set(
    allTurns.filter((turn) => turn.roleId === target.turn.roleId).map((turn) => turn.startIndex),
  );
  const openingTurn = allTurns.find((turn) =>
    turn.startIndex < target.turn.startIndex &&
    turn.endIndex >= target.defaultStartIndex &&
    !selectedStarts.has(turn.startIndex),
  );
  if (!openingTurn) return "";

  const utteranceBlocks = allBlocks.slice(openingTurn.startIndex, openingTurn.endIndex + 1);
  const rawText = utteranceBlocks.map((block) => block.text)
    .join(utteranceBlocks[0]?.direction === "vertical" ? "" : "\n");
  const speechText = splitStageDirectionText(rawText, usableRoleCandidates())
    .filter((fragment) => fragment.kind === "speech")
    .map((fragment) => fragment.text)
    .join("")
    .trim();
  const cue = cueAtStart(speechText, recoveredOpeningMarkers, usableRoleCandidates());
  let preview = speechText;
  if (cue) {
    const markerIndex = speechText.indexOf(cue.marker, cue.name.length);
    if (markerIndex >= 0) preview = speechText.slice(markerIndex);
  }
  preview = dialogueOnlyPreview(preview);
  const characters = Array.from(normalizeScriptText(preview));
  return characters.length > 88 ? `${characters.slice(0, 88).join("").trimEnd()}…` : characters.join("");
}

function dialogueOnlyPreview(text: string): string {
  const opening = /[「『“"]/u.exec(text);
  if (!opening) return text.trim();

  const closingMark: Record<string, string> = { "「": "」", "『": "』", "“": "”", '"': '"' };
  const closing = closingMark[opening[0]];
  const closingIndex = closing ? text.indexOf(closing, opening.index + opening[0].length) : -1;
  return (closingIndex >= 0
    ? text.slice(opening.index, closingIndex + closing.length)
    : text.slice(opening.index)).trim();
}

function renderPractice(): string {
  const targets = practiceTargets();
  const target = targets[state.currentTargetIndex];
  const role = selectedRole();
  if (!target || !role) return `<main class="narrow-page"><p>練習シーンを選んでください。</p><button class="secondary-button" data-action="back-to-appearances">練習シーン一覧に戻る</button></main>`;

  const allBlocks = blocks();
  const speakerTurns = turnsForBlocks(allBlocks);
  const range = rangeFor(target);
  const contextHtml = renderBlockRange(allBlocks, range.start, target.turn.startIndex - 1, speakerTurns, practiceStyles.contextBlock);
  const afterHtml = state.revealed ? renderAnswer(target, range, allBlocks, speakerTurns) : "";
  const pageRange = formatPageRange(target.turn.startPage, target.turn.endPage);
  const glyphCorrectionsExist = Object.values(state.corrections).some((value) => value.trim().length > 0);

  return `
    <main class="${practiceStyles.root}">
      <div class="${practiceStyles.topline}">
        <div class="${practiceStyles.progressCopy}"><span>${String(state.currentTargetIndex + 1).padStart(2, "0")}</span><span class="${practiceStyles.progressSeparator}">/</span><span>${String(targets.length).padStart(2, "0")}</span><span class="${practiceStyles.progressLabel}">シーン</span></div>
      </div>
      <section class="${practiceStyles.heading}">
        <div><p class="${practiceStyles.meta}">台本の${escapeHtml(target.sceneLabel)} · ${escapeHtml(pageRange)}</p><h1>${escapeHtml(role.label)}の練習シーン <span>${String(state.currentTargetIndex + 1).padStart(2, "0")}</span></h1></div>
      </section>
      ${glyphCorrectionsExist ? `<p class="${practiceStyles.correctionReminder}">文字の置換を練習画面に反映しています。</p>` : ""}
      <div class="${practiceStyles.layout}">
        <section class="${practiceStyles.card}">
          <div class="${practiceStyles.cardHeading}"><span class="small-label">${state.revealed ? "答え" : "前のセリフとト書き"}</span><span class="${practiceStyles.pageTag}">${escapeHtml(pageRange)}</span></div>
          ${contextHtml ? `<div class="${practiceStyles.scriptStream} ${practiceStyles.contextStream}" id="context-stream">${contextHtml}</div>` : `<div class="${practiceStyles.noContext}"><p>この練習シーンの前に表示するセリフやト書きはありません。</p></div>`}
          ${state.revealed ? `<div class="${practiceStyles.revealedAnswer}" id="revealed-answer">${afterHtml}</div>` : `
            <div class="${practiceStyles.answerPrompt}" aria-live="polite">
              <button class="primary-button ${practiceStyles.revealButton}" data-action="reveal">答えを確認する</button>
            </div>`}
          <details class="${practiceStyles.rangeDetails}">
            <summary>表示する範囲を調整する</summary>
            <div class="${practiceStyles.rangeControls}">
              <label class="${practiceStyles.rangeControl}"><span>前のセリフやト書きをどこから表示するか</span><input class="${practiceStyles.rangeSlider}" type="range" min="${target.minimumStartIndex}" max="${target.turn.startIndex}" value="${range.start}" data-range-start="${escapeHtml(target.id)}" /><small id="range-start-label">${escapeHtml(positionAt(allBlocks, range.start))}</small></label>
              <label class="${practiceStyles.rangeControl}"><span>答えを確認したあと、どこまで表示するか</span><input class="${practiceStyles.rangeSlider}" type="range" min="${target.defaultEndIndex}" max="${Math.max(target.defaultEndIndex, allBlocks.length - 1)}" value="${range.end}" data-range-end="${escapeHtml(target.id)}" /><small id="range-end-label">${escapeHtml(positionAt(allBlocks, range.end))}</small></label>
              <button class="text-button ${practiceStyles.resetRange}" data-action="reset-range" data-target-id="${escapeHtml(target.id)}">練習範囲を初期設定に戻す</button>
            </div>
          </details>
        </section>
        <aside class="${practiceStyles.sidePanel}">
          <div class="${practiceStyles.sideCard} ${practiceStyles.progressCard}"><span class="small-label">練習の進捗</span><div class="${practiceStyles.miniProgress}"><span style="width:${Math.round(((state.currentTargetIndex + 1) / Math.max(1, targets.length)) * 100)}%"></span></div><p>${state.currentTargetIndex + 1} / ${targets.length}シーン</p></div>
          ${state.revealed ? `<div class="${practiceStyles.sideCard} ${practiceStyles.sourceCard}"><span class="small-label">元のPDF</span><p>この練習シーンのページを確認できます。</p><button class="secondary-button" data-action="toggle-source">${state.showOriginal ? "元のPDFを閉じる" : "元のPDFを見る"}</button></div>` : `<div class="${practiceStyles.sideCard} ${practiceStyles.sourceCard}"><span class="small-label">元のPDF</span><p>答えを確認すると、該当ページを開けます。</p><button class="secondary-button" disabled>答えの確認後に表示</button></div>`}
        </aside>
      </div>
      ${state.showOriginal ? `<section class="panel ${practiceStyles.sourcePreview}"><div class="source-toolbar"><div><span class="small-label">${state.originalPage}ページ目</span><h2>元のPDFを確認する</h2></div><label class="select-field"><span>表示するページ</span><select class="select-input" id="original-page-select">${state.pages.map((page) => `<option value="${page.pageNumber}" ${page.pageNumber === state.originalPage ? "selected" : ""}>${page.pageNumber}ページ目</option>`).join("")}</select></label></div><div class="pdf-canvas-scroll"><canvas id="page-canvas" aria-label="元のPDFのページ"></canvas></div></section>` : ""}
      ${!target.nextTurn && state.revealed ? `<p class="alert alert-warning ${practiceStyles.lastUtteranceNote}">${escapeHtml(role.label)}の次のセリフを見つけられませんでした。読み取り結果で役名やセリフの区切りを確認してください。</p>` : ""}
      <p class="${practiceStyles.keyboardHelp}">キー操作：← 前の練習シーン　→ 確認／次の練習シーン　R もう一度</p>
      <nav class="${practiceStyles.navigation}" aria-label="練習の操作">
        <button class="secondary-button" data-action="back-to-appearances">練習シーン一覧に戻る</button>
        <button class="secondary-button" data-action="previous-target" ${state.currentTargetIndex === 0 ? "disabled" : ""}>前の練習シーン</button>
        <button class="secondary-button" data-action="repeat-target">同じ練習シーンをもう一度</button>
        <button class="primary-button" data-action="next-target" ${!state.revealed ? "disabled" : ""}>${state.currentTargetIndex + 1 >= targets.length ? "練習シーン一覧に戻る" : "次の練習シーン"}</button>
      </nav>
    </main>`;
}

function renderAnswer(
  target: PracticeTarget,
  range: PracticeRange,
  allBlocks: SourceBlock[],
  speakerTurns: SpeakerTurn[],
): string {
  const own = renderBlockRange(allBlocks, target.turn.startIndex, target.turn.endIndex, speakerTurns);
  const next = target.nextTurn
    ? `<section class="${practiceStyles.answerSection} ${practiceStyles.nextSpeechSection}"><div class="${practiceStyles.answerSectionHeading}"><div><span class="small-label">次のセリフ</span><h2>${escapeHtml(roleLabel(target.nextTurn.roleId))}</h2></div></div><div class="${practiceStyles.scriptStream}">${renderBlockRange(allBlocks, target.nextTurn.startIndex, target.nextTurn.endIndex, speakerTurns)}</div></section>`
    : `<div class="${practiceStyles.nextSpeechMissing}"><span class="small-label">次のセリフ</span><p>次のセリフが見つかりませんでした。</p></div>`;
  const extraStart = target.nextTurn ? target.nextTurn.endIndex + 1 : target.turn.endIndex + 1;
  const extra = range.end >= extraStart
    ? `<div class="${practiceStyles.afterExtra}"><span class="small-label">その先のセリフ</span><div class="${practiceStyles.scriptStream}">${renderBlockRange(allBlocks, extraStart, range.end, speakerTurns, practiceStyles.extraBlock)}</div></div>`
    : "";
  return `
    <section class="${practiceStyles.answerSection} ${practiceStyles.ownSpeechSection}"><div class="${practiceStyles.answerSectionHeading}"><div><span class="small-label">原文</span><h2>自分のセリフ</h2></div></div><div class="${practiceStyles.scriptStream}">${own}</div></section>
    ${next}
    ${extra}`;
}

function renderBlockRange(
  allBlocks: SourceBlock[],
  start: number,
  end: number,
  speakerTurns: SpeakerTurn[],
  variantClass?: string,
): string {
  if (end < start) return "";
  const startIndex = Math.max(0, start);
  const endIndex = Math.min(end, allBlocks.length - 1);
  const turnKeyByIndex = new Map<number, string>();
  for (const turn of speakerTurns) {
    const key = `${turn.startIndex}:${turn.endIndex}`;
    for (let index = turn.startIndex; index <= turn.endIndex; index += 1) {
      if (!turnKeyByIndex.has(index)) turnKeyByIndex.set(index, key);
    }
  }

  const groups: Array<{ key: string; startIndex: number; endIndex: number; blocks: SourceBlock[] }> = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const block = allBlocks[index];
    if (!block) continue;
    const turnKey = turnKeyByIndex.get(index);
    const key = turnKey ?? `block:${index}`;
    const current = groups[groups.length - 1];

    if (block.isSpeakerSuffix) {
      if (current?.key === key) current.endIndex = index;
      continue;
    }
    if (turnKey && current?.key === key) {
      current.endIndex = index;
      current.blocks.push(block);
      continue;
    }
    groups.push({ key, startIndex: index, endIndex: index, blocks: [block] });
  }

  return groups.map((group) => {
    const firstBlock = group.blocks[0];
    const lastBlock = group.blocks[group.blocks.length - 1];
    if (!firstBlock || !lastBlock) return "";

    return `
      <article class="${practiceStyles.scriptBlock}${variantClass ? ` ${variantClass}` : ""}" data-page="${firstBlock.pageNumber}">
        <span class="${practiceStyles.scriptPosition}">${escapeHtml(practiceRangePosition(firstBlock, lastBlock))}</span>
        <p dir="auto">${renderScriptBlocks(group.blocks)}</p>
      </article>`;
  }).join("");
}

function renderScriptBlocks(sourceBlocks: SourceBlock[]): string {
  const roles = usableRoleCandidates();
  const fragments: string[] = [];
  let pendingText = "";
  let pendingStage = "";
  let previousStageBlock: SourceBlock | undefined;
  for (const block of sourceBlocks) {
    const blockText = (block.boundaryRoleId === null ? block.speakerLabel ?? "" : "") + block.text;
    const separator = block.direction === "vertical" ? "" : "\n";
    const startsSpeech = block.boundaryRoleId !== null && Boolean(block.speakerLabel || block.boundaryRoleId || cueAtStart(block.text, recoveredOpeningMarkers, usableRoleCandidates()));
    const continuesStage = previousStageBlock &&
      !startsSpeech &&
      block.direction === "vertical" &&
      block.pageNumber === previousStageBlock.pageNumber &&
      block.orderOnPage === previousStageBlock.orderOnPage + 1 &&
      Math.abs(block.y - previousStageBlock.y) <= (block.fontSize ?? 12) / 2;
    if (continuesStage || (!block.boundaryRoleId && isStageDirectionBlock(block, roles))) {
      if (pendingText) fragments.push(renderScriptContent(pendingText, roles));
      pendingStage += blockText;
      pendingText = "";
      previousStageBlock = block;
    } else {
      if (pendingStage) fragments.push(`<span class="stage-direction">${escapeHtml(pendingStage)}</span>`);
      pendingStage = "";
      pendingText += (pendingText ? separator : "") + blockText;
      previousStageBlock = undefined;
    }
  }
  if (pendingText) fragments.push(renderScriptContent(pendingText, roles));
  if (pendingStage) fragments.push(`<span class="stage-direction">${escapeHtml(pendingStage)}</span>`);
  return fragments.join("");
}

function renderScriptContent(text: string, roles: RoleCandidate[]): string {
  return splitStageDirectionText(text, roles)
    .map((fragment) => fragment.kind === "stage-direction"
      ? `<span class="stage-direction">${escapeHtml(fragment.text)}</span>`
      : escapeHtml(fragment.text))
    .join("");
}

function practiceRangePosition(first: SourceBlock, last: SourceBlock): string {
  if (first.pageNumber === last.pageNumber) return blockRangePosition(first, last);
  const location = (block: SourceBlock) => blockPosition(block).split(" · ").at(-1) ?? "";
  return `${formatPageRange(first.pageNumber, last.pageNumber)} · ${location(first)}〜${location(last)}`;
}

async function renderPdfPreview(): Promise<void> {
  if (!state.document) return;
  const canvas = document.querySelector<HTMLCanvasElement>("#page-canvas");
  const container = canvas?.parentElement;
  if (!canvas || !container) return;
  const requestedPage = state.screen === "practice" ? state.originalPage : state.previewPage;
  const generation = ++previewGeneration;
  previewTask?.cancel();

  try {
    const page = await state.document.getPage(requestedPage);
    if (generation !== previewGeneration) return;
    const fitViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(280, container.clientWidth - 28);
    const scale = Math.min(1.5, availableWidth / fitViewport.width) * state.previewZoom;
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(2, window.devicePixelRatio || 1);
    const renderKey = previewCanvasRenderKey(requestedPage, state.previewZoom, container.clientWidth, outputScale);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    previewTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      background: "#ffffff",
    });
    await previewTask.promise;
    if (generation === previewGeneration) canvas.dataset.renderKey = renderKey;
  } catch (error) {
    if (error instanceof Error && error.name === "RenderingCancelledException") return;
    const fallback = document.querySelector<HTMLDivElement>(".pdf-canvas-scroll");
    if (fallback) fallback.insertAdjacentHTML("beforeend", `<p class="muted-copy">このページを表示できませんでした。</p>`);
  }
}

function rangeFor(target: PracticeTarget): PracticeRange {
  return state.ranges[target.id] ?? {
    start: target.defaultStartIndex,
    end: target.defaultEndIndex,
  };
}

function positionAt(allBlocks: SourceBlock[], index: number): string {
  const block = allBlocks[Math.max(0, Math.min(index, allBlocks.length - 1))];
  return block ? blockPosition(block) : "位置が不明です";
}

function roleLabel(roleId: string): string {
  return state.roles.find((role) => role.id === roleId)?.label ?? "役名不明";
}

function formatPageRange(start: number, end: number): string {
  return start === end ? `${start}ページ目` : `${start}〜${end}ページ目`;
}

function refreshAutomaticRoles(): void {
  const existing = new Map(state.roles.map((role) => [role.id, role]));
  const automatic = detectRoleCandidates(blocks(false))
    .filter((role) => !state.excludedRoleIds.has(role.id))
    .map((detected) => {
      const previous = existing.get(detected.id);
      return previous && !previous.manual
        ? { ...detected, label: previous.label, aliases: previous.aliases }
        : detected;
    });
  const manual = state.roles.filter((role) => role.manual && !state.excludedRoleIds.has(role.id));
  state.roles = [...automatic, ...manual];
  if (!state.roles.some((role) => role.id === state.selectedRoleId)) state.selectedRoleId = "";
}

function refreshPracticeDisplay(): void {
  const targets = practiceTargets();
  const target = targets[state.currentTargetIndex];
  if (!target) return;
  const allBlocks = blocks();
  const speakerTurns = turnsForBlocks(allBlocks);
  const currentRange = rangeFor(target);
  const stream = document.querySelector<HTMLDivElement>("#context-stream");
  if (stream) stream.innerHTML = renderBlockRange(allBlocks, currentRange.start, target.turn.startIndex - 1, speakerTurns, practiceStyles.contextBlock);
  const startLabel = document.querySelector<HTMLElement>("#range-start-label");
  const endLabel = document.querySelector<HTMLElement>("#range-end-label");
  if (startLabel) startLabel.textContent = positionAt(blocks(), currentRange.start);
  if (endLabel) endLabel.textContent = positionAt(blocks(), currentRange.end);
  const answer = document.querySelector<HTMLDivElement>("#revealed-answer");
  if (answer && state.revealed) answer.innerHTML = renderAnswer(target, currentRange, allBlocks, speakerTurns);
}

function scrollToSourceReview(): void {
  requestAnimationFrame(() => document.querySelector("#source-review")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

function slug(value: string): string {
  return Array.from(value).map((character) => (character.codePointAt(0) ?? 0).toString(16)).join("-");
}

async function openPdf(file: File): Promise<void> {
  const requestedResumeFingerprint = state.pendingResumeFingerprint;
  state.pendingResumeFingerprint = null;
  if (!file.name.toLocaleLowerCase("ja-JP").endsWith(".pdf") && file.type !== "application/pdf") {
    state.error = "PDFファイルを選んでください。";
    if (requestedResumeFingerprint) notify("保存した台本と同じPDFを選んでください。", "warning");
    renderApp();
    return;
  }

  clearNotification();
  state.error = "";
  state.loading = true;
  state.loadingPurpose = "opening-pdf";
  state.progress = 0;
  state.progressLabel = "PDFを読み取っています";
  renderApp();

  try {
    const loaded = await loadPdf(file, (pageNumber, pageCount) => {
      state.progress = Math.round((pageNumber / pageCount) * 100);
      state.progressLabel = `${pageNumber} / ${pageCount}ページを読み取り中`;
      const bar = document.querySelector<HTMLDivElement>("#load-progress-bar");
      const label = document.querySelector<HTMLElement>("#load-progress-label");
      if (bar) bar.style.width = `${state.progress}%`;
      if (label) label.textContent = state.progressLabel;
    });

    state.document = loaded.document;
    state.disposePdf = loaded.dispose;
    state.pages = loaded.pages;
    state.originalPages = [...loaded.pages];
    recognizedPageCache.clear();
    boundaryDraft = null;
    state.pdfFingerprint = loaded.fingerprint;
    state.cachedOcrPages = [];
    state.savedPractice = null;
    state.practiceHasStarted = false;
    state.fileName = file.name;
    state.fileSize = file.size;
    state.corrections = {};
    state.roles = [];
    state.excludedRoleIds = new Set();
    state.selectedRoleId = "";
    state.manualSpeakers = {};
    state.boundaryEdits = [];

    state.ranges = {};
    state.currentTargetIndex = 0;
    state.revealed = false;
    state.showOriginal = false;
    state.previewPage = loaded.pages.length > 1 ? 2 : 1;
    state.originalPage = 1;
    state.ocrBusy = false;
    state.ocrCancelRequested = false;
    state.ocrProgress = 0;
    state.ocrTotal = 0;
    state.ocrStatus = "";
    state.ocrErrors = { text: "", layout: "" };
    state.textOcrCompletion = null;
    state.layoutPreview = null;
    state.ocrAnalysisComplete = false;
    state.textOcrPreview = null;
    refreshAutomaticRoles();
    state.screen = "analysis";
    state.loading = Boolean(requestedResumeFingerprint);
    if (requestedResumeFingerprint) {
      state.loadingPurpose = "restoring-practice";
      state.progress = 100;
      state.progressLabel = "練習設定を復元しています";
    }
    renderApp();
    await findSavedPractice(loaded.fingerprint, loaded.pages.length, requestedResumeFingerprint);
  } catch {
    state.loading = false;
    state.error = "このPDFを読み取れませんでした。パスワードで保護されている場合は、保護を解除したPDFを選んでください。";
    if (requestedResumeFingerprint) notify("このPDFを読み取れなかったため、前回の練習設定を復元できませんでした。", "warning");
    renderApp();
  }
}

async function findSavedPractice(
  fingerprint: string | null,
  pageCount: number,
  requestedResumeFingerprint: string | null,
): Promise<void> {
  const restorationStartedAt = requestedResumeFingerprint ? performance.now() : null;
  const keepRestorationVisible = async (): Promise<void> => {
    if (restorationStartedAt === null) return;
    const remaining = 1000 - (performance.now() - restorationStartedAt);
    if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
  };
  let restoredPreviousImageAnalysis = false;

  if (!fingerprint) {
    await keepRestorationVisible();
    state.loading = false;
    if (requestedResumeFingerprint) {
      state.screen = "analysis";
      notify("このPDFを照合できないため、前回の練習設定を復元できませんでした。", "warning");
    }
    renderApp();
    return;
  }

  try {
    const savedPractice = await getSavedPractice(fingerprint);
    if (state.pdfFingerprint !== fingerprint) return;
    if (savedPractice && savedPractice.pageCount === pageCount) {
      state.savedPractice = savedPractice;
      if (requestedResumeFingerprint === fingerprint) {
        await keepRestorationVisible();
        applySavedPractice(savedPractice);
        return;
      }
      const recognizedPages = savedPractice.pages.filter(isOcrRecognizedPage);
      const savedOcrPages = recognizedPages.filter(
        (page) => page.recognitionVersion === OCR_RECOGNITION_VERSION,
      );
      if (savedOcrPages.length > 0) {
        state.cachedOcrPages = savedOcrPages;
      } else {
        const legacyReading = await getSavedReading(fingerprint);
        if (state.pdfFingerprint !== fingerprint) return;
        if (legacyReading && legacyReading.pageCount === pageCount) state.cachedOcrPages = legacyReading.pages;
      }
      if (recognizedPages.some((page) => page.recognitionVersion !== OCR_RECOGNITION_VERSION) && !requestedResumeFingerprint) {
        notify("画像解析の仕組みを更新しました。前回の結果は使わず、必要なページを読み直してください。", "info");
      }
    } else {
      const legacyReading = await getSavedReading(fingerprint);
      if (state.pdfFingerprint !== fingerprint) return;
      if (legacyReading && legacyReading.pageCount === pageCount) {
        state.cachedOcrPages = legacyReading.pages;
        if (requestedResumeFingerprint === fingerprint) {
          applyCachedImageAnalysis(false);
          restoredPreviousImageAnalysis = true;
        }
      } else if (requestedResumeFingerprint === fingerprint) {
        notify("この台本の練習設定は保存されていません。役を選んで練習を始めてください。", "info");
      }
    }
    if (requestedResumeFingerprint && requestedResumeFingerprint !== fingerprint) {
      notify("選んだPDFが前回の台本と一致しませんでした。保存した設定は使わず、このPDFを開きました。", "warning");
    }
  } catch {
    if (state.pdfFingerprint !== fingerprint) return;
    notify("前回の練習設定を復元できませんでした。このPDFで練習を始められます。", "warning");
  }

  await refreshSavedPracticeList();
  if (state.pdfFingerprint === fingerprint) {
    await keepRestorationVisible();
    state.loading = false;
    if (requestedResumeFingerprint && state.screen !== "appearances") state.screen = "analysis";
    if (restoredPreviousImageAnalysis) {
      notify("前回の画像解析結果を適用しました。練習する役を選んでください。", "success");
    }
    renderApp();
  }
}

async function refreshSavedPracticeList(): Promise<void> {
  try {
    const [practices, readings] = await Promise.all([listSavedPractices(), listSavedReadings()]);
    state.savedPractices = practices;
    const practiceFingerprints = new Set(practices.map((practice) => practice.fingerprint));
    state.legacySavedReadings = readings.filter((reading) => !practiceFingerprints.has(reading.fingerprint));
    if (state.screen === "home") renderApp();
  } catch {
    state.savedPractices = [];
    state.legacySavedReadings = [];
  }
}

function applySavedPractice(saved: SavedPractice): void {
  if (state.ocrBusy || state.practiceSaveBusy) return;
  const outdatedRecognition = saved.pages.some((page) =>
    isOcrRecognizedPage(page) && page.recognitionVersion !== OCR_RECOGNITION_VERSION,
  );
  state.loading = false;
  state.savedPractice = saved;
  state.pages = saved.pages.map((page) => {
    if (!isOcrRecognizedPage(page) || page.recognitionVersion === OCR_RECOGNITION_VERSION) {
      return structuredClone(page);
    }
    return structuredClone(state.originalPages[page.pageNumber - 1] ?? page);
  });
  state.roles = structuredClone(saved.settings.roles);
  state.excludedRoleIds = new Set(saved.settings.excludedRoleIds);
  state.selectedRoleId = saved.settings.selectedRoleId;
  state.manualSpeakers = { ...saved.settings.manualSpeakers };
  state.boundaryEdits = saved.settings.boundaryEdits ?? [];

  state.manualRoleNumber = saved.settings.manualRoleNumber;
  state.corrections = { ...saved.settings.corrections };
  state.ranges = structuredClone(saved.settings.ranges);
  state.currentTargetIndex = 0;
  state.previewPage = Math.min(Math.max(1, saved.settings.previewPage), state.pages.length);
  state.cachedOcrPages = [];
  state.practiceHasStarted = false;
  state.revealed = false;
  state.showOriginal = false;
  refreshAutomaticRoles();

  if (!state.roles.some((role) => role.id === state.selectedRoleId)) {
    const previousRole = saved.settings.roles.find((role) => role.id === saved.settings.selectedRoleId);
    if (previousRole) {
      const previousNames = new Set([previousRole.label, ...previousRole.aliases].map(normalizeAlias));
      const matchingRole = state.roles.find((role) =>
        [role.label, ...role.aliases].some((name) => previousNames.has(normalizeAlias(name))),
      );
      if (matchingRole) state.selectedRoleId = matchingRole.id;
    }
  }

  const targetCount = practiceTargets().length;
  if (targetCount === 0) {
    state.screen = "analysis";
    notify(outdatedRecognition
      ? "役の設定は復元しました。文字の読み取り方法が変わったため、画像解析をやり直してください。"
      : "前回の練習設定は復元しましたが、練習シーンが見つかりませんでした。読み取り結果を確認してください。", "warning");
  } else {
    state.currentTargetIndex = Math.min(Math.max(0, saved.settings.currentTargetIndex), targetCount - 1);
    state.screen = "appearances";
    state.practiceHasStarted = true;
    notify(outdatedRecognition
      ? `前回の「${selectedRole()?.label ?? "選んだ役"}」の練習設定を復元しました。読み取り結果から画像解析をやり直せます。`
      : `前回の「${selectedRole()?.label ?? "選んだ役"}」の練習設定を復元しました。`, outdatedRecognition ? "info" : "success");
  }
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function currentPracticeSnapshot(): SavedPracticeInput | null {
  if (!state.pdfFingerprint || state.pages.length === 0 || !state.selectedRoleId) return null;
  return {
    fingerprint: state.pdfFingerprint,
    pageCount: state.pages.length,
    pages: structuredClone(state.pages),
    fileName: state.fileName,
    settings: {
      roles: structuredClone(state.roles),
      excludedRoleIds: [...state.excludedRoleIds],
      selectedRoleId: state.selectedRoleId,
      manualSpeakers: { ...state.manualSpeakers },
      boundaryEdits: state.boundaryEdits,
      manualRoleNumber: state.manualRoleNumber,
      corrections: { ...state.corrections },
      ranges: structuredClone(state.ranges),
      currentTargetIndex: state.currentTargetIndex,
      previewPage: state.previewPage,
    },
  };
}

async function saveCurrentPractice(): Promise<SavedPractice> {
  if (!canSavePracticeHistory()) throw new Error("このブラウザでは練習設定を保存できません。");
  const snapshot = currentPracticeSnapshot();
  if (!snapshot) throw new Error("保存する練習設定が見つかりません。");
  const saved = await savePractice(snapshot);
  state.savedPractice = saved;
  await refreshSavedPracticeList();
  return saved;
}

async function continueToAppearances(): Promise<void> {
  if (practiceTargets().length === 0 || state.ocrBusy || state.layoutPreview || state.textOcrPreview || state.practiceSaveBusy) return;
  let saveError = false;
  if (state.practiceHasStarted) {
    clearScheduledPracticeSave();
    state.practiceSaveBusy = true;
    renderApp();
    try {
      await saveCurrentPractice();
    } catch {
      saveError = true;
    }
    state.practiceSaveBusy = false;
    if (saveError) notify("練習設定を保存できませんでした。前回保存した設定は残っています。", "warning");
  }
  state.screen = "appearances";
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function beginPractice(targetIndex: number): Promise<void> {
  const targetCount = practiceTargets().length;
  if (targetCount === 0 || state.practiceSaveBusy) return;
  clearScheduledPracticeSave();
  state.currentTargetIndex = Math.min(Math.max(0, targetIndex), targetCount - 1);
  state.practiceSaveBusy = true;
  renderApp();

  let saveError = false;
  try {
    await saveCurrentPractice();
  } catch {
    saveError = true;
  }

  state.practiceSaveBusy = false;
  state.screen = "practice";
  state.practiceHasStarted = true;
  state.revealed = false;
  state.showOriginal = false;
  if (saveError) notify("練習は続けられますが、この端末内に設定を保存できませんでした。", "warning");
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function schedulePracticeSave(): void {
  if (state.screen !== "practice" || !state.savedPractice || state.practiceSaveBusy) return;
  if (practiceSaveTimer !== null) window.clearTimeout(practiceSaveTimer);
  practiceSaveTimer = window.setTimeout(() => {
    practiceSaveTimer = null;
    void saveCurrentPractice().catch(() => {
      notify("練習設定を保存できませんでした。", "warning");
      renderApp();
    });
  }, 600);
}

function clearScheduledPracticeSave(): void {
  if (practiceSaveTimer !== null) window.clearTimeout(practiceSaveTimer);
  practiceSaveTimer = null;
}

async function readWithOcr(purpose: AppState["ocrPurpose"]): Promise<void> {
  const adjustLayout = purpose === "layout";
  if (state.ocrBusy || (adjustLayout && state.layoutPreview) || (!adjustLayout && (state.textOcrPreview || state.textOcrCompletion)) || !state.document) return;
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

  try {
    for (const sourcePage of candidates) {
      if (state.ocrCancelRequested) break;
      state.ocrStatus = "文字を読み取っています";
      updateOcrProgress();

      try {
        let recognizedPage = recognizedPageCache.get(sourcePage.pageNumber);
        if (!recognizedPage || recognizedPage.direction !== sourcePage.direction) {
          reader ??= await createLocalOcrReader((progress: OcrProgress) => {
            state.ocrStatus = readableOcrStatus(progress.status);
            updateOcrProgress();
          });
          recognizedPage = await reader.readPage(state.document, sourcePage.pageNumber, sourcePage.direction);
          recognizedPageCache.set(sourcePage.pageNumber, recognizedPage);
        }
        recognizedPages.set(sourcePage.pageNumber, recognizedPage);
        mergeRecognizedPage(sourcePage, recognizedPage, characterMappingEvidence);
        const preview = mergeRecognizedPage({ ...sourcePage, blocks: [] }, recognizedPage);
        if (preview.blocks.some((block) => block.text.trim())) layoutResults.push(preview);
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
      if (!layoutResults.some((page) => page.pageNumber === state.previewPage)) {
        state.previewPage = layoutResults[0].pageNumber;
      }
    }

    if (recognizedPages.size > 0 && !state.textOcrPreview && !state.textOcrCompletion) {
      state.textOcrPreview = {
        pages: [...recognizedPages.values()],
        corrections: inferDocumentCharacterCorrections(characterMappingEvidence),
      };
    }
    if (recognizedPages.size === candidates.length && !initializationFailed && failedPages.length === 0) {
      state.ocrAnalysisComplete = true;
      state.ocrErrors = { text: "", layout: "" };
    }

    if (state.ocrCancelRequested) {
      const hasResults = adjustLayout ? layoutResults.length > 0 : recognizedPages.size > 0;
      const resultMessage = "解析できたページの結果を確認できます。";
      state.ocrErrors[purpose] = hasResults ? `画像解析を中止しました。${resultMessage}` : "画像解析を中止しました。";
    } else if (initializationFailed) {
      const hasResults = adjustLayout ? layoutResults.length > 0 : recognizedPages.size > 0;
      const resultMessage = "解析できたページの結果を確認できます。";
      const retryMessage = hasResults ? resultMessage : "ページを開き直して、もう一度お試しください。";
      state.ocrErrors[purpose] = `画像解析の準備ができなかったため、処理を停止しました。${retryMessage}`;
    } else if (failedPages.length > 0) {
      const pageList = failedPages.slice(0, 6).map((page) => `${page}ページ目`).join("、");
      const remaining = failedPages.length > 6 ? ` ほか ${failedPages.length - 6}ページ` : "";
      state.ocrErrors[purpose] = `${failedPages.length}ページを解析できませんでした（${pageList}${remaining}）。解析できなかったページには、画像解析前の読み取り結果を表示しています。`;
    }
  } catch {
    state.ocrErrors[purpose] = "画像解析を完了できませんでした。画像解析前の読み取り結果は残っています。";
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
  if (status === "loading language traineddata") return "日本語の文字データを準備しています";
  if (status === "recognizing text") return "文字を読み取っています";
  return "画像解析の準備をしています";
}

function updateOcrProgress(): void {
  const label = document.querySelector<HTMLElement>("#image-analysis-progress-label");
  const count = document.querySelector<HTMLElement>("#image-analysis-progress-count");
  const bar = document.querySelector<HTMLDivElement>("#image-analysis-progress-bar");
  if (label) label.textContent = state.ocrStatus;
  if (count) count.textContent = `処理済み ${state.ocrProgress} / ${state.ocrTotal}ページ`;
  if (bar) {
    const percent = state.ocrTotal > 0
      ? Math.round((state.ocrProgress / state.ocrTotal) * 100)
      : 0;
    bar.style.width = `${percent}%`;
    const progress = bar.closest<HTMLElement>("[role='progressbar']");
    progress?.setAttribute("aria-valuenow", String(state.ocrProgress));
  }
}

function hasBoundaryEditsOnPage(pageNumber: number): boolean {
  const blockIds = new Set(blocks(false).filter((block) => block.pageNumber === pageNumber).map((block) => block.id));
  return state.boundaryEdits.some((edit) => blockIds.has(edit.blockId));
}

function replaceReadingPages(pages: SourcePage[]): void {
  const restoresPdfText = pages.some((page) => page.textSource === "pdf-text");
  if (restoresPdfText) {
    state.textOcrCompletion = null;
    state.ocrErrors.text = "";
  }
  const replacements = new Map(pages.map((page) => [page.pageNumber, page]));
  const replacedBlocks = blocks().filter((block) => replacements.has(block.pageNumber));
  const replacedBlockIds = new Set(replacedBlocks.map((block) => block.id));
  const replacedOrigins = new Set(replacedBlocks.map((block) => block.boundaryOrigin?.blockId ?? block.id));
  state.boundaryEdits = state.boundaryEdits.filter((edit) => !replacedOrigins.has(edit.blockId));

  state.manualSpeakers = Object.fromEntries(
    Object.entries(state.manualSpeakers).filter(([id]) => !replacedBlockIds.has(id)),
  );
  state.pages = state.pages.map((page) => replacements.get(page.pageNumber) ?? page);
  state.layoutPreview = null;
  state.ranges = {};
  state.currentTargetIndex = 0;
  state.ocrErrors.layout = "";
  refreshAutomaticRoles();
  renderApp();
}

function applyCachedImageAnalysis(showNotification = true): void {
  if (state.ocrBusy || state.cachedOcrPages.length === 0) return;
  state.textOcrCompletion = null;
  const savedPages = new Map(state.cachedOcrPages.map((page) => [page.pageNumber, page]));
  state.pages = state.pages.map((page) => {
    const saved = savedPages.get(page.pageNumber);
    return saved?.textSource === "ocr" ? saved : saved ? mergeRecognizedPage(page, saved) : page;
  });
  state.corrections = {};
  state.manualSpeakers = {};
  state.ranges = {};
  state.currentTargetIndex = 0;
  state.selectedRoleId = "";
  state.previewPage = state.cachedOcrPages[0]?.pageNumber ?? state.previewPage;
  state.ocrErrors = { text: "", layout: "" };
  state.cachedOcrPages = [];
  if (showNotification) notify("前回の画像解析結果を適用しました。練習する役を選んでください。", "success");
  refreshAutomaticRoles();
  renderApp();
}

function restoreSavedCorrections(): void {
  const savedCorrections = state.savedPractice?.settings.corrections;
  if (!savedCorrections || Object.keys(savedCorrections).length === 0) return;
  state.corrections = { ...savedCorrections, ...state.corrections };
  notify("前回の文字の置換を適用しました。", "success");
  refreshAutomaticRoles();
  renderApp();
}

async function deleteAllSavedPracticeDataFromDevice(): Promise<void> {
  if (state.savedPractices.length + state.legacySavedReadings.length === 0 || state.ocrBusy || state.practiceSaveBusy) return;
  if (!window.confirm("この端末内に保存した練習設定と読み取り結果をすべて削除しますか？PDFファイルは削除されません。")) return;
  try {
    await deleteAllSavedPracticeData();
    state.savedPractices = [];
    state.legacySavedReadings = [];
    state.savedPractice = null;
    state.cachedOcrPages = [];
    notify("保存した練習設定と読み取り結果をすべて削除しました。", "success");
  } catch {
    notify("保存した練習設定と読み取り結果を削除できませんでした。", "warning");
  }
  renderApp();
}

async function deleteSavedPracticeFromHome(fingerprint: string): Promise<void> {
  const reading = [...state.savedPractices, ...state.legacySavedReadings].find((candidate) => candidate.fingerprint === fingerprint);
  if (!reading || state.ocrBusy || state.practiceSaveBusy) return;
  const name = reading.fileName || "ファイル名未登録のPDF";
  if (!window.confirm(`「${name}」の練習設定と読み取り結果を、この端末から削除しますか？PDFファイルは削除されません。`)) return;
  try {
    await deleteSavedPractice(fingerprint);
    if (state.pdfFingerprint === fingerprint) {
      state.savedPractice = null;
      state.cachedOcrPages = [];
    }
    await refreshSavedPracticeList();
    notify("この台本の練習設定と読み取り結果を削除しました。", "success");
  } catch {
    notify("この台本の練習設定と読み取り結果を削除できませんでした。", "warning");
  }
  renderApp();
}

async function closePdf(): Promise<void> {
  if (state.loading || state.ocrBusy || state.practiceSaveBusy) return;
  clearScheduledPracticeSave();
  if (state.practiceHasStarted) {
    state.practiceSaveBusy = true;
    renderApp();
    try {
      await saveCurrentPractice();
    } catch {
      if (!window.confirm("練習設定を保存できませんでした。変更を保存せずに台本を閉じますか？")) {
        state.practiceSaveBusy = false;
        renderApp();
        return;
      }
    }
  }
  previewTask?.cancel();
  const dispose = state.disposePdf;
  state.document = null;
  state.disposePdf = null;
  state.pages = [];
  state.originalPages = [];
  boundaryDraft = null;
  state.ocrAnalysisComplete = false;
  state.textOcrPreview = null;
  state.textOcrCompletion = null;
  recognizedPageCache.clear();
  state.boundaryEdits = [];

  state.layoutPreview = null;
  state.pdfFingerprint = null;
  state.cachedOcrPages = [];
  state.savedPractice = null;
  clearNotification();
  state.practiceHasStarted = false;
  state.pendingResumeFingerprint = null;
  state.practiceSaveBusy = false;
  state.fileName = "";
  state.fileSize = 0;
  state.corrections = {};
  state.roles = [];
  state.excludedRoleIds = new Set();
  state.selectedRoleId = "";
  state.manualSpeakers = {};
  state.ranges = {};
  cachedDerivedBlocks = null;
  cachedSpeakerTurns = null;
  cachedPracticeTargets = null;
  recoveredOpeningMarkers = new Set();
  recoveredClosingMarkers = new Set();
  state.currentTargetIndex = 0;
  state.revealed = false;
  state.showOriginal = false;
  state.screen = "home";
  state.error = "";
  state.ocrBusy = false;
  state.ocrCancelRequested = false;
  state.ocrProgress = 0;
  state.ocrTotal = 0;
  state.ocrStatus = "";
  state.ocrErrors = { text: "", layout: "" };
  const fileInput = document.querySelector<HTMLInputElement>("#pdf-input");
  if (fileInput) fileInput.value = "";
  renderApp();
  if (dispose) await dispose();
}

root.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  switch (action) {
    case "choose-pdf": {
      state.pendingResumeFingerprint = null;
      const fileInput = document.querySelector<HTMLInputElement>("#pdf-input");
      if (fileInput) fileInput.value = "";
      fileInput?.click();
      break;
    }
    case "resume-saved-practice":
    case "open-saved-reading": {
      state.pendingResumeFingerprint = button.dataset.fingerprint ?? null;
      const fileInput = document.querySelector<HTMLInputElement>("#pdf-input");
      if (fileInput) fileInput.value = "";
      fileInput?.click();
      break;
    }
    case "go-home":
      if (state.pages.length > 0) state.screen = "analysis";
      else state.screen = "home";
      renderApp();
      break;
    case "close-pdf":
      void closePdf();
      break;
    case "read-with-ocr":
      void readWithOcr("text");
      break;
    case "cancel-ocr":
      state.ocrCancelRequested = true;
      state.ocrStatus = "処理中のページが終わり次第、画像解析を中止します";
      updateOcrProgress();
      break;
    case "assign-selected-speaker":
      applyScriptEditor(true);
      break;
    case "unassign-selected-speaker":
      unassignSelectedSpeaker();
      break;
    case "apply-ocr-text":
      applyTextOcrPreview();
      break;
    case "discard-ocr-text":
      state.textOcrPreview = null;
      renderApp();
      break;
    case "preview-ocr-layout":
      void readWithOcr("layout");
      break;
    case "apply-ocr-layout":
      if (!state.ocrBusy && state.layoutPreview) replaceReadingPages(state.layoutPreview);
      break;
    case "discard-ocr-layout":
      state.layoutPreview = null;
      renderApp();
      break;
    case "restore-preview-page-text": {
      const originalPage = state.originalPages[state.previewPage - 1];
      if (!state.ocrBusy && !state.layoutPreview && originalPage) {
        const changes = [
          hasBoundaryEditsOnPage(originalPage.pageNumber) ? "このページの手動の区切り" : "",
          Object.keys(state.ranges).length ? "調整した練習範囲" : "",
        ].filter(Boolean);
        if (changes.length && !window.confirm(`PDFからの読み取り結果に戻すと、${changes.join("と")}が初期設定に戻ります。`)) break;
        replaceReadingPages([originalPage]);
      }
      break;
    }
    case "use-previous-image-analysis":
      applyCachedImageAnalysis();
      break;
    case "dismiss-notification":
      clearNotification();
      renderApp();
      break;
    case "restore-saved-corrections":
      restoreSavedCorrections();
      break;
    case "delete-saved-practice-from-home":
      void deleteSavedPracticeFromHome(button.dataset.fingerprint ?? "");
      break;
    case "delete-all-saved-practices":
      void deleteAllSavedPracticeDataFromDevice();
      break;
    case "select-role":
      state.selectedRoleId = button.dataset.roleId ?? "";
      renderApp();
      break;
    case "remove-role": {
      const roleId = button.dataset.roleId ?? "";
      state.excludedRoleIds.add(roleId);
      state.roles = state.roles.filter((role) => role.id !== roleId);
      state.manualSpeakers = Object.fromEntries(Object.entries(state.manualSpeakers).filter(([, id]) => id !== roleId));
      if (state.boundaryEdits.some((edit) => edit.roleId === roleId)) {
        state.boundaryEdits = state.boundaryEdits.filter((edit) => edit.roleId !== roleId);
        state.ranges = {};
        state.currentTargetIndex = 0;
      }
      if (state.selectedRoleId === roleId) state.selectedRoleId = "";
      renderApp();
      break;
    }
    case "add-role": {
      const labelInput = document.querySelector<HTMLInputElement>("#new-role-label");
      const aliasInput = document.querySelector<HTMLInputElement>("#new-role-alias");
      const label = labelInput?.value.trim() ?? "";
      if (!label) {
        labelInput?.focus();
        labelInput?.setCustomValidity("役名を入力してください。");
        labelInput?.reportValidity();
        return;
      }
      state.manualRoleNumber += 1;
      const alias = aliasInput?.value.trim() || label;
      const role: RoleCandidate = {
        id: `manual-${slug(label)}-${state.manualRoleNumber}`,
        label,
        aliases: [alias],
        occurrenceCount: 0,
        exampleBlockIds: [],
        manual: true,
        evidence: "manual",
      };
      state.roles.push(role);
      state.selectedRoleId = role.id;
      renderApp();
      break;
    }
    case "continue-to-appearances":
      void continueToAppearances();
      break;
    case "back-to-analysis":
      state.screen = "analysis";
      renderApp();
      break;
    case "back-to-appearances":
      state.screen = "appearances";
      state.revealed = false;
      state.showOriginal = false;
      renderApp();
      break;
    case "start-practice":
      void beginPractice(Number(button.dataset.targetIndex ?? 0));
      break;
    case "reveal":
      state.revealed = true;
      renderApp();
      break;
    case "repeat-target":
      state.revealed = false;
      state.showOriginal = false;
      renderApp();
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "previous-target":
      if (state.currentTargetIndex > 0) state.currentTargetIndex -= 1;
      state.revealed = false;
      state.showOriginal = false;
      schedulePracticeSave();
      renderApp();
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "next-target": {
      const count = practiceTargets().length;
      if (!state.revealed) return;
      if (state.currentTargetIndex + 1 >= count) {
        state.screen = "appearances";
        state.revealed = false;
        state.showOriginal = false;
      } else {
        state.currentTargetIndex += 1;
        state.revealed = false;
        state.showOriginal = false;
        schedulePracticeSave();
      }
      renderApp();
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    }
    case "reset-range": {
      const targetId = button.dataset.targetId ?? "";
      const item = practiceTargets().find((candidate) => candidate.id === targetId);
      if (item) {
        state.ranges[item.id] = { start: item.defaultStartIndex, end: item.defaultEndIndex };
        const startInput = document.querySelector<HTMLInputElement>(`[data-range-start="${CSS.escape(item.id)}"]`);
        const endInput = document.querySelector<HTMLInputElement>(`[data-range-end="${CSS.escape(item.id)}"]`);
        if (startInput) startInput.value = String(item.defaultStartIndex);
        if (endInput) endInput.value = String(item.defaultEndIndex);
        refreshPracticeDisplay();
        schedulePracticeSave();
      }
      break;
    }
    case "toggle-source":
      state.showOriginal = !state.showOriginal;
      if (state.showOriginal) {
        const targetItem = practiceTargets()[state.currentTargetIndex];
        state.originalPage = targetItem?.turn.startPage ?? 1;
      }
      renderApp();
      break;
    case "zoom-in":
      state.previewZoom = Math.min(1.8, +(state.previewZoom + 0.2).toFixed(1));
      renderApp();
      break;
    case "zoom-out":
      state.previewZoom = Math.max(0.6, +(state.previewZoom - 0.2).toFixed(1));
      renderApp();
      break;
    case "previous-preview-page":
      goToPreviewPage(state.previewPage - 1);
      break;
    case "next-preview-page":
      goToPreviewPage(state.previewPage + 1);
      break;
    case "preview-block": {
      const block = rawBlocks().find((item) => item.id === button.dataset.blockId);
      if (block) {
        state.previewPage = block.pageNumber;
        state.originalPage = block.pageNumber;
        if (state.screen === "practice") state.showOriginal = true;
        renderApp();
        scrollToSourceReview();
      }
      break;
    }
    default:
      break;
  }
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;

  if (target instanceof HTMLInputElement && target.id === "pdf-input") {
    const file = target.files?.[0];
    if (file) void openPdf(file);
    return;
  }

  if (target instanceof HTMLInputElement && target.dataset.roleLabel) {
    const role = state.roles.find((item) => item.id === target.dataset.roleLabel);
    if (role) role.label = target.value.trim() || role.label;
    if (role && !target.value.trim()) target.value = role.label;
    return;
  }

  if (target instanceof HTMLInputElement && target.dataset.roleAliases) {
    const role = state.roles.find((item) => item.id === target.dataset.roleAliases);
    if (role) {
      const aliases = target.value.split(/[、,，\n]/u).map((value) => value.trim()).filter(Boolean);
      role.aliases = [...new Set(aliases)];
      if (role.aliases.length === 0) role.aliases = [role.label];
      target.value = role.aliases.join("、");
    }
    return;
  }

  if (target instanceof HTMLInputElement && target.dataset.correctionChar) {
    const character = target.dataset.correctionChar;
    const replacement = target.value;
    if ((state.corrections[character] ?? "") !== replacement && state.boundaryEdits.length) {
      state.ranges = {};
      state.currentTargetIndex = 0;
    }
    if (replacement.trim()) state.corrections[character] = replacement;
    else delete state.corrections[character];
    refreshAutomaticRoles();
    renderApp();
    return;
  }

  if (target instanceof HTMLSelectElement && (target.id === "preview-page-select" || target.id === "layout-ocr-page-select" || target.id === "text-ocr-page-select")) {
    goToPreviewPage(Number(target.value));
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "original-page-select") {
    state.originalPage = Number(target.value);
    renderApp();
    return;
  }

});

root.addEventListener("scroll", (event) => {
  if (event.target instanceof HTMLTextAreaElement && event.target.id === "full-script-editor") {
    syncEditorHighlights();
  }
}, true);

root.addEventListener("mouseup", (event) => {
  if (event.target instanceof HTMLTextAreaElement && event.target.id === "full-script-editor") {
    showScriptSelectionToolbar({ x: event.clientX, y: event.clientY });
  }
});

root.addEventListener("keyup", (event) => {
  if (event.target instanceof HTMLTextAreaElement && event.target.id === "full-script-editor") {
    if (event.key === "Escape") hideScriptSelectionToolbar();
    else showScriptSelectionToolbar();
  }
});

root.addEventListener("select", (event) => {
  if (event.target instanceof HTMLTextAreaElement && event.target.id === "full-script-editor") showScriptSelectionToolbar();
});

root.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Element && !event.target.closest("#full-script-editor, #script-selection-toolbar")) {
    hideScriptSelectionToolbar();
  }
});

window.addEventListener("resize", hideScriptSelectionToolbar);

root.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement && target.id === "full-script-editor") {
    if (event instanceof InputEvent && event.isComposing) return;
    target.setCustomValidity("");
    const model = scriptEditorModel();
    if (target.value.replace(/\n/g, "") !== model.text.replace(/\n/g, "")) {
      const position = target.selectionStart;
      target.value = model.text;
      target.setSelectionRange(Math.min(position, target.value.length), Math.min(position, target.value.length));
      showScriptEditorError("ここでは改行で区切りを調整できます。本文の文字は「文字の置換」で直せます。");
      return;
    }
    boundaryDraft = { source: model.text, text: target.value };
    applyScriptEditor(false);
    syncEditorHighlights();
    return;
  }
  if (!(target instanceof HTMLInputElement)) return;

  if (target.dataset.roleLabel) {
    const role = state.roles.find((item) => item.id === target.dataset.roleLabel);
    if (role && target.value.trim()) role.label = target.value.trim();
    return;
  }

  if (target.dataset.roleAliases) {
    const role = state.roles.find((item) => item.id === target.dataset.roleAliases);
    if (role) {
      const aliases = target.value.split(/[、,，\n]/u).map((value) => value.trim()).filter(Boolean);
      if (aliases.length > 0) role.aliases = [...new Set(aliases)];
    }
    return;
  }

  if (target.dataset.rangeStart) {
    const targetId = target.dataset.rangeStart;
    const existing = state.ranges[targetId] ?? { start: Number(target.min), end: Number(target.max) };
    existing.start = Number(target.value);
    state.ranges[targetId] = existing;
    refreshPracticeDisplay();
    schedulePracticeSave();
    return;
  }

  if (target.dataset.rangeEnd) {
    const targetId = target.dataset.rangeEnd;
    const existing = state.ranges[targetId] ?? { start: 0, end: Number(target.value) };
    existing.end = Number(target.value);
    state.ranges[targetId] = existing;
    refreshPracticeDisplay();
    schedulePracticeSave();
  }
});

root.addEventListener("wheel", (event) => {
  if (state.screen !== "analysis" || !(event.target instanceof Element)) return;
  const preview = event.target.closest<HTMLElement>(".pdf-canvas-scroll");
  if (!preview) return;
  const canScrollVertically = preview.scrollHeight > preview.clientHeight + 2;
  const canScrollHorizontally = preview.scrollWidth > preview.clientWidth + 2;
  if (canScrollVertically || canScrollHorizontally) return;

  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (Math.abs(delta) < 32) return;
  const now = performance.now();
  if (now - lastPreviewWheelTurn < 400) return;
  event.preventDefault();
  lastPreviewWheelTurn = now;
  goToPreviewPage(state.previewPage + (delta > 0 ? 1 : -1));
}, { passive: false });

root.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest(".pdf-canvas-scroll")) return;
  previewPointerStart = { x: event.clientX, y: event.clientY };
});

root.addEventListener("pointerup", (event) => {
  if (!previewPointerStart || !(event.target instanceof Element)) return;
  const preview = event.target.closest<HTMLElement>(".pdf-canvas-scroll");
  const start = previewPointerStart;
  previewPointerStart = null;
  if (!preview || preview.scrollWidth > preview.clientWidth + 2) return;
  const distanceX = event.clientX - start.x;
  const distanceY = event.clientY - start.y;
  if (Math.abs(distanceX) < 56 || Math.abs(distanceX) < Math.abs(distanceY) * 1.25) return;
  goToPreviewPage(state.previewPage + (distanceX < 0 ? 1 : -1));
});

root.addEventListener("pointercancel", () => {
  previewPointerStart = null;
});

root.addEventListener("dragover", (event) => {
  if (!state.loading && state.pages.length === 0) {
    event.preventDefault();
    document.querySelector("#drop-zone")?.classList.add("drop-zone-active");
  }
});

root.addEventListener("dragleave", (event) => {
  const target = event.target;
  if (target instanceof Element && !target.closest("#drop-zone")) return;
  document.querySelector("#drop-zone")?.classList.remove("drop-zone-active");
});

root.addEventListener("drop", (event) => {
  event.preventDefault();
  document.querySelector("#drop-zone")?.classList.remove("drop-zone-active");
  const file = event.dataTransfer?.files[0];
  if (file && state.pages.length === 0) void openPdf(file);
});

document.addEventListener("keydown", (event) => {
  if (state.screen !== "practice" || state.practiceSaveBusy) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))) return;

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (state.currentTargetIndex > 0) {
      state.currentTargetIndex -= 1;
      state.revealed = false;
      state.showOriginal = false;
      schedulePracticeSave();
      renderApp();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    if (!state.revealed) {
      state.revealed = true;
      renderApp();
    } else {
      document.querySelector<HTMLElement>('[data-action="next-target"]')?.click();
    }
  } else if (event.key.toLocaleLowerCase("en-US") === "r") {
    event.preventDefault();
    state.revealed = false;
    state.showOriginal = false;
    renderApp();
  }
});

renderApp();
void refreshSavedPracticeList();
