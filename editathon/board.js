// The editathon leaderboard: one implementation, used by the page in the browser
// and by the scheduled job in Node (scripts/leaderboard.mjs).
//
// It reads the edits of the signed-up participants from the Wikimedia APIs
// (list=usercontribs, up to 50 users per call) for the editathon window, gives
// each edit its points, and counts which task-list items were worked on.

const FILE_CATEGORY_RE = /^File:/;
const LABEL_CTX = /wbsetlabel-add|wbsetlabeldescriptionaliases-add|wbeditentity-create/;
const DESC_CTX = /wbsetdescription-add/;
const SITELINK_CTX = /wbsetsitelink-add|wbsetsitelink-set|clientsitelink-update|wblinktitles/;
const INFOBOX_RE = /infobox/i;
const DATABOX_RE = /databox/i;
const ARTICLE_IMAGE_RE = /\b(image|photo|picture|thumb|File:)|\[\[\s*(File|Image|Fayiro|Ekifaananyi)\s*:/i;
const IMAGE_CTX = /wbcreateclaim|wbsetclaim|wbeditentity|wbsetreference|wbsetclaimvalue/;
const P18_RE = /\bP18\b/;
const QID_RE = /^Q\d+$/;


// Who takes part: the people enrolled on the Outreach Dashboard programme (public list), plus anyone added by hand
// in participants.json. Both can be used together; a username is listed once.
export async function getParticipants(config, fetchFn, manual = []) {
  const map = new Map(); let fromDashboard = 0, error = null;
  const src = config.participantsSource;
  if (src && src.url) {
    try {
      const r = await fetchFn(src.url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      for (const u of (j.course && j.course.users) || []) {
        if ((src.roles || [0]).includes(u.role) && u.username) {
          const k = cleanUser(u.username).toLowerCase();
          if (!map.has(k)) { map.set(k, { user: cleanUser(u.username), team: '' }); fromDashboard++; }
        }
      }
    } catch (e) { error = 'dashboard: ' + e.message; }
  }
  for (const m of manual) {
    const name = cleanUser(m.user); if (!name) continue;
    const k = name.toLowerCase();
    map.set(k, { user: name, team: m.team || (map.get(k) || {}).team || '' });
  }
  return { users: [...map.values()], fromDashboard, error };
}

export function windowState(config, now = new Date()) {
  const s = new Date(config.start), e = new Date(config.end);
  return now < s ? 'upcoming' : now > e ? 'ended' : 'live';
}

export function cleanUser(u) {
  return String(u || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

// Give one contribution its kinds and points. `ctx.titleMap[wiki]` maps a page
// title to the task list it belongs to; `ctx.qidList` maps item ids to lists.
export function classify(wiki, c, config, ctx) {
  const P = config.points;
  const out = { kinds: [], points: 0, list: null, item: null };
  const tags = c.tags || [];
  // Undone edits earn nothing: the edit that was reverted (mw-reverted), and the revert/undo/rollback edit itself.
  // Deleted pages, items and files never appear in list=usercontribs, so deleted work is already excluded.
  if (tags.some(t => t === 'mw-reverted' || t === 'mw-undo' || t === 'mw-rollback' || t === 'mw-manual-revert')) return null;
  const title = c.title || '';
  // only content counts: articles and items everywhere, files and categories on Commons (not talk or user pages)
  const okNs = wiki === 'commonswiki' ? (c.ns === 6 || c.ns === 14) : c.ns === 0;
  if (!okNs) return null;
  if (wiki === 'incubatorwiki' && !title.startsWith('Wp/nyn/')) return null;
  const comment = c.comment || '';

  if (wiki === 'commonswiki') {
    if (c.ns === 6 && c.new) { out.kinds.push('upload'); out.points += P.upload; }
  } else if (wiki === 'wikidatawiki') {
    if (c.ns !== 0 || !QID_RE.test(title)) return null;
    out.item = title;
    if (comment.startsWith('/* wb') && LABEL_CTX.test(comment) && /\|[a-z-]+ \*\//.test(comment)) {
      out.kinds.push('label');   // labels earn no points (they are nearly the same in every language); still tracked for the task list
      if (/\|lg \*\//.test(comment)) out.list = 'wd-no-luganda';
    }
    if (comment.startsWith('/* wb') && DESC_CTX.test(comment) && /\|lg \*\//.test(comment)) {
      out.kinds.push('description'); out.labelDesc = true;
    }
    if (SITELINK_CTX.test(comment)) { out.kinds.push('sitelink'); out.points += P.sitelink; }
    if (comment.startsWith('/* wb') && IMAGE_CTX.test(comment) && P18_RE.test(comment)) {
      out.kinds.push('image'); out.points += P.wikidata_image;
      out.list = (ctx.qidList && ctx.qidList.get(title)) || 'wd-capture';
    }
  } else {
    const map = ctx.titleMap[wiki];
    const list = map && map.get(title);
    if (list) { out.kinds.push('task'); out.list = list; out.item = title; }
    // article work, recognised from the edit summary
    if (INFOBOX_RE.test(comment)) { out.kinds.push('infobox'); out.points += P.infobox; }
    if (DATABOX_RE.test(comment)) { out.kinds.push('databox'); out.points += P.databox; }
    if (ARTICLE_IMAGE_RE.test(comment) && !INFOBOX_RE.test(comment)) { out.kinds.push('article_image'); out.points += P.article_image; }
  }
  return out;
}

async function api(url, params, fetchFn, tries = 4) {
  const q = new URLSearchParams(Object.assign({ format: 'json', formatversion: '2', origin: '*' }, params));
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchFn(url + '?' + q.toString());
      if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(res => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw new Error('gave up after ' + tries + ' tries (rate limited or server error)');
}

// every contribution of `users` to one wiki inside the window
export async function fetchContribs(wiki, cfg, users, startISO, endISO, fetchFn) {
  const rows = [];
  for (let i = 0; i < users.length; i += 50) {
    const group = users.slice(i, i + 50);
    let cont = {};
    for (let page = 0; page < 200; page++) {
      const j = await api(cfg.api, Object.assign({
        action: 'query', list: 'usercontribs', ucuser: group.join('|'), ucstart: endISO, ucend: startISO,
        uclimit: '500', ucdir: 'older', ucprop: 'ids|title|timestamp|comment|flags|tags'
      }, cont), fetchFn);
      for (const c of (j.query && j.query.usercontribs) || []) rows.push(Object.assign({ wiki }, c));
      if (!j.continue) break;
      cont = j.continue;
    }
  }
  return rows;
}

// Finds edits that no longer stand. Returns Map('wiki:revid' -> reason). Reasons:
//   deleted   - the page, item or file is gone, or that revision was deleted
//   reverted  - MediaWiki tagged it mw-reverted, or a later revision brought the page back to exactly the
//               content it had before the edit (catches manual reverts and undos that carry no tag)
// Step 1 looks up all the edits' revisions 50 at a time (existence + tags). Step 2 only reads a page's
// history when someone else has edited the page since. A lookup that fails is reported in `errors` and
// that edit is left counted.
export async function findDead(contribs, config, fetchFn, errors = []) {
  const dead = new Map();
  const pool = async (jobs, fn, n = 3) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) await fn(jobs[i++]); })); };
  const byWiki = new Map();
  for (const c of contribs) { if (!byWiki.has(c.wiki)) byWiki.set(c.wiki, []); byWiki.get(c.wiki).push(c); }
  const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

  for (const [wiki, list] of byWiki) {
    const cfg = config.wikis[wiki];
    const sha = new Map(); // revid -> sha1 of every revision we saw
    // Step 1: do the revisions still exist, and are they tagged as reverted?
    await pool(chunks(list, 50), async group => {
      try {
        const j = await api(cfg.api, { action: 'query', prop: 'revisions', revids: group.map(c => c.revid).join('|'), rvprop: 'ids|tags|sha1' }, fetchFn);
        const live = new Map();
        for (const pg of (j.query && j.query.pages) || []) for (const r of pg.revisions || []) live.set(r.revid, r);
        for (const c of group) {
          const r = live.get(c.revid), key = wiki + ':' + c.revid;
          if (!r) dead.set(key, 'deleted');
          else if ((r.tags || []).includes('mw-reverted')) dead.set(key, 'reverted');
          else if (r.sha1) sha.set(c.revid, r.sha1);
        }
      } catch (e) { errors.push('verify ' + wiki + ': ' + e.message); }
    });
    // Step 2: pages edited by someone else afterwards may have been put back to how they were before
    const pages = new Map();
    for (const c of list) if (!dead.has(wiki + ':' + c.revid)) { if (!pages.has(c.pageid)) pages.set(c.pageid, []); pages.get(c.pageid).push(c); }
    const latest = new Map();
    await pool(chunks([...pages.keys()], 50), async ids => {
      try {
        const j = await api(cfg.api, { action: 'query', prop: 'revisions', pageids: ids.join('|'), rvprop: 'ids' }, fetchFn);
        for (const pg of (j.query && j.query.pages) || []) {
          if (pg.missing) for (const c of pages.get(pg.pageid) || []) dead.set(wiki + ':' + c.revid, 'deleted');
          else if (pg.revisions && pg.revisions[0]) latest.set(pg.pageid, pg.revisions[0].revid);
        }
      } catch (e) { errors.push('verify ' + wiki + ': ' + e.message); }
    });
    const todo = [...pages.entries()].filter(([id, g]) => latest.has(id) && latest.get(id) > Math.max(...g.map(c => c.revid)));
    await pool(todo, async ([id, group]) => {
      try {
        const startId = Math.min(...group.map(c => c.parentid || c.revid));
        const revs = []; let cont = {};
        for (let p = 0; p < 20; p++) {
          const j = await api(cfg.api, Object.assign({ action: 'query', prop: 'revisions', pageids: String(id), rvprop: 'ids|sha1|tags',
            rvlimit: '500', rvdir: 'newer', rvstartid: String(startId) }, cont), fetchFn);
          const pg = j.query && j.query.pages && j.query.pages[0];
          revs.push(...((pg && pg.revisions) || []));
          if (!j.continue) break;
          cont = j.continue;
        }
        for (const c of group) {
          const i = revs.findIndex(r => r.revid === c.revid);
          if (i < 0) continue;
          const before = c.parentid ? revs.find(r => r.revid === c.parentid) : null;
          if (before && before.sha1 && revs.slice(i + 1).some(r => r.sha1 === before.sha1)) dead.set(wiki + ':' + c.revid, 'reverted');
        }
      } catch (e) { errors.push('verify ' + wiki + ' page ' + id + ': ' + e.message); }
    }, 2);
  }
  return dead;
}

export async function computeBoard({ config, users, ctx, fetchFn, now = new Date(), verify = false }) {
  const state = windowState(config, now);
  const names = users.map(u => cleanUser(u.user)).filter(Boolean);
  const board = {
    showWinners: config.showWinners !== false,
    generated: now.toISOString(), state, start: config.start, end: config.end,
    users: [], totals: {}, progress: { lists: {} }, feed: [], errors: []
  };
  const byUser = new Map(names.map(n => [n.toLowerCase(), {
    user: n, team: (users.find(u => cleanUser(u.user).toLowerCase() === n.toLowerCase()) || {}).team || '',
    points: 0, edits: 0, byWiki: {}, pointsByWiki: {}, lastByWiki: {}, mix: {}, tasks: 0, uploads: 0, labels: 0, images: 0, descriptions: 0, infoboxes: 0, databoxes: 0, articleImages: 0, sitelinks: 0, last: null
  }]));
  if (state === 'upcoming' || !names.length) return finish(board, byUser, config, ctx, new Map());

  const endISO = (now < new Date(config.end) ? now : new Date(config.end)).toISOString();
  const wikis = Object.entries(config.wikis);
  const results = await Promise.all(wikis.map(async ([wiki, cfg]) => {
    try { return await fetchContribs(wiki, cfg, names, config.start, endISO, fetchFn); }
    catch (e) { board.errors.push(wiki + ': ' + e.message); return []; }
  }));

  const seen = new Set(), items = new Map(); // list -> Set(items)
  const feed = [];
  let cands = [];
  for (const c of results.flat()) {
    const key = c.wiki + ':' + c.revid;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = byUser.get(cleanUser(c.user).toLowerCase());
    if (!u) continue;
    const k = classify(c.wiki, c, config, ctx);
    if (!k) continue;
    cands.push({ c, u, k });
  }
  // Optional, slower check used for prize decisions: drop edits that are no longer live (see findDead).
  if (verify) {
    const dead = await findDead(cands.map(x => x.c), config, fetchFn, board.errors);
    board.dropped = [];
    cands = cands.filter(x => {
      const why = dead.get(x.c.wiki + ':' + x.c.revid);
      if (why) board.dropped.push({ wiki: x.c.wiki, user: x.u.user, title: x.c.title, revid: x.c.revid, points: x.k.points, why });
      return !why;
    });
  }
  // Wikidata Luganda description on an item, in one edit or several: one award of 2 points per person per item
  const labelDescDone = new Set();
  for (const { c, u, k } of cands) {
    let pts = k.points, descAward = 0;
    if (k.labelDesc) {
      const key = u.user.toLowerCase() + '|' + k.item;
      if (!labelDescDone.has(key)) { labelDescDone.add(key); descAward = config.points.wikidata_description; pts += descAward; }
    }
    // what the points came from, per project (shown on the "Who is winning" tab)
    for (const kind of k.kinds) {
      const p = kind === 'description' ? descAward : (KIND_POINTS[kind] ? config.points[KIND_POINTS[kind]] : 0);
      if (!p) continue;
      const m = ((u.mix[c.wiki] = u.mix[c.wiki] || {})[kind] = u.mix[c.wiki][kind] || { n: 0, pts: 0 });
      m.n++; m.pts += p;
    }
    u.points += pts; u.edits++;
    u.byWiki[c.wiki] = (u.byWiki[c.wiki] || 0) + 1;
    u.pointsByWiki[c.wiki] = (u.pointsByWiki[c.wiki] || 0) + pts;
    if (pts && (!u.lastByWiki[c.wiki] || c.timestamp > u.lastByWiki[c.wiki])) u.lastByWiki[c.wiki] = c.timestamp;
    if (k.kinds.includes('upload')) u.uploads++;
    if (k.kinds.includes('label')) u.labels++;
    if (k.kinds.includes('image')) u.images++;
    if (k.kinds.includes('task')) u.tasks++;
    if (k.kinds.includes('description')) u.descriptions++;
    if (k.kinds.includes('infobox')) u.infoboxes++;
    if (k.kinds.includes('databox')) u.databoxes++;
    if (k.kinds.includes('article_image')) u.articleImages++;
    if (k.kinds.includes('sitelink')) u.sitelinks++;
    if (!u.last || c.timestamp > u.last) u.last = c.timestamp;
    if (k.list && k.item) {
      if (!items.has(k.list)) items.set(k.list, new Set());
      items.get(k.list).add(k.item);
    }
    feed.push({ wiki: c.wiki, user: u.user, title: c.title, ts: c.timestamp, kind: k.kinds[0] || 'edit', points: pts,
                comment: (c.comment || '').slice(0, 140), revid: c.revid });
  }
  feed.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  board.feed = feed.slice(0, 80);
  return finish(board, byUser, config, ctx, items);
}

function finish(board, byUser, config, ctx, items) {
  board.users = [...byUser.values()].sort((a, b) => b.points - a.points || b.edits - a.edits || a.user.localeCompare(b.user));
  let rank = 0, prev = null, n = 0;
  for (const u of board.users) {
    n++;
    if (u.points !== prev) { rank = n; prev = u.points; }
    u.rank = u.points ? rank : null;
  }
  const t = { participants: board.users.length, active: 0, edits: 0, points: 0, uploads: 0, labels: 0, descriptions: 0, images: 0, tasks: 0, infoboxes: 0, databoxes: 0, articleImages: 0, sitelinks: 0, byWiki: {} };
  for (const u of board.users) {
    if (u.edits) t.active++;
    t.edits += u.edits; t.points += u.points; t.uploads += u.uploads; t.labels += u.labels; t.images += u.images; t.tasks += u.tasks;
    t.descriptions += u.descriptions; t.infoboxes += u.infoboxes; t.databoxes += u.databoxes; t.articleImages += u.articleImages; t.sitelinks += u.sitelinks;
    for (const [w, n] of Object.entries(u.byWiki)) t.byWiki[w] = (t.byWiki[w] || 0) + n;
  }
  board.totals = t;
  board.projects = rankProjects(board.users, config);
  for (const l of (ctx.lists || [])) {
    board.progress.lists[l.id] = { done: items.has(l.id) ? items.get(l.id).size : 0, total: l.count };
  }
  return board;
}

// One prize per project. Ranks everyone by the points earned on that project alone.
// Tie-break: whoever reached the points first (earlier last counted edit) ranks higher.
const KIND_POINTS = { upload: 'upload', image: 'wikidata_image', article_image: 'article_image', infobox: 'infobox', databox: 'databox', sitelink: 'sitelink' };
export const PROJECT_ORDER = ['enwiki', 'commonswiki', 'wikidatawiki', 'lgwiki', 'incubatorwiki'];
export function rankProjects(users, config) {
  const out = {};
  for (const wiki of PROJECT_ORDER) {
    if (!config.wikis[wiki]) continue;
    const rows = users.filter(u => (u.pointsByWiki[wiki] || 0) > 0)
      .map(u => ({ user: u.user, team: u.team, points: u.pointsByWiki[wiki], edits: u.byWiki[wiki] || 0, reached: u.lastByWiki[wiki], mix: u.mix[wiki] || {} }))
      .sort((a, b) => b.points - a.points || (a.reached < b.reached ? -1 : a.reached > b.reached ? 1 : 0) || a.user.localeCompare(b.user));
    rows.forEach((r, i) => { r.rank = i + 1; });
    out[wiki] = { label: config.wikis[wiki].label, prize: (config.prizes || {})[wiki] || null, winner: rows[0] || null, ranking: rows };
  }
  return out;
}

// The sets the classifier needs from the task lists (small lists only)
export function buildContext(index, loaded) {
  const titleMap = { enwiki: new Map(), lgwiki: new Map(), incubatorwiki: new Map() };
  const qidList = new Map();
  for (const l of index.lists) {
    const rows = loaded[l.id] || [];
    if (titleMap[l.wiki]) {
      for (const r of rows) titleMap[l.wiki].set(l.wiki === 'incubatorwiki' ? 'Wp/nyn/' + r[0] : r[0], l.id);
    } else if (l.id === 'wd-image-exists') {
      for (const r of rows) qidList.set(r[0], l.id);
    }
  }
  return { titleMap, qidList, lists: index.lists };
}

export const SMALL_LISTS = ['en-image-exists', 'en-pick-category', 'en-capture', 'lg-image-exists', 'lg-capture',
  'nyn-image-exists', 'nyn-capture', 'wd-image-exists'];

// The version everyone may see: group totals, task-list progress and (unless showWinners is false) the top five
// per project with what their points are made of. Everything else per person stays private.
export function publicBoard(board) {
  const t = Object.assign({}, board.totals); delete t.points;
  const out = { generated: board.generated, state: board.state, start: board.start, end: board.end,
           public: true, totals: t, progress: board.progress, errors: board.errors };
  // The "Who is winning" tab: top five per project and what their points are made of (switch off with showWinners:false in config.json)
  if (board.showWinners !== false && board.projects) {
    out.winners = {};
    for (const [w, p] of Object.entries(board.projects)) {
      out.winners[w] = { label: p.label, total: p.ranking.length,
        top: p.ranking.slice(0, 5).map(r => ({ rank: r.rank, user: r.user, points: r.points, edits: r.edits, mix: r.mix })) };
    }
  }
  return out;
}
