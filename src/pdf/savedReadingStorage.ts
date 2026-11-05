import {
  openLocalScriptDatabase,
  READING_STORE_NAME,
  requestResult,
} from "./localScriptDatabase";
import { OCR_RECOGNITION_VERSION } from "./ocrRecognitionVersion";
import type { SourcePage } from "./sourcePage";

export interface SavedReading {
  fingerprint: string;
  pageCount: number;
  pages: SourcePage[];
  savedAt: number;
  fileName?: string;
}

export interface SavedReadingSummary {
  fingerprint: string;
  pageCount: number;
  savedAt: number;
  fileName?: string;
}

export async function getSavedReading(
  fingerprint: string,
): Promise<SavedReading | null> {
  const db = await openLocalScriptDatabase();
  try {
    const transaction = db.transaction(READING_STORE_NAME, "readonly");
    const request = transaction
      .objectStore(READING_STORE_NAME)
      .get(fingerprint) as IDBRequest<SavedReading | undefined>;
    const result = await requestResult(request);
    return result ? validateSavedReading(result, fingerprint) : null;
  } finally {
    db.close();
  }
}

export async function listSavedReadings(): Promise<SavedReadingSummary[]> {
  const db = await openLocalScriptDatabase();
  try {
    const transaction = db.transaction(READING_STORE_NAME, "readonly");
    const request = transaction
      .objectStore(READING_STORE_NAME)
      .getAll() as IDBRequest<SavedReading[]>;
    const results = await requestResult(request);
    return results
      .filter(
        (result) =>
          result &&
          typeof result.fingerprint === "string" &&
          Number.isInteger(result.pageCount) &&
          Number.isFinite(result.savedAt),
      )
      .map(({ fingerprint, pageCount, savedAt, fileName }) => ({
        fingerprint,
        pageCount,
        savedAt,
        ...(typeof fileName === "string" ? { fileName } : {}),
      }))
      .sort((a, b) => b.savedAt - a.savedAt);
  } finally {
    db.close();
  }
}

function validateSavedReading(
  value: SavedReading,
  fingerprint: string,
): SavedReading | null {
  if (
    value.fingerprint !== fingerprint ||
    !Number.isInteger(value.pageCount) ||
    !Array.isArray(value.pages)
  )
    return null;

  const pages = value.pages.filter(
    (page) =>
      page &&
      Number.isInteger(page.pageNumber) &&
      page.pageNumber >= 1 &&
      page.pageNumber <= value.pageCount &&
      (page.textSource === "ocr" || page.textSource === "mixed") &&
      page.recognitionVersion === OCR_RECOGNITION_VERSION &&
      Array.isArray(page.items) &&
      Array.isArray(page.blocks) &&
      page.blocks.some((block) => block.recognitionConfidence !== undefined),
  );
  return { ...value, pages };
}
