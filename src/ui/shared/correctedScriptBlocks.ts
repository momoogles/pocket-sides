// Build corrected source blocks from PDF text and user adjustments.
import { applyBoundaryEdits } from "../../pdf/applyBoundaryEdits";
import { applyCharacterCorrections } from "../../pdf/characterCorrections";
import { detectRoleCandidates } from "../../pdf/detectRoleCandidates";
import { normalizeScriptText } from "../../pdf/normalizeScriptText";
import type { ScriptState } from "../../pdf/pdfWorkspace";
import {
  applyRecoveredQuoteMarkers,
  cueAtStart,
  inferRecoveredClosingMarkers,
  inferRecoveredOpeningMarkers,
  stripDuplicateSpeakerCue,
} from "../../pdf/quoteMarkers";
import type { RoleCandidate } from "../../pdf/roleCandidate";
import { collectBlocks, isStageDirectionBlock } from "../../pdf/sourceBlocks";
import type { SourceBlock } from "../../pdf/sourcePage";
import {
  isPlausibleSpeakerLabel,
  normalizeAlias,
} from "../../pdf/speakerNames";
import { splitInlineSpeakerBlocks } from "../../pdf/speakerParsing";
import { appRoot as root } from "../appRoot";
import {
  cacheForScriptDocument,
  deleteScriptDataCache,
} from "./scriptDataCache";

export function usableRoleCandidates(): RoleCandidate[] {
  return root.pdfWorkspace.script.roles
    .filter((role) => role.manual || isPlausibleSpeakerLabel(role.label))
    .map((role) => ({
      ...role,
      aliases: role.aliases.filter(isPlausibleSpeakerLabel),
    }));
}

export function knownOcrSpeakerAliasKeys(): ReadonlySet<string> {
  const layoutAliases = collectBlocks(
    root.pdfWorkspace.script.originalPages,
  ).flatMap((block) => {
    if (
      !block.speakerLabel ||
      block.speakerEvidence === "quotation" ||
      !isPlausibleSpeakerLabel(block.speakerLabel)
    )
      return [];
    return [block.speakerLabel, ...(block.speakerAliases ?? [])];
  });
  const trustedRoleAliases = root.pdfWorkspace.script.roles
    .filter((role) => role.manual)
    .flatMap((role) => role.aliases);
  return new Set(
    [...layoutAliases, ...trustedRoleAliases]
      .map(normalizeAlias)
      .filter(Boolean),
  );
}

export function getRecoveredOpeningMarkers(): ReadonlySet<string> {
  return cacheForScriptDocument(root.pdfWorkspace.script).openingMarkers;
}

export function getOcrReconciliationContext() {
  const cache = cacheForScriptDocument(root.pdfWorkspace.script);
  return {
    recoveredOpeningMarkers: cache.openingMarkers,
    roles: usableRoleCandidates(),
  };
}

export function resetScriptDataCaches(
  scriptState: ScriptState = root.pdfWorkspace.script,
): void {
  deleteScriptDataCache(scriptState);
}

export function rawBlocks(): SourceBlock[] {
  return collectBlocks(root.pdfWorkspace.script.pages);
}

export function inferredMarkerCorrections(): Record<string, string> {
  const cache = cacheForScriptDocument(root.pdfWorkspace.script);
  const corrections: Record<string, string> = {};
  for (const marker of cache.openingMarkers) {
    if (!cache.closingMarkers.has(marker)) corrections[marker] = "「";
  }
  for (const marker of cache.closingMarkers) {
    if (!cache.openingMarkers.has(marker)) corrections[marker] = "」";
  }
  return corrections;
}

export function blocks(includeBoundaryEdits = true): SourceBlock[] {
  const script = root.pdfWorkspace.script;
  const cache = cacheForScriptDocument(script);
  const roleCandidates = usableRoleCandidates();
  const roleSignature = JSON.stringify(
    roleCandidates.map(({ id, label, aliases, manual }) => [
      id,
      label,
      aliases,
      manual,
    ]),
  );
  const correctionsSignature = JSON.stringify(script.corrections);
  if (
    cache.derivedBlocks &&
    cache.derivedBlocks.pages === script.pages &&
    cache.derivedBlocks.roles === roleSignature &&
    cache.derivedBlocks.corrections === correctionsSignature &&
    cache.derivedBlocks.boundaryEdits === script.boundaryEdits
  )
    return includeBoundaryEdits
      ? cache.derivedBlocks.value
      : cache.derivedBlocks.unedited;

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
  cache.openingMarkers = inferRecoveredOpeningMarkers(sourceBlocks);
  cache.closingMarkers = inferRecoveredClosingMarkers(
    sourceBlocks,
    cache.openingMarkers,
  );
  const corrected = applySeparatedLatinRoleSuffixes(
    applyRecoveredQuoteMarkers(
      applyCharacterCorrections(sourceBlocks, script.corrections),
      cache.openingMarkers,
      cache.closingMarkers,
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
    cache.openingMarkers,
  );
  const withoutDuplicateCues = corrected.map((block) =>
    block.speakerLabel
      ? {
          ...block,
          text: stripDuplicateSpeakerCue(
            block.text,
            block.speakerLabel,
            cache.openingMarkers,
          ),
        }
      : block,
  );
  const unedited = splitInlineSpeakerBlocks(
    withoutDuplicateCues,
    roleCandidates,
  );
  const result = applyBoundaryEdits(unedited, script.boundaryEdits);
  cache.derivedBlocks = {
    pages: script.pages,
    roles: roleSignature,
    corrections: correctionsSignature,
    boundaryEdits: script.boundaryEdits,
    unedited,
    value: result,
  };
  return includeBoundaryEdits ? result : unedited;
}

function applySeparatedLatinRoleSuffixes(
  sourceBlocks: SourceBlock[],
  openingMarkers: ReadonlySet<string>,
): SourceBlock[] {
  const result = sourceBlocks.map((block) => ({ ...block }));
  const inferredSuffixes = new Map<
    string,
    { baseName: string; suffix: string }
  >();
  for (let index = 0; index < result.length; index += 1) {
    const block = result[index];
    if (block?.direction !== "vertical") continue;
    const cue = block.speakerLabel
      ? { name: block.speakerLabel }
      : cueAtStart(block.text, openingMarkers, usableRoleCandidates());
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
      : cueAtStart(block.text, openingMarkers, usableRoleCandidates());
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
