// Cache rehearsal targets derived from speaker turns and selected role.
import { buildPracticeTargets } from "../../pdf/buildPracticeTargets";
import type { PracticeTarget } from "../../pdf/practiceTarget";
import { appRoot as root } from "../appRoot";
import { blocks } from "./correctedScriptBlocks";
import { cacheForScriptDocument } from "./scriptDataCache";
import { turnsForBlocks } from "./scriptTurns";

export function currentPracticeTargets(): PracticeTarget[] {
  const script = root.pdfWorkspace.script;
  const cache = cacheForScriptDocument(script);
  const sourceBlocks = blocks();
  const speakerTurns = turnsForBlocks(sourceBlocks);
  if (
    cache.practiceTargets &&
    cache.practiceTargets.blocks === sourceBlocks &&
    cache.practiceTargets.turns === speakerTurns &&
    cache.practiceTargets.roleId === script.selectedRoleId
  )
    return cache.practiceTargets.value;

  const value = buildPracticeTargets(
    sourceBlocks,
    speakerTurns,
    script.selectedRoleId,
  );
  cache.practiceTargets = {
    blocks: sourceBlocks,
    turns: speakerTurns,
    roleId: script.selectedRoleId,
    value,
  };
  return value;
}
