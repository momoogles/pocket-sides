// Apply and infer corrections for characters unreadable in the source PDF.

import {
  normalizeScriptPunctuation,
  normalizeScriptText,
} from "./normalizeScriptText";
import type { SourceBlock } from "./sourcePage";
import { isUnreadableCharacter } from "./unreadableCharacter";

export interface CharacterMappingEvidence {
  sourceCharacter: string;
  recognizedCharacter: string;
  pageNumber: number;
  blockId: string;
}

export interface UnusualCharacter {
  character: string;
  count: number;
  exampleBlockId: string;
  examplePage: number;
  example: string;
}

export function applyCharacterCorrections(
  blocks: SourceBlock[],
  corrections: Record<string, string>,
): SourceBlock[] {
  const replaceCharacters = (value: string) =>
    Array.from(value)
      .map((character) => corrections[character] ?? character)
      .join("");

  return blocks.map((block) => {
    const speakerLabel = block.speakerLabel
      ? normalizeScriptText(replaceCharacters(block.speakerLabel))
      : undefined;
    const normalizedRawText = normalizeScriptPunctuation(
      block.rawText,
      speakerLabel,
    );
    const replacedRawText = replaceCharacters(normalizedRawText);
    const correctedRawText = normalizeScriptText(replacedRawText);
    const text =
      speakerLabel && correctedRawText.startsWith(speakerLabel)
        ? correctedRawText.slice(speakerLabel.length).trimStart()
        : correctedRawText;

    return {
      ...block,
      ...(speakerLabel ? { speakerLabel } : {}),
      text,
    };
  });
}

export function findUnusualCharacters(
  blocks: SourceBlock[],
  corrections: Record<string, string>,
): UnusualCharacter[] {
  const found = new Map<string, UnusualCharacter>();

  for (const block of blocks) {
    const reviewText = block.rawText;
    for (const character of Array.from(reviewText)) {
      if (!isUnusualCharacter(character) || corrections[character]?.trim())
        continue;
      const entry = found.get(character);
      if (entry) {
        entry.count += 1;
        continue;
      }
      found.set(character, {
        character,
        count: 1,
        exampleBlockId: block.id,
        examplePage: block.pageNumber,
        example: contextAround(reviewText, character),
      });
    }
  }

  return [...found.values()].sort(
    (a, b) => b.count - a.count || a.character.localeCompare(b.character, "ja"),
  );
}

export function startsWithUnreadableCharacter(value: string): boolean {
  const firstCharacter = Array.from(value.trimStart())[0] ?? "";
  return isUnreadableCharacter(firstCharacter);
}

/** Infers a replacement only when OCR agrees across independent lines and pages. */
export function inferDocumentCharacterCorrections(
  evidence: CharacterMappingEvidence[],
): Record<string, string> {
  const observations = new Map<
    string,
    Map<string, { count: number; blocks: Set<string>; pages: Set<number> }>
  >();

  for (const item of evidence) {
    if (
      !isUnreadableCharacter(item.sourceCharacter) ||
      Array.from(item.recognizedCharacter).length !== 1 ||
      isUnreadableCharacter(item.recognizedCharacter) ||
      /\s/u.test(item.recognizedCharacter)
    )
      continue;

    let candidates = observations.get(item.sourceCharacter);
    if (!candidates) {
      candidates = new Map();
      observations.set(item.sourceCharacter, candidates);
    }
    let candidate = candidates.get(item.recognizedCharacter);
    if (!candidate) {
      candidate = { count: 0, blocks: new Set(), pages: new Set() };
      candidates.set(item.recognizedCharacter, candidate);
    }
    candidate.count += 1;
    candidate.blocks.add(`${item.pageNumber}:${item.blockId}`);
    candidate.pages.add(item.pageNumber);
  }

  const corrections: Record<string, string> = {};
  for (const [sourceCharacter, candidates] of observations) {
    const ranked = [...candidates.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    );
    const [recognizedCharacter, winner] = ranked[0] ?? [];
    const totalCount = ranked.reduce(
      (sum, [, candidate]) => sum + candidate.count,
      0,
    );
    if (
      recognizedCharacter &&
      winner &&
      winner.count >= 3 &&
      winner.blocks.size >= 2 &&
      winner.pages.size >= 2 &&
      winner.count / totalCount >= 0.8
    )
      corrections[sourceCharacter] = recognizedCharacter;
  }
  return corrections;
}

function isUnusualCharacter(character: string): boolean {
  return isUnreadableCharacter(character);
}

function contextAround(value: string, target: string): string {
  const position = value.indexOf(target);
  const start = Math.max(0, position - 12);
  const end = Math.min(value.length, position + target.length + 18);
  return value.slice(start, end);
}
