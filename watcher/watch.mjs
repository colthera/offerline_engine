// Offerline watcher (v3). Runs hourly in the user's private repo.
// It does not read any job board itself: it downloads the shared scanner's results (jobs.json),
// keeps the new jobs that match this user's profile, and sends phone alerts with ntfy.
// Settings live in config.json (generated from the profile on the dashboard). No keys, no Claude usage.
import fs from 'node:fs';

const CFG = JSON.parse(fs.readFileSync(process.env.CONFIG || 'config.json', 'utf8'));
// SHADOW=1 (pilot beside an old watcher): no phone alerts, state kept in its own folder.
const SHADOW = process.env.SHADOW === '1', DIR = process.env.STATE_DIR || 'state';
const STATE_FILE = `${DIR}/seen.json`, FOUND_FILE = `${DIR}/found.json`;
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
state.seen ||= {}; state.pending ||= []; state.companies ||= {}; state.warned ||= {};
const found = fs.existsSync(FOUND_FILE) ? JSON.parse(fs.readFileSync(FOUND_FILE, 'utf8')) : [];
const today = new Date().toISOString().slice(0, 10);
const ENGINE = process.env.ENGINE_DATA || CFG.engineData || 'https://raw.githubusercontent.com/colthera/offerline_engine/data/jobs.json';

const rx = s => (s ? new RegExp(s, 'i') : null);
const TITLE = rx(CFG.titleRegex), BROAD = rx(CFG.broadTitleRegex), TITLE_NO = rx(CFG.titleExcludeRegex);
const LOC = rx(CFG.locationRegex), DROP = rx(CFG.dropRegex);
// skip: [{companies: [...], titleRegex}] = titles to ignore at those companies only (e.g. senior technical titles at big tech).
const SKIP = (CFG.skip || []).map(r => ({ cos: new Set(r.companies.map(s => s.toLowerCase())), re: rx(r.titleRegex) }));
const EXCLUDE = new Set((CFG.excludeCompanies || []).map(s => s.toLowerCase()));   // names plus their other names (AWS for Amazon)
// relocation "flag": a target title elsewhere in the US is kept for the morning run (location "other", never a phone alert).
const RELOCATE = CFG.relocation === 'flag';
const ONLY = CFG.companies?.length ? new Set(CFG.companies.map(s => s.toLowerCase())) : null; // empty = whole catalog
const unknownLoc = l => !String(l || '').trim() || /^\s*(remote|\d+ locations)\s*$/i.test(l);

async function push(title, body, click, priority = 'default') {
  if (!CFG.ntfyTopic || SHADOW) return;
  await fetch(`https://ntfy.sh/${CFG.ntfyTopic}`, { method: 'POST', body,
    headers: { Title: title.replace(/[^\x20-\x7E]/g, '-'), Priority: priority, Tags: 'briefcase', ...(click ? { Click: click } : {}) } });
}
const save = () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  fs.writeFileSync(FOUND_FILE, JSON.stringify(found, null, 1));
};

if (process.env.TEST_PUSH === '1') { await push('Job watcher is live', 'Test alert: phone alerts work. New matching roles will arrive like this.', CFG.dashboardUrl || null, 'high'); console.log('Test alert sent.'); process.exit(0); }
if (CFG.paused) { console.log('Paused: nothing to do.'); process.exit(0); }

const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: CFG.timeZone || 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const awake = hour >= (CFG.quietEnd ?? 5) && hour < (CFG.quietStart ?? 24);

// 1. Download the latest shared scan.
let scan;
try {
  const r = await fetch(ENGINE, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  scan = await r.json();
} catch (e) {
  console.log(`Could not download the shared scan: ${e.message}`);
  if (awake && state.warned.download !== today) { state.warned.download = today; await push('Watcher: shared scan unreachable', `Couldn't download today's job list (${e.message}). Ask Claude to check the watcher.`, null, 'low'); }
  save(); process.exit(0);
}
const ageHours = (Date.now() - Date.parse(scan.scannedAt)) / 36e5;
if (ageHours > 3 && awake && state.warned.stale !== today) {
  state.warned.stale = today;
  await push('Watcher: job list is out of date', `The shared scan is ${Math.round(ageHours)} hours old, so new jobs may be missed. Ask Claude to check the engine.`, null, 'low');
}

// 2. Keep new jobs that match this profile.
const firstRun = !state.engineSeeded;           // first run on the shared scan: record everything silently
// The first run with relocation on records the existing roles elsewhere quietly (a backlog, not news).
const relocFirst = RELOCATE && !state.relocationOn;
const matches = [];
for (const j of scan.jobs) {
  const co = j.company.toLowerCase();
  if (EXCLUDE.has(co) || (ONLY && !ONLY.has(co))) continue;
  if (state.seen[j.key]) continue;
  const strong = TITLE && TITLE.test(j.title), broad = !strong && BROAD && BROAD.test(j.title);
  if (!(strong || broad) || (TITLE_NO && TITLE_NO.test(j.title)) || (DROP && DROP.test(j.title))) continue;
  if (SKIP.some(r => r.cos.has(co) && r.re.test(j.title))) continue;
  const where = unknownLoc(j.loc) ? 'unknown' : (!LOC || LOC.test(j.loc) ? 'match' : 'other');
  if (where === 'other' && (!RELOCATE || broad)) continue;   // relocation keeps target titles only, not adjacent ones
  state.seen[j.key] = today;
  // Quiet (recorded, no alert): the first run, a company new to the catalog, or a job the scanner has known for
  // over 2 days (it only matches now because the profile changed).
  const old = j.firstSeen && Date.now() - Date.parse(j.firstSeen) > 48 * 36e5;
  const quiet = firstRun || !state.companies[j.company] || old || (where === 'other' && relocFirst);
  const entry = { key: j.key, company: j.company, title: j.title, loc: j.loc, url: j.url, posted: j.posted, foundAt: today,
    kind: broad ? 'adjacent' : 'title', location: where };
  // On the first run, jobs first seen in the last 7 days still go to found.json (no alert): setup scores them.
  if (firstRun && j.firstSeen && Date.now() - Date.parse(j.firstSeen) <= 7 * 864e5) { found.push({ ...entry, seeded: true }); continue; }
  if (!quiet) matches.push({ key: j.key, company: j.company, title: j.title, loc: j.loc, url: j.url, posted: j.posted, foundAt: today,
    kind: broad ? 'adjacent' : 'title', location: where });
}
for (const j of scan.jobs) state.companies[j.company] = true;
state.engineSeeded = true;
state.relocationOn = RELOCATE;

// Adjacent titles, unknown locations and (with relocation on) other US locations are saved for the morning run,
// which reads the full job text. Only clear title matches in the user's own places are alerted now.
const alertNow = matches.filter(m => m.kind === 'title' && m.location === 'match');
found.push(...matches);
state.pending.push(...alertNow);

// 3. Phone alerts (held overnight, sent in the first awake run).
if (firstRun) {
  const n = Object.keys(state.seen).length;
  await push('Job watcher is live', `Now using the shared scan of ${new Set(scan.jobs.map(j => j.company)).size} companies. ${n} current matching jobs recorded; you'll only hear about new ones from here.`);
} else if (awake && state.pending.length) {
  const p = state.pending;
  if (p.length <= 4) for (const x of p) await push(`New: ${x.company}`, `${x.title}\n${(x.loc || '').slice(0, 90)}`, x.url, 'high');
  else await push(`${p.length} new roles`, p.map(x => `• ${x.company}: ${x.title}`).join('\n').slice(0, 3500), CFG.dashboardUrl || null, 'high');
  state.pending = [];
}

// 4. Housekeeping: forget seen jobs after 120 days; keep 7 days of finds for the morning run.
const cut = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
for (const [k, d] of Object.entries(state.seen)) if (d < cut(120)) delete state.seen[k];
const keepFound = found.filter(f => f.foundAt >= cut(7));
found.length = 0; found.push(...keepFound);
save();
console.log(`hour ${hour}${awake ? '' : ' (quiet)'} · scan ${ageHours.toFixed(1)}h old, ${scan.jobs.length} jobs · new matches ${matches.length} (alert now ${alertNow.length}) · pending ${state.pending.length}${firstRun ? ' · first run, recorded silently' : ''}`);
