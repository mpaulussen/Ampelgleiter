/* Ampelgleiter Prototyp: zeichnet Halte und Durchfahrten an Ampeln auf. Alle Daten bleiben im Browser. */
(function () {
  'use strict';

  const VERSION = '0.4.1';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // Schwellen je Verkehrsmittel: unter stopV gilt als stehend, über goV als fahrend (m/s)
  const MODES = {
    auto: { label: 'Auto',      stopV: 1.4,  goV: 2.5, haltRadius: 70, passRadius: 25 },
    rad:  { label: 'Rad',       stopV: 0.9,  goV: 1.8, haltRadius: 40, passRadius: 20 },
    bus:  { label: 'Bus',       stopV: 1.4,  goV: 2.5, haltRadius: 70, passRadius: 25 },
    bahn: { label: 'Stadtbahn', stopV: 1.4,  goV: 2.5, haltRadius: 60, passRadius: 25 },
    fuss: { label: 'Zu Fuß',    stopV: 0.35, goV: 0.8, haltRadius: 30, passRadius: 18 }
  };
  const STOP_CONFIRM_MS = 3000;   // so lange langsam, bis ein Halt zählt
  const GO_CONFIRM_MS = 2000;     // so lange schneller, bis der Halt endet
  const MIN_WAIT_MS = 3000;       // kürzere Halte werden ignoriert
  const MERGE_MS = 120000;        // Halte an derselben Ampel innerhalb dieser Zeit = ein Wartevorgang
  const MAX_ACCURACY = 50;        // ungenauere GPS-Punkte werden verworfen
  const CLUSTER_M = 35;           // Ampelknoten in diesem Abstand bilden eine Kreuzung
  const AREA_RADIUS = 5000;       // Umkreis für das Laden der Ampeln
  const TAGS = ['zu lange gewartet', 'Grün zu kurz', 'unübersichtlich', 'Anschluss verpasst', 'alles gut'];
  const STEADY_MIN_V = 8.33;      // Gleichmäßigkeit zählt ab 30 km/h
  const STEADY_TOL = 1.39;        // ±5 km/h um das Mittel der letzten Minute
  const HARD_BRAKE = -3.0;        // starke Bremsung ab 3 m/s² Verzögerung
  const HARD_ACCEL = 2.5;         // starkes Beschleunigen ab 2,5 m/s²
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

  // ---------- Speicher ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ww.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ww.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  let trips = store.get('trips', []);
  let settings = Object.assign({ mode: 'auto', cut: 200 }, store.get('settings', {}));
  let signalCache = store.get('signals', { areas: [], nodes: {} });
  let names = store.get('names', {});
  let clusters = [];   // wird beim Start aus den gespeicherten Ampeln aufgebaut
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

  // ---------- Ampeldaten aus OpenStreetMap ----------
  function buildClusters(nodes) {
    const list = [];
    const ids = Object.keys(nodes).sort((a, b) => Number(a) - Number(b));
    for (const id of ids) {
      const [lat, lon] = nodes[id];
      const p = { lat, lon };
      let best = null, bd = Infinity;
      for (const c of list) { const d = dist(c, p); if (d < bd) { bd = d; best = c; } }
      if (best && bd <= CLUSTER_M) {
        best.n += 1; best.lat += (lat - best.lat) / best.n; best.lon += (lon - best.lon) / best.n;
      } else {
        list.push({ id: 'c' + id, lat, lon, n: 1 });
      }
    }
    return list;
  }
  function areaCovers(p) {
    const now = Date.now();
    return signalCache.areas.some((a) => dist(a, p) < a.r - 1500 && now - a.fetched < 30 * 864e5);
  }
  async function fetchSignals(p) {
    const q = `[out:json][timeout:25];(node(around:${AREA_RADIUS},${p.lat},${p.lon})[highway=traffic_signals];node(around:${AREA_RADIUS},${p.lat},${p.lon})[crossing=traffic_signals];);out;`;
    let lastErr;
    for (const url of OVERPASS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        for (const el of json.elements || []) if (el.type === 'node') signalCache.nodes[el.id] = [round5(el.lat), round5(el.lon)];
        signalCache.areas = signalCache.areas.filter((a) => dist(a, p) > 1000);
        signalCache.areas.push({ lat: round5(p.lat), lon: round5(p.lon), r: AREA_RADIUS, fetched: Date.now() });
        store.set('signals', signalCache);
        clusters = buildClusters(signalCache.nodes);
        updateSignalsInfo();
        return (json.elements || []).length;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Ampeldaten nicht erreichbar');
  }
  function updateSignalsInfo() {
    const n = clusters.length;
    $('#signals-info').textContent = n
      ? `${n} Ampel-Kreuzungen gespeichert (${Object.keys(signalCache.nodes).length} Signalstandorte, ${signalCache.areas.length} Gebiet${signalCache.areas.length === 1 ? '' : 'e'}).`
      : 'Noch keine Ampeln geladen. Das passiert automatisch beim ersten Fahrtstart.';
  }

  // Straßennamen für Kreuzungen, nacheinander und gedrosselt (Nominatim erlaubt 1 Anfrage pro Sekunde)
  const nameQueue = [];
  let nameBusy = false;
  function labelFor(e) {
    if (names[e.signal]) return names[e.signal];
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
  async function runNames(onDone) {
    nameBusy = true;
    while (nameQueue.length) {
      const q = nameQueue.shift();
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=de&lat=${q.lat}&lon=${q.lon}`);
        if (res.ok) {
          const j = await res.json();
          const road = j.address && (j.address.road || j.address.pedestrian || j.address.footway);
          if (road) { names[q.signal] = road; store.set('names', names); if (onDone) onDone(); }
        }
      } catch (e) { /* ohne Namen weiter */ }
      await new Promise((r) => setTimeout(r, 1100));
    }
    nameBusy = false;
  }

  // ---------- Aufzeichnung ----------
  let rec = null;          // laufende Fahrt
  let wakeLock = null;
  let tick = null;

  function newRecording(mode, extraClusters, demo) {
    return {
      trip: { id: 't' + Date.now().toString(36), mode, start: null, end: null, distance: 0, events: [], demo: !!demo },
      cfg: MODES[mode],
      extra: extraClusters || [],
      samples: [],          // letzte Positionen {lat, lon, t, v}
      first: null, last: null,
      slowSince: null, fastSince: null,
      stop: null,           // laufender Halt
      recentPass: {},       // Kreuzung -> Zeit der letzten Durchfahrt
      lastHaltAt: {},       // Kreuzung -> Endzeit des letzten Halts
      lastFetchAt: 0,
      st: { moving: 0, steady: 0, steadyBase: 0, brakes: 0, accels: 0, win: [], lastVs: null, lastBrake: 0, lastAccel: 0 },
      gpsCount: 0,
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
    if (!rec.trip.start) { rec.trip.start = t; rec.first = { lat: p.lat, lon: p.lon }; maybeFetchSignals(p, true); }

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
    if (prev) updateDrivingStats(vs, t, (t - prev.t) / 1000);
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
          const sig = findSignal(s, s.heading, cfg.haltRadius);
          rec.stop = { t0: s.t, lat: s.lat, lon: s.lon, heading: s.heading, signal: sig };
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
    if (rec.stop) {
      const label = rec.stop.signal ? 'Halt an Ampel' : 'Halt';
      setDriveState(`${label} · ${fmtDur(t - rec.stop.t0)}`, 'halt');
    } else {
      setDriveState(vs < cfg.stopV ? 'Langsam …' : 'Unterwegs', 'moving');
    }
    maybeFetchSignals(p, false);
    updateCounters();
  }

  // Fahrstil für die Fahrtbilanz: Fahrzeit in Bewegung, Gleichmäßigkeit, starke Manöver
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
      rec.trip.events.push({ type: 'pass', signal: c.id, lat: round5(c.lat), lon: round5(c.lon), t, heading: heading == null ? null : Math.round(heading) });
    }
  }

  function endStop(tEnd) {
    const s = rec.stop;
    rec.stop = null; rec.slowSince = null; rec.fastSince = null;
    const wait = tEnd - s.t0;
    if (wait < MIN_WAIT_MS) return;
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
    ev.push({
      type: 'halt', signal: sigId,
      lat: round5(s.signal ? s.signal.lat : s.lat), lon: round5(s.signal ? s.signal.lon : s.lon),
      t: s.t0, tEnd, wait, halts: 1,
      heading: s.heading == null ? null : Math.round(s.heading),
      distToSignal: s.signal ? Math.round(dist(s, s.signal)) : null
    });
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
    const halts = ev.filter((e) => e.type === 'halt' && e.signal);
    $('#drive-pass').textContent = ev.filter((e) => e.type === 'pass').length;
    $('#drive-halts').textContent = halts.length;
    const running = rec.stop && rec.stop.signal && rec.samples.length ? rec.samples[rec.samples.length - 1].t - rec.stop.t0 : 0;
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
    const mode = $('input[name="mode"]:checked').value;
    settings.mode = mode; store.set('settings', settings);
    const msg = $('#start-msg');
    if (!('geolocation' in navigator)) { msg.textContent = 'Dieses Gerät bietet keinen Standortzugriff.'; return; }
    if (!window.isSecureContext) { msg.textContent = 'Standort geht nur über eine sichere Verbindung (https).'; return; }
    msg.textContent = 'Standort wird angefragt …';
    rec = newRecording(mode);
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
    showView('drive');
    $$('.tabs button').forEach((b) => { b.disabled = true; });
    clearInterval(tick);
    tick = setInterval(() => {
      if (!rec) return;
      const now = rec.trip.demo ? (rec.samples.length ? rec.samples[rec.samples.length - 1].t : rec.startedAt) : Date.now();
      const from = rec.trip.start || rec.startedAt;
      $('#drive-time').textContent = fmtDur(now - from);
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

  function finishTrip() {
    if (!rec) return;
    if (rec.stop && rec.samples.length) endStop(rec.samples[rec.samples.length - 1].t);
    stopWatching();
    const trip = rec.trip;
    trip.end = rec.samples.length ? rec.samples[rec.samples.length - 1].t : Date.now();
    if (!trip.start) trip.start = trip.end;
    // Datenschutz: Ereignisse nahe Start und Ziel verwerfen
    const cut = Number(settings.cut) || 0;
    if (cut && rec.first && rec.last) {
      trip.events = trip.events.filter((e) => dist(e, rec.first) > cut && dist(e, rec.last) > cut);
    }
    trip.distance = Math.round(trip.distance);
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
      $('#start-msg').textContent = 'Die Fahrt war zu kurz und wurde nicht gespeichert.';
      return;
    }
    trips.push(trip);
    saveTrips();
    openReview(trip);
  }

  function resetEndButtons() {
    $('#btn-end').hidden = false; $('#btn-end-confirm').hidden = true; $('#btn-end-cancel').hidden = true;
  }

  // ---------- Bewertung ----------
  let reviewTrip = null;
  function openReview(trip) {
    reviewTrip = trip;
    const halts = trip.events.filter((e) => e.type === 'halt' && e.signal);
    const passes = trip.events.filter((e) => e.type === 'pass').length;
    const other = trip.events.filter((e) => e.type === 'halt' && !e.signal).length;
    const wait = halts.reduce((a, e) => a + e.wait, 0);
    $('#review-summary').textContent = halts.length
      ? `${halts.length} Halt${halts.length === 1 ? '' : 'e'} an Ampeln, zusammen ${fmtDur(wait)} Minuten gewartet. ${passes} Ampel${passes === 1 ? '' : 'n'} ohne Halt.${other ? ` Dazu ${other} Halt${other === 1 ? '' : 'e'} ohne Ampel in der Nähe.` : ''} Wie war es an den Ampeln?`
      : `Kein Halt an einer Ampel. ${passes} Ampel${passes === 1 ? '' : 'n'} ohne Halt passiert.`;
    renderBilanz();
    renderReview();
    showView('review');
    requestNames(halts, renderReview);
  }
  const fmtNum = (x, d) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  function renderBilanz() {
    const t = reviewTrip;
    const st = t.stats || {};
    const dur = (t.end || t.start) - t.start;
    const km = t.distance / 1000;
    const avg = st.movingMs ? km / (st.movingMs / 3600000) : null;
    const per100 = km >= 5 ? ` (${fmtNum((st.brakes || 0) / km * 100, 1)} je 100 km)` : '';
    const c = t.consumption || {};
    $('#review-bilanz').innerHTML = `<div class="card bilanz">
      <h3>Fahrtbilanz</h3>
      <div class="kpis">
        <div class="kpi"><b>${fmtNum(km, 1)} km</b><span>Strecke</span></div>
        <div class="kpi"><b>${fmtDur(dur)}</b><span>Fahrzeit${dur < 3600000 ? ' (min)' : ''}</span></div>
        <div class="kpi"><b>${avg ? Math.round(avg) + ' km/h' : '–'}</b><span>Ø Tempo in Bewegung</span></div>
        <div class="kpi"><b>${st.steadyShare != null ? fmtPct(st.steadyShare) : '–'}</b><span>gleichmäßig gefahren</span></div>
      </div>
      <p class="small">${st.brakes || 0} starke Bremsung${st.brakes === 1 ? '' : 'en'}${per100}, ${st.accels || 0}× stark beschleunigt.${st.steadyShare == null ? ' Die Gleichmäßigkeit wird ab einer Minute Fahrt über 30 km/h berechnet.' : ''}</p>
      <label class="small" for="inp-consumption">Verbrauch laut Bordcomputer (freiwillig)</label>
      <div class="cons-row">
        <input id="inp-consumption" type="text" inputmode="decimal" autocomplete="off" placeholder="z. B. 5,6" value="${c.value != null ? fmtNum(c.value, 1) : ''}">
        <select id="inp-unit" aria-label="Einheit">
          <option value="l"${c.unit !== 'kWh' ? ' selected' : ''}>l/100 km</option>
          <option value="kWh"${c.unit === 'kWh' ? ' selected' : ''}>kWh/100 km</option>
        </select>
      </div>
      <p id="cons-msg" class="small muted" role="status" aria-live="polite"></p>
    </div>`;
    const save = () => {
      const raw = $('#inp-consumption').value.trim().replace(',', '.');
      const unit = $('#inp-unit').value;
      if (!raw) { delete reviewTrip.consumption; saveTrips(); $('#cons-msg').textContent = ''; return; }
      const val = Number(raw);
      if (!isFinite(val) || val <= 0 || val > 60) { $('#cons-msg').textContent = 'Bitte eine Zahl wie 5,6 eingeben.'; return; }
      reviewTrip.consumption = { value: Math.round(val * 10) / 10, unit };
      saveTrips();
      $('#cons-msg').textContent = `Gespeichert: ${fmtNum(reviewTrip.consumption.value, 1)} ${unit}/100 km.`;
    };
    $('#inp-consumption').addEventListener('change', save);
    $('#inp-unit').addEventListener('change', save);
  }
  function renderReview() {
    if (!reviewTrip) return;
    const halts = reviewTrip.events.filter((e) => e.type === 'halt' && e.signal);
    $('#review-list').innerHTML = halts.map((e, i) => {
      const idx = reviewTrip.events.indexOf(e);
      const tags = e.tags || [];
      return `<article class="rev" data-idx="${idx}">
        <div class="rev-head"><strong>${esc(labelFor(e))}</strong><span class="rev-wait">${fmtDur(e.wait)} min</span></div>
        <span class="small muted">${esc(dirName(e.heading))}${e.halts > 1 ? ` · ${e.halts} Halte` : ''} · ${new Date(e.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</span>
        <div class="thumbs" role="group" aria-label="Bewertung für ${esc(labelFor(e))}">
          <button type="button" class="btn up" data-rate="1" aria-pressed="${e.rating === 1}">Gut</button>
          <button type="button" class="btn down" data-rate="-1" aria-pressed="${e.rating === -1}">Schlecht</button>
        </div>
        <div class="tags" role="group" aria-label="Stichworte">${TAGS.map((t) => `<button type="button" data-tag="${esc(t)}" aria-pressed="${tags.includes(t)}">${esc(t)}</button>`).join('')}</div>
      </article>`;
    }).join('');
  }
  $('#review-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    const card = ev.target.closest('.rev');
    if (!btn || !card || !reviewTrip) return;
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
  function renderStats() {
    const since = statsRange === 'week' ? weekStart() : 0;
    const list = trips.filter((t) => t.start >= since);
    $('#stats-demo').hidden = !list.some((t) => t.demo);
    const body = $('#stats-body');
    if (!list.length) {
      body.innerHTML = `<p class="msg">${statsRange === 'week' ? 'Diese Woche noch keine Fahrten.' : 'Noch keine Fahrten.'} Starte unter „Fahren“ deine erste Aufzeichnung oder spiele unter „Mehr“ eine Testfahrt ab.</p>`;
      return;
    }
    const ag = aggregate(list);
    const share = ag.halts + ag.passes ? ag.halts / (ag.halts + ag.passes) : 0;
    const worst = ag.approaches.filter((a) => a.halts).sort((a, b) => b.wait - a.wait)[0];
    const rows = ag.approaches.sort((a, b) => b.wait - a.wait).map((a) => {
      const n = a.halts + a.passes;
      const rating = a.up || a.down ? `${a.up} / ${a.down}` : '–';
      return `<tr><td>${esc(labelFor(a.sample))}</td><td>${dirShort(a.h)}</td><td>${n}</td><td>${fmtPct(a.halts / n)}</td><td>${a.halts ? fmtS(a.wait / a.halts) : '–'}</td><td>${rating}</td></tr>`;
    }).join('');
    const tripRows = list.slice().sort((a, b) => b.start - a.start).map((t) => {
      const h = t.events.filter((e) => e.type === 'halt' && e.signal);
      return `<div class="trip"><span>${fmtDate(t.start)} · ${MODES[t.mode] ? MODES[t.mode].label : t.mode}${t.demo ? '<span class="badge">Demo</span>' : ''}<br><span class="muted">${(t.distance / 1000).toFixed(1).replace('.', ',')} km · ${h.length} Halte · ${fmtDur(h.reduce((x, e) => x + e.wait, 0))} min${t.stats && t.stats.steadyShare != null ? ` · ${fmtPct(t.stats.steadyShare)} gleichmäßig` : ''}${t.consumption ? ` · ${fmtNum(t.consumption.value, 1)} ${t.consumption.unit}/100 km` : ''}</span></span>
        <span><button type="button" data-review="${t.id}">Ansehen</button> <button type="button" data-del="${t.id}">Löschen</button></span></div>`;
    }).join('');
    body.innerHTML = `
      <div class="kpis">
        <div class="kpi"><b>${fmtDur(ag.wait)}</b><span>Minuten an Ampeln gewartet</span></div>
        <div class="kpi"><b>${list.length}</b><span>Fahrt${list.length === 1 ? '' : 'en'}</span></div>
        <div class="kpi"><b>${fmtPct(share)}</b><span>der Ampeln mit Halt</span></div>
        <div class="kpi"><b>${ag.halts ? fmtS(ag.wait / ag.halts) : '–'}</b><span>Ø Wartezeit je Halt</span></div>
      </div>
      ${worst ? `<div class="card worst"><h3>Deine nervigste Ampel</h3><p><strong>${esc(labelFor(worst.sample))}</strong>${worst.h != null ? ', ' + esc(dirName(worst.h)) : ''}</p><p class="small">${worst.halts}× gehalten, zusammen ${fmtDur(worst.wait)} min, längster Halt ${fmtDur(worst.maxWait)} min.</p></div>` : ''}
      <h3>Alle Ampeln</h3>
      <div class="tbl-wrap"><table><thead><tr><th>Ampel</th><th>Richtung</th><th>Fahrten</th><th>mit Halt</th><th>Ø Warten</th><th>gut / schlecht</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3>Fahrten</h3>
      <div class="list">${tripRows}</div>`;
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
    if (typeof L === 'undefined') { $('#map-empty').hidden = false; $('#map-empty').textContent = 'Die Karte braucht eine Internetverbindung.'; return; }
    if (!map) {
      map = L.map('map', { zoomControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' }).addTo(map);
      map.setView([52.0211, 8.5325], 13);
    }
    setTimeout(() => map.invalidateSize(), 50);
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);
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
        .bindPopup(`<strong>${esc(labelFor(a.sample))}</strong><br>${n} Fahrten, ${fmtPct(a.halts / n)} mit Halt<br>Ø Wartezeit ${Math.round(avgAll)} s, längste ${fmtS(a.maxWait)}${a.up || a.down ? `<br>Bewertung: ${a.up} gut, ${a.down} schlecht` : ''}<br><br>${dirLines}`)
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
      navigator.share({ files: [file], title: 'Ampelgleiter Daten' }).catch(() => {});
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  $('#btn-export').addEventListener('click', () => {
    download(`ampelgleiter-${stamp()}.json`, JSON.stringify({ app: 'ampelgleiter', version: VERSION, exported: new Date().toISOString(), names, trips }, null, 1), 'application/json');
  });
  $('#btn-export-csv').addEventListener('click', () => {
    const head = ['fahrt', 'verkehrsmittel', 'demo', 'typ', 'ampel', 'name', 'lat', 'lon', 'zeit', 'wartezeit_s', 'halte', 'richtung_grad', 'bewertung', 'stichworte'];
    const lines = [head.join(';')];
    for (const tr of trips) for (const e of tr.events) {
      lines.push([tr.id, tr.mode, tr.demo ? 1 : 0, e.type === 'pass' ? 'durchfahrt' : 'halt', e.signal || '', labelFor(e).replace(/;/g, ','), e.lat, e.lon, new Date(e.t).toISOString(),
        e.type === 'halt' ? Math.round(e.wait / 1000) : 0, e.halts || 0, (e.heading == null ? '' : e.heading), (e.rating == null ? '' : e.rating), (e.tags || []).join('|')].join(';'));
    }
    download(`ampelgleiter-halte-${stamp()}.csv`, lines.join('\n'), 'text/csv');
  });
  $('#inp-import').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.trips)) throw new Error('kein Ampelgleiter-Export');
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
    if (name === 'map') renderMap();
    if (name === 'start') renderLastTrip();
    if (name === 'more') updateSignalsInfo();
    const h = $('#view-' + name + ' h2');
    if (h && name !== 'drive') { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    $('#main').scrollTop = 0;
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  function renderLastTrip() {
    const t = trips.filter((x) => !x.demo).slice(-1)[0];
    const el = $('#last-trip');
    if (!t) { el.innerHTML = ''; return; }
    const h = t.events.filter((e) => e.type === 'halt' && e.signal);
    el.innerHTML = `<div class="card"><h3>Letzte Fahrt</h3><p class="small">${fmtDate(t.start)} · ${MODES[t.mode] ? MODES[t.mode].label : ''} · ${h.length} Halte an Ampeln · ${fmtDur(h.reduce((a, e) => a + e.wait, 0))} min gewartet</p></div>`;
  }

  // ---------- Ereignisse ----------
  $('#btn-start').addEventListener('click', startTrip);
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

  // ---------- Start ----------
  const modeInput = $(`input[name="mode"][value="${settings.mode}"]`);
  if (modeInput) modeInput.checked = true;
  $('#inp-cut').value = String(settings.cut);
  $('#app-version').textContent = VERSION;
  $('.proto').textContent = 'Prototyp ' + VERSION;   // zeigt zugleich: das Programm läuft
  clusters = buildClusters(signalCache.nodes);
  updateSignalsInfo();
  renderLastTrip();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // Für Tests von außen erreichbar
  window.__ww = { onPosition: (p) => onPosition(p), state: () => ({ rec, trips, clusters }), demoRun };
})();
