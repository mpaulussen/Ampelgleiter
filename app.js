/* Flowtown Prototyp: zeichnet Halte und Durchfahrten an Ampeln auf. Alle Daten bleiben im Browser. */
(function () {
  'use strict';

  const VERSION = '0.14.1';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // Schwellen je Verkehrsmittel: unter stopV gilt als stehend, über goV als fahrend (m/s)
  const MODES = {
    auto: { label: 'Auto',      stopV: 1.4,  goV: 2.5, haltRadius: 70, passRadius: 25, vRef: 13.9 },
    rad:  { label: 'Rad',       stopV: 0.9,  goV: 1.8, haltRadius: 40, passRadius: 20, vRef: 5.5 },
    bus:  { label: 'Bus',       stopV: 1.4,  goV: 2.5, haltRadius: 70, passRadius: 25, vRef: 13.9 },
    bahn: { label: 'Stadtbahn', stopV: 1.4,  goV: 2.5, haltRadius: 60, passRadius: 25, vRef: 13.9 },
    fuss: { label: 'Zu Fuß',    stopV: 0.35, goV: 0.8, haltRadius: 30, passRadius: 18, vRef: 1.3 }
  };
  const STOP_CONFIRM_MS = 3000;   // so lange langsam, bis ein Halt zählt
  const GO_CONFIRM_MS = 2000;     // so lange schneller, bis der Halt endet
  const MIN_WAIT_MS = 3000;       // kürzere Halte werden ignoriert
  const MERGE_MS = 120000;        // Halte an derselben Ampel innerhalb dieser Zeit = ein Wartevorgang
  const QUEUE_M = 250;            // Rückstau: Halt bis zu diesem Abstand vor einer Ampel, durch die man danach fährt
  const QUEUE_MS = 120000;        // ... wenn die Durchfahrt höchstens so lange nach dem Halt kommt
  const MAX_ACCURACY = 50;        // ungenauere GPS-Punkte werden verworfen
  const CLUSTER_M = 40;           // Signalstandorte in diesem Abstand zueinander bilden eine Kreuzung
  const CLUSTER_MAX_M = 70;       // ... solange die Kreuzung nicht weiter ausgedehnt ist
  const JUNCTION_M = 50;          // zwei Ampeln direkt hintereinander, so nah beieinander: ein Kreuzungsbereich
  const JUNCTION_MS = 60000;      // ... wenn höchstens so viel Zeit dazwischen liegt
  const STOP_M = 60;              // Bus und Bahn: Halt so nah an einer Haltestelle ist ein Haltestellenhalt
  const GAP_MS = 15000;           // so lange ohne brauchbaren GPS-Punkt: Empfangslücke, z. B. im Tunnel
  const AREA_RADIUS = 5000;       // Umkreis für das Laden der Ampeln
  const TAGS = ['zu lange gewartet', 'Grün zu kurz', 'unübersichtlich', 'Anschluss verpasst', 'alles gut'];
  const ACC_TAGS = ['Grün zu kurz zum Queren', 'kein Tonsignal', 'Taster schlecht erreichbar', 'Bordstein zu hoch'];   // Profil barrierefrei
  const ACCESS_LABEL = { rollstuhl: 'Rollstuhl', rollator: 'Rollator oder langsames Gehen', sehen: 'Sehbehinderung', andere: 'andere Einschränkung' };
  // Zu Fuß ist man einen Weg gegangen, nicht gefahren
  const WORDS = {
    fahrt: { one: 'Fahrt', many: 'Fahrten', none: 'Noch keine Fahrt', start: 'Fahrt starten', end: 'Fahrt beenden', cont: 'Weiterfahren', time: 'Fahrzeit',
      past: 'gefahren', bilanz: 'Fahrtbilanz', last: 'Letzte Fahrt', review: 'Wie war deine Fahrt?', short: 'Die Fahrt war zu kurz und wurde nicht gespeichert.',
      hold: 'Handy in die Halterung, App geöffnet lassen. Der Bildschirm bleibt an.', during: 'Während der Fahrt nichts antippen. Bewertet wird erst danach.' },
    weg: { one: 'Weg', many: 'Wege', none: 'Noch kein Weg', start: 'Weg starten', end: 'Weg beenden', cont: 'Weitergehen', time: 'Gehzeit',
      past: 'gegangen', bilanz: 'Wegbilanz', last: 'Letzter Weg', review: 'Wie war dein Weg?', short: 'Der Weg war zu kurz und wurde nicht gespeichert.',
      hold: 'Handy in der Hand oder in der Tasche, App geöffnet lassen. Der Bildschirm bleibt an.', during: 'Unterwegs nichts antippen. Bewertet wird erst danach.' }
  };
  const words = (mode) => WORDS[mode === 'fuss' ? 'weg' : 'fahrt'];
  function applyModeWords(mode) {
    const w = words(mode);
    $('#btn-start-label').textContent = w.start;
    $('#hint-hold').textContent = w.hold;
    $('#hint-during').textContent = w.during;
    $('#btn-end-label').textContent = w.end;
    $('#btn-cont-label').textContent = w.cont;
    $('#lbl-drive-time').textContent = w.time;
  }
  const STEADY_MIN_V = 8.33;      // Gleichmäßigkeit zählt ab 30 km/h
  const STEADY_TOL = 1.39;        // ±5 km/h um das Mittel der letzten Minute
  const HARD_BRAKE = -3.0;        // starke Bremsung ab 3 m/s² Verzögerung
  const HARD_ACCEL = 2.5;         // starkes Beschleunigen ab 2,5 m/s²
  // Schätzwerte für die Kosten der Ampelhalte (offen angezeigt)
  const IDLE_L_PER_H = 0.8;       // Leerlauf Verbrenner, Liter je Stunde
  const RESTART_L = 0.02;         // Mehrverbrauch je Wiederanfahren auf etwa 50 km/h, Liter
  const IDLE_KWH_PER_H = 0.5;     // E-Auto im Stand (Heizung, Elektronik), kWh je Stunde
  const RESTART_KWH = 0.03;       // E-Auto je Wiederanfahren, kWh (mit Rückgewinnung)
  // Flow-Raster: Felder von etwa 150 × 150 m
  const CELL_LAT = 0.00135, CELL_LON = 0.0022;
  const WINDOWS = [
    { id: 'all', label: 'Alle Zeiten' },
    { id: 'wd-morning', label: 'Werktags 6–9 Uhr' },
    { id: 'wd-day', label: 'Werktags 9–16 Uhr' },
    { id: 'wd-evening', label: 'Werktags 16–19 Uhr' },
    { id: 'night', label: 'Abends und nachts (19–6 Uhr)' },
    { id: 'weekend', label: 'Wochenende 6–19 Uhr' }
  ];
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

  // ---------- Speicher ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ww.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ww.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  let trips = store.get('trips', []);
  let settings = Object.assign({ mode: 'auto', cut: 200, fuelPrice: 1.75, powerPrice: 0.35, access: { on: false, type: 'rollator' }, server: { url: '', wir: false, ki: false } }, store.get('settings', {}));
  let signalCache = store.get('signals', { areas: [], nodes: {} });
  // Haltestellen ab 0.9.0, Angaben zur Barrierefreiheit ab 0.10.0: Gebiete einmal neu laden
  // Haltestellennamen ab 0.12.0 (Umstiege)
  if (!signalCache.stops || !signalCache.acc || signalCache.v !== 3) { signalCache.stops = {}; signalCache.acc = signalCache.acc || {}; signalCache.areas = []; signalCache.v = 3; }
  let names = store.get('names3', {});   // 'names3': Querstraßen ohne Bahnsteignamen (ab 0.9.0)
  const names2 = store.get('names2', {}); // mit Querstraße (0.6.0 bis 0.8.0)
  const oldNames = store.get('names', {}); // nur Straße (bis 0.5.0), als Übergang bis die neuen Namen da sind
  const nameOf = (id) => names[id] || names2[id] || oldNames[id] || null;
  let clusters = [];   // wird beim Start aus den gespeicherten Ampeln aufgebaut
  let alias = {};      // 'c' + Signalstandort -> Kreuzung, damit ältere Fahrten zur aktuellen Einteilung passen
  let clusterById = {};
  const saveTrips = () => store.set('trips', trips);

  // ---------- Geometrie ----------
  const toR = Math.PI / 180;
  function dist(a, b) {
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
    const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
    return (Math.atan2(y, x) / toR + 360) % 360;
  }
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const DIRS = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
  const dirName = (h) => (h == null ? '' : 'Richtung ' + DIRS[Math.round(h / 45) % 8]);
  const round5 = (x) => Math.round(x * 1e5) / 1e5;

  // ---------- Formatierung ----------
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s >= 3600) return Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ' h';
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  const fmtS = (ms) => Math.round(ms / 1000) + ' s';
  const fmtPct = (x) => Math.round(x * 100) + ' %';
  const fmtDate = (t) => new Date(t).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Symbole aus dem Sprite in index.html
  const ic = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const MODE_ICON = { auto: 'car', rad: 'bike', bus: 'bus', bahn: 'tram', fuss: 'walk', oepnv: 'tram' };
  const cardHead = (icon, title, meta, cls) => `<div class="card-head"><span class="chip${cls ? ' ' + cls : ''}">${ic(icon)}</span><div>${meta ? `<span class="meta">${meta}</span>` : ''}<h3>${title}</h3></div></div>`;

  // ---------- Ampeldaten aus OpenStreetMap ----------
  // Gierig wie bis 0.8.0: jeder Standort zur nächsten Gruppe in Reichweite
  function greedyGroups(pts) {
    const out = [];
    for (const p of pts) {
      let best = null, bd = Infinity;
      for (const g of out) { const d = dist(g.m, p); if (d < bd) { bd = d; best = g; } }
      if (best && bd <= 35) {
        best.pts.push(p); const n = best.pts.length;
        best.m.lat += (p.lat - best.m.lat) / n; best.m.lon += (p.lon - best.m.lon) / n;
      } else out.push({ m: { lat: p.lat, lon: p.lon }, pts: [p] });
    }
    return out.map((g) => g.pts);
  }
  // Tonsignal oder Vibration an einer Kreuzung: ja, sobald ein Signal es hat; nein nur, wenn es eingetragen ist
  function accFlag(part, k) {
    const vals = part.map((p) => (signalCache.acc[p.id] || {})[k]).filter(Boolean);
    return vals.some((v) => v !== 'no') ? 'yes' : vals.length ? 'no' : null;
  }
  function buildClusters(nodes) {
    const pts = Object.keys(nodes).sort((a, b) => Number(a) - Number(b)).map((id) => ({ id, lat: nodes[id][0], lon: nodes[id][1] }));
    // Verketten: Standorte bis CLUSTER_M zueinander gehören zusammen, auch über mehrere Ecken einer großen Kreuzung
    const parent = pts.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const gi = (p) => Math.floor(p.lat / 0.0004), gj = (p) => Math.floor(p.lon / 0.0006);   // Raster etwa 44 × 41 m
    const grid = {};
    pts.forEach((p, i) => { const k = gi(p) + '_' + gj(p); (grid[k] = grid[k] || []).push(i); });
    pts.forEach((p, i) => {
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const j of grid[(gi(p) + a) + '_' + (gj(p) + b)] || []) {
          if (j > i && dist(p, pts[j]) <= CLUSTER_M) parent[find(j)] = find(i);
        }
      }
    });
    const groups = {};
    pts.forEach((p, i) => { const r = find(i); (groups[r] = groups[r] || []).push(p); });
    const list = [];
    alias = {}; clusterById = {};
    for (const g of Object.values(groups)) {
      const m = { lat: g.reduce((x, p) => x + p.lat, 0) / g.length, lon: g.reduce((x, p) => x + p.lon, 0) / g.length };
      const parts = g.every((p) => dist(p, m) <= CLUSTER_MAX_M) ? [g] : greedyGroups(g);   // zu lange Ketten wieder aufteilen
      for (const part of parts) {
        const c = { id: 'c' + part[0].id, lat: part.reduce((x, p) => x + p.lat, 0) / part.length, lon: part.reduce((x, p) => x + p.lon, 0) / part.length, n: part.length,
          sound: accFlag(part, 's'), vib: accFlag(part, 'v') };
        list.push(c); clusterById[c.id] = c;
        for (const p of part) alias['c' + p.id] = c.id;
      }
    }
    return list;
  }
  function nearStop(p) {
    for (const id in signalCache.stops) {
      const [lat, lon] = signalCache.stops[id];
      if (Math.abs(lat - p.lat) < 0.001 && dist({ lat, lon }, p) <= STOP_M) return true;
    }
    return false;
  }
  // Name der nächsten Haltestelle, für Umstiege
  function stopName(p) {
    let best = null, bd = 250;
    for (const id in signalCache.stops) {
      const [lat, lon, name] = signalCache.stops[id];
      if (!name || Math.abs(lat - p.lat) > 0.003) continue;
      const d = dist({ lat, lon }, p);
      if (d < bd) { bd = d; best = name; }
    }
    return best;
  }
  function areaCovers(p) {
    const now = Date.now();
    return signalCache.areas.some((a) => dist(a, p) < a.r - 1500 && now - a.fetched < 30 * 864e5);
  }
  async function fetchSignals(p) {
    const ar = `(around:${AREA_RADIUS},${p.lat},${p.lon})`;
    const q = `[out:json][timeout:25];(node${ar}[highway=traffic_signals];node${ar}[crossing=traffic_signals];node${ar}[railway=tram_stop];node${ar}[public_transport=stop_position];node${ar}[highway=bus_stop];);out;`;
    let lastErr;
    for (const url of OVERPASS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        let n = 0;
        for (const el of json.elements || []) {
          if (el.type !== 'node') continue;
          const tg = el.tags || {};
          if (tg.highway === 'traffic_signals' || tg.crossing === 'traffic_signals') {
            signalCache.nodes[el.id] = [round5(el.lat), round5(el.lon)]; n++;
            const a = {};
            if (tg['traffic_signals:sound']) a.s = tg['traffic_signals:sound'];
            if (tg['traffic_signals:vibration']) a.v = tg['traffic_signals:vibration'];
            if (Object.keys(a).length) signalCache.acc[el.id] = a; else delete signalCache.acc[el.id];
          }
          else signalCache.stops[el.id] = tg.name ? [round5(el.lat), round5(el.lon), tg.name] : [round5(el.lat), round5(el.lon)];
        }
        signalCache.areas = signalCache.areas.filter((a) => dist(a, p) > 1000);
        signalCache.areas.push({ lat: round5(p.lat), lon: round5(p.lon), r: AREA_RADIUS, fetched: Date.now() });
        store.set('signals', signalCache);
        clusters = buildClusters(signalCache.nodes);
        updateSignalsInfo();
        return n;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Ampeldaten nicht erreichbar');
  }
  function updateSignalsInfo() {
    const n = clusters.length;
    $('#signals-info').textContent = n
      ? `${n} Ampel-Kreuzungen gespeichert (${Object.keys(signalCache.nodes).length} Signalstandorte, ${Object.keys(signalCache.stops).length} Haltestellenpunkte, ${signalCache.areas.length} Gebiet${signalCache.areas.length === 1 ? '' : 'e'}).`
      : 'Noch keine Ampeln geladen. Das passiert automatisch beim ersten Fahrtstart.';
  }

  // Straßennamen für Kreuzungen, nacheinander und gedrosselt (Nominatim erlaubt 1 Anfrage pro Sekunde)
  const nameQueue = [];
  let nameBusy = false;
  // Ampel ohne Querstraße (oft Fußgängerampel): mit der nächsten benannten Kreuzung derselben Straße unterscheidbar machen
  const SIDE = ['nördlich', 'nordöstlich', 'östlich', 'südöstlich', 'südlich', 'südwestlich', 'westlich', 'nordwestlich'];
  const refMemo = {};
  function withLandmark(e, base) {
    if (base.indexOf(' / ') > 0 || /\d/.test(base)) return base;
    const key = e.signal + '|' + Object.keys(names).length + '|' + trips.length;
    if (!(key in refMemo)) {
      let best = null, bd = 2000;
      const seen = {};
      for (const tr of trips) for (const x of tr.events) {
        if (!x.signal || x.signal === e.signal || seen[x.signal]) continue;
        seen[x.signal] = true;
        const n = nameOf(x.signal);
        if (!n || n.split(' / ').indexOf(base) < 0 || n.indexOf(' / ') < 0) continue;
        const d = dist(e, x);
        if (d < bd) { bd = d; best = { n, x, d }; }
      }
      refMemo[key] = null;
      if (best) {
        const other = best.n.split(' / ').find((p) => p !== base);
        const far = best.d < 1000 ? `${Math.max(10, Math.round(best.d / 10) * 10)} m` : `${fmtNum(best.d / 1000, 1)} km`;
        refMemo[key] = `${base}, ${far} ${SIDE[Math.round(bearing(best.x, e) / 45) % 8]} von ${other}`;
      }
    }
    return refMemo[key] || base;
  }
  function labelFor(e) {
    if (nameOf(e.signal)) return withLandmark(e, nameOf(e.signal));
    if (e.signal && e.signal.startsWith('demo')) return 'Demo-Ampel ' + e.signal.slice(4);
    return `Ampel bei ${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}`;
  }
  function requestNames(events, onDone) {
    for (const e of events) {
      if (!e.signal || names[e.signal] || e.signal.startsWith('demo')) continue;
      if (!nameQueue.some((q) => q.signal === e.signal)) nameQueue.push({ signal: e.signal, lat: e.lat, lon: e.lon });
    }
    if (!nameBusy && nameQueue.length) runNames(onDone);
  }
  function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(timer));
  }
  // Abstand eines Punkts zu einer Linie aus OpenStreetMap, in Metern (lokal eben gerechnet)
  function distToWay(p, geom) {
    const kx = 111320 * Math.cos(p.lat * toR), ky = 110540;
    let best = Infinity;
    for (let i = 0; i < geom.length - 1; i++) {
      const ax = (geom[i].lon - p.lon) * kx, ay = (geom[i].lat - p.lat) * ky;
      const bx = (geom[i + 1].lon - p.lon) * kx, by = (geom[i + 1].lat - p.lat) * ky;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const u = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
    }
    return best;
  }
  // Namen für mehrere Kreuzungen mit einer einzigen Abfrage: die nächste Straße zuerst, dann die Querstraße
  async function crossingNames(list) {
    // Bahnsteige und Haltestellen tragen oft den Haltestellennamen, sind aber keine Querstraße
    const parts = list.map((q) => `way(around:35,${q.lat},${q.lon})[highway][name][highway!~"^(platform|bus_stop)$"];`).join('');
    const query = `[out:json][timeout:25];(${parts});out tags geom;`;
    for (const url of OVERPASS) {
      try {
        const res = await fetchWithTimeout(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 30000);
        if (!res.ok) continue;
        const ways = ((await res.json()).elements || []).filter((w) => w.tags && w.tags.name && w.geometry && w.geometry.length > 1);
        const out = {};
        for (const q of list) {
          const near = {};
          for (const w of ways) {
            const d = distToWay(q, w.geometry);
            if (d <= 35 && (near[w.tags.name] == null || d < near[w.tags.name])) near[w.tags.name] = d;
          }
          const sorted = Object.keys(near).sort((a, b) => near[a] - near[b]);
          out[q.signal] = sorted.length >= 2 ? sorted[0] + ' / ' + sorted[1] : (sorted[0] || null);
        }
        return out;
      } catch (e) { /* nächsten Server versuchen */ }
    }
    return null;
  }
  async function streetWithNumber(q) {
    try {
      const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=de&lat=${q.lat}&lon=${q.lon}`, {}, 15000);
      if (!res.ok) return null;
      const a = (await res.json()).address || {};
      const road = a.road || a.pedestrian || a.footway;
      return road ? (a.house_number ? `${road} ${a.house_number}` : road) : null;
    } catch (e) { return null; }
  }
  async function runNames(onDone) {
    nameBusy = true;
    try {
      while (nameQueue.length) {
        const batch = nameQueue.splice(0, 25);
        const found = (await crossingNames(batch)) || {};
        for (const q of batch) if (found[q.signal] && found[q.signal].indexOf(' / ') > 0) names[q.signal] = found[q.signal];
        store.set('names3', names);
        if (onDone) onDone();
        // ohne Querstraße (z. B. Fußgängerampel): Straße mit Hausnummer, höchstens eine Anfrage pro Sekunde
        for (const q of batch) {
          if (names[q.signal]) continue;
          await new Promise((r) => setTimeout(r, 1100));
          const n = (await streetWithNumber(q)) || found[q.signal];
          if (n) { names[q.signal] = n; store.set('names3', names); if (onDone) onDone(); }
        }
      }
    } finally {
      nameBusy = false;
    }
  }

  // ---------- Aufzeichnung ----------
  let rec = null;          // laufende Fahrt
  let wakeLock = null;
  let tick = null;

  function newRecording(mode, extraClusters, demo) {
    return {
      trip: { id: 't' + Date.now().toString(36), mode, start: null, end: null, distance: 0, events: [], gaps: [], demo: !!demo },
      cfg: MODES[mode],
      curMode: mode,        // wechselt beim Umsteigen
      transfer: null,       // laufender Umstieg
      legStart: null,
      extra: extraClusters || [],
      samples: [],          // letzte Positionen {lat, lon, t, v}
      first: null, last: null,
      slowSince: null, fastSince: null,
      stop: null,           // laufender Halt
      recentPass: {},       // Kreuzung -> Zeit der letzten Durchfahrt
      lastHaltAt: {},       // Kreuzung -> Endzeit des letzten Halts
      lastFetchAt: 0,
      cells: {},            // Flow-Raster: Feld|Zeitfenster -> Zeit, Stillstand, Tempo-Anteil
      st: { moving: 0, steady: 0, steadyBase: 0, brakes: 0, accels: 0, win: [], lastVs: null, lastBrake: 0, lastAccel: 0 },
      gpsCount: 0,
      lastFixAt: 0,         // Gerätezeit des letzten brauchbaren GPS-Punkts
      startedAt: Date.now()
    };
  }
  const allClusters = () => (rec && rec.extra.length ? clusters.concat(rec.extra) : clusters);

  function currentHeading(p) {
    // Richtung aus einem Punkt mindestens 15 m zurück
    for (let i = rec.samples.length - 1; i >= 0; i--) {
      const s = rec.samples[i];
      if (dist(s, p) >= 15) return bearing(s, p);
    }
    return null;
  }

  function findSignal(p, heading, radius) {
    let best = null, bestScore = Infinity;
    for (const c of allClusters()) {
      const d = dist(c, p);
      if (d > radius) continue;
      let score = d;
      if (heading != null && d > 15) {
        const diff = angDiff(bearing(p, c), heading);
        if (diff > 100) continue;          // liegt hinter uns
        score += diff * 0.3;
      }
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  function onPosition(pos) {
    if (!rec) return;
    const c = pos.coords;
    rec.gpsCount++;
    $('#drive-gps').textContent = `GPS: ±${Math.round(c.accuracy)} m`;
    if (c.accuracy > MAX_ACCURACY) { setDriveState('GPS zu ungenau …', ''); return; }
    const t = pos.timestamp;
    const p = { lat: c.latitude, lon: c.longitude, t };
    const prev = rec.samples[rec.samples.length - 1];
    if (prev && t <= prev.t) return;
    rec.lastFixAt = Date.now();
    if (!rec.trip.start) { rec.trip.start = t; rec.first = { lat: p.lat, lon: p.lon }; maybeFetchSignals(p, true); }

    // Empfangslücke (Tunnel, Unterführung): ein laufender Halt endet mit dem letzten Punkt davor, die Strecke wird überbrückt
    if (prev && t - prev.t > GAP_MS) {
      const d = dist(prev, p);
      if (rec.stop && d > 25) endStop(prev.t);
      if (d > 100) {
        rec.trip.gaps.push({ t: prev.t, tEnd: t, d: Math.round(d) });
        rec.samples = []; rec.slowSince = null;
      }
    }
    let v = (c.speed != null && c.speed >= 0) ? c.speed : null;
    if (prev) {
      const d = dist(prev, p);
      rec.trip.distance += d;
      if (v == null) v = d / ((t - prev.t) / 1000);
    }
    if (v == null) v = 0;
    // geglättet über die letzten drei Werte
    const recentV = rec.samples.slice(-2).map((s) => s.v).concat(v).sort((a, b) => a - b);
    const vs = recentV[Math.floor(recentV.length / 2)];
    p.v = v;
    if (prev) { updateDrivingStats(vs, t, (t - prev.t) / 1000); updateCells(p, vs, t, (t - prev.t) / 1000, dist(prev, p)); }
    rec.st.lastVs = vs;
    const heading = currentHeading(p);
    rec.samples.push(p);
    if (rec.samples.length > 40) rec.samples.shift();
    rec.last = { lat: p.lat, lon: p.lon };
    $('#drive-speed').textContent = Math.round(vs * 3.6);
    if (heading != null && vs > rec.cfg.goV) $('#drive-dir').textContent = dirName(heading);

    const cfg = rec.cfg;
    if (!rec.stop) {
      if (vs < cfg.stopV) {
        if (rec.slowSince == null) rec.slowSince = { t, lat: p.lat, lon: p.lon, heading };
        if (t - rec.slowSince.t >= STOP_CONFIRM_MS) {
          const s = rec.slowSince;
          // Bus und Bahn: die Haltestelle geht vor. Beim Umsteigen zu Fuß geht die Fußgängerampel vor.
          const near = findSignal(s, s.heading, cfg.haltRadius);
          const atStop = rec.transfer ? !near && nearStop(s) : (rec.curMode === 'bahn' || rec.curMode === 'bus') && nearStop(s);
          const sig = atStop ? null : near;
          // keine Ampel in der Nähe, aber eine voraus: vermutlich Stau davor (endgültig zugeordnet wird am Ende der Fahrt)
          const queueSig = !sig && !atStop ? findSignal(s, s.heading, QUEUE_M) : null;
          rec.stop = { t0: s.t, lat: s.lat, lon: s.lon, heading: s.heading, signal: sig, atStop, queueSig };
          rec.fastSince = null;
        }
      } else {
        rec.slowSince = null;
        checkPass(p, heading, t);
      }
    } else {
      const moved = dist(rec.stop, p);
      if (vs > cfg.goV || moved > 25) {
        if (rec.fastSince == null) rec.fastSince = t;
        if (t - rec.fastSince >= GO_CONFIRM_MS || moved > 25) endStop(rec.fastSince);
      } else {
        rec.fastSince = null;
      }
    }
    if (rec.transfer) {
      setDriveState(`Umstieg · ${fmtDur(t - rec.transfer.t)}`, 'transfer');
    } else if (rec.stop) {
      const label = rec.stop.signal ? 'Halt an Ampel' : rec.stop.queueSig ? 'Stau vor Ampel' : rec.stop.atStop ? 'Halt an Haltestelle' : 'Halt';
      setDriveState(`${label} · ${fmtDur(t - rec.stop.t0)}`, 'halt');
    } else {
      setDriveState(vs < cfg.stopV ? 'Langsam …' : 'Unterwegs', 'moving');
    }
    maybeFetchSignals(p, false);
    updateCounters();
  }

  // Fahrstil für die Fahrtbilanz: Fahrzeit in Bewegung, Gleichmäßigkeit, starke Manöver
  const cellKey = (lat, lon) => Math.floor(lat / CELL_LAT) + '_' + Math.floor(lon / CELL_LON);
  function cellCenter(key) {
    const [i, j] = key.split('_').map(Number);
    return { lat: (i + 0.5) * CELL_LAT, lon: (j + 0.5) * CELL_LON };
  }
  function cellBounds(key) {
    const [i, j] = key.split('_').map(Number);
    return [[i * CELL_LAT, j * CELL_LON], [(i + 1) * CELL_LAT, (j + 1) * CELL_LON]];
  }
  function timeWindow(t) {
    const d = new Date(t), h = d.getHours(), wd = d.getDay() >= 1 && d.getDay() <= 5;
    if (h >= 19 || h < 6) return 'night';
    if (!wd) return 'weekend';
    if (h < 9) return 'wd-morning';
    if (h < 16) return 'wd-day';
    return 'wd-evening';
  }
  // Pro Feld nur Summen speichern, nicht den Weg selbst
  function updateCells(p, vs, t, dt, d) {
    if (!(dt > 0 && dt <= 5)) return;
    const k = cellKey(p.lat, p.lon) + '|' + timeWindow(t);
    const c = rec.cells[k] || (rec.cells[k] = { t: 0, s: 0, r: 0, d: 0 });
    c.t += dt; c.d += d;
    if (vs < rec.cfg.stopV) c.s += dt;
    c.r += dt * Math.min(1, vs / rec.cfg.vRef);
  }

  function updateDrivingStats(vs, t, dt) {
    const st = rec.st;
    if (!(dt > 0 && dt <= 5)) { st.win = []; return; }   // Lücken (App im Hintergrund) nicht werten
    if (vs > rec.cfg.goV) st.moving += dt * 1000;
    st.win.push({ t, v: vs });
    while (st.win.length && t - st.win[0].t > 60000) st.win.shift();
    if (vs > STEADY_MIN_V && st.win.length >= 10) {
      const mean = st.win.reduce((a, w) => a + w.v, 0) / st.win.length;
      st.steadyBase += dt * 1000;
      if (Math.abs(vs - mean) <= STEADY_TOL) st.steady += dt * 1000;
    }
    if (st.lastVs != null) {
      const acc = (vs - st.lastVs) / dt;
      if (acc < HARD_BRAKE && t - st.lastBrake > 5000) { st.brakes++; st.lastBrake = t; }
      if (acc > HARD_ACCEL && t - st.lastAccel > 5000) { st.accels++; st.lastAccel = t; }
    }
  }

  function checkPass(p, heading, t) {
    const cfg = rec.cfg;
    for (const c of allClusters()) {
      if (dist(c, p) > cfg.passRadius) continue;
      if (rec.recentPass[c.id] && t - rec.recentPass[c.id] < 90000) continue;
      if (rec.lastHaltAt[c.id] && t - rec.lastHaltAt[c.id] < 180000) continue;
      rec.recentPass[c.id] = t;
      rec.trip.events.push({ type: 'pass', signal: c.id, lat: round5(c.lat), lon: round5(c.lon), t, heading: heading == null ? null : Math.round(heading), mode: rec.curMode });
    }
  }

  function endStop(tEnd) {
    const s = rec.stop;
    rec.stop = null; rec.slowSince = null; rec.fastSince = null;
    const wait = tEnd - s.t0;
    if (wait < MIN_WAIT_MS) return;
    if (s.atStop && rec.transfer) return;   // Warten am Bahnsteig steckt schon in der Umstiegszeit
    const sigId = s.signal ? s.signal.id : null;
    const ev = rec.trip.events;
    // Mehrere kurze Halte vor derselben Ampel (Rückstau) zu einem Wartevorgang zusammenfassen
    if (sigId) {
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i];
        if (e.type === 'halt' && e.signal === sigId && s.t0 - e.tEnd < MERGE_MS) {
          e.wait += wait; e.halts += 1; e.tEnd = tEnd;
          rec.lastHaltAt[sigId] = tEnd;
          return;
        }
      }
      rec.lastHaltAt[sigId] = tEnd;
      // Eine schon gezählte Durchfahrt kurz vorher an derselben Ampel zurücknehmen
      for (let i = ev.length - 1; i >= 0; i--) {
        if (ev[i].type === 'pass' && ev[i].signal === sigId && s.t0 - ev[i].t < 60000) { ev.splice(i, 1); break; }
      }
    }
    const e = {
      type: 'halt', signal: sigId,
      lat: round5(s.signal ? s.signal.lat : s.lat), lon: round5(s.signal ? s.signal.lon : s.lon),
      t: s.t0, tEnd, wait, halts: 1,
      heading: s.heading == null ? null : Math.round(s.heading),
      distToSignal: s.signal ? Math.round(dist(s, s.signal)) : null,
      at: [round5(s.lat), round5(s.lon)]   // wo wirklich gestanden wurde, für spätere Auswertungen
    };
    if (s.atStop) e.atStop = true;
    if (!sigId && s.queueSig) e.queueSig = s.queueSig.id;
    e.mode = rec.curMode;   // Verkehrsmittel des Abschnitts
    ev.push(e);
  }

  // Ein Halt ohne Ampel in der Nähe, nach dem man bald durch eine Ampel fährt, war Rückstau vor dieser Ampel
  function assignQueueHalts(trip) {
    const ev = trip.events;
    let changed = false;
    // Rückwärts durch die Fahrt: eine Kette von Halten ohne Ampel vor einer Ampel ist ihr Rückstau,
    // auch wenn er um eine Ecke reicht. Je Glied höchstens QUEUE_MS Abstand, alle bis QUEUE_M vor der Ampel.
    let target = null, chainT = 0;
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i];
      if (e.signal) { target = e; chainT = e.t; continue; }
      if (e.type !== 'halt' || e.atStop) { target = null; continue; }
      const ok = target && chainT - (e.tEnd || e.t) <= QUEUE_MS && dist(e, target) <= QUEUE_M &&
        (target.type === 'halt' || e.heading == null || angDiff(bearing(e, target), e.heading) <= 45);
      if (!ok) { target = null; continue; }
      if (target.type === 'halt') {
        target.wait += e.wait; target.halts = (target.halts || 1) + (e.halts || 1); target.t = e.t; target.queued = true;
        ev.splice(i, 1);
      } else {
        // Durchfahrt nach dem Stau: der Halt davor gehört zu dieser Ampel
        Object.assign(e, { signal: target.signal, distToSignal: Math.round(dist(e, target)), lat: target.lat, lon: target.lon, queued: true });
        ev.splice(ev.indexOf(target), 1);
        target = e;
      }
      delete e.queueSig;
      chainT = target.t; changed = true;
    }
    return changed;
  }

  // Fahrt aufräumen: aktuelle Kreuzungs-Einteilung, kein Warten vor der Abfahrt, eine Kreuzung nur einmal
  function tidyTrip(trip) {
    const ev = trip.events;
    let changed = false;
    for (const e of ev) {
      const to = e.signal && alias[e.signal];
      if (to && to !== e.signal) {
        const c = clusterById[to];
        e.signal = to;
        if (c) { e.lat = round5(c.lat); e.lon = round5(c.lon); }
        changed = true;
      }
    }
    // Halt ab dem ersten GPS-Punkt, noch ohne Richtung: Warten an der Haltestelle oder auf dem Parkplatz
    const i0 = ev.findIndex((e) => e.type === 'halt' && e.t <= trip.start && e.heading == null);
    if (i0 >= 0) { ev.splice(i0, 1); changed = true; }
    if (assignQueueHalts(trip)) changed = true;
    // Zwei Ampeln direkt hintereinander, dicht beieinander und kurz nacheinander: dieselbe Kreuzung
    for (let i = 0; i < ev.length - 1; i++) {
      const a = ev[i], b = ev[i + 1];
      if (!a.signal || !b.signal) continue;
      if (a.signal !== b.signal && dist(a, b) > JUNCTION_M) continue;
      if (b.t - (a.tEnd || a.t) > JUNCTION_MS) continue;
      let drop = i + 1;
      if (a.type === 'halt' && b.type === 'halt') {
        a.wait += b.wait; a.halts = (a.halts || 1) + (b.halts || 1); a.tEnd = b.tEnd;
        if (b.queued) a.queued = true;
        if (a.rating == null && b.rating != null) a.rating = b.rating;
        if (b.tags) a.tags = Array.from(new Set((a.tags || []).concat(b.tags)));
      } else if (a.type === 'pass' && b.type === 'halt') {
        drop = i;   // der Halt zählt, die Durchfahrt davor gehört dazu
      }
      ev.splice(drop, 1); i = Math.max(-1, i - 2); changed = true;
    }
    return changed;
  }

  function maybeFetchSignals(p, first) {
    if (rec.trip.demo) return;
    if (areaCovers(p)) return;
    const now = Date.now();
    if (!first && now - rec.lastFetchAt < 60000) return;
    rec.lastFetchAt = now;
    fetchSignals(p).then(() => { hideWarn(); }).catch(() => {
      showWarn('Ampeldaten konnten gerade nicht geladen werden. Halte werden trotzdem aufgezeichnet und später zugeordnet, wenn möglich.');
    });
  }

  function setDriveState(text, cls) {
    const el = $('#drive-state');
    if (el.textContent !== text) el.textContent = text;
    el.className = 'drive-state' + (cls ? ' ' + cls : '');
  }
  function updateCounters() {
    if (!rec) return;
    const ev = rec.trip.events;
    const halts = ev.filter((e) => e.type === 'halt' && (e.signal || e.queueSig));   // Stau vor einer Ampel zählt mit
    $('#drive-pass').textContent = ev.filter((e) => e.type === 'pass').length;
    $('#drive-halts').textContent = new Set(halts.map((e) => e.signal || e.queueSig)).size;   // ein Stau vor einer Ampel ist ein Halt
    const running = rec.stop && (rec.stop.signal || rec.stop.queueSig) && rec.samples.length ? rec.samples[rec.samples.length - 1].t - rec.stop.t0 : 0;
    $('#drive-wait').textContent = fmtDur(halts.reduce((a, e) => a + e.wait, 0) + running);
  }
  function showWarn(t) { const w = $('#drive-warn'); w.textContent = t; w.hidden = false; }
  function hideWarn() { $('#drive-warn').hidden = true; }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (!rec || rec.trip.demo) return;
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      if (rec.hiddenAt && Date.now() - rec.hiddenAt > 10000) showWarn('Die App war im Hintergrund. In dieser Zeit wurde vermutlich nicht aufgezeichnet.');
      rec.hiddenAt = null;
    } else {
      rec.hiddenAt = Date.now();
    }
  });

  function startTrip() {
    const mode = selectedMode();
    settings.mode = mode; store.set('settings', settings);
    applyModeWords(mode);
    const msg = $('#start-msg');
    if (!('geolocation' in navigator)) { msg.textContent = 'Dieses Gerät bietet keinen Standortzugriff.'; return; }
    if (!window.isSecureContext) { msg.textContent = 'Standort geht nur über eine sichere Verbindung (https).'; return; }
    msg.textContent = 'Standort wird angefragt …';
    rec = newRecording(mode);
    if (settings.access.on) rec.trip.access = settings.access.type;   // Wartezeiten mit Einschränkung getrennt auswertbar
    rec.watchId = navigator.geolocation.watchPosition(
      (p) => { if (rec && rec.gpsCount === 0) { msg.textContent = ''; } onPosition(p); },
      (err) => {
        if (err.code === 1) {
          stopWatching(); rec = null; showView('start');
          msg.textContent = 'Ohne Standortfreigabe geht es nicht. Bitte erlaube den Standortzugriff für diese Seite in den Einstellungen deines Browsers.';
        } else {
          setDriveState('GPS-Signal fehlt …', '');
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    requestWakeLock();
    enterDriveView();
  }

  function enterDriveView() {
    hideWarn();
    setDriveState('Warte auf GPS …', '');
    $('#drive-speed').textContent = '–';
    $('#drive-dir').textContent = '';
    ['#drive-pass', '#drive-halts'].forEach((s) => { $(s).textContent = '0'; });
    $('#drive-wait').textContent = '0:00';
    $('#drive-time').textContent = '0:00';
    resetEndButtons();
    updateTransferUI();
    showView('drive');
    $$('.tabs button').forEach((b) => { b.disabled = true; });
    clearInterval(tick);
    tick = setInterval(() => {
      if (!rec) return;
      const now = rec.trip.demo ? (rec.samples.length ? rec.samples[rec.samples.length - 1].t : rec.startedAt) : Date.now();
      const from = rec.trip.start || rec.startedAt;
      $('#drive-time').textContent = fmtDur(now - from);
      if (!rec.trip.demo && rec.lastFixAt && Date.now() - rec.lastFixAt > GAP_MS) setDriveState('Kein GPS-Empfang, etwa im Tunnel. Die Lücke wird überbrückt.', '');
      updateCounters();
    }, 1000);
  }

  function stopWatching() {
    if (rec && rec.watchId != null) navigator.geolocation.clearWatch(rec.watchId);
    if (rec && rec.demoTimer) clearInterval(rec.demoTimer);
    clearInterval(tick);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $$('.tabs button').forEach((b) => { b.disabled = false; });
  }

  // ---------- Umsteigen (Bus und Bahn) ----------
  const isTransit = (m) => m === 'bus' || m === 'bahn';
  const nowT = () => (rec.samples.length ? rec.samples[rec.samples.length - 1].t : Date.now());
  function closeLeg(t) {
    const legs = rec.trip.legs || (rec.trip.legs = []);
    legs.push({ mode: rec.curMode, t0: rec.legStart != null ? rec.legStart : (rec.trip.start || t), t1: t });
    rec.legStart = t;
  }
  function switchMode(mode) {
    rec.curMode = mode; rec.cfg = MODES[mode];
    rec.slowSince = null; rec.fastSince = null;
  }
  function startTransfer() {
    if (!rec || rec.transfer || !isTransit(rec.curMode)) return;
    const t = nowT();
    if (rec.stop) endStop(t);   // die Bahn stand an der Haltestelle: dieser Halt endet mit dem Aussteigen
    const p = rec.samples[rec.samples.length - 1] || rec.last || {};
    closeLeg(t);
    rec.transfer = { t, from: rec.curMode, lat: p.lat, lon: p.lon };
    switchMode('fuss');
    updateTransferUI();
    setDriveState('Umstieg · 0:00', 'transfer');
  }
  function endTransfer(mode) {
    if (!rec || !rec.transfer) return;
    const t = nowT();
    if (rec.stop) endStop(t);
    closeLeg(t);
    const tr = rec.transfer;
    const item = { t: tr.t, tEnd: t, wait: t - tr.t, from: tr.from, to: mode };
    if (tr.lat != null) { item.lat = round5(tr.lat); item.lon = round5(tr.lon); const n = stopName(tr); if (n) item.stop = n; }
    (rec.trip.transfers = rec.trip.transfers || []).push(item);
    rec.transfer = null;
    switchMode(mode);
    updateTransferUI();
  }
  function updateTransferUI() {
    const show = rec && (isTransit(rec.curMode) || rec.transfer);
    $('#transfer-row').hidden = !show;
    $('#btn-transfer').hidden = !!(rec && rec.transfer);
    $('#transfer-next').hidden = !(rec && rec.transfer);
    const n = rec && rec.trip.legs ? rec.trip.legs.length + 1 : 1;
    $('#drive-leg').hidden = !rec || n < 2;
    if (rec) $('#drive-leg').textContent = rec.transfer ? `Abschnitt ${n} · Umstieg zu Fuß` : `Abschnitt ${n} · ${MODES[rec.curMode].label}`;
  }

  function finishTrip() {
    if (!rec) return;
    if (rec.stop && rec.samples.length) endStop(rec.samples[rec.samples.length - 1].t);
    // Abschnitte abschließen; ein offener Umstieg war keiner (man ist ausgestiegen und zu Fuß weiter)
    if (rec.trip.legs) {
      if (!rec.transfer || nowT() - rec.legStart >= 5000) closeLeg(nowT());
      if (rec.trip.legs.length < 2) delete rec.trip.legs;
    }
    rec.transfer = null;
    stopWatching();
    const trip = rec.trip;
    trip.end = rec.samples.length ? rec.samples[rec.samples.length - 1].t : Date.now();
    if (!trip.start) trip.start = trip.end;
    tidyTrip(trip);
    // Datenschutz: Ereignisse nahe Start und Ziel verwerfen
    const cut = Number(settings.cut) || 0;
    if (cut && rec.first && rec.last) {
      trip.events = trip.events.filter((e) => dist(e, rec.first) > cut && dist(e, rec.last) > cut);
    }
    trip.distance = Math.round(trip.distance);
    trip.cells = Object.keys(rec.cells).map((key) => {
      const [k, w] = key.split('|'), c = rec.cells[key];
      return { k, w, t: Math.round(c.t), s: Math.round(c.s), r: Math.round(c.r * 10) / 10, d: Math.round(c.d) };
    }).filter((c) => {
      if (c.t < 3) return false;
      if (!cut || !rec.first || !rec.last) return true;
      const m = cellCenter(c.k);
      return dist(m, rec.first) > cut + 100 && dist(m, rec.last) > cut + 100;   // Datenschutz wie bei den Ereignissen
    });
    const st = rec.st;
    trip.stats = {
      movingMs: Math.round(st.moving),
      steadyShare: st.steadyBase >= 60000 ? Math.round(st.steady / st.steadyBase * 100) / 100 : null,
      brakes: st.brakes,
      accels: st.accels
    };
    rec = null;
    if (!trip.events.length && trip.distance < 50) {
      showView('start');
      $('#start-msg').textContent = words(trip.mode).short;
      return;
    }
    trips.push(trip);
    saveTrips();
    flushWir(trip);
    openReview(trip);
  }

  function resetEndButtons() {
    $('#btn-end').hidden = false; $('#btn-end-confirm').hidden = true; $('#btn-end-cancel').hidden = true;
  }

  // ---------- Bewertung ----------
  let reviewTrip = null;
  function openReview(trip) {
    reviewTrip = trip;
    $('#h-review').textContent = words(trip.mode).review;
    const halts = trip.events.filter((e) => e.type === 'halt' && e.signal);
    const passes = trip.events.filter((e) => e.type === 'pass').length;
    const atStop = trip.events.filter((e) => e.type === 'halt' && e.atStop).length;
    const other = trip.events.filter((e) => e.type === 'halt' && !e.signal && !e.atStop).length;
    const wait = halts.reduce((a, e) => a + e.wait, 0);
    const extra = [atStop ? `${atStop} Halt${atStop === 1 ? '' : 'e'} an Haltestellen` : '', other ? `${other} Halt${other === 1 ? '' : 'e'} ohne Ampel in der Nähe` : ''].filter(Boolean).join(' und ');
    const trs = trip.transfers || [];
    const trText = trs.length ? ` ${trs.length} Umstieg${trs.length === 1 ? '' : 'e'}, zusammen ${durText(trs.reduce((x, r) => x + r.wait, 0))}.` : '';
    $('#review-summary').textContent = (halts.length
      ? `${halts.length} Halt${halts.length === 1 ? '' : 'e'} an Ampeln, zusammen ${fmtDur(wait)} Minuten gewartet. ${passes} Ampel${passes === 1 ? '' : 'n'} ohne Halt.${extra ? ` Dazu ${extra}, die nicht als Ampelhalt zählen.` : ''}`
      : `Kein Halt an einer Ampel. ${passes} Ampel${passes === 1 ? '' : 'n'} ohne Halt passiert.${extra ? ` ${extra.charAt(0).toUpperCase() + extra.slice(1)}.` : ''}`) + trText + (halts.length ? ' Wie war es an den Ampeln?' : '');
    renderBilanz();
    renderReview();
    showView('review');
    requestNames(halts, renderReview);
  }
  const fmtNum = (x, d) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtEuro = (x) => x.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
  // Kosten einer Autofahrt: Sprit oder Strom (nur mit Verbrauchsangabe) und geschätzte Kosten der Ampelhalte
  function tripCosts(t) {
    if (t.mode !== 'auto') return null;
    const unit = t.consumption ? t.consumption.unit : 'l';
    const price = unit === 'kWh' ? settings.powerPrice : settings.fuelPrice;
    const halts = t.events.filter((e) => e.type === 'halt' && e.signal);
    const waitH = halts.reduce((a, e) => a + e.wait, 0) / 3600000;
    const stops = halts.reduce((a, e) => a + (e.halts || 1), 0);
    const amount = unit === 'kWh' ? waitH * IDLE_KWH_PER_H + stops * RESTART_KWH : waitH * IDLE_L_PER_H + stops * RESTART_L;
    const energy = t.consumption ? t.distance / 1000 * t.consumption.value / 100 * price : null;
    return { unit, price, energy, halts: amount * price, amount, stops };
  }
  function costHtml(t) {
    const c = tripCosts(t);
    if (!c) return '';
    const what = c.unit === 'kWh' ? 'Strom' : 'Sprit';
    const lines = [`<div class="card-head"><span class="chip sm amber">${ic('euro')}</span><strong>Kosten</strong></div>`];
    lines.push(c.energy != null
      ? `<p><strong>${what} für diese Fahrt: ${fmtEuro(c.energy)}</strong></p>`
      : `<p class="small">Trag den Verbrauch ein, dann rechnet die App die ${what}kosten der Fahrt aus.</p>`);
    lines.push(c.stops
      ? `<p>Deine Ampelhalte: ca. ${fmtEuro(c.halts)} (${c.stops} Halt${c.stops === 1 ? '' : 'e'}, ${fmtNum(c.amount, 2)} ${c.unit === 'kWh' ? 'kWh' : 'l'})</p>`
      : '<p>Keine Ampelhalte, also auch keine Kosten fürs Warten.</p>');
    lines.push(`<p class="small muted">Schätzung mit ${fmtEuro(c.price)} je ${c.unit === 'kWh' ? 'kWh' : 'Liter'} (änderbar unter „Mehr“), ${c.unit === 'kWh' ? `${fmtNum(IDLE_KWH_PER_H, 1)} kWh je Stunde im Stand und ${fmtNum(RESTART_KWH, 2)} kWh` : `${fmtNum(IDLE_L_PER_H, 1)} l je Stunde Leerlauf und ${fmtNum(RESTART_L, 2)} l`} je Wiederanfahren.</p>`);
    return lines.join('');
  }
  // Bus und Bahn: wohin die Zeit ging, und die Abschnitte der Fahrt
  function transitFacts(t) {
    const sum = (f) => t.events.reduce((a, e) => a + (e.type === 'halt' && f(e) ? e.wait : 0), 0);
    const trs = t.transfers || [];
    const legs = (t.legs || []).filter((l) => l.mode !== 'fuss' || !trs.some((r) => r.t === l.t0));
    const chain = legs.length >= 2 ? `<p class="legs">${legs.map((l) => `<span>${ic(MODE_ICON[l.mode])}${esc(MODES[l.mode].label)}</span>`).join('<span class="arrow">→</span>')}</p>` : '';
    return `${chain}<ul class="facts">
      <li>${ic('pin')}<span>An Haltestellen</span><b>${durText(sum((e) => e.atStop))}</b></li>
      <li>${ic('light')}<span>An Ampeln</span><b>${durText(sum((e) => e.signal))}</b></li>
      ${trs.length ? `<li>${ic('walk')}<span>Umsteigen (${trs.length}×)</span><b>${durText(trs.reduce((a, r) => a + r.wait, 0))}</b></li>` : ''}
    </ul>`;
  }
  function renderBilanz() {
    const t = reviewTrip;
    const st = t.stats || {};
    const dur = (t.end || t.start) - t.start;
    const km = t.distance / 1000;
    const gaps = t.gaps || [];
    const gapKm = gaps.reduce((a, g) => a + g.d, 0) / 1000;
    const gapMs = gaps.reduce((a, g) => a + g.tEnd - g.t, 0);
    const avg = st.movingMs ? (km - gapKm) / (st.movingMs / 3600000) : null;   // Tempo nur aus Abschnitten mit GPS
    const per100 = km >= 5 ? ` (${fmtNum((st.brakes || 0) / km * 100, 1)} je 100 km)` : '';
    const c = t.consumption || {};
    const w = words(t.mode), walk = t.mode !== 'auto' && t.mode !== 'rad';   // Fahrstil nur, wenn man selbst fährt
    $('#review-bilanz').innerHTML = `<div class="card bilanz">
      ${cardHead(MODE_ICON[t.mode] || 'route', w.bilanz, `${fmtDate(t.start)} · ${MODES[t.mode] ? MODES[t.mode].label : ''}`)}
      <div class="kpis">
        <div class="kpi">${ic('route')}<b>${fmtNum(km, 1)} km</b><span>Strecke</span></div>
        <div class="kpi">${ic('timer')}<b>${fmtDur(dur)}</b><span>${w.time}${dur < 3600000 ? ' (min)' : ''}</span></div>
        <div class="kpi">${ic('gauge')}<b>${avg ? Math.round(avg) + ' km/h' : '–'}</b><span>Ø Tempo in Bewegung</span></div>
        ${walk
          ? `<div class="kpi">${ic('light')}<b>${t.events.filter((e) => e.type === 'halt' && e.signal).length}</b><span>Halte an Ampeln</span></div>`
          : `<div class="kpi">${ic('wave')}<b>${st.steadyShare != null ? fmtPct(st.steadyShare) : '–'}</b><span>gleichmäßig gefahren</span></div>`}
      </div>
      ${isTransit(t.mode) || (t.transfers || []).length ? transitFacts(t) : ''}
      ${walk ? '' : `<p class="note">${ic('alert')}<span>${st.brakes || 0} starke Bremsung${st.brakes === 1 ? '' : 'en'}${per100}, ${st.accels || 0}× stark beschleunigt.${st.steadyShare == null ? ' Die Gleichmäßigkeit wird ab einer Minute Fahrt über 30 km/h berechnet.' : ''}</span></p>`}
      ${gaps.length ? `<p class="note">${ic('gps')}<span>Ohne GPS-Empfang, etwa im Tunnel: ${fmtDur(gapMs)} min, rund ${fmtNum(gapKm, 1)} km Luftlinie überbrückt. Dort wird nichts gewertet.</span></p>` : ''}
      ${t.mode === 'auto' ? `      <label class="small" for="inp-consumption">Verbrauch laut Bordcomputer (freiwillig)</label>
      <div class="cons-row">
        <input id="inp-consumption" type="text" inputmode="decimal" autocomplete="off" placeholder="z. B. 5,6" value="${c.value != null ? fmtNum(c.value, 1) : ''}">
        <select id="inp-unit" aria-label="Einheit">
          <option value="l"${c.unit !== 'kWh' ? ' selected' : ''}>l/100 km</option>
          <option value="kWh"${c.unit === 'kWh' ? ' selected' : ''}>kWh/100 km</option>
        </select>
      </div>
      <p id="cons-msg" class="small muted" role="status" aria-live="polite"></p>
      <div id="bilanz-costs" class="costs">${costHtml(t)}</div>` : ''}
    </div>`;
    const save = () => {
      const raw = $('#inp-consumption').value.trim().replace(',', '.');
      const unit = $('#inp-unit').value;
      if (!raw) { delete reviewTrip.consumption; saveTrips(); $('#cons-msg').textContent = ''; $('#bilanz-costs').innerHTML = costHtml(reviewTrip); return; }
      const val = Number(raw);
      if (!isFinite(val) || val <= 0 || val > 60) { $('#cons-msg').textContent = 'Bitte eine Zahl wie 5,6 eingeben.'; return; }
      reviewTrip.consumption = { value: Math.round(val * 10) / 10, unit };
      saveTrips();
      $('#cons-msg').textContent = `Gespeichert: ${fmtNum(reviewTrip.consumption.value, 1)} ${unit}/100 km.`;
      $('#bilanz-costs').innerHTML = costHtml(reviewTrip);
    };
    if (t.mode !== 'auto') return;   // Verbrauch und Kosten nur fürs Auto
    $('#inp-consumption').addEventListener('change', save);
    $('#inp-unit').addEventListener('change', save);
  }
  const openTags = new Set();   // aufgeklappte Stichwort-Listen bleiben beim Neuzeichnen offen
  function renderReview() {
    if (!reviewTrip) return;
    const halts = reviewTrip.events.filter((e) => e.type === 'halt' && e.signal);
    const tagList = reviewTrip.access || settings.access.on ? TAGS.concat(ACC_TAGS) : TAGS;
    $('#review-list').innerHTML = halts.map((e, i) => {
      const idx = reviewTrip.events.indexOf(e);
      const tags = e.tags || [];
      return `<article class="rev" data-idx="${idx}">
        <div class="rev-head"><span class="chip sm">${ic('light')}</span><div class="rev-title"><strong>${esc(labelFor(e))}</strong><span class="small muted">${[dirName(e.heading), e.halts > 1 ? `${e.halts} Halte` : '', e.queued ? 'im Rückstau' : '', new Date(e.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'].filter(Boolean).map(esc).join(' · ')}</span></div><span class="rev-wait">${ic('hourglass')}${fmtDur(e.wait)} min</span></div>
        <div class="thumbs" role="group" aria-label="Bewertung für ${esc(labelFor(e))}">
          <button type="button" class="btn up" data-rate="1" aria-pressed="${e.rating === 1}">${ic('thumb')}Gut</button>
          <button type="button" class="btn down" data-rate="-1" aria-pressed="${e.rating === -1}">${ic('thumb', 'flip')}Schlecht</button>
        </div>
        <details class="tag-box"${tags.length || openTags.has(idx) ? ' open' : ''} data-idx="${idx}"><summary>${ic('list')}Stichworte${tags.length ? ` (${tags.length})` : ''}</summary>
          <div class="tags" role="group" aria-label="Stichworte">${tagList.map((t) => `<button type="button" data-tag="${esc(t)}" aria-pressed="${tags.includes(t)}">${esc(t)}</button>`).join('')}</div></details>
      </article>`;
    }).join('') + (reviewTrip.transfers || []).map((tr, i) => `<article class="rev transfer" data-tidx="${i}">
        <div class="rev-head"><span class="chip sm amber">${ic('walk')}</span><div class="rev-title"><strong>Umstieg${tr.stop ? ' ' + esc(tr.stop) : ''}</strong><span class="small muted">${esc(MODES[tr.from].label)} → ${esc(MODES[tr.to].label)} · ${new Date(tr.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</span></div><span class="rev-wait">${ic('hourglass')}${durText(tr.wait)}</span></div>
        <button type="button" class="btn miss" data-missed aria-pressed="${!!tr.missed}">${ic('alert')}Anschluss verpasst</button>
      </article>`).join('');
  }
  $('#review-list').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.classList || !d.classList.contains('tag-box')) return;
    const i = Number(d.dataset.idx);
    if (d.open) openTags.add(i); else openTags.delete(i);
  }, true);
  $('#review-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    const card = ev.target.closest('.rev');
    if (!btn || !card || !reviewTrip) return;
    if (card.dataset.tidx != null) {
      const tr = reviewTrip.transfers[Number(card.dataset.tidx)];
      tr.missed = !tr.missed;
      saveTrips(); renderReview();
      const b = $(`#review-list .rev[data-tidx="${card.dataset.tidx}"] button[data-missed]`);
      if (b) b.focus();
      return;
    }
    const e = reviewTrip.events[Number(card.dataset.idx)];
    if (btn.dataset.rate) {
      const r = Number(btn.dataset.rate);
      e.rating = e.rating === r ? null : r;
    } else if (btn.dataset.tag) {
      const t = btn.dataset.tag;
      e.tags = e.tags || [];
      e.tags = e.tags.includes(t) ? e.tags.filter((x) => x !== t) : e.tags.concat(t);
    }
    saveTrips();
    renderReview();
    const again = $(`#review-list .rev[data-idx="${card.dataset.idx}"] button[data-${btn.dataset.rate ? 'rate' : 'tag'}="${btn.dataset.rate || btn.dataset.tag}"]`);
    if (again) again.focus();
  });
  $('#btn-review-done').addEventListener('click', () => { reviewTrip = null; showView('stats'); });

  // ---------- Statistik ----------
  let statsRange = 'week';
  function weekStart() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }
  // Fahrten an derselben Ampel mit ähnlicher Richtung (±45°) bilden eine Zufahrt
  function dirGroup(a, e) {
    let g = null;
    if (e.heading != null) {
      for (const d of a.dirs) if (d.h != null && angDiff(d.h, e.heading) <= 45) { g = d; break; }
    } else {
      g = a.dirs.find((d) => d.h == null) || null;
    }
    if (!g) { g = { h: e.heading == null ? null : e.heading, sx: 0, sy: 0, passes: 0, halts: 0, wait: 0, maxWait: 0, up: 0, down: 0 }; a.dirs.push(g); }
    if (e.heading != null) {
      g.sx += Math.sin(e.heading * toR); g.sy += Math.cos(e.heading * toR);
      g.h = (Math.atan2(g.sx, g.sy) / toR + 360) % 360;
    }
    return g;
  }
  function countInto(x, e) {
    if (e.type === 'pass') x.passes++;
    else { x.halts++; x.wait += e.wait; x.maxWait = Math.max(x.maxWait, e.wait); }
    if (e.rating === 1) x.up++;
    if (e.rating === -1) x.down++;
  }
  function aggregate(list) {
    const per = {};
    let wait = 0, halts = 0, passes = 0;
    for (const tr of list) for (const e of tr.events) {
      if (!e.signal) continue;
      const a = per[e.signal] || (per[e.signal] = { signal: e.signal, lat: e.lat, lon: e.lon, passes: 0, halts: 0, wait: 0, maxWait: 0, up: 0, down: 0, tags: {}, sample: e, dirs: [] });
      countInto(a, e);
      countInto(dirGroup(a, e), e);
      if (e.type === 'pass') passes++; else { halts++; wait += e.wait; }
      for (const t of e.tags || []) a.tags[t] = (a.tags[t] || 0) + 1;
    }
    const all = Object.values(per);
    const approaches = [];
    for (const a of all) for (const d of a.dirs) approaches.push(Object.assign({ sample: a.sample, signal: a.signal }, d));
    return { per: all, approaches, wait, halts, passes };
  }
  const dirShort = (h) => (h == null ? '–' : DIRS[Math.round(h / 45) % 8]);
  function costSummary(list) {
    const cs = list.map(tripCosts).filter(Boolean);
    if (!cs.length) return '';
    const halts = cs.reduce((a, c) => a + c.halts, 0);
    const withEnergy = cs.filter((c) => c.energy != null);
    const energy = withEnergy.reduce((a, c) => a + c.energy, 0);
    return `<div class="card">${cardHead('euro', 'Kosten', 'geschätzt', 'amber')}
      <p>Ampelhalte: <strong>${fmtEuro(halts)}</strong> bei ${cs.length} Autofahrt${cs.length === 1 ? '' : 'en'}</p>
      ${withEnergy.length ? `<p>Sprit und Strom: <strong>${fmtEuro(energy)}</strong> bei ${withEnergy.length} Fahrt${withEnergy.length === 1 ? '' : 'en'} mit Verbrauchsangabe</p>` : '<p class="small">Für Sprit- und Stromkosten den Verbrauch in der Fahrtbilanz eintragen.</p>'}
    </div>`;
  }
  function renderStats() {
    const since = statsRange === 'week' ? weekStart() : 0;
    const list = trips.filter((t) => t.start >= since);
    $('#stats-demo').hidden = !list.some((t) => t.demo);
    const body = $('#stats-body');
    if (!list.length) {
      body.innerHTML = `<p class="msg">${statsRange === 'week' ? 'Diese Woche noch keine Fahrten.' : 'Noch keine Fahrten.'} Starte unter „Heute“ deine erste Aufzeichnung oder spiele unter „Mehr“ eine Testfahrt ab.</p>`;
      return;
    }
    const ag = aggregate(list);
    const share = ag.halts + ag.passes ? ag.halts / (ag.halts + ag.passes) : 0;
    const worst = ag.approaches.filter((a) => a.halts).sort((a, b) => b.wait - a.wait)[0];
    const rowList = ag.approaches.sort((a, b) => b.wait - a.wait).map((a) => {
      const n = a.halts + a.passes;
      const rating = a.up || a.down ? `${a.up} / ${a.down}` : '–';
      return `<tr><td>${esc(labelFor(a.sample))}</td><td>${dirShort(a.h)}</td><td>${n}</td><td>${fmtPct(a.halts / n)}</td><td>${a.halts ? fmtS(a.wait / a.halts) : '–'}</td><td>${rating}</td></tr>`;
    });
    const tripList = list.slice().sort((a, b) => b.start - a.start).map((t) => {
      const h = t.events.filter((e) => e.type === 'halt' && e.signal);
      return `<div class="trip"><span class="chip sm">${ic(MODE_ICON[t.mode] || 'route')}</span><span class="trip-main">${fmtDate(t.start)} · ${MODES[t.mode] ? MODES[t.mode].label : t.mode}${t.demo ? '<span class="badge">Demo</span>' : ''}<br><span class="muted">${(t.distance / 1000).toFixed(1).replace('.', ',')} km · ${h.length} Halte · ${fmtDur(h.reduce((x, e) => x + e.wait, 0))} min${(t.transfers || []).length ? ` · ${t.transfers.length} Umstieg${t.transfers.length === 1 ? '' : 'e'}` : ''}${t.stats && t.stats.steadyShare != null ? ` · ${fmtPct(t.stats.steadyShare)} gleichmäßig` : ''}${t.consumption ? ` · ${fmtNum(t.consumption.value, 1)} ${t.consumption.unit}/100 km` : ''}${(() => { const c = tripCosts(t); return c && c.energy != null ? ` · ${fmtEuro(c.energy)}` : ''; })()}</span></span>
        <span class="trip-act"><button type="button" data-review="${t.id}">Ansehen</button><button type="button" data-del="${t.id}">Löschen</button></span></div>`;
    });
    const thead = '<thead><tr><th>Ampel</th><th>Richtung</th><th>Fahrten</th><th>mit Halt</th><th>Ø Warten</th><th>gut / schlecht</th></tr></thead>';
    const table = (rs) => `<div class="tbl-wrap"><table>${thead}<tbody>${rs.join('')}</tbody></table></div>`;
    // lange Listen: die wichtigsten zuerst, der Rest zum Aufklappen
    const rest = (items, n, label, wrap) => items.length > n ? `<details class="more-box"><summary>${ic('list')}${label} (${items.length - n} weitere)</summary>${wrap(items.slice(n))}</details>` : '';
    body.innerHTML = `
      <div class="kpis">
        <div class="kpi">${ic('hourglass')}<b>${fmtDur(ag.wait)}</b><span>Minuten an Ampeln gewartet</span></div>
        <div class="kpi">${ic('list')}<b>${list.length}</b><span>Aufzeichnung${list.length === 1 ? '' : 'en'}</span></div>
        <div class="kpi">${ic('light')}<b>${fmtPct(share)}</b><span>der Ampeln mit Halt</span></div>
        <div class="kpi">${ic('clock')}<b>${ag.halts ? fmtS(ag.wait / ag.halts) : '–'}</b><span>Ø Wartezeit je Halt</span></div>
      </div>
      ${costSummary(list)}
      ${worst ? `<div class="card worst">${cardHead('alert', 'Deine nervigste Ampel', '', 'bad')}<p><strong>${esc(labelFor(worst.sample))}</strong>${worst.h != null ? ', ' + esc(dirName(worst.h)) : ''}</p><ul class="facts"><li>${ic('light')}<span>gehalten</span><b>${worst.halts}×</b></li><li>${ic('hourglass')}<span>zusammen</span><b>${fmtDur(worst.wait)} min</b></li><li>${ic('clock')}<span>längster Halt</span><b>${fmtDur(worst.maxWait)} min</b></li></ul></div>` : ''}
      <h3 class="sec">${ic('light')}Alle Ampeln</h3>
      ${table(rowList.slice(0, 8))}
      ${rest(rowList, 8, 'Alle Ampeln anzeigen', table)}
      <h3 class="sec">${ic('list')}Fahrten und Wege</h3>
      <div class="list">${tripList.slice(0, 5).join('')}</div>
      ${rest(tripList, 5, 'Ältere anzeigen', (xs) => `<div class="list">${xs.join('')}</div>`)}`;
    requestNames(ag.per.map((a) => a.sample), () => { if (!$('#view-stats').hidden) renderStats(); });
  }
  $('.seg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-range]');
    if (!b) return;
    statsRange = b.dataset.range;
    $$('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderStats();
  });
  $('#stats-body').addEventListener('click', (ev) => {
    const del = ev.target.closest('button[data-del]');
    const rv = ev.target.closest('button[data-review]');
    if (del) {
      if (del.dataset.armed) {
        trips = trips.filter((t) => t.id !== del.dataset.del); saveTrips(); renderStats();
      } else {
        del.dataset.armed = '1'; del.textContent = 'Wirklich?';
      }
    } else if (rv) {
      const t = trips.find((x) => x.id === rv.dataset.review);
      if (t) openReview(t);
    }
  });

  // ---------- Karte ----------
  let map = null, layer = null;
  let mapMode = 'signals', mapWindow = 'all', mapFitted = false;

  // Flow-Wert je Feld (0–100): Mittel aus Tempo-Anteil, Anteil ohne Stillstand, Ampel-Wartezeit und Bewertungen
  function aggregateGrid(list, win) {
    const g = {};
    const get = (k) => g[k] || (g[k] = { k, trips: new Set(), t: 0, s: 0, r: 0, d: 0, n: 0, wait: 0, halts: 0, up: 0, down: 0, signals: new Set() });
    for (const tr of list) {
      for (const c of tr.cells || []) {
        if (win !== 'all' && c.w !== win) continue;
        const a = get(c.k); a.trips.add(tr.id); a.t += c.t; a.s += c.s; a.r += c.r; a.d += c.d;
      }
      for (const e of tr.events) {
        if (!e.signal || (win !== 'all' && timeWindow(e.t) !== win)) continue;
        const a = get(cellKey(e.lat, e.lon)); a.trips.add(tr.id); a.n++; a.signals.add(e.signal);
        if (!a.sig) a.sig = { signal: e.signal, lat: e.lat, lon: e.lon };
        if (e.type === 'halt') { a.halts++; a.wait += e.wait; }
        if (e.rating === 1) a.up++;
        if (e.rating === -1) a.down++;
      }
    }
    for (const a of Object.values(g)) {
      const parts = [];
      if (a.t >= 5) { parts.push(a.r / a.t); parts.push(1 - a.s / a.t); }
      if (a.n) parts.push(1 - Math.min(1, a.wait / a.n / 60000));   // 60 s Ø Wartezeit je Durchfahrt = 0
      if (a.up + a.down) parts.push(a.up / (a.up + a.down));
      a.flow = parts.length ? Math.round(100 * parts.reduce((x, y) => x + y, 0) / parts.length) : null;
      a.count = a.trips.size;
    }
    return Object.values(g).filter((a) => a.flow != null);
  }
  function flowColor(f) { return waitColor(45 * (1 - f / 100)); }   // gleiche Farbskala: grün fließt, rot hakt
  function cellLabel(a) {
    if (a.signals.size) { const sig = [...a.signals][0]; const nm = nameOf(sig); if (nm) return nm; }
    const key = 'g' + a.k;
    return names[key] || 'Feld bei ' + cellCenter(a.k).lat.toFixed(4) + ', ' + cellCenter(a.k).lon.toFixed(4);
  }
  function gridInsights(list) {
    const out = [];
    const all = aggregateGrid(list, 'all').filter((a) => a.count >= 2).sort((x, y) => x.flow - y.flow);
    for (const a of all.slice(0, 3)) if (a.flow < 70) out.push(`<li><strong>${esc(cellLabel(a))}</strong>: Flow ${a.flow} aus ${a.count} Fahrten${a.halts ? `, ${a.halts}× an der Ampel gehalten` : ''}.</li>`);
    // Zeitvergleich: dasselbe Feld in verschiedenen Zeitfenstern
    const per = {};
    for (const w of WINDOWS.slice(1)) for (const a of aggregateGrid(list, w.id)) (per[a.k] = per[a.k] || []).push({ w, a });
    // nur Zeitfenster mit mindestens zwei Fahrten vergleichen, sonst ist es Zufall
    for (const k of Object.keys(per)) per[k] = per[k].filter((x) => x.a.count >= 2);
    const cmp = Object.values(per).filter((x) => x.length >= 2).map((x) => {
      x.sort((p, q) => q.a.flow - p.a.flow);
      return { best: x[0], worst: x[x.length - 1], gap: x[0].a.flow - x[x.length - 1].a.flow };
    }).filter((c) => c.gap >= 15).sort((p, q) => q.gap - p.gap).slice(0, 2);
    for (const c of cmp) out.push(`<li><strong>${esc(cellLabel(c.best.a))}</strong>: ${esc(c.best.w.label)} fließt es besser (Flow ${c.best.a.flow}) als ${esc(c.worst.w.label)} (Flow ${c.worst.a.flow}).</li>`);
    return out;
  }
  function renderInsights() {
    const ins = gridInsights(trips);
    $('#map-insights').innerHTML = ins.length
      ? `${cardHead('bulb', 'Was dein Raster zeigt', '', 'amber')}<ul>${ins.join('')}</ul>`
      : '<p class="small muted">Erkenntnisse erscheinen, sobald du Orte mehrmals durchfahren hast.</p>';
  }
  function drawGrid() {
    const cells = aggregateGrid(trips, mapWindow);
    const pts = [];
    for (const a of cells) {
      const col = flowColor(a.flow);
      const op = Math.min(0.65, 0.2 + a.count * 0.09);   // mehr Fahrten, kräftigere Farbe
      const speed = a.t >= 5 ? Math.round(a.d / a.t * 3.6) : null;
      L.rectangle(cellBounds(a.k), { color: col, weight: 1, fillColor: col, fillOpacity: op })
        .bindPopup(`<strong>${esc(cellLabel(a))}</strong><br>Flow ${a.flow} von 100 · ${a.count} Fahrt${a.count === 1 ? '' : 'en'}${a.count < 5 ? ' (noch kein sicheres Muster)' : ''}`
          + (speed != null ? `<br>Ø ${speed} km/h, ${fmtPct(a.s / a.t)} der Zeit Stillstand` : '')
          + (a.n ? `<br>Ampeln: ${a.halts} von ${a.n} mit Halt, Ø ${Math.round(a.wait / a.n / 1000)} s Wartezeit` : '')
          + (a.up || a.down ? `<br>Bewertung: ${a.up} gut, ${a.down} schlecht` : ''))
        .addTo(layer);
      pts.push(cellCenter(a.k));
    }
    $('#map-empty').hidden = cells.length > 0;
    $('#map-empty').textContent = 'Für dieses Zeitfenster gibt es noch keine Daten.';
    renderInsights();
    // Namen für Felder ohne Ampel nachladen
    const wanted = cells.slice(0, 60).map((a) => a.sig || Object.assign({ signal: 'g' + a.k }, cellCenter(a.k)));
    requestNames(wanted, () => { if (mapMode === 'grid' && !$('#view-map').hidden) renderInsights(); });   // Karte nicht neu zeichnen, damit offene Infofenster bleiben
    return pts.map((p) => [p.lat, p.lon]);
  }
  function waitColor(s) {
    const stops = [[0, [46, 158, 106]], [20, [224, 163, 38]], [45, [214, 69, 47]]];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) if (s >= stops[i][0] && s <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; }
    const u = b[0] === a[0] ? 1 : Math.min(1, Math.max(0, (s - a[0]) / (b[0] - a[0])));
    return 'rgb(' + a[1].map((x, i) => Math.round(x + (b[1][i] - x) * u)).join(',') + ')';
  }
  function renderMap() {
    const ag = aggregate(trips);
    const empty = !ag.per.length;
    $('#map-empty').hidden = !empty;
    $('#map-empty').textContent = 'Noch keine Halte aufgezeichnet.';
    if (typeof L === 'undefined') { $('#map-empty').hidden = false; $('#map-empty').textContent = 'Die Karte braucht eine Internetverbindung.'; return; }
    if (!map) {
      map = L.map('map', { zoomControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' }).addTo(map);
      map.setView([52.0211, 8.5325], 13);
    }
    setTimeout(() => map.invalidateSize(), 50);
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);
    $('#map-legend').textContent = mapMode === 'grid'
      ? 'Jedes Feld ist etwa 150 × 150 m groß. Grün: es fließt, rot: es hakt. Je kräftiger die Farbe, desto mehr Fahrten stehen dahinter. Tippe auf ein Feld für die Werte.'
      : 'Je größer der Kreis, desto länger wartest du dort im Schnitt. Farbe: grün kurz, rot lang. Tippe auf einen Kreis für die Werte je Richtung.';
    $('#map-window').hidden = mapMode !== 'grid';
    $('#map-insights').hidden = mapMode !== 'grid';
    if (mapMode === 'grid') {
      const gp = drawGrid();
      mapHasData = gp.length > 0;
      if (gp.length && !mapFitted) { map.fitBounds(gp, { padding: [30, 30], maxZoom: 16 }); mapFitted = true; }
      startMyLocation();
      return;
    }
    mapFitted = false;
    const pts = [];
    for (const a of ag.per) {
      const n = a.halts + a.passes;
      const avgAll = a.wait / n / 1000;            // Ø Wartezeit über alle Fahrten, auch ohne Halt
      const r = 8 + Math.sqrt(avgAll) * 5;
      const col = waitColor(avgAll);
      const dirLines = a.dirs.map((d) => {
        const dn = d.halts + d.passes;
        return `${esc(dirName(d.h) || 'Richtung unbekannt')}: ${dn}× vorbei, ${fmtPct(d.halts / dn)} mit Halt, Ø ${Math.round(d.wait / dn / 1000)} s`;
      }).join('<br>');
      L.circleMarker([a.lat, a.lon], { radius: r, color: col, weight: 2, fillColor: col, fillOpacity: 0.45 })
        .bindPopup(`<strong>${esc(labelFor(a.sample))}</strong><br>${n} Fahrten, ${fmtPct(a.halts / n)} mit Halt<br>Ø Wartezeit ${Math.round(avgAll)} s, längste ${fmtS(a.maxWait)}${a.up || a.down ? `<br>Bewertung: ${a.up} gut, ${a.down} schlecht` : ''}${settings.access.on ? `<br>${esc(accText(a.signal))}` : ''}<br><br>${dirLines}`)
        .addTo(layer);
      pts.push([a.lat, a.lon]);
    }
    mapHasData = pts.length > 0;
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
    startMyLocation();
  }

  // Eigener Standort auf der Karte, nur solange die Karte offen ist
  let meMarker = null, meCircle = null, meWatch = null, meCenterNext = false, mapHasData = false;
  function startMyLocation() {
    if (!map || !('geolocation' in navigator) || meWatch != null) return;
    if (!mapHasData && !meMarker) meCenterNext = true;
    meWatch = navigator.geolocation.watchPosition((p) => {
      $('#map-loc-msg').textContent = '';
      const ll = [p.coords.latitude, p.coords.longitude];
      if (!meMarker) {
        meCircle = L.circle(ll, { radius: p.coords.accuracy, color: '#1d5fa6', weight: 1, fillColor: '#1d5fa6', fillOpacity: 0.12, interactive: false }).addTo(map);
        meMarker = L.circleMarker(ll, { radius: 8, color: '#ffffff', weight: 3, fillColor: '#1d5fa6', fillOpacity: 1 }).bindTooltip('Du bist hier').addTo(map);
      } else {
        meMarker.setLatLng(ll); meCircle.setLatLng(ll); meCircle.setRadius(p.coords.accuracy);
      }
      if (meCenterNext) { map.setView(ll, 16); meCenterNext = false; }
    }, (err) => {
      stopMyLocation();
      $('#map-loc-msg').textContent = err.code === 1
        ? 'Dein Standort ist für diese Seite nicht freigegeben. In Safari: auf „aA“ in der Adressleiste tippen, dann Website-Einstellungen → Standort → Erlauben.'
        : 'Dein Standort konnte gerade nicht bestimmt werden.';
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }
  function stopMyLocation() {
    if (meWatch != null) { navigator.geolocation.clearWatch(meWatch); meWatch = null; }
  }
  $('#map-mode').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (!b) return;
    mapMode = b.dataset.mode; mapFitted = false;
    $$('#map-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderMap();
  });
  $('#map-window').innerHTML = WINDOWS.map((w) => `<option value="${w.id}">${esc(w.label)}</option>`).join('');
  $('#map-window').addEventListener('change', (ev) => { mapWindow = ev.target.value; renderMap(); });
  $('#btn-locate').addEventListener('click', () => {
    if (meMarker) map.setView(meMarker.getLatLng(), 16);
    else { meCenterNext = true; startMyLocation(); }
  });

  // ---------- Testfahrt ----------
  function demoRun() {
    if (rec) return;
    const base = { lat: 52.0150, lon: 8.5500 };
    const mPerDegLon = 111320 * Math.cos(base.lat * toR);
    const at = (m) => ({ lat: base.lat, lon: base.lon + m / mPerDegLon });
    const demoSignals = [600, 1000, 1400, 1800].map((m, i) => Object.assign({ id: 'demo' + (i + 1), n: 1 }, at(m)));
    // Ablauf: Meter -> Halt in Sekunden (Rückstau an Ampel 3: zwei Halte)
    const plan = [{ at: 970, wait: 42 }, { at: 1340, wait: 18 }, { at: 1352, wait: 21 }];
    const pts = [];
    let m = 0, t = Date.now();
    const v = 13.9;
    while (m < 2400) {
      const stop = plan.find((s) => !s.done && m >= s.at);
      if (stop) {
        stop.done = true;
        for (let k = 0; k < stop.wait; k++) { t += 1000; pts.push({ m, t, v: 0 }); }
      }
      // vor einem geplanten Halt abbremsen
      const next = plan.find((s) => !s.done);
      const speed = next && next.at - m < 40 ? Math.max(2, (next.at - m) / 3) : v;
      m += speed; t += 1000;
      pts.push({ m, t, v: speed });
    }
    rec = newRecording('auto', demoSignals, true);
    enterDriveView();
    setDriveState('Testfahrt läuft …', '');
    let i = 0;
    rec.demoTimer = setInterval(() => {
      if (!rec) return;
      if (i >= pts.length) { clearInterval(rec.demoTimer); finishTrip(); return; }
      const q = pts[i++];
      const g = at(q.m);
      onPosition({ timestamp: q.t, coords: { latitude: g.lat, longitude: g.lon, accuracy: 6, speed: q.v } });
    }, 40);
  }

  // ---------- Export und Import ----------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const file = typeof File === 'function' ? new File([blob], name, { type }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Flowtown Daten' }).catch(() => {});
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  $('#btn-export').addEventListener('click', () => {
    download(`flowtown-${stamp()}.json`, JSON.stringify({ app: 'flowtown', version: VERSION, exported: new Date().toISOString(), names, trips }, null, 1), 'application/json');
  });
  $('#btn-export-csv').addEventListener('click', () => {
    const head = ['fahrt', 'verkehrsmittel', 'demo', 'typ', 'ampel', 'name', 'lat', 'lon', 'zeit', 'wartezeit_s', 'halte', 'richtung_grad', 'bewertung', 'stichworte'];
    const lines = [head.join(';')];
    for (const tr of trips) for (const e of tr.events) {
      lines.push([tr.id, tr.mode, tr.demo ? 1 : 0, e.type === 'pass' ? 'durchfahrt' : 'halt', e.signal || '', labelFor(e).replace(/;/g, ','), e.lat, e.lon, new Date(e.t).toISOString(),
        e.type === 'halt' ? Math.round(e.wait / 1000) : 0, e.halts || 0, (e.heading == null ? '' : e.heading), (e.rating == null ? '' : e.rating), (e.tags || []).join('|')].join(';'));
    }
    download(`flowtown-halte-${stamp()}.csv`, lines.join('\n'), 'text/csv');
  });
  $('#inp-import').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.trips)) throw new Error('kein Flowtown-Export');
      const known = new Set(trips.map((t) => t.id));
      const add = data.trips.filter((t) => t && t.id && Array.isArray(t.events) && !known.has(t.id));
      trips = trips.concat(add); saveTrips();
      if (data.names) { names = Object.assign({}, data.names, names); store.set('names', names); }
      moreMsg(`${add.length} Fahrt${add.length === 1 ? '' : 'en'} importiert.`);
    } catch (e) {
      moreMsg('Die Datei konnte nicht gelesen werden. Bitte wähle einen Export aus dieser App.');
    }
    ev.target.value = '';
  });
  function moreMsg(t) { $('#more-msg').textContent = t; }

  // ---------- Navigation ----------
  function showView(name) {
    if (name !== 'map') stopMyLocation();
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    $$('.tabs button').forEach((b) => {
      const active = b.dataset.view === name || (name === 'drive' && b.dataset.view === 'start') || (name === 'review' && b.dataset.view === 'stats');
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (name === 'stats') renderStats();
    if (name === 'tips') renderTips();
    if (name === 'map') renderMap();
    if (name === 'start') { renderToday(); renderLastTrip(); }
    if (name === 'more') updateSignalsInfo();
    const h = $('#view-' + name + ' h2');
    if (h && name !== 'drive') { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    $('#main').scrollTop = 0;
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ---------- Heute: Verkehrsmittel, eigene Wege, beste Abfahrtszeit ----------
  const MODE_GROUP = { auto: 'auto', rad: 'rad', bus: 'oepnv', bahn: 'oepnv', fuss: 'fuss' };
  const GROUP_WITH = { auto: 'mit dem Auto', rad: 'mit dem Rad', oepnv: 'mit Bus und Bahn', fuss: 'zu Fuß' };
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const durText = (ms) => (ms >= 3600000 ? fmtDur(ms) : fmtDur(ms) + ' min');
  const avgOf = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const tripWait = (t) => t.events.reduce((a, e) => a + (e.type === 'halt' && e.signal ? e.wait : 0), 0);
  function selectedMode() {
    const g = $('input[name="mgroup"]:checked').value;
    return g === 'oepnv' ? $('input[name="pt"]:checked').value : g;
  }
  function setModeUI(mode) {
    const g = MODE_GROUP[mode] || 'auto';
    $(`input[name="mgroup"][value="${g}"]`).checked = true;
    if (g === 'oepnv') $(`input[name="pt"][value="${mode}"]`).checked = true;
    $('#pt-row').hidden = g !== 'oepnv';
  }
  function accText(id) {
    const c = clusterById[id];
    const w = (x) => (x === 'yes' ? 'ja' : x === 'no' ? 'nein' : 'nicht eingetragen');
    return c ? `Tonsignal: ${w(c.sound)} · Vibration: ${w(c.vib)}` : 'Keine Angaben zur Barrierefreiheit';
  }
  // Wiederkehrende Wege: Fahrten mit überwiegend denselben Ampeln in ähnlicher Richtung. Alles bleibt auf dem Gerät.
  function findRoutes(list) {
    const groups = [];
    for (const t of list.slice().sort((a, b) => a.start - b.start)) {
      const ev = t.events.filter((e) => e.signal);
      const sig = Array.from(new Set(ev.map((e) => e.signal)));
      if (sig.length < 3) continue;
      const first = ev[0], last = ev[ev.length - 1];
      const dir = dist(first, last) > 200 ? bearing(first, last) : null;
      const set = new Set(sig);
      let g = groups.find((x) => {
        const inter = x.sig.filter((id) => set.has(id)).length;
        // überwiegend dieselben Ampeln; eine kürzere Fahrt auf demselben Weg zählt mit
        const same = inter >= 3 && inter / Math.min(x.sig.length, sig.length) >= 0.7 && inter / (x.sig.length + sig.length - inter) >= 0.35;
        return same && (x.dir == null || dir == null || angDiff(x.dir, dir) <= 60);
      });
      if (!g) { g = { sig, dir, first, last, trips: [] }; groups.push(g); }
      g.trips.push(t);
    }
    return groups.filter((g) => g.trips.length >= 2);
  }
  // Abfahrtsstunde mit der geringsten Wartezeit, verglichen mit jetzt oder mit allen anderen Stunden
  function bestHour(own) {
    const now = new Date().getHours();
    const hours = {};
    for (const t of own) { const h = new Date(t.start).getHours(); (hours[h] = hours[h] || []).push(tripWait(t)); }
    const hs = Object.keys(hours).map(Number);
    const nowAvg = hours[now] ? avgOf(hours[now]) : avgOf(own.map(tripWait));
    if (hs.length < 2) return { nowAvg };
    const best = hs.reduce((b, h) => (avgOf(hours[h]) < avgOf(hours[b]) ? h : b), hs[0]);
    const ref = hours[now] ? nowAvg : avgOf(own.filter((t) => new Date(t.start).getHours() !== best).map(tripWait));
    if (best === now || ref - avgOf(hours[best]) < 30000) return { nowAvg };
    return { nowAvg, best, bestAvg: avgOf(hours[best]), ref,
      text: `Am wenigsten gewartet hast du bei Abfahrt zwischen ${best} und ${best + 1} Uhr: Ø ${durText(avgOf(hours[best]))} statt ${durText(ref)}.` };
  }
  function routeCard(g, group) {
    const own = g.trips.filter((t) => MODE_GROUP[t.mode] === group);
    let body;
    if (own.length) {
      const bh = bestHour(own);
      body = `<div class="big-line">${ic('hourglass')}<span>Jetzt los: etwa <b>${durText(bh.nowAvg)}</b> an Ampeln</span></div>`;
      if (bh.text) body += `<p class="tip">${ic('bulb')}<span>${bh.text}</span></p>`;
    } else {
      body = `<p class="note">${ic('info')}<span>${cap(GROUP_WITH[group])} bist du diesen Weg noch nicht ${words(group).past}.</span></p>`;
    }
    // Strecken-Vergleich: derselbe Weg mit verschiedenen Verkehrsmitteln
    const byMode = {};
    for (const t of g.trips) (byMode[MODE_GROUP[t.mode]] = byMode[MODE_GROUP[t.mode]] || []).push(t);
    if (Object.keys(byMode).length >= 2) {
      body += `<div class="compare">${Object.keys(byMode).map((m) => `<div>${ic(MODE_ICON[m])}<span>${cap(GROUP_WITH[m])}: Ø ${durText(avgOf(byMode[m].map((t) => t.end - t.start)))} unterwegs, ${durText(avgOf(byMode[m].map(tripWait)))} an Ampeln</span></div>`).join('')}</div>`;
    }
    return `<div class="card"><div class="card-head"><span class="chip">${ic('route')}</span><div><span class="meta">Dein Weg · ${g.trips.length}× unterwegs</span><div class="route-name">${esc(labelFor(g.first))}<span class="arrow" aria-label="nach">→</span>${esc(labelFor(g.last))}</div></div></div>${body}</div>`;
  }
  function modeCard(group) {
    const since = Date.now() - 30 * 864e5;
    const ts = trips.filter((t) => !t.demo && MODE_GROUP[t.mode] === group && t.start >= since);
    const head = cardHead(MODE_ICON[group], cap(GROUP_WITH[group]), 'Die letzten 30 Tage');
    const later = group === 'oepnv' ? `<p class="note">${ic('bell')}<span>Abfahrten und Verspätungen von moBiel zeigt Flowtown, sobald eine Datenquelle angebunden ist.</span></p>` : '';
    const w = words(group);
    if (!ts.length) return `<div class="card">${head}<p class="note">${ic('info')}<span>${w.none}. Starte unten deine erste Aufzeichnung.</span></p>${later}</div>`;
    const km = ts.reduce((a, t) => a + t.distance, 0) / 1000;
    const halts = ts.reduce((a, t) => a + t.events.filter((e) => e.type === 'halt' && e.signal).length, 0);
    const wait = ts.reduce((a, t) => a + tripWait(t), 0);
    let extra = '';
    if (group === 'oepnv') {
      const atStops = ts.reduce((a, t) => a + t.events.reduce((b, e) => b + (e.atStop ? e.wait : 0), 0), 0);
      const trs = ts.reduce((a, t) => a.concat(t.transfers || []), []);
      const missed = trs.filter((r) => r.missed).length;
      extra = `${atStops || trs.length ? `<ul class="facts"><li>${ic('pin')}<span>An Haltestellen</span><b>${durText(atStops)}</b></li><li>${ic('light')}<span>An Ampeln</span><b>${durText(wait)}</b></li>${trs.length ? `<li>${ic('walk')}<span>Ø je Umstieg (${trs.length}×)</span><b>${durText(avgOf(trs.map((r) => r.wait)))}</b></li>` : ''}${missed ? `<li>${ic('alert')}<span>Anschluss verpasst</span><b>${missed}×</b></li>` : ''}</ul>` : ''}<p class="note">${ic('info')}<span>Die Zeit an Ampeln ist Verlustzeit, die ein besserer Vorrang für Bus und Bahn sparen könnte.</span></p>`;
    }
    const mini = (icon, val, label) => `<div class="mini">${ic(icon)}<b>${val}</b><span>${label}</span></div>`;
    return `<div class="card">${head}<div class="minis">${mini('list', ts.length, ts.length === 1 ? w.one : w.many)}${mini('route', fmtNum(km, 1) + ' km', 'Strecke')}${mini('light', fmtNum(km ? halts / km : 0, 1), 'Ampelhalte je km')}${mini('hourglass', durText(wait / ts.length), 'Ø an Ampeln je ' + w.one)}</div>${extra}${later}</div>`;
  }
  function accessCard() {
    const ids = new Set();
    for (const t of trips) for (const e of t.events) if (e.signal && !e.signal.startsWith('demo')) ids.add(e.signal);
    let yes = 0, no = 0, unk = 0;
    for (const id of ids) { const c = clusterById[id]; if (c && c.sound === 'yes') yes++; else if (c && c.sound === 'no') no++; else unk++; }
    return `<div class="card">${cardHead('access', 'Barrierefrei unterwegs', esc(ACCESS_LABEL[settings.access.type]))}
      ${ids.size ? `<p class="small muted">Ampeln auf deinen Wegen laut OpenStreetMap</p><ul class="facts"><li>${ic('sound')}<span>mit Tonsignal</span><b>${yes}</b></li><li>${ic('light')}<span>ohne Tonsignal</span><b>${no}</b></li><li>${ic('info')}<span>ohne Angabe</span><b>${unk}</b></li></ul>` : `<p class="note">${ic('sound')}<span>Nach den ersten Fahrten siehst du hier, welche Ampeln auf deinen Wegen ein Tonsignal haben.</span></p>`}
      <p class="note">${ic('thumb')}<span>Bei der Bewertung gibt es zusätzliche Stichworte wie „Grün zu kurz zum Queren“.</span></p>
      <p class="note">${ic('shield')}<span>Deine Aufzeichnungen tragen den Hinweis „${esc(ACCESS_LABEL[settings.access.type])}“, damit sich Wartezeiten mit Einschränkung getrennt auswerten lassen. Das bleibt auf deinem Gerät.</span></p></div>`;
  }
  function renderToday() {
    const group = MODE_GROUP[selectedMode()];
    const now = new Date().getHours();
    const hourGap = (g) => Math.min(...g.trips.map((t) => { const d = Math.abs(new Date(t.start).getHours() - now); return Math.min(d, 24 - d); }));
    const own = (g) => g.trips.filter((t) => MODE_GROUP[t.mode] === group).length;
    let routes = findRoutes(trips.filter((t) => !t.demo)).sort((a, b) => own(b) - own(a) || hourGap(a) - hourGap(b));
    if (routes.some(own)) routes = routes.filter(own);   // Wege mit anderen Verkehrsmitteln nur, solange es keine eigenen gibt
    const html = routes.length
      ? routes.slice(0, 2).map((g) => routeCard(g, group))
      : [`<div class="card">${cardHead('route', 'Deine Wege')}<p class="small">Wenn du dieselbe Strecke zwei-, dreimal zurückgelegt hast, erkennt Flowtown deinen Weg und zeigt dir, wann du am wenigsten wartest. Das bleibt auf deinem Gerät.</p></div>`];
    const top = computeTips()[0];
    if (top) html.unshift(`<div class="card top-tip">${cardHead('bulb', 'Dein Tipp', '', 'amber')}<p>${top.short}</p><button type="button" class="btn" data-goto="tips">${ic('bulb')}Alle Tipps</button></div>`);
    html.push(modeCard(group));
    if (settings.access.on) html.push(accessCard());
    $('#today').innerHTML = html.join('');
  }

  // ---------- Flowtown-Server: Ebene „Wir“, KI-Einschätzung, Meldungen ----------
  const apiBase = () => (settings.server.url || '').trim().replace(/\/+$/, '');
  async function api(pathPart, opts) {
    const res = await fetchWithTimeout(apiBase() + pathPart, opts || {}, pathPart === '/api/ki' ? 45000 : 15000);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.fehler || 'HTTP ' + res.status);
    return j;
  }
  const postJson = (pathPart, body) => api(pathPart, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function contributorId() {
    if (!settings.cid) {
      const b = new Uint8Array(16); crypto.getRandomValues(b);
      settings.cid = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      store.set('settings', settings);
    }
    return settings.cid;
  }
  // Nur Ampel, Richtung (Achtel), Zeitfenster, Wartezeit; Fahrten, Orte und Uhrzeiten bleiben auf dem Gerät
  const wirItems = (t) => t.events.filter((e) => e.signal && /^c\d+$/.test(e.signal)).map((e) => ({
    s: e.signal, d: e.heading == null ? -1 : Math.round(e.heading / 45) % 8, w: timeWindow(e.t), wait: e.type === 'halt' ? e.wait : 0, halt: e.type === 'halt'
  }));
  async function flushWir(trip) {
    if (!apiBase() || !settings.server.wir) return;
    const queue = store.get('wirQueue', []);
    if (trip && !trip.demo) queue.push(trip.id);
    const left = [];
    for (const id of queue.slice(-50)) {
      const t = trips.find((x) => x.id === id);
      if (!t) continue;
      try { await postJson('/api/wir', { cid: contributorId(), items: wirItems(t) }); } catch (e) { left.push(id); }
    }
    store.set('wirQueue', left);
  }
  let wirCache = null, wirAt = 0, newsCache = [], newsAt = 0;
  async function loadWir() {
    if (!apiBase() || !settings.server.wir) return null;
    if (wirCache && Date.now() - wirAt < 600000) return wirCache;
    const ids = Array.from(new Set([].concat(...trips.map((t) => t.events.filter((e) => e.signal && /^c\d+$/.test(e.signal)).map((e) => e.signal))))).slice(0, 400);
    if (!ids.length) return null;
    try { wirCache = (await api('/api/wir?s=' + ids.join(','))).werte || {}; wirAt = Date.now(); } catch (e) { /* ohne Server weiter */ }
    return wirCache;
  }
  // Werte anderer für eine Ampel in einer Richtung, über alle Zeitfenster
  function othersAt(signal, heading) {
    if (!wirCache) return null;
    const d = heading == null ? -1 : Math.round(heading / 45) % 8;
    let v = 0, h = 0, w = 0, n = 0;
    for (const k in wirCache) {
      const [s, dd] = k.split('|');
      if (s !== signal || Number(dd) !== d) continue;
      const x = wirCache[k]; v += x.v; h += x.h; w += x.avg * x.h; n = Math.max(n, x.n);
    }
    return v ? { n, share: h / v, avg: h ? w / h : 0 } : null;
  }
  async function loadNews() {
    if (!apiBase()) { newsCache = []; return; }
    if (Date.now() - newsAt < 600000) return;
    try { newsCache = (await api('/api/news')).meldungen || []; newsAt = Date.now(); } catch (e) { /* ohne Server weiter */ }
  }
  // Meldungen nur, wenn sie die eigenen Wege betreffen (oder für die ganze Stadt gelten); geprüft wird auf dem Gerät
  function myNews() {
    const pts = [];
    for (const t of trips) if (!t.demo) for (const e of t.events) if (e.signal) pts.push(e);
    return newsCache.filter((n) => n.lat == null || n.lon == null || pts.some((q) => dist(q, n) <= (n.radius_m || 300)));
  }

  // ---------- Tipps: feste Auswertung auf dem Gerät, noch ohne KI ----------
  const BIKE_KMH = 15, WALK_KMH = 4.8;   // Annahmen für Schätzungen
  const median = (xs) => { const v = xs.slice().sort((x, y) => x - y), m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const dayLabel = (t) => new Date(t).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const routeName = (g) => `${esc(labelFor(g.first))}<span class="arrow" aria-label="nach">→</span>${esc(labelFor(g.last))}`;

  // Ungewöhnlich lange Wartezeit an einer Ampel in den letzten 7 Tagen, verglichen mit den übrigen Besuchen
  function tipAnomalies(list) {
    const out = anomalyList(list);
    if (!out.length) return null;
    const first = out[0];
    return { prio: 0, icon: 'alert', cls: 'amber', title: 'Auffällig auf deinen Wegen',
      short: `${esc(labelFor(first.e))}: ${durText(first.e.wait)} gewartet, sonst Ø ${durText(first.usual)}.`,
      html: `<ul class="facts">${out.slice(0, 3).map((x) => `<li>${ic('light')}<span>${dayLabel(x.e.t)} · ${esc(labelFor(x.e))}</span><b>${durText(x.e.wait)}</b></li>`).join('')}</ul>
        <p class="note">${ic('info')}<span>Sonst wartest du dort Ø ${out.slice(0, 3).map((x) => durText(x.usual)).join(' bzw. ')}. Vielleicht Baustelle, Sperrung oder Stau.</span></p>` };
  }
  function anomalyList(list) {
    const since = Date.now() - 7 * 864e5;
    const visits = {};
    for (const t of list) for (const e of t.events) if (e.signal) (visits[e.signal] = visits[e.signal] || []).push({ e, trip: t.id });
    const out = [];
    for (const t of list) {
      if (t.start < since) continue;
      for (const e of t.events) {
        if (e.type !== 'halt' || !e.signal || e.wait < 60000) continue;
        const others = visits[e.signal].filter((v) => v.trip !== t.id && (e.heading == null || v.e.heading == null || angDiff(v.e.heading, e.heading) <= 45))
          .map((v) => (v.e.type === 'halt' ? v.e.wait : 0));
        if (others.length < 3) continue;
        const usual = median(others);
        if (e.wait >= 2 * usual + 30000) out.push({ e, usual });
      }
    }
    return out.sort((x, y) => y.e.t - x.e.t);
  }
  // Wege: beste Abfahrtszeit und andere Verkehrsmittel im Vergleich
  function tipRoutes(list) {
    return findRoutes(list).slice(0, 3).map((g) => {
      const km = avgOf(g.trips.map((t) => t.distance)) / 1000;
      const byMode = {};
      for (const t of g.trips) (byMode[MODE_GROUP[t.mode]] = byMode[MODE_GROUP[t.mode]] || []).push(t);
      const car = byMode.auto || [];
      const carMs = car.length ? avgOf(car.map((t) => t.end - t.start)) : null;
      const rows = [];
      const row = (m, label, ms, est, extra) => rows.push(`<div>${ic(MODE_ICON[m])}<span>${label}${est ? ' <span class="tag-est">geschätzt</span>' : ''}${extra ? `<br><span class="small muted">${extra}</span>` : ''}</span><b>${durText(ms)}</b></div>`);
      if (car.length) {
        const costs = car.map(tripCosts).filter(Boolean);
        const energy = costs.filter((c) => c.energy != null);
        const cost = energy.length ? avgOf(energy.map((c) => c.energy)) : avgOf(costs.map((c) => c.halts));
        row('auto', 'Auto', carMs, false, `davon ${durText(avgOf(car.map(tripWait)))} an Ampeln · ca. ${fmtEuro(cost)} ${energy.length ? 'Sprit oder Strom' : 'fürs Warten'}`);
      }
      if (byMode.oepnv) row('bahn', 'Bus und Bahn', avgOf(byMode.oepnv.map((t) => t.end - t.start)), false, `davon ${durText(avgOf(byMode.oepnv.map(tripWait)))} an Ampeln`);
      let bikeMs = null;
      if (byMode.rad) row('rad', 'Rad', bikeMs = avgOf(byMode.rad.map((t) => t.end - t.start)), false, `davon ${durText(avgOf(byMode.rad.map(tripWait)))} an Ampeln`);
      else if (km <= 15) row('rad', 'Rad', bikeMs = km / BIKE_KMH * 3600000, true, `${fmtNum(km, 1)} km bei ${BIKE_KMH} km/h, ohne Ampeln`);
      if (byMode.fuss) row('fuss', 'Zu Fuß', avgOf(byMode.fuss.map((t) => t.end - t.start)), false);
      else if (km <= 3) row('fuss', 'Zu Fuß', km / WALK_KMH * 3600000, true, `${fmtNum(km, 1)} km bei ${fmtNum(WALK_KMH, 1)} km/h`);
      const bh = car.length ? bestHour(car) : bestHour(g.trips);
      let short = bh.text || '';
      let prio = bh.text ? 1.5 : 2.5;
      // Rad als Alternative zum Auto oder zu Bus und Bahn
      const baseMs = carMs || (byMode.oepnv ? avgOf(byMode.oepnv.map((t) => t.end - t.start)) : null);
      if (baseMs && bikeMs && !byMode.rad && bikeMs <= baseMs * 1.25) {
        short = `Mit dem Rad wärst du auf diesem Weg etwa gleich schnell wie ${carMs ? 'mit dem Auto' : 'mit Bus und Bahn'} (geschätzt).`;
        prio = 1;
      }
      return { prio, icon: 'route', title: routeName(g), meta: `Dein Weg · ${g.trips.length}× unterwegs`, short: short || `${g.trips.length}× unterwegs auf diesem Weg.`,
        html: `${bh.text ? `<p class="tip">${ic('bulb')}<span>${bh.text}</span></p>` : ''}${prio === 1 ? `<p class="tip">${ic('bike')}<span>${short}</span></p>` : ''}<div class="alt">${rows.join('')}</div>
          <p class="note">${ic('bell')}<span>Fahrpläne von Bus und Bahn als Alternative kommen mit dem Flowtown-Server.</span></p>` };
    });
  }
  function tipTimeEaters(list) {
    const ag = aggregate(list);
    if (!ag.halts) return null;
    const top = ag.approaches.filter((x) => x.halts).sort((x, y) => y.wait - x.wait).slice(0, 3);
    const share = top.reduce((x, y) => x + y.wait, 0) / ag.wait;
    const what = top.length === 1 ? 'eine Ampel' : `${top.length} Ampeln`;
    return { prio: 2, icon: 'hourglass', cls: 'bad', title: 'Deine größten Zeitfresser',
      short: `${fmtPct(share)} deiner Wartezeit an Ampeln entfallen auf ${what}.`,
      html: `<p>${fmtPct(share)} deiner Wartezeit an Ampeln entfallen auf ${what}:</p><ul class="facts">${top.map((x) => { const o = othersAt(x.signal, x.h); return `<li>${ic('light')}<span>${esc(labelFor(x.sample))}${x.h != null ? `, Richtung ${esc(dirShort(x.h))}` : ''}${o ? `<span class="others">Andere (${o.n}): ${fmtPct(o.share)} mit Halt, Ø ${durText(o.avg)}</span>` : ''}</span><b>${durText(x.wait)}</b></li>`; }).join('')}</ul>` };
  }
  // Autofahrten: Wartezeit an Ampeln je km nach Zeitfenster
  // Autofahrten: Wartezeit an Ampeln je km je Zeitfenster
  function windowStats(list, minTrips) {
    const per = {};
    for (const t of list) {
      if (t.mode !== 'auto' || t.distance < 1000) continue;
      const w = timeWindow(t.start);
      (per[w] = per[w] || []).push(tripWait(t) / (t.distance / 1000));
    }
    return WINDOWS.filter((w) => per[w.id] && per[w.id].length >= minTrips).map((w) => ({ w, v: avgOf(per[w.id]), n: per[w.id].length }));
  }
  function tipWindows(list) {
    const ws = windowStats(list, 2);
    if (ws.length < 2) return null;
    ws.sort((x, y) => x.v - y.v);
    const best = ws[0], worst = ws[ws.length - 1];
    if (worst.v - best.v < 5000) return null;
    return { prio: 3, icon: 'clock', title: 'Wann es besser fließt', meta: 'Mit dem Auto, Wartezeit je km',
      short: `${worst.w.label} wartest du je km am längsten, ${best.w.label} am kürzesten.`,
      html: `<ul class="facts">${ws.map((x) => `<li>${ic('clock')}<span>${esc(x.w.label)} <span class="small muted">(${x.n} Fahrten)</span></span><b>${durText(x.v)}</b></li>`).join('')}</ul>` };
  }
  function tipStyle(list) {
    const since = Date.now() - 30 * 864e5;
    const car = list.filter((t) => t.mode === 'auto' && t.start >= since && t.stats);
    const steady = car.map((t) => t.stats.steadyShare).filter((x) => x != null);
    const km = car.reduce((x, t) => x + t.distance, 0) / 1000;
    if (!steady.length || km < 5) return null;
    const share = avgOf(steady), brakes = car.reduce((x, t) => x + (t.stats.brakes || 0), 0) / km * 100;
    if (share >= 0.4 && brakes < 2) return null;
    return { prio: 4, icon: 'wave', title: 'Gleichmäßiger fahren', meta: 'Die letzten 30 Tage',
      short: `Du fährst zu Ø ${fmtPct(share)} gleichmäßig.`,
      html: `<ul class="facts"><li>${ic('wave')}<span>gleichmäßig gefahren</span><b>${fmtPct(share)}</b></li><li>${ic('alert')}<span>starke Bremsungen je 100 km</span><b>${fmtNum(brakes, 1)}</b></li></ul>
        <p class="note">${ic('bulb')}<span>Früh vom Gas gehen und auf eine rote Ampel zurollen: Oft wird es grün, bevor du ganz anhalten musst. Das spart Sprit und Bremsen.</span></p>` };
  }
  function tipCosts(list) {
    const since = Date.now() - 30 * 864e5;
    const cs = list.filter((t) => t.start >= since).map(tripCosts).filter(Boolean);
    if (!cs.length) return null;
    const halts = cs.reduce((x, c) => x + c.halts, 0);
    if (halts < 0.05) return null;
    return { prio: 5, icon: 'euro', cls: 'amber', title: 'Was dich Ampeln kosten', meta: 'Die letzten 30 Tage, geschätzt',
      short: `Ampelhalte kosteten dich etwa ${fmtEuro(halts)}.`,
      html: `<p>Leerlauf und Wiederanfahren an Ampeln kosteten dich bei ${cs.length} Autofahrt${cs.length === 1 ? '' : 'en'} etwa <strong>${fmtEuro(halts)}</strong>.</p>` };
  }
  function tipNews() {
    const ns = myNews();
    if (!ns.length) return null;
    return { prio: -1, icon: 'bell', cls: 'amber', title: 'Meldungen für deine Wege', short: `${esc(ns[0].titel)}${ns.length > 1 ? ` und ${ns.length - 1} weitere Meldung${ns.length > 2 ? 'en' : ''}` : ''}.`,
      html: `<ul class="ki-list">${ns.map((n) => `<li>${ic('bell')}<span><strong>${esc(n.titel)}</strong>${n.text ? `<br>${esc(n.text)}` : ''}${n.quelle ? `<br><span class="small muted">Quelle: ${esc(n.quelle)}${n.bis ? ` · bis ${esc(n.bis)}` : ''}</span>` : ''}</span></li>`).join('')}</ul>` };
  }
  function computeTips() {
    const list = trips.filter((t) => !t.demo);
    return [tipNews(), tipAnomalies(list)].concat(tipRoutes(list), [tipTimeEaters(list), tipWindows(list), tipStyle(list), tipCosts(list)])
      .filter(Boolean).sort((x, y) => x.prio - y.prio);
  }
  function renderTips() {
    const tips = computeTips();
    const news = myNews().length ? '' : `<div class="card">${cardHead('bell', 'Meldungen', 'Sperrungen, Baustellen, Ausfälle')}<p class="small">${apiBase() ? 'Gerade keine Meldungen für deine Wege.' : 'Meldungen der Stadt und von moBiel zu deinen Wegen erscheinen hier, sobald der Flowtown-Server unter „Mehr“ eingetragen ist.'} Angezeigt wird nur, was deine Wege betrifft.</p></div>`;
    $('#tips-body').innerHTML = kiCard() + (tips.length
      ? tips.map((x) => `<div class="card">${cardHead(x.icon, x.title, x.meta || '', x.cls)}${x.html}</div>`).join('')
      : `<div class="card">${cardHead('bulb', 'Noch zu wenig Daten')}<p class="small">Nach ein paar Fahrten auf deinen üblichen Wegen findest du hier deine Zeitfresser, die besten Abfahrtszeiten und Alternativen mit Rad oder zu Fuß.</p></div>`) + news;
    requestNames([].concat(...trips.map((t) => t.events.filter((e) => e.signal))), () => { if (!$('#view-tips').hidden) renderTips(); });
    // Werte anderer und Meldungen nachladen, dann einmal neu zeichnen
    if (!tipsLoading && apiBase() && (Date.now() - newsAt > 600000 || (settings.server.wir && Date.now() - wirAt > 600000))) {
      tipsLoading = true;
      Promise.all([loadNews(), loadWir()]).then(() => { if (!$('#view-tips').hidden) renderTips(); }).finally(() => { tipsLoading = false; });
    }
  }
  let tipsLoading = false;
  // ---------- KI-Einschätzung ----------
  const kiState = { busy: false, error: '', result: store.get('ki', null) };
  function kiCard() {
    if (!apiBase()) return '';
    if (!settings.server.ki) return `<div class="card">${cardHead('spark', 'KI-Einschätzung', 'Mistral, EU')}<p class="small">Erlaube die KI-Einschätzung unter „Mehr“, dann formuliert eine KI aus deinen Werten persönliche Empfehlungen.</p></div>`;
    const r = kiState.result;
    const body = r ? `<p>${esc(r.einschaetzung)}</p>${r.groesster_hebel ? `<p class="tip">${ic('spark')}<span><strong>Größter Hebel:</strong> ${esc(r.groesster_hebel)}</span></p>` : ''}<ul class="ki-list">${r.empfehlungen.map((e) => `<li>${ic('bulb')}<span><strong>${esc(e.titel)}</strong><br>${esc(e.text)}</span></li>`).join('')}</ul>
      <p class="note">${ic('info')}<span>KI-Text von ${esc(r.modell || 'Mistral')}, erstellt am ${esc(dayLabel(r.t))} Er kann Fehler enthalten.</span></p>` : '<p class="small">Eine KI formuliert aus deinen zusammengefassten Werten eine Einschätzung und Empfehlungen.</p>';
    return `<div class="card">${cardHead('spark', 'KI-Einschätzung', 'Mistral, EU')}${body}${kiState.error ? `<p class="msg warn">${esc(kiState.error)}</p>` : ''}
      <button type="button" class="btn${r ? '' : ' primary'}" id="btn-ki" ${kiState.busy ? 'disabled' : ''}>${ic('spark')}${kiState.busy ? 'Einschätzung wird erstellt …' : r ? 'Neu einschätzen' : 'Einschätzung holen'}</button></div>`;
  }
  // Zusammengefasste Werte für die KI: keine Koordinaten, keine Uhrzeiten einzelner Fahrten, keine Start- und Zielorte
  function kiFacts() {
    const list = trips.filter((t) => !t.demo);
    const since = Date.now() - 30 * 864e5;
    const recent = list.filter((t) => t.start >= since);
    const s = (ms) => Math.round(ms / 1000);
    const groups = {};
    for (const t of recent) {
      const g = groups[MODE_GROUP[t.mode]] || (groups[MODE_GROUP[t.mode]] = { fahrten: 0, km: 0, warten_an_ampeln_s: 0, halte_an_ampeln: 0 });
      g.fahrten++; g.km += t.distance / 1000; g.warten_an_ampeln_s += s(tripWait(t)); g.halte_an_ampeln += t.events.filter((e) => e.type === 'halt' && e.signal).length;
    }
    for (const g of Object.values(groups)) g.km = Math.round(g.km * 10) / 10;
    const ag = aggregate(list);
    const zeitfresser = ag.approaches.filter((x) => x.halts).sort((x, y) => y.wait - x.wait).slice(0, 5).map((x) => {
      const o = othersAt(x.signal, x.h);
      return { ampel: labelFor(x.sample), richtung: x.h != null ? dirShort(x.h) : null, vorbeigekommen: x.halts + x.passes, gehalten: x.halts, warten_gesamt_s: s(x.wait),
        andere: o ? { personen: o.n, anteil_mit_halt: Math.round(o.share * 100) / 100, warten_je_halt_s: s(o.avg) } : undefined };
    });
    const wege = findRoutes(list).slice(0, 3).map((g) => {
      const byMode = {};
      for (const t of g.trips) (byMode[MODE_GROUP[t.mode]] = byMode[MODE_GROUP[t.mode]] || []).push(t);
      const km = avgOf(g.trips.map((t) => t.distance)) / 1000;
      const out = { von: labelFor(g.first), nach: labelFor(g.last), km: Math.round(km * 10) / 10, gemessen: {} };
      for (const m of Object.keys(byMode)) out.gemessen[m] = { fahrten: byMode[m].length, dauer_min: Math.round(avgOf(byMode[m].map((t) => t.end - t.start)) / 6000) / 10, warten_an_ampeln_s: s(avgOf(byMode[m].map(tripWait))) };
      if (!byMode.rad && km <= 15) out.rad_geschaetzt_min = Math.round(km / BIKE_KMH * 600) / 10;
      if (!byMode.fuss && km <= 3) out.zu_fuss_geschaetzt_min = Math.round(km / WALK_KMH * 600) / 10;
      const bh = bestHour(byMode.auto || g.trips);
      if (bh.text) out.beste_abfahrt = { stunde: bh.best, warten_s: s(bh.bestAvg), sonst_s: s(bh.ref) };
      // wie oft und wann: Abfahrten je Stunde mit Ø Wartezeit an Ampeln
      const inMonth = g.trips.filter((t) => t.start >= since).length;
      out.fahrten_pro_woche = Math.round(inMonth / (30 / 7) * 10) / 10;
      const hours = {};
      for (const t of g.trips) { const h = new Date(t.start).getHours(); (hours[h] = hours[h] || []).push(tripWait(t)); }
      out.abfahrten = Object.keys(hours).map(Number).sort((x, y) => x - y).map((h) => ({ stunde: h, fahrten: hours[h].length, warten_an_ampeln_s: s(avgOf(hours[h])) }));
      return out;
    });
    const plain = (x) => String(x).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const car = recent.filter((t) => t.mode === 'auto' && t.stats);
    const steady = car.map((t) => t.stats.steadyShare).filter((x) => x != null);
    const carKm = car.reduce((x, t) => x + t.distance, 0) / 1000;
    const costs = recent.map(tripCosts).filter(Boolean);
    const trs = recent.reduce((x, t) => x.concat(t.transfers || []), []);
    return {
      zeitraum: 'letzte 30 Tage', profil_barrierefrei: settings.access.on ? ACCESS_LABEL[settings.access.type] : null,
      verkehrsmittel: groups, zeitfresser, wege,
      auto_warten_je_km_nach_zeitfenster: windowStats(list, 1).map((x) => ({ zeitfenster: x.w.label, fahrten: x.n, warten_je_km_s: s(x.v) })),
      auffaelligkeiten_7_tage: anomalyList(list).slice(0, 5).map((x) => ({ tag: dayLabel(x.e.t), ampel: labelFor(x.e), warten_s: s(x.e.wait), sonst_s: s(x.usual) })),
      app_hinweise: computeTips().filter((x) => x.icon !== 'bell').map((x) => plain(x.title) + ': ' + plain(x.short)),
      fahrweise_auto: steady.length ? { gleichmaessig_anteil: Math.round(avgOf(steady) * 100) / 100, starke_bremsungen_je_100km: carKm ? Math.round(car.reduce((x, t) => x + (t.stats.brakes || 0), 0) / carKm * 1000) / 10 : null } : null,
      kosten_ampelhalte_eur_geschaetzt: costs.length ? Math.round(costs.reduce((x, c) => x + c.halts, 0) * 100) / 100 : null,
      umstiege: trs.length ? { anzahl: trs.length, warten_je_umstieg_s: s(avgOf(trs.map((r) => r.wait))), anschluss_verpasst: trs.filter((r) => r.missed).length } : null
    };
  }
  async function runKi() {
    kiState.busy = true; kiState.error = ''; renderTips();
    try {
      await loadWir();
      const r = await postJson('/api/ki', { facts: kiFacts() });
      kiState.result = Object.assign({ t: Date.now() }, r);
      store.set('ki', kiState.result);
    } catch (e) {
      kiState.error = 'Die Einschätzung hat nicht geklappt: ' + e.message;
    }
    kiState.busy = false;
    if (!$('#view-tips').hidden) renderTips();
  }

  function renderLastTrip() {
    const t = trips.filter((x) => !x.demo).slice(-1)[0];
    const el = $('#last-trip');
    if (!t) { el.innerHTML = ''; return; }
    const h = t.events.filter((e) => e.type === 'halt' && e.signal);
    el.innerHTML = `<div class="card">${cardHead(MODE_ICON[t.mode] || 'route', words(t.mode).last, `${fmtDate(t.start)} · ${MODES[t.mode] ? MODES[t.mode].label : ''}`)}<ul class="facts"><li>${ic('light')}<span>Halte an Ampeln</span><b>${h.length}</b></li><li>${ic('hourglass')}<span>gewartet</span><b>${durText(h.reduce((a, e) => a + e.wait, 0))}</b></li></ul></div>`;
  }

  // ---------- Ereignisse ----------
  $('#btn-start').addEventListener('click', startTrip);
  $('#tips-body').addEventListener('click', (ev) => { if (ev.target.closest('#btn-ki')) runKi(); });
  const saveServer = () => {
    settings.server = { url: $('#inp-server').value.trim(), wir: $('#inp-wir').checked, ki: $('#inp-ki').checked };
    store.set('settings', settings);
    wirCache = null; wirAt = 0; newsAt = 0;
    if (settings.server.wir) flushWir();
  };
  ['#inp-server', '#inp-wir', '#inp-ki'].forEach((id) => $(id).addEventListener('change', saveServer));
  $('#btn-server-test').addEventListener('click', async () => {
    saveServer();
    const st = $('#server-status');
    if (!apiBase()) { st.textContent = 'Bitte zuerst die Adresse eintragen.'; return; }
    st.textContent = 'Verbindung wird geprüft …';
    try {
      const h = await api('/api/health');
      st.textContent = `Verbunden. KI ${h.ki ? 'bereit (' + h.modell + ')' : 'auf dem Server noch nicht eingerichtet'}. Werte anderer ab ${h.kMin} Personen.`;
    } catch (e) { st.textContent = 'Keine Verbindung: ' + e.message; }
  });
  $('#today').addEventListener('click', (ev) => { const b = ev.target.closest('[data-goto]'); if (b) showView(b.dataset.goto); });
  $('#btn-transfer').addEventListener('click', startTransfer);
  $('#btn-next-bahn').addEventListener('click', () => endTransfer('bahn'));
  $('#btn-next-bus').addEventListener('click', () => endTransfer('bus'));
  $$('input[name="mgroup"], input[name="pt"]').forEach((i) => i.addEventListener('change', () => {
    $('#pt-row').hidden = $('input[name="mgroup"]:checked').value !== 'oepnv';
    settings.mode = selectedMode(); store.set('settings', settings);
    applyModeWords(settings.mode);
    renderToday();
  }));
  const saveAccess = () => {
    settings.access = { on: $('#inp-access').checked, type: $('#inp-access-type').value };
    store.set('settings', settings);
    $('#inp-access-type').hidden = !settings.access.on;
    renderToday();
  };
  $('#inp-access').addEventListener('change', saveAccess);
  $('#inp-access-type').addEventListener('change', saveAccess);
  $('#btn-end').addEventListener('click', () => { $('#btn-end').hidden = true; $('#btn-end-confirm').hidden = false; $('#btn-end-cancel').hidden = false; $('#btn-end-confirm').focus(); });
  $('#btn-end-cancel').addEventListener('click', () => { resetEndButtons(); $('#btn-end').focus(); });
  $('#btn-end-confirm').addEventListener('click', finishTrip);
  $('#btn-demo').addEventListener('click', demoRun);
  $('#btn-demo-clear').addEventListener('click', () => {
    const n = trips.filter((t) => t.demo).length;
    trips = trips.filter((t) => !t.demo); saveTrips();
    moreMsg(n ? `${n} Demo-Fahrt${n === 1 ? '' : 'en'} gelöscht.` : 'Keine Demo-Daten vorhanden.');
  });
  $('#btn-wipe').addEventListener('click', () => { $('#wipe-confirm').hidden = false; $('#btn-wipe').hidden = true; });
  $('#btn-wipe-no').addEventListener('click', () => { $('#wipe-confirm').hidden = true; $('#btn-wipe').hidden = false; });
  $('#btn-wipe-yes').addEventListener('click', () => {
    trips = []; saveTrips();
    $('#wipe-confirm').hidden = true; $('#btn-wipe').hidden = false;
    moreMsg('Alle Fahrten gelöscht.');
  });
  $('#btn-reload-signals').addEventListener('click', () => {
    moreMsg('Standort wird abgefragt …');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        moreMsg('Ampeln werden geladen …');
        fetchSignals({ lat: p.coords.latitude, lon: p.coords.longitude })
          .then((n) => moreMsg(`${n} Signalstandorte im Umkreis von 5 km geladen.`))
          .catch(() => moreMsg('Die Ampeldaten konnten nicht geladen werden. Bitte später noch einmal versuchen.'));
      },
      () => moreMsg('Ohne Standort lassen sich keine Ampeln in deiner Nähe laden.'),
      { enableHighAccuracy: false, timeout: 15000 }
    );
  });
  $('#inp-cut').addEventListener('change', (ev) => { settings.cut = Number(ev.target.value); store.set('settings', settings); });
  function bindPrice(id, key) {
    $(id).addEventListener('change', (ev) => {
      const v = Number(ev.target.value.trim().replace(',', '.'));
      if (!isFinite(v) || v <= 0 || v > 10) { moreMsg('Bitte einen Preis wie 1,75 eingeben.'); ev.target.value = fmtNum(settings[key], 2); return; }
      settings[key] = Math.round(v * 100) / 100; store.set('settings', settings);
      ev.target.value = fmtNum(settings[key], 2);
      moreMsg('Preis gespeichert.');
    });
  }
  bindPrice('#inp-fuel', 'fuelPrice');
  bindPrice('#inp-power', 'powerPrice');

  // ---------- Start ----------
  setModeUI(settings.mode);
  applyModeWords(settings.mode);
  $('#inp-access').checked = !!settings.access.on;
  $('#inp-access-type').value = settings.access.type;
  $('#inp-access-type').hidden = !settings.access.on;
  $('#inp-server').value = settings.server.url || '';
  $('#inp-wir').checked = !!settings.server.wir;
  $('#inp-ki').checked = !!settings.server.ki;
  // Meldungen beim Start laden, damit sie auf „Heute“ erscheinen
  loadNews().then(() => { if (newsCache.length && !$('#view-start').hidden) renderToday(); });
  $('#inp-cut').value = String(settings.cut);
  $('#inp-fuel').value = fmtNum(settings.fuelPrice, 2);
  $('#inp-power').value = fmtNum(settings.powerPrice, 2);
  $('#app-version').textContent = VERSION;
  $('.proto').textContent = 'Prototyp ' + VERSION;   // zeigt zugleich: das Programm läuft
  clusters = buildClusters(signalCache.nodes);
  // Ältere Fahrten nachbearbeiten: Rückstau-Halte (ab 0.6.0), Kreuzungen und Warten vor der Abfahrt (ab 0.9.0)
  if (trips.map((t) => tidyTrip(t)).some(Boolean)) saveTrips();
  updateSignalsInfo();
  renderToday();
  renderLastTrip();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // Für Tests von außen erreichbar
  window.__ww = { onPosition: (p) => onPosition(p), state: () => ({ rec, trips, clusters }), demoRun };
})();
