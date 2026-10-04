/* ================================================================
 * On-device storage (IndexedDB). Nothing here leaves the phone.
 *
 *   sessions  one row per archive: name, dates, page order and the
 *             sorted documents (without images, which live in pages)
 *   pages     one row per captured page: scan, thumbnail, original
 *             frame, detected outline, text read from it, PDF page
 * ================================================================ */
interface StoredDoc extends Omit<ArchiveDoc, 'images' | 'thumbs' | 'originals' | 'pdfs'> { pageKeys: string[] }
interface SessionMeta {
  id: string; name: string; createdAt: number; updatedAt: number;
  pageKeys: string[];          // every captured page, in order
  docs: StoredDoc[];           // sorted documents (pages not yet in a document are still to be processed)
  cover: string[];             // up to 3 thumbnails for the archive list
  processed?: string[];        // pages already sorted into documents (or set aside as duplicates)
}
interface StoredPage {
  key: string; sessionId: string; image: string; thumb: string; original: string; originalRatio: number;
  quad: [number, number][]; sig: number[]; capturedAt: number; sharpness: number; blurry: boolean;
  ocr?: { lines: string[]; ok: boolean }; pdf?: PagePdf;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      try {
        const req = indexedDB.open('paper-archive', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'key' }).createIndex('session', 'sessionId');
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      } catch (e) { rej(e); }
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}
function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return openDb().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => res(r ? (r as IDBRequest).result : (undefined as any));
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

const store = {
  available: typeof indexedDB !== 'undefined',
  listSessions: () => idb<SessionMeta[]>('sessions', 'readonly', (s) => s.getAll()).then((l) => (l || []).sort((a, b) => b.updatedAt - a.updatedAt)),
  getSession: (id: string) => idb<SessionMeta | undefined>('sessions', 'readonly', (s) => s.get(id)),
  putSession: (m: SessionMeta) => idb<void>('sessions', 'readwrite', (s) => { s.put(m); }),
  putPage: (p: StoredPage) => idb<void>('pages', 'readwrite', (s) => { s.put(p); }),
  getPages: (sessionId: string) => idb<StoredPage[]>('pages', 'readonly', (s) => s.index('session').getAll(sessionId)),
  deletePages: (keys: string[]) => idb<void>('pages', 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); }),
  async updatePage(key: string, patch: Partial<StoredPage>) {
    const cur = await idb<StoredPage | undefined>('pages', 'readonly', (s) => s.get(key));
    if (cur) await store.putPage({ ...cur, ...patch });
  },
  async deleteSession(id: string) {
    const pages = await store.getPages(id).catch(() => [] as StoredPage[]);
    await store.deletePages(pages.map((p) => p.key));
    await idb<void>('sessions', 'readwrite', (s) => { s.delete(id); });
  },
  async deleteAll() {
    await idb<void>('pages', 'readwrite', (s) => { s.clear(); });
    await idb<void>('sessions', 'readwrite', (s) => { s.clear(); });
  },
};

/** Ask the browser not to clear our data when space runs low (granted silently on most phones). */
function askPersistentStorage() {
  try { (navigator as any).storage?.persist?.(); } catch { /* not supported */ }
}

const toStoredDoc = (d: ArchiveDoc): StoredDoc => {
  const { images, thumbs, originals, pdfs, looks, aspects, pageTexts, sources, ...rest } = d as any;
  return { ...rest, pageKeys: d.pageKeys || [] };
};
function hydrateDoc(d: StoredDoc, pages: Map<string, StoredPage>): ArchiveDoc {
  const ps = d.pageKeys.map((k) => pages.get(k)).filter(Boolean) as StoredPage[];
  if (!ps.length) return d as ArchiveDoc;
  return {
    ...d, images: ps.map((p) => p.image), thumbs: ps.map((p) => p.thumb),
    originals: ps.map((p) => ({ src: p.original, quad: p.quad, ratio: p.originalRatio })),
    looks: ps.map((p: any) => p.look), aspects: ps.map((p: any) => p.aspect), pageTexts: ps.map((p) => (p.ocr && p.ocr.lines) || []),
    sources: ps.map((p: any) => (p.source ? { from: p.source, size: p.size } : null)),
    pdfs: ps.map((p) => p.pdf || null),
  } as ArchiveDoc;
}
/** Put stored text results back into the reading queue so nothing is read twice. */
function primeReadCache(pages: StoredPage[]) {
  pages.forEach((p) => {
    if (p.ocr && p.ocr.ok) ocrJobs.set(p.key, Promise.resolve(p.ocr));
    if (p.pdf) pagePdf.set(p.key, p.pdf);
  });
}
const toRealPage = (p: StoredPage): RealPage => {
  const { sessionId, ocr, pdf, ...rest } = p as any;
  return rest as RealPage;
};
const defaultSessionName = (at = Date.now()) => {
  const d = new Date(at);
  return `${t('Archive')} · ${d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}, ${clock(at)}`;
};
const fmtBytes = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1024 ** 3 ? `${Math.round(b / 1024 / 1024)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`);

/** Load one saved archive's documents with their pages, without opening it. */
async function loadArchiveDocs(id: string): Promise<{ meta: SessionMeta | undefined; docs: ArchiveDoc[] }> {
  const meta = await store.getSession(id);
  if (!meta) return { meta, docs: [] };
  const pages = await store.getPages(id);
  primeReadCache(pages);
  const map = new Map(pages.map((p) => [p.key, p] as [string, StoredPage]));
  return { meta, docs: meta.docs.map((d) => hydrateDoc(d, map)) };
}

/* ---------- Archive list on the home screen ---------- */
function SessionList({ sessions, onContinue, onOpen, onAddMore, onFinish, onDelete, onRename, onNew, onExport, usage }: any) {
  const [confirmId, setConfirmId] = useState('');
  const notExported = sessions.reduce((n: number, s: SessionMeta) => n + s.docs.filter((d: any) => !d.exportedAt).length, 0);
  const [snoozed, setSnoozed] = useState(() => { try { return Number(localStorage.getItem('pa.backupSnooze') || 0) > Date.now(); } catch { return false; } });
  const snooze = () => { try { localStorage.setItem('pa.backupSnooze', String(Date.now() + 3 * 24 * 3600 * 1000)); } catch { /* ignore */ } setSnoozed(true); };
  const [editId, setEditId] = useState('');
  const [editName, setEditName] = useState('');
  if (!sessions.length) return null;
  return (
    <section className="sessions" aria-label={t("Your archives")}>
      <div className="sessions-head">
        <div>
          <h2 className="h-section">{t("Your archives")}</h2>
          <span className="fine"><Icon name="lock" size={13} /> {t("Saved on this device")}{usage ? ` · ${usage}` : ''}</span>
        </div>
        <div className="sessions-btns">
          {sessions.some((s: SessionMeta) => s.docs.length) && <button className="btn btn-quiet btn-sm" type="button" onClick={onExport}><Icon name="download" size={15} /> {t("Export")}</button>}
          <button className="btn btn-quiet btn-sm" type="button" onClick={onNew}><Icon name="plus" size={15} /> {t("New archive")}</button>
        </div>
      </div>
      {notExported > 0 && !snoozed && (
        <div className="backup-note" role="status">
          <Icon name="alert" size={16} />
          <span><strong>{notExported === 1 ? t("1 document isn’t exported yet.") : t("{0} documents aren’t exported yet.", { 0: notExported })}</strong> {t("They live only in this browser. Export to keep your own copy.")}</span>
          <div className="backup-actions">
            <button className="btn btn-primary btn-sm" type="button" onClick={onExport}>{t("Export")}</button>
            <button className="btn btn-quiet btn-sm" type="button" onClick={snooze}>{t("Later")}</button>
          </div>
        </div>
      )}
      <div className="session-list">
        {sessions.map((s: SessionMeta) => {
          const done = new Set((s as any).processed || s.docs.flatMap((d) => d.pageKeys));
          const pending = s.pageKeys.filter((k) => !done.has(k)).length;
          const review = s.docs.filter((d) => d.review).length;
          return (
            <article className="session" key={s.id}>
              <div className="session-cover" aria-hidden="true">
                {s.cover.length ? s.cover.slice(0, 3).map((c, i) => <img key={i} src={c} alt="" style={{ transform: `rotate(${[-6, 3, -1][i]}deg)` }} />) : <span className="cover-empty"><Icon name="doc" size={20} /></span>}
              </div>
              <div className="session-main">
                {editId === s.id ? (
                  <form className="rename" onSubmit={(e: any) => { e.preventDefault(); onRename(s.id, editName.trim() || s.name); setEditId(''); }}>
                    <input id={`rename-${s.id}`} value={editName} onChange={(e: any) => setEditName(e.target.value)} autoFocus dir="auto" aria-label={t("Archive name")} />
                    <button className="btn btn-quiet btn-sm" type="submit">{t("Save")}</button>
                  </form>
                ) : (
                  <button className="session-name" type="button" onClick={() => { setEditId(s.id); setEditName(s.name); }} title={t("Rename")}>
                    <span dir="auto">{s.name}</span><Icon name="pencil" size={13} />
                  </button>
                )}
                <span className="session-meta num">
                  {s.docs.length ? `${plural(s.docs.length, 'document')} · ` : ''}{plural(s.docs.reduce((n, d) => n + (d.pageKeys || []).length, 0) + pending, 'page')}
                  {review ? t(" · {0} to review", { 0: review }) : ''}
                </span>
                {pending > 0 && <span className="pill-warn session-pill">{t("{0} not sorted yet", { 0: plural(pending, 'page') })}</span>}
                <span className="session-date">{t("Last changed")} {new Date(s.updatedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}, {clock(s.updatedAt)}</span>
              </div>
              {confirmId === s.id ? (
                <div className="session-actions confirm-row">
                  <span>{t("Delete this archive and its {0}?", { 0: plural(s.pageKeys.length, 'page') })}</span>
                  <button className="btn btn-quiet btn-sm" type="button" onClick={() => setConfirmId('')}>{t("Cancel")}</button>
                  <button className="btn btn-danger btn-sm" type="button" onClick={() => { setConfirmId(''); onDelete(s.id); }}>{t("Delete")}</button>
                </div>
              ) : (
                <div className="session-actions">
                  {pending > 0 ? (
                    <>
                      <button className="btn btn-primary btn-sm" type="button" onClick={() => onContinue(s.id)}><Icon name="camera" size={15} /> {t("Continue capturing")}</button>
                      <button className="btn btn-quiet btn-sm" type="button" onClick={() => onFinish(s.id)}>{t("Finish and sort")}</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-primary btn-sm" type="button" onClick={() => onOpen(s.id)}>{t("Open")}</button>
                      <button className="btn btn-quiet btn-sm" type="button" onClick={() => onAddMore(s.id)}><Icon name="camera" size={15} /> {t("Add pages")}</button>
                    </>
                  )}
                  <button className="icon-btn" type="button" aria-label={t("Delete {0}", { 0: s.name })} onClick={() => setConfirmId(s.id)}><Icon name="trash" size={16} /></button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
