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

// Tageslimit je IP, getrennt nach Zweck
function limiter(max) {
  const count = new Map();   // IP → { day, n }
  return (ip) => {
    const day = new Date().toISOString().slice(0, 10);
    const e = count.get(ip);
    if (!e || e.day !== day) { count.set(ip, { day, n: 1 }); return true; }
    if (e.n >= max) return false;
    e.n += 1;
    return true;
  };
}
const kiAllowed = limiter(KI_PER_DAY);
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
      quelle: 'HERE', richtung: true, art: closed ? 'sperrung' : cf.jamFactor >= 8 ? 'stau' : 'zaeh', richtung: true,
      titel: clip(loc.description || 'Straße', 60), text: closed ? 'gesperrt' : `Ø ${kmh(spd)} km/h statt ${kmh(ff)} km/h`, delay, pts
    });
  }
  return out;
}
const HERE_ART = { accident: 'unfall', congestion: 'stau', construction: 'baustelle', roadClosure: 'sperrung', laneRestriction: 'baustelle', disabledVehicle: 'warnung', roadHazard: 'warnung', plannedEvent: 'warnung', weather: 'warnung', massTransit: 'warnung', other: 'warnung' };
async function hereIncidents(box) {
  const j = await getJson(`${HERE_URL}/incidents?in=bbox:${(box || LAGE_BBOX).map((x) => x.toFixed(4)).join(',')}&locationReferencing=shape&lang=de-DE&apiKey=${encodeURIComponent(HERE_KEY)}`);
  const out = [];
  for (const r of j.results || []) {
    const d = r.incidentDetails || {}, loc = r.location || {};
    const pts = herePts(loc);
    if (!pts.length) continue;
    const sum = d.summary && d.summary.value, desc = d.description && d.description.value;
    out.push({
      id: 'hi' + String(d.id || d.originalId || out.length).slice(-16), quelle: 'HERE', richtung: pts.length > 1,
      art: d.roadClosed ? 'sperrung' : HERE_ART[d.type] || 'warnung',
      titel: clip(loc.description || sum || 'Meldung', 60), text: clip(desc || sum || '', 220), bis: d.endTime || null, pts
    });
  }
  return out;
}
// Autobahn GmbH des Bundes: Warnungen, Sperrungen, Baustellen auf den Autobahnen rund um Bielefeld (offen, ohne Schlüssel)
const AB_SVC = { warning: 'warnung', closure: 'sperrung', roadworks: 'baustelle' };
// je Autobahn höchstens alle LAGE_MIN Minuten abrufen; gilt für die Stadtlage und für Strecken
const abCache = new Map();   // Straße → { t, items, run }
async function abRoad(road) {
  const c = abCache.get(road);
  if (c && Date.now() - c.t < LAGE_MIN * 60000) return c.items;
  if (c && c.run) return c.run;
  const run = (async () => {
    const done = await Promise.allSettled(Object.keys(AB_SVC).map((svc) => getJson(`${AUTOBAHN_URL}/${road}/services/${svc}`).then((j) => ({ svc, list: j[svc] || [] }))));
    if (done.every((r) => r.status === 'rejected')) throw new Error('nicht erreichbar: ' + done[0].reason.message);
    const out = [];
    for (const res of done) {
      if (res.status !== 'fulfilled') continue;
      for (const x of res.value.list) {
        if (!x || x.future || x.display_type === 'WEIGHT_LIMIT_35') continue;
        const lat = Number(x.coordinate && x.coordinate.lat), lon = Number(x.coordinate && x.coordinate.long);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const geo = x.geometry && x.geometry.type === 'LineString' && Array.isArray(x.geometry.coordinates) ? x.geometry.coordinates.map((g) => [g[1], g[0]]) : [];
        const pts = thin(geo.length ? geo : [[lat, lon]]);
        let art = AB_SVC[res.value.svc];
        if (art === 'warnung' && /STATIONARY|QUEUING|SLOW/.test(x.abnormalTrafficType || '')) art = 'stau';
        const lines = (x.description || []).map(String).filter((t) => t.trim() && !/^(Beginn|Ende):/.test(t));
        const delay = Number(x.delayTimeValue) > 0 ? Number(x.delayTimeValue) * 60 : null;
        out.push({
          id: 'ab' + String(x.identifier || '').slice(-16), quelle: 'Autobahn GmbH', art,
          titel: clip(x.title || road, 60), richtungText: clip(x.subtitle || '', 60), text: clip(lines.join(' '), 220), delay, pts
        });
      }
    }
    abCache.set(road, { t: Date.now(), items: out });
    return out;
  })();
  abCache.set(road, Object.assign({}, c || { t: 0, items: [] }, { run }));
  try { return await run; } catch (e) { if (c && c.items.length && Date.now() - c.t < 30 * 60000) { abCache.set(road, c); return c.items; } abCache.delete(road); throw e; }
}
async function autobahn() {
  const done = await Promise.allSettled(LAGE_ROADS.map(abRoad));
  if (done.length && done.every((r) => r.status === 'rejected')) throw new Error(done[0].reason.message);
  return [].concat(...done.filter((r) => r.status === 'fulfilled').map((r) => r.value)).filter((it) => it.pts.some((q) => inBox(q[0], q[1], 0.05)));
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

// ---------- Ziel prüfen: Strecke mit Verkehr, Meldungen entlang der Strecke, beste Abfahrt ----------
// Nur auf Knopfdruck. Der Start kommt auf etwa 1 km gerundet an, gespeichert wird nichts außer einem kurzen Zwischenspeicher.
const ROUTER_URL = process.env.HERE_ROUTER_URL || 'https://router.hereapi.com/v8/routes';
const GEOCODE_URL = process.env.HERE_GEOCODE_URL || 'https://geocode.search.hereapi.com/v1/geocode';
const REVGEO_URL = process.env.HERE_REVGEO_URL || 'https://revgeocode.search.hereapi.com/v1/revgeocode';
const ZIEL_PER_DAY = Number(process.env.ZIEL_PER_DAY || 40);
const zielAllowed = limiter(ZIEL_PER_DAY), ortAllowed = limiter(ZIEL_PER_DAY);

// HEREs „Flexible Polyline“ entpacken (ohne Bibliothek, mit Gleitkomma statt Bitoperationen, damit große Werte stimmen)
const FP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function decodeFlex(str) {
  let i = 0;
  const next = () => {
    let res = 0, mul = 1, v;
    do {
      v = FP.indexOf(str[i++]);
      if (v < 0) throw new Error('polyline');
      res += (v & 31) * mul; mul *= 32;
    } while (v & 32);
    return res;
  };
  const signed = (u) => (u % 2 ? -(u + 1) / 2 : u / 2);
  if (next() !== 1) throw new Error('polyline version');
  const head = next(), prec = 10 ** (head % 16), third = Math.floor(head / 16) % 8;
  const out = [];
  let lat = 0, lon = 0;
  while (i < str.length) {
    lat += signed(next()); lon += signed(next());
    if (third) next();
    out.push([lat / prec, lon / prec]);
  }
  return out;
}
// Geometrie in Metern (flache Näherung je Punkt)
const R = Math.PI / 180;
function segDist(p, a, b) {
  const kx = 111320 * Math.cos(p[0] * R), ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const u = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  return Math.hypot(ax + u * dx, ay + u * dy);
}
const brg = (a, b) => (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * R), b[0] - a[0]) / R + 360) % 360;
const angGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
// nächster Abschnitt der Strecke zu einem Punkt: Abstand und Fahrtrichtung dort
function nearRoute(p, route) {
  let best = { d: Infinity, h: 0, i: 0 };
  for (let k = 0; k < route.length - 1; k++) {
    const d = segDist(p, route[k], route[k + 1]);
    if (d < best.d) best = { d, h: brg(route[k], route[k + 1]), i: k };
  }
  return best;
}
// Liegt eine Meldung auf der Strecke, und zwar in Fahrtrichtung? Eng gefasst, damit Nebenstraßen und Auffahrten draußen bleiben.
function onRoute(it, route, tol) {
  const near = it.pts.map((q) => Object.assign({ q }, nearRoute(q, route))).filter((m) => m.d <= tol);
  if (!near.length || (it.pts.length > 1 && near.length < Math.min(2, it.pts.length))) return null;
  if (near.length >= 2) {
    const a = near[0].q, b = near[near.length - 1].q;
    if ((Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) > 0.0002 && angGap(brg(a, b), near[0].h) > 45) return null;   // Gegenrichtung oder Querstraße
  }
  return near[0].i;
}
// Strecke in Rechtecke von höchstens 0,9 Grad teilen (Grenze der Verkehrsabfrage)
function boxesAlong(route) {
  const boxes = [];
  let box = null;
  for (const p of route) {
    const nb = box ? [Math.min(box[0], p[1]), Math.min(box[1], p[0]), Math.max(box[2], p[1]), Math.max(box[3], p[0])] : [p[1], p[0], p[1], p[0]];
    if (box && (nb[2] - nb[0] > 0.9 || nb[3] - nb[1] > 0.9)) { boxes.push(box); box = [p[1], p[0], p[1], p[0]]; } else box = nb;
  }
  if (box) boxes.push(box);
  return boxes.map((b) => [b[0] - 0.01, b[1] - 0.01, b[2] + 0.01, b[3] + 0.01]);
}
const txt = (v) => (v == null ? '' : typeof v === 'string' ? v : v.value || '');
// Strecke von HERE: Geometrie, Straßennummern und -namen je Abschnitt, Störungen, die auf genau dieser Strecke liegen
async function hereRoute(from, to, mode, opts) {
  const q = new URLSearchParams({ transportMode: mode === 'rad' ? 'bicycle' : 'car', origin: from.join(','), destination: to.join(','), apiKey: HERE_KEY });
  if (opts.full) { q.set('return', 'summary,polyline,typicalDuration,incidents'); q.set('spans', 'routeNumbers,names,incidents'); q.set('lang', 'de-DE'); if (mode !== 'rad') q.set('alternatives', '1'); }
  else q.set('return', 'summary');
  if (opts.at) q.set('departureTime', opts.at);
  const j = await getJson(`${ROUTER_URL}?${q}`, 12000);
  return (j.routes || []).map((r) => {
    const secs = r.sections || [];
    const sum = (k) => secs.reduce((a, x) => a + (Number(x.summary && x.summary[k]) || 0), 0);
    const pts = [], spans = [], roads = [];
    let incs = null;
    if (opts.full) {
      for (const x of secs) {
        const base = pts.length;
        const sp = x.polyline ? decodeFlex(x.polyline) : [];
        pts.push(...sp);
        for (const s of x.spans || []) {
          const num = (s.routeNumbers || []).map((n) => txt(n).replace(/\s+/g, '')).find(Boolean) || '';
          const name = (s.names || []).map(txt).find(Boolean) || '';
          spans.push({ i: base + (Number(s.offset) || 0), num, name, inc: Array.isArray(s.incidents) ? s.incidents : [] });
          if (num && !roads.includes(num)) roads.push(num);
        }
        if (Array.isArray(x.incidents)) {
          incs = incs || [];
          const spx = spans.filter((s) => s.i >= base);
          x.incidents.forEach((d, k) => {
            const mine = spx.filter((s) => s.inc.includes(k));
            const i0 = mine.length ? mine[0].i : null;
            const last = mine.length ? spans[spans.indexOf(mine[mine.length - 1]) + 1] : null;
            const i1 = last ? last.i : i0 != null ? Math.min(pts.length - 1, i0 + 1) : null;
            incs.push({ d, i0, i1 });
          });
        }
      }
    }
    return { dauer: sum('duration'), basis: sum('baseDuration') || sum('typicalDuration') || sum('duration'), m: sum('length'), pts, spans, roads, incs };
  });
}
// Ort zu einem Punkt (für „A2 bei Kamen“), einen Tag zwischengespeichert
const ortCache = new Map();
async function placeNear(p) {
  const key = p.map((x) => (Math.round(x * 50) / 50).toFixed(2)).join(',');
  const c = ortCache.get(key);
  if (c && Date.now() - c.t < 864e5) return c.v;
  let v = '';
  try {
    const jj = await getJson(`${REVGEO_URL}?${new URLSearchParams({ at: p.join(','), lang: 'de-DE', apiKey: HERE_KEY })}`, 6000);
    const a = (jj.items && jj.items[0] && jj.items[0].address) || {};
    v = a.city || a.county || '';
  } catch (e) { /* ohne Ortsnamen weiter */ }
  ortCache.set(key, { t: Date.now(), v });
  if (ortCache.size > 5000) ortCache.delete(ortCache.keys().next().value);
  return v;
}
// „A2 | AS Kamen-Zentrum (15) - AS Unna (16)“ → „A2 zwischen Kamen-Zentrum und Unna“
function abTitle(t) {
  const [road, rest] = String(t).split('|').map((s) => s.trim());
  if (!rest) return t;
  const ends = rest.split(/\s+-\s+/).map((s) => s.replace(/^(AS|AK|AD|Kreuz|Dreieck|Anschlussstelle)\s+/i, '').replace(/\s*\(\d+[a-z]?\)\s*$/i, '').trim());
  return ends.length === 2 ? `${road} zwischen ${ends[0]} und ${ends[1]}` : `${road} bei ${ends[0]}`;
}
const HERE_TYP = Object.assign({}, HERE_ART, { congestion: 'stau', accident: 'unfall' });
// Abfahrtszeiten: jetzt, dann volle und halbe Stunden ab einer Viertelstunde von jetzt
function slots(now) {
  const t = new Date(now + 15 * 60000);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() <= 30 && t.getMinutes() > 0 ? 30 : t.getMinutes() === 0 ? 0 : 60);
  return [0, 1, 2, 3].map((k) => new Date(t.getTime() + k * 30 * 60000));
}
const zielCache = new Map();   // kurzer Zwischenspeicher gegen Doppel-Tipps, 3 Minuten
async function checkZiel(from, to, mode) {
  const key = [from, to, mode].join('|');
  const hit = zielCache.get(key);
  if (hit && Date.now() - hit.t < 180000) return hit.v;
  const [main, ...alts] = await hereRoute(from, to, mode, { full: true });
  if (!main || main.pts.length < 2) throw Object.assign(new Error('Keine Strecke gefunden'), { status: 404 });
  const P = main.pts;
  const cum = [0];
  for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + segDist(P[k], P[k - 1], P[k - 1]));
  const roadAt = (i) => { let s = null; for (const x of main.spans) { if (x.i <= i) s = x; else break; } return s || {}; };
  const keep = (art) => mode !== 'rad' || ['sperrung', 'baustelle', 'unfall'].includes(art);
  const items = [];
  // 1. Störungen, die HERE selbst der Strecke zuordnet
  if (main.incs) {
    main.incs.forEach(({ d, i0, i1 }, k) => {
      const art = d.roadClosed || d.type === 'roadClosure' ? 'sperrung' : HERE_TYP[d.type] || 'warnung';
      if (i0 == null || !keep(art)) return;
      items.push({ id: 'ri' + String(d.id || k).slice(-16), quelle: 'HERE', art, at: i0, text: clip(txt(d.description) || txt(d.summary), 220), bis: d.validUntil || d.endTime || null, pts: thin(P.slice(i0, Math.max(i0 + 1, i1) + 1)) });
    });
  }
  // 2. ohne Zuordnung von HERE: Störungen im Umkreis, eng auf die Strecke gelegt
  const jobs = main.incs ? [] : boxesAlong(P.filter((p, k) => k % 3 === 0)).map((b) => hereIncidents(b));
  const autobahns = main.roads.filter((r) => /^A\d{1,3}$/.test(r)).slice(0, 8);
  const nJobs = jobs.length;
  jobs.push(...autobahns.map(abRoad));
  const seen = new Set(items.map((x) => x.id));
  (await Promise.allSettled(jobs)).forEach((r, n) => {
    if (r.status !== 'fulfilled') return;
    for (const it of r.value) {
      if (seen.has(it.id) || !keep(it.art)) continue;
      const fromAb = n >= nJobs;
      if (fromAb && main.incs && !['sperrung', 'stau'].includes(it.art)) continue;   // Baustellen meldet HERE schon auf der Strecke
      const at = onRoute(it, P, fromAb && it.pts.length === 1 ? 60 : 30);
      if (at == null) continue;
      seen.add(it.id);
      items.push(Object.assign({}, it, { at, titel: fromAb ? abTitle(it.titel) : null }));
    }
  });
  // Straße und Ort benennen: „A2 bei Kamen“, sortiert nach Schwere und Lage
  const RANK = { sperrung: 0, stau: 1, unfall: 2, zaeh: 3, baustelle: 4, warnung: 5 };
  items.sort((a, b) => RANK[a.art] - RANK[b.art] || a.at - b.at);
  await Promise.all(items.slice(0, 8).map(async (it) => {
    if (it.titel) return;
    const rd = roadAt(it.at), town = await placeNear(P[it.at]);
    const road = rd.num || rd.name || '';
    it.titel = clip(road && town ? (rd.num ? `${road} bei ${town}` : `${road}, ${town}`) : road || town || it.text || 'Meldung', 60);
  }));
  for (const it of items) { if (!it.titel) it.titel = clip(roadAt(it.at).num || roadAt(it.at).name || it.text || 'Meldung', 60); it.km = Math.round(cum[it.at] / 1000); delete it.at; }
  // Abfahrtsleiste (nur Auto): jetzt plus vier Zeiten, mit HEREs Vorhersage
  let abfahrt = null;
  if (mode !== 'rad') {
    const ts = slots(Date.now());
    const later = await Promise.allSettled(ts.map((t) => hereRoute(from, to, mode, { at: t.toISOString() })));
    abfahrt = [{ t: null, dauer: main.dauer }].concat(later.map((r, k) => (r.status === 'fulfilled' && r.value[0] ? { t: ts[k].toISOString(), dauer: r.value[0].dauer } : null)).filter(Boolean));
  }
  const alt = alts.find((a) => main.dauer - a.dauer >= 600);
  const v = {
    t: Date.now(), mode, dauer: main.dauer, basis: main.basis, km: Math.round(main.m / 100) / 10, strassen: main.roads.slice(0, 6),
    pts: thin2(main.pts, 160), items, abfahrt,
    alternative: alt ? { dauer: alt.dauer, strassen: alt.roads.filter((r) => !main.roads.includes(r)).slice(0, 3) } : null
  };
  zielCache.set(key, { t: Date.now(), v });
  if (zielCache.size > 200) zielCache.delete(zielCache.keys().next().value);
  return v;
}
function thin2(pts, n) {
  if (pts.length <= n) return pts.map((p) => [r5(p[0]), r5(p[1])]);
  const step = (pts.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, k) => pts[Math.round(k * step)]).map((p) => [r5(p[0]), r5(p[1])]);
}
async function findOrt(q) {
  const u = `${GEOCODE_URL}?${new URLSearchParams({ q, limit: '3', lang: 'de-DE', in: 'countryCode:DEU,NLD,BEL,LUX,FRA,CHE,AUT,DNK,POL,CZE', apiKey: HERE_KEY })}`;
  const j = await getJson(u);
  return (j.items || []).filter((x) => x.position).slice(0, 3).map((x) => {
    const a = x.address || {};
    const name = a.street ? `${a.street}${a.houseNumber ? ' ' + a.houseNumber : ''}, ${a.city || ''}` : a.city || a.label || x.title;
    return { name: clip(name, 50), sub: clip([a.postalCode, a.city !== name ? a.city : '', a.state, a.countryName !== 'Deutschland' ? a.countryName : ''].filter(Boolean).join(' · '), 70), lat: r5(x.position.lat), lon: r5(x.position.lng) };
  });
}
const coord = (s, digits) => {
  const v = String(s || '').split(',').map(Number);
  if (v.length !== 2 || !(Math.abs(v[0]) <= 90) || !(Math.abs(v[1]) <= 180)) throw Object.assign(new Error('Koordinaten'), { status: 400 });
  const f = 10 ** digits;
  return v.map((x) => Math.round(x * f) / f);
};

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
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, ki: !!MISTRAL_KEY, modell: MISTRAL_MODEL, kMin: K_MIN, lage: { here: !!HERE_KEY, autobahn: LAGE_ROADS }, ziel: !!HERE_KEY }, origin);
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
    if (req.method === 'GET' && (p === '/api/ort' || p === '/api/ziel')) {
      if (!HERE_KEY) return send(res, 503, { fehler: 'Ziel-Prüfung braucht einen HERE-Schlüssel auf dem Server.' }, origin);
      if (p === '/api/ort') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
        if (q.length < 2) return send(res, 400, { fehler: 'Bitte einen Ort eingeben.' }, origin);
        if (!ortAllowed(ip)) return send(res, 429, { fehler: 'Heute sind keine weiteren Suchen möglich.' }, origin);
        return send(res, 200, { orte: await findOrt(q) }, origin);
      }
      const from = coord(url.searchParams.get('from'), 2), to = coord(url.searchParams.get('to'), 4);   // Start auf etwa 1 km gerundet
      const mode = url.searchParams.get('mode') === 'rad' ? 'rad' : 'auto';
      if (!zielAllowed(ip)) return send(res, 429, { fehler: 'Heute sind keine weiteren Prüfungen möglich.' }, origin);
      return send(res, 200, await checkZiel(from, to, mode), origin);
    }
    if (req.method === 'GET' && p === '/api/news') return send(res, 200, { meldungen: readNews() }, origin);
    return send(res, 404, { fehler: 'unbekannt' }, origin);
  } catch (e) {
    const status = e.status || (e.message === 'cid' || e.message === 'items' ? 400 : 500);
    if (status >= 500) console.error(new Date().toISOString(), p, e.message);
    return send(res, status, { fehler: status >= 500 ? 'Serverfehler' : e.message }, origin);
  }
});
server.listen(PORT, HOST, () => console.log(`Flowtown-Server auf ${HOST}:${PORT}, KI ${MISTRAL_KEY ? 'an (' + MISTRAL_MODEL + ')' : 'aus'}, Verkehrslage: Autobahn ${LAGE_ROADS.join('/')}${HERE_KEY ? ' + HERE' : ''}`));
