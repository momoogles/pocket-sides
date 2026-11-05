// Quote markers are recovered and normalized from repeated speaker-cue structure.
import type { RoleCandidate, RoleEvidence } from "./roleCandidate";
import type { SourceBlock } from "./sourcePage";
import {
  isCjkExtensionCharacter,
  isValidSpeakerLabel,
  normalizeAlias,
  SPEAKER_LABEL_CHARACTER,
  speakerLabelKey,
} from "./speakerNames";

export const OPENING_MARKERS = [
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

export const SPEECH_WITH_STAGE_DIRECTION_MARKERS = new Set([
  "（",
  "(",
  "［",
  "[",
  "【",
]);

export const CUE_BOUNDARY_MARKERS = new Set([
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

export interface SpeakerCue {
  name: string;
  marker: string;
  evidence: RoleEvidence;
  aliases?: string[];
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

export function isPotentialQuoteMarker(value: string): boolean {
  return isCjkExtensionCharacter(value) || /[|｜│┃︱︳∣丨]/u.test(value);
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

export function quotedCueAtStart(
  text: string,
  recoveredOpeningMarkers: ReadonlySet<string> = new Set(),
): SpeakerCue | null {
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

export function cueMatchesAlias(
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

export function isOpeningMarker(
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
