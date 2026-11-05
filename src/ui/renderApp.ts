// HTML rendering and DOM-specific interactions for the current screen.

import { appRoot as root, appState as state } from "./appRoot";
import { renderNotification } from "./notifications";
import { previewCanvasRenderKey, renderPdfPreview } from "./pdfPreview";
import {
  type RenderState,
  renderStateFor,
  setRenderCallback,
  syncEditorHighlights,
} from "./renderState";
import { renderAnalysisScreen } from "./screens/analysis/screen";
import { renderAppearancesScreen } from "./screens/appearances/screen";
import { renderHome } from "./screens/home/screen";
import {
  createPracticeScreenContext,
  type PracticeScreenContext,
} from "./screens/practice/context";
import { renderPracticeScreen } from "./screens/practice/screen";
import { renderBoundaryEditor } from "./scriptEditor";
import { escapeHtml } from "./shared/escapeHtml";

export function bindRenderLifetime(signal: AbortSignal): void {
  const renderState = renderStateFor(state);
  signal.addEventListener(
    "abort",
    () => {
      renderState.previewTask?.cancel();
      renderState.previewTask = null;
      renderState.previewGeneration += 1;
      renderState.editorResizeObserver.disconnect();
      renderState.practiceScreenContext?.dispose();
      renderState.practiceScreenContext = null;
      if (renderState.notificationTimer !== null)
        window.clearTimeout(renderState.notificationTimer);
      renderState.notificationTimer = null;
      state.notification = null;
    },
    { once: true },
  );
}

export function renderApp(): void {
  const renderState = renderStateFor(state);
  const practiceContext = syncPracticeScreenContext(renderState);
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
    state.screen === "practice"
      ? (practiceContext?.originalPage ?? 1)
      : root.pdfWorkspace.analysis.previewPage;
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

  root.innerHTML = [
    renderTopbar(),
    renderScreen(practiceContext),
    renderNotification(),
  ].join("");
  for (const id of openEditors) {
    const editor = root.querySelector<HTMLDetailsElement>(`#${id}`);
    if (editor) editor.open = true;
  }
  const textEditor = root.querySelector<HTMLTextAreaElement>(
    "#full-script-editor",
  );
  renderState.editorResizeObserver.disconnect();
  if (textEditor) {
    textEditor.scrollTop = previousEditorScroll;
    renderState.editorResizeObserver.observe(textEditor);
    syncEditorHighlights();
  }
  root
    .querySelector("main")
    ?.toggleAttribute("inert", root.pdfWorkspace.practice.practiceSaveBusy);
  root.dataset.screen = state.loading ? "loading" : state.screen;
  const requestedPage =
    state.screen === "practice"
      ? (practiceContext?.originalPage ?? 1)
      : root.pdfWorkspace.analysis.previewPage;
  const newCanvas = root.querySelector<HTMLCanvasElement>("#page-canvas");
  const newCanvasContainer = newCanvas?.parentElement;
  const canReuseCanvas = Boolean(
    previousCanvas &&
      newCanvas &&
      previousCanvasKey ===
        previewCanvasRenderKey(
          requestedPage,
          root.pdfWorkspace.analysis.previewZoom,
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
    (state.screen === "practice" && practiceContext?.showOriginal === true)
  ) {
    if (!canReuseCanvas) requestAnimationFrame(() => void renderPdfPreview());
  }
}

function syncPracticeScreenContext(
  renderState: RenderState,
): PracticeScreenContext | null {
  const isPracticeScreen =
    !state.loading &&
    !(state.error && root.pdfWorkspace.script.pages.length === 0) &&
    state.screen === "practice";
  if (!isPracticeScreen) {
    renderState.practiceScreenContext?.dispose();
    renderState.practiceScreenContext = null;
    return null;
  }

  if (!renderState.practiceScreenContext) {
    renderState.practiceScreenContext = createPracticeScreenContext({
      render: renderApp,
      scrollToSourceReview,
    });
  }
  return renderState.practiceScreenContext;
}

function renderTopbar(): string {
  const hasPdf = root.pdfWorkspace.script.pages.length > 0;
  return `
    <header class="topbar">
      <span class="brand">
        <span class="brand-name">おぼえる台本</span>
      </span>
      <div class="topbar-right">
        ${hasPdf ? `<button class="secondary-button quiet-button close-script" data-action="close-pdf" ${state.loading || root.pdfWorkspace.analysis.ocrBusy || root.pdfWorkspace.practice.practiceSaveBusy ? "disabled" : ""}>台本を閉じる</button>` : ""}
      </div>
    </header>`;
}

function renderScreen(practiceContext: PracticeScreenContext | null): string {
  if (state.loading) return renderLoading();
  if (state.error && root.pdfWorkspace.script.pages.length === 0)
    return renderLoadError();
  switch (state.screen) {
    case "analysis":
      return renderAnalysisScreen(renderBoundaryEditor);
    case "appearances":
      return renderAppearancesScreen();
    case "practice":
      return practiceContext ? renderPracticeScreen(practiceContext) : "";
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

export function scrollToSourceReview(): void {
  requestAnimationFrame(() =>
    document
      .querySelector("#source-review")
      ?.scrollIntoView({ behavior: "smooth", block: "start" }),
  );
}

setRenderCallback(renderApp);
