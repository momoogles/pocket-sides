// UI-only state that lives with the mounted application element.
import type { PDFPageProxy } from "pdfjs-dist";
import type { AppState } from "../appState";
import { appRoot as root } from "./appRoot";
import type { PracticeScreenContext } from "./screens/practice/context";

export interface RenderState {
  previewTask: ReturnType<PDFPageProxy["render"]> | null;
  boundaryDraft: { source: string; text: string } | null;
  previewGeneration: number;
  notificationTimer: number | null;
  notificationSequence: number;
  editorResizeObserver: ResizeObserver;
  practiceScreenContext: PracticeScreenContext | null;
}

const renderStatesByApp = new WeakMap<AppState, RenderState>();

export function renderStateFor(appState: AppState): RenderState {
  const current = renderStatesByApp.get(appState);
  if (current) return current;

  const renderState: RenderState = {
    previewTask: null,
    boundaryDraft: null,
    previewGeneration: 0,
    notificationTimer: null,
    notificationSequence: 0,
    editorResizeObserver: new ResizeObserver(syncEditorHighlights),
    practiceScreenContext: null,
  };
  renderStatesByApp.set(appState, renderState);
  return renderState;
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

let renderCallback: (() => void) | null = null;

export function setRenderCallback(callback: () => void): void {
  renderCallback = callback;
}

export function requestRender(): void {
  renderCallback?.();
}
