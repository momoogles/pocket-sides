import { appRoot as root, appState as state } from "../../appRoot";
import { rawBlocks } from "../../shared/correctedScriptBlocks";
import { currentPracticeTargets } from "../../shared/currentPracticeTargets";
import { schedulePracticeSave } from "./practiceHistory";
import { refreshPracticeDisplay } from "./screen";

export interface PracticeScreenContext {
  revealed: boolean;
  showOriginal: boolean;
  originalPage: number;
  dispose(): void;
}

export interface PracticeScreenCommands {
  render(): void;
  scrollToSourceReview(): void;
}

export function createPracticeScreenContext(
  commands: PracticeScreenCommands,
): PracticeScreenContext {
  const lifetime = new AbortController();
  const context: PracticeScreenContext = {
    revealed: false,
    showOriginal: false,
    originalPage: 1,
    dispose: () => lifetime.abort(),
  };

  function resetAnswer(): void {
    context.revealed = false;
    context.showOriginal = false;
  }

  root.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLElement>("[data-action]");
      const action = button?.dataset.action;
      if (!button || !action || state.screen !== "practice") return;

      switch (action) {
        case "back-to-appearances":
          state.screen = "appearances";
          context.revealed = false;
          context.showOriginal = false;
          commands.render();
          break;
        case "reveal":
          context.revealed = true;
          commands.render();
          break;
        case "repeat-target":
          resetAnswer();
          commands.render();
          window.scrollTo({ top: 0, behavior: "smooth" });
          break;
        case "previous-target":
          if (root.pdfWorkspace.practice.currentTargetIndex > 0)
            root.pdfWorkspace.practice.currentTargetIndex -= 1;
          resetAnswer();
          schedulePracticeSave();
          commands.render();
          window.scrollTo({ top: 0, behavior: "smooth" });
          break;
        case "next-target": {
          if (!context.revealed) return;
          const targetCount = currentPracticeTargets().length;
          if (
            root.pdfWorkspace.practice.currentTargetIndex + 1 >=
            targetCount
          ) {
            state.screen = "appearances";
          } else {
            root.pdfWorkspace.practice.currentTargetIndex += 1;
            schedulePracticeSave();
          }
          resetAnswer();
          commands.render();
          window.scrollTo({ top: 0, behavior: "smooth" });
          break;
        }
        case "reset-range": {
          const targetId = button.dataset.targetId ?? "";
          const target = currentPracticeTargets().find(
            (candidate) => candidate.id === targetId,
          );
          if (!target) return;

          root.pdfWorkspace.practice.ranges[target.id] = {
            start: target.defaultStartIndex,
            end: target.defaultEndIndex,
          };
          const startInput = root.querySelector<HTMLInputElement>(
            `[data-range-start="${CSS.escape(target.id)}"]`,
          );
          const endInput = root.querySelector<HTMLInputElement>(
            `[data-range-end="${CSS.escape(target.id)}"]`,
          );
          if (startInput) startInput.value = String(target.defaultStartIndex);
          if (endInput) endInput.value = String(target.defaultEndIndex);
          refreshPracticeDisplay(context);
          schedulePracticeSave();
          break;
        }
        case "toggle-source": {
          context.showOriginal = !context.showOriginal;
          if (context.showOriginal) {
            const target =
              currentPracticeTargets()[
                root.pdfWorkspace.practice.currentTargetIndex
              ];
            context.originalPage = target?.turn.startPage ?? 1;
          }
          commands.render();
          break;
        }
        case "preview-block": {
          const block = rawBlocks().find(
            (item) => item.id === button.dataset.blockId,
          );
          if (!block) return;

          root.pdfWorkspace.analysis.previewPage = block.pageNumber;
          context.originalPage = block.pageNumber;
          context.showOriginal = true;
          commands.render();
          commands.scrollToSourceReview();
          break;
        }
      }
    },
    { signal: lifetime.signal },
  );

  root.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (
        target instanceof HTMLSelectElement &&
        target.id === "original-page-select" &&
        state.screen === "practice"
      ) {
        context.originalPage = Number(target.value);
        commands.render();
      }
    },
    { signal: lifetime.signal },
  );

  root.addEventListener(
    "input",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || state.screen !== "practice")
        return;

      const targetId = target.dataset.rangeStart ?? target.dataset.rangeEnd;
      if (!targetId) return;

      const current = root.pdfWorkspace.practice.ranges[targetId] ?? {
        start: target.dataset.rangeStart ? Number(target.min) : 0,
        end: target.dataset.rangeStart
          ? Number(target.max)
          : Number(target.value),
      };
      if (target.dataset.rangeStart) current.start = Number(target.value);
      else current.end = Number(target.value);
      root.pdfWorkspace.practice.ranges[targetId] = current;
      refreshPracticeDisplay(context);
      schedulePracticeSave();
    },
    { signal: lifetime.signal },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        state.screen !== "practice" ||
        root.pdfWorkspace.practice.practiceSaveBusy
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
      )
        return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (root.pdfWorkspace.practice.currentTargetIndex > 0) {
          root.pdfWorkspace.practice.currentTargetIndex -= 1;
          resetAnswer();
          schedulePracticeSave();
          commands.render();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (!context.revealed) {
          context.revealed = true;
          commands.render();
        } else {
          root
            .querySelector<HTMLElement>('[data-action="next-target"]')
            ?.click();
        }
      } else if (event.key.toLocaleLowerCase("en-US") === "r") {
        event.preventDefault();
        resetAnswer();
        commands.render();
      }
    },
    { signal: lifetime.signal },
  );

  return context;
}
