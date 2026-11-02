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
import { createLocalOcrReader, type OcrProgress } from "./pdf/ocr";
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
  mergeReadableSourceText,
  normalizeScriptText,
} from "./pdf/corrections";
import {
  blockPosition,
  buildPracticeTargets,
  collectBlocks,
  cueAtStart,
  detectRoleCandidates,
  getSpeakerTurns,
  hasEnoughText,
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
  ocrError: string;
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
  ocrError: "",
};

const foundRoot = document.querySelector<HTMLDivElement>("#app");
if (!foundRoot) throw new Error("アプリの表示領域が見つかりません。");
const root: HTMLDivElement = foundRoot;

let previewTask: ReturnType<PDFPageProxy["render"]> | null = null;
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
let recoveredOpeningMarkers = new Set<string>();

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

function blocks(): SourceBlock[] {
  const roleCandidates = usableRoleCandidates();
  const roleSignature = JSON.stringify(roleCandidates.map(({ id, label, aliases, manual }) => [id, label, aliases, manual]));
  const correctionsSignature = JSON.stringify(state.corrections);
  if (
    cachedDerivedBlocks &&
    cachedDerivedBlocks.pages === state.pages &&
    cachedDerivedBlocks.roles === roleSignature &&
    cachedDerivedBlocks.corrections === correctionsSignature
  ) return cachedDerivedBlocks.value;

  const sourceBlocks = rawBlocks();
  recoveredOpeningMarkers = inferRecoveredOpeningMarkers(sourceBlocks);
  const corrected = applySeparatedLatinRoleSuffixes(
    applyCharacterCorrections(sourceBlocks, state.corrections).map((block) => {
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
  const result = splitInlineSpeakerBlocks(withoutDuplicateCues, roleCandidates);
  cachedDerivedBlocks = {
    pages: state.pages,
    roles: roleSignature,
    corrections: correctionsSignature,
    value: result,
  };
  return result;
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
      : cueAtStart(block.text, recoveredOpeningMarkers);
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
      : cueAtStart(block.text, recoveredOpeningMarkers);
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

function pagesNeedingOcr(): SourcePage[] {
  return state.pages.filter(
    (page) => page.textSource !== "ocr" && pageRequiresOcr(page),
  );
}

function pageRequiresOcr(page: SourcePage): boolean {
  if (page.textSource === "ocr") return false;
  if (page.blocks.length === 0) return true;
  const sourceBlocks = page.blocks.filter((block) => block.recognitionConfidence === undefined);
  if (sourceBlocks.length === 0) return false;
  return sourceBlocks.some((block) =>
    !block.text.trim() || findUnusualCharacters([block], {}).length > 0,
  );
}

function mergeRecognizedPage(sourcePage: SourcePage, recognizedPage: SourcePage): SourcePage {
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
    const sourceSpeakerLabel = sourceBlock.speakerLabel ?? cueAtStart(sourceBlock.text, recoveredOpeningMarkers)?.name;
    const speakerLabel = sourceSpeakerLabel ?? recognizedBlock.speakerLabel;
    const sourceText = !sourceBlock.speakerLabel && sourceSpeakerLabel &&
      sourceBlock.text.startsWith(sourceSpeakerLabel)
      ? sourceBlock.text.slice(sourceSpeakerLabel.length).trimStart()
      : sourceBlock.text;
    const recognizedTextSource = sourceSpeakerLabel && recognizedBlock.speakerLabel
      ? recognizedBlock.text
      : recognizedBlock.rawText;
    const recognizedText = normalizeScriptText(sourceSpeakerLabel
      ? stripDuplicateSpeakerCue(recognizedTextSource, sourceSpeakerLabel, recoveredOpeningMarkers)
      : recognizedTextSource);
    const mergedTextWithCue = mergeReadableSourceText(sourceText, recognizedText);
    const mergedText = normalizeScriptText(speakerLabel
      ? stripDuplicateSpeakerCue(mergedTextWithCue, speakerLabel, recoveredOpeningMarkers)
      : mergedTextWithCue);
    const mergedRawText = normalizeScriptText(mergeReadableSourceText(
      sourceBlock.rawText,
      normalizeScriptText(recognizedBlock.rawText),
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
      ...(speakerLabel ? { speakerLabel } : {}),
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

  const sourceSpeaker = sourceBlock.speakerLabel ?? cueAtStart(sourceBlock.text, recoveredOpeningMarkers)?.name;
  const recognizedSpeaker = recognizedBlock.speakerLabel ?? cueAtStart(recognizedBlock.text, recoveredOpeningMarkers)?.name;
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
    return `<div class="toast-notification toast-info toast-progress" role="status" aria-live="polite"><span class="toast-spinner" aria-hidden="true"></span><p>練習設定をこの端末に保存しています。</p></div>`;
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
          <h1><span>台本をひらいて、</span><span>シーンを練習する</span></h1>
          <p class="hero-lead">自分のセリフを隠して、シーンごとに練習できます。</p>
        </section>
        <div class="upload-card" id="drop-zone">
          <p class="upload-label">台本PDFを読み取る</p>
          <p class="upload-description">端末から台本PDFを選ぶか、ここにドロップします。</p>
          <input class="visually-hidden" type="file" id="pdf-input" accept="application/pdf,.pdf" />
          <button class="primary-button choose-button" data-action="choose-pdf">PDFを選ぶ</button>
          <p class="privacy-note">PDFはブラウザ内で読み取ります。練習を始めると、読み取り結果と設定をこの端末に保存します。PDF自体は保存しません。</p>
        </div>
      </div>

      <section class="steps-strip" aria-labelledby="steps-heading">
        <h2 id="steps-heading">使い方</h2>
        <ol class="home-steps">
          <li>台本PDFを選ぶと、文字をブラウザ内で読み取ります。</li>
          <li>文字と役名を元のPDFと見比べ、必要なら直します。</li>
          <li>役を選び、「練習を始める」を押します。</li>
          <li>シーンを選び、表示された前のセリフを読みます。</li>
          <li>自分のセリフを声に出してから「確認する」を押します。原文と次のセリフが表示されます。</li>
        </ol>
      </section>

      ${recentItems.length > 0 ? `<section class="recent-practices" aria-labelledby="saved-readings-heading">
        <div class="recent-practices-heading"><h2 id="saved-readings-heading">最近おぼえようとした台本</h2><button class="text-button" data-action="delete-all-saved-practices" aria-label="保存した練習設定と読み取り結果をすべて削除">すべて削除</button></div>
        <ul class="recent-practices-list">${recentItems.map((reading) => `<li class="recent-practices-item"><span><strong>${escapeHtml(reading.fileName || "ファイル名未登録")}</strong><small>${reading.kind === "practice" ? `選択した役：${escapeHtml(reading.roleLabel)} · ${reading.pageCount} ページ` : `${reading.pageCount} ページ · 練習設定は未保存`}</small></span><div class="recent-practices-actions"><button class="${reading.kind === "practice" ? "primary-button" : "secondary-button"}" data-action="${reading.kind === "practice" ? "resume-saved-practice" : "open-saved-reading"}" data-fingerprint="${escapeHtml(reading.fingerprint)}">${reading.kind === "practice" ? "PDFを選んで練習を再開する" : "PDFを選んで設定を作る"}</button><button class="text-button" data-action="delete-saved-practice-from-home" data-fingerprint="${escapeHtml(reading.fingerprint)}">削除</button></div></li>`).join("")}</ul>
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
      <p>${restoringPractice ? "前回の役と練習範囲を確認しています。" : "ページ数によっては、少し時間がかかることがあります。"}</p>
      <div class="progress-shell"><div class="progress-bar" id="load-progress-bar" style="width:${state.progress}%"></div></div>
      <p class="progress-copy" id="load-progress-label">${escapeHtml(state.progressLabel || (restoringPractice ? "練習設定を確認しています" : "準備しています"))}</p>
    </main>`;
}

function renderLoadError(): string {
  return `
    <main class="narrow-page error-page">
      <h1>別のPDFで試してください</h1>
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
  const allGlyphs = findUnusualCharacters(rawBlocks(), state.corrections);
  const ocrPageCount = state.pages.filter(isOcrRecognizedPage).length;
  const ocrCandidateCount = pagesNeedingOcr().length;
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
      !state.practiceSaveBusy,
  );

  return `
    <main class="work-page analysis-page">
      ${renderStepHeader("読み取り結果を確認する", "元のPDFと見比べ、練習する役を選びます。")}
      <section class="file-summary-panel">
        <div class="file-summary-copy"><span class="small-label">開いている台本</span><strong>${escapeHtml(state.fileName)}</strong><p>練習を始めると、読み取り結果と設定をこの端末に保存します。PDF自体は保存しません。</p></div>
        <div class="file-summary-stats"><span>${state.pages.length} ページ</span><span>${characterCount.toLocaleString("ja-JP")} 文字</span></div>
      </section>

      ${!enoughText ? `<div class="alert alert-warning notice-box" role="alert"><strong>PDFから文字を読み取れませんでした。</strong><p>「画像解析で文字を読み直す」を試してください。読み取った文字は元のPDFと見比べられます。</p></div>` : ""}

      ${renderCorrectionPanel(allGlyphs, ocrCandidateCount, ocrPageCount)}

      <section class="panel role-panel">
        <div class="panel-heading">
          <div><span class="small-label">自分の役を選ぶ</span><h2>役名の候補</h2><p>役名を元のPDFと見比べて選びます。必要なら、名前や表記を直せます。</p></div>
          <span class="count-pill">候補 ${state.roles.length} 件</span>
        </div>
        ${frequentRoles.length > 0 ? `<div class="role-grid">${frequentRoles.map((role) => renderRoleCard(role, foundTurns, blocksById)).join("")}</div>` : `<div class="empty-state"><strong>繰り返し見つかった役名はありません</strong><p>1回だけ見つかった名前を確認するか、台本を見ながら役名を追加してください。セリフとの対応は、あとから選べます。</p></div>`}
        ${occasionalRoles.length > 0 ? `<details class="occasional-role-details"><summary>1回だけ見つかった名前も確認する（${occasionalRoles.length} 件）</summary><p>セリフの一部を役名として読み取っている場合があります。元のPDFと照らし合わせて選んでください。</p><div class="role-grid">${occasionalRoles.map((role) => renderRoleCard(role, foundTurns, blocksById)).join("")}</div></details>` : ""}

        <details class="manual-role-details">
          <summary>見つからない役を追加する</summary>
          <div class="manual-role-form">
            <label>画面に表示する役名<input class="text-input" id="new-role-label" type="text" placeholder="例：役名" maxlength="24" /></label>
            <label>台本に書かれた名前<input class="text-input" id="new-role-alias" type="text" placeholder="同じ名前でよければ空欄で構いません" maxlength="48" /></label>
            <button class="secondary-button" data-action="add-role">役名を追加</button>
          </div>
        </details>
      </section>

      <section class="panel source-review-panel" id="source-review">
        <div class="panel-heading"><div><span class="small-label">PDFと見比べる</span><h2>原稿の見た目と読み取り結果</h2><p>ページ番号を選ぶと、元のPDFと読み取った文字を並べて確認できます。</p></div></div>
        <div class="source-toolbar">
          <div class="page-navigation" aria-label="PDFのページ移動">
            <button class="secondary-button page-step-button" data-action="previous-preview-page" aria-label="前のページ" title="前のページ" ${state.previewPage <= 1 ? "disabled" : ""}><span aria-hidden="true">←</span></button>
            <label>ページ<select class="select-input" id="preview-page-select">${state.pages.map((page) => `<option value="${page.pageNumber}" ${page.pageNumber === state.previewPage ? "selected" : ""}>${page.pageNumber} ページ</option>`).join("")}</select></label>
            <button class="secondary-button page-step-button" data-action="next-preview-page" aria-label="次のページ" title="次のページ" ${state.previewPage >= state.pages.length ? "disabled" : ""}><span aria-hidden="true">→</span></button>
          </div>
          <div class="zoom-controls"><button class="zoom-button secondary-button" data-action="zoom-out" aria-label="原稿を縮小">−</button><span>${Math.round(state.previewZoom * 100)}%</span><button class="zoom-button secondary-button" data-action="zoom-in" aria-label="原稿を拡大">＋</button></div>
        </div>
        <div class="source-compare-grid">
          <div class="pdf-preview-card"><span class="preview-label">元のPDF</span><div class="pdf-canvas-scroll"><canvas id="page-canvas" aria-label="元のPDFのページ"></canvas></div></div>
          <div class="extracted-page-card"><span class="preview-label">読み取った文字</span><div class="extracted-lines">${renderPageBlocks(state.previewPage)}</div></div>
        </div>
        <p class="panel-footnote">セリフは発話ごとにまとめ、位置はページ番号と列の範囲で示します。元のPDFは読み取り専用です。</p>
      </section>

      <div class="sticky-action-bar">
        <p>${state.selectedRoleId ? selectedTurnCount > 0 ? `「${escapeHtml(selectedRole()?.label ?? "")}」のセリフを ${selectedTurnCount} 件見つけました。` : `「${escapeHtml(selectedRole()?.label ?? "")}」のセリフを見つけられませんでした。読み取り結果を直すか、セリフの行を選んでください。` : "練習する役を選んでください。"}</p>
        <button class="primary-button" data-action="continue-to-appearances" ${!canContinue || state.practiceSaveBusy ? "disabled" : ""}>${state.practiceHasStarted ? "練習を再開する" : "練習を始める"}</button>
      </div>
    </main>`;
}

function renderCorrectionPanel(
  glyphs: ReturnType<typeof findUnusualCharacters>,
  ocrCandidateCount: number,
  ocrPageCount: number,
): string {
  const unresolved = glyphs.filter((entry) => !state.corrections[entry.character]?.trim()).length;
  const occurrenceCount = glyphs.reduce((sum, entry) => sum + entry.count, 0);
  const needsReview = glyphs.length > 0 || ocrPageCount > 0;
  const savedCorrectionCount = Object.values(state.savedPractice?.settings.corrections ?? {}).filter((value) => value.trim()).length;
  const hasOcrSupport = ocrCandidateCount > 0 || state.cachedOcrPages.length > 0 || ocrPageCount > 0;
  const imageAnalysisProgress = state.ocrBusy ? `
    <div class="image-analysis-progress" role="status">
      <p id="image-analysis-progress-label" aria-live="polite">${escapeHtml(state.ocrStatus || "画像解析の準備をしています")}</p>
      <div class="image-analysis-progress-meter">
        <div class="progress-shell" role="progressbar" aria-label="読み取り済みページ数" aria-valuemin="0" aria-valuemax="${state.ocrTotal}" aria-valuenow="${state.ocrProgress}">
          <div class="progress-bar" id="image-analysis-progress-bar" style="width:${state.ocrTotal ? Math.round((state.ocrProgress / state.ocrTotal) * 100) : 0}%"></div>
        </div>
        <span id="image-analysis-progress-count" aria-hidden="true">読み取り済み ${state.ocrProgress} / ${state.ocrTotal} ページ</span>
      </div>
      <button class="text-button" data-action="cancel-ocr">キャンセル</button>
    </div>` : "";
  const glyphRows = glyphs.map((entry) => {
    const block = rawBlocks().find((item) => item.id === entry.exampleBlockId);
    return `<article class="glyph-row"><div class="glyph-sample"><span class="glyph-character">${escapeHtml(entry.character)}</span><span class="glyph-count">${entry.count.toLocaleString("ja-JP")} 回</span></div><div class="glyph-context"><span class="small-label">p.${entry.examplePage} の例</span><p>${escapeHtml(entry.example)}</p><button class="text-button" data-action="preview-block" data-block-id="${escapeHtml(entry.exampleBlockId)}">${block ? escapeHtml(blockPosition(block)) : `p.${entry.examplePage}`} のPDFを見る</button></div><label class="glyph-replacement">正しい文字<input class="text-input" type="text" maxlength="8" data-correction-char="${escapeHtml(entry.character)}" value="${escapeHtml(state.corrections[entry.character] ?? "")}" placeholder="PDFを見て入力" /></label></article>`;
  }).join("");
  return `
    <div class="reading-support">
      ${needsReview ? `<section class="alert alert-warning correction-warning" role="alert" aria-labelledby="correction-warning-heading">
        <h2 id="correction-warning-heading" class="correction-warning-title">読み取り結果を確認してください</h2>
        <p class="correction-warning-description">${glyphs.length > 0 ? `${occurrenceCount.toLocaleString("ja-JP")} か所に、PDFの表示と違う文字が含まれるかもしれません。` : "画像解析で読み直した文字を含みます。役名や練習する行を確認してください。"}</p>
        <p class="correction-warning-description">文字を置き換えるか、画像解析で読み直せます。</p>
      </section>` : ""}
      <section class="panel glyph-panel" aria-labelledby="glyph-panel-heading">
        <div class="panel-heading"><div><h2 id="glyph-panel-heading">文字の置き換え</h2></div>${glyphs.length > 0 ? `<span class="count-pill">${glyphs.length} 種類 · 未設定 ${unresolved}</span>` : ""}</div>
        ${savedCorrectionCount > 0 ? `<div class="saved-corrections-option"><p>このPDFで保存した置き換え（${savedCorrectionCount} 種類）</p><button class="text-button" data-action="restore-saved-corrections">前回の置き換えを使う</button></div>` : ""}
        ${hasOcrSupport ? `<section class="image-analysis-section" aria-labelledby="image-analysis-heading"><h3 id="image-analysis-heading">画像解析で文字を読み直す</h3>${ocrCandidateCount > 0 ? `<p>PDFの見た目を確かめて、最初に読めなかった文字を補います。ページ数によっては数分かかります。</p>` : `<p>画像解析で読み直した文字を使っています。</p>`}${imageAnalysisProgress}${state.cachedOcrPages.length > 0 ? `<p class="image-analysis-history-copy">前回の結果（${state.cachedOcrPages.length} ページ）を使えます。</p>` : ""}<div class="image-analysis-actions">${state.cachedOcrPages.length > 0 ? `<button class="primary-button" data-action="use-previous-image-analysis" ${state.ocrBusy ? "disabled" : ""}>前回の結果を使う</button>` : ""}${ocrCandidateCount > 0 && !state.ocrBusy ? `<button class="secondary-button" data-action="read-with-ocr">画像解析して読み直す（${ocrCandidateCount} ページ）</button>` : ""}${ocrPageCount > 0 ? `<button class="text-button" data-action="restore-pdf-text">PDFから取り出した文字に戻す</button>` : ""}</div>${ocrCandidateCount > 0 ? `<p class="image-analysis-local-note">画像解析はこのブラウザ内で行います。</p>` : ""}</section>` : ""}
        ${glyphs.length > 0 ? `<details class="glyph-replacements-details"><summary>文字ごとに確認して置き換える（${glyphs.length} 種類）</summary><div class="glyph-list">${glyphRows}</div><p class="glyph-footnote">PDFに書かれた文字を見て、正しい字が分かるものだけ入力してください。置き換えはこの画面にだけ反映します。</p></details>` : `<p class="glyph-empty-state">置き換えが必要な文字はありません。</p>`}
      </section>
      ${state.ocrError ? `<div class="alert alert-warning image-analysis-error" role="alert">${escapeHtml(state.ocrError)}</div>` : ""}
    </div>`;
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
      ? "配置から候補"
      : role.evidence === "recovered"
        ? "文字の対応を要確認"
        : "名前と記号から候補";
  return `
    <article class="role-card ${selected ? "role-card-selected" : ""}">
      <div class="role-card-top"><span class="role-badge">${evidenceLabel}${role.manual ? "" : ` · ${role.occurrenceCount} 回`}</span><button class="secondary-button small-button remove-role-button" data-action="remove-role" data-role-id="${escapeHtml(role.id)}">候補から外す</button></div>
      <label class="field-label">画面に表示する役名<input class="text-input" type="text" data-role-label="${escapeHtml(role.id)}" value="${escapeHtml(role.label)}" maxlength="24" /></label>
      <label class="field-label">台本に書かれた名前（表記は「、」で区切る）<input class="text-input" type="text" data-role-aliases="${escapeHtml(role.id)}" value="${escapeHtml(role.aliases.join("、"))}" maxlength="120" /></label>
      <div class="role-card-meta"><span>セリフ候補 <strong>${count}</strong></span>${example[0] ? `<button class="text-button" data-action="preview-block" data-block-id="${escapeHtml(example[0].id)}">例を見る · ${escapeHtml(blockPosition(example[0]))}</button>` : ""}</div>
      ${example.length > 1 ? `<p class="role-example">例：${escapeHtml(example[1].text.slice(0, 52))}${example[1].text.length > 52 ? "…" : ""}</p>` : ""}
      <button class="role-select-button ${selected ? "primary-button" : "secondary-button"}" data-action="select-role" data-role-id="${escapeHtml(role.id)}" aria-pressed="${selected}">${selected ? "選択中" : "この役を選ぶ"}</button>
    </article>`;
}

function renderPageBlocks(pageNumber: number): string {
  const page = state.pages.find((candidate) => candidate.pageNumber === pageNumber);
  if (!page || page.blocks.length === 0) return `<p class="muted-copy">このページから読める文字はありません。</p>`;
  const sourceNote = page.textSource === "ocr"
    || page.blocks.some((block) => block.recognitionConfidence !== undefined)
    ? `<p class="image-analysis-page-note">画像解析で読み直した行を含みます。元のPDFと照らし合わせてください。</p>`
    : "";
  const allBlocks = blocks();
  const pageBlocks = allBlocks.filter((block) => block.pageNumber === pageNumber);
  const blockIndexById = new Map(allBlocks.map((block, index) => [block.id, index]));
  const turnByBlockId = new Map<string, SpeakerTurn>();
  const turnStartsByBlockId = new Set<string>();
  for (const turn of turns()) {
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
    const startsSpeech = !standalone && Boolean(
      block.speakerLabel || cueAtStart(block.text, recoveredOpeningMarkers) || turnStartsByBlockId.has(block.id),
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
    const hasText = visibleBlocks.some((block) => block.text.trim());
    const hasSuffix = group.blocks.some((block) => block.isSpeakerSuffix);
    if (!hasText && !hasSuffix) return "";
    const position = blockRangePosition(firstBlock, lastBlock);
    const firstIndex = blockIndexById.get(firstBlock.id);
    const turnStartsHere = firstIndex !== undefined && firstIndex === group.turn?.startIndex;
    const cue = cueAtStart(firstBlock.text, recoveredOpeningMarkers);
    const sourceSpeakerLabel = firstBlock.coSpeakers && firstBlock.coSpeakers.length > 1
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
    const text = visibleBlocks.map((block) => block.text).join("");
    const suffixNotes = group.blocks
      .filter((block) => block.isSpeakerSuffix)
      .map((block) => `<small class="extracted-suffix-note">「${escapeHtml(block.rawText.trim())}」を隣の役名「${escapeHtml(block.speakerAliases?.[0] ?? "")}」の一部として扱っています。</small>`)
      .join("");

    return `<article class="extracted-line"><span>${escapeHtml(position)}</span><div><p>${displayLabel}${renderScriptContent(text || "（文字なし）")}</p>${suffixNotes}</div></article>`;
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
    ? `p.${first.pageNumber} · 右から${first.orderOnPage}〜${last.orderOnPage}列目`
    : `p.${first.pageNumber} · 上から${first.orderOnPage}〜${last.orderOnPage}行目`;
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
      ${renderStepHeader("シーンを選ぶ", `練習する役：${role?.label ?? "未選択"}`)}
      <div class="scene-explainer"><p>番号付きの区切りで分けた練習シーンです。前後の範囲は練習画面で調整できます。</p></div>
      ${targets.length === 0 ? `<div class="empty-state"><strong>この役のシーンを見つけられませんでした</strong><p>読み取り結果に戻り、役名とセリフの対応を見直してください。</p><button class="secondary-button" data-action="back-to-analysis">読み取り結果へ戻る</button></div>` : `<div class="appearance-groups">${[...groups.entries()].map(([sceneLabel, sceneTargets]) => `
        <section class="scene-group">
          <div class="scene-heading"><span>台本の区切り</span><h2>${escapeHtml(sceneLabel)}</h2><span class="scene-unit-count">練習シーン ${sceneTargets.length} 件</span></div>
          <div class="appearance-list">${sceneTargets.map((target) => {
            const index = targets.findIndex((item) => item.id === target.id);
            const openingLine = appearanceOpeningLine(target, allBlocks, allTurns);
            return `<article class="appearance-row">
              <div class="appearance-copy"><span class="small-label">練習シーン ${index + 1} · ${escapeHtml(formatPageRange(target.turn.startPage, target.turn.endPage))}</span><p class="appearance-opening-line">${escapeHtml(openingLine || "前のセリフが見つかりません")}</p></div>
              <button class="secondary-button appearance-start" data-action="start-practice" data-target-index="${index}" ${state.practiceSaveBusy ? "disabled" : ""}>このシーンから始める</button>
            </article>`;
          }).join("")}</div>
        </section>`).join("")}</div>`}
      <div class="bottom-actions sticky-action-bar"><button class="text-button" data-action="back-to-analysis">読み取り結果を再確認する</button><button class="primary-button" data-action="start-practice" data-target-index="${state.practiceHasStarted ? Math.min(state.currentTargetIndex, Math.max(0, targets.length - 1)) : 0}" ${targets.length === 0 || state.practiceSaveBusy ? "disabled" : ""}>続きから始める</button></div>
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
  const cue = cueAtStart(speechText, recoveredOpeningMarkers);
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
  if (!target || !role) return `<main class="narrow-page"><p>練習するシーンを選んでください。</p><button class="secondary-button" data-action="back-to-appearances">シーン一覧へ戻る</button></main>`;

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
      ${glyphCorrectionsExist ? `<p class="${practiceStyles.correctionReminder}">読み取りの文字置き換えを表示に反映しています。元のPDFは変更していません。</p>` : ""}
      <div class="${practiceStyles.layout}">
        <section class="${practiceStyles.card}">
          <div class="${practiceStyles.cardHeading}"><span class="small-label">${state.revealed ? "答え" : "ここまでのセリフとト書き"}</span><span class="${practiceStyles.pageTag}">${escapeHtml(pageRange)}</span></div>
          ${contextHtml ? `<div class="${practiceStyles.scriptStream} ${practiceStyles.contextStream}" id="context-stream">${contextHtml}</div>` : `<div class="${practiceStyles.noContext}"><p>このシーンより前のセリフやト書きが見つかりませんでした。</p></div>`}
          ${state.revealed ? `<div class="${practiceStyles.revealedAnswer}" id="revealed-answer">${afterHtml}</div>` : `
            <div class="${practiceStyles.answerPrompt}" aria-live="polite">
              <button class="primary-button ${practiceStyles.revealButton}" data-action="reveal">確認する</button>
            </div>`}
          <details class="${practiceStyles.rangeDetails}">
            <summary>表示するセリフの範囲を調整</summary>
            <div class="${practiceStyles.rangeControls}">
              <label class="${practiceStyles.rangeControl}"><span>前のセリフやト書きをどこから表示するか</span><input class="${practiceStyles.rangeSlider}" type="range" min="${target.minimumStartIndex}" max="${target.turn.startIndex}" value="${range.start}" data-range-start="${escapeHtml(target.id)}" /><small id="range-start-label">${escapeHtml(positionAt(allBlocks, range.start))}</small></label>
              <label class="${practiceStyles.rangeControl}"><span>確認後、どこまで続けて表示するか</span><input class="${practiceStyles.rangeSlider}" type="range" min="${target.defaultEndIndex}" max="${Math.max(target.defaultEndIndex, allBlocks.length - 1)}" value="${range.end}" data-range-end="${escapeHtml(target.id)}" /><small id="range-end-label">${escapeHtml(positionAt(allBlocks, range.end))}</small></label>
              <button class="text-button ${practiceStyles.resetRange}" data-action="reset-range" data-target-id="${escapeHtml(target.id)}">最初の範囲に戻す</button>
            </div>
          </details>
        </section>
        <aside class="${practiceStyles.sidePanel}">
          <div class="${practiceStyles.sideCard} ${practiceStyles.progressCard}"><span class="small-label">練習の進み具合</span><div class="${practiceStyles.miniProgress}"><span style="width:${Math.round(((state.currentTargetIndex + 1) / Math.max(1, targets.length)) * 100)}%"></span></div><p>${state.currentTargetIndex + 1} / ${targets.length} シーン</p></div>
          ${state.revealed ? `<div class="${practiceStyles.sideCard} ${practiceStyles.sourceCard}"><span class="small-label">元のPDF</span><p>このシーンのページを開いて確認できます。</p><button class="secondary-button" data-action="toggle-source">${state.showOriginal ? "PDFを閉じる" : "PDFを見る"}</button></div>` : `<div class="${practiceStyles.sideCard} ${practiceStyles.sourceCard}"><span class="small-label">元のPDF</span><p>答えを確認すると、該当ページを開けます。</p><button class="secondary-button" disabled>確認後に表示</button></div>`}
        </aside>
      </div>
      ${state.showOriginal ? `<section class="panel ${practiceStyles.sourcePreview}"><div class="source-toolbar"><div><span class="small-label">元のPDF · ${state.originalPage} ページ</span><h2>原稿を確認する</h2></div><label>ページ<select class="select-input" id="original-page-select">${state.pages.map((page) => `<option value="${page.pageNumber}" ${page.pageNumber === state.originalPage ? "selected" : ""}>${page.pageNumber} ページ</option>`).join("")}</select></label></div><div class="pdf-canvas-scroll"><canvas id="page-canvas" aria-label="元のPDFのページ"></canvas></div></section>` : ""}
      ${!target.nextTurn && state.revealed ? `<p class="alert alert-warning ${practiceStyles.lastUtteranceNote}">${escapeHtml(role.label)}の次のセリフを見つけられませんでした。読み取り結果で役名を確認してください。</p>` : ""}
      <p class="${practiceStyles.keyboardHelp}">キー操作：← 前のシーン　→ 確認／次のシーン　R もう一度</p>
      <nav class="${practiceStyles.navigation}" aria-label="練習の操作">
        <button class="secondary-button" data-action="back-to-appearances">シーンを選ぶ</button>
        <button class="secondary-button" data-action="previous-target" ${state.currentTargetIndex === 0 ? "disabled" : ""}>前のシーン</button>
        <button class="secondary-button" data-action="repeat-target">同じシーンをもう一度</button>
        <button class="primary-button" data-action="next-target" ${!state.revealed ? "disabled" : ""}>${state.currentTargetIndex + 1 >= targets.length ? "シーン一覧へ" : "次のシーン"}</button>
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
    : `<div class="${practiceStyles.nextSpeechMissing}"><span class="small-label">次のセリフ</span><p>続くセリフを見つけられませんでした。</p></div>`;
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
    const separator = firstBlock.direction === "vertical" ? "" : "\\n";
    const text = group.blocks.map((block) => block.text).join(separator);
    return `
      <article class="${practiceStyles.scriptBlock}${variantClass ? ` ${variantClass}` : ""}" data-page="${firstBlock.pageNumber}">
        <span class="${practiceStyles.scriptPosition}">${escapeHtml(practiceRangePosition(firstBlock, lastBlock))}</span>
        <p dir="auto">${renderScriptContent(text)}</p>
      </article>`;
  }).join("");
}

function renderScriptContent(text: string): string {
  return splitStageDirectionText(text, usableRoleCandidates())
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
  return block ? blockPosition(block) : "位置を確認できません";
}

function roleLabel(roleId: string): string {
  return state.roles.find((role) => role.id === roleId)?.label ?? "役名未確認";
}

function formatPageRange(start: number, end: number): string {
  return start === end ? `p.${start}` : `p.${start}–${end}`;
}

function refreshAutomaticRoles(): void {
  const existing = new Map(state.roles.map((role) => [role.id, role]));
  const automatic = detectRoleCandidates(blocks())
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
  state.progressLabel = "PDFを開いています";
  renderApp();

  try {
    const loaded = await loadPdf(file, (pageNumber, pageCount) => {
      state.progress = Math.round((pageNumber / pageCount) * 100);
      state.progressLabel = `${pageNumber} / ${pageCount} ページを確認中`;
      const bar = document.querySelector<HTMLDivElement>("#load-progress-bar");
      const label = document.querySelector<HTMLElement>("#load-progress-label");
      if (bar) bar.style.width = `${state.progress}%`;
      if (label) label.textContent = state.progressLabel;
    });

    state.document = loaded.document;
    state.disposePdf = loaded.dispose;
    state.pages = loaded.pages;
    state.originalPages = [...loaded.pages];
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
    state.ocrError = "";
    refreshAutomaticRoles();
    state.screen = "analysis";
    state.loading = Boolean(requestedResumeFingerprint);
    if (requestedResumeFingerprint) {
      state.loadingPurpose = "restoring-practice";
      state.progress = 100;
      state.progressLabel = "練習設定を確認しています";
    }
    renderApp();
    await findSavedPractice(loaded.fingerprint, loaded.pages.length, requestedResumeFingerprint);
  } catch {
    state.loading = false;
    state.error = "このPDFを読み取れませんでした。パスワードで保護されている場合は、保護を解除したPDFを選んでください。";
    if (requestedResumeFingerprint) notify("このPDFを読み取れなかったため、前回の練習設定を使えませんでした。", "warning");
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
      notify("このPDFを照合できないため、保存した練習設定を使えませんでした。", "warning");
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
    notify("このブラウザに保存した設定を読み込めませんでした。PDFは通常どおり使えます。", "warning");
  }

  await refreshSavedPracticeList();
  if (state.pdfFingerprint === fingerprint) {
    await keepRestorationVisible();
    state.loading = false;
    if (requestedResumeFingerprint && state.screen !== "appearances") state.screen = "analysis";
    if (restoredPreviousImageAnalysis) {
      notify("前回の画像解析結果を適用しました。役名を選んで練習を始めてください。", "success");
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
      ? "役の設定は戻しました。文字の読み取り方法が変わったため、画像解析をやり直してください。"
      : "前回の練習設定は読み込みましたが、シーンが見つかりませんでした。読み取り結果を確認してください。", "warning");
  } else {
    state.currentTargetIndex = Math.min(Math.max(0, saved.settings.currentTargetIndex), targetCount - 1);
    state.screen = "appearances";
    state.practiceHasStarted = true;
    notify(outdatedRecognition
      ? `前回の「${selectedRole()?.label ?? "選んだ役"}」の設定を戻しました。画像解析は設定からやり直せます。`
      : `前回の「${selectedRole()?.label ?? "選んだ役"}」の設定で、続きから練習できます。`, outdatedRecognition ? "info" : "success");
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
      manualRoleNumber: state.manualRoleNumber,
      corrections: { ...state.corrections },
      ranges: structuredClone(state.ranges),
      currentTargetIndex: state.currentTargetIndex,
      previewPage: state.previewPage,
    },
  };
}

async function saveCurrentPractice(): Promise<SavedPractice> {
  if (!canSavePracticeHistory()) throw new Error("このブラウザでは端末内保存を利用できません。");
  const snapshot = currentPracticeSnapshot();
  if (!snapshot) throw new Error("保存する練習設定が見つかりません。");
  const saved = await savePractice(snapshot);
  state.savedPractice = saved;
  await refreshSavedPracticeList();
  return saved;
}

async function continueToAppearances(): Promise<void> {
  if (practiceTargets().length === 0 || state.ocrBusy || state.practiceSaveBusy) return;
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
    if (saveError) notify("設定を保存できませんでした。前回の保存内容は残っています。", "warning");
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
  if (saveError) notify("練習は続けられますが、この端末に設定を保存できませんでした。", "warning");
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function schedulePracticeSave(): void {
  if (state.screen !== "practice" || !state.savedPractice || state.practiceSaveBusy) return;
  if (practiceSaveTimer !== null) window.clearTimeout(practiceSaveTimer);
  practiceSaveTimer = window.setTimeout(() => {
    practiceSaveTimer = null;
    void saveCurrentPractice().catch(() => {
      notify("練習設定をこの端末に更新できませんでした。", "warning");
      renderApp();
    });
  }, 600);
}

function clearScheduledPracticeSave(): void {
  if (practiceSaveTimer !== null) window.clearTimeout(practiceSaveTimer);
  practiceSaveTimer = null;
}

async function readWithOcr(): Promise<void> {
  if (state.ocrBusy || !state.document) return;
  const candidates = pagesNeedingOcr();
  if (candidates.length === 0) return;

  state.ocrBusy = true;
  state.ocrCancelRequested = false;
  state.ocrProgress = 0;
  state.ocrTotal = candidates.length;
  state.ocrStatus = "画像解析の準備をしています";
  state.ocrError = "";
  renderApp();

  let reader: Awaited<ReturnType<typeof createLocalOcrReader>> | null = null;
  let replacedPages = 0;
  const failedPages: number[] = [];
  const updatedPages = [...state.pages];

  try {
    reader = await createLocalOcrReader((progress: OcrProgress) => {
      state.ocrStatus = readableOcrStatus(progress.status);
      updateOcrProgress();
    });

    for (const sourcePage of candidates) {
      if (state.ocrCancelRequested) break;
      state.ocrStatus = "文字を読み取っています";
      updateOcrProgress();

      try {
        const recognizedPage = await reader.readPage(
          state.document,
          sourcePage.pageNumber,
          sourcePage.direction,
        );
        const mergedPage = mergeRecognizedPage(sourcePage, recognizedPage);
        if (mergedPage === sourcePage) {
          failedPages.push(sourcePage.pageNumber);
        } else {
          updatedPages[sourcePage.pageNumber - 1] = mergedPage;
          replacedPages += 1;
        }
      } catch {
        failedPages.push(sourcePage.pageNumber);
      }

      state.ocrProgress += 1;
      state.ocrStatus = "文字を読み取っています";
      updateOcrProgress();
    }

    if (replacedPages > 0) {
      state.pages = updatedPages;
      state.corrections = {};
      state.manualSpeakers = {};
      state.ranges = {};
      state.currentTargetIndex = 0;
      refreshAutomaticRoles();
    }

    if (state.ocrCancelRequested) {
      state.ocrError = "画像解析を途中で止めました。解析できたページは残っています。";
    } else if (failedPages.length > 0) {
      const pageList = failedPages.slice(0, 6).map((page) => `p.${page}`).join("、");
      const remaining = failedPages.length > 6 ? ` ほか ${failedPages.length - 6} ページ` : "";
      state.ocrError = `${failedPages.length} ページを解析できませんでした（${pageList}${remaining}）。元の文字抽出を表示しています。`;
    } else if (replacedPages === 0) {
      state.ocrError = "文字を読み直せませんでした。元のPDFと見比べ、役名や文字を確認してください。";
    }
  } catch {
    state.ocrError = "画像解析を完了できませんでした。元の文字抽出は残っています。";
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
  if (count) count.textContent = `読み取り済み ${state.ocrProgress} / ${state.ocrTotal} ページ`;
  if (bar) {
    const percent = state.ocrTotal > 0
      ? Math.round((state.ocrProgress / state.ocrTotal) * 100)
      : 0;
    bar.style.width = `${percent}%`;
    const progress = bar.closest<HTMLElement>("[role='progressbar']");
    progress?.setAttribute("aria-valuenow", String(state.ocrProgress));
  }
}

function restorePdfText(): void {
  if (state.ocrBusy || state.originalPages.length === 0) return;
  state.pages = [...state.originalPages];
  state.corrections = {};
  state.manualSpeakers = {};
  state.ranges = {};
  state.currentTargetIndex = 0;
  state.ocrError = "";
  refreshAutomaticRoles();
  renderApp();
}

function applyCachedImageAnalysis(showNotification = true): void {
  if (state.ocrBusy || state.cachedOcrPages.length === 0) return;
  const savedPages = new Map(state.cachedOcrPages.map((page) => [page.pageNumber, page]));
  state.pages = state.pages.map((page) => {
    const saved = savedPages.get(page.pageNumber);
    return saved ? mergeRecognizedPage(page, saved) : page;
  });
  state.corrections = {};
  state.manualSpeakers = {};
  state.ranges = {};
  state.currentTargetIndex = 0;
  state.selectedRoleId = "";
  state.previewPage = state.cachedOcrPages[0]?.pageNumber ?? state.previewPage;
  state.ocrError = "";
  state.cachedOcrPages = [];
  if (showNotification) notify("前回の画像解析結果を適用しました。役名を選んで練習を始めてください。", "success");
  refreshAutomaticRoles();
  renderApp();
}

function restoreSavedCorrections(): void {
  const savedCorrections = state.savedPractice?.settings.corrections;
  if (!savedCorrections || Object.keys(savedCorrections).length === 0) return;
  state.corrections = { ...savedCorrections, ...state.corrections };
  notify("前回の文字の置き換えを読み込みました。", "success");
  refreshAutomaticRoles();
  renderApp();
}

async function deleteAllSavedPracticeDataFromDevice(): Promise<void> {
  if (state.savedPractices.length + state.legacySavedReadings.length === 0 || state.ocrBusy || state.practiceSaveBusy) return;
  if (!window.confirm("この端末に保存した練習設定と読み取り結果をすべて削除しますか？PDFファイルは削除されません。")) return;
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
  state.ocrError = "";
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
      void readWithOcr();
      break;
    case "cancel-ocr":
      state.ocrCancelRequested = true;
      state.ocrStatus = "現在のページを解析した後に止めます";
      updateOcrProgress();
      break;
    case "restore-pdf-text":
      restorePdfText();
      break;
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
    if (replacement.trim()) state.corrections[character] = replacement;
    else delete state.corrections[character];
    refreshAutomaticRoles();
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "preview-page-select") {
    goToPreviewPage(Number(target.value));
    return;
  }

  if (target instanceof HTMLSelectElement && target.id === "original-page-select") {
    state.originalPage = Number(target.value);
    renderApp();
    return;
  }

});

root.addEventListener("input", (event) => {
  const target = event.target;
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
