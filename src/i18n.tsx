/* ================================================================
 * Languages: English, Hebrew, Arabic
 *
 * Every on-screen text is written in English in the code and passed through
 * t(). Hebrew and Arabic come from the dictionaries in dict.tsx; anything
 * missing falls back to English. The choice is kept in this browser
 * (localStorage "pa.lang") so the next visit opens in the same language.
 * ================================================================ */
type Lang = 'en' | 'he' | 'ar';
const LANGS: { code: Lang; name: string; dir: 'ltr' | 'rtl' }[] = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'he', name: 'עברית', dir: 'rtl' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
];
const isLang = (v: any): v is Lang => v === 'en' || v === 'he' || v === 'ar';
let LANG: Lang = (() => { try { const v = localStorage.getItem('pa.lang'); if (isLang(v)) return v; } catch { /* storage unavailable */ } return 'en'; })();
const hasChosenLang = () => { try { return isLang(localStorage.getItem('pa.lang')); } catch { return false; } };
/** A sensible first suggestion from the phone's own language. */
const suggestedLang = (): Lang => {
  const l = (navigator.languages || [navigator.language || 'en']).map((x) => String(x).toLowerCase());
  if (l.some((x) => x.startsWith('he') || x.startsWith('iw'))) return 'he';
  if (l.some((x) => x.startsWith('ar'))) return 'ar';
  return 'en';
};
function setDocumentLang(l: Lang) {
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'en' ? 'ltr' : 'rtl';
}
setDocumentLang(LANG);
function applyLang(l: Lang) {
  LANG = l;
  try { localStorage.setItem('pa.lang', l); } catch { /* storage unavailable */ }
  setDocumentLang(l);
}
const isRtl = () => LANG !== 'en';
const locale = () => (LANG === 'he' ? 'he-IL' : LANG === 'ar' ? 'ar-u-nu-latn' : 'en-GB');

function t(key: string, vars?: Record<string, any>): string {
  const d: any = LANG === 'en' ? null : (DICT as any)[LANG];
  let s: string = (d && d[key]) || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
  return s;
}
/** Built-in category names are translated; the person's own categories are shown as they wrote them. */
const tc = (c: string) => (['Bills', 'Insurance', 'Bank', 'Government', 'Other', 'All', 'Needs review'].includes(c) ? t(c) : c);

/** Counted words: "3 pages", "3 עמודים", "3 صفحات". Arabic has six plural forms. */
function plural(n: number, one: string, many = one + 's') {
  if (LANG === 'en') return `${n} ${n === 1 ? one : many}`;
  const forms: any = (PLURALS as any)[LANG]?.[one];
  if (!forms) return `${n} ${t(n === 1 ? one : many)}`;
  let cat = 'other';
  try { cat = new Intl.PluralRules(LANG).select(n); } catch { cat = n === 1 ? 'one' : 'other'; }
  return String(forms[cat] || forms.other).replace('{n}', String(n));
}

/** Messages that were saved with a document (why it was sorted) are stored in English and translated when shown. */
const REASON_PATTERNS: [RegExp, string][] = [
  [/^Letterhead reads “(.*)”$/, 'Letterhead reads “{0}”'],
  [/^Heading contains “(.*)”$/, 'Heading contains “{0}”'],
  [/^Printed next to “(.*)”$/, 'Printed next to “{0}”'],
  [/^Found “(.*)” in the text$/, 'Found “{0}” in the text'],
  [/^Text contains “(.*)” \(your rule\)$/, 'Text contains “{0}” (your rule)'],
  [/^Text contains “(.*)”$/, 'Text contains “{0}”'],
  [/^Number next to “(.*)”$/, 'Number next to “{0}”'],
  [/^Handwritten “(.*)”, low certainty$/, 'Handwritten “{0}”, low certainty'],
];
function tr(s: string): string {
  if (!s) return s;
  for (const [re, key] of REASON_PATTERNS) { const m = s.match(re); if (m) return t(key, { 0: m[1] }); }
  return t(s);
}

/* ---------- Language picker ---------- */
function LanguageChooser({ onPick }: any) {
  const [pick, setPick] = useState(suggestedLang());
  return (
    <div className="lang-gate" role="dialog" aria-label="Language · שפה · اللغة">
      <div className="lang-card">
        <BrandMark />
        <h1 className="lang-title"><span dir="ltr">Paper Archive</span><span dir="rtl">ארכיון נייר</span><span dir="rtl">أرشيف الورق</span></h1>
        <p className="muted lang-sub"><span dir="ltr">Choose your language</span><span dir="rtl">בחרו שפה</span><span dir="rtl">اختر لغتك</span></p>
        <div className="lang-options">
          {LANGS.map((l) => (
            <button key={l.code} type="button" dir={l.dir} className={`lang-option ${pick === l.code ? 'on' : ''}`} onClick={() => setPick(l.code)} aria-pressed={pick === l.code}>
              <span>{l.name}</span>{pick === l.code && <Icon name="check" size={18} />}
            </button>
          ))}
        </div>
        <button className="btn btn-primary btn-lg" type="button" onClick={() => onPick(pick)}>
          {pick === 'he' ? 'המשך' : pick === 'ar' ? 'متابعة' : 'Continue'}
        </button>
        <p className="fine">{pick === 'he' ? 'אפשר להחליף שפה בכל עת מהכפתור בראש המסך.' : pick === 'ar' ? 'يمكنك تغيير اللغة في أي وقت من الزر أعلى الشاشة.' : 'You can change it any time from the button at the top.'}</p>
      </div>
    </div>
  );
}
function LangMenu({ lang, onChange }: any) {
  const [open, setOpen] = useState(false);
  const cur = LANGS.find((l) => l.code === lang) || LANGS[0];
  return (
    <div className="lang-menu">
      <button className="btn btn-quiet btn-sm lang-btn" type="button" onClick={() => setOpen(!open)} aria-haspopup="true" aria-expanded={open} aria-label={t('Language')}>
        <Icon name="globe" size={15} /> <span>{cur.name}</span>
      </button>
      {open && (
        <>
          <div className="lang-scrim" onClick={() => setOpen(false)} />
          <div className="lang-pop" role="menu">
            {LANGS.map((l) => (
              <button key={l.code} type="button" role="menuitemradio" aria-checked={l.code === lang} dir={l.dir} className={l.code === lang ? 'on' : ''} onClick={() => { setOpen(false); onChange(l.code); }}>
                {l.name}{l.code === lang && <Icon name="check" size={15} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
const LangCtx = React.createContext({ lang: 'en' as Lang, setLang: (_l: Lang) => {} });
