/* Station pins on the landing page. Full review tools stay on /map. */
(function () {
  const el = document.getElementById('station-map');
  const note = document.getElementById('station-note');
  if (!el || typeof L === 'undefined') return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  fetch('/v1/map/stations')
    .then(r => {
      if (!r.ok) throw new Error('stations ' + r.status);
      return r.json();
    })
    .then(body => {
      const stations = (body.data && body.data.stations) || [];
      const survey = body.data && body.data.survey;
      const mapped = body.data && body.data.mapped;
      const map = L.map(el, { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(map);
      const bounds = [];
      for (const s of stations) {
        if (s.lat == null || s.lng == null) continue;
        const marker = L.circleMarker([s.lat, s.lng], {
          radius: s.source === 'osm' ? 4 : 5,
          color: '#fff',
          weight: 1,
          fillColor: s.source === 'osm' ? '#44403c' : '#171717',
          fillOpacity: 0.9
        });
        const where = s.region ? esc(s.region) : 'Ghana';
        marker.bindPopup('<strong>' + esc(s.name) + '</strong><br>' + where);
        marker.addTo(map);
        bounds.push([s.lat, s.lng]);
      }
      if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] });
      else map.setView([7.95, -1.02], 6);
      if (note) {
        note.innerHTML = stations.length + ' stations'
          + (survey != null ? ' · ' + survey + ' from the Accra survey' : '')
          + (mapped ? ' · ' + mapped + ' mapped across Ghana' : '')
          + '. <a href="/map">Review them on the full map</a>.';
      }
      setTimeout(() => map.invalidateSize(), 200);
    })
    .catch(err => {
      if (note) note.textContent = 'The station map could not load. ' + err.message;
    });
})();
