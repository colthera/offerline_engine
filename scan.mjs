// Offerline shared scanner: reads every job board in catalog.json once and writes
//   out/jobs.json    US jobs from every board (title, location, link, first seen)
//   out/health.json  one line per board: ok/failed, HTTP status, time, job counts
// No keys, no Claude usage. Node 20+, no dependencies.
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
const ctx = new AsyncLocalStorage();   // per-board request count and slowest single response

const CATALOG = JSON.parse(fs.readFileSync('catalog.json', 'utf8'));
const PREV = fs.existsSync('prev/jobs.json') ? JSON.parse(fs.readFileSync('prev/jobs.json', 'utf8')) : { jobs: [] };
const firstSeen = new Map(PREV.jobs.map(j => [j.key, j.firstSeen]));
const NOW = new Date().toISOString();
const SET = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
const SLOW_MS = SET.slowMs || 9000;   // a single response slower than this is "slow"
const CONCURRENCY = 12;
const UA = 'Mozilla/5.0 (compatible; OfferlineScanner/0.1; +https://github.com/offerline)';

const STATES = 'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia';
const ABBR = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const CITIES = 'new york|nyc|san francisco|bay area|seattle|bellevue|redmond|kirkland|boston|cambridge|chicago|austin|dallas|houston|denver|boulder|atlanta|los angeles|san diego|san jose|santa clara|sunnyvale|palo alto|mountain view|menlo park|irvine|portland|phoenix|scottsdale|salt lake|lehi|miami|tampa|orlando|charlotte|raleigh|durham|nashville|minneapolis|detroit|pittsburgh|philadelphia|baltimore|columbus|cincinnati|cleveland|indianapolis|kansas city|st\\.? louis|omaha|milwaukee|madison|richmond|arlington|reston|mclean|herndon|washington,? d\\.?c|jersey city|stamford|hartford|providence|newark|princeton|sacramento|oakland|plano|irving|frisco|fort worth|san antonio|las vegas|albuquerque|boise|honolulu|anchorage';
const US = new RegExp(`united states|\\busa?\\b|u\\.s\\.|,\\s*(${ABBR})\\b|\\b(${ABBR})\\s*[-,]|\\b(${STATES})\\b|\\bUS[- ]|\\b(${CITIES})\\b`, 'i');
const NOT_US = /canada|toronto|vancouver|montreal|ontario|british columbia|united kingdom|\buk\b|london|dublin|india|bengaluru|bangalore|hyderabad|pune|mexico|brazil|germany|france|ireland|singapore|japan|australia|china|poland|netherlands|spain|israel|philippines|costa rica|romania|hungary|czech|argentina|colombia|korea/i;
const SURE_US = new RegExp(`united states|\\busa\\b|u\\.s\\.|\\b(${STATES})\\b`, 'i');
// A job is US when any of its locations is. A part naming another country counts only if it also names a US state.
// "Remote" alone, Workday's "3 Locations" and a blank location are kept as "location unknown":
// the user's watcher then checks the job description.
const usPart = p => (US.test(p) && (!NOT_US.test(p) || SURE_US.test(p))) || /^\s*(remote|\d+ locations)\s*$/i.test(p);
const isUS = loc => !String(loc || '').trim() || String(loc).split(/;|\|/).some(usPart);
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

let requests = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// One request. A 429 (too many requests), 5xx or timeout is retried twice, after 3s and 10s.
async function call(url, opts = {}, kind = 'json') {
  for (let attempt = 0; ; attempt++) {
    requests++; const st = ctx.getStore(); if (st) st.req++;
    const t = Date.now();
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': UA, Accept: kind === 'json' ? 'application/json' : 'text/html', 'Accept-Language': 'en-US', ...(opts.headers || {}) } });
      if (st) st.maxMs = Math.max(st.maxMs, Date.now() - t);
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      return kind === 'json' ? await r.json() : await r.text();
    } catch (e) {
      if (st) { st.maxMs = Math.max(st.maxMs, Date.now() - t); if (e.status === 429) st.r429++; }
      const retry = e.status === 429 || e.status >= 500 || e.name === 'TimeoutError' || /timeout|fetch failed/i.test(e.message);
      if (!retry || attempt >= 2) throw e;
      await sleep(attempt ? 10000 : 3000);
    }
  }
}
const post = (url, body, headers = {}) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Each reader returns [{id, title, loc, url, posted?}] for (ideally) every open job, newest first where the board allows.
const R = {
  async greenhouse(c) {
    const j = await call(`https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs`);
    return (j.jobs || []).map(x => ({ id: x.id, title: x.title, loc: x.location?.name, url: x.absolute_url, posted: x.updated_at }));
  },
  async ashby(c) {
    const j = await call(`https://api.ashbyhq.com/posting-api/job-board/${c.slug}`);
    return (j.jobs || []).map(x => ({ id: x.id, title: x.title, url: x.jobUrl, posted: x.publishedAt,
      loc: [x.location, ...(x.secondaryLocations || []).map(l => l.location), x.address?.postalAddress?.addressCountry, x.isRemote ? 'Remote' : ''].filter(Boolean).join('; ') }));
  },
  async lever(c) {
    const j = await call(`https://api.lever.co/v0/postings/${c.slug}?mode=json`);
    return (Array.isArray(j) ? j : []).map(x => ({ id: x.id, title: x.text, url: x.hostedUrl, posted: x.createdAt && new Date(x.createdAt).toISOString(),
      loc: [x.categories?.location, ...(x.categories?.allLocations || []), x.country].filter(Boolean).join('; ') }));
  },
  async smartrecruiters(c) {
    const out = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const j = await call(`https://api.smartrecruiters.com/v1/companies/${c.slug}/postings?country=us&limit=100&offset=${offset}`);
      for (const x of j.content || []) out.push({ id: x.id, title: x.name, loc: (x.location?.fullLocation || 'United States') + (x.location?.remote ? '; Remote' : ''), url: `https://jobs.smartrecruiters.com/${c.slug}/${x.id}`, posted: x.releasedDate });
      if ((j.content || []).length < 100) break;
    }
    return out;
  },
  // Workday returns 20 at a time, newest first. Read until a page holds only jobs we already know (or 10 pages).
  async workday(c) {
    const out = [];
    for (let offset = 0; offset < 200; offset += 20) {
      const j = await post(`https://${c.host}/wday/cxs/${c.tenant}/${c.site}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText: '' });
      const ps = j.jobPostings || [];
      if (offset === 0) c._total = j.total;
      let fresh = 0;
      for (const p of ps) {
        const job = { id: p.externalPath, title: p.title, loc: p.locationsText, url: `https://${c.host}/${c.site}${p.externalPath}`, posted: p.postedOn };
        if (!firstSeen.has(key(c, job.id))) fresh++;
        out.push(job);
      }
      if (ps.length < 20 || (PREV.jobs.length && fresh === 0)) break;
    }
    return out;
  },
  async oraclehcm(c) {
    const j = await call(`https://${c.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${c.site},limit=200,sortBy=POSTING_DATES_DESC`);
    c._total = j.items?.[0]?.TotalJobsCount;
    return (j.items?.[0]?.requisitionList || []).map(x => ({ id: x.Id, title: x.Title, posted: x.PostedDate,
      loc: [x.PrimaryLocation, x.PrimaryLocationCountry, ...(x.secondaryLocations || []).map(s => s.Name)].filter(Boolean).join('; '),
      url: c.jobUrl ? c.jobUrl.replace('{id}', x.Id) : `https://${c.host}/hcmUI/CandidateExperience/en/sites/${c.site}/job/${x.Id}` }));
  },
  async jibe(c) {
    const j = await call(`https://${c.host}/api/jobs?limit=100&sortBy=posted_date&descending=true`);
    c._total = j.totalCount;
    return (j.jobs || []).map(({ data: d }) => ({ id: d.req_id, title: d.title, posted: d.posted_date,
      loc: [d.full_location, d.country].filter(Boolean).join('; '), url: `https://${c.host}/careers-home/jobs/${d.req_id}` }));
  },
  async amazon() {
    const j = await call('https://www.amazon.jobs/en/search.json?country=USA&result_limit=100&sort=recent&offset=0');
    return (j.jobs || []).map(x => ({ id: x.id_icims || x.id, title: x.title, loc: x.normalized_location || x.location, url: 'https://www.amazon.jobs' + x.job_path, posted: x.posted_date }));
  },
  async microsoft() {
    const out = [];
    for (let start = 0; start < 100; start += 10) {
      const j = await call(`https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=&location=United%20States&start=${start}&sort_by=timestamp`);
      const ps = j.data?.positions || j.positions || [];
      for (const p of ps) out.push({ id: p.id, title: p.name || p.title, loc: (p.locations || [p.location]).join('; ') || 'United States', url: `https://apply.careers.microsoft.com/careers/job/${p.id}` });
      if (ps.length < 10) break;
    }
    return out;
  },
  async atlassian() {
    const j = await call('https://www.atlassian.com/endpoint/careers/listings');
    return (Array.isArray(j) ? j : []).map(x => ({ id: x.id, title: x.title, loc: (x.locations || []).join('; '), url: x.portalJobPost?.portalUrl || 'https://www.atlassian.com/company/careers/all-jobs' }));
  },
  // TikTok's country filter returns nothing, so read the newest 200 and keep jobs whose city sits under the US (CN_6).
  async tiktok() {
    const j = await post('https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts', { keyword: '', limit: 200, offset: 0 }, { 'website-path': 'tiktok' });
    const chain = c => { const n = []; for (let x = c; x; x = x.parent) n.push(x); return n; };
    return (j.data?.job_post_list || []).filter(x => chain(x.city_info).some(n => n.code === 'CN_6'))
      .map(x => ({ id: x.id, title: x.title, loc: chain(x.city_info).map(n => n.en_name).join(', ') + ', United States', url: `https://lifeattiktok.com/search/${x.id}` }));
  },
  async eightfold(c) {
    const ps = [];
    for (let start = 0; start < 100; start += 10) {   // Eightfold returns 10 per page
      const j = await call(`https://${c.host}/api/apply/v2/jobs?domain=${c.domain}&start=${start}&num=10&location=United%20States&sort_by=timestamp`);
      c._total = j.count; ps.push(...(j.positions || []));
      if ((j.positions || []).length < 10) break;
    }
    return ps.map(p => ({ id: p.id, title: p.name, loc: (p.locations || [p.location]).join('; '), url: p.canonicalPositionUrl || `https://${c.host}/careers/job/${p.id}`, posted: p.t_create && new Date(p.t_create * 1000).toISOString() }));
  },
  async googlehtml() {
    const s = await call('https://www.google.com/about/careers/applications/jobs/results/?location=United%20States&sort_by=date', {}, 'html');
    const ids = [...new Map([...s.matchAll(/jobs\/results\/(\d{10,})-([a-z0-9-]+)/g)].map(m => [m[1], m[2]])).entries()];
    const titles = [...s.matchAll(/<h3 class="QJPWVe">([^<]+)<\/h3>/g)].map(m => m[1].replace(/&amp;/g, '&'));
    return ids.map(([id, slug], i) => ({ id, title: titles[i] || slug.replace(/-/g, ' '), loc: 'United States', url: `https://www.google.com/about/careers/applications/jobs/results/${id}-${slug}` }));
  },
  async applehtml() {
    const s = await call('https://jobs.apple.com/en-us/search?location=united-states-USA&sort=newest', {}, 'html');
    return [...s.matchAll(/aria-label="([^"]+?)\s(\d{6,})"\s+href="(\/en-us\/details\/[^"]+)"/g)]
      .map(m => ({ id: m[2], title: m[1].replace(/&amp;/g, '&'), loc: 'United States', url: 'https://jobs.apple.com' + m[3] }));
  },
};

const key = (c, id) => `${c.name}|${id}`;
const boards = CATALOG.filter(c => R[c.method]);
const health = [], jobs = [];

async function scanOne(c) {
  const t0 = Date.now(), st = { req: 0, maxMs: 0, r429: 0 };
  return ctx.run(st, async () => { try {
    const list = await R[c.method](c);
    const us = list.filter(j => isUS(j.loc));
    const notUS = [...new Set(list.filter(j => !isUS(j.loc)).map(j => j.loc || '(blank)'))].slice(0, 6);
    for (const j of us) {
      const k = key(c, j.id);
      jobs.push({ key: k, company: c.name, title: strip(j.title), loc: j.loc || '', url: j.url, posted: j.posted || null, firstSeen: firstSeen.get(k) || NOW });
    }
    health.push({ name: c.name, method: c.method, ok: true, ms: Date.now() - t0, slowestMs: st.maxMs, requests: st.req, retried429: st.r429, read: list.length, us: us.length, total: c._total ?? list.length, notUS });
  } catch (e) {
    health.push({ name: c.name, method: c.method, ok: false, ms: Date.now() - t0, slowestMs: st.maxMs, requests: st.req, retried429: st.r429, status: e.status || null, error: String(e.message || e).slice(0, 120) });
  } });
}

// Run boards in parallel, but never two at once on the same host (spreads the load on Workday and Oracle).
// Workday rate-limits per data center (wd1, wd5, ...), not per company, so at most 3 boards per data center at once.
const queue = [...boards], busy = new Map();
const LIMIT = { workday: 3 };
const laneOf = c => c.method === 'workday' ? 'wd:' + (c.host.split('.')[1] || '') : (c.host || c.method + ':' + (c.slug || c.name));
const room = c => (busy.get(laneOf(c)) || 0) < (LIMIT[c.method] || 1);
async function worker() {
  while (queue.length) {
    const i = queue.findIndex(room);
    if (i < 0) { await sleep(50); continue; }
    const [c] = queue.splice(i, 1), lane = laneOf(c);
    busy.set(lane, (busy.get(lane) || 0) + 1);
    await scanOne(c);
    busy.set(lane, busy.get(lane) - 1);
  }
}
const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Jobs seen last run but missing from a board that only reads its newest page are kept until they age out (30 days).
const readAll = new Set(['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'atlassian']);
const okBoards = new Set(health.filter(h => h.ok).map(h => h.name));
const fresh = new Set(jobs.map(j => j.key));
const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
for (const j of PREV.jobs) {
  if (fresh.has(j.key)) continue;
  const c = CATALOG.find(x => x.name === j.company);
  if (!c) continue;                 // company removed from the catalog: drop its jobs
  const closed = c && readAll.has(c.method) && okBoards.has(c.name);
  if (!closed && j.firstSeen > cutoff) jobs.push(j);
}

// Slow boards. Each board's slowest response per scan is kept for SET.historyDays days, labelled busy (inside the
// weekday busy window, 12-1pm Pacific to start) or off-peak. Slowness in the busy window never makes a drop
// candidate. A board is a drop candidate when it was slow in most off-peak scans (or failed them) on each of the
// last SET.dropRule.days days that had off-peak scans. The maintainer confirms any removal.
const BW = SET.busyWindow, DR = SET.dropRule;
const localParts = d => { const f = new Intl.DateTimeFormat('en-US', { timeZone: BW.timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => f.find(x => x.type === t).value; return { hour: +g('hour'), wd: g('weekday'), day: `${g('year')}-${g('month')}-${g('day')}` }; };
const nowL = localParts(new Date(NOW));
const busyScan = nowL.hour >= BW.startHour && nowL.hour < BW.endHour && (!BW.weekdaysOnly || !['Sat', 'Sun'].includes(nowL.wd));
const hist = fs.existsSync('prev/board-history.json') ? JSON.parse(fs.readFileSync('prev/board-history.json', 'utf8')) : {};
const keepAfter = Date.now() - (SET.historyDays || 7) * 864e5;
for (const h of health) {
  const rows = (hist[h.name] || []).filter(r => Date.parse(r.t) > keepAfter);
  rows.push({ t: NOW, day: nowL.day, hour: nowL.hour, busy: busyScan, ms: h.slowestMs || 0, ok: h.ok });
  hist[h.name] = rows;
  h.slow = (h.slowestMs || 0) > SLOW_MS;
  const offDays = [...new Set(rows.filter(r => !r.busy).map(r => r.day))].sort().slice(-DR.days);
  const badDay = d => { const rs = rows.filter(r => !r.busy && r.day === d); const bad = rs.filter(r => !r.ok || r.ms > SLOW_MS).length; return rs.length && bad / rs.length > DR.shareOfOffPeakScansSlow; };
  h.dropCandidate = offDays.length >= DR.days && offDays.every(badDay);
  h.slowOnlyWhenBusy = !h.dropCandidate && rows.some(r => r.busy && r.ms > SLOW_MS) && !rows.some(r => !r.busy && r.ms > SLOW_MS);
}
for (const n of Object.keys(hist)) if (!health.find(h => h.name === n)) delete hist[n];   // removed from the catalog
// When were boards slow? Count of slow responses by Pacific hour over the last 3 days, to spot a moving busy window.
const slowByHour = {};
for (const rows of Object.values(hist)) for (const r of rows) if (Date.parse(r.t) > Date.now() - 3 * 864e5 && r.ms > SLOW_MS) slowByHour[r.hour] = (slowByHour[r.hour] || 0) + 1;
health.sort((a, b) => a.name.localeCompare(b.name));

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/jobs.json', JSON.stringify({ scannedAt: NOW, count: jobs.length, jobs }));
const summary = { scannedAt: NOW, seconds: Math.round((Date.now() - started) / 1000), requests, boards: health.length,
  ok: health.filter(h => h.ok).length, failed: health.filter(h => !h.ok).length, slow: health.filter(h => h.slow).length, usJobs: jobs.length,
  newJobs: jobs.filter(j => j.firstSeen === NOW).length };
fs.writeFileSync('out/health.json', JSON.stringify({ ...summary, busyScan, slowByHour, boards: health }, null, 1));
fs.writeFileSync('out/board-history.json', JSON.stringify(hist));
fs.appendFileSync('out/history.jsonl', JSON.stringify(summary) + '\n');

// Readable report for the Actions run page.
const fail = health.filter(h => !h.ok), slow = health.filter(h => h.ok && h.slow);
const byStatus = fail.reduce((m, h) => (m[h.status || h.error] = (m[h.status || h.error] || 0) + 1, m), {});
const lines = [
  `## Offerline scan · ${NOW}`,
  `${summary.ok} of ${summary.boards} boards read in ${summary.seconds}s with ${requests} requests. ${summary.usJobs} US jobs, ${summary.newJobs} new.`,
  '', `**Failed (${fail.length})** · by reason: ${Object.entries(byStatus).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`,
  ...fail.map(h => `- ${h.name} (${h.method}): ${h.error}`),
  '', `**Read fine but under 20 US jobs (${health.filter(h => h.ok && h.us < 20).length})**`,
  ...health.filter(h => h.ok && h.us < 20).map(h => `- ${h.name} (${h.method}): ${h.us} US of ${h.read} read · other locations: ${(h.notUS || []).join(' / ')}`),
  '', `**A response slower than ${SLOW_MS / 1000}s this scan (${slow.length})**${busyScan ? ' · inside the busy window, so none of these count toward dropping' : ''}`,
  ...slow.map(h => `- ${h.name} (${h.method}): ${(h.slowestMs / 1000).toFixed(1)}s`),
  '', `**Drop candidates: slow or failing in most off-peak scans on ${DR.days} days in a row (${health.filter(h => h.dropCandidate).length})** · confirm before removing`,
  ...health.filter(h => h.dropCandidate).map(h => `- ${h.name} (${h.method})`),
  '', `**Slow only in the busy window (${health.filter(h => h.slowOnlyWhenBusy).length})** · noted, not dropped: ${health.filter(h => h.slowOnlyWhenBusy).map(h => h.name).join(', ') || 'none'}`,
  '', `**When boards were slow, last 3 days (Pacific hour: slow responses)** · busy window ${BW.startHour}:00-${BW.endHour}:00`,
  Object.keys(slowByHour).length ? Object.entries(slowByHour).sort((a, b) => a[0] - b[0]).map(([h, n]) => `${h}:00 ${n}`).join(' · ') : 'none',
];
fs.writeFileSync('out/report.md', lines.join('\n') + '\n');
console.log(lines.join('\n'));
