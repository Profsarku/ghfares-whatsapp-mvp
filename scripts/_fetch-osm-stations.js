#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const query = `[out:json][timeout:180];
area["ISO3166-1"="GH"][admin_level=2]->.gh;
(
  node["amenity"="bus_station"](area.gh);
  way["amenity"="bus_station"](area.gh);
  node["public_transport"="station"](area.gh);
  way["public_transport"="station"](area.gh);
);
out center;`;

async function main() {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'ghfares-station-map/0.1 (station gazetteer)'
    },
    body: 'data=' + encodeURIComponent(query)
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(res.status, text.slice(0, 500));
    process.exit(1);
  }
  const out = path.join(__dirname, '..', 'data', 'osm-ghana-stations.raw.json');
  fs.writeFileSync(out, text);
  const json = JSON.parse(text);
  const els = json.elements || [];
  const named = els.filter(e => e.tags && e.tags.name);
  console.log('elements', els.length, 'named', named.length);
  console.log(named.slice(0, 15).map(e => e.tags.name).join('\n'));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
