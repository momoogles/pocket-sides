// PDF canvas preview rendering and page navigation.

import { appRoot as root, appState as state } from "./appRoot";
import { renderStateFor, requestRender } from "./renderState";

export function cancelPdfPreview(): void {
  const renderState = renderStateFor(state);
  renderState.previewGeneration += 1;
  renderState.previewTask?.cancel();
  renderState.previewTask = null;
}

export function previewCanvasRenderKey(
  pageNumber: number,
  zoom: number,
  width: number,
  pixelRatio: number,
): string {
  return `${pageNumber}:${zoom}:${Math.max(280, width - 28)}:${Math.min(2, pixelRatio)}`;
}

export function goToPreviewPage(pageNumber: number): void {
  const nextPage = Math.max(
    1,
    Math.min(root.pdfWorkspace.script.pages.length, pageNumber),
  );
  if (nextPage === root.pdfWorkspace.analysis.previewPage) return;
  root.pdfWorkspace.analysis.previewPage = nextPage;

  requestRender();
}

export async function renderPdfPreview(): Promise<void> {
  const renderState = renderStateFor(state);
  const pdfWorkspace = root.pdfWorkspace;
  const pdfDocument = pdfWorkspace.file.document;
  if (!pdfDocument) return;
  const canvas = document.querySelector<HTMLCanvasElement>("#page-canvas");
  const container = canvas?.parentElement;
  if (!canvas || !container) return;
  const requestedPage =
    state.screen === "practice"
      ? (renderState.practiceScreenContext?.originalPage ?? 1)
      : pdfWorkspace.analysis.previewPage;
  const generation = ++renderState.previewGeneration;
  renderState.previewTask?.cancel();
  renderState.previewTask = null;

  try {
    const page = await pdfDocument.getPage(requestedPage);
    if (
      generation !== renderState.previewGeneration ||
      root.pdfWorkspace !== pdfWorkspace
    )
      return;
    const fitViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(280, container.clientWidth - 28);
    const scale =
      Math.min(1.5, availableWidth / fitViewport.width) *
      pdfWorkspace.analysis.previewZoom;
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(2, window.devicePixelRatio || 1);
    const renderKey = previewCanvasRenderKey(
      requestedPage,
      pdfWorkspace.analysis.previewZoom,
      container.clientWidth,
      outputScale,
    );
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    renderState.previewTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform:
        outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      background: "#ffffff",
    });
    await renderState.previewTask.promise;
    if (
      generation === renderState.previewGeneration &&
      root.pdfWorkspace === pdfWorkspace
    )
      canvas.dataset.renderKey = renderKey;
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
