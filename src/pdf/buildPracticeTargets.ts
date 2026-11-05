// Practice targets use scene headings and speaker-turn boundaries to set a useful range.

import { cueForBlock } from "./detectRoleCandidates";
import { normalizeScriptText } from "./normalizeScriptText";
import type { PracticeTarget } from "./practiceTarget";
import { inferRecoveredOpeningMarkers } from "./quoteMarkers";
import { isCastListEntry } from "./sourceBlocks";
import type { SourceBlock } from "./sourcePage";
import type { SpeakerTurn } from "./speakerTurn";

const NUMBERED_SECTION_HEADING =
  /^(?:[（(]\s*[〇零一二三四五六七八九十百0-9０-９]+\s*[）)](?:[\p{L}\p{Number}々ヶヵー・\s]{0,24})?|[〇零一二三四五六七八九十百0-9０-９]{1,3}[.．、][\p{L}\p{Number}々ヶヵー・\s]{0,24})$/u;

export function buildPracticeTargets(
  blocks: SourceBlock[],
  turns: SpeakerTurn[],
  selectedRoleId: string,
): PracticeTarget[] {
  const sceneStarts = findSceneStarts(blocks);
  const units = turns;
  const firstDialogueIndex = turns.reduce(
    (first, turn) => Math.min(first, turn.startIndex),
    blocks.length,
  );
  const selectedTurns = units.filter((turn) => turn.roleId === selectedRoleId);
  return selectedTurns.map((turn, index) => {
    const previousTurn = index > 0 ? selectedTurns[index - 1] : undefined;
    const nextTurn = units.find(
      (candidate) => candidate.startIndex > turn.startIndex,
    );
    const boundaryIndex = latestSceneBoundary(sceneStarts, turn.startIndex);
    const minimumStartIndex = Math.max(
      boundaryIndex >= 0 ? boundaryIndex : firstDialogueIndex,
      previousTurn ? previousTurn.startIndex : firstDialogueIndex,
    );
    const defaultStartIndex = Math.max(minimumStartIndex, turn.startIndex - 7);
    const defaultEndIndex = Math.max(
      turn.endIndex,
      nextTurn?.endIndex ?? turn.endIndex,
    );
    const sceneNumber = sceneNumberAt(sceneStarts, turn.startIndex);
    return {
      id: `practice-${turn.id}`,
      turn,
      nextTurn,
      sceneNumber,
      sceneLabel: sceneNumber > 0 ? `シーン ${sceneNumber}` : "シーンが不明",
      minimumStartIndex,
      defaultStartIndex,
      defaultEndIndex: Math.min(blocks.length - 1, defaultEndIndex),
    };
  });
}

function findSceneStarts(blocks: SourceBlock[]): number[] {
  const recoveredOpeningMarkers = inferRecoveredOpeningMarkers(blocks);
  return blocks.flatMap((block, index) =>
    isSceneHeading(block, recoveredOpeningMarkers) ? [index] : [],
  );
}

function isSceneHeading(
  block: SourceBlock,
  recoveredOpeningMarkers: ReadonlySet<string>,
): boolean {
  const text = normalizeScriptText(block.text).trim().replace(/\s+/gu, " ");
  if (
    !text ||
    isCastListEntry(block) ||
    cueForBlock(block, recoveredOpeningMarkers)
  )
    return false;
  if (Array.from(text).length > 40 || /[「」『』“”"]/u.test(text)) return false;
  return NUMBERED_SECTION_HEADING.test(text);
}

function latestSceneBoundary(
  sceneStarts: number[],
  targetIndex: number,
): number {
  for (let index = sceneStarts.length - 1; index >= 0; index -= 1) {
    if (sceneStarts[index] <= targetIndex) return sceneStarts[index];
  }
  return -1;
}

function sceneNumberAt(sceneStarts: number[], targetIndex: number): number {
  let sceneNumber = 0;
  for (const startIndex of sceneStarts) {
    if (startIndex > targetIndex) break;
    sceneNumber += 1;
  }
  return sceneNumber;
}
