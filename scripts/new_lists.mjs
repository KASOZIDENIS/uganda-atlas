// Builds fresh task lists from the LIVE wikis, so the editathon never runs dry.
//   node scripts/new_lists.mjs [lg|nyn|en]     (no argument = all three)
// Writes editathon/tasks/<id>.0.json and adds the lists to editathon/tasks/index.json.
// Lists made:
//   lg-more-images        Luganda pages with no image, where Commons already has one (Wikidata P18, or the English article's free lead image)
//   lg-more-category      Luganda pages with no image, where Commons has a category to choose from (P373 / Commons sitelink)
//   nyn-more-images       same for Runyankore pages on the Incubator (matched to English through the old lists, or the same title)
//   nyn-more-category     same, category only
//   en-no-image-infobox   Uganda-related English articles with no lead image AND no infobox
// Items already on an older list are left out, so nothing is listed twice.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => JSON.parse(readFileSync(join(root, p), 'utf-8'));
const UA = { 'User-Agent': 'UgandaAtlasEditathon/1.0 (https://kasozidenis.github.io/uganda-atlas/; wikimedia community user group uganda)' };
const API = { en: 'https://en.wikipedia.org/w/api.php', lg: 'https://lg.wikipedia.org/w/api.php', inc: 'https://incubator.wikimedia.org/w/api.php', wd: 'https://www.wikidata.org/w/api.php' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LG_BOIL = new Set(['File:Arbcom ru editing.svg', 'File:Georgia in United States.svg', 'File:Kentucky counties map.png', 'File:Puzzle-W-glossy.svg', 'File:Texas in United States.svg']);
const NYN_BOIL = new Set(['File:OOjs UI icon edit-ltr.svg']);

async function api(base, params) {
  const q = new URLSearchParams(Object.assign({ format: 'json', formatversion: '2' }, params));
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(base + '?' + q, { headers: UA });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === 5) throw e; await sleep(1000 * (i + 1)); }
  }
}
// run a titles query in batches of 50, following continuation
async function batched(base, items, params, onPage) {
  for (let i = 0; i < items.length; i += 50) {
    let cont = {};
    for (let k = 0; k < 40; k++) {
      const j = await api(base, Object.assign({ action: 'query', titles: items.slice(i, i + 50).join('|') }, params, cont));
      for (const p of (j.query.pages || [])) onPage(p);
      if (!j.continue) break; cont = j.continue;
    }
    await sleep(120);
    if ((i / 50) % 20 === 0) process.stdout.write('.');
  }
  console.log();
}
async function allPages(base, extra) {
  const out = []; let cont = {};
  for (let k = 0; k < 200; k++) {
    const j = await api(base, Object.assign({ action: 'query', list: 'allpages', apnamespace: '0', apfilterredir: 'nonredirects', aplimit: '500' }, extra, cont));
    out.push(...j.query.allpages.map(p => p.title));
    if (!j.continue) break; cont = j.continue; await sleep(100);
  }
  return out;
}
const oldRows = id => { const out = []; for (let n = 0; ; n++) { try { out.push(...rd(`editathon/tasks/${id}.${n}.json`)); } catch (e) { break; } } return out; };

async function wikidataFacts(qids) {   // qid -> { p18, cat, en }
  const m = new Map();
  for (let i = 0; i < qids.length; i += 50) {
    const j = await api(API.wd, { action: 'wbgetentities', ids: qids.slice(i, i + 50).join('|'), props: 'claims|sitelinks', sitefilter: 'enwiki|commonswiki' });
    for (const [q, e] of Object.entries(j.entities || {})) {
      if (e.missing !== undefined) continue;
      const c = e.claims || {}, v = x => x && x[0] && x[0].mainsnak && x[0].mainsnak.datavalue && x[0].mainsnak.datavalue.value;
      const cs = e.sitelinks && e.sitelinks.commonswiki && e.sitelinks.commonswiki.title;
      m.set(q, { p18: v(c.P18) || '', cat: v(c.P373) || (cs && /^Category:/.test(cs) ? cs.slice(9) : ''), en: (e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title) || '' });
    }
    await sleep(120);
  }
  return m;
}
async function enLeadImages(titles) {   // English title -> free lead image file
  const m = new Map();
  await batched(API.en, titles, { prop: 'pageprops', ppprop: 'page_image_free', redirects: '1' }, p => {
    if (p.pageprops && p.pageprops.page_image_free) m.set(p.title, 'File:' + p.pageprops.page_image_free.replace(/_/g, ' '));
  });
  return m;
}

const existing = {
  lg: new Set([...oldRows('lg-image-exists'), ...oldRows('lg-capture')].map(r => r[0])),
  nyn: new Set([...oldRows('nyn-image-exists'), ...oldRows('nyn-capture')].map(r => r[0])),
  en: new Set([...oldRows('en-image-exists'), ...oldRows('en-pick-category'), ...oldRows('en-capture')].map(r => r[0])),
};
const strip = f => String(f || '').replace(/^(File|Image):/i, '').replace(/_/g, ' ');

// ---------- Luganda ----------
async function luganda() {
  console.log('Luganda: listing pages');
  const titles = await allPages(API.lg, {});
  console.log(titles.length, 'pages; checking images');
  const info = new Map();
  await batched(API.lg, titles, { prop: 'images|pageprops', imlimit: 'max', ppprop: 'wikibase_item' }, p => {
    const e = info.get(p.title) || { imgs: 0, qid: '' };
    e.imgs += (p.images || []).filter(x => !LG_BOIL.has(x.title)).length;
    if (p.pageprops && p.pageprops.wikibase_item) e.qid = p.pageprops.wikibase_item;
    info.set(p.title, e);
  });
  const bare = [...info].filter(([, e]) => !e.imgs && e.qid);
  console.log(bare.length, 'pages with no image and a Wikidata item; reading Wikidata');
  const wd = await wikidataFacts([...new Set(bare.map(([, e]) => e.qid))]);
  const needLead = [...new Set(bare.map(([, e]) => { const f = wd.get(e.qid); return f && !f.p18 && f.en ? f.en : ''; }).filter(Boolean))];
  console.log(needLead.length, 'English articles to check for a lead image');
  const lead = await enLeadImages(needLead);
  const images = [], cats = [];
  for (const [t, e] of bare) {
    const f = wd.get(e.qid); if (!f) continue;
    const img = f.p18 ? 'File:' + f.p18 : (f.en && lead.get(f.en)) || '';
    if (img) images.push([t, strip(img), f.en || 'N/A', e.qid]);
    else if (f.cat) cats.push([t, f.cat, f.en || 'N/A', e.qid]);
  }
  const fresh = rows => rows.filter(r => !existing.lg.has(r[0]));
  return { images: fresh(images), cats: fresh(cats), allImages: images.length, allCats: cats.length };
}

// ---------- Runyankore (Incubator) ----------
async function runyankore() {
  console.log('Runyankore: listing pages');
  const titles = (await allPages(API.inc, { apprefix: 'Wp/nyn/' })).map(t => t.replace(/^Wp\/nyn\//, ''));
  console.log(titles.length, 'pages');
  const eng = new Map([...oldRows('nyn-image-exists'), ...oldRows('nyn-capture')].map(r => [r[0], r[r.length - 1] && r[r.length - 1] !== 'N/A' ? r[r.length - 1] : '']));
  const withImage = new Set();
  await batched(API.inc, titles.map(t => 'Wp/nyn/' + t), { prop: 'images', imlimit: 'max' }, p => {
    if ((p.images || []).some(x => !NYN_BOIL.has(x.title))) withImage.add(p.title.replace(/^Wp\/nyn\//, ''));
  });
  const bare = titles.filter(t => !withImage.has(t));
  console.log(bare.length, 'with no image');
  const guess = bare.filter(t => !eng.get(t));
  const exists = new Set();
  await batched(API.en, guess, { redirects: '1' }, p => { if (!p.missing) exists.add(p.title); });
  const en = t => eng.get(t) || (exists.has(t) ? t : '');
  const needEn = [...new Set(bare.map(en).filter(Boolean))];
  const lead = await enLeadImages(needEn);
  const qids = new Map();
  await batched(API.en, needEn, { prop: 'pageprops', ppprop: 'wikibase_item', redirects: '1' }, p => { if (p.pageprops && p.pageprops.wikibase_item) qids.set(p.title, p.pageprops.wikibase_item); });
  const wd = await wikidataFacts([...new Set(qids.values())]);
  const images = [], cats = [];
  for (const t of bare) {
    const e = en(t); if (!e) continue;
    const f = wd.get(qids.get(e)) || {};
    const img = f.p18 ? 'File:' + f.p18 : lead.get(e) || '';
    if (img) images.push([t, strip(img), e]); else if (f.cat) cats.push([t, f.cat, e]);
  }
  const fresh = rows => rows.filter(r => !existing.nyn.has(r[0]));
  return { images: fresh(images), cats: fresh(cats), allImages: images.length, allCats: cats.length };
}

// ---------- English: no lead image and no infobox ----------
async function english() {
  const pool = [...new Set(rd('t/english.articles.0.json')[0])];
  console.log('English: checking', pool.length, 'Uganda-related articles');
  const st = new Map();
  await batched(API.en, pool, { prop: 'pageprops|templates', ppprop: 'page_image|disambiguation', tlnamespace: '10', tllimit: 'max', redirects: '1' }, p => {
    if (p.missing) return;
    const e = st.get(p.title) || { img: false, box: false, dab: false };
    if (p.pageprops && p.pageprops.page_image) e.img = true;
    if (p.pageprops && p.pageprops.disambiguation !== undefined) e.dab = true;
    if ((p.templates || []).some(x => /^Template:(Infobox|Taxobox|Speciesbox|Automatic taxobox|Subspeciesbox|Infraspeciesbox)/i.test(x.title))) e.box = true;
    st.set(p.title, e);
  });
  const rows = [...st].filter(([t, e]) => !e.img && !e.box && !e.dab && !/^(List of|Lists of|Index of|Outline of|Timeline of)/.test(t)).map(([t]) => [t]);
  return { rows, all: [...st].filter(([, e]) => !e.img && !e.box && !e.dab).length };
}

const index = rd('editathon/tasks/index.json');
const put = (id, name, wiki, kind, cols, rows) => {
  writeFileSync(join(root, 'editathon', 'tasks', id + '.0.json'), JSON.stringify(rows), 'utf-8');
  const entry = { id, name, wiki, kind, count: rows.length, chunks: 1, cols };
  const k = index.lists.findIndex(l => l.id === id);
  if (k >= 0) index.lists[k] = entry; else index.lists.push(entry);
  console.log('wrote', id, rows.length);
};
const only = process.argv[2];
const lg = !only || only === 'lg' ? await luganda() : null;
const ny = !only || only === 'nyn' ? await runyankore() : null;
const en = !only || only === 'en' ? await english() : null;
if (lg) {
  console.log('lg: open on the live wiki', lg.allImages, 'with image,', lg.allCats, 'category only; not on an older list:', lg.images.length, lg.cats.length);
  put('lg-more-images', 'Luganda Wikipedia: Commons has an image, page has none (new)', 'lgwiki', 'image-exists', ['Image to add', 'English article', 'Wikidata item'], lg.images);
  put('lg-more-category', 'Luganda Wikipedia: pick an image from Commons (new)', 'lgwiki', 'pick-category', ['Commons category', 'English article', 'Wikidata item'], lg.cats);
}
if (ny) {
  console.log('nyn: open on the live wiki', ny.allImages, 'with image,', ny.allCats, 'category only; not on an older list:', ny.images.length, ny.cats.length);
  put('nyn-more-images', 'Runyankore (Incubator): Commons has an image, page has none (new)', 'incubatorwiki', 'image-exists', ['Image to add', 'English article'], ny.images);
  put('nyn-more-category', 'Runyankore (Incubator): pick an image from Commons (new)', 'incubatorwiki', 'pick-category', ['Commons category', 'English article'], ny.cats);
}
if (en) {
  console.log('en: no image and no infobox', en.all, '; not on an older list:', en.rows.length);
  put('en-no-image-infobox', 'English Wikipedia: no lead image and no infobox (new)', 'enwiki', 'image-infobox', [], en.rows);
}
index.lists = index.lists.filter(l => l.count > 0);
writeFileSync(join(root, 'editathon', 'tasks', 'index.json'), JSON.stringify(index), 'utf-8');
