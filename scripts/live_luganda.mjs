// Live numbers for the Luganda Wikipedia dashboard.
//   node scripts/live_luganda.mjs [outDir]
//
// It repeats, on the live wikis, the same steps that built the September 2026 snapshot (uganda-gap/src_data/luganda_pages.py):
//   1. THE FILTER. Every page in the main namespace of lg.wikipedia.org that is not a redirect, except the wiki's front page
//      (Wikidata item Q5296). Nothing else is counted, so the live figures follow the same rule as the snapshot.
//   2. Each page's length and Wikidata item; from the item, its English article and English label.
//   3. Views since July 2015: one request per page for the complete months, plus one for the days of this month so far.
//   4. "About Uganda" = the Luganda side of an article in the English analysis. Pages that were in the snapshot keep the
//      snapshot's answer; a page that is new is tested by whether its English article is in the English analysis list
//      (t/english.articles.0.json).
// Pages that are new since the snapshot also get their first-edit year and number of edits.
//
// Writes luganda-live.json (everything the page needs, including the four article tables in the dashboard's own column
// format) and luganda-state.json (views already measured, so the next run only measures what changed).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || join(root, 'live-out');
mkdirSync(outDir, { recursive: true });
const rd = p => JSON.parse(readFileSync(p, 'utf-8'));
const UA = { 'User-Agent': 'UgandaAtlasLive/1.0 (https://kasozidenis.github.io/uganda-atlas/; wikimedia community user group uganda)' };
const LG = 'https://lg.wikipedia.org/w/api.php', WD = 'https://www.wikidata.org/w/api.php';
const PV = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/lg.wikipedia/all-access/user/';
const MAIN_PAGE = 'Q5296';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];

async function getJson(url, tries = 6, allow404 = false) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 404 && allow404) return null;
      if (r.status === 429 || r.status >= 500) { await sleep(Math.min(2000 * (i + 1), 30000)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * (i + 1)); }
  }
  throw new Error('gave up on ' + url);
}
const api = (base, params) => getJson(base + '?' + new URLSearchParams(Object.assign({ format: 'json', formatversion: '2' }, params)));

// ---------- 1. the filter: every content page of the Luganda Wikipedia ----------
async function listPages() {
  const titles = []; let cont = {};
  for (let k = 0; k < 100; k++) {
    const j = await api(LG, Object.assign({ action: 'query', list: 'allpages', apnamespace: '0', apfilterredir: 'nonredirects', aplimit: '500' }, cont));
    for (const p of j.query.allpages) titles.push(p.title);
    if (!j.continue) break; cont = j.continue; await sleep(100);
  }
  return titles;
}

// ---------- 2. length and Wikidata item of each page ----------
async function details(titles) {
  const info = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const j = await api(LG, { action: 'query', titles: titles.slice(i, i + 50).join('|'), prop: 'info|pageprops', ppprop: 'wikibase_item' });
    for (const p of j.query.pages || []) if (!p.missing) info.set(p.title, { bytes: p.length || 0, qid: (p.pageprops && p.pageprops.wikibase_item) || '' });
    await sleep(100);
  }
  return info;
}
async function wikidata(qids) {
  const out = new Map();
  for (let i = 0; i < qids.length; i += 50) {
    const j = await api(WD, { action: 'wbgetentities', ids: qids.slice(i, i + 50).join('|'), props: 'sitelinks|labels', sitefilter: 'enwiki', languages: 'en' });
    for (const [q, e] of Object.entries(j.entities || {})) {
      out.set(q, { en: (e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title) || '', label: (e.labels && e.labels.en && e.labels.en.value) || '' });
    }
    await sleep(100);
  }
  return out;
}

// ---------- 3. views ----------
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const enc = t => encodeURIComponent(t.replace(/ /g, '_'));
async function measureMonths(title, end) {
  const j = await getJson(PV + enc(title) + '/monthly/20150701/' + end, 6, true);
  const y = {};
  for (const it of (j && j.items) || []) { const yr = String(it.timestamp).slice(0, 4); y[yr] = (y[yr] || 0) + it.views; }
  return y;
}
async function measureDays(title, from, to) {
  const j = await getJson(PV + enc(title) + '/daily/' + from + '/' + to, 6, true);
  return ((j && j.items) || []).reduce((s, it) => s + it.views, 0);
}
const BUDGET_MS = Number(process.env.LIVE_BUDGET_MIN || 20) * 60000, T0 = Date.now();
const outOfTime = () => Date.now() - T0 > BUDGET_MS;
// runs fn over items with n in parallel; stops starting new items when the time budget is used up (the next run continues)
async function pool(items, n, fn, onProgress, force = false) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length && (force || !outOfTime())) {
      const k = i++; await fn(items[k]);
      if (++done % 500 === 0) { console.log('  ', done, '/', items.length); if (onProgress) onProgress(); }
    }
  }));
  return done;
}

// first-edit year and number of edits of one page (only for pages that are new since the snapshot)
async function history(title) {
  let n = 0, first = null, cont = {};
  for (let k = 0; k < 10; k++) {
    const j = await api(LG, Object.assign({ action: 'query', titles: title, prop: 'revisions', rvprop: 'timestamp', rvlimit: '500', rvdir: 'newer' }, cont));
    const p = (j.query.pages || [])[0]; const revs = (p && p.revisions) || [];
    if (!first && revs.length) first = revs[0].timestamp;
    n += revs.length;
    if (!j.continue) break; cont = j.continue;
  }
  return { created: first ? Number(first.slice(0, 4)) : null, edits: n };
}

// ---------- derived figures (shared with the check against the snapshot) ----------
const YEARS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const META = [
  { k: 'Luganda article', t: 's' }, { k: 'English label', t: 's' },
  { k: 'Total views, all time', t: 'n', f: 0 }, { k: 'Created', t: 'n', f: 0 }, { k: 'Edits', t: 'n', f: 0 },
  ...YEARS.map(y => ({ k: 'Views ' + y, t: 'n', f: 0 })),
  { k: 'Bytes', t: 'n', f: 0 }, { k: 'Wikidata', t: 's' }, { k: 'English article', t: 's' },
  { k: 'About Uganda', t: 'c', d: ['N', 'Y'] }
];
// row = { title, label, views, created, edits, y:{year:views}, bytes, qid, en, about }
function median(a) { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
function derive(rows) {
  rows.sort((a, b) => b.views - a.views || (a.title < b.title ? -1 : 1));
  const n = rows.length, pct = c => Math.round(100 * rows.filter(c).length / n);
  const cnt = c => rows.filter(c).length;
  return {
    kpis: {
      articles: n, views: rows.reduce((s, r) => s + r.views, 0),
      wikidataPct: pct(r => r.qid), englishPct: pct(r => r.en), littlePct: pct(r => r.views < 1000),
      neverRead: cnt(r => r.views === 0), about: cnt(r => r.about), medianBytes: median(rows.map(r => r.bytes))
    },
    buckets: [['Never read', cnt(r => r.views === 0)], ['1 to 99', cnt(r => r.views > 0 && r.views < 100)],
      ['100 to 999', cnt(r => r.views >= 100 && r.views < 1000)], ['1,000 to 9,999', cnt(r => r.views >= 1000 && r.views < 10000)],
      ['10,000 or more', cnt(r => r.views >= 10000)]],
    // same arithmetic as the snapshot (uganda-gap build_luganda_excel.py): with English article; with Wikidata minus those; without Wikidata
    connections: [['Wikidata item and English article', cnt(r => r.en)], ['Wikidata item only', cnt(r => r.qid) - cnt(r => r.en)], ['No Wikidata item', n - cnt(r => r.qid)]],
    sizes: [['Under 1,000 bytes', cnt(r => r.bytes < 1000)], ['1,000 to 4,999', cnt(r => r.bytes >= 1000 && r.bytes < 5000)],
      ['5,000 to 19,999', cnt(r => r.bytes >= 5000 && r.bytes < 20000)], ['20,000 or more', cnt(r => r.bytes >= 20000)]],
    top: rows.slice(0, 15).map(r => [r.title, r.label || null, r.views, r.created, r.edits])
  };
}
function table(rows) {
  const col = f => rows.map(f);
  return {
    n: rows.length, meta: META,
    cols: [col(r => r.title), col(r => r.label || null), col(r => r.views), col(r => r.created), col(r => r.edits),
      ...YEARS.map(y => col(r => r.y[y] || 0)), col(r => r.bytes), col(r => r.qid || null), col(r => r.en || null), col(r => r.about ? 1 : 0)]
  };
}
export { derive, table };

if (!process.env.LIVE_LUGANDA_NO_MAIN) await main();

async function main() {
  const t0 = Date.now();
  // the snapshot the dashboard was built from
  const snapCols = rd(join(root, 't/luganda.articles.0.json'));
  const snap = new Map(); snapCols[0].forEach((t, i) => snap.set(t, i));
  const englishSet = new Set(rd(join(root, 't/english.articles.0.json'))[0]);
  const prevState = existsSync(join(outDir, 'luganda-state.json')) ? rd(join(outDir, 'luganda-state.json')) : null;
  const state = { through: null, mtdDate: null, views: {}, mtd: {}, hist: {} };
  if (prevState) Object.assign(state, prevState);

  const now = new Date();
  const endMonthly = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)));   // last day of the previous month
  const monthStart = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const yesterday = ymd(new Date(now.getTime() - 864e5));
  const hasMtd = now.getUTCDate() > 1;

  console.log('listing pages…');
  const all = await listPages();
  console.log(all.length, 'content pages');
  const info = await details(all);
  const qidOf = new Map(); for (const [t, v] of info) if (v.qid) qidOf.set(t, v.qid);
  const wd = await wikidata([...new Set(qidOf.values())]);
  // the front page is not an article
  const titles = all.filter(t => info.has(t) && info.get(t).qid !== MAIN_PAGE);
  console.log(titles.length, 'articles after the filter');

  // pages new since the snapshot go first and always get measured, whatever the time budget says
  const fresh = titles.filter(t => !snap.has(t));
  const today = ymd(now);
  const save = () => writeFileSync(join(outDir, 'luganda-state.json'), JSON.stringify(state));
  if (state.viewsMonth !== endMonthly) { state.views = {}; state.viewsMonth = endMonthly; }
  const freshDone = new Set();
  console.log(fresh.length, 'pages are new since the snapshot');
  await pool(fresh, 4, async t => {
    try {
      if (!state.views[t]) state.views[t] = await measureMonths(t, endMonthly);
      if (hasMtd && (state.mtdDate !== yesterday || !(t in state.mtd))) state.mtd[t] = await measureDays(t, monthStart, yesterday);
      freshDone.add(t);
      if (!state.hist[t] || state.hist[t].day !== today) state.hist[t] = Object.assign(await history(t), { day: today });
    } catch (e) { errors.push('new page ' + t + ': ' + e.message); }
  }, null, true);

  // views: complete months (all pages when a new month is out, otherwise only pages not measured yet) ...
  const needMonths = titles.filter(t => !state.views[t]);
  console.log('monthly views for', needMonths.length, 'pages');
  let failed = 0;
  const doneM = await pool(needMonths, 8, async t => { try { state.views[t] = await measureMonths(t, endMonthly); } catch (e) { failed++; } }, save);
  const monthsComplete = !failed && doneM === needMonths.length;
  if (monthsComplete) state.through = endMonthly;
  save();
  // ... and this month so far (all pages once a day, new pages at once)
  const needMtd = hasMtd ? titles.filter(t => !freshDone.has(t) && (state.mtdDate !== yesterday || !(t in state.mtd))) : [];
  if (!hasMtd) { state.mtd = {}; state.mtdDate = null; }
  console.log('month-to-date views for', needMtd.length, 'pages');
  let failedMtd = 0;
  const doneD = await pool(needMtd, 8, async t => { try { state.mtd[t] = await measureDays(t, monthStart, yesterday); } catch (e) { failedMtd++; } }, save);
  if (hasMtd && !failedMtd && doneD === needMtd.length) state.mtdDate = yesterday;
  const partial = !monthsComplete || (hasMtd && state.mtdDate !== yesterday);
  if (partial) errors.push(`views not fully re-measured yet (${failed + failedMtd} failed requests, time budget ${Math.round(BUDGET_MS / 60000)} min): pages still waiting use the September snapshot's views until the next run`);

  // assemble the rows
  const curYear = String(now.getUTCFullYear());
  const rows = titles.map(t => {
    const i = snap.get(t), d = info.get(t), q = d.qid, w = (q && wd.get(q)) || { en: '', label: '' };
    let y;
    if (state.views[t]) { y = Object.assign({}, state.views[t]); if (state.mtd[t]) y[curYear] = (y[curYear] || 0) + state.mtd[t]; }
    else if (i !== undefined) y = Object.fromEntries(YEARS.map((yr, k) => [yr, snapCols[5 + k][i]]));   // not re-measured yet: the snapshot's views
    else y = {};
    const views = Object.values(y).reduce((s, v) => s + v, 0);
    const known = i !== undefined;
    const h = state.hist[t] || {};
    return {
      title: t, label: w.label || (known ? snapCols[1][i] : '') || '', views, y,
      created: known ? snapCols[3][i] : (h.created ?? null), edits: known ? snapCols[4][i] : (h.edits ?? null),
      bytes: d.bytes, qid: q, en: w.en,
      about: known ? snapCols[20][i] === 1 : !!(w.en && englishSet.has(w.en)),
      isNew: !known
    };
  });
  const gone = [...snap.keys()].filter(t => !info.has(t) || info.get(t).qid === MAIN_PAGE).length;
  const d = derive(rows);
  const live = {
    generated: now.toISOString(), viewsThrough: endMonthly, mtdThrough: hasMtd && state.mtdDate === yesterday ? yesterday : null,
    viewsComplete: !partial, viewsMeasured: Object.keys(state.views).length,
    baseline: { articles: snapCols[0].length, views: snapCols[2].reduce((s, v) => s + v, 0), through: '2026-09-30' },
    newCount: rows.filter(r => r.isNew).length, goneCount: gone,
    newest: rows.filter(r => r.isNew).sort((a, b) => (b.created || 0) - (a.created || 0) || b.views - a.views).slice(0, 12)
      .map(r => ({ title: r.title, label: r.label, created: r.created, bytes: r.bytes, views: r.views, about: r.about })),
    ...d,
    tables: {
      'luganda.articles': table(rows),
      'luganda.no-english-article': table(rows.filter(r => r.qid && !r.en)),
      'luganda.no-wikidata-item': table(rows.filter(r => !r.qid)),
      'luganda.never-read': table(rows.filter(r => r.views === 0))
    },
    errors
  };
  const write = (name, obj) => { const f = join(outDir, name); writeFileSync(f + '.tmp', JSON.stringify(obj)); renameSync(f + '.tmp', f); };
  write('luganda-state.json', state);
  write('luganda-live.json', live);
  console.log('done in', Math.round((Date.now() - t0) / 1000), 's:', JSON.stringify(d.kpis), 'new', live.newCount, 'gone', gone);
}
