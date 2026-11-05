export type ReadingDirection = "vertical" | "horizontal";

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
  speakerEvidence?: "layout" | "quotation";
  /** Distance to the next source column or row, used as a layout hint. */
  visualGapAfter?: number;
  /** Approximate source font size, used to associate inline Latin letters by position. */
  fontSize?: number;
  /** Alternate spellings retained when a role suffix is isolated in an adjacent column. */
  speakerAliases?: string[];
  /** Role names that speak together on this line. */
  coSpeakers?: string[];
  boundaryRoleId?: string | null;
  boundaryOrigin?: {
    blockId: string;
    text: string;
    offset: number;
    labelLength?: number;
  };
  /** A standalone source token visually associated with a neighboring speaker label. */
  isSpeakerSuffix?: boolean;
  /** OCR confidence from 0 to 100 when this block came from image recognition. */
  recognitionConfidence?: number;
  /** OCR word-center span on the cross axis, used to reject lines spanning multiple columns. */
  recognitionBounds?: {
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
  };
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
