// Application state is owned here; views read it and actions update it.

import type { PDFDocumentProxy } from "pdfjs-dist";
import type { BoundaryEdit } from "../pdf/boundaries";
import type { SavedReadingSummary } from "../pdf/ocr-cache";
import type {
  SavedPractice,
  SavedPracticeSummary,
} from "../pdf/practice-cache";
import type { RoleCandidate, SourcePage } from "../pdf/types";

type Screen = "home" | "analysis" | "appearances" | "practice";

type LoadingPurpose = "opening-pdf" | "restoring-practice";

export type NotificationTone = "info" | "success" | "warning";

interface AppNotification {
  id: number;
  message: string;
  tone: NotificationTone;
}

export interface PracticeRange {
  start: number;
  end: number;
}

export interface AppState {
  screen: Screen;
  loading: boolean;
  loadingPurpose: LoadingPurpose;
  progress: number;
  progressLabel: string;
  error: string;
  fileName: string;
  fileSize: number;
  pages: SourcePage[];
  originalPages: SourcePage[];
  pdfFingerprint: string | null;
  cachedOcrPages: SourcePage[];
  legacySavedReadings: SavedReadingSummary[];
  savedPractices: SavedPracticeSummary[];
  savedPractice: SavedPractice | null;
  notification: AppNotification | null;
  practiceSaveBusy: boolean;
  pendingResumeFingerprint: string | null;
  practiceHasStarted: boolean;
  document: PDFDocumentProxy | null;
  disposePdf: (() => Promise<void>) | null;
  corrections: Record<string, string>;
  roles: RoleCandidate[];
  excludedRoleIds: Set<string>;
  selectedRoleId: string;
  manualSpeakers: Record<string, string>;
  boundaryEdits: BoundaryEdit[];
  manualRoleNumber: number;
  previewPage: number;
  previewZoom: number;
  currentTargetIndex: number;
  ranges: Record<string, PracticeRange>;
  revealed: boolean;
  showOriginal: boolean;
  originalPage: number;
  ocrBusy: boolean;
  ocrCancelRequested: boolean;
  ocrProgress: number;
  ocrTotal: number;
  ocrStatus: string;
  ocrErrors: Record<"text" | "layout", string>;
  textOcrCompletion: { pageCount: number; replacedPages: number } | null;
  ocrPurpose: "layout" | "text";
  layoutPreview: SourcePage[] | null;
  ocrAnalysisComplete: boolean;
  textOcrPreview: {
    pages: SourcePage[];
    corrections: Record<string, string>;
  } | null;
}

export const state: AppState = {
  screen: "home",
  loading: false,
  loadingPurpose: "opening-pdf",
  progress: 0,
  progressLabel: "",
  error: "",
  fileName: "",
  fileSize: 0,
  pages: [],
  originalPages: [],
  pdfFingerprint: null,
  cachedOcrPages: [],
  legacySavedReadings: [],
  savedPractices: [],
  savedPractice: null,
  notification: null,
  practiceSaveBusy: false,
  pendingResumeFingerprint: null,
  practiceHasStarted: false,
  document: null,
  disposePdf: null,
  corrections: {},
  roles: [],
  excludedRoleIds: new Set(),
  selectedRoleId: "",
  manualSpeakers: {},
  boundaryEdits: [],
  manualRoleNumber: 0,
  previewPage: 1,
  previewZoom: 1,
  currentTargetIndex: 0,
  ranges: {},
  revealed: false,
  showOriginal: false,
  originalPage: 1,
  ocrBusy: false,
  ocrCancelRequested: false,
  ocrProgress: 0,
  ocrTotal: 0,
  ocrStatus: "",
  ocrErrors: { text: "", layout: "" },
  textOcrCompletion: null,
  ocrPurpose: "layout",
  layoutPreview: null,
  ocrAnalysisComplete: false,
  textOcrPreview: null,
};
