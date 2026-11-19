// Live data for the dashboards, loaded in <head> before the page starts.
// It does not change how the dashboards are drawn. It sits in front of fetch() and, for the files of a dashboard that has a
// live feed, swaps the September snapshot's numbers for the live ones produced by the scheduled job
// (scripts/live_luganda.mjs, which applies the same filter as the snapshot). If the live file cannot be read in a few seconds,
// or looks wrong, the original snapshot files are used, so a dashboard never breaks because of the live feed.
(function () {
  'use strict';
  var realFetch = window.fetch.bind(window);
  var FALLBACK_BASE = 'https://raw.githubusercontent.com/kasozidenis/uganda-atlas/editathon-data/';
  var feeds = {}; // id -> Promise(live object or null)

  function jsonResponse(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  function fmt(n) { return Number(n).toLocaleString('en-GB'); }
  function withTimeout(url, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return realFetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }
  var basePromise = null;
  function base() {
    if (!basePromise) basePromise = realFetch('editathon/config.json?t=' + Math.floor(Date.now() / 3600000))
      .then(function (r) { return r.json(); })
      .then(function (c) { return (c.metricsUrl || '').replace(/metrics\.json.*$/, '') || FALLBACK_BASE; })
      .catch(function () { return FALLBACK_BASE; });
    return basePromise;
  }
  function feed(id, file, valid) {
    if (!feeds[id]) feeds[id] = base().then(function (b) { return withTimeout(b + file + '?t=' + Math.floor(Date.now() / 600000), 8000); })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { if (!valid(j)) throw new Error('unexpected shape'); window['__LIVE_' + id.toUpperCase()] = j; document.dispatchEvent(new CustomEvent('live-data', { detail: id })); return j; })
      .catch(function (e) { console.info('Live data for ' + id + ' not used:', e && e.message); return null; });
    return feeds[id];
  }

  // ---------- Luganda Wikipedia ----------
  var LG_TABLES = ['luganda.articles', 'luganda.no-english-article', 'luganda.no-wikidata-item', 'luganda.never-read'];
  function lgFeed() {
    return feed('luganda', 'luganda-live.json', function (j) {
      return j && j.kpis && j.kpis.articles > 1000 && j.tables && LG_TABLES.every(function (t) {
        var x = j.tables[t]; return x && x.meta && x.cols && x.cols.length === x.meta.length && x.cols[0].length === x.n;
      });
    });
  }
  function through(live) { // "30 Nov 2026" style date for how far the views run
    var s = live.mtdThrough || live.viewsThrough; if (!s) return '';
    return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function setRows(blocks, title, rows) { blocks.forEach(function (b) { if (b.t === 'tbl' && b.title === title) b.rows = rows; }); }
  function patchLuganda(d, live) {
    var k = live.kpis, blocks = d.tabs[0].blocks, to = through(live);
    blocks.forEach(function (b) {
      if (b.t !== 'kpis') return;
      b.items.forEach(function (i) {
        if (i.l === 'Articles') { i.x = k.articles; i.v = fmt(k.articles); i.n = 'Luganda Wikipedia · live'; }
        else if (i.l === 'Total views, all time') { i.x = k.views; i.v = fmt(k.views); i.n = 'since July 2015, to ' + to + (live.viewsComplete === false ? ' (being updated)' : ''); }
        else if (i.l === 'With a Wikidata item') { i.x = k.wikidataPct; i.v = k.wikidataPct + '%'; }
        else if (i.l === 'With an English article') { i.x = k.englishPct; i.v = k.englishPct + '%'; }
        else if (i.l === 'Read fewer than 1,000 times') { i.x = k.littlePct; i.v = k.littlePct + '%'; }
        else if (i.l === 'Never read') { i.x = k.neverRead; i.v = fmt(k.neverRead); i.n = 'no views since July 2015'; }
        else if (i.l === 'About Uganda') { i.x = k.about; i.v = fmt(k.about); }
        else if (i.l === 'Median article') { i.v = fmt(k.medianBytes) + ' B'; }
      });
    });
    setRows(blocks, 'How much each article has been read in all', live.buckets);
    setRows(blocks, 'Wikidata and English connections', live.connections);
    setRows(blocks, 'How long the articles are', live.sizes);
    setRows(blocks, 'The fifteen most read articles', live.top);
    d.tabs.forEach(function (t) {
      t.blocks.forEach(function (b) {
        if (b.t === 'xtbl' && live.tables[b.id]) { b.n = String(live.tables[b.id].n); b.meta = live.tables[b.id].meta; }
      });
    });
    if (d.card) { d.card.pages = k.articles; d.card.views = k.views; }
    return d;
  }
  function patchManifest(m, live) {
    (m.dash || []).forEach(function (x) { if (x.id === 'luganda') { x.pages = live.kpis.articles; x.views = live.kpis.views; } });
    return m;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var orig = function () { return realFetch(input, init); };
    var m;
    if (/(^|\/)d\/luganda\.json(\?|$)/.test(url)) {
      return Promise.all([orig(), lgFeed()]).then(function (a) {
        if (!a[1] || !a[0].ok) return a[0];
        return a[0].clone().json().then(function (d) { return jsonResponse(patchLuganda(d, a[1])); }).catch(function () { return a[0]; });
      });
    }
    if (/(^|\/)d\/manifest\.json(\?|$)/.test(url)) {
      return Promise.all([orig(), lgFeed()]).then(function (a) {
        if (!a[1] || !a[0].ok) return a[0];
        return a[0].clone().json().then(function (d) { return jsonResponse(patchManifest(d, a[1])); }).catch(function () { return a[0]; });
      });
    }
    if ((m = url.match(/(^|\/)t\/(luganda\.(?:articles|no-english-article|no-wikidata-item|never-read))\.0\.json(\?|$)/))) {
      return lgFeed().then(function (live) { return live ? jsonResponse(live.tables[m[2]].cols) : orig(); });
    }
    return orig();
  };
})();
