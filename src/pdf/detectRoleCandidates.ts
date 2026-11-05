// Role candidates are inferred from speaker cues and page layout.

import {
  inferRecoveredOpeningMarkers,
  quotedCueAtStart,
  type SpeakerCue,
} from "./quoteMarkers";
import type { RoleCandidate, RoleEvidence } from "./roleCandidate";
import { roleIdForName } from "./roleIdForName";
import { isCastListEntry, isStageDirectionBlock } from "./sourceBlocks";
import type { SourceBlock } from "./sourcePage";
import {
  isPlausibleSpeakerLabel,
  normalizeAlias,
  splitJointSpeakerNames,
} from "./speakerNames";
import { splitInlineSpeakerBlocks } from "./speakerParsing";

interface CandidateAccumulator {
  role: RoleCandidate;
  pageNumbers: Set<number>;
}

export function detectRoleCandidates(blocks: SourceBlock[]): RoleCandidate[] {
  const recoveredOpeningMarkers = inferRecoveredOpeningMarkers(blocks);
  const initial = collectRoleCandidates(blocks, recoveredOpeningMarkers);
  const expanded = splitInlineSpeakerBlocks(
    blocks,
    initial,
    recoveredOpeningMarkers,
  );
  const hasExpandedCues =
    expanded.length !== blocks.length ||
    expanded.some((block, index) => block !== blocks[index]);
  const detected = !hasExpandedCues
    ? initial
    : collectRoleCandidates(expanded, recoveredOpeningMarkers);
  return mergeJointRoleCandidates(detected);
}

function collectRoleCandidates(
  blocks: SourceBlock[],
  recoveredOpeningMarkers: ReadonlySet<string>,
): RoleCandidate[] {
  const candidates = new Map<string, CandidateAccumulator>();

  for (const block of blocks) {
    const cue = cueForBlock(block, recoveredOpeningMarkers);
    if (!cue) continue;
    const key = normalizeAlias(cue.name);
    const existing = candidates.get(key);
    if (existing) {
      existing.role.occurrenceCount += 1;
      existing.pageNumbers.add(block.pageNumber);
      existing.role.evidence = strongerEvidence(
        existing.role.evidence,
        cue.evidence,
      );
      for (const alias of [cue.name, ...(cue.aliases ?? [])]) {
        if (!existing.role.aliases.includes(alias))
          existing.role.aliases.push(alias);
      }
      if (existing.role.exampleBlockIds.length < 4) {
        existing.role.exampleBlockIds.push(block.id);
      }
      continue;
    }

    candidates.set(key, {
      role: {
        id: `role-${roleIdForName(key)}`,
        label: cue.name,
        aliases: [...new Set([cue.name, ...(cue.aliases ?? [])])],
        occurrenceCount: 1,
        exampleBlockIds: [block.id],
        manual: false,
        evidence: cue.evidence,
      },
      pageNumbers: new Set([block.pageNumber]),
    });
  }

  const entries = [...candidates.values()];
  const layoutRoles = entries.filter(({ role }) => role.evidence === "layout");
  const layoutOccurrences = layoutRoles.reduce(
    (sum, { role }) => sum + role.occurrenceCount,
    0,
  );
  const quotationOccurrences = entries
    .filter(({ role }) => role.evidence === "quotation")
    .reduce((sum, { role }) => sum + role.occurrenceCount, 0);
  const usesSpacedLabels =
    layoutRoles.filter(({ role }) => role.occurrenceCount >= 2).length >= 2 &&
    layoutOccurrences >= 6 &&
    layoutOccurrences >= quotationOccurrences * 2;

  const layoutBlocks = blocks.filter(
    (block) => block.speakerLabel && block.speakerEvidence !== "quotation",
  );
  const supportedQuotedNames = new Set<string>();
  if (usesSpacedLabels) {
    for (const block of blocks) {
      const cue = cueForBlock(block, recoveredOpeningMarkers);
      if (cue?.evidence !== "quotation") continue;
      const peers = layoutBlocks.filter(
        (candidate) =>
          candidate.direction === block.direction &&
          (candidate.recognitionConfidence !== undefined) ===
            (block.recognitionConfidence !== undefined),
      );
      const positions = peers.map(speakerAxisStart).sort((a, b) => a - b);
      if (!positions.length) continue;
      const expectedStart = positions[Math.floor(positions.length / 2)];
      if (
        Math.abs(speakerAxisStart(block) - expectedStart) <=
        Math.max(6, (block.fontSize ?? 12) * 1.5)
      ) {
        supportedQuotedNames.add(normalizeAlias(cue.name));
      }
    }
  }

  return entries
    .map(({ role }) => role)
    .filter(
      (role) =>
        !usesSpacedLabels ||
        role.evidence !== "quotation" ||
        supportedQuotedNames.has(normalizeAlias(role.label)),
    )
    .sort(
      (a, b) =>
        b.occurrenceCount - a.occurrenceCount ||
        a.label.localeCompare(b.label, "ja"),
    );
}

function speakerAxisStart(block: SourceBlock): number {
  return block.direction === "vertical"
    ? (block.recognitionBounds?.yMax ?? block.y)
    : (block.recognitionBounds?.xMin ?? block.x);
}

function mergeJointRoleCandidates(
  candidates: RoleCandidate[],
): RoleCandidate[] {
  const rolesByName = new Map<string, RoleCandidate>();
  for (const role of candidates) {
    for (const name of [role.label, ...role.aliases]) {
      rolesByName.set(normalizeAlias(name), role);
    }
  }

  const grouped = new Set<string>();
  const additions = new Map<string, { count: number; examples: string[] }>();
  for (const candidate of candidates) {
    const members = splitJointSpeakerNames(candidate.label);
    if (!members || members.length < 2) continue;
    const memberRoles = members.map((name) =>
      rolesByName.get(normalizeAlias(name)),
    );
    if (
      memberRoles.some((role) => !role) ||
      new Set(memberRoles).size !== members.length
    )
      continue;

    grouped.add(candidate.id);
    for (const role of memberRoles) {
      if (!role) continue;
      const addition = additions.get(role.id) ?? { count: 0, examples: [] };
      addition.count += candidate.occurrenceCount;
      for (const id of candidate.exampleBlockIds) {
        if (addition.examples.length >= 4) break;
        if (!addition.examples.includes(id)) addition.examples.push(id);
      }
      additions.set(role.id, addition);
    }
  }

  return candidates
    .filter((candidate) => !grouped.has(candidate.id))
    .map((candidate) => {
      const addition = additions.get(candidate.id);
      if (!addition) return candidate;
      return {
        ...candidate,
        occurrenceCount: candidate.occurrenceCount + addition.count,
        exampleBlockIds: [
          ...new Set([...candidate.exampleBlockIds, ...addition.examples]),
        ].slice(0, 4),
      };
    });
}

export function cueForBlock(
  block: SourceBlock,
  recoveredOpeningMarkers: ReadonlySet<string> = new Set(),
): SpeakerCue | null {
  if (isCastListEntry(block) || isStageDirectionBlock(block, [])) return null;
  if (block.speakerLabel && isPlausibleSpeakerLabel(block.speakerLabel)) {
    return {
      name: block.speakerLabel,
      marker: "",
      evidence: block.speakerEvidence ?? "layout",
      ...(block.speakerAliases ? { aliases: block.speakerAliases } : {}),
    };
  }

  const quoted = quotedCueAtStart(block.text, recoveredOpeningMarkers);
  if (quoted) {
    return {
      ...quoted,
      ...(block.speakerAliases ? { aliases: block.speakerAliases } : {}),
    };
  }
  return null;
}

function strongerEvidence(
  current: RoleEvidence | undefined,
  next: RoleEvidence,
): RoleEvidence {
  const priority: Record<RoleEvidence, number> = {
    recovered: 1,
    layout: 2,
    quotation: 3,
    manual: 4,
  };
  return !current || priority[next] > priority[current] ? next : current;
}
