import type { RecordingChunkMeta, RecordingDatasetSummary } from "@/types";

export interface RecorderStorage {
  listDatasets(): Promise<RecordingDatasetSummary[]>;
  getDataset(id: string): Promise<RecordingDatasetSummary | null>;
  saveDataset(summary: RecordingDatasetSummary): Promise<void>;
  deleteDataset(id: string): Promise<void>;
  saveChunk(meta: RecordingChunkMeta, payload: Uint8Array): Promise<void>;
  listChunks(datasetId: string): Promise<RecordingChunkMeta[]>;
  getChunkMeta(id: string): Promise<RecordingChunkMeta | null>;
  getChunkData(id: string): Promise<Uint8Array | null>;
  deleteChunks(datasetId: string): Promise<void>;
}

const DB_NAME = "footprint-recorder";
const DB_VERSION = 1;
const DATASETS_STORE = "datasets";
const CHUNKS_STORE = "chunks";

const isBrowser = typeof window !== "undefined";

export function createRecorderStorage(): RecorderStorage {
  if (!isBrowser || typeof indexedDB === "undefined") {
    return new MemoryRecorderStorage();
  }
  return new IndexedDbRecorderStorage();
}

interface StoredChunkRecord extends RecordingChunkMeta {
  data: ArrayBuffer;
}

class IndexedDbRecorderStorage implements RecorderStorage {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = this.open();
  }

  async listDatasets(): Promise<RecordingDatasetSummary[]> {
    const db = await this.dbPromise;
    const transaction = db.transaction(DATASETS_STORE, "readonly");
    const store = transaction.objectStore(DATASETS_STORE);
    const request = store.getAll();
    const result = await requestToPromise<RecordingDatasetSummary[]>(request);
    return (result ?? [])
      .map(cloneDatasetSummary)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async getDataset(id: string): Promise<RecordingDatasetSummary | null> {
    const db = await this.dbPromise;
    const transaction = db.transaction(DATASETS_STORE, "readonly");
    const store = transaction.objectStore(DATASETS_STORE);
    const request = store.get(id);
    const result = await requestToPromise<RecordingDatasetSummary | undefined>(
      request,
    );
    return result ? cloneDatasetSummary(result) : null;
  }

  async saveDataset(summary: RecordingDatasetSummary): Promise<void> {
    const db = await this.dbPromise;
    const transaction = db.transaction(DATASETS_STORE, "readwrite");
    const store = transaction.objectStore(DATASETS_STORE);
    const request = store.put(cloneDatasetSummary(summary));
    await requestToPromise(request);
  }

  async deleteDataset(id: string): Promise<void> {
    const db = await this.dbPromise;
    const transaction = db.transaction(
      [DATASETS_STORE, CHUNKS_STORE],
      "readwrite",
    );
    const datasets = transaction.objectStore(DATASETS_STORE);
    const chunks = transaction.objectStore(CHUNKS_STORE);

    await requestToPromise(datasets.delete(id));

    const index = chunks.index("datasetId");
    const range = IDBKeyRange.only(id);
    const cursorRequest = index.openKeyCursor(range);

    await new Promise<void>((resolve, reject) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        chunks.delete(cursor.primaryKey);
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  }

  async saveChunk(
    meta: RecordingChunkMeta,
    payload: Uint8Array,
  ): Promise<void> {
    const db = await this.dbPromise;
    const transaction = db.transaction(CHUNKS_STORE, "readwrite");
    const store = transaction.objectStore(CHUNKS_STORE);
    const record: StoredChunkRecord = {
      ...meta,
      data: payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength,
      ),
    };
    const request = store.put(record);
    await requestToPromise(request);
  }

  async listChunks(datasetId: string): Promise<RecordingChunkMeta[]> {
    const db = await this.dbPromise;
    const transaction = db.transaction(CHUNKS_STORE, "readonly");
    const store = transaction.objectStore(CHUNKS_STORE);
    const index = store.index("datasetId");
    const request = index.getAll(IDBKeyRange.only(datasetId));
    const result = await requestToPromise<StoredChunkRecord[]>(request);
    return (result ?? [])
      .map((item) => cloneChunkMeta(item))
      .sort((a, b) => a.index - b.index);
  }

  async getChunkMeta(id: string): Promise<RecordingChunkMeta | null> {
    const db = await this.dbPromise;
    const transaction = db.transaction(CHUNKS_STORE, "readonly");
    const store = transaction.objectStore(CHUNKS_STORE);
    const request = store.get(id);
    const result = await requestToPromise<StoredChunkRecord | undefined>(
      request,
    );
    return result ? cloneChunkMeta(result) : null;
  }

  async getChunkData(id: string): Promise<Uint8Array | null> {
    const db = await this.dbPromise;
    const transaction = db.transaction(CHUNKS_STORE, "readonly");
    const store = transaction.objectStore(CHUNKS_STORE);
    const request = store.get(id);
    const result = await requestToPromise<StoredChunkRecord | undefined>(
      request,
    );
    if (!result) {
      return null;
    }
    return new Uint8Array(result.data);
  }

  async deleteChunks(datasetId: string): Promise<void> {
    const db = await this.dbPromise;
    const transaction = db.transaction(CHUNKS_STORE, "readwrite");
    const store = transaction.objectStore(CHUNKS_STORE);
    const index = store.index("datasetId");
    const cursorRequest = index.openKeyCursor(IDBKeyRange.only(datasetId));
    await new Promise<void>((resolve, reject) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to open IndexedDB"));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DATASETS_STORE)) {
          db.createObjectStore(DATASETS_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          const store = db.createObjectStore(CHUNKS_STORE, { keyPath: "id" });
          store.createIndex("datasetId", "datasetId", { unique: false });
          store.createIndex("datasetIndex", ["datasetId", "index"], {
            unique: true,
          });
        } else {
          const store = request.transaction?.objectStore(CHUNKS_STORE);
          if (store && !store.indexNames.contains("datasetId")) {
            store.createIndex("datasetId", "datasetId", { unique: false });
          }
          if (store && !store.indexNames.contains("datasetIndex")) {
            store.createIndex("datasetIndex", ["datasetId", "index"], {
              unique: true,
            });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }
}

class MemoryRecorderStorage implements RecorderStorage {
  private datasets = new Map<string, RecordingDatasetSummary>();

  private chunks = new Map<
    string,
    { meta: RecordingChunkMeta; data: Uint8Array }
  >();

  async listDatasets(): Promise<RecordingDatasetSummary[]> {
    return Array.from(this.datasets.values())
      .map(cloneDatasetSummary)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async getDataset(id: string): Promise<RecordingDatasetSummary | null> {
    const dataset = this.datasets.get(id);
    return dataset ? cloneDatasetSummary(dataset) : null;
  }

  async saveDataset(summary: RecordingDatasetSummary): Promise<void> {
    this.datasets.set(summary.id, cloneDatasetSummary(summary));
  }

  async deleteDataset(id: string): Promise<void> {
    this.datasets.delete(id);
    for (const [chunkId, record] of Array.from(this.chunks.entries())) {
      if (record.meta.datasetId === id) {
        this.chunks.delete(chunkId);
      }
    }
  }

  async saveChunk(
    meta: RecordingChunkMeta,
    payload: Uint8Array,
  ): Promise<void> {
    this.chunks.set(meta.id, {
      meta: cloneChunkMeta(meta),
      data: payload.slice(),
    });
  }

  async listChunks(datasetId: string): Promise<RecordingChunkMeta[]> {
    return Array.from(this.chunks.values())
      .filter((record) => record.meta.datasetId === datasetId)
      .map((record) => cloneChunkMeta(record.meta))
      .sort((a, b) => a.index - b.index);
  }

  async getChunkMeta(id: string): Promise<RecordingChunkMeta | null> {
    const record = this.chunks.get(id);
    return record ? cloneChunkMeta(record.meta) : null;
  }

  async getChunkData(id: string): Promise<Uint8Array | null> {
    const record = this.chunks.get(id);
    if (!record) {
      return null;
    }
    return record.data.slice();
  }

  async deleteChunks(datasetId: string): Promise<void> {
    for (const [chunkId, record] of Array.from(this.chunks.entries())) {
      if (record.meta.datasetId === datasetId) {
        this.chunks.delete(chunkId);
      }
    }
  }
}

function cloneDatasetSummary(
  summary: RecordingDatasetSummary,
): RecordingDatasetSummary {
  return {
    ...summary,
  };
}

function cloneChunkMeta(meta: RecordingChunkMeta): RecordingChunkMeta {
  return {
    ...meta,
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export { MemoryRecorderStorage };
