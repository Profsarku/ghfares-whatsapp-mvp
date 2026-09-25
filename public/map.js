/* Review map for data/accra-station-stops.review.json. Not a rider page. */
(function () {
  const FAR_M = 20000;
  const listEl = document.getElementById('list');
  const detailEl = document.getElementById('detail');
  const countsEl = document.getElementById('counts');
  const coverageEl = document.getElementById('coverage');
  const qEl = document.getElementById('q');
  let doc = null;
  let filter = 'stations';
  let selectedId = null;
  let map, stationLayer, stopLayer, looseLayer;
  const stationMarkers = new Map();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function metres(a, b) {
    if (a.lat == null || b.lat == null) return null;
    const R = 6371000;
    const p1 = a.lat * Math.PI / 180;
    const p2 = b.lat * Math.PI / 180;
    const dphi = (b.lat - a.lat) * Math.PI / 180;
    const dl = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bare(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/\b(station|terminal|lorry park|taxi rank|last\s?stop)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function prepare(raw) {
    const groups = new Map();
    for (const s of raw.stations) {
      const key = bare(s.name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    let farLinks = 0;
    for (const s of raw.stations) {
      const twins = (groups.get(bare(s.name)) || []).filter(o => o.id !== s.id);
      s.flags = [];
      if (/^[a-z]$/i.test(String(s.name || '').trim())) s.flags.push('Single-letter name');
      if (s.stop_count <= 2) s.flags.push('Only ' + s.stop_count + ' stop' + (s.stop_count === 1 ? '' : 's'));
      if (twins.length) s.flags.push('Also spelled ' + twins.map(t => t.name).join(', '));
      s.far = [];
      for (const st of s.stops || []) {
        st.away = metres(s, st);
        if (st.away != null && st.away > FAR_M) {
          s.far.push(st);
          farLinks++;
        }
      }
      if (s.far.length) s.flags.push(s.far.length + ' stop' + (s.far.length === 1 ? '' : 's') + ' more than 20 km away');
    }
    raw.farLinks = farLinks;
    raw.review = raw.stations.filter(s => s.flags.length);
    return raw;
  }

  function popup(title, lines) {
    return '<strong>' + esc(title) + '</strong><br>' + lines.map(esc).join('<br>');
  }

  function styleStation(s, on) {
    const look = s.flags && s.flags.length > 0;
    const mapped = s.source === 'osm';
    return {
      radius: on ? 9 : (mapped ? 5 : 6),
      color: '#fff',
      weight: 1,
      fillColor: look ? '#9a3412' : (mapped ? '#44403c' : '#171717'),
      fillOpacity: on ? 1 : 0.9
    };
  }

  function drawStations() {
    stationLayer.clearLayers();
    stationMarkers.clear();
    const bounds = [];
    for (const s of doc.stations) {
      if (s.lat == null || s.lng == null) continue;
      const marker = L.circleMarker([s.lat, s.lng], styleStation(s, s.id === selectedId));
      const lines = s.source === 'osm'
        ? [s.region || 'Ghana', 'Mapped station']
        : [
          s.id,
          (s.stop_count || 0) + ' stops on surveyed trips',
          (s.flags && s.flags[0]) || 'Accra survey park'
        ];
      marker.bindPopup(popup(s.name, lines));
      marker.on('click', () => select(s.id));
      marker.addTo(stationLayer);
      stationMarkers.set(s.id, marker);
      bounds.push([s.lat, s.lng]);
    }
    if (!selectedId && bounds.length) map.fitBounds(bounds, { padding: [24, 24] });
  }

  function drawStops(s) {
    stopLayer.clearLayers();
    if (!s) return;
    const bounds = [[s.lat, s.lng]];
    for (const st of s.stops || []) {
      if (st.lat == null || st.lng == null) continue;
      const far = st.away != null && st.away > FAR_M;
      const marker = L.circleMarker([st.lat, st.lng], {
        radius: far ? 6 : 4,
        color: st.terminal ? '#171717' : '#fff',
        weight: st.terminal ? 2 : 1,
        fillColor: far ? '#b45309' : '#52525b',
        fillOpacity: 0.9
      });
      const km = st.away == null ? 'no coordinate on the park' : (st.away / 1000).toFixed(1) + ' km from ' + s.name;
      marker.bindPopup(popup(st.name || st.id, [
        st.id,
        km,
        st.terminal ? 'Marked terminal' : 'Wayside stop',
        'On trips to: ' + (st.routes || []).join(', ')
      ]));
      marker.addTo(stopLayer);
      bounds.push([st.lat, st.lng]);
    }
    if (bounds.length === 1) map.setView(bounds[0], 13);
    else if (bounds.length) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
  }

  function drawLoose() {
    looseLayer.clearLayers();
    if (filter !== 'loose') return;
    const bounds = [];
    for (const st of doc.stops_not_on_a_route || []) {
      if (st.lat == null || st.lng == null) continue;
      L.circleMarker([st.lat, st.lng], {
        radius: 4,
        color: '#fff',
        weight: 1,
        fillColor: '#a8a29e',
        fillOpacity: 0.85
      }).bindPopup(popup(st.name || st.id, [st.id, 'Named in the survey, not on a recorded trip'])).addTo(looseLayer);
      bounds.push([st.lat, st.lng]);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [24, 24] });
  }

  function nameHit(s, q) {
    if (!q) return false;
    return (s.name || '').toLowerCase().includes(q) || (s.id || '').toLowerCase().includes(q);
  }

  function matches(s, q) {
    if (!q) return true;
    if (nameHit(s, q)) return true;
    return (s.stops || []).some(st => (st.name || '').toLowerCase().includes(q) || (st.id || '').toLowerCase().includes(q));
  }

  function renderList() {
    const q = qEl.value.trim().toLowerCase();
    listEl.innerHTML = '';
    if (filter === 'loose') {
      const rows = (doc.stops_not_on_a_route || []).filter(st => {
        if (!q) return true;
        return (st.name || '').toLowerCase().includes(q) || (st.id || '').toLowerCase().includes(q);
      });
      for (const st of rows) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = esc(st.name || st.id) + '<span class="sub">' + esc(st.id) + (st.terminal ? ' · terminal' : '') + '</span>';
        btn.addEventListener('click', () => {
          if (st.lat == null) return;
          map.setView([st.lat, st.lng], 16);
          looseLayer.eachLayer(layer => {
            const ll = layer.getLatLng();
            if (Math.abs(ll.lat - st.lat) < 1e-6 && Math.abs(ll.lng - st.lng) < 1e-6) layer.openPopup();
          });
        });
        li.appendChild(btn);
        listEl.appendChild(li);
      }
      return;
    }
    const pool = (filter === 'review' ? doc.review : doc.stations)
      .filter(s => matches(s, q))
      .sort((a, b) => {
        const ah = nameHit(a, q) ? 0 : 1;
        const bh = nameHit(b, q) ? 0 : 1;
        if (ah !== bh) return ah - bh;
        return String(a.name).localeCompare(String(b.name));
      });
    for (const s of pool) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      if (s.id === selectedId) btn.className = 'on';
      const tag = s.flags.length ? '<span class="sub tag">' + esc(s.flags[0]) + '</span>' : '';
      const destLabel = s.destination_count + ' destination' + (s.destination_count === 1 ? '' : 's');
      const sub = s.source === 'osm'
        ? esc(s.region || 'Ghana')
        : (s.stop_count + ' stops · ' + destLabel);
      btn.innerHTML = esc(s.name) + tag + '<span class="sub">' + sub + '</span>';
      btn.addEventListener('click', () => select(s.id));
      li.appendChild(btn);
      listEl.appendChild(li);
    }
  }

  function renderDetail(s) {
    if (!s || filter === 'loose') {
      detailEl.innerHTML = '';
      return;
    }
    const flags = s.flags.length
      ? '<p>' + s.flags.map(esc).join('<br>') + '</p>'
      : (s.source === 'osm'
        ? '<p>' + esc(s.region || 'Ghana') + '. Mapped station, with no surveyed trip stops yet.</p>'
        : '<p>Stops sit with this park. Open one on the map to read the trip it was recorded on.</p>');
    detailEl.innerHTML = '<div class="map-detail"><h2>' + esc(s.name) + '</h2>'
      + '<p>' + esc(s.id) + ' · ' + Number(s.lat).toFixed(5) + ', ' + Number(s.lng).toFixed(5) + '</p>'
      + flags + '</div>';
  }

  function select(id) {
    selectedId = id;
    const s = doc.stations.find(x => x.id === id);
    stationMarkers.forEach((marker, sid) => {
      const st = doc.stations.find(x => x.id === sid);
      marker.setStyle(styleStation(st, sid === id));
    });
    drawStops(s);
    renderDetail(s);
    renderList();
    const marker = stationMarkers.get(id);
    if (marker) marker.bringToFront();
  }

  function setFilter(next) {
    filter = next;
    selectedId = null;
    document.getElementById('f-stations').classList.toggle('on', next === 'stations');
    document.getElementById('f-review').classList.toggle('on', next === 'review');
    document.getElementById('f-loose').classList.toggle('on', next === 'loose');
    stopLayer.clearLayers();
    renderDetail(null);
    drawLoose();
    if (next !== 'loose') drawStations();
    renderList();
  }

  function mergePins(pins) {
    const byId = new Map(doc.stations.map(s => [s.id, s]));
    const seen = new Set();
    const merged = [];
    for (const p of pins || []) {
      if (p.lat == null || p.lng == null || seen.has(p.id)) continue;
      seen.add(p.id);
      const known = byId.get(p.id);
      if (known) {
        known.region = p.region || known.region || null;
        known.source = p.source || 'survey';
        merged.push(known);
      } else {
        merged.push({
          id: p.id,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          region: p.region || null,
          source: p.source || 'osm',
          aliases: [],
          destination_count: 0,
          stop_count: 0,
          stops: [],
          flags: []
        });
      }
    }
    for (const s of doc.stations) {
      if (!seen.has(s.id)) {
        s.source = s.source || 'survey';
        merged.push(s);
      }
    }
    merged.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    doc.stations = merged;
    doc.review = merged.filter(s => s.flags && s.flags.length);
  }

  async function boot(raw) {
    doc = prepare(raw);
    let pins = [];
    try {
      const res = await fetch('/v1/map/stations');
      if (res.ok) {
        const body = await res.json();
        pins = (body.data && body.data.stations) || [];
      }
    } catch (err) { /* review file still draws the Accra parks */ }
    if (pins.length) mergePins(pins);
    const mapped = doc.stations.filter(s => s.source === 'osm').length;
    coverageEl.textContent = mapped
      ? 'Accra survey parks, plus stations mapped across Ghana.'
      : ((raw.coverage && raw.coverage.limit) || '2015 Accra trotro survey.');
    countsEl.textContent = doc.stations.length + ' stations'
      + (mapped ? ' · ' + mapped + ' more from the Ghana map' : '')
      + ' · '
      + (raw.counts.stops_on_routes || 0) + ' stops on trips · '
      + doc.review.length + ' need a look · '
      + doc.farLinks + ' stop links sit over 20 km from their park · '
      + (raw.counts.stops_not_on_a_route || 0) + ' names are not on a trip.';
    map = L.map('map', { scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    looseLayer = L.layerGroup().addTo(map);
    stopLayer = L.layerGroup().addTo(map);
    stationLayer = L.layerGroup().addTo(map);
    drawStations();
    renderList();
    qEl.addEventListener('input', renderList);
    document.getElementById('f-stations').addEventListener('click', () => setFilter('stations'));
    document.getElementById('f-review').addEventListener('click', () => setFilter('review'));
    document.getElementById('f-loose').addEventListener('click', () => setFilter('loose'));
    setTimeout(() => map.invalidateSize(), 200);
  }

  fetch('/data/accra-station-stops.review.json')
    .then(r => {
      if (!r.ok) throw new Error('review file ' + r.status);
      return r.json();
    })
    .then(boot)
    .catch(err => {
      coverageEl.textContent = 'Could not load the review file. ' + err.message;
    });
})();
