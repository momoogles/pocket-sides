import { normalizeScriptText } from "./corrections";
import type {
  PracticeTarget,
  RoleCandidate,
  RoleEvidence,
  SourceBlock,
  SourcePage,
  SpeakerTurn,
} from "./types";

const SAFE_NAME_CHARACTER = String.raw`(?:(?![\u3400-\u4dbf])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}々ヶヵー・])`;
const NAME_CHARACTERS = new RegExp(`^${SAFE_NAME_CHARACTER}{1,12}$`, "u");
const SPEAKER_LABEL_CHARACTER = String.raw`(?:${SAFE_NAME_CHARACTER}|[、,，&＆/／])`;
const OPENING_MARKERS = [
  "「",
  "『",
  "“",
  '"',
  ":",
  "：",
  "-",
  "－",
  "―",
  "—",
  "–",
  "‐",
  "‑",
  "−",
  "─",
  "━",
];
const SPEECH_WITH_STAGE_DIRECTION_MARKERS = new Set([
  "（",
  "(",
  "［",
  "[",
  "【",
]);
const CUE_BOUNDARY_MARKERS = new Set([
  "」",
  "』",
  "”",
  '"',
  "!",
  "！",
  "?",
  "？",
  "。",
  "．",
  "…",
]);
const NUMBERED_SECTION_HEADING =
  /^(?:[（(]\s*[〇零一二三四五六七八九十百0-9０-９]+\s*[）)](?:[\p{L}\p{Number}々ヶヵー・\s]{0,24})?|[〇零一二三四五六七八九十百0-9０-９]{1,3}[.．、][\p{L}\p{Number}々ヶヵー・\s]{0,24})$/u;

export interface ScriptTextFragment {
  kind: "speech" | "stage-direction";
  text: string;
}

interface Cue {
  name: string;
  marker: string;
  evidence: RoleEvidence;
  aliases?: string[];
}

interface CandidateAccumulator {
  role: RoleCandidate;
  pageNumbers: Set<number>;
}

interface RoleAliasEntry {
  role: RoleCandidate;
  alias: string;
}

interface RoleAliasNode {
  children: Map<string, RoleAliasNode>;
  entry?: RoleAliasEntry;
}

export function collectBlocks(pages: SourcePage[]): SourceBlock[] {
  return pages.flatMap((page) => page.blocks);
}

/** Infers opening quote glyphs from repeated speaker-cue structure. */
export function inferRecoveredOpeningMarkers(
  blocks: SourceBlock[],
): Set<string> {
  const glyphTotals = new Map<string, number>();
  const cueCounts = new Map<string, Map<string, number>>();

  for (const block of blocks) {
    const characters = Array.from((block.rawText || block.text).trimStart());
    for (const character of characters) {
      if (isPotentialQuoteMarker(character)) {
        glyphTotals.set(character, (glyphTotals.get(character) ?? 0) + 1);
      }
    }

    for (
      let markerIndex = 1;
      markerIndex < Math.min(characters.length, 13);
      markerIndex += 1
    ) {
      const marker = characters[markerIndex];
      if (!marker || !isPotentialQuoteMarker(marker)) continue;

      const label = characters.slice(0, markerIndex).join("").trim();
      const followingText = characters.slice(markerIndex + 1).join("");
      if (isValidSpeakerLabel(label) && followingText.trim()) {
        const labels = cueCounts.get(marker) ?? new Map<string, number>();
        labels.set(label, (labels.get(label) ?? 0) + 1);
        cueCounts.set(marker, labels);
      }
      break;
    }
  }

  const recovered = new Set<string>();
  for (const [marker, labels] of cueCounts) {
    const total = glyphTotals.get(marker) ?? 0;
    const cueCount = [...labels.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    const repeatedLabels = [...labels.values()].filter(
      (count) => count >= 2,
    ).length;
    if (cueCount >= 6 && repeatedLabels >= 2 && cueCount / total >= 0.5) {
      recovered.add(marker);
    }
  }
  return recovered;
}

export function inferRecoveredClosingMarkers(
  blocks: SourceBlock[],
  recoveredOpeningMarkers: ReadonlySet<string> = inferRecoveredOpeningMarkers(
    blocks,
  ),
): Set<string> {
  const endingGlyphTotals = new Map<string, number>();
  const cueCounts = new Map<string, Map<string, number>>();

  for (const block of blocks) {
    const rawText = (block.rawText || block.text).trimEnd();
    const marker = Array.from(rawText).at(-1);
    if (!marker || !isPotentialQuoteMarker(marker)) continue;
    endingGlyphTotals.set(marker, (endingGlyphTotals.get(marker) ?? 0) + 1);

    const cueText =
      block.speakerLabel && !rawText.startsWith(block.speakerLabel)
        ? block.speakerLabel + block.text
        : rawText;
    const cue = quotedCueAtStart(cueText, recoveredOpeningMarkers);
    if (!cue) continue;
    const labels = cueCounts.get(marker) ?? new Map<string, number>();
    labels.set(cue.name, (labels.get(cue.name) ?? 0) + 1);
    cueCounts.set(marker, labels);
  }

  const recovered = new Set<string>();
  for (const [marker, labels] of cueCounts) {
    const total = endingGlyphTotals.get(marker) ?? 0;
    const cueCount = [...labels.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    const repeatedLabels = [...labels.values()].filter(
      (count) => count >= 2,
    ).length;
    if (cueCount >= 6 && repeatedLabels >= 2 && cueCount / total >= 0.5) {
      recovered.add(marker);
    }
  }
  return recovered;
}

/** Corrects inferred quote glyphs only where speaker cues and dialogue endings support them. */
export function applyRecoveredQuoteMarkers(
  blocks: SourceBlock[],
  recoveredOpeningMarkers: ReadonlySet<string>,
  recoveredClosingMarkers: ReadonlySet<string>,
): SourceBlock[] {
  return blocks.map((block) => {
    const speakerLabel = block.speakerLabel ?? "";
    const cueText = speakerLabel ? speakerLabel + block.text : block.text;
    const cue = quotedCueAtStart(cueText, recoveredOpeningMarkers);
    if (!cue) return block;

    let text = block.text;
    if (
      recoveredOpeningMarkers.has(cue.marker) ||
      isAmbiguousSpeakerQuoteMarker(cue.marker)
    ) {
      const leading = cueText.trimStart();
      const leadingOffset = cueText.length - leading.length;
      const markerOffset =
        leadingOffset + leading.indexOf(cue.marker, cue.name.length);
      const textOffset = markerOffset - speakerLabel.length;
      if (textOffset >= 0 && text[textOffset] === cue.marker) {
        text =
          text.slice(0, textOffset) +
          "「" +
          text.slice(textOffset + cue.marker.length);
      }
    }

    const endingMarker = Array.from(text.trimEnd()).at(-1);
    if (
      endingMarker &&
      (recoveredClosingMarkers.has(endingMarker) ||
        isAmbiguousClosingQuoteMarker(endingMarker))
    ) {
      const endingOffset = text.lastIndexOf(endingMarker);
      text =
        text.slice(0, endingOffset) +
        "」" +
        text.slice(endingOffset + endingMarker.length);
    }

    return text === block.text ? block : { ...block, text };
  });
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
        id: "role-" + slug(key),
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

function parseKnownSpeakerCue(
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

function createRoleAliasIndex(roles: RoleCandidate[]): RoleAliasNode {
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

function isCjkExtensionCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0x3400 && codePoint <= 0x4dbf;
}

function isPotentialQuoteMarker(value: string): boolean {
  return isCjkExtensionCharacter(value) || /[|｜│┃︱︳∣丨]/u.test(value);
}

function isJointSpeakerSeparator(character: string): boolean {
  return (
    /[、,，・&＆/／]/u.test(character) || isCjkExtensionCharacter(character)
  );
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

function resolveJointSpeakers(
  label: string | undefined,
  roles: RoleCandidate[],
): RoleCandidate[] {
  if (!label) return [];
  const members = splitJointSpeakerNames(label);
  if (members && members.length > 1) {
    const resolved = members.map((name) => findRoleByName(name, roles));
    if (
      resolved.every((role): role is RoleCandidate => Boolean(role)) &&
      new Set(resolved).size === members.length
    ) {
      return resolved;
    }
  }
  return [];
}

function findRoleByName(
  name: string,
  roles: RoleCandidate[],
): RoleCandidate | undefined {
  const normalized = normalizeAlias(name);
  return roles.find(
    (role) =>
      normalizeAlias(role.label) === normalized ||
      role.aliases.some((alias) => normalizeAlias(alias) === normalized),
  );
}

function splitJointSpeakerNames(label: string): string[] | null {
  if (!Array.from(label).some(isJointSpeakerSeparator)) return null;
  const members = Array.from(label)
    .reduce<string[]>(
      (result, character) => {
        if (isJointSpeakerSeparator(character)) result.push("");
        else
          result[result.length - 1] =
            (result[result.length - 1] ?? "") + character;
        return result;
      },
      [""],
    )
    .map((member) => member.trim());
  return members.length > 1 &&
    members.every((member) => NAME_CHARACTERS.test(member))
    ? members
    : null;
}

function isValidSpeakerLabel(label: string): boolean {
  if (isPlausibleSpeakerLabel(label)) return true;
  const members = splitJointSpeakerNames(label);
  return Boolean(
    members &&
      members.length > 1 &&
      members.every(isPlausibleSingleSpeakerName),
  );
}

export function isPlausibleSpeakerLabel(label: string): boolean {
  const normalized = normalizeAlias(label);
  if (isPlausibleSingleSpeakerName(normalized)) return true;
  const members = splitJointSpeakerNames(normalized);
  return Boolean(
    members &&
      members.length > 1 &&
      members.every(isPlausibleSingleSpeakerName),
  );
}

export function splitStageDirectionText(
  text: string,
  roles: RoleCandidate[],
  leadingSpeakerLabel?: string,
): ScriptTextFragment[] {
  const names = [
    ...new Set([
      ...(leadingSpeakerLabel ? [leadingSpeakerLabel] : []),
      ...roles.flatMap((role) => [role.label, ...role.aliases]),
    ]),
  ]
    .filter(isPlausibleSpeakerLabel)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegularExpression);
  if (names.length === 0) return [{ kind: "speech", text }];

  // 役名の直後に読点があるまとまりを、ト書きの構造として扱う。
  // 内容の単語からセリフかト書きかを推測しない。
  const name = `(?:${names.join("|")})`;
  const subjects = `${name}(?:と${name})*`;
  const startPattern = new RegExp(
    `(^|[」』。．.!！?？…\\n])${subjects}[、,，]`,
    "gu",
  );
  const ranges: Array<{ start: number }> = [];
  for (
    let match = startPattern.exec(text);
    match !== null;
    match = startPattern.exec(text)
  ) {
    ranges.push({ start: match.index + (match[1]?.length ?? 0) });
  }

  if (ranges.length === 0) return [{ kind: "speech", text }];
  let cursor = 0;
  return ranges
    .flatMap((range, index) => {
      const nextStart = ranges[index + 1]?.start ?? text.length;
      const fragments: ScriptTextFragment[] = [];
      if (range.start > cursor)
        fragments.push({
          kind: "speech",
          text: text.slice(cursor, range.start),
        });
      fragments.push({
        kind: "stage-direction",
        text: text.slice(range.start, nextStart),
      });
      cursor = nextStart;
      return fragments;
    })
    .concat(
      cursor < text.length
        ? [{ kind: "speech", text: text.slice(cursor) }]
        : [],
    );
}

export function isStageDirectionBlock(
  block: SourceBlock,
  roles: RoleCandidate[],
): boolean {
  const text = normalizeScriptText(block.rawText || block.text);
  if (!text.trim() || /[「『“"]/u.test(text)) return false;

  const fragments = splitStageDirectionText(
    text,
    roles,
    block.speakerLabel?.trim(),
  );
  return (
    fragments.length > 0 &&
    fragments.every((fragment) => fragment.kind === "stage-direction")
  );
}

export function isCastListEntry(block: SourceBlock): boolean {
  const value = normalizeAlias(
    normalizeScriptText(
      `${block.speakerLabel ?? ""}${block.text || block.rawText}`,
    ),
  );
  const prefix = Array.from(value).slice(0, 48).join("");
  const ageMarker = /[（(][0-9０-９]{1,3}[）)]/u.exec(prefix);
  if (!ageMarker) return false;
  const afterAge = prefix.slice(
    ageMarker.index + ageMarker[0].length,
    ageMarker.index + ageMarker[0].length + 8,
  );
  return /(?:…|\.{2,})/u.test(afterAge);
}

function isPlausibleSingleSpeakerName(label: string): boolean {
  return NAME_CHARACTERS.test(label);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

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
        id: "turn-" + block.id + "-" + role.id,
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
      id: "practice-" + turn.id,
      turn,
      nextTurn,
      sceneNumber,
      sceneLabel: sceneNumber > 0 ? "シーン " + sceneNumber : "シーンが不明",
      minimumStartIndex,
      defaultStartIndex,
      defaultEndIndex: Math.min(blocks.length - 1, defaultEndIndex),
    };
  });
}

export function cueAtStart(
  text: string,
  recoveredOpeningMarkers: ReadonlySet<string> = new Set(),
  roles?: RoleCandidate[],
): { name: string; marker: string } | null {
  const cue = quotedCueAtStart(text, recoveredOpeningMarkers);
  if (!cue) return null;
  if (
    roles &&
    !roles.some((role) =>
      role.aliases.some(
        (alias) => normalizeAlias(alias) === normalizeAlias(cue.name),
      ),
    )
  )
    return null;
  return { name: cue.name, marker: cue.marker };
}

export function stripDuplicateSpeakerCue(
  text: string,
  speakerLabel: string,
  recoveredOpeningMarkers: ReadonlySet<string> = new Set(),
): string {
  const value = text.trimStart();
  const cue = quotedCueAtStart(value, recoveredOpeningMarkers);
  if (!cue || speakerLabelKey(cue.name) !== speakerLabelKey(speakerLabel))
    return text;

  const markerIndex = value.indexOf(cue.marker, cue.name.length);
  if (markerIndex < 0) return text;
  const prefix = value
    .slice(0, markerIndex)
    .trim()
    .replace(/^[【（(]/u, "")
    .replace(/[】）)]$/u, "")
    .trim();
  if (speakerLabelKey(prefix) !== speakerLabelKey(cue.name)) return text;

  return value.slice(markerIndex);
}

export function normalizeAlias(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\u3000]/gu, "")
    .trim();
}

function speakerLabelKey(value: string): string {
  const members = splitJointSpeakerNames(value);
  return members && members.length > 1
    ? members.map(normalizeAlias).sort().join("\u0000")
    : normalizeAlias(value);
}

export function blockPosition(block: SourceBlock): string {
  return block.direction === "vertical"
    ? block.pageNumber + "ページ目 · 右から" + block.orderOnPage + "列目"
    : block.pageNumber + "ページ目 · 上から" + block.orderOnPage + "行目";
}

export function hasEnoughText(blocks: SourceBlock[]): boolean {
  const total = blocks.reduce(
    (sum, block) => sum + block.text.trim().length,
    0,
  );
  return blocks.length > 0 && total >= 30;
}

function cueForBlock(
  block: SourceBlock,
  recoveredOpeningMarkers: ReadonlySet<string> = new Set(),
): Cue | null {
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

function quotedCueAtStart(
  text: string,
  recoveredOpeningMarkers: ReadonlySet<string> = new Set(),
): Cue | null {
  const value = text.trimStart();
  const wrapped = new RegExp(
    `^(?:【|（|\\()(${SPEAKER_LABEL_CHARACTER}{1,24})(?:】|）|\\))\\s*(.{1})`,
    "u",
  ).exec(value);
  if (
    wrapped &&
    isValidSpeakerLabel(wrapped[1]) &&
    isOpeningMarker(wrapped[2], recoveredOpeningMarkers) &&
    (!isCjkExtensionCharacter(wrapped[2]) ||
      value.slice(wrapped[0].length).trim())
  ) {
    return { name: wrapped[1], marker: wrapped[2], evidence: "quotation" };
  }

  const direct = new RegExp(
    `^(${SPEAKER_LABEL_CHARACTER}{1,24})[\\s\\u3000]*(.{1})`,
    "u",
  ).exec(value);
  if (
    !direct ||
    !isValidSpeakerLabel(direct[1]) ||
    !isOpeningMarker(direct[2], recoveredOpeningMarkers) ||
    (isCjkExtensionCharacter(direct[2]) &&
      !value.slice(direct[0].length).trim())
  )
    return null;
  return { name: direct[1], marker: direct[2], evidence: "quotation" };
}

function cueMatchesAlias(
  block: SourceBlock,
  alias: string,
  recoveredOpeningMarkers: ReadonlySet<string>,
): boolean {
  const normalizedAlias = normalizeAlias(alias);
  if (!normalizedAlias) return false;
  if (
    block.speakerAliases?.some(
      (candidate) => normalizeAlias(candidate) === normalizedAlias,
    )
  ) {
    return true;
  }
  if (
    block.speakerLabel &&
    normalizeAlias(block.speakerLabel) === normalizedAlias
  ) {
    return true;
  }

  const cue = quotedCueAtStart(block.text, recoveredOpeningMarkers);
  return Boolean(cue && normalizeAlias(cue.name) === normalizedAlias);
}

function isOpeningMarker(
  value: string,
  recoveredOpeningMarkers: ReadonlySet<string>,
): boolean {
  return OPENING_MARKERS.includes(value) || recoveredOpeningMarkers.has(value);
}

function isAmbiguousSpeakerQuoteMarker(value: string): boolean {
  return /[|｜│┃︱︳∣丨:：－―—–‐‑−─━-]/u.test(value);
}

function isAmbiguousClosingQuoteMarker(value: string): boolean {
  return /[|｜│┃︱︳∣丨:：]/u.test(value);
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

function slug(value: string): string {
  return Array.from(value)
    .map((character) => character.codePointAt(0)?.toString(16) ?? "0")
    .join("-");
}
