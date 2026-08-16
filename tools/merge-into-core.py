#!/usr/bin/env python3
"""
Merge the surveyed 2015 fare table into the live API core.

Honesty rules encoded here:
  · fare_2015    the surveyed value. Real, dated, attributable.
  · fare_est     a re-based estimate. NEVER served as an approved fare.
  · chart_status 'surveyed_2015' until a current GPRTU chart is loaded.

The API must be able to say, for every number it returns, where it came
from and when. Nothing in this file invents a fare.
"""
import json, statistics as st

DATA = '/home/claude/ghfares/data'

table = json.load(open(f'{DATA}/fare-table-2015.json'))
stops = json.load(open(f'{DATA}/stops-accra.json'))
core  = json.load(open(f'{DATA}/core.json'))

# Composite re-basing factor, 2015 → 2026.
# Derived from Ghana transport CPI movement, NOT from a GPRTU chart.
# Used only to show order of magnitude alongside the surveyed value.
REBASE = 6.25
REBASE_NOTE = ('Estimate only. Derived from transport CPI movement 2015→2026, '
               'not from an approved chart. Replace on first GPRTU chart load.')

def round_denom(x):
    """Round to circulating denominations — fares are paid in coins."""
    if x < 5:   return round(x * 2) / 2      # nearest 50p
    if x < 20:  return round(x)              # nearest cedi
    return round(x / 5) * 5                  # nearest 5

# Keep the busiest stations — enough for a real MVP without bloating the payload
ranked = sorted(table['stations'].values(), key=lambda s: -s['destination_count'])
selected = ranked[:40]

stations = []
for s in selected:
    fares = []
    for d in s['destinations']:
        est = round_denom(d['fare_2015'] * REBASE)
        fares.append({
            'to': d['to_slug'],
            'name': d['to'],
            'fare_2015': d['fare_2015'],
            'fare_est': est,
            'chart': est,                       # what the bot quotes, flagged as estimate
            'chart_status': 'estimate_pending_chart',
            'route_id': d['route_id'],
            'stop_count': d['stop_count'],
            'observations': d['observations'],
            'mode': 'trotro',
            'bay': f"{d['to']} bay",
            'chart_id': 'surveyed-2015-rebased',
            'stops': d['stops'][:20],
        })
    stations.append({
        'id': s['id'],
        'name': s['name'],
        'aliases': list({s['name'].lower(), s['id'].replace('-', ' ')}),
        'lat': s['lat'], 'lng': s['lng'],
        'region': 'Greater Accra',
        'branch': s['branches'][0] if s['branches'] else None,
        'branches': s['branches'],
        'fares': fares,
    })

core['stations'] = stations
core['stops'] = {k: v for k, v in stops.items()}
core['charts'] = [
    {'id': 'surveyed-2015-rebased',
     'authority': 'Accra TroTro Apps Challenge field survey',
     'effective_from': '2015-06-01',
     'status': 'SURVEYED — NOT AN APPROVED CHART',
     'note': REBASE_NOTE,
     'rebase_factor': REBASE,
     'covers': ['trotro']},
    {'id': 'vipjeoun-2026-04', 'authority': 'VIP Jeoun', 'effective_from': '2026-04-08',
     'status': 'published', 'note': 'Operator chart revision', 'covers': ['coach']},
    {'id': 'gprtu-2026-06', 'authority': 'GPRTU', 'effective_from': '2026-06-02',
     'status': 'announced_percentage_only',
     'note': '+20% nationwide. Percentage published; route-level chart is displayed at '
             'lorry stations only and has not been digitised.',
     'covers': ['trotro', 'shared_taxi']},
]
core['provenance'] = {
    'fare_basis': 'surveyed_2015_rebased',
    'warning': 'Trotro fares shown are ESTIMATES derived from a 2015 field survey. '
               'They are not approved GPRTU fares. Load a current chart before launch.',
    'stations': len(stations),
    'destinations': sum(len(s['fares']) for s in stations),
    'stops': len(stops),
}

json.dump(core, open(f'{DATA}/core.json', 'w'), indent=1)

print(f"stations wired    {len(stations)}")
print(f"destinations      {core['provenance']['destinations']}")
print(f"stops             {len(stops)}")
print()
k = next(s for s in stations if 'kaneshie' in s['id'])
print(f"{k['name']} — {len(k['fares'])} destinations")
for f in k['fares'][:6]:
    print(f"   2015 GH¢{f['fare_2015']:<5} → est GH¢{f['chart']:<5} {f['name'][:28]:30} [{f['route_id']}]")
