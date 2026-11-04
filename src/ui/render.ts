// HTML rendering and DOM-specific interactions for the current screen.
import type { PDFPageProxy } from "pdfjs-dist";
import { blocks, turns } from "../app/script-model";
import { type NotificationTone, state } from "../app/state";
import type { BoundaryEdit } from "../pdf/boundaries";
import { isPlausibleSpeakerLabel, normalizeAlias } from "../pdf/segments";
import type { SourceBlock } from "../pdf/types";
import { escapeHtml } from "./html";
import { root } from "./root";
import { renderAnalysisScreen } from "./screens/analysis-screen";
import { renderAppearancesScreen } from "./screens/appearances-screen";
import { renderHome } from "./screens/home-screen";
import { renderPracticeScreen } from "./screens/practice-screen";

let previewTask: ReturnType<PDFPageProxy["render"]> | null = null;

let boundaryDraft: { source: string; text: string } | null = null;

let previewGeneration = 0;

let notificationTimer: number | null = null;

let notificationSequence = 0;

export function setBoundaryDraft(draft: {
  source: string;
  text: string;
}): void {
  boundaryDraft = draft;
}

export function resetBoundaryDraft(): void {
  boundaryDraft = null;
}

export function cancelPdfPreview(): void {
  previewTask?.cancel();
}

export function notify(message: string, tone: NotificationTone = "info"): void {
  if (notificationTimer !== null) window.clearTimeout(notificationTimer);
  const id = ++notificationSequence;
  state.notification = { id, message, tone };
  notificationTimer = window.setTimeout(
    () => {
      if (state.notification?.id !== id) return;
      state.notification = null;
      notificationTimer = null;
      renderApp();
    },
    tone === "warning" ? 7000 : 4500,
  );
}

export function clearNotification(): void {
  if (notificationTimer !== null) window.clearTimeout(notificationTimer);
  notificationTimer = null;
  state.notification = null;
}

export function renderApp(): void {
  const previousCanvas = root.querySelector<HTMLCanvasElement>("#page-canvas");
  const previousCanvasKey = previousCanvas?.dataset.renderKey;
  const previousCanvasScroll = {
    left: previousCanvas?.parentElement?.scrollLeft ?? 0,
    top: previousCanvas?.parentElement?.scrollTop ?? 0,
  };
  const editorIds = ["manual-boundary-editor", "manual-glyph-editor"];
  const openEditors = editorIds.filter(
    (id) => root.querySelector<HTMLDetailsElement>(`#${id}`)?.open,
  );
  const previousEditorScroll =
    root.querySelector<HTMLTextAreaElement>("#full-script-editor")?.scrollTop ??
    0;
  const previousExtractedScroll =
    root.querySelector<HTMLElement>(".extracted-lines")?.scrollTop ?? 0;
  const previousPage =
    state.screen === "practice" ? state.originalPage : state.previewPage;
  const previousScreen = root.dataset.screen;
  const previousScroll = { left: window.scrollX, top: window.scrollY };
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const focusTarget =
    activeElement && root.contains(activeElement)
      ? {
          id: activeElement.id,
          action: activeElement.dataset.action,
          roleId: activeElement.dataset.roleId,
          blockId: activeElement.dataset.blockId,
        }
      : null;

  root.innerHTML = [renderTopbar(), renderScreen(), renderNotification()].join(
    "",
  );
  for (const id of openEditors) {
    const editor = root.querySelector<HTMLDetailsElement>(`#${id}`);
    if (editor) editor.open = true;
  }
  const textEditor = root.querySelector<HTMLTextAreaElement>(
    "#full-script-editor",
  );
  scriptEditorResizeObserver.disconnect();
  if (textEditor) {
    textEditor.scrollTop = previousEditorScroll;
    scriptEditorResizeObserver.observe(textEditor);
    syncEditorHighlights();
  }
  root.querySelector("main")?.toggleAttribute("inert", state.practiceSaveBusy);
  root.dataset.screen = state.loading ? "loading" : state.screen;
  const requestedPage =
    state.screen === "practice" ? state.originalPage : state.previewPage;
  const newCanvas = root.querySelector<HTMLCanvasElement>("#page-canvas");
  const newCanvasContainer = newCanvas?.parentElement;
  const canReuseCanvas = Boolean(
    previousCanvas &&
      newCanvas &&
      previousCanvasKey ===
        previewCanvasRenderKey(
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
    const replacement = selector
      ? root.querySelector<HTMLElement>(selector)
      : null;
    replacement?.focus({ preventScroll: true });
  }

  if (
    state.screen === "analysis" ||
    (state.screen === "practice" && state.showOriginal)
  ) {
    if (!canReuseCanvas) requestAnimationFrame(() => void renderPdfPreview());
  }
}

function previewCanvasRenderKey(
  pageNumber: number,
  zoom: number,
  width: number,
  pixelRatio: number,
): string {
  return `${pageNumber}:${zoom}:${Math.max(280, width - 28)}:${Math.min(2, pixelRatio)}`;
}

export function goToPreviewPage(pageNumber: number): void {
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
      return renderAnalysisScreen(renderBoundaryEditor);
    case "appearances":
      return renderAppearancesScreen();
    case "practice":
      return renderPracticeScreen();
    case "home":
    default:
      return renderHome();
  }
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

interface ScriptEditorSpan {
  block: SourceBlock;
  start: number;
  end: number;
  prefixLength: number;
  speakerLength: number;
  roleId?: string;
}

export function scriptEditorModel(): {
  text: string;
  spans: ScriptEditorSpan[];
  breaks: Set<number>;
} {
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
    const role = state.roles.find(
      (candidate) => candidate.id === starts.get(index),
    );
    const speakerLength = starts.has(index)
      ? prefix.length ||
        role?.aliases.find((alias) => content.startsWith(alias))?.length ||
        0
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

function renderEditorHighlights(
  text: string,
  model: ReturnType<typeof scriptEditorModel>,
): string {
  if (text.replace(/\n/g, "") !== model.text.replace(/\n/g, ""))
    return escapeHtml(text);
  const labels = new Map(
    model.spans
      .filter((span) => span.speakerLength > 0)
      .map((span) => [span.start, span.speakerLength]),
  );
  const parts: string[] = [];
  let plainOffset = 0;
  let unmarkedStart = 0;
  let index = 0;
  while (index < text.length) {
    const labelLength =
      text[index] === "\n" ? undefined : labels.get(plainOffset);
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
      parts.push(
        `<mark class="inline-role-highlight">${escapeHtml(text.slice(start, index))}</mark>`,
      );
      unmarkedStart = index;
    } else {
      if (text[index] !== "\n") plainOffset += 1;
      index += 1;
    }
  }
  parts.push(escapeHtml(text.slice(unmarkedStart)));
  return parts.join("") + "\n";
}

export function syncEditorHighlights(): void {
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  const highlights = root.querySelector<HTMLElement>("#full-script-highlights");
  const content = highlights?.firstElementChild;
  if (!editor || !highlights || !(content instanceof HTMLElement)) return;
  content.style.width = `${editor.clientWidth}px`;
  highlights.scrollTop = editor.scrollTop;
  highlights.scrollLeft = editor.scrollLeft;
}

const scriptEditorResizeObserver = new ResizeObserver(syncEditorHighlights);

export function hideScriptSelectionToolbar(): void {
  const toolbar = root.querySelector<HTMLElement>("#script-selection-toolbar");
  if (toolbar) toolbar.hidden = true;
}

export function showScriptSelectionToolbar(point?: {
  x: number;
  y: number;
}): void {
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  const toolbar = root.querySelector<HTMLElement>("#script-selection-toolbar");
  const label = root.querySelector<HTMLElement>("#script-selection-label");
  if (!editor || !toolbar || !label || state.ocrBusy) return;
  const model = scriptEditorModel();
  if (editor.selectionStart === editor.selectionEnd) {
    const plainOffset = editor.value
      .slice(0, editor.selectionStart)
      .replace(/\n/g, "").length;
    const span = model.spans.find(
      (item) =>
        item.speakerLength > 0 &&
        plainOffset >= item.start &&
        plainOffset < item.start + item.speakerLength,
    );
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
  const selected = editor.value.slice(
    editor.selectionStart,
    editor.selectionEnd,
  );
  if (
    !selected ||
    selected.includes("\n") ||
    !isPlausibleSpeakerLabel(selected)
  ) {
    hideScriptSelectionToolbar();
    return;
  }
  const plainStart = editor.value
    .slice(0, editor.selectionStart)
    .replace(/\n/g, "").length;
  const selectedSpeaker = model.spans.find(
    (span) =>
      span.start === plainStart &&
      span.speakerLength === selected.length &&
      span.speakerLength > 0,
  );
  const removeButton = toolbar.querySelector<HTMLButtonElement>(
    '[data-action="unassign-selected-speaker"]',
  );
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

export function unassignSelectedSpeaker(): void {
  if (state.ocrBusy) return;
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  const plainStart = editor.value
    .slice(0, editor.selectionStart)
    .replace(/\n/g, "").length;
  const model = scriptEditorModel();
  const span = model.spans.find(
    (item) =>
      item.start === plainStart &&
      item.speakerLength > 0 &&
      editor.selectionEnd - editor.selectionStart === item.speakerLength,
  );
  if (!span) return;
  state.boundaryEdits = setBoundaryEdit(
    state.boundaryEdits,
    editorPosition(span, span.start),
    null,
  );
  state.ranges = {};
  state.currentTargetIndex = 0;
  boundaryDraft = null;
  const scroll = editor.scrollTop;
  renderApp();
  const updated = root.querySelector<HTMLTextAreaElement>(
    "#full-script-editor",
  );
  if (updated) updated.scrollTop = scroll;
}

function renderBoundaryEditor(): string {
  const model = scriptEditorModel();
  if (boundaryDraft && boundaryDraft.source !== model.text) {
    boundaryDraft = null;
    notify(
      "読み取り結果が変わったため、未反映の改行を元に戻しました。",
      "info",
    );
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

function editorPosition(
  span: ScriptEditorSpan,
  plainOffset: number,
): Omit<BoundaryEdit, "roleId"> {
  const localOffset = plainOffset - span.start;
  const origin = span.block.boundaryOrigin;
  const offset =
    Math.max(0, localOffset - span.prefixLength) +
    (localOffset >= span.prefixLength ? (origin?.labelLength ?? 0) : 0);
  return {
    blockId: origin?.blockId ?? span.block.id,
    text: origin?.text ?? span.block.text,
    offset: (origin?.offset ?? 0) + offset,
  };
}

function setBoundaryEdit(
  edits: BoundaryEdit[],
  position: Omit<BoundaryEdit, "roleId">,
  roleId: string | null,
): BoundaryEdit[] {
  const remaining = edits.filter(
    (edit) =>
      edit.blockId !== position.blockId || edit.offset !== position.offset,
  );
  return roleId || position.offset === 0
    ? [...remaining, { ...position, roleId }]
    : remaining;
}

export function showScriptEditorError(message: string): void {
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  editor.setCustomValidity(message);
  editor.reportValidity();
}

export function applyScriptEditor(assignSpeaker: boolean): void {
  if (state.ocrBusy) return;
  const editor = root.querySelector<HTMLTextAreaElement>("#full-script-editor");
  if (!editor) return;
  editor.setCustomValidity("");
  const model = scriptEditorModel();
  const plain = editor.value.replace(/\n/g, "");
  if (plain !== model.text.replace(/\n/g, "")) {
    showScriptEditorError(
      "ここでは改行を追加・削除できます。本文の文字を元に戻してから適用してください。",
    );
    return;
  }
  const wantedBreaks = new Set<number>();
  let offset = 0;
  for (const character of editor.value) {
    if (character === "\n") wantedBreaks.add(offset);
    else offset += character.length;
  }
  const findSpan = (position: number) =>
    model.spans.find((span) => position >= span.start && position < span.end);
  let edits = [...state.boundaryEdits];
  for (const position of new Set([...model.breaks, ...wantedBreaks])) {
    if (
      model.breaks.has(position) === wantedBreaks.has(position) ||
      position === 0 ||
      position === plain.length
    )
      continue;
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
    const start = editor.value
      .slice(0, editor.selectionStart)
      .replace(/\n/g, "").length;
    const end = editor.value
      .slice(0, editor.selectionEnd)
      .replace(/\n/g, "").length;
    const label = plain.slice(start, end);
    const span = findSpan(start);
    if (
      !span ||
      !label ||
      label !== label.trim() ||
      !isPlausibleSpeakerLabel(label) ||
      end > span.end
    ) {
      showScriptEditorError("役名の文字だけを選択してください。");
      return;
    }
    const withinPrefix =
      start === span.start && end === span.start + span.prefixLength;
    if (start < span.start + span.prefixLength && !withinPrefix) {
      showScriptEditorError("役名は一部ではなく、名前全体を選択してください。");
      return;
    }
    let role = state.roles.find((candidate) =>
      candidate.aliases.some(
        (alias) => normalizeAlias(alias) === normalizeAlias(label),
      ),
    );
    if (!role) {
      state.manualRoleNumber += 1;
      role = {
        id: `manual-${slug(label)}-${state.manualRoleNumber}`,
        label,
        aliases: [label],
        occurrenceCount: 0,
        exampleBlockIds: [],
        manual: true,
        evidence: "manual",
      };
      state.roles.push(role);
    } else if (!role.aliases.includes(label)) {
      role.aliases = [...role.aliases, label];
    }
    const location = editorPosition(span, start);
    edits = setBoundaryEdit(
      edits,
      {
        ...location,
        ...(!withinPrefix || span.block.boundaryOrigin?.labelLength
          ? { speakerText: label }
          : {}),
      },
      role.id,
    );
  }
  state.boundaryEdits = edits;
  state.ranges = {};
  state.currentTargetIndex = 0;
  boundaryDraft = null;
  const caret = editor.selectionStart;
  const scrollTop = editor.scrollTop;
  renderApp();
  const updated = root.querySelector<HTMLTextAreaElement>(
    "#full-script-editor",
  );
  if (updated) {
    updated.focus({ preventScroll: true });
    updated.setSelectionRange(
      Math.min(caret, updated.value.length),
      Math.min(caret, updated.value.length),
    );
    updated.scrollTop = scrollTop;
  }
}

async function renderPdfPreview(): Promise<void> {
  if (!state.document) return;
  const canvas = document.querySelector<HTMLCanvasElement>("#page-canvas");
  const container = canvas?.parentElement;
  if (!canvas || !container) return;
  const requestedPage =
    state.screen === "practice" ? state.originalPage : state.previewPage;
  const generation = ++previewGeneration;
  cancelPdfPreview();

  try {
    const page = await state.document.getPage(requestedPage);
    if (generation !== previewGeneration) return;
    const fitViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(280, container.clientWidth - 28);
    const scale =
      Math.min(1.5, availableWidth / fitViewport.width) * state.previewZoom;
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(2, window.devicePixelRatio || 1);
    const renderKey = previewCanvasRenderKey(
      requestedPage,
      state.previewZoom,
      container.clientWidth,
      outputScale,
    );
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
      transform:
        outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      background: "#ffffff",
    });
    await previewTask.promise;
    if (generation === previewGeneration) canvas.dataset.renderKey = renderKey;
  } catch (error) {
    if (error instanceof Error && error.name === "RenderingCancelledException")
      return;
    const fallback =
      document.querySelector<HTMLDivElement>(".pdf-canvas-scroll");
    if (fallback)
      fallback.insertAdjacentHTML(
        "beforeend",
        `<p class="muted-copy">このページを表示できませんでした。</p>`,
      );
  }
}

export function scrollToSourceReview(): void {
  requestAnimationFrame(() =>
    document
      .querySelector("#source-review")
      ?.scrollIntoView({ behavior: "smooth", block: "start" }),
  );
}

export function slug(value: string): string {
  return Array.from(value)
    .map((character) => (character.codePointAt(0) ?? 0).toString(16))
    .join("-");
}
