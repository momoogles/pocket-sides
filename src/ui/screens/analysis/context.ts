import type { RoleCandidate } from "../../../pdf/roleCandidate";
import { roleIdForName } from "../../../pdf/roleIdForName";
import { appRoot as root, appState as state } from "../../appRoot";
import { goToPreviewPage } from "../../pdfPreview";
import {
  renderApp,
  scrollToAnalysisPanel,
  scrollToSourceReview,
} from "../../renderApp";
import { syncEditorHighlights } from "../../renderState";
import {
  applyScriptEditor,
  hideScriptSelectionToolbar,
  scriptEditorModel,
  setBoundaryDraft,
  showScriptEditorError,
  showScriptSelectionToolbar,
  unassignSelectedSpeaker,
} from "../../scriptEditor";
import { rawBlocks } from "../../shared/correctedScriptBlocks";
import { hasBoundaryEditsOnPage } from "../../shared/hasBoundaryEditsOnPage";
import { refreshAutomaticRoles } from "../../shared/scriptRoles";
import { continueToAppearances } from "../practice/continueToAppearances";
import {
  applyCachedImageAnalysis,
  applyTextOcrPreview,
  readWithOcr,
  replaceReadingPages,
  restoreSavedCorrections,
  updateOcrProgress,
} from "./ocr";

export function bindAnalysisContext(signal: AbortSignal): void {
  let previewPointerStart: { x: number; y: number } | null = null;
  let lastPreviewWheelTurn = 0;

  root.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLElement>("[data-action]");
      const action = button?.dataset.action;
      if (!button || !action) return;

      switch (action) {
        case "read-with-ocr":
          void readWithOcr("text");
          break;
        case "cancel-ocr":
          root.pdfWorkspace.analysis.ocrCancelRequested = true;
          root.pdfWorkspace.analysis.ocrStatus =
            "処理中のページが終わり次第、画像解析を中止します";
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
          root.pdfWorkspace.analysis.textOcrPreview = null;
          renderApp();
          break;
        case "preview-ocr-layout":
          void readWithOcr("layout");
          break;
        case "apply-ocr-layout":
          if (
            !root.pdfWorkspace.analysis.ocrBusy &&
            root.pdfWorkspace.analysis.layoutPreview
          ) {
            replaceReadingPages(root.pdfWorkspace.analysis.layoutPreview, true);
            scrollToAnalysisPanel("layout-adjustment-panel");
          }
          break;
        case "discard-ocr-layout":
          root.pdfWorkspace.analysis.layoutPreview = null;
          renderApp();
          break;
        case "restore-preview-page-text": {
          const originalPage =
            root.pdfWorkspace.script.originalPages[
              root.pdfWorkspace.analysis.previewPage - 1
            ];
          if (
            !root.pdfWorkspace.analysis.ocrBusy &&
            !root.pdfWorkspace.analysis.layoutPreview &&
            originalPage
          ) {
            const changes = [
              hasBoundaryEditsOnPage(originalPage.pageNumber)
                ? "このページの手動の区切り"
                : "",
              Object.keys(root.pdfWorkspace.practice.ranges).length
                ? "調整した練習範囲"
                : "",
            ].filter(Boolean);
            if (
              changes.length &&
              !window.confirm(
                `PDFからの読み取り結果に戻すと、${changes.join("と")}が初期設定に戻ります。`,
              )
            ) {
              break;
            }
            replaceReadingPages([originalPage]);
          }
          break;
        }
        case "use-previous-image-analysis":
          applyCachedImageAnalysis();
          break;
        case "restore-saved-corrections":
          restoreSavedCorrections();
          break;
        case "select-role":
          root.pdfWorkspace.script.selectedRoleId = button.dataset.roleId ?? "";
          renderApp();
          break;
        case "remove-role": {
          const roleId = button.dataset.roleId ?? "";
          root.pdfWorkspace.script.excludedRoleIds.add(roleId);
          root.pdfWorkspace.script.roles =
            root.pdfWorkspace.script.roles.filter((role) => role.id !== roleId);
          root.pdfWorkspace.script.manualSpeakers = Object.fromEntries(
            Object.entries(root.pdfWorkspace.script.manualSpeakers).filter(
              ([, id]) => id !== roleId,
            ),
          );
          if (
            root.pdfWorkspace.script.boundaryEdits.some(
              (edit) => edit.roleId === roleId,
            )
          ) {
            root.pdfWorkspace.script.boundaryEdits =
              root.pdfWorkspace.script.boundaryEdits.filter(
                (edit) => edit.roleId !== roleId,
              );
            root.pdfWorkspace.practice.ranges = {};
            root.pdfWorkspace.practice.currentTargetIndex = 0;
          }
          if (root.pdfWorkspace.script.selectedRoleId === roleId) {
            root.pdfWorkspace.script.selectedRoleId = "";
          }
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
          root.pdfWorkspace.script.manualRoleNumber += 1;
          const alias = aliasInput?.value.trim() || label;
          const role: RoleCandidate = {
            id: `manual-${roleIdForName(label)}-${root.pdfWorkspace.script.manualRoleNumber}`,
            label,
            aliases: [alias],
            occurrenceCount: 0,
            exampleBlockIds: [],
            manual: true,
            evidence: "manual",
          };
          root.pdfWorkspace.script.roles.push(role);
          root.pdfWorkspace.script.selectedRoleId = role.id;
          renderApp();
          break;
        }
        case "continue-to-appearances":
          void continueToAppearances();
          break;
        case "zoom-in":
          root.pdfWorkspace.analysis.previewZoom = Math.min(
            1.8,
            +(root.pdfWorkspace.analysis.previewZoom + 0.2).toFixed(1),
          );
          renderApp();
          break;
        case "zoom-out":
          root.pdfWorkspace.analysis.previewZoom = Math.max(
            0.6,
            +(root.pdfWorkspace.analysis.previewZoom - 0.2).toFixed(1),
          );
          renderApp();
          break;
        case "previous-preview-page":
          goToPreviewPage(root.pdfWorkspace.analysis.previewPage - 1);
          break;
        case "next-preview-page":
          goToPreviewPage(root.pdfWorkspace.analysis.previewPage + 1);
          break;
        case "preview-block": {
          if (state.screen === "practice") break;
          const block = rawBlocks().find(
            (item) => item.id === button.dataset.blockId,
          );
          if (block) {
            root.pdfWorkspace.analysis.previewPage = block.pageNumber;
            renderApp();
            scrollToSourceReview();
          }
          break;
        }
      }
    },
    { signal },
  );

  root.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLSelectElement)
      ) {
        return;
      }

      if (target instanceof HTMLInputElement && target.dataset.roleLabel) {
        const role = root.pdfWorkspace.script.roles.find(
          (item) => item.id === target.dataset.roleLabel,
        );
        if (role) role.label = target.value.trim() || role.label;
        if (role && !target.value.trim()) target.value = role.label;
        return;
      }

      if (target instanceof HTMLInputElement && target.dataset.roleAliases) {
        const role = root.pdfWorkspace.script.roles.find(
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
          (root.pdfWorkspace.script.corrections[character] ?? "") !==
            replacement &&
          root.pdfWorkspace.script.boundaryEdits.length
        ) {
          root.pdfWorkspace.practice.ranges = {};
          root.pdfWorkspace.practice.currentTargetIndex = 0;
        }
        if (replacement.trim()) {
          root.pdfWorkspace.script.corrections[character] = replacement;
        } else {
          delete root.pdfWorkspace.script.corrections[character];
        }
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
      }
    },
    { signal },
  );

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
    { capture: true, signal },
  );

  root.addEventListener(
    "mouseup",
    (event) => {
      if (
        event.target instanceof HTMLTextAreaElement &&
        event.target.id === "full-script-editor"
      ) {
        showScriptSelectionToolbar({ x: event.clientX, y: event.clientY });
      }
    },
    { signal },
  );

  root.addEventListener(
    "keyup",
    (event) => {
      if (
        event.target instanceof HTMLTextAreaElement &&
        event.target.id === "full-script-editor"
      ) {
        if (event.key === "Escape") hideScriptSelectionToolbar();
        else showScriptSelectionToolbar();
      }
    },
    { signal },
  );

  root.addEventListener(
    "select",
    (event) => {
      if (
        event.target instanceof HTMLTextAreaElement &&
        event.target.id === "full-script-editor"
      ) {
        showScriptSelectionToolbar();
      }
    },
    { signal },
  );

  root.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.target instanceof Element &&
        !event.target.closest("#full-script-editor, #script-selection-toolbar")
      ) {
        hideScriptSelectionToolbar();
      }
    },
    { signal },
  );

  window.addEventListener("resize", hideScriptSelectionToolbar, { signal });

  root.addEventListener(
    "input",
    (event) => {
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
        const role = root.pdfWorkspace.script.roles.find(
          (item) => item.id === target.dataset.roleLabel,
        );
        if (role && target.value.trim()) role.label = target.value.trim();
        return;
      }

      if (target.dataset.roleAliases) {
        const role = root.pdfWorkspace.script.roles.find(
          (item) => item.id === target.dataset.roleAliases,
        );
        if (role) {
          const aliases = target.value
            .split(/[、,，\n]/u)
            .map((value) => value.trim())
            .filter(Boolean);
          if (aliases.length > 0) role.aliases = [...new Set(aliases)];
        }
      }
    },
    { signal },
  );

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
      goToPreviewPage(
        root.pdfWorkspace.analysis.previewPage + (delta > 0 ? 1 : -1),
      );
    },
    { passive: false, signal },
  );

  root.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".pdf-canvas-scroll")
      ) {
        return;
      }
      previewPointerStart = { x: event.clientX, y: event.clientY };
    },
    { signal },
  );

  root.addEventListener(
    "pointerup",
    (event) => {
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
      ) {
        return;
      }
      goToPreviewPage(
        root.pdfWorkspace.analysis.previewPage + (distanceX < 0 ? 1 : -1),
      );
    },
    { signal },
  );

  root.addEventListener(
    "pointercancel",
    () => {
      previewPointerStart = null;
    },
    { signal },
  );
}
