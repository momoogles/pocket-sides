import { type AppState, createAppState } from "./appState";
import {
  createPdfWorkspaceState,
  type PdfWorkspaceState,
} from "./pdf/pdfWorkspace";

export interface AppElement extends HTMLElement {
  readonly appState: AppState;
  pdfWorkspace: PdfWorkspaceState;
  onAppConnected(callback: (signal: AbortSignal) => void): void;
}

class PocketSidesAppElement extends HTMLElement implements AppElement {
  readonly appState = createAppState();
  pdfWorkspace = createPdfWorkspaceState();

  #eventLifetime: AbortController | null = null;
  #onAppConnected: ((signal: AbortSignal) => void) | null = null;

  connectedCallback(): void {
    if (this.#eventLifetime) return;

    this.#eventLifetime = new AbortController();
    this.#onAppConnected?.(this.#eventLifetime.signal);
  }

  disconnectedCallback(): void {
    this.#eventLifetime?.abort();
    this.#eventLifetime = null;
  }

  onAppConnected(callback: (signal: AbortSignal) => void): void {
    this.#onAppConnected = callback;
    if (this.#eventLifetime) callback(this.#eventLifetime.signal);
  }
}

export function registerAppElement(): void {
  if (!customElements.get("pocket-sides-app"))
    customElements.define("pocket-sides-app", PocketSidesAppElement);
}
