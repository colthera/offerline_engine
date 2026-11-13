// Fetch the full text of one job posting and save it to jd/<id>.txt. Run by .github/workflows/fetch-jd.yml.
// Handles Greenhouse, Ashby, Lever, Workday and Microsoft through their public APIs, and any other site
// through its HTML (JSON-LD JobPosting first, then visible text).
import fs from 'node:fs';

const url = process.env.JD_URL, id = (process.env.JD_ID || 'job').replace(/[^\w.-]/g, '_');
// The company list comes from the shared engine's catalog (falls back to a local companies.json if present).
const CATALOG = process.env.CATALOG_URL || 'https://raw.githubusercontent.com/colthera/offerline_engine/main/catalog.json';
let COMPANIES = [];
try { COMPANIES = await (await fetch(CATALOG, { signal: AbortSignal.timeout(20000) })).json(); }
catch { if (fs.existsSync('companies.json')) COMPANIES = JSON.parse(fs.readFileSync('companies.json', 'utf8')); }
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126 Safari/537.36' };
const get = async (u, o = {}) => { const r = await fetch(u, { ...o, headers: { ...UA, ...(o.headers || {}) }, signal: AbortSignal.timeout(25000) }); if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`); return r; };
const strip = h => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|h\d|div|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
  .replace(/&[a-z]+;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const decode = h => String(h || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

async function greenhouse(board, jid) {
  const j = await (await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jid}?content=true`)).json();
  return { source: 'greenhouse', title: j.title, location: j.location?.name, text: strip(decode(j.content)) };
}
async function run(url) {
  const u = new URL(url), h = u.hostname.replace(/^www\./, ''), path = u.pathname;
  let m;
  // Greenhouse
  if ((m = path.match(/\/([\w-]+)\/jobs\/(\d+)/)) && /greenhouse\.io$/.test(h)) return greenhouse(m[1], m[2]);
  const gh = u.searchParams.get('gh_jid');
  const byName = n => COMPANIES.find(c => c.method === 'greenhouse' && (h.includes(c.slug) || h.includes(c.name.toLowerCase().replace(/[^a-z]/g, ''))));
  if (gh && byName()) return greenhouse(byName().slug, gh);
  if (h === 'stripe.com' && (m = path.match(/(\d{6,})\/?$/))) return greenhouse('stripe', m[1]);
  // Ashby
  if (h === 'jobs.ashbyhq.com' && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})/))) {
    const j = await (await get(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}?includeCompensation=true`)).json();
    const x = (j.jobs || []).find(p => (p.id || '') === m[2] || (p.jobUrl || '').includes(m[2]));
    if (x) return { source: 'ashby', title: x.title, location: x.location, text: strip(x.descriptionHtml || x.descriptionPlain) };
  }
  // Lever
  if (h === 'jobs.lever.co' && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})/))) {
    const x = await (await get(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`)).json();
    return { source: 'lever', title: x.text, location: x.categories?.location, text: strip(x.description) + '\n' + (x.lists || []).map(l => l.text + '\n' + strip(l.content)).join('\n') + '\n' + strip(x.additional) };
  }
  // Workday
  if (/myworkdayjobs\.com$/.test(h) && (m = path.match(/^(?:\/[a-z]{2}-[A-Z]{2})?\/([^/]+)(\/job\/.+)$/))) {
    const tenant = h.split('.')[0];
    const x = await (await get(`https://${h}/wday/cxs/${tenant}/${m[1]}${m[2]}`, { headers: { Accept: 'application/json' } })).json();
    const i = x.jobPostingInfo || {};
    return { source: 'workday', title: i.title, location: i.location, text: strip(i.jobDescription) };
  }
  // Workday link without a job path (e.g. https://<tenant>.wdN.myworkdayjobs.com/<site>?q=R0076151): find it by requisition ID
  if (/myworkdayjobs\.com$/.test(h) && u.searchParams.get('q') && (m = path.match(/^(?:\/[a-z]{2}-[A-Z]{2})?\/([^/]+)\/?$/))) {
    const tenant = h.split('.')[0], q = u.searchParams.get('q');
    const s = await (await get(`https://${h}/wday/cxs/${tenant}/${m[1]}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: q }) })).json();
    const p = (s.jobPostings || []).find(x => (x.externalPath || '').includes(q) || (x.bulletFields || []).includes(q)) || (s.jobPostings || [])[0];
    if (!p) throw new Error(`No Workday posting found for ${q}`);
    const x = await (await get(`https://${h}/wday/cxs/${tenant}/${m[1]}${p.externalPath}`, { headers: { Accept: 'application/json' } })).json();
    const i = x.jobPostingInfo || {};
    return { source: 'workday', title: i.title, location: i.location, url: `https://${h}/${m[1]}${p.externalPath}`, text: strip(i.jobDescription) };
  }
  // Microsoft
  if (h === 'apply.careers.microsoft.com' && (m = path.match(/job\/(\d+)/))) {
    const x = await (await get(`https://apply.careers.microsoft.com/api/pcsx/position_details?position_id=${m[1]}&domain=microsoft.com&hl=en`)).json();
    const d = x.data || x;
    return { source: 'microsoft', title: d.name, location: (d.locations || []).join('; '), text: strip(d.job_description || d.jobDescription || JSON.stringify(d)) };
  }
  // Oracle Cloud HCM (Oracle, Uber)
  const ORACLE = { 'careers.oracle.com': ['eeho.fa.us2.oraclecloud.com', 'CX_45001'], 'iaziqy.fa.ocs.oraclecloud.com': ['iaziqy.fa.ocs.oraclecloud.com', 'CX_1'], 'jobs.uber.com': ['iaziqy.fa.ocs.oraclecloud.com', 'CX_1'] };
  if ((ORACLE[h] || /oraclecloud\.com$/.test(h)) && (m = (path + u.hash).match(/job\/(\d+)/))) {
    const [host, site] = ORACLE[h] || [h, (path.match(/sites\/([^/]+)/) || [])[1] || 'CX_1'];
    const x = await (await get(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${m[1]}%22,siteNumber=${site}`)).json();
    const d = x.items?.[0] || {};
    return { source: 'oracle', title: d.Title, location: d.PrimaryLocation, text: strip([d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr, d.CorporateDescriptionStr].filter(Boolean).join('\n')) };
  }
  // SmartRecruiters (ServiceNow and others)
  if (/smartrecruiters\.com$/.test(h) && (m = path.match(/^\/([^/]+)\/(\d+)/))) {
    const x = await (await get(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`)).json();
    const sec = x.jobAd?.sections || {};
    return { source: 'smartrecruiters', title: x.name, location: x.location?.fullLocation, text: strip(['jobDescription', 'qualifications', 'additionalInformation'].map(k => sec[k]?.text || '').join('\n')) };
  }
  // Jibe career sites (Docusign)
  if (h === 'careers.docusign.com' && (m = path.match(/jobs\/(\d+)/))) {
    const x = await (await get(`https://${h}/api/jobs/${m[1]}`)).json();
    const d = x.data || x;
    return { source: 'jibe', title: d.title, location: d.full_location, text: strip([d.description, d.responsibilities, d.qualifications].filter(Boolean).join('\n')) };
  }
  // Anything else: JSON-LD JobPosting, else visible page text
  const html = await (await get(url)).text();
  for (const s of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const arr = [].concat(JSON.parse(s[1])); const p = arr.flatMap(a => a['@graph'] || a).find(a => a['@type'] === 'JobPosting');
      if (p) return { source: 'json-ld', title: p.title, location: JSON.stringify(p.jobLocation || p.applicantLocationRequirements || ''), text: strip(decode(p.description)) };
    } catch { }
  }
  const t = strip(html);
  return { source: 'html', title: (html.match(/<title>([^<]*)/i) || [])[1], location: '', text: t };
}

// Batch mode: JD_BATCH holds lines "<id> <url>"; otherwise a single JD_URL/JD_ID.
const jobs = process.env.JD_BATCH ? process.env.JD_BATCH.split(/\n|;;/).map(l => l.trim()).filter(Boolean).map(l => { const [i, ...u] = l.split(/\s+/); return [i.replace(/[^\w.-]/g, '_'), u.join(' ')]; }) : [[id, url]];
fs.mkdirSync('jd', { recursive: true });
for (const [jid, jurl] of jobs) {
  let out;
  try { out = await run(jurl); if (!out.text || out.text.length < 400) out.warning = 'Very little text found; the page may need a browser.'; }
  catch (e) { out = { error: String(e.message || e) }; }
  fs.writeFileSync(`jd/${jid}.json`, JSON.stringify({ url: jurl, fetchedAt: new Date().toISOString(), ...out }, null, 1));
  console.log(JSON.stringify({ id: jid, source: out.source, title: out.title, chars: out.text?.length, error: out.error, warning: out.warning }));
}
