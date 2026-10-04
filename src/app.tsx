/* Paper Archive — interactive prototype
 * React (UMD global) + TypeScript, compiled with esbuild. Client-side state only.
 * No account, no backend, no network calls for documents.
 */
declare const React: any;
declare const ReactDOM: any;
const { useState, useEffect, useRef, useMemo } = React;

/* ================================================================
 * Types
 * ================================================================ */
type Category = string; // built-ins: Bills, Insurance, Bank, Government, Other — plus the person's own
type DocKind = 'bill' | 'letter' | 'statement' | 'form' | 'handwritten';

interface Reason { label: string; value: string; source: string }

interface ArchiveDoc {
  id: string;
  sender: string;          // short sender name
  letterhead: string;      // full name as printed
  address: string;
  title: string;
  typeWord: string;        // word that drove the document-type guess
  date: string;            // dd.mm.yyyy
  dateLabel?: string;
  category: Category;
  pages: number;
  amount?: string;
  amountLabel?: string;
  ref?: string;
  tint: string;
  kind: DocKind;
  tilt: number;
  rows?: [string, string][];
  body?: string[];
  review?: 'duplicate' | 'unclear';
  duplicateOf?: string;
  capturedAt?: string;
  // real captures
  real?: boolean;
  images?: string[];
  thumbs?: string[];
  originals?: { src: string; quad: [number, number][]; ratio: number }[];
  ocr?: string[];
  reasons?: Reason[];
  pdfs?: (any | null)[];   // per page: one PDF, or bands to stack
  blurry?: boolean;
  pageKeys?: string[];
  looks?: (Uint8Array | undefined)[];
  aspects?: (number | undefined)[];
  pageTexts?: string[][];
  sources?: ({ from: 'photo' | 'video'; size?: [number, number] } | null)[];
}

const CATEGORIES: Category[] = ['Bills', 'Insurance', 'Bank', 'Government', 'Other'];

/* ---------- The person's own categories ---------- */
interface CustomCat { name: string; keywords: string[] }
const CATEGORY_PRESETS: CustomCat[] = [
  { name: 'Store receipts', keywords: ['קבלה', 'חשבונית מס קבלה', 'חשבונית מס/קבלה', 'עודף', 'קופאי', 'מס׳ קופה', 'שופרסל', 'רמי לוי', 'יוחננוף', 'ויקטורי', 'אושר עד', 'טיב טעם', 'מחסני השוק', 'יינות ביתן', 'סופר-פארם', 'סופר פארם', 'קרפור', 'איקאה', 'ACE', 'KSP'] },
  { name: 'Medical', keywords: ['מכבי', 'כללית', 'מאוחדת', 'לאומית', 'מרשם', 'בית חולים', 'מרפאה', 'רופא', 'בדיקת דם'] },
  { name: 'Car', keywords: ['רישיון רכב', 'מוסך', 'טסט', 'ביטוח רכב', 'מספר רכב', 'חניה'] },
  { name: 'Warranties', keywords: ['תעודת אחריות', 'אחריות', 'מספר סידורי', 'Serial'] },
  { name: 'Kids & school', keywords: ['בית ספר', 'גן ילדים', 'חוג', 'משרד החינוך', 'תלמיד'] },
];
/** Light cleanup that keeps the text readable: no niqqud, straight quotes, single spaces. */
const lightNorm = (t: string) => t.replace(/[\u0591-\u05C7]/g, '').replace(/[״“”]/g, '"').replace(/[׳‘’]/g, "'").replace(/\s+/g, ' ');
/** Forgiving form for keyword matching: also ignores case and Hebrew final letters. */
const FINALS: Record<string, string> = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const norm = (t: string) => lightNorm(t).toLowerCase().replace(/[ךםןףץ]/g, (c) => FINALS[c]).trim();
let CUSTOM_RULES: CustomCat[] = [];
const CatsCtx = React.createContext({ all: CATEGORIES as string[], custom: [] as CustomCat[], openAdd: (_assignTo?: string) => {} });
const useCats = () => React.useContext(CatsCtx);

function applyCategoryRule(cat: CustomCat, list: ArchiveDoc[]): { docs: ArchiveDoc[]; moved: number } {
  const kws = cat.keywords.map(norm).filter(Boolean);
  let moved = 0;
  const docs = list.map((d) => {
    const text = norm([d.title, d.sender, ...extractedText(d)].join(' '));
    const hit = cat.keywords.find((k, i) => kws[i] && text.includes(kws[i]));
    if (!hit || d.category === cat.name) return d;
    moved++;
    return {
      ...d, category: cat.name, review: d.review === 'unclear' ? undefined : d.review,
      reasons: [...reasonsFor(d).filter((r) => r.label !== 'Looks like'), { label: 'Looks like', value: cat.name, source: `Text contains “${hit}” (your rule)` }],
    };
  });
  return { docs, moved };
}

/* ================================================================
 * Mock pile — the order a person might pick documents off the pile
 * ================================================================ */
const QUEUE: ArchiveDoc[] = [
  {
    id: 'd1', sender: 'חברת החשמל', letterhead: 'חברת החשמל לישראל בע״מ', address: 'ת.ד. 10, חיפה',
    title: 'חשבון חשמל', typeWord: 'חשבון', date: '18.11.2025', dateLabel: 'תאריך הפקה',
    category: 'Bills', pages: 2, amount: '₪437.20', ref: 'מס׳ חוזה 3487 2210', tint: '#C69A2B', kind: 'bill', tilt: -2.2,
    rows: [['תקופת החשבון', '15.09–14.11.2025'], ['צריכה', '612 קוט״ש'], ['קריאה נוכחית', '48,215'], ['מועד אחרון לתשלום', '08.12.2025']],
  },
  {
    id: 'd2', sender: 'כלל ביטוח', letterhead: 'כלל חברה לביטוח בע״מ', address: 'מנחם בגין 36, תל אביב',
    title: 'הודעה על פוליסה', typeWord: 'פוליסה', date: '03.09.2025', category: 'Insurance', pages: 3,
    ref: 'פוליסה 7731-0042-19', tint: '#3C6E9E', kind: 'letter', tilt: 1.6,
    body: ['שלום רב,', 'הפוליסה שבנדון תחודש בתאריך 01.10.2025 בהתאם לתנאים המצורפים.', 'מצורפים דף פרטי הביטוח ותנאי הפוליסה המעודכנים.'],
  },
  {
    id: 'd3', sender: 'בנק הפועלים', letterhead: 'בנק הפועלים בע״מ', address: 'סניף 532, רמת אביב',
    title: 'דף חשבון עו״ש', typeWord: 'דף חשבון', date: '31.10.2025', category: 'Bank', pages: 2,
    ref: 'חשבון 48-219-77', tint: '#C2453A', kind: 'statement', tilt: -1.2,
    rows: [['יתרת פתיחה', '₪11,902.10'], ['משכורת', '+₪14,250.00'], ['כרטיס אשראי', '−₪6,880.42'], ['הוראת קבע', '−₪1,240.00'], ['יתרת סגירה', '₪12,408.33']],
  },
  {
    id: 'd4', sender: 'מי אביבים', letterhead: 'מי אביבים 2010 בע״מ', address: 'אבן גבירול 69, תל אביב',
    title: 'חשבון מים', typeWord: 'חשבון', date: '21.10.2025', category: 'Bills', pages: 1,
    amount: '₪186.40', tint: '#3E8FA8', kind: 'bill', tilt: 2.4, ref: 'מס׳ נכס 104-55821',
    rows: [['תקופה', 'אוגוסט–ספטמבר 2025'], ['צריכה', '14 מ״ק'], ['מספר נפשות', '3']],
  },
  {
    id: 'd5', sender: 'בנק הפועלים', letterhead: 'בנק הפועלים בע״מ', address: 'סניף 532, רמת אביב',
    title: 'דף חשבון עו״ש', typeWord: 'דף חשבון', date: '31.10.2025', category: 'Bank', pages: 2,
    ref: 'חשבון 48-219-77', tint: '#C2453A', kind: 'statement', tilt: 1.8,
    rows: [['יתרת פתיחה', '₪11,902.10'], ['משכורת', '+₪14,250.00'], ['כרטיס אשראי', '−₪6,880.42'], ['הוראת קבע', '−₪1,240.00'], ['יתרת סגירה', '₪12,408.33']],
    review: 'duplicate', duplicateOf: 'd3',
  },
  {
    id: 'd6', sender: 'עיריית תל אביב-יפו', letterhead: 'עיריית תל אביב-יפו', address: 'אגף החיובים, אבן גבירול 69',
    title: 'הודעת תשלום ארנונה', typeWord: 'הודעת תשלום', date: '12.12.2025', category: 'Government', pages: 1,
    amount: '₪1,284.00', ref: 'חשבון ארנונה 2004417', tint: '#5B6B3A', kind: 'form', tilt: -1.8,
    rows: [['שטח הנכס', '78 מ״ר'], ['תקופה', 'נוב׳–דצמ׳ 2025'], ['סיווג', 'מגורים']],
  },
  {
    id: 'd7', sender: 'Unknown', letterhead: '', address: '',
    title: 'מסמך לא מזוהה', typeWord: '', date: '14.02.2025', category: 'Other', pages: 1,
    tint: '#999', kind: 'handwritten', tilt: 3.2, review: 'unclear',
    body: ['14.02.25', 'להתקשר בעניין ההחזר', 'סכום? 350', 'לשמור עם הקבלות'],
  },
  {
    id: 'd8', sender: 'מכבי שירותי בריאות', letterhead: 'מכבי שירותי בריאות', address: 'מרכז רפואי רמת אביב',
    title: 'מכתב: סיכום ביקור', typeWord: 'מכתב', date: '05.11.2025', category: 'Other', pages: 1,
    tint: '#4B7BB5', kind: 'letter', tilt: -2.6,
    body: ['לכבוד המטופל/ת,', 'מצורף סיכום הביקור מיום 05.11.2025.', 'יש לתאם ביקור מעקב בעוד כשלושה חודשים.'],
  },
  {
    id: 'd9', sender: 'בזק', letterhead: 'בזק החברה הישראלית לתקשורת', address: 'ת.ד. 1000, ירושלים',
    title: 'חשבונית מס', typeWord: 'חשבונית', date: '01.11.2025', category: 'Bills', pages: 1,
    amount: '₪129.90', tint: '#2F7FC1', kind: 'bill', tilt: 1.1, ref: 'מס׳ לקוח 66120873',
    rows: [['אינטרנט סיבים', '₪99.90'], ['קו טלפון', '₪30.00']],
  },
  {
    id: 'd10', sender: 'הראל ביטוח', letterhead: 'הראל חברה לביטוח בע״מ', address: 'אבא הלל 3, רמת גן',
    title: 'חידוש ביטוח רכב', typeWord: 'ביטוח', date: '15.08.2025', category: 'Insurance', pages: 2,
    amount: '₪3,412.00', amountLabel: 'פרמיה שנתית', tint: '#2E5E8C', kind: 'letter', tilt: -0.8, ref: 'פוליסה 0390-221187',
    body: ['שלום רב,', 'ביטוח הרכב שלך עומד להתחדש ב־01.09.2025.', 'פרמיה שנתית: ₪3,412.00'],
  },
  {
    id: 'd11', sender: 'ישראכרט', letterhead: 'ישראכרט בע״מ', address: 'ת.ד. 62, גבעתיים',
    title: 'פירוט חיובים', typeWord: 'פירוט חיובים', date: '02.11.2025', category: 'Bank', pages: 3,
    amount: '₪2,316.45', amountLabel: 'סה״כ חיוב', tint: '#5E5A8F', kind: 'statement', tilt: 2.0, ref: 'כרטיס 4580',
    rows: [['שופרסל', '₪642.18'], ['פז', '₪310.00'], ['נטפליקס', '₪54.90'], ['סופר-פארם', '₪187.37'], ['סה״כ חיוב', '₪2,316.45']],
  },
  {
    id: 'd12', sender: 'ביטוח לאומי', letterhead: 'המוסד לביטוח לאומי', address: 'שד׳ ויצמן 13, ירושלים',
    title: 'אישור על תשלום דמי ביטוח', typeWord: 'אישור', date: '10.01.2025', category: 'Government', pages: 2,
    tint: '#4E6F52', kind: 'form', tilt: -1.4, ref: 'מס׳ תיק 0287741',
    rows: [['שנת מס', '2024'], ['סוג מבוטח', 'שכיר'], ['סטטוס', 'שולם במלואו']],
  },
  {
    id: 'd13', sender: 'בנק לאומי', letterhead: 'בנק לאומי לישראל בע״מ', address: 'יהודה הלוי 34, תל אביב',
    title: 'הודעה על שינוי תנאים', typeWord: 'הודעה', date: '22.09.2025', category: 'Bank', pages: 1,
    tint: '#2C6FB0', kind: 'letter', tilt: 1.4,
    body: ['לקוח/ה נכבד/ה,', 'החל מ־01.11.2025 יעודכנו עמלות ניהול החשבון.', 'פירוט מלא מצורף להודעה זו.'],
  },
  {
    id: 'd14', sender: 'סופרגז', letterhead: 'סופרגז חברה לאספקת גז בע״מ', address: 'ת.ד. 80, חולון',
    title: 'חשבון גז', typeWord: 'חשבון', date: '30.10.2025', category: 'Bills', pages: 1,
    amount: '₪98.50', tint: '#D07A2E', kind: 'bill', tilt: -2.0,
    rows: [['צריכה', '9.2 מ״ק'], ['דמי שימוש במערכת', '₪12.00']],
  },
  {
    id: 'd15', sender: 'רשות המסים', letterhead: 'רשות המסים בישראל', address: 'כנפי נשרים 5, ירושלים',
    title: 'הודעה על החזר מס', typeWord: 'הודעה', date: '28.07.2025', category: 'Government', pages: 1,
    amount: '₪1,920.00', amountLabel: 'סכום ההחזר', tint: '#46617F', kind: 'letter', tilt: 0.9,
    body: ['הנדון: החזר מס לשנת 2024', 'סכום ההחזר: ₪1,920.00', 'הסכום יועבר לחשבון הבנק הרשום.'],
  },
  {
    id: 'd16', sender: 'משרד התחבורה', letterhead: 'משרד התחבורה והבטיחות בדרכים', address: 'אגף הרישוי',
    title: 'רישיון רכב', typeWord: 'רישיון', date: '04.06.2025', category: 'Government', pages: 1,
    tint: '#6E7A42', kind: 'form', tilt: -1.0, ref: 'מס׳ רכב 52-118-73',
    rows: [['תוקף עד', '03.06.2026'], ['דגם', 'טויוטה קורולה'], ['שנת ייצור', '2019']],
  },
];

/* ================================================================
 * Helpers
 * ================================================================ */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseDate = (d: string) => { if (!d) return 0; const [dd, mm, yy] = d.split('.').map(Number); return new Date(yy, mm - 1, dd).getTime() || 0; };
const clock = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const isUnknown = (d: ArchiveDoc) => d.kind === 'handwritten' || d.sender === 'Unknown';

function extractedText(doc: ArchiveDoc): string[] {
  if (doc.ocr) return doc.ocr;
  if (isUnknown(doc)) return [...(doc.body || [])];
  const out = [doc.letterhead, doc.title, `${doc.dateLabel || 'תאריך'}: ${doc.date}`];
  if (doc.ref) out.push(doc.ref);
  (doc.rows || []).forEach(([k, v]) => out.push(`${k}: ${v}`));
  (doc.body || []).forEach((l) => out.push(l));
  if (doc.amount && doc.kind !== 'letter') out.push(`${doc.amountLabel || 'סכום לתשלום'}: ${doc.amount}`);
  return out;
}

const CATEGORY_REASON: Record<Category, string> = {
  Bills: 'Utility layout: billing period, usage and an amount',
  Insurance: 'Insurer name and a policy number',
  Bank: 'Bank or card issuer name and an account number',
  Government: 'Government or municipal sender',
  Other: 'No stronger match, so filed under Other',
};

function reasonsFor(doc: ArchiveDoc): Reason[] {
  if (doc.reasons) return doc.reasons;
  if (isUnknown(doc)) {
    return [
      { label: 'Sender', value: 'Unknown', source: 'No letterhead or logo found' },
      { label: 'Date', value: doc.date, source: 'Handwritten “14.02.25”, low certainty' },
      { label: 'Document type', value: 'Unclear', source: 'No heading matched a known type' },
    ];
  }
  const r: Reason[] = [
    { label: 'Detected sender', value: doc.sender, source: `Letterhead reads “${doc.letterhead}”` },
    { label: 'Detected document type', value: doc.typeWord, source: `Heading contains “${doc.typeWord}”` },
    { label: 'Detected date', value: doc.date, source: `Printed next to “${doc.dateLabel || 'תאריך'}”` },
  ];
  if (doc.amount) r.push({ label: 'Detected amount', value: doc.amount, source: `Printed next to “${doc.amountLabel || 'סכום לתשלום'}”` });
  r.push({ label: 'Looks like', value: doc.category, source: CATEGORY_REASON[doc.category] || 'Filed by you' });
  return r;
}

/* ================================================================
 * Capture pipeline
 *
 *   Camera → frame capture → document detection → page capture
 *          → OCR → document grouping → classification → archive
 *
 * Every stage is a small function with a clear input and output. The
 * prototype ships simulated versions. Real, on-device versions can
 * replace them one at a time without touching the UI:
 *   frames      getUserMedia + requestVideoFrameCallback
 *   detection   OpenCV.js contour + quad fit (Web Worker)
 *   stability   IoU of the quad across ~12 frames
 *   capture     perspective warp of the full-res frame
 *   ocr         Tesseract.js with Hebrew + English models
 *   grouping    page markers ("עמוד 2 מתוך 3") + letterhead similarity
 *   classify    sender dictionary + keyword rules
 *   duplicates  perceptual hash + text similarity
 * ================================================================ */
interface Quad { cx: number; cy: number; w: number; h: number; angle: number }
interface PageImage { key: string; docId: string; pageIndex: number; capturedAt: number }

const pipeline = {
  /** frame + scene → document outline, or null when the table is clear */
  detectDocument(scene: { doc: ArchiveDoc | null; onTable: boolean }): Quad | null {
    if (!scene.doc || !scene.onTable) return null;
    return { cx: 0.5, cy: 0.5, w: 0.34, h: 0.48, angle: scene.doc.tilt };
  },
  /** recent outlines → is the page lying still? */
  isStable(history: Quad[], minFrames = 12): boolean {
    if (history.length < minFrames) return false;
    const a = history[history.length - 1], b = history[history.length - minFrames];
    return Math.abs(a.cx - b.cx) < 0.01 && Math.abs(a.cy - b.cy) < 0.01 && Math.abs(a.angle - b.angle) < 0.5;
  },
  /** frame + outline → flattened page image */
  capturePage(doc: ArchiveDoc, pageIndex: number): PageImage {
    return { key: `${doc.id}:${pageIndex}`, docId: doc.id, pageIndex, capturedAt: Date.now() };
  },
  /** page image → text lines (simulated: reads the mock document) */
  async ocr(page: PageImage): Promise<string[]> {
    const doc = QUEUE.find((d) => d.id === page.docId)!;
    return page.pageIndex === 0 ? extractedText(doc) : [];
  },
  /** captured pages → documents (pages that belong together) */
  groupPages(pages: PageImage[]): PageImage[][] {
    const map = new Map<string, PageImage[]>();
    pages.forEach((p) => { if (!map.has(p.docId)) map.set(p.docId, []); map.get(p.docId)!.push(p); });
    return [...map.values()];
  },
  /** grouped pages → archive entry with detected metadata */
  classify(group: PageImage[]): ArchiveDoc {
    const base = QUEUE.find((d) => d.id === group[0].docId)!;
    return { ...base, pages: group.length, capturedAt: clock(group[0].capturedAt) };
  },
  /** archive entries → pairs that look like the same document */
  findDuplicates(docs: ArchiveDoc[]): [ArchiveDoc, ArchiveDoc][] {
    const pairs: [ArchiveDoc, ArchiveDoc][] = [];
    docs.forEach((a, i) => docs.slice(i + 1).forEach((b) => {
      if (!isUnknown(a) && a.sender === b.sender && a.date === b.date && a.title === b.title) pairs.push([a, b]);
    }));
    return pairs;
  },
};

/* ================================================================
 * Simulated desk session — drives detection → stability → capture
 * ================================================================ */
type Phase = 'clear' | 'placing' | 'detected' | 'steady' | 'captured' | 'turning' | 'removing' | 'done';
const PHASE_MS: Record<Phase, number> = {
  clear: 850, placing: 950, detected: 700, steady: 1300, captured: 650, turning: 800, removing: 800, done: 0,
};

function useDeskSession(opts: {
  queue: ArchiveDoc[]; running: boolean; speed: number; loop?: boolean;
  onPage?: (doc: ArchiveDoc, page: number) => void; onDocDone?: (doc: ArchiveDoc) => void;
}) {
  const { queue, running, speed, loop } = opts;
  const [idx, setIdx] = useState(0);
  const [page, setPage] = useState(0);
  const [phase, setPhase] = useState('clear' as Phase);
  const cbs = useRef(opts);
  cbs.current = opts;

  useEffect(() => {
    if (!running || phase === 'done') return;
    const doc = queue[idx];
    const t = setTimeout(() => {
      switch (phase) {
        case 'clear': setPhase('placing'); break;
        case 'placing': setPhase('detected'); break;
        case 'detected': setPhase('steady'); break;
        case 'steady': setPhase('captured'); cbs.current.onPage?.(doc, page); break;
        case 'captured':
          if (page < doc.pages - 1) setPhase('turning');
          else { setPhase('removing'); cbs.current.onDocDone?.(doc); }
          break;
        case 'turning': setPage(page + 1); setPhase('detected'); break;
        case 'removing': {
          const next = idx + 1;
          if (next >= queue.length) {
            if (!loop) { setPhase('done'); return; }
            setIdx(0);
          } else setIdx(next);
          setPage(0); setPhase('clear');
          break;
        }
      }
    }, PHASE_MS[phase] / speed);
    return () => clearTimeout(t);
  }, [phase, running, idx, page, speed]);

  return { phase, doc: queue[idx] as ArchiveDoc, idx, page };
}

const STATUS: Record<Phase, string> = {
  clear: 'Waiting for the next document',
  placing: 'Something new on the table',
  detected: 'Document detected',
  steady: 'Hold still…',
  captured: 'Captured',
  turning: 'New page detected',
  removing: 'Saved. Place the next one',
  done: 'Pile finished',
};

/* ================================================================
 * Small UI pieces
 * ================================================================ */
const ICONS: Record<string, string> = {
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  device: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 5l12 7-12 7z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 8v5M12 16.5v.5M10.3 3.9L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  table: 'M3 5h18v14H3zM3 10h18M9 10v9',
  archive: 'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
  restart: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
  plus: 'M12 5v14M5 12h14',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>
  );
}

function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <rect x="7.5" y="3.5" width="14" height="18" rx="1.5" fill="var(--surface)" stroke="currentColor" strokeWidth="1.5" transform="rotate(6 14.5 12.5)" />
      <rect x="4.5" y="5.5" width="14" height="18" rx="1.5" fill="var(--surface)" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 11h7M8 14h7M8 17h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function LocalPill({ onClick, label = 'On this device', dark = false }: { onClick?: () => void; label?: string; dark?: boolean }) {
  return (
    <button className={`local-pill ${dark ? 'is-dark' : ''}`} onClick={onClick} type="button">
      <Icon name="lock" size={14} /> {label}
    </button>
  );
}

function Bars({ n, seed = 1 }: { n: number; seed?: number }) {
  return (
    <div className="bars">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="bar" style={{ width: `${62 + ((i * 37 + seed * 13) % 36)}%` }} />
      ))}
    </div>
  );
}

/** A rendered paper document. Sized entirely in em: set font-size on a parent to scale it. */
function DocPaper({ doc, page = 0 }: { doc: ArchiveDoc; page?: number }) {
  const seed = Number(doc.id.slice(1)) || 3;
  if (doc.images) {
    return <div className="paper photo"><img src={doc.images[Math.min(page, doc.images.length - 1)]} alt={`Page ${page + 1}`} /></div>;
  }
  return (
    <div className={`paper kind-${doc.kind}`} dir="rtl" lang="he">
      {doc.kind === 'handwritten' ? (
        <div className="hw">
          {(doc.body || []).map((l, i) => (
            <div key={i} style={{ transform: `rotate(${i % 2 ? -1.2 : 0.9}deg)`, marginInlineStart: `${(i * 7) % 18}%` }}>{l}</div>
          ))}
        </div>
      ) : page === 0 ? (
        <>
          <div className="p-head">
            <span className="p-logo" style={{ background: doc.tint }} />
            <div><div className="p-sender">{doc.letterhead}</div><div className="p-addr">{doc.address}</div></div>
          </div>
          <div className="p-title">{doc.title}</div>
          <div className="p-meta"><span>{doc.dateLabel || 'תאריך'}: {doc.date}</span>{doc.ref && <span>{doc.ref}</span>}</div>
          {doc.body && <div className="p-body">{doc.body.map((l, i) => <p key={i}>{l}</p>)}</div>}
          {doc.rows && (
            <div className={`p-rows ${doc.kind === 'form' ? 'is-form' : ''}`}>
              {doc.rows.map(([k, v], i) => <div className="p-row" key={i}><span>{k}</span><span>{v}</span></div>)}
            </div>
          )}
          {doc.amount && doc.kind !== 'letter' && (
            <div className="p-amount" style={{ borderColor: doc.tint }}>
              <span>{doc.amountLabel || 'סכום לתשלום'}</span><span>{doc.amount}</span>
            </div>
          )}
          <Bars n={doc.kind === 'letter' ? 7 : 4} seed={seed} />
        </>
      ) : (
        <>
          <div className="p-cont"><span className="p-logo sm" style={{ background: doc.tint }} />{doc.letterhead} · המשך</div>
          <Bars n={16} seed={seed + page} />
        </>
      )}
      <div className="p-foot">עמוד {page + 1} מתוך {doc.pages}</div>
    </div>
  );
}

/* ================================================================
 * Desk scene (simulated camera view)
 * ================================================================ */
function DeskScene(props: {
  phase: Phase; doc: ArchiveDoc | null; page: number; pileCount: number; doneCount: number;
  speed?: number; stream?: any; compact?: boolean; guide?: boolean; paused?: boolean;
}) {
  const { phase, doc, page, pileCount, doneCount, speed = 1, stream, compact, guide, paused } = props;
  const videoRef = useRef(null);
  useEffect(() => { if (videoRef.current && stream) videoRef.current.srcObject = stream; }, [stream]);

  const showDetect = ['detected', 'steady', 'captured', 'turning'].includes(phase);
  const moving = phase === 'placing' || phase === 'removing';
  const style: any = {
    '--tilt': `${doc ? doc.tilt : 0}deg`,
    '--t': `${moving ? PHASE_MS[phase] / speed : 280}ms`,
    '--steady': `${PHASE_MS.steady / speed}ms`,
  };

  return (
    <div className={`desk ${compact ? 'is-compact' : ''} ${paused ? 'is-paused' : ''}`} style={style}>
      {stream ? (
        <video ref={videoRef} className="desk-video" autoPlay muted playsInline />
      ) : (
        <>
          <div className="desk-mug" aria-hidden="true" />
          <div className="desk-pen" aria-hidden="true" />
          <div className="pile" aria-hidden="true">
            {Array.from({ length: Math.min(pileCount, 5) }).map((_, i) => (
              <div key={i} className="pile-sheet" style={{ transform: `rotate(${[-9, 4, -3, 7, -6][i]}deg) translate(${i * 2}px, ${-i * 2}px)` }} />
            ))}
          </div>
          <div className="done-stack" aria-hidden="true">
            {Array.from({ length: Math.min(doneCount, 5) }).map((_, i) => (
              <div key={i} className="pile-sheet flat" style={{ transform: `rotate(${[8, -4, 11, 2, -7][i]}deg) translate(${-i * 2}px, ${-i * 2}px)` }} />
            ))}
          </div>
        </>
      )}

      {doc && phase !== 'done' && (
        <div className={`scene-doc phase-${phase} ${stream ? 'is-ghost' : ''}`}>
          <div className="scene-paper"><DocPaper doc={doc} page={page} /></div>
          {showDetect && (
            <div className={`detect detect-${phase}`}>
              <i className="c tl" /><i className="c tr" /><i className="c bl" /><i className="c br" />
            </div>
          )}
          {phase === 'captured' && <div className="flash" />}
        </div>
      )}

      {guide && (
        <div className="frame-guide">
          <span className="guide-label"><Icon name="check" size={14} /> Table in view</span>
        </div>
      )}

      {!guide && (
        <div className={`status status-${phase}`} role="status" aria-live="polite">
          {phase === 'steady' && (
            <svg className="ring" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="8" className="ring-bg" />
              <circle cx="10" cy="10" r="8" className="ring-fg" />
            </svg>
          )}
          {phase === 'captured' && <Icon name="check" size={14} />}
          <span>{STATUS[phase]}{phase === 'captured' && doc && doc.pages > 1 ? ` · page ${page + 1} of ${doc.pages}` : ''}</span>
        </div>
      )}
      <div className="vignette" aria-hidden="true" />
    </div>
  );
}

/* ================================================================
 * Screens
 * ================================================================ */
function AppHeader({ onHome, openPrivacy, right }: { onHome: () => void; openPrivacy: () => void; right?: any }) {
  return (
    <header className="app-header">
      <button className="brand" onClick={onHome} type="button"><BrandMark /><span>Paper Archive</span></button>
      <div className="header-right">{right}<LocalPill onClick={openPrivacy} /></div>
    </header>
  );
}

function HomeScreen({ onStart, onHow, onSample, openPrivacy, sessionList, hasSessions }: any) {
  const demoQueue = useMemo(() => [QUEUE[0], QUEUE[3], QUEUE[5], QUEUE[8]], []);
  const s = useDeskSession({ queue: demoQueue, running: true, speed: 1.15, loop: true });
  const done = s.phase === 'removing' ? s.idx + 1 : s.idx;
  return (
    <div className="page">
      <AppHeader onHome={() => {}} openPrivacy={openPrivacy} />
      {sessionList}
      <main className={`home ${hasSessions ? 'is-returning' : ''}`}>
        <section className="home-copy">
          <h1>Turn a pile of paper into a searchable archive.</h1>
          <p className="lede">Prop your phone above the table and go through your papers one by one. Each page is captured on its own the moment it lies still. No photos to take, nothing to crop or rename.</p>
          <div className="privacy-callout">
            <span className="privacy-icon"><Icon name="device" size={20} /></span>
            <div>
              <strong>Processed locally on your device.</strong>
              <span>Your documents stay on this device. No account, no upload.</span>
            </div>
          </div>
          <div className="cta-row">
            <button className="btn btn-primary btn-lg" onClick={onStart} type="button">{hasSessions ? 'Start a new archive' : 'Start archiving'}</button>
            <button className="btn btn-quiet btn-lg" onClick={onHow} type="button">See how it works</button>
          </div>
        </section>
        <figure className="home-demo">
          <div className="demo-frame">
            <DeskScene phase={s.phase} doc={s.doc} page={s.page} pileCount={4 - (done % 4)} doneCount={done % 4 + 1} speed={1.15} compact />
          </div>
          <figcaption>Nobody presses a button here. A page goes down, the outline locks on, and it is captured.</figcaption>
        </figure>
      </main>
      <footer className="foot">Prototype with sample documents · <button className="foot-link" onClick={onSample} type="button">Open a sample archive</button></footer>
    </div>
  );
}

function HowScreen({ onBack, onStart, onSample, openPrivacy }: any) {
  const steps = [
    ['The camera watches the table', 'Your phone rests above the table, looking down. No handling, no aiming.'],
    ['A new paper appears', 'When you lay something down, its outline is found in the camera picture.'],
    ['It is captured when still', 'Once the page stops moving for a moment, it is captured and flattened.'],
    ['The text is read', 'Hebrew and English text is read from each page, on this device.'],
    ['Pages are grouped', 'Page 2 of a bill is attached to page 1, so each document stays whole.'],
    ['Everything is sorted', 'Sender, date and amount are detected. Look-alikes are flagged for you.'],
  ];
  return (
    <div className="page">
      <AppHeader onHome={onBack} openPrivacy={openPrivacy} />
      <main className="narrow">
        <button className="link-back" onClick={onBack} type="button"><Icon name="back" size={16} /> Back</button>
        <h1 className="h-page">How it works</h1>
        <div className="compare">
          <div className="compare-col is-old">
            <h2>Usual scanner apps</h2>
            <p className="flow">Tap → photograph → crop → rename → file it</p>
            <p className="muted">…then repeat for every page in the pile.</p>
          </div>
          <div className="compare-col is-new">
            <h2>Paper Archive</h2>
            <p className="flow">Pick up a paper, open it, put it down. Next.</p>
            <p className="muted">The app captures, separates and sorts while you keep going.</p>
          </div>
        </div>
        <h2 className="h-section">What happens on your device</h2>
        <ol className="steps">
          {steps.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span></li>)}
        </ol>
        <div className="cta-row">
          <button className="btn btn-primary btn-lg" onClick={onStart} type="button">Start archiving</button>
          <button className="btn btn-quiet btn-lg" onClick={onSample} type="button">Open a sample archive</button>
        </div>
      </main>
    </div>
  );
}

function SetupScreen({ onBack, onStartCamera, openPrivacy }: any) {
  const [source, setSource] = useState('sim');
  return (
    <div className="page">
      <AppHeader onHome={onBack} openPrivacy={openPrivacy} />
      <main className="setup">
        <section className="setup-copy">
          <button className="link-back" onClick={onBack} type="button"><Icon name="back" size={16} /> Back</button>
          <h1 className="h-page">Place your phone above the table</h1>
          <ol className="setup-steps">
            <li>Put your phone somewhere with a clear view of the table.</li>
            <li>Open and place each document on the table.</li>
            <li>Keep moving — the app captures documents automatically.</li>
          </ol>
          <fieldset className="source">
            <legend>Camera</legend>
            <label className={source === 'sim' ? 'on' : ''}>
              <input type="radio" name="src" id="src-sim" checked={source === 'sim'} onChange={() => setSource('sim')} />
              <span><strong>Simulated desk</strong><small>Sample pile, for trying the flow</small></span>
            </label>
            <label className={source === 'cam' ? 'on' : ''}>
              <input type="radio" name="src" id="src-cam" checked={source === 'cam'} onChange={() => setSource('cam')} />
              <span><strong>This device’s camera</strong><small>Falls back to the simulated desk if unavailable</small></span>
            </label>
          </fieldset>
          <button className="btn btn-primary btn-lg" onClick={() => onStartCamera(source)} type="button"><Icon name="camera" /> Start camera</button>
          <p className="fine"><Icon name="lock" size={13} /> Camera frames are analyzed in this browser and never leave the device.</p>
        </section>
        <figure className="setup-preview">
          <div className="demo-frame">
            <DeskScene phase="clear" doc={null} page={0} pileCount={5} doneCount={0} guide />
          </div>
          <figcaption>Keep the whole table in view. Leave room for the pile on one side.</figcaption>
        </figure>
      </main>
    </div>
  );
}

function CameraScreen({ stream, onFinish, onRestart, onExit, openPrivacy }: any) {
  const [running, setRunning] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pages, setPages] = useState([] as PageImage[]);
  const [doneDocs, setDoneDocs] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const stripRef = useRef(null);

  const s = useDeskSession({
    queue: QUEUE, running, speed, loop: false,
    onPage: (doc: ArchiveDoc, p: number) => setPages((ps: PageImage[]) => [...ps, pipeline.capturePage(doc, p)]),
    onDocDone: () => setDoneDocs((n: number) => n + 1),
  });

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((e: number) => e + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => { if (stripRef.current) stripRef.current.scrollLeft = stripRef.current.scrollWidth; }, [pages.length]);

  const docCount = new Set(pages.map((p) => p.docId)).size;
  const stepIdx: Record<Phase, number> = { clear: -1, placing: -1, detected: 0, steady: 1, captured: 2, turning: 0, removing: 3, done: 3 };
  const steps = ['Detected', 'Holding still', 'Captured', 'Saved'];
  const active = stepIdx[s.phase as Phase];
  const pileLeft = QUEUE.length - s.idx - (s.phase === 'clear' ? 0 : 1);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0'), ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className="cam">
      <header className="cam-top">
        <div className="cam-left">
          <button className="btn btn-cam btn-sm" onClick={() => { setRunning(false); setConfirm(true); }} type="button"><Icon name="restart" size={15} /> Start over</button>
        </div>
        <div className="cam-title"><span className={`rec ${running ? '' : 'off'}`} /> {running ? 'Archiving' : 'Paused'} <span className="cam-time">{mm}:{ss}</span></div>
        <LocalPill onClick={openPrivacy} label="Local processing" dark />
      </header>

      <div className="cam-stage">
        <div className="cam-frame">
          <DeskScene phase={s.phase} doc={s.doc} page={s.page} pileCount={Math.max(0, pileLeft)} doneCount={doneDocs}
            speed={speed} stream={stream} paused={!running} />
          {stream && <div className="sim-note">Live camera. Detection is simulated in this prototype.</div>}
          {!running && !confirm && (
            <div className="paused">
              <strong>Paused</strong>
              <span>Captured pages are kept on this device.</span>
              <button className="btn btn-light" onClick={() => setRunning(true)} type="button"><Icon name="play" size={16} /> Resume</button>
            </div>
          )}
          {confirm && (
            <div className="paused">
              <strong>Start over?</strong>
              <span>{pages.length ? `The ${plural(pages.length, 'page')} captured so far will be discarded.` : 'The session restarts from the first document.'}</span>
              <div className="cta-row center">
                <button className="btn btn-cam" onClick={() => { setConfirm(false); setRunning(true); }} type="button">Keep going</button>
                <button className="btn btn-light" onClick={onRestart} type="button"><Icon name="restart" size={16} /> Start over</button>
              </div>
              <button className="link-cam" onClick={onExit} type="button">Leave and go back to the start screen</button>
            </div>
          )}
          {s.phase === 'done' && running && (
            <div className="paused">
              <strong>That was the whole pile</strong>
              <span>{plural(docCount, 'document')} · {plural(pages.length, 'page')}</span>
              <button className="btn btn-light" onClick={() => onFinish(pages)} type="button">Finish archive</button>
            </div>
          )}
        </div>
      </div>

      <footer className="cam-bottom">
        <div className="cam-stats">
          <div className="counts">
            <span className="big">{plural(docCount, 'document')}</span><span className="dot">·</span><span className="big">{plural(pages.length, 'page')}</span>
          </div>
          <ol className="capture-steps" aria-label="Current page">
            {steps.map((st, i) => <li key={st} className={i < active ? 'past' : i === active ? 'now' : ''}>{st}</li>)}
          </ol>
        </div>

        <div className="strip" ref={stripRef} aria-label="Captured pages">
          {pages.length === 0 && <span className="strip-empty">No buttons to press. Lay a document down and let go.</span>}
          {pages.map((p, i) => {
            const d = QUEUE.find((q) => q.id === p.docId)!;
            return (
              <div key={p.key} className={`strip-item ${i === pages.length - 1 ? 'is-new' : ''}`}>
                <div className="strip-thumb"><DocPaper doc={d} page={p.pageIndex} /></div>
                {d.pages > 1 && <span className="strip-badge">{p.pageIndex + 1}/{d.pages}</span>}
              </div>
            );
          })}
        </div>

        <div className="cam-actions">
          <button className="btn btn-cam" onClick={() => setRunning(!running)} type="button">
            <Icon name={running ? 'pause' : 'play'} size={16} /> {running ? 'Pause' : 'Resume'}
          </button>
          <div className="speed" role="group" aria-label="Demo speed">
            <span>Demo speed</span>
            {[1, 3].map((v) => <button key={v} type="button" className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>{v}×</button>)}
          </div>
          <button className="btn btn-light" onClick={() => onFinish(pages)} type="button">Finish archive</button>
        </div>
      </footer>
    </div>
  );
}

function ProcessingScreen({ pages, usedSample, onView, openPrivacy }: any) {
  const [step, setStep] = useState(0);
  const [ocrCount, setOcrCount] = useState(0);
  const [result, setResult] = useState(null as null | { docs: ArchiveDoc[]; dupes: number });

  const groups = useMemo(() => pipeline.groupPages(pages), [pages]);

  useEffect(() => {
    let live = true;
    (async () => {
      await wait(700); if (!live) return; setStep(1);
      await wait(650); if (!live) return; setStep(2);
      for (let i = 0; i < pages.length; i++) {
        await pipeline.ocr(pages[i]);
        if (!live) return;
        setOcrCount(i + 1);
        await wait(Math.max(30, 1100 / pages.length));
      }
      setStep(3);
      const docs = groups.map((g: PageImage[]) => pipeline.classify(g));
      await wait(700); if (!live) return; setStep(4);
      const dupes = pipeline.findDuplicates(docs).length;
      await wait(650); if (!live) return; setStep(5);
      await wait(550); if (!live) return; setStep(6);
      setResult({ docs, dupes });
    })();
    return () => { live = false; };
  }, []);

  const docsSoFar = result ? result.docs : groups.map((g: PageImage[]) => pipeline.classify(g));
  const cats = new Set(docsSoFar.map((d: ArchiveDoc) => d.category)).size;
  const review = docsSoFar.filter((d: ArchiveDoc) => d.review).length;
  const stages = [
    ['Documents detected', plural(groups.length, 'document')],
    ['Pages separated', plural(pages.length, 'page')],
    ['Text extracted', `${ocrCount} of ${pages.length} pages`],
    ['Documents classified', plural(cats, 'category', 'categories')],
    ['Duplicates checked', result ? plural(result.dupes, 'possible duplicate') : '…'],
    ['Archive created', 'Saved on this device'],
  ];

  return (
    <div className="page">
      <AppHeader onHome={() => {}} openPrivacy={openPrivacy} />
      <main className="narrow processing">
        {!result ? (
          <>
            <h1 className="h-page">Building your archive</h1>
            <p className="muted">Running on this device. You can put your phone down.</p>
          </>
        ) : (
          <>
            <h1 className="h-page">Your archive is ready</h1>
            {usedSample && <p className="muted">No pages were captured, so the sample pile was used.</p>}
          </>
        )}
        <ol className="stages">
          {stages.map(([label, detail], i) => (
            <li key={label} className={i < step ? 'done' : i === step ? 'now' : ''}>
              <span className="stage-mark">{i < step ? <Icon name="check" size={14} /> : i === step ? <span className="spin" /> : null}</span>
              <span className="stage-label">{label}</span>
              <span className="stage-detail">{i <= step ? detail : ''}</span>
            </li>
          ))}
        </ol>
        {result && (
          <>
            <dl className="summary">
              <div><dt>Documents</dt><dd>{result.docs.length}</dd></div>
              <div><dt>Pages</dt><dd>{pages.length}</dd></div>
              <div><dt>Categories</dt><dd>{cats}</dd></div>
              <div><dt>Possible duplicates</dt><dd>{result.dupes}</dd></div>
              <div className={review ? 'warn' : ''}><dt>Need review</dt><dd>{review}</dd></div>
            </dl>
            <div className="cta-row">
              <button className="btn btn-primary btn-lg" onClick={() => onView(result.docs)} type="button">View archive</button>
            </div>
            <p className="fine"><Icon name="lock" size={13} /> 0 bytes uploaded. Every step above ran in this browser.</p>
          </>
        )}
      </main>
    </div>
  );
}

/* ---------------- Archive ---------------- */
function CategoryChip({ c }: { c: Category }) {
  return <span className={`chip cat-${c.toLowerCase()}`}>{c}</span>;
}

function ReviewPill({ doc }: { doc: ArchiveDoc }) {
  if (!doc.review) return null;
  return <span className="pill-warn"><Icon name="alert" size={12} /> {doc.review === 'duplicate' ? 'Possible duplicate' : 'Needs review'}</span>;
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function DocumentsTab({ docs, onOpen, filter, setFilter }: any) {
  const { all, openAdd } = useCats();
  const [q, setQ] = useState('');
  const counts: Record<string, number> = { All: docs.length, 'Needs review': docs.filter((d: ArchiveDoc) => d.review).length };
  all.forEach((c: string) => (counts[c] = docs.filter((d: ArchiveDoc) => d.category === c).length));

  const query = q.trim();
  const rows = docs
    .filter((d: ArchiveDoc) => filter === 'All' || (filter === 'Needs review' ? !!d.review : d.category === filter))
    .map((d: ArchiveDoc) => {
      if (!query) return { d, hit: '' };
      const lq = query.toLowerCase();
      const head = [d.title, d.sender, d.date, d.category, d.amount || ''].join(' ').toLowerCase();
      if (head.includes(lq)) return { d, hit: '' };
      const line = extractedText(d).find((l) => l.toLowerCase().includes(lq));
      return line ? { d, hit: line } : null;
    })
    .filter(Boolean)
    .sort((a: any, b: any) => parseDate(b.d.date) - parseDate(a.d.date));

  return (
    <>
      <div className="search">
        <Icon name="search" />
        <input id="search" type="search" placeholder="Search documents..." value={q} onChange={(e: any) => setQ(e.target.value)} dir="auto" />
        {q && <button className="icon-btn" onClick={() => setQ('')} type="button" aria-label="Clear search"><Icon name="close" size={16} /></button>}
      </div>
      <div className="try">Try <button type="button" onClick={() => setQ('ארנונה')}>ארנונה</button><button type="button" onClick={() => setQ('437')}>437</button><button type="button" onClick={() => setQ('.10.2025')}>10.2025</button><span>· searches the text inside every page</span></div>
      <div className="filters" role="tablist" aria-label="Filter">
        {['All', 'Needs review', ...all].map((f: string) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`filter ${filter === f ? 'on' : ''} ${f === 'Needs review' && counts[f] ? 'has-warn' : ''}`} onClick={() => setFilter(f)}>
            {f} <span className="n">{counts[f]}</span>
          </button>
        ))}
        <button type="button" className="filter add" onClick={() => openAdd()}><Icon name="plus" size={14} /> Add category</button>
      </div>
      <div className="list">
        {rows.length === 0 && <div className="empty">No documents match “{query || filter}”.</div>}
        {rows.map(({ d, hit }: any) => (
          <button key={d.id} className="row" onClick={() => onOpen(d.id)} type="button">
            <div className="thumb"><DocPaper doc={d} /></div>
            <div className="row-main">
              <div className="row-title"><span dir="auto">{highlight(d.title, query)}</span></div>
              <div className="row-sub"><span dir="auto">{highlight(d.sender, query)}</span><span className="sep">·</span><span className="num">{d.date || 'No date found'}</span></div>
              {hit && <div className="row-hit" dir="rtl">…{highlight(hit, query)}</div>}
              <div className="row-tags"><CategoryChip c={d.category} /><ReviewPill doc={d} /></div>
            </div>
            <div className="row-meta">
              <span className="num amount">{d.amount || ''}</span>
              <span className="pages">{plural(d.pages, 'page')}</span>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function ReviewTab({ docs, resolveDuplicate, resolveUnclear, onOpen, deleteDoc }: any) {
  const { all, openAdd } = useCats();
  const [choosing, setChoosing] = useState(false);
  const pending = docs.filter((d: ArchiveDoc) => d.review);
  const total = docs.length;
  return (
    <div className="review">
      <h2 className="h-section">{pending.length ? `${plural(pending.length, 'document')} ${pending.length === 1 ? 'needs' : 'need'} your attention` : 'Nothing left to review'}</h2>
      <p className="muted">{pending.length
        ? `${total - pending.length === 1 ? 'The other document was' : `The other ${total - pending.length} were`} sorted without you. ${pending.length === 1 ? 'This one was' : 'These were'} ambiguous, so the choice is yours.`
        : `All ${total} documents are filed. You can still change any category from a document’s page.`}</p>
      {pending.map((d: ArchiveDoc) => {
        if (d.review === 'duplicate') {
          const orig = docs.find((o: ArchiveDoc) => o.id === d.duplicateOf);
          return (
            <article className="rcard" key={d.id}>
              <header><span className="pill-warn"><Icon name="alert" size={12} /> Possible duplicate</span></header>
              <p className="rcard-lede">Two documents look very similar.</p>
              <div className="pair">
                {[orig, d].filter(Boolean).map((x: ArchiveDoc, i: number) => (
                  <button key={x.id} className="pair-item" onClick={() => onOpen(x.id)} type="button">
                    <div className="thumb lg"><DocPaper doc={x} /></div>
                    <span dir="auto">{x.sender} · {x.title}</span>
                    <small>{i === 0 ? 'First copy' : 'Second copy'} · captured {x.capturedAt}</small>
                  </button>
                ))}
              </div>
              <ul className="evidence">
                {d.real ? (<><li>The pages look the same, even though they were framed differently</li><li>The text read from both mostly matches</li>{d.date && <li>Same date ({d.date})</li>}</>) : (<><li>Same sender and date ({d.date})</li><li>Same account number</li><li>Text on both pages matches closely</li></>)}
              </ul>
              <div className="rcard-actions">
                <button className="btn btn-quiet" onClick={() => resolveDuplicate(d.id, false)} type="button">Keep both</button>
                <button className="btn btn-primary" onClick={() => resolveDuplicate(d.id, true)} type="button">Mark as duplicate</button>
              </div>
            </article>
          );
        }
        return (
          <article className="rcard" key={d.id}>
            <header><span className="pill-warn"><Icon name="alert" size={12} /> Document type unclear</span></header>
            <div className="unclear">
              <button className="thumb lg" onClick={() => onOpen(d.id)} type="button" aria-label="Open document"><DocPaper doc={d} /></button>
              <div>
                <p className="rcard-lede">{d.real ? (d.ocr && d.ocr.length ? 'No known sender found on this page.' : 'No text could be read from this page.') : 'Handwritten page with no letterhead.'}</p>
                <dl className="detected">
                  <div><dt>Detected</dt><dd>Sender: {d.sender === 'Unknown' || !d.real ? 'Unknown' : d.sender}</dd></div>
                  <div><dt>Detected</dt><dd>Date: {d.date || 'not found'}</dd></div>
                </dl>
              </div>
            </div>
            {choosing && (
              <div className="choose">
                <span>File it under</span>
                {all.map((c: string) => <button key={c} type="button" className="filter" onClick={() => { setChoosing(false); resolveUnclear(d.id, c); }}>{c}</button>)}
                <button type="button" className="filter add" onClick={() => { setChoosing(false); openAdd(d.id); }}><Icon name="plus" size={14} /> New category</button>
              </div>
            )}
            <div className="rcard-actions">
              {d.real && <button className="btn btn-quiet danger" onClick={() => deleteDoc(d.id)} type="button"><Icon name="trash" size={15} /> Not a document</button>}
              <button className="btn btn-quiet" onClick={() => resolveUnclear(d.id, null)} type="button">Leave unclassified</button>
              <button className="btn btn-primary" onClick={() => setChoosing(!choosing)} type="button">Choose category</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ---------- Export: files are built on this device ---------- */
const isoDate = (d: string) => { const m = d.match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : 'no-date'; };
const safeName = (t: string) => t.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
const fileBase = (d: ArchiveDoc) => safeName(`${isoDate(d.date)} ${d.sender === 'Unknown' ? '' : d.sender + ' - '}${d.title}`) || d.id;
function dataUrlBytes(u: string): Uint8Array {
  const b = atob(u.slice(u.indexOf(',') + 1)); const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function loadGlobal(name: string, src: string): Promise<any> {
  const w = window as any;
  if (!w[name]) await loadScript(src);
  return w[name];
}
const getPdfLib = () => loadGlobal('PDFLib', 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
const getJSZip = () => loadGlobal('JSZip', 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');

function buildCsv(docs: ArchiveDoc[]): string {
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = docs.map((d) => [d.title, d.sender, d.date, d.category, d.amount || '', d.pages, d.review ? 'yes' : 'no', d.capturedAt || '', `${fileBase(d)}.pdf`].map(esc).join(','));
  return ['title,sender,date,category,amount,pages,needs_review,captured,file', ...rows].join('\r\n');
}
/** One document as a PDF. Uses the reader's searchable pages when available, else the photos. */
async function documentPdf(d: ArchiveDoc, searchable: boolean): Promise<Uint8Array | null> {
  if (!d.images?.length) return null;
  const { PDFDocument } = await getPdfLib();
  const out = await PDFDocument.create();
  out.setTitle(`${d.sender} · ${d.title}`);
  for (let i = 0; i < d.images.length; i++) {
    const tp = searchable ? d.pdfs?.[i] : null;
    if (tp && tp instanceof Uint8Array && tp.length) {
      const src = await PDFDocument.load(tp);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((pg: any) => out.addPage(pg));
    } else if (Array.isArray(tp) && tp.length && tp.every((b: any) => b.bytes && b.bytes.length && b.textOnly)) {
      // Full-quality colour scan underneath, invisible searchable text from the reader on top
      const layers = [];
      for (const b of tp) layers.push((await out.embedPdf(b.bytes, [0]))[0]);
      const img = await out.embedJpg(dataUrlBytes(d.images[i]));
      const w = 595, h = (595 * img.height) / img.width;
      const pg = out.addPage([w, h]);
      pg.drawImage(img, { x: 0, y: 0, width: w, height: h });
      const textH = layers.reduce((n: number, e: any) => n + e.height, 0), sc = h / textH;
      let top = h;
      for (const e of layers) { const lh = e.height * sc; top -= lh; pg.drawPage(e, { x: 0, y: top, width: w, height: lh }); }
    } else if (Array.isArray(tp) && tp.length && tp.every((b: any) => b.bytes && b.bytes.length)) {
      // Bands read in parallel: stack them back into one page, keeping their hidden text
      const embedded = [];
      for (const b of tp) embedded.push((await out.embedPdf(b.bytes, [0]))[0]);
      const w = embedded[0].width, h = embedded.reduce((n: number, e: any) => n + e.height, 0);
      const pg = out.addPage([w, h]);
      let top = h;
      for (const e of embedded) { top -= e.height; pg.drawPage(e, { x: 0, y: top, width: e.width, height: e.height }); }
    } else {
      const img = await out.embedJpg(dataUrlBytes(d.images[i]));
      const w = 595, h = (595 * img.height) / img.width;
      out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
  }
  return out.save();
}

function ExportTab({ docs, toast }: any) {
  const pages = docs.reduce((n: number, d: ArchiveDoc) => n + d.pages, 0);
  const scanned = docs.filter((d: ArchiveDoc) => d.images?.length);
  const [state, setState] = useState({} as Record<string, { status: string; progress: number; blob?: Blob; name?: string; error?: string }>);
  const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const ua = navigator.userAgent;
  const where = /iPhone|iPad|iPod/.test(ua) ? 'Files app › Downloads' : /Android/.test(ua) ? 'Downloads folder (Files app)' : 'Downloads folder';
  const csv = useMemo(() => buildCsv(docs), [docs]);
  const set = (id: string, v: any) => setState((s: any) => ({ ...s, [id]: { ...(s[id] || {}), ...v } }));

  const options = [
    { id: 'docs', icon: 'doc', title: 'Download documents', desc: `${plural(scanned.length, 'PDF')} in one ZIP, named by date and sender`, needsScans: true },
    { id: 'pdf', icon: 'layers', title: 'Download searchable PDF', desc: `One file, ${plural(scanned.reduce((n: number, d: ArchiveDoc) => n + d.pages, 0), 'page')}, text you can search and copy`, needsScans: true },
    { id: 'csv', icon: 'table', title: 'Download metadata CSV', desc: 'Opens in Excel or Google Sheets, Hebrew included', needsScans: false },
    { id: 'zip', icon: 'archive', title: 'Download complete archive ZIP', desc: 'Folders by category: PDFs, original photos, extracted text and the CSV', needsScans: false },
  ];

  async function build(id: string, progress: (p: number) => void): Promise<{ blob: Blob; name: string }> {
    const stamp = new Date().toISOString().slice(0, 10);
    if (id === 'csv') return { blob: new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), name: `paper-archive-${stamp}.csv` };
    if (id === 'pdf') {
      const { PDFDocument } = await getPdfLib();
      const out = await PDFDocument.create(); out.setTitle('Paper Archive');
      for (let i = 0; i < scanned.length; i++) {
        const bytes = await documentPdf(scanned[i], true);
        if (bytes) { const src = await PDFDocument.load(bytes); (await out.copyPages(src, src.getPageIndices())).forEach((pg: any) => out.addPage(pg)); }
        progress((i + 1) / scanned.length);
      }
      return { blob: new Blob([await out.save()], { type: 'application/pdf' }), name: `paper-archive-${stamp}.pdf` };
    }
    const JSZip = await getJSZip();
    const zip = new JSZip();
    const used = new Set<string>();
    const unique = (n: string) => { let x = n, k = 2; while (used.has(x)) x = `${n} (${k++})`; used.add(x); return x; };
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i]; const base = unique(fileBase(d));
      const folder = id === 'zip' ? safeName(d.category) + '/' : '';
      const pdf = await documentPdf(d, true);
      if (pdf) zip.file(`${folder}${base}.pdf`, pdf);
      if (id === 'zip') {
        const text = extractedText(d).join('\n');
        if (text) zip.file(`${folder}${base}.txt`, '﻿' + text);
        (d.originals || []).forEach((o, p) => zip.file(`originals/${base} p${p + 1}.jpg`, dataUrlBytes(o.src)));
      }
      progress((i + 1) / (docs.length + 1));
    }
    if (id === 'zip') zip.file('archive.csv', '﻿' + csv);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, (m: any) => progress(0.9 + m.percent / 1000));
    return { blob, name: `paper-archive-${id === 'zip' ? 'complete' : 'documents'}-${stamp}.zip` };
  }

  async function prepare(id: string) {
    set(id, { status: 'working', progress: 0.02, error: '' });
    try {
      const r = await build(id, (p) => set(id, { progress: Math.max(0.02, Math.min(1, p)) }));
      set(id, { status: 'ready', progress: 1, ...r });
    } catch (e: any) {
      set(id, { status: 'error', error: navigator.onLine ? 'Couldn’t build this file. Try again.' : 'The file builder needs a connection the first time. Connect and try again.' });
    }
  }
  function save(id: string) {
    const st = state[id]; if (!st?.blob) return;
    const url = URL.createObjectURL(st.blob);
    const a = document.createElement('a'); a.href = url; a.download = st.name!; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(inFrame ? 'Claude’s preview blocks saving. Use the hosted site to save files.' : `Saved to your ${where}`);
  }
  async function share(id: string) {
    const st = state[id]; if (!st?.blob) return;
    const file = new File([st.blob], st.name!, { type: st.blob.type });
    try { await (navigator as any).share({ files: [file], title: st.name }); }
    catch (e: any) { if (e?.name !== 'AbortError') toast('Sharing isn’t available here. Use Save instead.'); }
  }
  const canShareFiles = (b?: Blob, n?: string) => {
    try { return !!b && !!(navigator as any).canShare?.({ files: [new File([b], n || 'f', { type: b.type })] }); } catch { return false; }
  };
  const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

  return (
    <div className="export">
      <h2 className="h-section">Export archive</h2>
      <div className="local-banner"><Icon name="device" size={18} /> Everything is generated on your device. Your documents are never uploaded.</div>
      <div className="exports">
        {options.map((o) => {
          const st = state[o.id] || { status: 'idle', progress: 0 };
          const disabled = o.needsScans && scanned.length === 0;
          return (
            <div className="export-row" key={o.id}>
              <span className="export-icon"><Icon name={o.icon} size={20} /></span>
              <div className="export-main">
                <strong>{o.title}</strong>
                <span>{disabled ? 'Needs scanned pages. The sample documents have none.' : o.desc}</span>
                {st.status === 'working' && <div className="progress"><i style={{ width: `${Math.round(st.progress * 100)}%` }} /></div>}
                {st.status === 'ready' && <span className="ready"><Icon name="check" size={14} /> Ready · {st.name} · {fmtSize(st.blob!.size)}</span>}
                {st.status === 'error' && <span className="form-error">{st.error}</span>}
              </div>
              {st.status === 'ready' ? (
                <div className="export-actions">
                  <button className="btn btn-primary" onClick={() => save(o.id)} type="button"><Icon name="download" size={16} /> Save</button>
                  {canShareFiles(st.blob, st.name) && <button className="btn btn-quiet" onClick={() => share(o.id)} type="button">Share…</button>}
                </div>
              ) : (
                <button className="btn btn-quiet" disabled={disabled || st.status === 'working'} onClick={() => prepare(o.id)} type="button">
                  {st.status === 'working' ? `${Math.round(st.progress * 100)}%` : 'Prepare'}
                </button>
              )}
              {o.id === 'csv' && st.status === 'ready' && (
                <div className="csv"><textarea id="csv-out" readOnly value={csv} rows={5} dir="ltr" /></div>
              )}
            </div>
          );
        })}
      </div>
      <p className="fine">Save puts the file in your {where}. Share… lets you send it to Google Drive, WhatsApp, email or Files instead.</p>
    </div>
  );
}

/* ---------- Rearranging pages ---------- */
const PAGE_FIELDS = ['images', 'thumbs', 'originals', 'pdfs', 'pageKeys', 'looks', 'aspects', 'pageTexts', 'sources'];
/** A copy of the document holding only the given pages, in the given order. */
function withPages(d: ArchiveDoc, idx: number[], extra?: { from: ArchiveDoc; idx: number[] }): ArchiveDoc {
  const out: any = { ...d };
  PAGE_FIELDS.forEach((f) => {
    const mine = (d as any)[f], theirs = extra ? (extra.from as any)[f] : null;
    if (!Array.isArray(mine) && !Array.isArray(theirs)) return;
    out[f] = [...idx.map((i) => (mine || [])[i]), ...(extra ? extra.idx.map((i) => (theirs || [])[i]) : [])];
  });
  out.pages = idx.length + (extra ? extra.idx.length : 0);
  if (out.pageTexts) out.ocr = (out.pageTexts as string[][]).flat();
  return out as ArchiveDoc;
}
/** Turn one page into a document of its own and sort it from its own text. */
function pageAsDocument(d: ArchiveDoc, i: number): ArchiveDoc {
  const o = d.originals?.[i];
  const page: any = {
    key: d.pageKeys?.[i] || `p${Date.now()}`, image: d.images![i], thumb: d.thumbs?.[i] || d.images![i],
    original: o?.src || d.images![i], originalRatio: o?.ratio || 1, quad: o?.quad || [], sig: [], capturedAt: Date.now(),
    sharpness: 0, blurry: false, look: d.looks?.[i], aspect: d.aspects?.[i],
    source: d.sources?.[i]?.from, size: d.sources?.[i]?.size,
  };
  const doc = classifyPages({ pages: [page], texts: [d.pageTexts?.[i] || []] }, `r${Date.now().toString(36)}s`, true);
  if (d.pdfs?.[i]) doc.pdfs = [d.pdfs[i]];
  return { ...doc, capturedAt: d.capturedAt };
}

/** Put freshly scanned pages into a document: replace one page (retake) or add at the end. */
const PAGE_FIELD_OF: Record<string, string> = { images: 'image', thumbs: 'thumb', originals: 'original', pdfs: 'pdf', pageKeys: 'pageKey', looks: 'look', aspects: 'aspect', pageTexts: 'pageText', sources: 'source' };
function placePages(d: ArchiveDoc, mode: 'retake' | 'add', index: number, entries: any[]): ArchiveDoc {
  const out: any = { ...d };
  Object.entries(PAGE_FIELD_OF).forEach(([f, k]) => {
    const arr = Array.isArray((d as any)[f]) ? [...(d as any)[f]] : [];
    while (arr.length < d.pages) arr.push(f === 'pageTexts' ? [] : null);
    if (mode === 'retake') arr[index] = entries[0][k]; else entries.forEach((e) => arr.push(e[k]));
    out[f] = arr;
  });
  out.pages = mode === 'retake' ? d.pages : d.pages + entries.length;
  out.ocr = (out.pageTexts as string[][]).flat().filter(Boolean);
  if (mode === 'retake' && out.blurry) out.blurry = false;
  return out as ArchiveDoc;
}
/** Re-read who sent it, date, amount and type from all of a document's text, keeping the document itself. */
function resortDocument(d: ArchiveDoc): ArchiveDoc {
  const pages: any[] = (d.images || []).map((img, i) => ({
    key: d.pageKeys?.[i] || `p${i}`, image: img, thumb: d.thumbs?.[i] || img, original: d.originals?.[i]?.src || img,
    originalRatio: d.originals?.[i]?.ratio || 1, quad: d.originals?.[i]?.quad || [], sig: [], capturedAt: Date.now(),
    sharpness: 0, blurry: false, look: d.looks?.[i], aspect: d.aspects?.[i], source: d.sources?.[i]?.from, size: d.sources?.[i]?.size,
  }));
  const fresh = classifyPages({ pages, texts: d.pageTexts || pages.map(() => []) }, d.id, true);
  return { ...d, sender: fresh.sender, letterhead: fresh.letterhead, title: fresh.title, typeWord: fresh.typeWord, date: fresh.date,
    category: fresh.category, amount: fresh.amount, amountLabel: fresh.amountLabel, reasons: fresh.reasons, review: d.review === 'duplicate' ? d.review : fresh.review };
}

function MovePageSheet({ docs, from, onPick, onClose }: any) {
  const others = docs.filter((d: ArchiveDoc) => d.id !== from.id && d.images?.length);
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Move page" onClick={(e: any) => e.stopPropagation()}>
        <div className="sheet-head"><h2>Move this page to…</h2>
          <button className="icon-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" /></button></div>
        <div className="move-list">
          <button type="button" className="move-item new" onClick={() => onPick('new')}>
            <span className="move-new"><Icon name="plus" size={18} /></span>
            <span><strong>A new document</strong><small>Sorted on its own from this page’s text</small></span>
          </button>
          {others.map((d: ArchiveDoc) => (
            <button type="button" className="move-item" key={d.id} onClick={() => onPick(d.id)}>
              <span className="thumb"><DocPaper doc={d} /></span>
              <span><strong dir="auto">{d.title}</strong><small dir="auto">{d.sender === 'Unknown' ? '' : d.sender + ' · '}{d.date || 'No date'} · {plural(d.pages, 'page')}</small></span>
            </button>
          ))}
        </div>
        <p className="fine">The page is added at the end. You can then move it earlier.</p>
      </div>
    </div>
  );
}

function DocumentDetail({ doc, onBack, onChangeCategory, goReview, onDelete, docs = [], onPages }: any) {
  const [confirmDel, setConfirmDel] = useState(false);
  const { all, openAdd } = useCats();
  const [page, setPage] = useState(0);
  const [original, setOriginal] = useState(false);
  const lines = extractedText(doc);
  const [moving, setMoving] = useState(false);
  const [confirmPageDel, setConfirmPageDel] = useState(false);
  useEffect(() => { setPage(0); }, [doc.id]);
  useEffect(() => { if (page > doc.pages - 1) setPage(Math.max(0, doc.pages - 1)); setConfirmPageDel(false); }, [doc.pages, page]);
  const editable = !!(doc.images?.length && onPages);
  const move = (to: number) => { const idx = [...Array(doc.pages).keys()]; const [x] = idx.splice(page, 1); idx.splice(to, 0, x); onPages.reorder(doc.id, idx); setPage(to); };
  return (
    <div className="detail" role="dialog" aria-label={doc.title}>
      <div className="detail-bar">
        <button className="link-back" onClick={onBack} type="button"><Icon name="back" size={16} /> My Archive</button>
      </div>
      <div className="detail-grid">
        <section className="detail-preview">
          <div className="big-paper"><DocPaper doc={doc} page={page} /></div>
          {editable ? (
            <div className="page-strip" role="group" aria-label="Pages">
              {Array.from({ length: doc.pages }).map((_, i) => (
                <button key={(doc.pageKeys || [])[i] || i} type="button" className={`page-thumb ${i === page ? 'on' : ''}`} onClick={() => setPage(i)} aria-label={`Page ${i + 1}`}>
                  <img src={doc.thumbs?.[i] || doc.images[i]} alt="" /><span>{i + 1}</span>
                </button>
              ))}
              <button type="button" className="page-add" onClick={() => onPages.addPages(doc.id)} aria-label="Scan more pages into this document">
                <Icon name="plus" size={18} /><small>Add page</small>
              </button>
            </div>
          ) : doc.pages > 1 && (
            <div className="pager" role="group" aria-label="Pages">
              {Array.from({ length: doc.pages }).map((_, i) => (
                <button key={i} type="button" className={i === page ? 'on' : ''} onClick={() => setPage(i)}>{i + 1}</button>
              ))}
            </div>
          )}
          {editable && (
            confirmPageDel ? (
              <div className="page-actions confirm-row"><span>Delete page {page + 1}{doc.pages === 1 ? ' and this document' : ''}?</span>
                <button className="btn btn-quiet btn-sm" type="button" onClick={() => setConfirmPageDel(false)}>Cancel</button>
                <button className="btn btn-danger btn-sm" type="button" onClick={() => { setConfirmPageDel(false); onPages.remove(doc.id, page); }}>Delete</button>
              </div>
            ) : (
              <div className="page-actions" role="group" aria-label={`Page ${page + 1} of ${doc.pages}`}>
                <span className="page-label num">Page {page + 1} of {doc.pages}</span>
                <button className="btn btn-quiet btn-sm" type="button" disabled={page === 0} onClick={() => move(page - 1)} aria-label="Move page earlier"><Icon name="back" size={15} /> Earlier</button>
                <button className="btn btn-quiet btn-sm" type="button" disabled={page >= doc.pages - 1} onClick={() => move(page + 1)} aria-label="Move page later">Later <span className="flip"><Icon name="back" size={15} /></span></button>
                <button className="btn btn-quiet btn-sm" type="button" onClick={() => onPages.retake(doc.id, page)}><Icon name="camera" size={15} /> Retake</button>
                <button className="btn btn-quiet btn-sm" type="button" onClick={() => setMoving(true)}>Move to…</button>
                <button className="icon-btn" type="button" onClick={() => setConfirmPageDel(true)} aria-label="Delete this page"><Icon name="trash" size={16} /></button>
              </div>
            )
          )}
          <div className="preview-tools">
            <button className="btn btn-quiet" onClick={() => setOriginal(true)} type="button"><Icon name="eye" size={16} /> View original page</button>
          </div>
          {doc.sources?.[page] && (
            <p className="fine scan-src">Scan {doc.sources[page].size ? `${doc.sources[page].size[0]} × ${doc.sources[page].size[1]} px` : ''} · from the {doc.sources[page].from === 'photo' ? 'full-resolution camera photo' : 'video picture'}</p>
          )}
          {moving && <MovePageSheet docs={docs} from={doc} onClose={() => setMoving(false)} onPick={(target: string) => { setMoving(false); onPages.moveTo(doc.id, page, target); }} />}
        </section>

        <section className="detail-info">
          {doc.review && (
            <button className="review-banner" onClick={goReview} type="button">
              <Icon name="alert" size={16} /> {doc.review === 'duplicate' ? 'Possible duplicate of another document.' : 'Document type unclear.'} <u>Review</u>
            </button>
          )}
          <h1 className="detail-title"><span dir="auto">{doc.title}</span></h1>
          <div className="detail-cat">
            <label htmlFor="cat">Looks like</label>
            <select id="cat" value={doc.category} onChange={(e: any) => (e.target.value === '__new' ? openAdd(doc.id) : onChangeCategory(doc.id, e.target.value))}>
              {all.map((c: string) => <option key={c} value={c}>{c}</option>)}
              <option value="__new">+ New category…</option>
            </select>
          </div>
          <dl className="fields">
            <div><dt>Sender</dt><dd><span dir="auto">{isUnknown(doc) ? 'Not detected' : doc.sender}</span><em>{isUnknown(doc) ? '' : 'Detected'}</em></dd></div>
            <div><dt>Date</dt><dd className="num">{doc.date ? <>{doc.date}<em>{doc.kind === 'handwritten' ? 'Low certainty' : 'Detected'}</em></> : <span className="muted">No date found</span>}</dd></div>
            <div><dt>Amount</dt><dd className="num">{doc.amount ? <>{doc.amount}<em>Detected</em></> : <span className="muted">No amount found</span>}</dd></div>
            <div><dt>Pages</dt><dd>{doc.pages}</dd></div>
            <div><dt>Captured</dt><dd>Today, {doc.capturedAt} · stored on this device</dd></div>
          </dl>

          <h2 className="h-sub">Why we classified this</h2>
          <ul className="reasons">
            {reasonsFor(doc).map((r) => (
              <li key={r.label}><span className="r-k">{r.label}:</span> <span className="r-v" dir="auto">{r.value}</span><small dir="auto">{r.source}</small></li>
            ))}
          </ul>

          <h2 className="h-sub">Extracted text</h2>
          <div className="ocr" dir="rtl" lang="he">{lines.length ? lines.map((l, i) => <div key={i} dir="auto">{l}</div>) : <div className="muted" dir="ltr">No text was read from this page.</div>}</div>
          <p className="fine">Read automatically on this device and may contain mistakes. If a detail matters, check the original page.</p>
          {onDelete && (confirmDel ? (
            <div className="confirm del-row"><span>Delete this document from the archive?</span>
              <button className="btn btn-quiet btn-sm" type="button" onClick={() => setConfirmDel(false)}>Cancel</button>
              <button className="btn btn-danger btn-sm" type="button" onClick={() => onDelete(doc.id)}>Delete</button></div>
          ) : (
            <button className="btn btn-quiet btn-sm danger del-row" type="button" onClick={() => setConfirmDel(true)}><Icon name="trash" size={15} /> Delete document</button>
          ))}
        </section>
      </div>

      {original && (
        <div className="original" role="dialog" aria-label="Original page" onClick={() => setOriginal(false)}>
          <div className="original-inner" onClick={(e: any) => e.stopPropagation()}>
            <div className="original-head">
              <span>Original capture · page {page + 1} of {doc.pages} · {doc.capturedAt}</span>
              <button className="icon-btn light" onClick={() => setOriginal(false)} type="button" aria-label="Close"><Icon name="close" /></button>
            </div>
            {doc.originals ? (
              <div className="orig-real" style={{ width: `min(100%, calc(68vh * ${doc.originals[page]?.ratio || 1}))` }}>
                <img src={doc.originals[page]?.src} alt="Original camera frame" />
                <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                  <polygon points={(doc.originals[page]?.quad || []).map((p: number[]) => p.join(',')).join(' ')} />
                </svg>
              </div>
            ) : (
              <div className="original-photo">
                <div className="original-paper" style={{ transform: `rotate(${doc.tilt}deg) perspective(900px) rotateX(7deg)` }}><DocPaper doc={doc} page={page} /></div>
              </div>
            )}
            <p>The unedited camera frame{doc.originals ? ', with the outline that was detected' : ''}, kept so you can always check what was actually on the paper.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ArchiveScreen({ docs, setDocs, tab, setTab, openPrivacy, onNewSession, onAllArchives, archiveName, toast, onScanFor, initialOpenId = null }: any) {
  const [openId, setOpenIdRaw] = useState(initialOpenId as string | null);
  // Opening a document adds a history step, so the phone's Back button closes it instead of leaving
  const setOpenId = (id: string | null) => {
    if (id) { try { history.pushState({ screen: 'archive', detail: id }, ''); } catch { /* ignore */ } setOpenIdRaw(id); }
    else if (openIdRef.current) { try { history.back(); } catch { setOpenIdRaw(null); } }
  };
  const openIdRef = useRef(null as string | null);
  openIdRef.current = openId;
  useEffect(() => { if (initialOpenId) { try { history.pushState({ screen: 'archive', detail: initialOpenId }, ''); } catch { /* ignore */ } } }, []);
  useEffect(() => {
    const onPop = () => { if (openIdRef.current) setOpenIdRaw(null); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [filter, setFilter] = useState('All');
  const pending = docs.filter((d: ArchiveDoc) => d.review).length;
  const pages = docs.reduce((n: number, d: ArchiveDoc) => n + d.pages, 0);
  const open = docs.find((d: ArchiveDoc) => d.id === openId);

  const update = (id: string, patch: Partial<ArchiveDoc>) => setDocs((ds: ArchiveDoc[]) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  function resolveDuplicate(id: string, isDup: boolean) {
    if (isDup) { setDocs((ds: ArchiveDoc[]) => ds.filter((d) => d.id !== id)); toast('Marked as duplicate. The first copy is kept.'); }
    else { update(id, { review: undefined }); toast('Kept both copies'); }
  }
  const pageOps = {
    retake(id: string, i: number) { onScanFor?.(id, 'retake', i); },
    addPages(id: string) { onScanFor?.(id, 'add', 0); },
    reorder(id: string, idx: number[]) { setDocs((ds: ArchiveDoc[]) => ds.map((d) => (d.id === id ? withPages(d, idx) : d))); },
    remove(id: string, i: number) {
      const d = docs.find((x: ArchiveDoc) => x.id === id); if (!d) return;
      const key = d.pageKeys?.[i];
      if (key) store.deletePages([key]).catch(() => {});
      if (d.pages <= 1) { deleteDoc(id); return; }
      setDocs((ds: ArchiveDoc[]) => ds.map((x) => (x.id === id ? withPages(x, [...Array(x.pages).keys()].filter((k) => k !== i)) : x)));
      toast('Page deleted');
    },
    moveTo(id: string, i: number, target: string) {
      const src = docs.find((x: ArchiveDoc) => x.id === id); if (!src) return;
      const rest = [...Array(src.pages).keys()].filter((k) => k !== i);
      let created: ArchiveDoc | null = null;
      setDocs((ds: ArchiveDoc[]) => {
        let out = ds.map((d) => {
          if (d.id === target) return withPages(d, [...Array(d.pages).keys()], { from: src, idx: [i] });
          if (d.id === id) return rest.length ? withPages(d, rest) : null;
          return d;
        }).filter(Boolean) as ArchiveDoc[];
        if (target === 'new') {
          created = pageAsDocument(src, i);
          const at = out.findIndex((d) => d.id === id);
          out.splice(at < 0 ? out.length : at + 1, 0, created);
        }
        return out;
      });
      const name = target === 'new' ? 'a new document' : `“${docs.find((x: ArchiveDoc) => x.id === target)?.title || 'the document'}”`;
      toast(`Page moved to ${name}`);
      if (!rest.length) setTimeout(() => setOpenId(null), 0);
    },
  };
  function deleteDoc(id: string) {
    setDocs((ds: ArchiveDoc[]) => ds.filter((d) => d.id !== id));
    if (openIdRef.current === id) setOpenId(null);
    toast('Deleted from this archive');
  }
  function resolveUnclear(id: string, c: string | null) {
    const target = docs.find((x: ArchiveDoc) => x.id === id);
    update(id, target?.real ? { review: undefined, category: c || 'Other' } : { review: undefined, category: c || 'Other', title: c ? 'הערה בכתב יד' : 'מסמך לא מזוהה' });
    toast(c ? `Filed under ${c}` : 'Left unclassified, filed under Other');
  }

  useEffect(() => { window.scrollTo(0, 0); }, [openId, tab]);

  if (open) {
    return (
      <div className="page">
        <AppHeader onHome={() => setOpenId(null)} openPrivacy={openPrivacy} />
        <DocumentDetail doc={open} docs={docs} onPages={pageOps} onDelete={deleteDoc} onBack={() => setOpenId(null)} goReview={() => { setOpenId(null); setTab('review'); }}
          onChangeCategory={(id: string, c: Category) => { update(id, { category: c }); toast(`Category changed to ${c}`); }} />
      </div>
    );
  }

  return (
    <div className="page">
      <AppHeader onHome={onAllArchives} openPrivacy={openPrivacy}
        right={<>
          <button className="btn btn-quiet btn-sm" onClick={onAllArchives} type="button"><Icon name="list" size={16} /> All archives</button>

        </>} />
      <main className="archive">
        <div className="archive-head">
          {archiveName && <button className="btn btn-primary btn-sm scan-more" onClick={onNewSession} type="button"><Icon name="camera" size={16} /> Scan more documents</button>}
          <h1 className="h-page" dir="auto">{archiveName || 'My Archive'}</h1>
          <p className="muted num">{plural(docs.length, 'document')} · {plural(pages, 'page')}{archiveName ? ' · saved on this device' : ' · sample, not saved'}</p>
        </div>
        <nav className="tabs" aria-label="Archive sections">
          <button type="button" className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>Documents</button>
          <button type="button" className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>Needs review {pending > 0 && <span className="badge">{pending}</span>}</button>
          <button type="button" className={tab === 'export' ? 'on' : ''} onClick={() => setTab('export')}>Export</button>
        </nav>
        {tab === 'docs' && <DocumentsTab docs={docs} onOpen={setOpenId} filter={filter} setFilter={setFilter} />}
        {tab === 'review' && <ReviewTab docs={docs} resolveDuplicate={resolveDuplicate} resolveUnclear={resolveUnclear} onOpen={setOpenId} deleteDoc={deleteDoc} />}
        {tab === 'export' && <ExportTab docs={docs} toast={toast} />}
      </main>
    </div>
  );
}

function PrivacySheet({ onClose, onDelete, hasArchive }: any) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Privacy" onClick={(e: any) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="privacy-icon"><Icon name="device" size={20} /></span>
          <h2>Your documents stay on this device.</h2>
          <button className="icon-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" /></button>
        </div>
        <ul className="checks">
          <li><Icon name="check" size={16} /> Camera frames are analyzed in this browser.</li>
          <li><Icon name="check" size={16} /> Page images and extracted text are stored only here.</li>
          <li><Icon name="check" size={16} /> No account and no sign-in. There is nothing to upload to.</li>
          <li><Icon name="check" size={16} /> Exports are built on the device, even offline.</li>
          <li><Icon name="check" size={16} /> The text reader is downloaded once from a public library server. Your pages are never sent anywhere.</li>
        </ul>
        {hasArchive && (!confirm ? (
          <button className="btn btn-quiet danger" onClick={() => setConfirm(true)} type="button"><Icon name="trash" size={16} /> Delete all archives from this device</button>
        ) : (
          <div className="confirm">
            <span>Delete every archive, page and text on this device? This can’t be undone.</span>
            <button className="btn btn-quiet" onClick={() => setConfirm(false)} type="button">Cancel</button>
            <button className="btn btn-danger" onClick={onDelete} type="button">Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================================================================
 * App
 * ================================================================ */
function AddCategorySheet({ custom, assignTo, onClose, onSave, onRemove }: any) {
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [error, setError] = useState('');
  const taken = (n: string) => [...CATEGORIES, ...custom.map((c: CustomCat) => c.name)].some((x) => x.toLowerCase() === n.trim().toLowerCase());
  const presets = CATEGORY_PRESETS.filter((p) => !taken(p.name));
  function submit(e: any) {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError('Give the category a name.'); return; }
    if (taken(n)) { setError(`“${n}” already exists.`); return; }
    const keywords = words.split(/[,\n،]/).map((w) => w.trim()).filter(Boolean);
    onSave({ name: n, keywords });
  }
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <form className="sheet" role="dialog" aria-label="Add category" onClick={(e: any) => e.stopPropagation()} onSubmit={submit}>
        <div className="sheet-head">
          <span className="privacy-icon cat-icon"><Icon name="tag" size={20} /></span>
          <h2>{assignTo ? 'New category for this document' : 'Add a category'}</h2>
          <button className="icon-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" /></button>
        </div>
        {presets.length > 0 && (
          <div className="presets">
            <span>Start from</span>
            {presets.map((p) => (
              <button key={p.name} type="button" className="filter" onClick={() => { setName(p.name); setWords(p.keywords.join(', ')); setError(''); }}>{p.name}</button>
            ))}
          </div>
        )}
        <label className="field" htmlFor="cat-name">
          <span>Name</span>
          <input id="cat-name" value={name} onChange={(e: any) => { setName(e.target.value); setError(''); }} placeholder="e.g. Store receipts or קבלות" dir="auto" autoComplete="off" />
        </label>
        <label className="field" htmlFor="cat-words">
          <span>Words that identify it <small>optional, separated by commas</small></span>
          <textarea id="cat-words" value={words} onChange={(e: any) => setWords(e.target.value)} rows={3} placeholder="קבלה, שופרסל, רמי לוי" dir="auto" />
          <small className="hint">Pages whose text contains any of these words are filed here automatically, now and in future sessions.</small>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="cta-row end">
          <button className="btn btn-quiet" onClick={onClose} type="button">Cancel</button>
          <button className="btn btn-primary" type="submit">Add category</button>
        </div>
        {custom.length > 0 && !assignTo && (
          <div className="your-cats">
            <h3>Your categories</h3>
            {custom.map((c: CustomCat) => (
              <div className="your-cat" key={c.name}>
                <div><strong dir="auto">{c.name}</strong><small dir="auto">{c.keywords.length ? c.keywords.join(', ') : 'No words, filed by hand only'}</small></div>
                <button type="button" className="icon-btn" aria-label={`Remove ${c.name}`} onClick={() => onRemove(c.name)}><Icon name="trash" size={16} /></button>
              </div>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}

function loadCustomCats(): CustomCat[] {
  try { const v = JSON.parse(localStorage.getItem('pa.categories') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

type Screen = 'home' | 'how' | 'setup' | 'camera' | 'processing' | 'archive';

function App() {
  const [screen, setScreen] = useState('home' as Screen);
  const [stream, setStream] = useState(null as any);
  const [captured, setCaptured] = useState([] as PageImage[]);
  const [usedSample, setUsedSample] = useState(false);
  const [docs, setDocs] = useState([] as ArchiveDoc[]);
  const [docsOwner, setDocsOwner] = useState(null as string | null);   // which saved archive `docs` belongs to
  const [tab, setTab] = useState('docs');
  const [privacy, setPrivacy] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const [sessionKey, setSessionKey] = useState(0);
  const [realPages, setRealPages] = useState(null as RealPage[] | null);
  const [cameraInitial, setCameraInitial] = useState([] as RealPage[]);
  const [pageTarget, setPageTarget] = useState(null as null | { docId: string; mode: 'retake' | 'add'; index: number; title: string });
  const [reopenId, setReopenId] = useState(null as string | null);
  const [sessions, setSessions] = useState([] as SessionMeta[]);
  const [current, setCurrentState] = useState(null as SessionMeta | null);
  const [usage, setUsage] = useState('');
  const currentRef = useRef(null as SessionMeta | null);
  const creating = useRef(null as Promise<SessionMeta> | null);
  const [custom, setCustom] = useState(loadCustomCats);
  const [addCat, setAddCat] = useState(null as null | { assignTo?: string });
  CUSTOM_RULES = custom;
  useEffect(() => { try { localStorage.setItem('pa.categories', JSON.stringify(custom)); } catch { /* storage unavailable */ } }, [custom]);
  const catsValue = useMemo(() => ({ all: [...CATEGORIES, ...custom.map((c: CustomCat) => c.name)], custom, openAdd: (assignTo?: string) => setAddCat({ assignTo }) }), [custom]);
  const toastTimer = useRef(0 as any);
  const toast = (m: string) => { setToastMsg(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(''), m.length > 60 ? 6500 : 2600); };

  /* ---------- saved archives ---------- */
  const setCurrent = (m: SessionMeta | null) => { currentRef.current = m; setCurrentState(m); };
  async function refreshSessions() {
    try { setSessions(await store.listSessions()); } catch { setSessions([]); }
    try { const e = await (navigator as any).storage?.estimate?.(); if (e?.usage) setUsage(fmtBytes(e.usage)); } catch { /* not supported */ }
  }
  useEffect(() => { refreshSessions(); }, []);
  // Fetch and start the text reader in the background as soon as the site opens (cached after the first visit)
  useEffect(() => {
    let inFrame = false; try { inFrame = window.self !== window.top; } catch { inFrame = true; }
    if (inFrame) return;
    const start = () => { getOcrWorker().catch(() => {}); };
    const idle = (window as any).requestIdleCallback;
    const h = idle ? idle(start, { timeout: 2500 }) : setTimeout(start, 1200);
    return () => { if (idle) (window as any).cancelIdleCallback?.(h); else clearTimeout(h); };
  }, []);
  async function saveMeta(patch: Partial<SessionMeta>) {
    const cur = currentRef.current; if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    setCurrent(next);
    try { await store.putSession(next); } catch { /* storage unavailable */ }
  }
  function ensureSession(): Promise<SessionMeta> {
    if (currentRef.current) return Promise.resolve(currentRef.current);
    if (!creating.current) {
      creating.current = (async () => {
        const now = Date.now();
        const m: SessionMeta = { id: `s${now.toString(36)}`, name: defaultSessionName(now), createdAt: now, updatedAt: now, pageKeys: [], docs: [], cover: [], processed: [] } as any;
        setCurrent(m);
        try { await store.putSession(m); askPersistentStorage(); } catch { toast('This browser won’t keep archives, so this one lasts until you close the page.'); }
        return m;
      })();
      creating.current.finally(() => { creating.current = null; });
    }
    return creating.current;
  }
  // Save each captured page the moment it's taken
  async function onPageCaptured(page: RealPage, replaceKey: string) {
    const m = await ensureSession();
    try {
      await store.putPage({ ...page, sessionId: m.id } as StoredPage);
      if (replaceKey) await store.deletePages([replaceKey]);
    } catch { /* storage unavailable */ }
    const cur = currentRef.current || m;
    const pageKeys = replaceKey ? cur.pageKeys.map((k) => (k === replaceKey ? page.key : k)) : [...cur.pageKeys, page.key];
    const cover = cur.cover.length < 3 && !replaceKey ? [...cur.cover, page.thumb] : cur.cover;
    await saveMeta({ pageKeys, cover });
  }
  // Save text as soon as a page has been read
  useEffect(() => {
    onPageRead = (key, out, pdf) => { store.updatePage(key, { ocr: out, ...(pdf ? { pdf } : {}) }).catch(() => {}); };
  }, []);
  // Save edits to documents (category changes, reviews) shortly after they happen
  useEffect(() => {
    if (!docsOwner || !currentRef.current || currentRef.current.id !== docsOwner) return;
    const t = setTimeout(() => saveMeta({ docs: docs.map(toStoredDoc) }), 400);
    return () => clearTimeout(t);
  }, [docs, docsOwner]);

  async function loadSession(id: string) {
    const meta = await store.getSession(id);
    if (!meta) { toast('That archive is no longer on this device.'); refreshSessions(); return null; }
    const pages = await store.getPages(id);
    primeReadCache(pages);
    const map = new Map(pages.map((p) => [p.key, p] as [string, StoredPage]));
    const processed = new Set((meta as any).processed || meta.docs.flatMap((d) => d.pageKeys));
    const pending = meta.pageKeys.filter((k) => !processed.has(k) && map.has(k)).map((k) => toRealPage(map.get(k)!));
    setCurrent(meta);
    setDocs(meta.docs.map((d) => hydrateDoc(d, map)));
    setDocsOwner(meta.id);
    return { meta, pending };
  }

  /* ---------- navigation (the phone's Back button moves within the app) ---------- */
  const go = (s: Screen) => { try { history.pushState({ screen: s }, ''); } catch { /* ignore */ } setScreen(s); window.scrollTo(0, 0); };
  useEffect(() => {
    try { history.replaceState({ screen: 'home' }, ''); } catch { /* ignore */ }
    const onPop = (e: PopStateEvent) => {
      let target: Screen = (e.state && e.state.screen) || 'home';
      if (target === 'camera' || target === 'processing') target = 'home';   // never re-enter these by going back
      setScreen(target);
      if (target === 'home') refreshSessions();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const stopStream = () => { if (stream) stream.getTracks().forEach((t: any) => t.stop()); setStream(null); };
  useEffect(() => { if (screen !== 'camera' && stream) stopStream(); if (screen !== 'camera') setPageTarget(null); }, [screen]);

  /* ---------- Retake a page, or scan more pages into one document ---------- */
  async function scanFor(docId: string, mode: 'retake' | 'add', index: number) {
    const d = docs.find((x: ArchiveDoc) => x.id === docId); if (!d) return;
    setCameraInitial([]);
    const ok = await startCamera('cam', true);
    if (ok) setPageTarget({ docId, mode, index, title: d.title });
  }
  async function applyScans(target: { docId: string; mode: 'retake' | 'add'; index: number }, ps: RealPage[]) {
    stopStream(); setReopenId(target.docId); setTab('docs'); go('archive');
    if (!ps.length) return;
    const before = docs.find((x: ArchiveDoc) => x.id === target.docId);
    if (!before) return;
    const oldKey = target.mode === 'retake' ? before.pageKeys?.[target.index] : undefined;
    const hadText = !!(before.ocr && before.ocr.length) && before.review !== 'unclear';
    const entry = (p: RealPage, lines: string[] = []) => ({
      image: p.image, thumb: p.thumb, original: { src: p.original, quad: p.quad, ratio: p.originalRatio }, pdf: pagePdf.get(p.key) || null,
      pageKey: p.key, look: p.look, aspect: p.aspect, pageText: lines, source: p.source ? { from: p.source, size: p.size } : null,
    });
    // Show the new scan straight away
    setDocs((ds: ArchiveDoc[]) => ds.map((d) => (d.id === target.docId ? placePages(d, target.mode, target.index, ps.map((p) => entry(p))) : d)));
    toast(target.mode === 'retake' ? 'Page retaken. Reading its text…' : `Added ${plural(ps.length, 'page')}. Reading the text…`);
    const cur = currentRef.current;
    if (cur) {
      const processed = Array.from(new Set([...((cur as any).processed || []), ...ps.map((p) => p.key)]));
      await saveMeta({ processed, pageKeys: oldKey ? cur.pageKeys.filter((k) => k !== oldKey) : cur.pageKeys } as any);
      if (oldKey) store.deletePages([oldKey]).catch(() => {});
    }
    // Then fill in the text (and re-sort if the document had none before)
    const outs = await Promise.all(ps.map((p) => readPage(p)));
    setDocs((ds: ArchiveDoc[]) => ds.map((d) => {
      if (d.id !== target.docId) return d;
      const next: any = { ...d, pageTexts: [...(d.pageTexts || [])], pdfs: [...(d.pdfs || [])] };
      ps.forEach((p, i) => {
        const at = (d.pageKeys || []).indexOf(p.key);
        if (at >= 0) { next.pageTexts[at] = outs[i].lines; next.pdfs[at] = pagePdf.get(p.key) || null; }
      });
      next.ocr = (next.pageTexts as string[][]).flat().filter(Boolean);
      return hadText ? next : resortDocument(next);
    }));
    toast(target.mode === 'retake' ? 'New page is ready' : 'Pages added');
  }

  function samplePages(): PageImage[] {
    const t0 = Date.now() - 14 * 60000;
    return QUEUE.flatMap((d, i) => Array.from({ length: d.pages }).map((_, p) => ({ key: `${d.id}:${p}`, docId: d.id, pageIndex: p, capturedAt: t0 + i * 50000 + p * 9000 })));
  }
  function openSample() { setCurrent(null); setDocsOwner(null); setRealPages(null); setCaptured(samplePages()); setUsedSample(false); go('processing'); }

  /** Returns true when the real camera started. */
  async function startCamera(source: string, strict = false): Promise<boolean> {
    if (source === 'cam') {
      const fallback = strict ? '' : ' Using the simulated desk instead.';
      let inFrame = false;
      try { inFrame = window.self !== window.top; } catch { inFrame = true; }
      if (!window.isSecureContext) {
        toast('The camera only works on an https:// address.' + fallback);
      } else if (!navigator.mediaDevices?.getUserMedia) {
        toast('This browser doesn’t allow camera access here. Open the page directly in Safari or Chrome.' + fallback);
      } else {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
          setStream(s); setSessionKey((k: number) => k + 1); go('camera');
          return true;
        } catch (err: any) {
          const name = err?.name || '';
          if (inFrame && (name === 'NotAllowedError' || name === 'SecurityError')) toast('Claude’s viewer blocks the camera. Open a hosted copy of this page to use it.' + fallback);
          else if (name === 'NotAllowedError') toast('Camera access was declined. Allow it in your browser’s site settings, then try again.' + fallback);
          else if (name === 'NotFoundError' || name === 'OverconstrainedError') toast('No camera was found on this device.' + fallback);
          else if (name === 'NotReadableError') toast('Another app is using the camera. Close it and try again.' + fallback);
          else toast(`The camera couldn’t start (${name || 'unknown error'}).` + fallback);
        }
      }
      if (strict) return false;
    }
    setCurrent(null); setDocsOwner(null);   // the simulated desk is a demo and isn't saved
    setSessionKey((k: number) => k + 1); go('camera');
    return false;
  }

  function startNewArchive() { setCurrent(null); setDocs([]); setDocsOwner(null); setCameraInitial([]); go('setup'); }
  async function continueSession(id: string) {
    const r = await loadSession(id); if (!r) return;
    setCameraInitial(r.pending);
    await startCamera('cam', true);
  }
  async function addPagesTo(id: string) {
    const r = await loadSession(id); if (!r) return;
    setCameraInitial([]);
    await startCamera('cam', true);
  }
  async function finishSession(id: string) {
    const r = await loadSession(id); if (!r) return;
    if (!r.pending.length) { setTab('docs'); go('archive'); return; }
    setRealPages(r.pending); go('processing');
  }
  async function openSession(id: string) {
    setReopenId(null);
    const r = await loadSession(id); if (!r) return;
    setTab('docs'); go('archive');
  }
  async function deleteSession(id: string) {
    try { await store.deleteSession(id); } catch { /* ignore */ }
    if (currentRef.current?.id === id) { setCurrent(null); setDocs([]); setDocsOwner(null); }
    refreshSessions(); toast('Archive deleted from this device');
  }
  async function renameSession(id: string, name: string) {
    try { const m = await store.getSession(id); if (m) await store.putSession({ ...m, name, updatedAt: Date.now() }); } catch { /* ignore */ }
    if (currentRef.current?.id === id) setCurrent({ ...currentRef.current, name });
    refreshSessions();
  }
  // Camera "Start over": drop pages not yet sorted; documents already in the archive stay
  async function discardPending(pages: RealPage[]) {
    const cur = currentRef.current;
    if (cur) {
      const processed = new Set((cur as any).processed || []);
      const drop = cur.pageKeys.filter((k) => !processed.has(k));
      try { await store.deletePages(drop); } catch { /* ignore */ }
      const pageKeys = cur.pageKeys.filter((k) => processed.has(k));
      if (!pageKeys.length && !cur.docs.length) { try { await store.deleteSession(cur.id); } catch { /* ignore */ } setCurrent(null); }
      else await saveMeta({ pageKeys, cover: cur.cover.slice(0, Math.min(cur.cover.length, pageKeys.length)) });
    }
    setCameraInitial([]); setSessionKey((k: number) => k + 1);
    toast('Started over. Place the first document.');
  }

  function saveCategory(cat: CustomCat) {
    const assignTo = addCat?.assignTo;
    setCustom((cs: CustomCat[]) => [...cs, cat]);
    setAddCat(null);
    let moved = 0;
    setDocs((list: ArchiveDoc[]) => {
      const r = applyCategoryRule(cat, list);
      moved = r.moved;
      let out = r.docs;
      if (assignTo) out = out.map((d) => (d.id === assignTo && d.category !== cat.name ? { ...d, category: cat.name, review: d.review === 'unclear' ? undefined : d.review } : d));
      return out;
    });
    setTimeout(() => toast(assignTo ? `Filed under ${cat.name}` : moved ? `Added ${cat.name}. Moved ${plural(moved, 'document')} there.` : `Added ${cat.name}`), 0);
  }
  function removeCategory(name: string) {
    setCustom((cs: CustomCat[]) => cs.filter((c) => c.name !== name));
    setDocs((list: ArchiveDoc[]) => list.map((d) => (d.category === name ? { ...d, category: 'Other' } : d)));
    toast(`Removed ${name}. Its documents moved to Other.`);
  }

  const openPrivacy = () => setPrivacy(true);
  const sessionList = (
    <SessionList sessions={sessions} usage={usage} onContinue={continueSession} onOpen={openSession} onAddMore={addPagesTo}
      onFinish={finishSession} onDelete={deleteSession} onRename={renameSession} onNew={startNewArchive} />
  );

  return (
    <CatsCtx.Provider value={catsValue}>
      {screen === 'home' && <HomeScreen onStart={startNewArchive} onHow={() => go('how')} openPrivacy={openPrivacy}
        onSample={openSample} sessionList={sessionList} hasSessions={sessions.length > 0} />}
      {screen === 'how' && <HowScreen onBack={() => go('home')} onStart={startNewArchive} openPrivacy={openPrivacy} onSample={openSample} />}
      {screen === 'setup' && <SetupScreen onBack={() => go('home')} onStartCamera={(src: string) => startCamera(src)} openPrivacy={openPrivacy} />}
      {screen === 'camera' && stream && <RealCameraScreen key={sessionKey} stream={stream} openPrivacy={openPrivacy}
        target={pageTarget ? { mode: pageTarget.mode, index: pageTarget.index, title: pageTarget.title } : null}
        initialPages={cameraInitial} onPageCaptured={onPageCaptured} sessionName={current?.name || ''}
        existingFaces={(docsOwner && current && docsOwner === current.id ? docs : []).flatMap((d: ArchiveDoc) => (d.looks || []).map((look, i) => ({ look, aspect: d.aspects?.[i], lines: d.pageTexts?.[i] || [] })))}
        onPageUpgraded={(pg: RealPage) => { const m = currentRef.current; if (m) store.putPage({ ...pg, sessionId: m.id } as StoredPage).catch(() => {}); }}
        onRestart={discardPending}
        onExit={() => { stopStream(); go('home'); refreshSessions(); }}
        onFinish={(ps: RealPage[]) => {
          if (pageTarget) { applyScans(pageTarget, ps); return; }
          if (!ps.length) { toast('No pages captured yet. Lay a document in view and hold it still for a second.'); return; }
          stopStream(); setRealPages(ps); go('processing');
        }} />}
      {screen === 'camera' && !stream && <CameraScreen key={sessionKey} openPrivacy={openPrivacy}
        onRestart={() => { setSessionKey((k: number) => k + 1); toast('Started over. Place the first document.'); }}
        onExit={() => go('home')}
        onFinish={(pages: PageImage[]) => { setRealPages(null); const empty = pages.length === 0; setUsedSample(empty); setCaptured(empty ? samplePages() : pages); go('processing'); }} />}
      {screen === 'processing' && realPages && <RealProcessingScreen pages={realPages} openPrivacy={openPrivacy} existing={docsOwner && current && docsOwner === current.id ? docs : []}
        onView={async (d: ArchiveDoc[]) => {
          const m = await ensureSession();
          const keep = docsOwner === m.id ? docs : [];
          const all = [...keep, ...d];
          const processed = Array.from(new Set([...(((currentRef.current as any) || {}).processed || []), ...realPages.map((p) => p.key)]));
          setDocs(all); setDocsOwner(m.id);
          await saveMeta({ docs: all.map(toStoredDoc), processed } as any);
          setRealPages(null); setCameraInitial([]); setTab('docs'); go('archive'); refreshSessions();
        }} />}
      {screen === 'processing' && !realPages && <ProcessingScreen pages={captured} usedSample={usedSample} openPrivacy={openPrivacy}
        onView={(d: ArchiveDoc[]) => { setCurrent(null); setDocsOwner(null); setDocs(custom.reduce((acc: ArchiveDoc[], c: CustomCat) => applyCategoryRule(c, acc).docs, d)); setTab('docs'); go('archive'); }} />}
      {screen === 'archive' && <ArchiveScreen docs={docs} setDocs={setDocs} tab={tab} setTab={setTab} openPrivacy={openPrivacy} toast={toast}
        onScanFor={scanFor} initialOpenId={reopenId}
        archiveName={docsOwner ? current?.name : ''}
        onAllArchives={() => { setReopenId(null); go('home'); refreshSessions(); }}
        onNewSession={() => { setCameraInitial([]); go('setup'); }} />}

      {privacy && <PrivacySheet onClose={() => setPrivacy(false)} hasArchive={docs.length > 0 || sessions.length > 0}
        onDelete={async () => { try { await store.deleteAll(); } catch { /* ignore */ } setCurrent(null); setDocs([]); setDocsOwner(null); setCaptured([]); setPrivacy(false); go('home'); refreshSessions(); toast('All archives deleted from this device'); }} />}
      {addCat && <AddCategorySheet custom={custom} assignTo={addCat.assignTo} onClose={() => setAddCat(null)} onSave={saveCategory} onRemove={removeCategory} />}
      <div className={`toast ${toastMsg ? 'show' : ''}`} role="status" aria-live="polite">{toastMsg}</div>
    </CatsCtx.Provider>
  );
}
