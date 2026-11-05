import type { PDFDocumentProxy } from "pdfjs-dist";
import type { BoundaryEdit } from "./applyBoundaryEdits";
import type { SavedPractice } from "./practiceStorage";
import type { RoleCandidate } from "./roleCandidate";
import type { SourcePage } from "./sourcePage";

export interface PdfFileState {
  fileName: string;
  fileSize: number;
  pdfFingerprint: string | null;
  document: PDFDocumentProxy | null;
  disposePdf: (() => Promise<void>) | null;
}

export interface ScriptState {
  pages: SourcePage[];
  originalPages: SourcePage[];
  cachedOcrPages: SourcePage[];
  corrections: Record<string, string>;
  roles: RoleCandidate[];
  excludedRoleIds: Set<string>;
  selectedRoleId: string;
  manualSpeakers: Record<string, string>;
  boundaryEdits: BoundaryEdit[];
  manualRoleNumber: number;
}

export interface AnalysisState {
  previewPage: number;
  previewZoom: number;
  ocrBusy: boolean;
  ocrCancelRequested: boolean;
  ocrProgress: number;
  ocrTotal: number;
  ocrStatus: string;
  ocrErrors: Record<"text" | "layout", string>;
  textOcrCompletion: { pageCount: number; replacedPages: number } | null;
  layoutOcrCompletion: { pageCount: number } | null;
  ocrPurpose: "layout" | "text";
  layoutPreview: SourcePage[] | null;
  ocrAnalysisComplete: boolean;
  textOcrPreview: {
    pages: SourcePage[];
    corrections: Record<string, string>;
  } | null;
}

export interface PracticeRange {
  start: number;
  end: number;
}

export interface PracticeState {
  savedPractice: SavedPractice | null;
  practiceSaveBusy: boolean;
  practiceHasStarted: boolean;
  currentTargetIndex: number;
  ranges: Record<string, PracticeRange>;
}

export interface PdfWorkspaceState {
  file: PdfFileState;
  script: ScriptState;
  analysis: AnalysisState;
  practice: PracticeState;
}

export function createPdfWorkspaceState(): PdfWorkspaceState {
  return {
    file: {
      fileName: "",
      fileSize: 0,
      pdfFingerprint: null,
      document: null,
      disposePdf: null,
    },
    script: {
      pages: [],
      originalPages: [],
      cachedOcrPages: [],
      corrections: {},
      roles: [],
      excludedRoleIds: new Set(),
      selectedRoleId: "",
      manualSpeakers: {},
      boundaryEdits: [],
      manualRoleNumber: 0,
    },
    analysis: {
      previewPage: 1,
      previewZoom: 1,
      ocrBusy: false,
      ocrCancelRequested: false,
      ocrProgress: 0,
      ocrTotal: 0,
      ocrStatus: "",
      ocrErrors: { text: "", layout: "" },
      textOcrCompletion: null,
      layoutOcrCompletion: null,
      ocrPurpose: "layout",
      layoutPreview: null,
      ocrAnalysisComplete: false,
      textOcrPreview: null,
    },
    practice: {
      savedPractice: null,
      practiceSaveBusy: false,
      practiceHasStarted: false,
      currentTargetIndex: 0,
      ranges: {},
    },
  };
}
