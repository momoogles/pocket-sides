import { cueAtStart } from "../../pdf/quoteMarkers";
import type { RoleCandidate } from "../../pdf/roleCandidate";
import {
  isStageDirectionBlock,
  splitStageDirectionText,
} from "../../pdf/sourceBlocks";
import type { SourceBlock } from "../../pdf/sourcePage";
import {
  getRecoveredOpeningMarkers,
  usableRoleCandidates,
} from "./correctedScriptBlocks";
import { escapeHtml } from "./escapeHtml";

export function renderScriptBlocks(sourceBlocks: SourceBlock[]): string {
  const roles = usableRoleCandidates();
  const fragments: string[] = [];
  let pendingText = "";
  let pendingStage = "";
  let previousStageBlock: SourceBlock | undefined;
  let pendingSpeakerLabel: string | undefined;
  const flushPendingText = () => {
    if (!pendingText) return;
    fragments.push(
      renderScriptContent(pendingText, roles, pendingSpeakerLabel),
    );
    pendingText = "";
    pendingSpeakerLabel = undefined;
  };
  for (const block of sourceBlocks) {
    const blockText =
      (block.boundaryRoleId === null ? (block.speakerLabel ?? "") : "") +
      block.text;
    const separator = block.direction === "vertical" ? "" : "\n";
    const startsSpeech =
      block.boundaryRoleId !== null &&
      Boolean(
        block.speakerLabel ||
          block.boundaryRoleId ||
          cueAtStart(
            block.text,
            getRecoveredOpeningMarkers(),
            usableRoleCandidates(),
          ),
      );
    const continuesStage =
      previousStageBlock &&
      !startsSpeech &&
      block.direction === "vertical" &&
      block.pageNumber === previousStageBlock.pageNumber &&
      block.orderOnPage === previousStageBlock.orderOnPage + 1 &&
      Math.abs(block.y - previousStageBlock.y) <= (block.fontSize ?? 12) / 2;
    if (
      continuesStage ||
      (!block.boundaryRoleId && isStageDirectionBlock(block, roles))
    ) {
      flushPendingText();
      pendingStage += blockText;
      pendingText = "";
      previousStageBlock = block;
    } else {
      if (pendingStage)
        fragments.push(
          `<span class="stage-direction">${escapeHtml(pendingStage)}</span>`,
        );
      pendingStage = "";
      if (startsSpeech) flushPendingText();
      if (!pendingText) {
        pendingSpeakerLabel =
          block.speakerLabel?.trim() ||
          roles.find((role) => role.id === block.boundaryRoleId)?.label;
      }
      pendingText += (pendingText ? separator : "") + blockText;
      previousStageBlock = undefined;
    }
  }
  flushPendingText();
  if (pendingStage)
    fragments.push(
      `<span class="stage-direction">${escapeHtml(pendingStage)}</span>`,
    );
  return fragments.join("");
}

export function renderScriptContent(
  text: string,
  roles: RoleCandidate[],
  leadingSpeakerLabel?: string,
): string {
  return splitStageDirectionText(text, roles, leadingSpeakerLabel)
    .map((fragment) =>
      fragment.kind === "stage-direction"
        ? `<span class="stage-direction">${escapeHtml(fragment.text)}</span>`
        : escapeHtml(fragment.text),
    )
    .join("");
}
