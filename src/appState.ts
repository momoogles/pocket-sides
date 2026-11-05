import type { SavedPracticeSummary } from "./pdf/practiceStorage";
import type { SavedReadingSummary } from "./pdf/savedReadingStorage";

type Screen = "home" | "analysis" | "appearances" | "practice";
type LoadingPurpose = "opening-pdf" | "restoring-practice";

export type NotificationTone = "info" | "success" | "warning";

interface AppNotification {
  id: number;
  message: string;
  tone: NotificationTone;
}

export interface AppState {
  screen: Screen;
  loading: boolean;
  loadingPurpose: LoadingPurpose;
  progress: number;
  progressLabel: string;
  error: string;
  legacySavedReadings: SavedReadingSummary[];
  savedPractices: SavedPracticeSummary[];
  notification: AppNotification | null;
  pendingResumeFingerprint: string | null;
}

export function createAppState(): AppState {
  return {
    screen: "home",
    loading: false,
    loadingPurpose: "opening-pdf",
    progress: 0,
    progressLabel: "",
    error: "",
    legacySavedReadings: [],
    savedPractices: [],
    notification: null,
    pendingResumeFingerprint: null,
  };
}
