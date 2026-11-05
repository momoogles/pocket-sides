export function roleIdForName(name: string): string {
  return Array.from(name)
    .map((character) => character.codePointAt(0)?.toString(16) ?? "0")
    .join("-");
}
