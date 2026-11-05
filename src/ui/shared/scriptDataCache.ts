// Cache derived script data for the lifetime of its ScriptState object.
import type { BoundaryEdit } from "../../pdf/applyBoundaryEdits";
import type { ScriptState } from "../../pdf/pdfWorkspace";
import type { PracticeTarget } from "../../pdf/practiceTarget";
import type { SourceBlock, SourcePage } from "../../pdf/sourcePage";
import type { SpeakerTurn } from "../../pdf/speakerTurn";

export interface CachedDerivedBlocks {
  pages: SourcePage[];
  roles: string;
  corrections: string;
  boundaryEdits: BoundaryEdit[];
  unedited: SourceBlock[];
  value: SourceBlock[];
}

export interface CachedSpeakerTurns {
  blocks: SourceBlock[];
  roles: string;
  manualSpeakers: string;
  value: SpeakerTurn[];
}

export interface CachedPracticeTargets {
  blocks: SourceBlock[];
  turns: SpeakerTurn[];
  roleId: string;
  value: PracticeTarget[];
}

export interface ScriptDataCache {
  derivedBlocks: CachedDerivedBlocks | null;
  speakerTurns: CachedSpeakerTurns | null;
  practiceTargets: CachedPracticeTargets | null;
  openingMarkers: Set<string>;
  closingMarkers: Set<string>;
}

const cachesByScriptDocument = new WeakMap<ScriptState, ScriptDataCache>();

export function cacheForScriptDocument(
  scriptDocument: ScriptState,
): ScriptDataCache {
  const cached = cachesByScriptDocument.get(scriptDocument);
  if (cached) return cached;

  const cache: ScriptDataCache = {
    derivedBlocks: null,
    speakerTurns: null,
    practiceTargets: null,
    openingMarkers: new Set(),
    closingMarkers: new Set(),
  };
  cachesByScriptDocument.set(scriptDocument, cache);
  return cache;
}

export function deleteScriptDataCache(scriptDocument: ScriptState): void {
  cachesByScriptDocument.delete(scriptDocument);
}
