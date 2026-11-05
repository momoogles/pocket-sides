// Own the shared IndexedDB schema for saved readings and practice settings.

export const READING_STORE_NAME = "readings";
export const PRACTICE_STORE_NAME = "practices";
const DATABASE_NAME = "oboueru-daihon-local-readings";
const DATABASE_VERSION = 2;

export function openLocalScriptDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("このブラウザでは端末内保存を利用できません。"),
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(READING_STORE_NAME)) {
        db.createObjectStore(READING_STORE_NAME, { keyPath: "fingerprint" });
      }
      const practiceStore = db.objectStoreNames.contains(PRACTICE_STORE_NAME)
        ? request.transaction?.objectStore(PRACTICE_STORE_NAME)
        : db.createObjectStore(PRACTICE_STORE_NAME, { keyPath: "fingerprint" });
      const readingStore = request.transaction?.objectStore(READING_STORE_NAME);
      if (practiceStore && readingStore)
        migratePractices(practiceStore, readingStore);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("端末内の保存領域を開けませんでした。"),
      );
    request.onblocked = () =>
      reject(new Error("端末内の保存領域を開けませんでした。"));
  });
}

function migratePractices(
  practiceStore: IDBObjectStore,
  readingStore: IDBObjectStore,
): void {
  const request = readingStore.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const value = cursor.value as {
      settings?: unknown;
      pages?: unknown;
    } | null;
    if (
      value &&
      typeof value === "object" &&
      value.settings &&
      Array.isArray(value.pages)
    ) {
      practiceStore.put(cursor.value);
      cursor.delete();
    }
    cursor.continue();
  };
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("端末内の保存結果を読み取れませんでした。"),
      );
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("端末内に保存できませんでした。"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("端末内に保存できませんでした。"));
  });
}
