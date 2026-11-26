import type { Project, RunRecord } from '../domain/types';

const DB_NAME = 'waterlogging-coupler';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_RUNS = 'runs';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_RUNS)) {
        const s = db.createObjectStore(STORE_RUNS, { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
        s.createIndex('schemeId', 'schemeId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const projectDb = {
  put: (p: Project) => tx(STORE_PROJECTS, 'readwrite', s => s.put(p) as IDBRequest<IDBValidKey>),
  get: (id: string) => tx<Project | undefined>(STORE_PROJECTS, 'readonly', s => s.get(id)),
  async all(): Promise<Project[]> {
    return tx<Project[]>(STORE_PROJECTS, 'readonly', s => s.getAll() as IDBRequest<Project[]>);
  },
  delete: (id: string) => tx(STORE_PROJECTS, 'readwrite', s => s.delete(id) as IDBRequest<undefined>)
};

export const runDb = {
  put: (r: RunRecord) => tx(STORE_RUNS, 'readwrite', s => s.put(r) as IDBRequest<IDBValidKey>),
  get: (id: string) => tx<RunRecord | undefined>(STORE_RUNS, 'readonly', s => s.get(id)),
  async all(): Promise<RunRecord[]> {
    return tx<RunRecord[]>(STORE_RUNS, 'readonly', s => s.getAll() as IDBRequest<RunRecord[]>);
  },
  async byProject(projectId: string): Promise<RunRecord[]> {
    const all = await this.all();
    return all.filter(r => r.projectId === projectId).sort((a, b) => b.startedAt - a.startedAt);
  },
  delete: (id: string) => tx(STORE_RUNS, 'readwrite', s => s.delete(id) as IDBRequest<undefined>)
};

export async function ensureSeedProject(factory: () => Project): Promise<Project> {
  const existing = await projectDb.all();
  if (existing.length) return existing.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const p = factory();
  await projectDb.put(p);
  return p;
}
