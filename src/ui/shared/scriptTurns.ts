// Cache speaker turns derived from the current source blocks and role choices.
import { getSpeakerTurns } from "../../pdf/getSpeakerTurns";
import type { SourceBlock } from "../../pdf/sourcePage";
import type { SpeakerTurn } from "../../pdf/speakerTurn";
import { appRoot as root } from "../appRoot";
import { blocks, usableRoleCandidates } from "./correctedScriptBlocks";
import { cacheForScriptDocument } from "./scriptDataCache";

export function turns(): SpeakerTurn[] {
  return turnsForBlocks(blocks());
}

export function turnsForBlocks(sourceBlocks: SourceBlock[]): SpeakerTurn[] {
  const script = root.pdfWorkspace.script;
  const cache = cacheForScriptDocument(script);
  const roles = usableRoleCandidates();
  const roleSignature = JSON.stringify(
    roles.map(({ id, label, aliases, manual }) => [id, label, aliases, manual]),
  );
  const manualSpeakersSignature = JSON.stringify(script.manualSpeakers);
  if (
    cache.speakerTurns &&
    cache.speakerTurns.blocks === sourceBlocks &&
    cache.speakerTurns.roles === roleSignature &&
    cache.speakerTurns.manualSpeakers === manualSpeakersSignature
  )
    return cache.speakerTurns.value;

  const value = getSpeakerTurns(sourceBlocks, roles, script.manualSpeakers);
  cache.speakerTurns = {
    blocks: sourceBlocks,
    roles: roleSignature,
    manualSpeakers: manualSpeakersSignature,
    value,
  };
  return value;
}
