// Notifications own their timeout and display text.
import type { NotificationTone } from "../appState";
import { appRoot as root, appState as state } from "./appRoot";
import { renderStateFor, requestRender } from "./renderState";
import { escapeHtml } from "./shared/escapeHtml";

export function notify(message: string, tone: NotificationTone = "info"): void {
  const renderState = renderStateFor(state);
  if (renderState.notificationTimer !== null)
    window.clearTimeout(renderState.notificationTimer);
  const id = ++renderState.notificationSequence;
  state.notification = { id, message, tone };
  renderState.notificationTimer = window.setTimeout(
    () => {
      if (state.notification?.id !== id) return;
      state.notification = null;
      renderState.notificationTimer = null;
      requestRender();
    },
    tone === "warning" ? 7000 : 4500,
  );
}

export function clearNotification(): void {
  const renderState = renderStateFor(state);
  if (renderState.notificationTimer !== null)
    window.clearTimeout(renderState.notificationTimer);
  renderState.notificationTimer = null;
  state.notification = null;
}

export function renderNotification(): string {
  if (root.pdfWorkspace.practice.practiceSaveBusy) {
    return `<div class="toast-notification toast-info toast-progress" role="status" aria-live="polite"><span class="toast-spinner" aria-hidden="true"></span><p>練習設定をこの端末内に保存しています。</p></div>`;
  }
  const notification = state.notification;
  if (!notification) return "";
  const role = notification.tone === "warning" ? "alert" : "status";
  return `<div class="toast-notification toast-${notification.tone}" role="${role}" aria-live="${notification.tone === "warning" ? "assertive" : "polite"}"><p>${escapeHtml(notification.message)}</p><button class="text-button toast-dismiss" data-action="dismiss-notification" aria-label="通知を閉じる">閉じる</button></div>`;
}
