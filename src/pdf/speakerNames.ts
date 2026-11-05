// Speaker labels are normalized and validated consistently across parsing and UI.
import type { RoleCandidate } from "./roleCandidate";

export const SAFE_NAME_CHARACTER = String.raw`(?:(?![\u3400-\u4dbf])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}々ヶヵー・])`;

export const NAME_CHARACTERS = new RegExp(
  `^${SAFE_NAME_CHARACTER}{1,12}$`,
  "u",
);

export const SPEAKER_LABEL_CHARACTER = `(?:${SAFE_NAME_CHARACTER}|[、,，&＆/／])`;

export function isCjkExtensionCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0x3400 && codePoint <= 0x4dbf;
}

export function isJointSpeakerSeparator(character: string): boolean {
  return (
    /[、,，・&＆/／]/u.test(character) || isCjkExtensionCharacter(character)
  );
}

export function resolveJointSpeakers(
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

export function findRoleByName(
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

export function splitJointSpeakerNames(label: string): string[] | null {
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

export function isValidSpeakerLabel(label: string): boolean {
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

function isPlausibleSingleSpeakerName(label: string): boolean {
  return NAME_CHARACTERS.test(label);
}

export function normalizeAlias(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\u3000]/gu, "")
    .trim();
}

export function speakerLabelKey(value: string): string {
  const members = splitJointSpeakerNames(value);
  return members && members.length > 1
    ? members.map(normalizeAlias).sort().join("\u0000")
    : normalizeAlias(value);
}
