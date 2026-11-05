// Source blocks provide the shared text and page-level parsing helpers.
import { normalizeScriptText } from "./normalizeScriptText";
import type { RoleCandidate } from "./roleCandidate";
import type { SourceBlock, SourcePage } from "./sourcePage";
import { isPlausibleSpeakerLabel, normalizeAlias } from "./speakerNames";

export interface ScriptTextFragment {
  kind: "speech" | "stage-direction";
  text: string;
}

const DIALOGUE_QUOTE_PAIRS = new Map([
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ['"', '"'],
]);

export function collectBlocks(pages: SourcePage[]): SourceBlock[] {
  return pages.flatMap((page) => page.blocks);
}

export function splitStageDirectionText(
  text: string,
  roles: RoleCandidate[],
  leadingSpeakerLabel?: string,
): ScriptTextFragment[] {
  const speakerNames = [
    ...new Set([
      ...(leadingSpeakerLabel ? [leadingSpeakerLabel] : []),
      ...roles.flatMap((role) => [role.label, ...role.aliases]),
    ]),
  ]
    .filter(isPlausibleSpeakerLabel)
    .sort((a, b) => b.length - a.length);
  if (speakerNames.length === 0) return [{ kind: "speech", text }];

  // 役名の直後に読点があるまとまりを、ト書きの構造として扱う。
  // 内容の単語からセリフかト書きかを推測しない。
  const name = `(?:${speakerNames.map(escapeRegularExpression).join("|")})`;
  const subjects = `${name}(?:と${name})*`;
  const startPattern = new RegExp(
    `(^|[」』。．.!！?？…\\n])${subjects}[、,，]`,
    "gu",
  );
  const rangeStarts = new Set<number>();
  const quotedTailStart = findQuotedSpeechTailStart(
    text,
    speakerNames,
    leadingSpeakerLabel,
  );
  if (quotedTailStart !== null) rangeStarts.add(quotedTailStart);

  const quotedRanges = findDialogueQuoteRanges(text);
  for (
    let match = startPattern.exec(text);
    match !== null;
    match = startPattern.exec(text)
  ) {
    const start = match.index + (match[1]?.length ?? 0);
    if (
      !quotedRanges.some((range) => range.start <= start && start < range.end)
    )
      rangeStarts.add(start);
  }

  if (rangeStarts.size === 0) return [{ kind: "speech", text }];
  const ranges = [...rangeStarts].sort((a, b) => a - b);
  let cursor = 0;
  return ranges
    .flatMap((range, index) => {
      const nextStart = ranges[index + 1] ?? text.length;
      const fragments: ScriptTextFragment[] = [];
      if (range > cursor)
        fragments.push({
          kind: "speech",
          text: text.slice(cursor, range),
        });
      fragments.push({
        kind: "stage-direction",
        text: text.slice(range, nextStart),
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
  if (!text.trim()) return false;

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

function findQuotedSpeechTailStart(
  text: string,
  speakerNames: string[],
  leadingSpeakerLabel?: string,
): number | null {
  const openingIndex = findLeadingDialogueQuote(
    text,
    speakerNames,
    leadingSpeakerLabel,
  );
  if (openingIndex === null) return null;

  let closingIndex = findMatchingDialogueQuote(text, openingIndex);
  if (closingIndex < 0) return null;

  while (closingIndex + 1 < text.length) {
    let probe = closingIndex + 1;
    while (/[\s\u3000。．.!！?？…]/u.test(text[probe] ?? "")) probe += 1;
    if (probe >= text.length) return null;

    const nextCharacter = String.fromCodePoint(text.codePointAt(probe) ?? 0);
    if (!DIALOGUE_QUOTE_PAIRS.has(nextCharacter)) return probe;

    closingIndex = findMatchingDialogueQuote(text, probe);
    if (closingIndex < 0) return null;
  }

  return null;
}

function findLeadingDialogueQuote(
  text: string,
  speakerNames: string[],
  leadingSpeakerLabel?: string,
): number | null {
  const value = text.trimStart();
  const offset = text.length - value.length;
  if (
    leadingSpeakerLabel &&
    DIALOGUE_QUOTE_PAIRS.has(String.fromCodePoint(value.codePointAt(0) ?? 0))
  )
    return offset;

  for (const name of speakerNames) {
    if (!value.startsWith(name)) continue;
    let cursor = name.length;
    while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
    if (/[：:,，]/u.test(value[cursor] ?? "")) cursor += 1;
    while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
    const quote = String.fromCodePoint(value.codePointAt(cursor) ?? 0);
    if (DIALOGUE_QUOTE_PAIRS.has(quote)) return offset + cursor;
  }

  return null;
}

function findDialogueQuoteRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < text.length; ) {
    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
    if (!DIALOGUE_QUOTE_PAIRS.has(character)) {
      index += character.length;
      continue;
    }

    const closingIndex = findMatchingDialogueQuote(text, index);
    if (closingIndex < 0) {
      index += character.length;
      continue;
    }
    ranges.push({ start: index, end: closingIndex + 1 });
    index = closingIndex + 1;
  }
  return ranges;
}

function findMatchingDialogueQuote(text: string, openingIndex: number): number {
  const opening = String.fromCodePoint(text.codePointAt(openingIndex) ?? 0);
  const firstClosing = DIALOGUE_QUOTE_PAIRS.get(opening);
  if (!firstClosing) return -1;

  const closings = [firstClosing];
  for (let index = openingIndex + opening.length; index < text.length; ) {
    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const expectedClosing = closings[closings.length - 1];
    if (character === expectedClosing) {
      closings.pop();
      if (closings.length === 0) return index;
    } else {
      const nestedClosing = DIALOGUE_QUOTE_PAIRS.get(character);
      if (nestedClosing) closings.push(nestedClosing);
    }
    index += character.length;
  }

  return -1;
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

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function blockPosition(block: SourceBlock): string {
  return block.direction === "vertical"
    ? `${block.pageNumber}ページ目 · 右から${block.orderOnPage}列目`
    : `${block.pageNumber}ページ目 · 上から${block.orderOnPage}行目`;
}

export function hasEnoughText(blocks: SourceBlock[]): boolean {
  const total = blocks.reduce(
    (sum, block) => sum + block.text.trim().length,
    0,
  );
  return blocks.length > 0 && total >= 30;
}
