// Speaker cues and inline dialogue are parsed against known role aliases.

import {
  CUE_BOUNDARY_MARKERS,
  inferRecoveredOpeningMarkers,
  isOpeningMarker,
  isPotentialQuoteMarker,
  SPEECH_WITH_STAGE_DIRECTION_MARKERS,
} from "./quoteMarkers";
import type { RoleCandidate } from "./roleCandidate";
import type { SourceBlock } from "./sourcePage";
import {
  isJointSpeakerSeparator,
  normalizeAlias,
  resolveJointSpeakers,
} from "./speakerNames";

interface RoleAliasEntry {
  role: RoleCandidate;
  alias: string;
}

export interface RoleAliasNode {
  children: Map<string, RoleAliasNode>;
  entry?: RoleAliasEntry;
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

export function splitInlineSpeakerBlocks(
  sourceBlocks: SourceBlock[],
  roles: RoleCandidate[],
  recoveredOpeningMarkers: ReadonlySet<string> = inferRecoveredOpeningMarkers(
    sourceBlocks,
  ),
): SourceBlock[] {
  if (roles.length === 0) return sourceBlocks;
  const roleAliasIndex = createRoleAliasIndex(roles);

  return sourceBlocks.flatMap((sourceBlock) => {
    const cueText = sourceBlock.speakerLabel
      ? sourceBlock.speakerLabel + sourceBlock.text
      : sourceBlock.text;
    const parsedInitialCue = parseKnownSpeakerCue(
      cueText,
      0,
      roleAliasIndex,
      recoveredOpeningMarkers,
    );
    const initialCue = parsedInitialCue
      ? { name: parsedInitialCue.name, marker: parsedInitialCue.marker }
      : sourceBlock.speakerLabel
        ? { name: sourceBlock.speakerLabel, marker: "" }
        : undefined;
    let currentLabel = initialCue?.name;
    let currentCoSpeakers =
      parsedInitialCue?.roles ?? resolveJointSpeakers(currentLabel, roles);
    let cursor = sourceBlock.speakerLabel
      ? Math.max(
          0,
          (parsedInitialCue?.markerStart ?? sourceBlock.speakerLabel.length) -
            sourceBlock.speakerLabel.length,
        )
      : (parsedInitialCue?.markerStart ?? 0);

    if (!sourceBlock.speakerLabel && initialCue) {
      const leading = sourceBlock.text.trimStart();
      const leadingOffset = sourceBlock.text.length - leading.length;
      if (parsedInitialCue) {
        cursor = parsedInitialCue.markerStart;
      } else {
        const nameOffset = leading.startsWith(initialCue.name)
          ? initialCue.name.length
          : -1;
        if (nameOffset >= 0) {
          let markerOffset = leadingOffset + nameOffset;
          while (/\s/u.test(sourceBlock.text[markerOffset] ?? ""))
            markerOffset += 1;
          if (
            isOpeningMarker(
              sourceBlock.text[markerOffset] ?? "",
              recoveredOpeningMarkers,
            )
          )
            cursor = markerOffset;
        }
      }
    }

    const cues = findInlineSpeakerCues(
      sourceBlock.text,
      roleAliasIndex,
      recoveredOpeningMarkers,
    ).filter((cue) => cue.start > cursor);
    if (cues.length === 0) {
      const jointNames = currentCoSpeakers.map((role) => role.label);
      return jointNames.length > 1
        ? [{ ...sourceBlock, coSpeakers: jointNames }]
        : [sourceBlock];
    }

    const result: SourceBlock[] = [];
    let part = 0;
    const addPart = (
      text: string,
      label: string | undefined,
      speakers: RoleCandidate[],
    ) => {
      if (!text) return;
      part += 1;
      const coSpeakers = speakers.map((role) => role.label);
      result.push({
        ...sourceBlock,
        id: `${sourceBlock.id}-part-${part}`,
        rawText: `${label ?? ""}${text}`,
        text,
        ...(label ? { speakerLabel: label } : { speakerLabel: undefined }),
        ...(coSpeakers.length > 1 ? { coSpeakers } : { coSpeakers: undefined }),
      });
    };

    for (const cue of cues) {
      addPart(
        sourceBlock.text.slice(cursor, cue.start),
        currentLabel,
        currentCoSpeakers,
      );
      cursor = cue.markerStart;
      currentLabel = cue.name;
      currentCoSpeakers = cue.roles;
    }
    addPart(sourceBlock.text.slice(cursor), currentLabel, currentCoSpeakers);
    return result.length > 0 ? result : [sourceBlock];
  });
}

function findInlineSpeakerCues(
  text: string,
  roleAliasIndex: RoleAliasNode,
  recoveredOpeningMarkers: ReadonlySet<string>,
): Array<{
  name: string;
  start: number;
  markerStart: number;
  roles: RoleCandidate[];
}> {
  const cues: Array<{
    name: string;
    start: number;
    markerStart: number;
    roles: RoleCandidate[];
  }> = [];
  for (let index = 0; index < text.length; ) {
    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
    index += character.length;
    if (
      !CUE_BOUNDARY_MARKERS.has(character) &&
      !isPotentialQuoteMarker(character)
    )
      continue;
    const cue = parseKnownSpeakerCue(
      text,
      index,
      roleAliasIndex,
      recoveredOpeningMarkers,
    );
    if (!cue || cue.start === 0) continue;
    cues.push({
      name: cue.name,
      start: cue.start,
      markerStart: cue.markerStart,
      roles: cue.roles,
    });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function parseKnownSpeakerCue(
  text: string,
  from: number,
  roleAliasIndex: RoleAliasNode,
  recoveredOpeningMarkers: ReadonlySet<string>,
): {
  name: string;
  marker: string;
  start: number;
  markerStart: number;
  roles: RoleCandidate[];
} | null {
  const start = skipWhitespace(text, from);
  let cursor = start;
  const members: RoleCandidate[] = [];
  const first = roleAliasAt(text, cursor, roleAliasIndex);
  if (!first) return null;
  members.push(first.role);
  cursor = first.endIndex;

  while (cursor < text.length) {
    let nextStart = cursor;
    while (nextStart < text.length) {
      const character = String.fromCodePoint(text.codePointAt(nextStart) ?? 0);
      if (!isJointSpeakerSeparator(character) && !/\s/u.test(character)) break;
      nextStart += character.length;
    }
    if (nextStart === cursor) break;
    const next = roleAliasAt(text, nextStart, roleAliasIndex);
    if (!next || members.some((role) => role.id === next.role.id)) break;
    members.push(next.role);
    cursor = next.endIndex;
  }

  const markerStart = skipWhitespace(text, cursor);
  const marker = String.fromCodePoint(text.codePointAt(markerStart) ?? 0);
  if (
    !isOpeningMarker(marker, recoveredOpeningMarkers) &&
    !SPEECH_WITH_STAGE_DIRECTION_MARKERS.has(marker)
  )
    return null;
  if (
    SPEECH_WITH_STAGE_DIRECTION_MARKERS.has(marker) &&
    !hasDialogueAfterStageDirection(text, markerStart, marker)
  )
    return null;
  return {
    name: members.map((role) => role.label).join("・"),
    marker,
    start,
    markerStart,
    roles: members,
  };
}

function hasDialogueAfterStageDirection(
  text: string,
  start: number,
  opener: string,
): boolean {
  const closing =
    opener === "（"
      ? "）"
      : opener === "［"
        ? "］"
        : opener === "【"
          ? "】"
          : ")";
  const end = text.indexOf(closing, start + opener.length);
  if (end < 0) return false;
  return /[\p{Letter}\p{Number}]/u.test(text.slice(end + closing.length));
}

export function createRoleAliasIndex(roles: RoleCandidate[]): RoleAliasNode {
  const root: RoleAliasNode = { children: new Map() };
  const entries = roles
    .flatMap((role) =>
      [...new Set([role.label, ...role.aliases])]
        .map((alias) => ({ role, alias, normalized: normalizeAlias(alias) }))
        .filter((entry) => entry.normalized.length > 0),
    )
    .sort((a, b) => b.normalized.length - a.normalized.length);

  for (const entry of entries) {
    let node = root;
    for (const character of Array.from(entry.normalized)) {
      let child = node.children.get(character);
      if (!child) {
        child = { children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    node.entry ??= { role: entry.role, alias: entry.alias };
  }
  return root;
}

function roleAliasAt(
  text: string,
  index: number,
  root: RoleAliasNode,
): { role: RoleCandidate; alias: string; endIndex: number } | undefined {
  let cursor = index;
  let node = root;
  let match:
    | { role: RoleCandidate; alias: string; endIndex: number }
    | undefined;

  while (cursor < text.length) {
    const character = String.fromCodePoint(text.codePointAt(cursor) ?? 0);
    if (/\s/u.test(character)) {
      cursor += character.length;
      continue;
    }

    let nextNode = node;
    let valid = true;
    for (const normalizedCharacter of Array.from(character.normalize("NFKC"))) {
      const child = nextNode.children.get(normalizedCharacter);
      if (!child) {
        valid = false;
        break;
      }
      nextNode = child;
    }
    if (!valid) break;

    cursor += character.length;
    node = nextNode;
    if (node.entry) match = { ...node.entry, endIndex: cursor };
  }

  return match;
}
