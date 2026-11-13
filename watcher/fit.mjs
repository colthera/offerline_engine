// Fit check: a fast keyword match of a job description against the user's profile.
// The keyword lists live in config.json under "fit" (setup fills them from the career inventory),
// so this file never needs editing. Keep config.fit in sync with the dashboard's
// reference/direct-search-scripts fitCheck, which the evening sweep uses.
// fitCheck(title, text, company, location) -> { fit: 0-100, why: "short reason" }
import fs from 'node:fs';
const CFG = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const F = CFG.fit || {};
const rx = s => new RegExp(s, 'i');
// [label, pattern]: themes from the user's experience (8-14 of them).
const CORE = (F.core || [
  ['program mgmt', 'program manag|cross-functional|stakeholder|change management|roadmap'],
  ['process/automation', 'process improvement|automat|workflow|playbook|operational excellence'],
  ['KPIs/data', '\\bkpis?\\b|scorecard|dashboard|metrics|data[- ]driven'],
  ['vendors', 'vendor|supplier|\\bbpos?\\b|outsourc'],
]).map(([n, p]) => [n, rx(p)]);
// [pattern, penalty, label]: things the user can't or won't do.
const KO = (F.knockouts || []).map(([p, pen, l]) => [rx(p), pen, l]);
KO.push([rx('security clearance|ts/sci|public trust clearance|must (be|hold) (a )?u\\.?s\\.? citizen|u\\.?s\\.? citizenship (is )?required'), 50, 'clearance/citizenship']);
if (CFG.needsSponsorship) KO.push([rx("(unable|not able|cannot|will not|won['’]t|does not|do not) (to )?(provide |offer )?(visa )?sponsor|without (the need for )?(visa )?sponsorship|no (visa )?sponsorship"), 50, 'no sponsorship']);
const TARGETS = F.targetCompanies ? rx(F.targetCompanies) : null;
const HOME = F.homeLocations ? rx(F.homeLocations) : null;
const MAX_YEARS = F.maxYears || 12;

export const fitCheck = (title, text, company, loc) => {
  const t = ((title || '') + '\n' + (text || '')).toLowerCase().replace(/\s+/g, ' ');
  const hits = CORE.filter(([, re]) => re.test(t)).map(([n]) => n);
  let fit = 12 + Math.min(hits.length, 9) * 8;
  const why = [];
  const yrs = [...t.matchAll(/(\d{1,2})\s*\+?\s*(?:or more\s+)?years?(?:'|’)?\s+(?:of\s+)?(?:\w+\s+){0,6}?experience/g)].map(m => +m[1]).filter(n => n >= 3 && n <= 25);
  const maxY = yrs.length ? Math.max(...yrs) : 0;
  if (maxY > MAX_YEARS) { fit -= 40; why.push(`needs ${maxY}+ years`); }
  for (const [re, pen, label] of KO) if (re.test(t)) { fit -= pen; why.push(label); }
  if (TARGETS && TARGETS.test(company || '')) fit += 5;
  if (HOME && HOME.test(loc || '')) fit += 3;
  fit = Math.max(0, Math.min(100, Math.round(fit)));
  const good = hits.slice(0, 4).join(', ');
  return { fit, why: (why.length ? 'Gaps: ' + why.join('; ') + '. ' : '') + (good ? 'Matches: ' + good : 'Few profile matches') };
};
export const priorityFor = fit => fit >= 60 ? 'high' : fit >= 40 ? 'normal' : 'low';
