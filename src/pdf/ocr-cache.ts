import { OCR_RECOGNITION_VERSION, type SourcePage } from "./types";

const DATABASE_NAME = "oboueru-daihon-local-readings";
const DATABASE_VERSION = 2;
const STORE_NAME = "readings";
const PRACTICE_STORE_NAME = "practices";

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

export function fingerprintPdf(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return Promise.resolve(null);
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  return globalThis.crypto.subtle.digest("SHA-256", digestInput)
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))
    .catch(() => null);
}

export async function getSavedReading(fingerprint: string): Promise<SavedReading | null> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(fingerprint) as IDBRequest<SavedReading | undefined>;
    const result = await requestResult(request);
    return result ? validateSavedReading(result, fingerprint) : null;
  } finally {
    db.close();
  }
}

export async function listSavedReadings(): Promise<SavedReadingSummary[]> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll() as IDBRequest<SavedReading[]>;
    const results = await requestResult(request);
    return results
      .filter((result) =>
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

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("このブラウザでは端末内保存を利用できません。"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "fingerprint" });
      }
      const practiceStore = db.objectStoreNames.contains(PRACTICE_STORE_NAME)
        ? request.transaction?.objectStore(PRACTICE_STORE_NAME)
        : db.createObjectStore(PRACTICE_STORE_NAME, { keyPath: "fingerprint" });
      const legacyStore = request.transaction?.objectStore(STORE_NAME);
      if (practiceStore && legacyStore) migratePractices(practiceStore, legacyStore);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("端末内の保存領域を開けませんでした。"));
    request.onblocked = () => reject(new Error("端末内の保存領域を開けませんでした。"));
  });
}

function migratePractices(practiceStore: IDBObjectStore, legacyStore: IDBObjectStore): void {
  const request = legacyStore.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const value = cursor.value as { settings?: unknown; pages?: unknown } | null;
    if (value && typeof value === "object" && value.settings && Array.isArray(value.pages)) {
      practiceStore.put(cursor.value);
      cursor.delete();
    }
    cursor.continue();
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("端末内の保存結果を読み取れませんでした。"));
  });
}

function validateSavedReading(value: SavedReading, fingerprint: string): SavedReading | null {
  if (
    value.fingerprint !== fingerprint ||
    !Number.isInteger(value.pageCount) ||
    !Array.isArray(value.pages)
  ) return null;

  const pages = value.pages.filter((page) =>
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
