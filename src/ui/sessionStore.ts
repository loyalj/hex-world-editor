/**
 * IndexedDB-backed autosave slot: one record holding the latest unsaved
 * session as a full save-file JSON string. Everything here is best-effort —
 * a browser with IndexedDB blocked (private windows, storage pressure) makes
 * these resolve to null/no-op rather than throwing into the autosave path.
 */

export interface StoredSession {
  /** Document name at autosave time, for the restore prompt. */
  name: string;
  /** The full save-file JSON, identical to what Save writes. */
  json: string;
  /** Epoch millis of the autosave. */
  savedAt: number;
}

const DB_NAME = 'hex-world-editor';
const STORE   = 'session';
const KEY     = 'latest';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Run one transaction against the session store; the db is closed after. */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  try {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The stored session, or null when none exists or storage is unavailable. */
export async function loadSession(): Promise<StoredSession | null> {
  const raw = await withStore('readonly', s => s.get(KEY) as IDBRequest<unknown>);
  if (!raw || typeof raw !== 'object') return null;
  const session = raw as StoredSession;
  if (typeof session.json !== 'string' || typeof session.name !== 'string') return null;
  return session;
}

export async function storeSession(session: StoredSession): Promise<void> {
  await withStore('readwrite', s => s.put(session, KEY));
}

export async function clearSession(): Promise<void> {
  await withStore('readwrite', s => s.delete(KEY));
}
