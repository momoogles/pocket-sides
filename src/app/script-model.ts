// Derived script data stays separate from rendering and browser effects.

import { applyBoundaryEdits, type BoundaryEdit } from "../pdf/boundaries";
import {
  applyCharacterCorrections,
  normalizeScriptText,
} from "../pdf/corrections";
import {
  applyRecoveredQuoteMarkers,
  buildPracticeTargets,
  collectBlocks,
  cueAtStart,
  detectRoleCandidates,
  getSpeakerTurns,
  inferRecoveredClosingMarkers,
  inferRecoveredOpeningMarkers,
  isPlausibleSpeakerLabel,
  isStageDirectionBlock,
  normalizeAlias,
  splitInlineSpeakerBlocks,
  stripDuplicateSpeakerCue,
} from "../pdf/segments";
import type {
  PracticeTarget,
  RoleCandidate,
  SourceBlock,
  SourcePage,
  SpeakerTurn,
} from "../pdf/types";
import { state } from "./state";

let cachedDerivedBlocks: {
  pages: SourcePage[];
  roles: string;
  corrections: string;
  boundaryEdits: BoundaryEdit[];
  unedited: SourceBlock[];
  value: SourceBlock[];
} | null = null;

let cachedSpeakerTurns: {
  blocks: SourceBlock[];
  roles: string;
  manualSpeakers: string;
  value: SpeakerTurn[];
} | null = null;

let cachedPracticeTargets: {
  blocks: SourceBlock[];
  turns: SpeakerTurn[];
  roleId: string;
  value: PracticeTarget[];
} | null = null;

let recoveredOpeningMarkers = new Set<string>();

let recoveredClosingMarkers = new Set<string>();

export function getRecoveredOpeningMarkers(): ReadonlySet<string> {
  return recoveredOpeningMarkers;
}

export function getOcrReconciliationContext() {
  return {
    recoveredOpeningMarkers,
    roles: usableRoleCandidates(),
  };
}

export function resetScriptModelCaches(): void {
  cachedDerivedBlocks = null;
  cachedSpeakerTurns = null;
  cachedPracticeTargets = null;
  recoveredOpeningMarkers = new Set();
  recoveredClosingMarkers = new Set();
}

export function rawBlocks(): SourceBlock[] {
  return collectBlocks(state.pages);
}

export function inferredMarkerCorrections(): Record<string, string> {
  const corrections: Record<string, string> = {};
  for (const marker of recoveredOpeningMarkers) {
    if (!recoveredClosingMarkers.has(marker)) corrections[marker] = "「";
  }
  for (const marker of recoveredClosingMarkers) {
    if (!recoveredOpeningMarkers.has(marker)) corrections[marker] = "」";
  }
  return corrections;
}

export function blocks(includeBoundaryEdits = true): SourceBlock[] {
  const roleCandidates = usableRoleCandidates();
  const roleSignature = JSON.stringify(
    roleCandidates.map(({ id, label, aliases, manual }) => [
      id,
      label,
      aliases,
      manual,
    ]),
  );
  const correctionsSignature = JSON.stringify(state.corrections);
  if (
    cachedDerivedBlocks &&
    cachedDerivedBlocks.pages === state.pages &&
    cachedDerivedBlocks.roles === roleSignature &&
    cachedDerivedBlocks.corrections === correctionsSignature &&
    cachedDerivedBlocks.boundaryEdits === state.boundaryEdits
  )
    return includeBoundaryEdits
      ? cachedDerivedBlocks.value
      : cachedDerivedBlocks.unedited;

  const rawSourceBlocks = rawBlocks();
  const supportedNames = new Set(
    detectRoleCandidates(rawSourceBlocks).flatMap((role) =>
      role.aliases.map(normalizeAlias),
    ),
  );
  const sourceBlocks = rawSourceBlocks.map((block) => {
    if (
      block.speakerEvidence !== "quotation" ||
      !block.speakerLabel ||
      supportedNames.has(normalizeAlias(block.speakerLabel))
    )
      return block;
    return {
      ...block,
      text: block.speakerLabel + block.text,
      speakerLabel: undefined,
      speakerAliases: undefined,
      coSpeakers: undefined,
    };
  });
  recoveredOpeningMarkers = inferRecoveredOpeningMarkers(sourceBlocks);
  recoveredClosingMarkers = inferRecoveredClosingMarkers(
    sourceBlocks,
    recoveredOpeningMarkers,
  );
  const corrected = applySeparatedLatinRoleSuffixes(
    applyRecoveredQuoteMarkers(
      applyCharacterCorrections(sourceBlocks, state.corrections),
      recoveredOpeningMarkers,
      recoveredClosingMarkers,
    ).map((block) => {
      if (isStageDirectionBlock(block, roleCandidates)) {
        const label = block.speakerLabel?.trim();
        const text = block.text.trimStart();
        const normalizedText = normalizeAlias(text);
        const normalizedLabel = label ? normalizeAlias(label) : "";
        const remainder = Array.from(normalizedText)
          .slice(Array.from(normalizedLabel).length)
          .join("");
        const textAlreadyHasLabel = Boolean(
          label &&
            normalizedText.startsWith(normalizedLabel) &&
            /^[、,，:：]/u.test(remainder),
        );
        const textHasLeadingSeparator = /^[、,，:：]/u.test(text);
        return {
          ...block,
          speakerLabel: undefined,
          text: normalizeScriptText(
            !label || textAlreadyHasLabel || textHasLeadingSeparator
              ? `${label ?? ""}${text}`
              : `${label}、${text}`,
          ),
        };
      }
      if (!block.speakerLabel || isPlausibleSpeakerLabel(block.speakerLabel))
        return block;
      return {
        ...block,
        speakerLabel: undefined,
        text: normalizeScriptText(block.speakerLabel + block.text),
      };
    }),
  );
  const withoutDuplicateCues = corrected.map((block) =>
    block.speakerLabel
      ? {
          ...block,
          text: stripDuplicateSpeakerCue(
            block.text,
            block.speakerLabel,
            recoveredOpeningMarkers,
          ),
        }
      : block,
  );
  const unedited = splitInlineSpeakerBlocks(
    withoutDuplicateCues,
    roleCandidates,
  );
  const result = applyBoundaryEdits(unedited, state.boundaryEdits);
  cachedDerivedBlocks = {
    pages: state.pages,
    roles: roleSignature,
    corrections: correctionsSignature,
    boundaryEdits: state.boundaryEdits,
    unedited,
    value: result,
  };
  return includeBoundaryEdits ? result : unedited;
}

export function usableRoleCandidates(): RoleCandidate[] {
  return state.roles
    .filter((role) => role.manual || isPlausibleSpeakerLabel(role.label))
    .map((role) => ({
      ...role,
      aliases: role.aliases.filter(isPlausibleSpeakerLabel),
    }));
}

function applySeparatedLatinRoleSuffixes(
  sourceBlocks: SourceBlock[],
): SourceBlock[] {
  const result = sourceBlocks.map((block) => ({ ...block }));
  const inferredSuffixes = new Map<
    string,
    { baseName: string; suffix: string }
  >();
  for (let index = 0; index < result.length; index += 1) {
    const block = result[index];
    if (!block || block.direction !== "vertical") continue;
    const cue = block.speakerLabel
      ? { name: block.speakerLabel }
      : cueAtStart(block.text, recoveredOpeningMarkers, usableRoleCandidates());
    if (
      !cue ||
      !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(cue.name)
    )
      continue;

    for (const neighborIndex of [index - 1, index + 1]) {
      const neighbor = result[neighborIndex];
      if (
        !neighbor ||
        neighbor.pageNumber !== block.pageNumber ||
        neighbor.direction !== "vertical"
      )
        continue;
      if (neighbor.speakerLabel || neighbor.isSpeakerSuffix) continue;
      const suffix = normalizeAlias(neighbor.text);
      if (!/^[\p{Script=Latin}\p{Number}]{1,2}$/u.test(suffix)) continue;

      const fontSize = Math.max(block.fontSize ?? 0, neighbor.fontSize ?? 0, 1);
      if (
        Math.abs(block.x - neighbor.x) > fontSize * 1.5 ||
        Math.abs(block.y - neighbor.y) > fontSize * 1.5
      )
        continue;

      const fullName = cue.name + suffix;
      inferredSuffixes.set(normalizeAlias(cue.name), {
        baseName: cue.name,
        suffix,
      });
      block.speakerAliases = [
        ...new Set([...(block.speakerAliases ?? []), cue.name]),
      ];
      if (block.speakerLabel) {
        block.speakerLabel = fullName;
      } else {
        block.text = fullName + block.text.slice(cue.name.length);
      }
      neighbor.isSpeakerSuffix = true;
      neighbor.speakerAliases = [fullName];
      neighbor.text = "";
      break;
    }
  }

  for (const block of result) {
    if (block.isSpeakerSuffix) continue;
    const cue = block.speakerLabel
      ? { name: block.speakerLabel }
      : cueAtStart(block.text, recoveredOpeningMarkers, usableRoleCandidates());
    if (!cue) continue;
    const inferred = inferredSuffixes.get(normalizeAlias(cue.name));
    if (!inferred) continue;
    const fullName = inferred.baseName + inferred.suffix;
    block.speakerAliases = [
      ...new Set([...(block.speakerAliases ?? []), cue.name]),
    ];
    if (block.speakerLabel) {
      block.speakerLabel = fullName;
    } else {
      block.text = fullName + block.text.slice(cue.name.length);
    }
  }
  return result;
}

export function turns(): SpeakerTurn[] {
  return turnsForBlocks(blocks());
}

export function turnsForBlocks(sourceBlocks: SourceBlock[]): SpeakerTurn[] {
  const roles = usableRoleCandidates();
  const roleSignature = JSON.stringify(
    roles.map(({ id, label, aliases, manual }) => [id, label, aliases, manual]),
  );
  const manualSpeakersSignature = JSON.stringify(state.manualSpeakers);
  if (
    cachedSpeakerTurns &&
    cachedSpeakerTurns.blocks === sourceBlocks &&
    cachedSpeakerTurns.roles === roleSignature &&
    cachedSpeakerTurns.manualSpeakers === manualSpeakersSignature
  )
    return cachedSpeakerTurns.value;

  const value = getSpeakerTurns(sourceBlocks, roles, state.manualSpeakers);
  cachedSpeakerTurns = {
    blocks: sourceBlocks,
    roles: roleSignature,
    manualSpeakers: manualSpeakersSignature,
    value,
  };
  return value;
}

export function practiceTargets(): PracticeTarget[] {
  const sourceBlocks = blocks();
  const speakerTurns = turnsForBlocks(sourceBlocks);
  if (
    cachedPracticeTargets &&
    cachedPracticeTargets.blocks === sourceBlocks &&
    cachedPracticeTargets.turns === speakerTurns &&
    cachedPracticeTargets.roleId === state.selectedRoleId
  )
    return cachedPracticeTargets.value;

  const value = buildPracticeTargets(
    sourceBlocks,
    speakerTurns,
    state.selectedRoleId,
  );
  cachedPracticeTargets = {
    blocks: sourceBlocks,
    turns: speakerTurns,
    roleId: state.selectedRoleId,
    value,
  };
  return value;
}

export function selectedRole(): RoleCandidate | undefined {
  return state.roles.find((role) => role.id === state.selectedRoleId);
}

export function refreshAutomaticRoles(): void {
  const existing = new Map(state.roles.map((role) => [role.id, role]));
  const automatic = detectRoleCandidates(blocks(false))
    .filter((role) => !state.excludedRoleIds.has(role.id))
    .map((detected) => {
      const previous = existing.get(detected.id);
      return previous && !previous.manual
        ? { ...detected, label: previous.label, aliases: previous.aliases }
        : detected;
    });
  const manual = state.roles.filter(
    (role) => role.manual && !state.excludedRoleIds.has(role.id),
  );
  state.roles = [...automatic, ...manual];
  if (!state.roles.some((role) => role.id === state.selectedRoleId))
    state.selectedRoleId = "";
}

export function hasBoundaryEditsOnPage(pageNumber: number): boolean {
  const blockIds = new Set(
    blocks(false)
      .filter((block) => block.pageNumber === pageNumber)
      .map((block) => block.id),
  );
  return state.boundaryEdits.some((edit) => blockIds.has(edit.blockId));
}
