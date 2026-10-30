// Flowtown-Server: Ebene „Wir“, KI-Einschätzung über Mistral, Meldungen, Verkehrslage. Ohne Abhängigkeiten, Node 18 oder neuer.
// Gespeichert werden nur zusammengefasste Werte je Ampel, Richtung und Zeitfenster, nie Fahrten, Orte oder Uhrzeiten.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://mpaulussen.github.io').split(',').map((s) => s.trim()).filter(Boolean);
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || '';
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';
const MISTRAL_URL = process.env.MISTRAL_URL || 'https://api.mistral.ai/v1/chat/completions';
const K_MIN = Number(process.env.K_MIN || 5);          // ein Wert erscheint erst ab so vielen verschiedenen Beitragenden
const KI_PER_DAY = Number(process.env.KI_PER_DAY || 20); // KI-Anfragen je IP und Tag
const SALT = process.env.SALT || 'bitte-in-der-env-datei-setzen';
const WINDOWS = ['wd-morning', 'wd-day', 'wd-evening', 'night', 'weekend'];

fs.mkdirSync(DATA_DIR, { recursive: true });
const AGG_FILE = path.join(DATA_DIR, 'wir.json');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

// ---------- Ebene „Wir“ ----------
// Schlüssel: Ampel|Richtung (0–7, -1 unbekannt)|Zeitfenster → Besuche, Halte, Summe Wartezeit, gehashte Beitragende (höchstens 20)
const agg = readJson(AGG_FILE, {});
let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  const tmp = AGG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(agg));
  fs.renameSync(tmp, AGG_FILE);
}, 10000).unref();

const hashCid = (cid) => crypto.createHash('sha256').update(SALT + '|' + cid).digest('base64url').slice(0, 16);

function addWir(body) {
  if (!body || typeof body.cid !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.cid)) throw new Error('cid');
  if (!Array.isArray(body.items) || body.items.length > 300) throw new Error('items');
  const who = hashCid(body.cid);
  let n = 0;
  for (const it of body.items) {
    if (!it || typeof it.s !== 'string' || !/^c\d{1,13}$/.test(it.s)) continue;
    const d = Number.isInteger(it.d) && it.d >= -1 && it.d <= 7 ? it.d : -1;
    if (!WINDOWS.includes(it.w)) continue;
    const wait = Number(it.wait);
    if (!(wait >= 0 && wait <= 3600000)) continue;
    const k = `${it.s}|${d}|${it.w}`;
    const a = agg[k] || (agg[k] = { v: 0, h: 0, w: 0, c: [] });
    a.v += 1;
    if (it.halt) { a.h += 1; a.w += Math.round(wait); }
    if (!a.c.includes(who) && a.c.length < 20) a.c.push(who);
    n++;
  }
  dirty = dirty || n > 0;
  return n;
}
function readWir(ids) {
  const want = new Set(ids);
  const out = {};
  for (const k of Object.keys(agg)) {
    const a = agg[k];
    if (!want.has(k.split('|')[0]) || a.c.length < K_MIN) continue;
    out[k] = { n: a.c.length, v: a.v, h: a.h, avg: a.h ? Math.round(a.w / a.h) : 0 };
  }
  return out;
}

// ---------- KI-Einschätzung (Mistral) ----------
const SYSTEM = `Du bist der Mobilitäts-Coach der App Flowtown aus Bielefeld. Du bekommst die zusammengefassten Werte
einer Person aus den letzten 30 Tagen (JSON). Unter "app_hinweise" steht, was die App selbst schon erkannt hat,
unter "moegliche_ersparnisse" hat die App bereits ausgerechnet, was Änderungen bringen würden.

Deine Aufgabe: Wähle die ein bis drei Punkte, die für diese Person am meisten bringen, und sag ihr konkret, was sie tun kann.

Harte Regeln:
- Rechne nicht selbst. Zahlen zu Ersparnissen ("pro Woche", "je Fahrt") nimmst du nur aus "moegliche_ersparnisse".
  Andere Zahlen übernimmst du genau so, wie sie in den Daten stehen.
- Jede Empfehlung nennt einen Ort, Weg oder eine Uhrzeit aus den Daten und mindestens eine Zahl aus den Daten.
- Ampeln und Wege nennst du genau so, wie sie in den Daten heißen (Felder "ampel", "von", "nach"), ohne sie abzukürzen,
  damit die App sie auf der Karte zeigen kann.
- Beachte "sicherheit": Bei "niedrig" schreibst du ausdrücklich "erster Eindruck" und rätst, die Strecke öfter aufzuzeichnen.
- Die Rad-Schätzung enthält keine Ampeln ("rad_ampeln_unbekannt"). Behaupte nie, dass man mit dem Rad Wartezeit an Ampeln spart.
- Eine schlechte Bewertung einer Ampel empfiehlst du nur, wenn sie mindestens dreimal gehalten wurde oder Werte anderer
  Personen zeigen, dass dort alle lange warten.
- Uhrzeiten und Tageszeiten nennst du nur, wenn sie wörtlich in den Daten stehen. Erfinde keine Orte, Zeiten oder Zahlen.
- Keine allgemeinen Ratschläge, die auf jeden passen würden ("vorausschauend fahren", "Stoßzeiten meiden"),
  ohne Ort und Zahl aus den Daten.
- Ist ein Profil zur Barrierefreiheit gesetzt, achte besonders auf Wege zu Fuß, Umstiege und Grünzeiten.
- Nichts empfehlen, wofür man das Handy während der Fahrt braucht.
Wenn die Daten insgesamt dünn sind, sag das in der Einschätzung offen und nenne, welche Fahrten noch fehlen.

Schreibe Deutsch, duze, kurze Sätze, freundlich und direkt.

Antworte nur mit JSON:
{"einschaetzung": "2 bis 3 Sätze mit dem wichtigsten Befund und einer Zahl aus den Daten",
 "groesster_hebel": "1 Satz: die eine Änderung, die laut moegliche_ersparnisse oder zeitfresser am meisten bringt",
 "empfehlungen": [{"titel": "kurz, mit Ort oder Uhrzeit", "text": "1 bis 2 Sätze mit Zahl und konkreter Handlung"}]}`;

const kiCount = new Map();   // IP → { day, n }
function kiAllowed(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const e = kiCount.get(ip);
  if (!e || e.day !== day) { kiCount.set(ip, { day, n: 1 }); return true; }
  if (e.n >= KI_PER_DAY) return false;
  e.n += 1;
  return true;
}
async function askMistral(facts) {
  if (!MISTRAL_KEY) throw Object.assign(new Error('Kein MISTRAL_API_KEY gesetzt'), { status: 503 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(MISTRAL_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MISTRAL_KEY}` },
      body: JSON.stringify({
        model: MISTRAL_MODEL, temperature: 0.2, max_tokens: 1000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(facts) }]
      })
    });
    if (!res.ok) throw Object.assign(new Error('Mistral antwortet mit ' + res.status), { status: 502 });
    const j = await res.json();
    const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const parsed = JSON.parse(txt);
    const clean = (s, n) => String(s || '').slice(0, n);
    return {
      einschaetzung: clean(parsed.einschaetzung, 800),
      groesster_hebel: clean(parsed.groesster_hebel, 300),
      empfehlungen: (Array.isArray(parsed.empfehlungen) ? parsed.empfehlungen : []).slice(0, 3).map((e) => ({ titel: clean(e.titel, 80), text: clean(e.text, 400) })),
      modell: MISTRAL_MODEL
    };
  } finally { clearTimeout(timer); }
}

// ---------- Meldungen ----------
// data/news.json pflegst du selbst: [{ "id", "titel", "text", "quelle", "lat", "lon", "radius_m", "von", "bis" }]
function readNews() {
  const today = new Date().toISOString().slice(0, 10);
  return readJson(NEWS_FILE, []).filter((n) => n && n.titel && (!n.von || n.von <= today) && (!n.bis || n.bis >= today));
}

// ---------- Verkehrslage vor der Fahrt ----------
// Geholt wird höchstens alle LAGE_MIN Minuten und nur, wenn jemand fragt, immer für das ganze Gebiet.
// Jede App bekommt dasselbe Gesamtbild und prüft auf dem Gerät, was ihre Wege betrifft. Der Server erfährt keine Wege.
const HERE_KEY = process.env.HERE_API_KEY || '';
const HERE_URL = process.env.HERE_URL || 'https://data.traffic.hereapi.com/v7';
const AUTOBAHN_URL = process.env.AUTOBAHN_URL || 'https://verkehr.autobahn.de/o/autobahn';
const LAGE_BBOX = (process.env.LAGE_BBOX || '8.38,51.90,8.70,52.12').split(',').map(Number);   // West, Süd, Ost, Nord: Bielefeld
const LAGE_ROADS = (process.env.LAGE_ROADS || 'A2,A33').split(',').map((s) => s.trim()).filter((s) => /^[A-Z]\d{1,4}$/.test(s));
const LAGE_MIN = Number(process.env.LAGE_MIN || 5);

async function getJson(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'Flowtown/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const inBox = (lat, lon, m) => lon >= LAGE_BBOX[0] - m && lon <= LAGE_BBOX[2] + m && lat >= LAGE_BBOX[1] - m && lat <= LAGE_BBOX[3] + m;
// höchstens 24 Punkte je Abschnitt, erster und letzter bleiben
function thin(pts) {
  const ok = pts.filter((p) => isFinite(p[0]) && isFinite(p[1])).map((p) => [r5(p[0]), r5(p[1])]);
  if (ok.length <= 24) return ok;
  const step = (ok.length - 1) / 23;
  return Array.from({ length: 24 }, (_, i) => ok[Math.round(i * step)]);
}
const herePts = (loc) => thin([].concat(...((loc && loc.shape && loc.shape.links) || []).map((l) => (l.points || []).map((q) => [q.lat, q.lng]))));
const kmh = (ms) => Math.round(ms * 3.6);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// HERE Verkehrsfluss: nur Abschnitte, auf denen es hakt (Jam-Faktor ab 4 von 10), Richtung zählt
async function hereFlow() {
  const j = await getJson(`${HERE_URL}/flow?in=bbox:${LAGE_BBOX.join(',')}&locationReferencing=shape&minJamFactor=4&apiKey=${encodeURIComponent(HERE_KEY)}`);
  const out = [];
  for (const r of j.results || []) {
    const cf = r.currentFlow || {}, loc = r.location || {};
    const pts = herePts(loc);
    if (pts.length < 2) continue;
    const len = Number(loc.length) || 0;
    const spd = Number(cf.speedUncapped != null ? cf.speedUncapped : cf.speed), ff = Number(cf.freeFlow);
    const closed = cf.traversability === 'closed';
    const delay = !closed && spd > 0.3 && ff > spd ? Math.round(len / spd - len / ff) : null;
    if (!closed && (delay == null || delay < 10)) continue;   // kurze Abschnitte mit wenigen Sekunden Verlust sind Rauschen
    out.push({
      id: 'hf' + crypto.createHash('sha1').update(JSON.stringify(pts[0]) + JSON.stringify(pts[pts.length - 1])).digest('hex').slice(0, 10),
      quelle: 'HERE', art: closed ? 'sperrung' : cf.jamFactor >= 8 ? 'stau' : 'zaeh', richtung: true,
      titel: clip(loc.description || 'Straße', 60), text: closed ? 'gesperrt' : `Ø ${kmh(spd)} km/h statt ${kmh(ff)} km/h`, delay, pts
    });
  }
  return out;
}
const HERE_ART = { accident: 'unfall', congestion: 'stau', construction: 'baustelle', roadClosure: 'sperrung', laneRestriction: 'baustelle', disabledVehicle: 'warnung', roadHazard: 'warnung', plannedEvent: 'warnung', weather: 'warnung', massTransit: 'warnung', other: 'warnung' };
async function hereIncidents() {
  const j = await getJson(`${HERE_URL}/incidents?in=bbox:${LAGE_BBOX.join(',')}&locationReferencing=shape&lang=de-DE&apiKey=${encodeURIComponent(HERE_KEY)}`);
  const out = [];
  for (const r of j.results || []) {
    const d = r.incidentDetails || {}, loc = r.location || {};
    const pts = herePts(loc);
    if (!pts.length) continue;
    const sum = d.summary && d.summary.value, desc = d.description && d.description.value;
    out.push({
      id: 'hi' + String(d.id || d.originalId || out.length).slice(-16), quelle: 'HERE',
      art: d.roadClosed ? 'sperrung' : HERE_ART[d.type] || 'warnung',
      titel: clip(loc.description || sum || 'Meldung', 60), text: clip(desc || sum || '', 220), bis: d.endTime || null, pts
    });
  }
  return out;
}
// Autobahn GmbH des Bundes: Warnungen, Sperrungen, Baustellen auf den Autobahnen rund um Bielefeld (offen, ohne Schlüssel)
const AB_SVC = { warning: 'warnung', closure: 'sperrung', roadworks: 'baustelle' };
async function autobahn() {
  const jobs = [];
  for (const road of LAGE_ROADS) for (const svc of Object.keys(AB_SVC)) jobs.push(getJson(`${AUTOBAHN_URL}/${road}/services/${svc}`).then((j) => ({ svc, list: j[svc] || [] })));
  const done = await Promise.allSettled(jobs);
  if (done.length && done.every((r) => r.status === 'rejected')) throw new Error('nicht erreichbar: ' + done[0].reason.message);
  const out = [];
  for (const res of done) {
    if (res.status !== 'fulfilled') continue;
    for (const x of res.value.list) {
      if (!x || x.future || x.display_type === 'WEIGHT_LIMIT_35') continue;
      const lat = Number(x.coordinate && x.coordinate.lat), lon = Number(x.coordinate && x.coordinate.long);
      if (!inBox(lat, lon, 0.05)) continue;
      const geo = x.geometry && x.geometry.type === 'LineString' && Array.isArray(x.geometry.coordinates) ? x.geometry.coordinates.map((c) => [c[1], c[0]]) : [];
      const pts = thin(geo.length ? geo : [[lat, lon]]);
      let art = AB_SVC[res.value.svc];
      if (art === 'warnung' && /STATIONARY|QUEUING|SLOW/.test(x.abnormalTrafficType || '')) art = 'stau';
      const lines = (x.description || []).map(String).filter((s) => s.trim() && !/^(Beginn|Ende):/.test(s));
      const delay = Number(x.delayTimeValue) > 0 ? Number(x.delayTimeValue) * 60 : null;
      out.push({
        id: 'ab' + String(x.identifier || '').slice(-16), quelle: 'Autobahn GmbH', art,
        titel: clip(x.title || 'Autobahn', 60), richtungText: clip(x.subtitle || '', 60), text: clip(lines.join(' '), 220), delay, pts
      });
    }
  }
  return out;
}

const lage = { here: { items: [], t: 0 }, autobahn: { items: [], t: 0 } };
let lageAt = 0, lageRun = null;
async function refreshLage() {
  const jobs = { autobahn: autobahn() };
  if (HERE_KEY) jobs.here = Promise.all([hereFlow(), hereIncidents()]).then(([a, b]) => a.concat(b));
  for (const [name, job] of Object.entries(jobs)) {
    try { lage[name] = { items: await job, t: Date.now() }; }
    catch (e) { console.error(new Date().toISOString(), 'Lage', name, e.message); }   // ältere Werte bleiben bis 30 Minuten stehen
  }
  lageAt = Date.now();
}
async function readLage() {
  if (Date.now() - lageAt > LAGE_MIN * 60000) {
    lageRun = lageRun || refreshLage().finally(() => { lageRun = null; });
    await lageRun;
  }
  const fresh = Object.entries(lage).filter(([, v]) => v.t && Date.now() - v.t < 30 * 60000);
  return {
    t: Math.min(...fresh.map(([, v]) => v.t).concat(lageAt || Date.now())),
    quellen: fresh.map(([k, v]) => ({ name: k === 'here' ? 'HERE' : 'Autobahn GmbH', t: v.t })),
    items: [].concat(...fresh.map(([, v]) => v.items))
  };
}

// ---------- HTTP ----------
function send(res, status, obj, origin) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin && ORIGINS.includes(origin)) Object.assign(h, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
  res.writeHead(status, h);
  res.end(obj == null ? '' : JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('zu groß'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(Object.assign(new Error('kein JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/flowtown-api/, '');   // läuft auch hinter einem Pfad im Webserver
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'OPTIONS') return send(res, 204, null, origin);
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, ki: !!MISTRAL_KEY, modell: MISTRAL_MODEL, kMin: K_MIN, lage: { here: !!HERE_KEY, autobahn: LAGE_ROADS } }, origin);
    if (req.method === 'POST' && p === '/api/wir') return send(res, 200, { ok: true, n: addWir(await readBody(req, 64 * 1024)) }, origin);
    if (req.method === 'GET' && p === '/api/wir') {
      const ids = (url.searchParams.get('s') || '').split(',').filter((s) => /^c\d{1,13}$/.test(s)).slice(0, 400);
      return send(res, 200, { kMin: K_MIN, werte: readWir(ids) }, origin);
    }
    if (req.method === 'POST' && p === '/api/ki') {
      if (!kiAllowed(ip)) return send(res, 429, { fehler: 'Heute sind keine weiteren KI-Einschätzungen möglich.' }, origin);
      const body = await readBody(req, 48 * 1024);
      return send(res, 200, await askMistral(body.facts || {}), origin);
    }
    if (req.method === 'GET' && p === '/api/lage') return send(res, 200, await readLage(), origin);
    if (req.method === 'GET' && p === '/api/news') return send(res, 200, { meldungen: readNews() }, origin);
    return send(res, 404, { fehler: 'unbekannt' }, origin);
  } catch (e) {
    const status = e.status || (e.message === 'cid' || e.message === 'items' ? 400 : 500);
    if (status >= 500) console.error(new Date().toISOString(), p, e.message);
    return send(res, status, { fehler: status >= 500 ? 'Serverfehler' : e.message }, origin);
  }
});
server.listen(PORT, HOST, () => console.log(`Flowtown-Server auf ${HOST}:${PORT}, KI ${MISTRAL_KEY ? 'an (' + MISTRAL_MODEL + ')' : 'aus'}, Verkehrslage: Autobahn ${LAGE_ROADS.join('/')}${HERE_KEY ? ' + HERE' : ''}`));
