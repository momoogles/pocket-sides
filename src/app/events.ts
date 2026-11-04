// DOM events are translated into named application actions here.
import type { RoleCandidate } from "../pdf/types";
import {
  applyScriptEditor,
  clearNotification,
  goToPreviewPage,
  hideScriptSelectionToolbar,
  renderApp,
  scriptEditorModel,
  scrollToSourceReview,
  setBoundaryDraft,
  showScriptEditorError,
  showScriptSelectionToolbar,
  slug,
  syncEditorHighlights,
  unassignSelectedSpeaker,
} from "../ui/render";
import { root } from "../ui/root";
import { refreshPracticeDisplay } from "../ui/screens/practice-screen";
import {
  beginPractice,
  closePdf,
  continueToAppearances,
  deleteAllSavedPracticeDataFromDevice,
  deleteSavedPracticeFromHome,
  openPdf,
  schedulePracticeSave,
} from "./actions";
import {
  applyCachedImageAnalysis,
  applyTextOcrPreview,
  readWithOcr,
  replaceReadingPages,
  restoreSavedCorrections,
  updateOcrProgress,
} from "./ocr-actions";
import {
  hasBoundaryEditsOnPage,
  practiceTargets,
  rawBlocks,
  refreshAutomaticRoles,
} from "./script-model";
import { state } from "./state";

let previewPointerStart: { x: number; y: number } | null = null;

let lastPreviewWheelTurn = 0;
export function bindAppEvents(): void {
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>("[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    switch (action) {
      case "choose-pdf": {
        state.pendingResumeFingerprint = null;
        const fileInput =
          document.querySelector<HTMLInputElement>("#pdf-input");
        if (fileInput) fileInput.value = "";
        fileInput?.click();
        break;
      }
      case "resume-saved-practice":
      case "open-saved-reading": {
        state.pendingResumeFingerprint = button.dataset.fingerprint ?? null;
        const fileInput =
          document.querySelector<HTMLInputElement>("#pdf-input");
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
        if (!state.ocrBusy && state.layoutPreview)
          replaceReadingPages(state.layoutPreview);
        break;
      case "discard-ocr-layout":
        state.layoutPreview = null;
        renderApp();
        break;
      case "restore-preview-page-text": {
        const originalPage = state.originalPages[state.previewPage - 1];
        if (!state.ocrBusy && !state.layoutPreview && originalPage) {
          const changes = [
            hasBoundaryEditsOnPage(originalPage.pageNumber)
              ? "このページの手動の区切り"
              : "",
            Object.keys(state.ranges).length ? "調整した練習範囲" : "",
          ].filter(Boolean);
          if (
            changes.length &&
            !window.confirm(
              `PDFからの読み取り結果に戻すと、${changes.join("と")}が初期設定に戻ります。`,
            )
          )
            break;
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
        state.manualSpeakers = Object.fromEntries(
          Object.entries(state.manualSpeakers).filter(
            ([, id]) => id !== roleId,
          ),
        );
        if (state.boundaryEdits.some((edit) => edit.roleId === roleId)) {
          state.boundaryEdits = state.boundaryEdits.filter(
            (edit) => edit.roleId !== roleId,
          );
          state.ranges = {};
          state.currentTargetIndex = 0;
        }
        if (state.selectedRoleId === roleId) state.selectedRoleId = "";
        renderApp();
        break;
      }
      case "add-role": {
        const labelInput =
          document.querySelector<HTMLInputElement>("#new-role-label");
        const aliasInput =
          document.querySelector<HTMLInputElement>("#new-role-alias");
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
        const item = practiceTargets().find(
          (candidate) => candidate.id === targetId,
        );
        if (item) {
          state.ranges[item.id] = {
            start: item.defaultStartIndex,
            end: item.defaultEndIndex,
          };
          const startInput = document.querySelector<HTMLInputElement>(
            `[data-range-start="${CSS.escape(item.id)}"]`,
          );
          const endInput = document.querySelector<HTMLInputElement>(
            `[data-range-end="${CSS.escape(item.id)}"]`,
          );
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
        state.previewZoom = Math.min(
          1.8,
          +(state.previewZoom + 0.2).toFixed(1),
        );
        renderApp();
        break;
      case "zoom-out":
        state.previewZoom = Math.max(
          0.6,
          +(state.previewZoom - 0.2).toFixed(1),
        );
        renderApp();
        break;
      case "previous-preview-page":
        goToPreviewPage(state.previewPage - 1);
        break;
      case "next-preview-page":
        goToPreviewPage(state.previewPage + 1);
        break;
      case "preview-block": {
        const block = rawBlocks().find(
          (item) => item.id === button.dataset.blockId,
        );
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
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement
      )
    )
      return;

    if (target instanceof HTMLInputElement && target.id === "pdf-input") {
      const file = target.files?.[0];
      if (file) void openPdf(file);
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.roleLabel) {
      const role = state.roles.find(
        (item) => item.id === target.dataset.roleLabel,
      );
      if (role) role.label = target.value.trim() || role.label;
      if (role && !target.value.trim()) target.value = role.label;
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.roleAliases) {
      const role = state.roles.find(
        (item) => item.id === target.dataset.roleAliases,
      );
      if (role) {
        const aliases = target.value
          .split(/[、,，\n]/u)
          .map((value) => value.trim())
          .filter(Boolean);
        role.aliases = [...new Set(aliases)];
        if (role.aliases.length === 0) role.aliases = [role.label];
        target.value = role.aliases.join("、");
      }
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.correctionChar) {
      const character = target.dataset.correctionChar;
      const replacement = target.value;
      if (
        (state.corrections[character] ?? "") !== replacement &&
        state.boundaryEdits.length
      ) {
        state.ranges = {};
        state.currentTargetIndex = 0;
      }
      if (replacement.trim()) state.corrections[character] = replacement;
      else delete state.corrections[character];
      refreshAutomaticRoles();
      renderApp();
      return;
    }

    if (
      target instanceof HTMLSelectElement &&
      (target.id === "preview-page-select" ||
        target.id === "layout-ocr-page-select" ||
        target.id === "text-ocr-page-select")
    ) {
      goToPreviewPage(Number(target.value));
      return;
    }

    if (
      target instanceof HTMLSelectElement &&
      target.id === "original-page-select"
    ) {
      state.originalPage = Number(target.value);
      renderApp();
      return;
    }
  });

  root.addEventListener(
    "scroll",
    (event) => {
      if (
        event.target instanceof HTMLTextAreaElement &&
        event.target.id === "full-script-editor"
      ) {
        syncEditorHighlights();
      }
    },
    true,
  );

  root.addEventListener("mouseup", (event) => {
    if (
      event.target instanceof HTMLTextAreaElement &&
      event.target.id === "full-script-editor"
    ) {
      showScriptSelectionToolbar({ x: event.clientX, y: event.clientY });
    }
  });

  root.addEventListener("keyup", (event) => {
    if (
      event.target instanceof HTMLTextAreaElement &&
      event.target.id === "full-script-editor"
    ) {
      if (event.key === "Escape") hideScriptSelectionToolbar();
      else showScriptSelectionToolbar();
    }
  });

  root.addEventListener("select", (event) => {
    if (
      event.target instanceof HTMLTextAreaElement &&
      event.target.id === "full-script-editor"
    )
      showScriptSelectionToolbar();
  });

  root.addEventListener("pointerdown", (event) => {
    if (
      event.target instanceof Element &&
      !event.target.closest("#full-script-editor, #script-selection-toolbar")
    ) {
      hideScriptSelectionToolbar();
    }
  });

  window.addEventListener("resize", hideScriptSelectionToolbar);

  root.addEventListener("input", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLTextAreaElement &&
      target.id === "full-script-editor"
    ) {
      if (event instanceof InputEvent && event.isComposing) return;
      target.setCustomValidity("");
      const model = scriptEditorModel();
      if (target.value.replace(/\n/g, "") !== model.text.replace(/\n/g, "")) {
        const position = target.selectionStart;
        target.value = model.text;
        target.setSelectionRange(
          Math.min(position, target.value.length),
          Math.min(position, target.value.length),
        );
        showScriptEditorError(
          "ここでは改行で区切りを調整できます。本文の文字は「文字の置換」で直せます。",
        );
        return;
      }
      setBoundaryDraft({ source: model.text, text: target.value });
      applyScriptEditor(false);
      syncEditorHighlights();
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;

    if (target.dataset.roleLabel) {
      const role = state.roles.find(
        (item) => item.id === target.dataset.roleLabel,
      );
      if (role && target.value.trim()) role.label = target.value.trim();
      return;
    }

    if (target.dataset.roleAliases) {
      const role = state.roles.find(
        (item) => item.id === target.dataset.roleAliases,
      );
      if (role) {
        const aliases = target.value
          .split(/[、,，\n]/u)
          .map((value) => value.trim())
          .filter(Boolean);
        if (aliases.length > 0) role.aliases = [...new Set(aliases)];
      }
      return;
    }

    if (target.dataset.rangeStart) {
      const targetId = target.dataset.rangeStart;
      const existing = state.ranges[targetId] ?? {
        start: Number(target.min),
        end: Number(target.max),
      };
      existing.start = Number(target.value);
      state.ranges[targetId] = existing;
      refreshPracticeDisplay();
      schedulePracticeSave();
      return;
    }

    if (target.dataset.rangeEnd) {
      const targetId = target.dataset.rangeEnd;
      const existing = state.ranges[targetId] ?? {
        start: 0,
        end: Number(target.value),
      };
      existing.end = Number(target.value);
      state.ranges[targetId] = existing;
      refreshPracticeDisplay();
      schedulePracticeSave();
    }
  });

  root.addEventListener(
    "wheel",
    (event) => {
      if (state.screen !== "analysis" || !(event.target instanceof Element))
        return;
      const preview = event.target.closest<HTMLElement>(".pdf-canvas-scroll");
      if (!preview) return;
      const canScrollVertically =
        preview.scrollHeight > preview.clientHeight + 2;
      const canScrollHorizontally =
        preview.scrollWidth > preview.clientWidth + 2;
      if (canScrollVertically || canScrollHorizontally) return;

      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      if (Math.abs(delta) < 32) return;
      const now = performance.now();
      if (now - lastPreviewWheelTurn < 400) return;
      event.preventDefault();
      lastPreviewWheelTurn = now;
      goToPreviewPage(state.previewPage + (delta > 0 ? 1 : -1));
    },
    { passive: false },
  );

  root.addEventListener("pointerdown", (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(".pdf-canvas-scroll")
    )
      return;
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
    if (
      Math.abs(distanceX) < 56 ||
      Math.abs(distanceX) < Math.abs(distanceY) * 1.25
    )
      return;
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
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
    )
      return;

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
        document
          .querySelector<HTMLElement>('[data-action="next-target"]')
          ?.click();
      }
    } else if (event.key.toLocaleLowerCase("en-US") === "r") {
      event.preventDefault();
      state.revealed = false;
      state.showOriginal = false;
      renderApp();
    }
  });
}
