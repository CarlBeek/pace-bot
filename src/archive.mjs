// Local, origin-scoped database of complete game traces. No network or file downloads.
// Keep failed writes in memory so a quota/permission error does not silently discard data.
export class TraceArchive {
  constructor(indexedDB) {
    this.indexedDB = indexedDB;
    this.connection = null;
    this.pending = new Map();
    this.saved = 0;
    this.error = null;
  }

  open() {
    if (this.connection) return this.connection;
    this.connection = new Promise((resolve, reject) => {
      if (!this.indexedDB) { reject(new Error('Browser storage unavailable')); return; }
      const request = this.indexedDB.open('pace-bot-traces', 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('games')) request.result.createObjectStore('games', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error || new Error('Could not open trace backup'));
      request.onblocked = () => { blocked = true; reject(new Error('Trace backup is blocked by another tab')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.connection = null; };
        resolve(db);
      };
    }).catch(error => { this.connection = null; throw error; });
    return this.connection;
  }

  async transaction(mode, action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('games', mode);
      const request = action(tx.objectStore('games'));
      // Request success is not enough: the transaction can still abort afterwards.
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || request.error || new Error('Trace backup transaction aborted'));
      tx.onerror = () => { /* An unhandled request error aborts the transaction. */ };
    });
  }

  async save(record) {
    this.pending.set(record.id, record);
    try {
      await this.transaction('readwrite', store => store.put(record));
      if (this.pending.get(record.id) === record) this.pending.delete(record.id);
      this.saved++;
      if (!this.pending.size) this.error = null;
      return true;
    } catch (error) {
      this.error = String(error?.message || error);
      return false;
    }
  }

  count() { return this.transaction('readonly', store => store.count()); }

  async records() {
    let stored = [], warning = null;
    try { stored = await this.transaction('readonly', store => store.getAll()); }
    catch (error) {
      warning = `Could not read stored traces: ${String(error?.message || error)}. Only in-memory backups are included.`;
      if (!this.pending.size) throw new Error(warning);
    }
    const merged = new Map(stored.map(record => [record.id, record]));
    for (const [id, record] of this.pending) merged.set(id, record);
    return { records: [...merged.values()].sort((a, b) =>
      (a.data.exportedAt ?? '').localeCompare(b.data.exportedAt ?? '') ||
      (a.data.gameNumber ?? 0) - (b.data.gameNumber ?? 0) || a.id.localeCompare(b.id)), warning };
  }
}
