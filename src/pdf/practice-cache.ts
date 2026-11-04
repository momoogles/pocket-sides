import type { BoundaryEdit } from "./boundaries";
import { OCR_RECOGNITION_VERSION, type RoleCandidate, type SourcePage } from "./types";

const DATABASE_NAME = "oboueru-daihon-local-readings";
const DATABASE_VERSION = 2;
const PRACTICE_STORE_NAME = "practices";
const LEGACY_READING_STORE_NAME = "readings";

export interface PracticeRangeSnapshot {
  start: number;
  end: number;
}

export interface SavedPracticeSettings {
  roles: RoleCandidate[];
  excludedRoleIds: string[];
  selectedRoleId: string;
  manualSpeakers: Record<string, string>;
  boundaryEdits?: BoundaryEdit[];
  manualRoleNumber: number;
  corrections: Record<string, string>;
  ranges: Record<string, PracticeRangeSnapshot>;
  currentTargetIndex: number;
  previewPage: number;
}

export interface SavedPractice {
  fingerprint: string;
  pageCount: number;
  pages: SourcePage[];
  savedAt: number;
  fileName: string;
  settings: SavedPracticeSettings;
}

export interface SavedPracticeSummary {
  fingerprint: string;
  pageCount: number;
  savedAt: number;
  fileName: string;
  roleLabel: string;
}

export type SavedPracticeInput = Omit<SavedPractice, "savedAt">;

export function canSavePracticeHistory(): boolean {
  return typeof indexedDB !== "undefined";
}

export function fingerprintPdf(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return Promise.resolve(null);
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  return globalThis.crypto.subtle.digest("SHA-256", digestInput)
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))
    .catch(() => null);
}

export async function getSavedPractice(fingerprint: string): Promise<SavedPractice | null> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(PRACTICE_STORE_NAME, "readonly");
    const request = transaction.objectStore(PRACTICE_STORE_NAME).get(fingerprint) as IDBRequest<SavedPractice | undefined>;
    const result = await requestResult(request);
    return result ? validateSavedPractice(result, fingerprint) : null;
  } finally {
    db.close();
  }
}

export async function listSavedPractices(): Promise<SavedPracticeSummary[]> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(PRACTICE_STORE_NAME, "readonly");
    const request = transaction.objectStore(PRACTICE_STORE_NAME).getAll() as IDBRequest<unknown[]>;
    const results = await requestResult(request);
    return results
      .map((result) => validateSavedPractice(result, ""))
      .filter((result): result is SavedPractice => result !== null)
      .map((result) => ({
        fingerprint: result.fingerprint,
        pageCount: result.pageCount,
        savedAt: result.savedAt,
        fileName: result.fileName,
        roleLabel: result.settings.roles.find((role) => role.id === result.settings.selectedRoleId)?.label ?? "役名不明",
      }))
      .sort((a, b) => b.savedAt - a.savedAt);
  } finally {
    db.close();
  }
}

export async function savePractice(input: SavedPracticeInput): Promise<SavedPractice> {
  if (!canSavePracticeHistory()) {
    throw new Error("このブラウザでは練習設定を保存できません。");
  }
  const saved: SavedPractice = { ...input, savedAt: Date.now() };
  const db = await openDatabase();
  try {
    const transaction = db.transaction(PRACTICE_STORE_NAME, "readwrite");
    transaction.objectStore(PRACTICE_STORE_NAME).put(saved);
    await transactionDone(transaction);
    return saved;
  } finally {
    db.close();
  }
}

export async function deleteSavedPractice(fingerprint: string): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction([PRACTICE_STORE_NAME, LEGACY_READING_STORE_NAME], "readwrite");
    transaction.objectStore(PRACTICE_STORE_NAME).delete(fingerprint);
    transaction.objectStore(LEGACY_READING_STORE_NAME).delete(fingerprint);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function deleteAllSavedPracticeData(): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction([PRACTICE_STORE_NAME, LEGACY_READING_STORE_NAME], "readwrite");
    transaction.objectStore(PRACTICE_STORE_NAME).clear();
    transaction.objectStore(LEGACY_READING_STORE_NAME).clear();
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!canSavePracticeHistory()) {
    return Promise.reject(new Error("このブラウザでは端末内保存を利用できません。"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_READING_STORE_NAME)) {
        db.createObjectStore(LEGACY_READING_STORE_NAME, { keyPath: "fingerprint" });
      }
      const practiceStore = db.objectStoreNames.contains(PRACTICE_STORE_NAME)
        ? request.transaction?.objectStore(PRACTICE_STORE_NAME)
        : db.createObjectStore(PRACTICE_STORE_NAME, { keyPath: "fingerprint" });
      const legacyStore = request.transaction?.objectStore(LEGACY_READING_STORE_NAME);
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
    const value = cursor.value as Partial<SavedPractice> | null;
    if (value && typeof value === "object" && value.settings && Array.isArray(value.pages)) {
      practiceStore.put(value);
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

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("端末内に保存できませんでした。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("端末内に保存できませんでした。"));
  });
}

function validateSavedPractice(value: unknown, expectedFingerprint: string): SavedPractice | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SavedPractice>;
  const settings = record.settings;
  if (
    typeof record.fingerprint !== "string" ||
    (expectedFingerprint && record.fingerprint !== expectedFingerprint) ||
    !Number.isInteger(record.pageCount) ||
    !Number.isFinite(record.savedAt) ||
    typeof record.fileName !== "string" ||
    !Array.isArray(record.pages) ||
    record.pages.length !== record.pageCount ||
    !settings ||
    !Array.isArray(settings.roles) ||
    !Array.isArray(settings.excludedRoleIds) ||
    typeof settings.selectedRoleId !== "string" ||
    !settings.selectedRoleId ||
    !settings.roles.some((role) => isRoleCandidate(role) && role.id === settings.selectedRoleId) ||
    !isStringMap(settings.manualSpeakers) ||
    (settings.boundaryEdits !== undefined && !isBoundaryEdits(settings.boundaryEdits)) ||
    !Number.isInteger(settings.manualRoleNumber) ||
    !isStringMap(settings.corrections) ||
    !isRangeMap(settings.ranges) ||
    !Number.isInteger(settings.currentTargetIndex) ||
    !Number.isInteger(settings.previewPage)
  ) return null;

  const pages = record.pages.filter((page): page is SourcePage => isSourcePage(page));
  if (pages.length !== record.pageCount) return null;
  return { ...record, pages, settings } as SavedPractice;
}

function isBoundaryEdits(value: unknown): value is BoundaryEdit[] {
  return Array.isArray(value) && value.every((entry) =>
    entry && typeof entry.blockId === "string" && typeof entry.text === "string" &&
    Number.isInteger(entry.offset) && entry.offset >= 0 && entry.offset < entry.text.length &&
    (typeof entry.roleId === "string" || (entry.roleId === null && entry.offset === 0)) &&
    (entry.speakerText === undefined || (typeof entry.speakerText === "string" && entry.text.slice(entry.offset).startsWith(entry.speakerText))),
  );
}

function isRoleCandidate(value: unknown): value is RoleCandidate {
  if (!value || typeof value !== "object") return false;
  const role = value as Partial<RoleCandidate>;
  return typeof role.id === "string" &&
    typeof role.label === "string" &&
    Array.isArray(role.aliases) &&
    role.aliases.every((alias) => typeof alias === "string") &&
    Number.isInteger(role.occurrenceCount) &&
    Array.isArray(role.exampleBlockIds) &&
    typeof role.manual === "boolean";
}

function isSourcePage(value: unknown): value is SourcePage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<SourcePage>;
  const containsRecognizedText = page.textSource === "ocr" ||
    page.textSource === "mixed" ||
    (Array.isArray(page.blocks) && page.blocks.some((block) =>
      block && typeof block === "object" && (block as { recognitionConfidence?: unknown }).recognitionConfidence !== undefined,
    ));
  return (!containsRecognizedText || (
    Number.isInteger(page.recognitionVersion) &&
    Number(page.recognitionVersion) > 0 &&
    Number(page.recognitionVersion) <= OCR_RECOGNITION_VERSION
  )) &&
    Number.isInteger(page.pageNumber) &&
    Number(page.pageNumber) >= 1 &&
    Number.isFinite(page.width) &&
    Number.isFinite(page.height) &&
    (page.direction === "vertical" || page.direction === "horizontal") &&
    Array.isArray(page.items) &&
    Array.isArray(page.blocks);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "string"));
}

function isRangeMap(value: unknown): value is Record<string, PracticeRangeSnapshot> {
  return Boolean(value && typeof value === "object" &&
    Object.values(value).every((range) =>
      Boolean(range && typeof range === "object" &&
        Number.isInteger((range as PracticeRangeSnapshot).start) &&
        Number.isInteger((range as PracticeRangeSnapshot).end)),
    ));
}
