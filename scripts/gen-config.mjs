// Turns the user's profile (plain words, saved on the dashboard) into the watcher's config.json.
// Usage: node gen-config.mjs profile.json packs.json > config.json
//        node gen-config.mjs profile.json packs.json --cron   (prints the workflow's UTC hours, e.g. "13-23,0-6")
// The profile is the only thing anyone edits. Run this again after any profile change; the morning health
// check compares the two and regenerates config.json when they no longer match.
import fs from 'node:fs';

const [profilePath, packsPath, flag] = process.argv.slice(2);
const P = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const PACKS = JSON.parse(fs.readFileSync(packsPath, 'utf8')).packs;

const esc = s => String(s).trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const words = list => (list || []).filter(Boolean).map(w => `\\b${esc(w)}`).join('|');
const join = (...parts) => parts.filter(Boolean).join('|');

// "Custom" = a profession no pack covers: titles come only from extraTitles/adjacentTitles, and the General
// pack supplies the exclusions and seniority words.
const custom = P.pack === 'Custom';
const pack = (!custom && PACKS.find(p => p.name === P.pack)) || PACKS.find(p => p.name === 'General');
const chosen = custom ? [] : P.families?.length ? pack.families.filter(f => P.families.includes(f.name)) : pack.families;
if (!custom && P.families?.length && !chosen.length) throw new Error(`None of ${JSON.stringify(P.families)} is a family in the ${pack.name} pack`);
if (!chosen.length && !(P.extraTitles || []).length) throw new Error('No titles: choose a job family or add extraTitles');

// Titles: the families' patterns plus anything the user typed. Adjacent titles are judged on the job text later.
// extraTitleRegex / extraBroadRegex: raw patterns carried over from a v2 watcher, so a migration loses nothing.
const titleRegex = join(...chosen.map(f => f.titleRegex), words(P.extraTitles), P.extraTitleRegex || '');
const broadTitleRegex = P.adjacentOff ? '' : join(...chosen.map(f => f.broadTitleRegex), words(P.adjacentTitles), P.extraBroadRegex || '');
const titleExcludeRegex = join(pack.titleExcludeRegex, words(P.excludeTitleWords));
// Seniority the user doesn't want (e.g. "Director") becomes a title drop, using the pack's seniority patterns.
const dropRegex = join(...(P.excludeSeniority || []).map(s => pack.seniorityRegex?.[s]).filter(Boolean), words(P.excludeTitlePhrases), P.extraDropRegex || '');   // extraDropRegex: a raw pattern carried over from an older setup

// Locations: the scan is US-only already, so "anywhere in the US" means no location filter at all.
const L = P.locations || {};
const city = c => esc(String(c).split(',')[0]);
const locationRegex = L.anywhereUS ? '' : join(...(L.cities || []).map(city), L.remote ? 'remote' : '', L.remote ? '^\\s*(united states|usa|us)\\s*$' : '', L.includeMultiLocation ? '\\d+\\s+locations' : '');
// A posting whose only location is "United States" is usually remote or open to any US city, so it counts with remote.

// Fit check: themes from the chosen families (deduplicated) plus the user's own, and their knockouts.
const themes = new Map();
for (const f of chosen) for (const [label, re] of f.fitThemes || []) if (!themes.has(label)) themes.set(label, re);
for (const [label, list] of P.fitThemes || []) themes.set(label, (Array.isArray(list) ? list : [list]).map(esc).join('|'));

const config = {
  _generated: `from profile.json by gen-config.mjs on ${new Date().toISOString().slice(0, 10)}. Edit the profile, not this file.`,
  ntfyTopic: P.ntfyTopic || '',
  ...(P.engineRef ? { engineRef: P.engineRef } : {}),   // "next" = the maintainer's test track
  timeZone: P.timeZone || 'America/Los_Angeles',
  quietEnd: P.activeFrom ?? 5,
  quietStart: P.activeUntil ?? 24,
  dashboardUrl: P.dashboardUrl || '',
  paused: !!P.paused,
  titleRegex, broadTitleRegex, titleExcludeRegex, dropRegex, locationRegex,
  excludeCompanies: P.excludeCompanies || [],
  companies: P.onlyCompanies || [],
  skip: P.skip || [],
  needsSponsorship: !!P.needsSponsorship,
  fit: {
    core: [...themes.entries()].slice(0, 14),
    knockouts: (P.knockouts || []).map(([w, penalty, label]) => [Array.isArray(w) ? w.map(esc).join('|') : esc(w), penalty ?? 20, label || String(w)]),
    targetCompanies: (P.targetCompanies || []).map(esc).join('|'),
    homeLocations: join(...(L.cities || []).map(city), L.remote ? 'remote' : ''),
    maxYears: P.maxYears ?? 12,
  },
};
for (const k of ['titleRegex', 'broadTitleRegex', 'titleExcludeRegex', 'dropRegex', 'locationRegex']) if (config[k]) new RegExp(config[k], 'i'); // fail loudly on a bad pattern

if (flag === '--cron') {
  // UTC hours covering activeFrom..activeUntil local time, at today's offset (shifts an hour when clocks change).
  const hourIn = timeZone => Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const offset = ((hourIn('UTC') - hourIn(config.timeZone)) % 24 + 24) % 24;   // e.g. 8 for Pacific standard time
  const hours = [];
  for (let h = config.quietEnd; h < config.quietStart; h++) hours.push(((h + offset) % 24 + 24) % 24);
  const sorted = [...new Set(hours)].sort((a, b) => a - b), ranges = [];
  for (const h of sorted) { const r = ranges.at(-1); if (r && r[1] === h - 1) r[1] = h; else ranges.push([h, h]); }
  console.log(ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(','));
} else {
  console.log(JSON.stringify(config, null, 1));
}
