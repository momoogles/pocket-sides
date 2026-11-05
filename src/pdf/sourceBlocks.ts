// Source blocks provide the shared text and page-level parsing helpers.
import { normalizeScriptText } from "./normalizeScriptText";
import type { RoleCandidate } from "./roleCandidate";
import type { SourceBlock, SourcePage } from "./sourcePage";
import { isPlausibleSpeakerLabel, normalizeAlias } from "./speakerNames";

export interface ScriptTextFragment {
  kind: "speech" | "stage-direction";
  text: string;
}

export function collectBlocks(pages: SourcePage[]): SourceBlock[] {
  return pages.flatMap((page) => page.blocks);
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
