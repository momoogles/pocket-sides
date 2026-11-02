export type ReadingDirection = "vertical" | "horizontal";
export type RoleEvidence = "quotation" | "layout" | "recovered" | "manual";

export const OCR_RECOGNITION_VERSION = 15;

export interface SourceItem {
  id: string;
  pageNumber: number;
  contentIndex: number;
  text: string;
  direction: "ltr" | "rtl" | "ttb";
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

export interface SourceBlock {
  id: string;
  pageNumber: number;
  orderOnPage: number;
  direction: ReadingDirection;
  rawText: string;
  text: string;
  x: number;
  y: number;
  itemIds: string[];
  /** A short label isolated from the following text by PDF layout spacing. */
  speakerLabel?: string;
  /** Distance to the next source column or row, used as a layout hint. */
  visualGapAfter?: number;
  /** Approximate source font size, used to associate inline Latin letters by position. */
  fontSize?: number;
  /** Alternate spellings retained when a role suffix is isolated in an adjacent column. */
  speakerAliases?: string[];
  /** Role names that speak together on this line. */
  coSpeakers?: string[];
  /** A standalone source token visually associated with a neighboring speaker label. */
  isSpeakerSuffix?: boolean;
  /** OCR confidence from 0 to 100 when this block came from image recognition. */
  recognitionConfidence?: number;
  /** OCR word-center span on the cross axis, used to reject lines spanning multiple columns. */
  recognitionBounds?: { xMin: number; yMin: number; xMax: number; yMax: number };
}

export interface SourcePage {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  direction: ReadingDirection;
  textSource?: "pdf-text" | "ocr" | "mixed";
  recognitionVersion?: number;
  recognitionConfidence?: number;
  items: SourceItem[];
  blocks: SourceBlock[];
}

export interface RoleCandidate {
  id: string;
  label: string;
  aliases: string[];
  occurrenceCount: number;
  exampleBlockIds: string[];
  manual: boolean;
  evidence?: RoleEvidence;
}

export interface SpeakerTurn {
  id: string;
  roleId: string;
  startIndex: number;
  endIndex: number;
  startPage: number;
  endPage: number;
}

export interface PracticeTarget {
  id: string;
  turn: SpeakerTurn;
  nextTurn?: SpeakerTurn;
  sceneNumber: number;
  sceneLabel: string;
  minimumStartIndex: number;
  defaultStartIndex: number;
  defaultEndIndex: number;
}

export interface LoadedPdf {
  document: import("pdfjs-dist").PDFDocumentProxy;
  pages: SourcePage[];
  /** A local-only digest used to match saved reading results; never sent anywhere. */
  fingerprint: string | null;
  dispose: () => Promise<void>;
}
