// Character tests shared by OCR alignment and correction inference.

export function isUnreadableCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    codePoint === 0xfffd ||
    codePoint === 0x25a1 ||
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

export function isAlignmentAnchor(character: string): boolean {
  return !isUnreadableCharacter(character) && !/\s/u.test(character);
}

export function isReplaceableSourceCharacter(
  source: string[],
  index: number,
): boolean {
  const character = source[index] ?? "";
  if (isUnreadableCharacter(character)) return true;
  return (
    isLineStrokeCharacter(character) && hasJapaneseNeighbors(source, index)
  );
}

export function isLineStrokeCharacter(character: string): boolean {
  return /[|｜│┃︱︳∣丨ー―—–‐‑−─━-]/u.test(character);
}

export function isVerticalStrokeCharacter(character: string): boolean {
  return /[|｜│┃︱︳∣丨]/u.test(character);
}

export function isUnmatchedBoundaryCharacter(
  source: string[],
  index: number,
): boolean {
  return unmatchedBoundaryKind(source, index) !== undefined;
}

export function unmatchedBoundaryKind(
  source: string[],
  index: number,
): "start" | "end" | undefined {
  if (!isUnreadableCharacter(source[index] ?? "")) return undefined;
  let first = 0;
  let last = source.length - 1;
  while (first <= last && /\s/u.test(source[first] ?? "")) first += 1;
  while (last >= first && /\s/u.test(source[last] ?? "")) last -= 1;
  if (index === first) return "start";
  if (index === last) return "end";
  return undefined;
}

export function lastIndexOfCharacter(
  characters: Array<{ character: string; index: number }>,
  predicate: (character: string) => boolean,
): number {
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    if (predicate(characters[index]?.character ?? ""))
      return characters[index]?.index ?? -1;
  }
  return -1;
}

export function isClosingQuoteCharacter(character: string): boolean {
  return /[」』”"]/u.test(character);
}

export function isOpeningDelimiterCharacter(character: string): boolean {
  return /[「『“"（(【［[{〈《:：|｜│┃︱︳∣丨\-－―—–‐‑−─━]/u.test(character);
}

export function hasJapaneseNeighbors(source: string[], index: number): boolean {
  const previous = adjacentNonWhitespaceCharacter(source, index, -1);
  const next = adjacentNonWhitespaceCharacter(source, index, 1);
  return isJapaneseScriptCharacter(previous) && isJapaneseScriptCharacter(next);
}

export function adjacentNonWhitespaceCharacter(
  source: string[],
  index: number,
  step: -1 | 1,
): string {
  for (
    let cursor = index + step;
    cursor >= 0 && cursor < source.length;
    cursor += step
  ) {
    const character = source[cursor] ?? "";
    if (!/\s/u.test(character)) return character;
  }
  return "";
}

export function isJapaneseScriptCharacter(character: string): boolean {
  return (
    !isUnreadableCharacter(character) &&
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶヵ]/u.test(
      character,
    )
  );
}
