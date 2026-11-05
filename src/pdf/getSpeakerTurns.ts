// Speaker turns connect recognized cues to roles and bound their page ranges.

import { cueMatchesAlias, inferRecoveredOpeningMarkers } from "./quoteMarkers";
import type { RoleCandidate } from "./roleCandidate";
import { isCastListEntry } from "./sourceBlocks";
import type { SourceBlock } from "./sourcePage";
import { findRoleByName } from "./speakerNames";
import { createRoleAliasIndex, parseKnownSpeakerCue } from "./speakerParsing";
import type { SpeakerTurn } from "./speakerTurn";

export function getSpeakerTurns(
  blocks: SourceBlock[],
  roles: RoleCandidate[],
  manualSpeakers: Record<string, string>,
): SpeakerTurn[] {
  const orderedRoles = [...roles].sort(
    (a, b) =>
      Math.max(...b.aliases.map((alias) => alias.length), 0) -
      Math.max(...a.aliases.map((alias) => alias.length), 0),
  );
  const roleAliasIndex = createRoleAliasIndex(orderedRoles);
  const recoveredOpeningMarkers = inferRecoveredOpeningMarkers(blocks);
  const turns: SpeakerTurn[] = [];

  blocks.forEach((block, index) => {
    if (block.boundaryRoleId === null) return;
    const manuallySelectedRoleId =
      block.boundaryRoleId ?? manualSpeakers[block.id];
    if (!manuallySelectedRoleId && isCastListEntry(block)) return;
    const jointRoles = block.coSpeakers?.length
      ? block.coSpeakers
          .map((name) => findRoleByName(name, orderedRoles))
          .filter((role): role is RoleCandidate => Boolean(role))
      : [];
    const cueText = block.speakerLabel
      ? block.speakerLabel + block.text
      : block.text;
    const parsedCue = parseKnownSpeakerCue(
      cueText,
      0,
      roleAliasIndex,
      recoveredOpeningMarkers,
    );
    const cueRoles =
      jointRoles.length > 0 ? jointRoles : (parsedCue?.roles ?? []);
    const matchedRoles = manuallySelectedRoleId
      ? roles.filter((candidate) => candidate.id === manuallySelectedRoleId)
      : cueRoles.length > 0
        ? cueRoles
        : orderedRoles
            .filter((candidate) =>
              candidate.aliases.some((alias) =>
                cueMatchesAlias(block, alias, recoveredOpeningMarkers),
              ),
            )
            .slice(0, 1);
    for (const role of matchedRoles) {
      turns.push({
        id: `turn-${block.id}-${role.id}`,
        roleId: role.id,
        startIndex: index,
        endIndex: index,
        startPage: block.pageNumber,
        endPage: block.pageNumber,
      });
    }
  });

  const distinctStarts = [...new Set(turns.map((turn) => turn.startIndex))];
  const nextStartByStart = new Map(
    distinctStarts.map((start, index) => [
      start,
      distinctStarts[index + 1] ?? blocks.length,
    ]),
  );
  return turns.map((turn) => {
    const nextStart = nextStartByStart.get(turn.startIndex) ?? blocks.length;
    const endIndex = Math.max(turn.startIndex, nextStart - 1);
    return {
      ...turn,
      endIndex,
      endPage: blocks[endIndex]?.pageNumber ?? turn.startPage,
    };
  });
}
