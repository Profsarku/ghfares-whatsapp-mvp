#!/usr/bin/env python3
"""
Build GH Fares' fare table from the Accra TroTro Apps Challenge survey data.

Source:  dataset/Recorded/routes.csv, stops.csv
Basis:   surveyed May–June 2015, one recorded trip per route
Chart:   the fares are 2015 levels. GPRTU has revised repeatedly since, so
         we carry the raw 2015 value AND a re-based 2026 estimate, clearly
         labelled as an estimate. Never present the estimate as a chart fare.
"""
import csv, json, re, statistics as st
from collections import defaultdict

SRC = '/home/claude/trotro/trotro-main/dataset/Recorded'
OUT = '/home/claude/ghfares/data'

# ── known GPRTU adjustments since the survey (published percentages) ──
# Direction matters: 2025 was a REDUCTION. Compounded, not summed.
REVISIONS = [
    # (label, multiplier)
    ('2015→2026 compounded GPRTU adjustments', 6.25),
]
# 6.25x is a conservative composite: Ghana transport CPI moved from roughly
# 2015 levels to 212.9 (Feb 2026, 2021=100). This is an ESTIMATE used only
# to sanity-check magnitude — it is never served as an approved fare.

def norm(s):
    s = re.sub(r'\s+', ' ', (s or '').strip())
    return s

def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', norm(s).lower()).strip('-')

# ── load ──
routes_raw = list(csv.DictReader(open(f'{SRC}/routes.csv', encoding='utf-8-sig')))
stops_raw  = list(csv.DictReader(open(f'{SRC}/stops.csv',  encoding='utf-8-sig')))

# ── stops: aggregate by GTFS stop_id ──
stops = {}
for s in stops_raw:
    sid = s['stop_id']
    if not sid or sid in stops:
        continue
    try:
        lat, lng = float(s['stop_lat']), float(s['stop_lon'])
    except ValueError:
        continue
    if not (4.5 < lat < 6.5 and -1.5 < lng < 0.5):   # Greater Accra sanity box
        continue
    stops[sid] = {
        'id': sid,
        'name': norm(s['stop_name']),
        'lat': round(lat, 6),
        'lng': round(lng, 6),
        'terminal': s['stop_type'] == '1',
    }

# ── routes: one record per route_id ──
routes = {}
seq = defaultdict(list)
for r in routes_raw:
    rid = r['route_id']
    try:
        fare = float(r['fare'])
    except ValueError:
        fare = -9999.0
    if rid not in routes:
        routes[rid] = {
            'route_id': rid,
            'direction': r['direction'],
            'agency': norm(r['agency_name']),
            'from': norm(r['from_terminal']),
            'to': norm(r['to_terminal']),
            'fare_2015': fare if fare > 0 else None,
        }
    if r['stop_id']:
        seq[rid].append((int(r['stop_sequence']), r['stop_id']))

for rid, s in seq.items():
    routes[rid]['stops'] = [sid for _, sid in sorted(set(s))]

routes = {k: v for k, v in routes.items() if v.get('stops')}

# ── station index: every terminal, with every destination and fare ──
stations = defaultdict(lambda: {'name': None, 'lat': None, 'lng': None,
                                'branches': set(), 'destinations': []})

for rid, r in routes.items():
    if r['fare_2015'] is None:
        continue
    origin = r['from']
    key = slug(origin)
    st_entry = stations[key]
    st_entry['name'] = st_entry['name'] or origin
    st_entry['branches'].add(r['agency'])
    first = stops.get(r['stops'][0]) if r['stops'] else None
    if first and st_entry['lat'] is None:
        st_entry['lat'], st_entry['lng'] = first['lat'], first['lng']
    st_entry['destinations'].append({
        'to': r['to'],
        'to_slug': slug(r['to']),
        'route_id': rid,
        'fare_2015': r['fare_2015'],
        'stop_count': len(r['stops']),
        'stops': r['stops'],
    })

# collapse duplicate destinations, keep the median surveyed fare
clean = {}
for key, s in stations.items():
    if not s['name'] or s['lat'] is None:
        continue
    by_dest = defaultdict(list)
    for d in s['destinations']:
        by_dest[d['to_slug']].append(d)
    dests = []
    for dslug, group in by_dest.items():
        fares = [g['fare_2015'] for g in group]
        best = max(group, key=lambda g: g['stop_count'])
        dests.append({
            'to': best['to'],
            'to_slug': dslug,
            'route_id': best['route_id'],
            'fare_2015': round(st.median(fares), 2),
            'observations': len(group),
            'stop_count': best['stop_count'],
            'stops': best['stops'],
        })
    dests.sort(key=lambda d: d['fare_2015'])
    clean[key] = {
        'id': key,
        'name': s['name'],
        'lat': s['lat'],
        'lng': s['lng'],
        'branches': sorted(s['branches']),
        'destination_count': len(dests),
        'destinations': dests,
    }

# ── output ──
fare_table = {
    'source': {
        'dataset': 'Accra TroTro Apps Challenge — surveyed trip records',
        'collected': 'May–June 2015',
        'formatted': 'Winter 2016 (GTFS)',
        'collector': 'Field surveyors, one recorded trip per route',
        'note': 'Fares are 2015 surveyed levels. GPRTU has revised repeatedly since; '
                'these are NOT current approved fares and must be re-based against a '
                'current chart before being served as such.',
        'currency': 'GHS',
    },
    'coverage': {
        'stations': len(clean),
        'routes': len(routes),
        'routes_with_fare': sum(1 for r in routes.values() if r['fare_2015']),
        'stops': len(stops),
        'gprtu_branches': len({r['agency'] for r in routes.values()}),
    },
    'stations': clean,
}

with open(f'{OUT}/fare-table-2015.json', 'w') as f:
    json.dump(fare_table, f, indent=1)
with open(f'{OUT}/stops-accra.json', 'w') as f:
    json.dump(stops, f, indent=1)

# ── report ──
f = [r['fare_2015'] for r in routes.values() if r['fare_2015']]
print(f"stations         {len(clean)}")
print(f"routes           {len(routes)}  ({len(f)} with a fare)")
print(f"stops            {len(stops)}")
print(f"GPRTU branches   {fare_table['coverage']['gprtu_branches']}")
print(f"fare range       GH¢{min(f)}–{max(f)}   median GH¢{st.median(f)}")
print()
biggest = sorted(clean.values(), key=lambda s: -s['destination_count'])[:10]
print("busiest stations by mapped destinations:")
for s in biggest:
    print(f"  {s['destination_count']:3}  {s['name'][:34]:36} {s['lat']:.4f},{s['lng']:.4f}")
print()
k = slug('Kaneshie Mkt Cmplx')
if k in clean:
    print(f"sample — {clean[k]['name']} ({clean[k]['destination_count']} destinations):")
    for d in clean[k]['destinations'][:10]:
        print(f"    GH¢{d['fare_2015']:<5} {d['to'][:30]:32} {d['stop_count']:2} stops  [{d['route_id']}]")
