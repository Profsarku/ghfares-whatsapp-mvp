/** DDL applied to each Neon database. Names match lib/db/catalog.js. */
module.exports = {
  identity: `
CREATE TABLE IF NOT EXISTS identities (
  hash text PRIMARY KEY,
  channel text,
  created_at timestamptz NOT NULL DEFAULT now(),
  blocked boolean NOT NULL DEFAULT false,
  last_seen timestamptz NOT NULL DEFAULT now()
);
`,

  auth: `
CREATE TABLE IF NOT EXISTS accounts (
  hash text PRIMARY KEY,
  channel text,
  created_at timestamptz NOT NULL DEFAULT now(),
  blocked boolean NOT NULL DEFAULT false,
  last_seen timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stations_often text[];
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS popular_route text;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_web_name
  ON accounts (lower(first_name), lower(last_name))
  WHERE first_name IS NOT NULL AND last_name IS NOT NULL;
`,

  users: `
CREATE TABLE IF NOT EXISTS users (
  hash text PRIMARY KEY,
  caps text[] NOT NULL DEFAULT '{}',
  route jsonb,
  station text,
  context jsonb,
  pending jsonb,
  seen timestamptz NOT NULL DEFAULT now()
);
`,

  consent: `
CREATE TABLE IF NOT EXISTS opt_ins (
  id bigserial PRIMARY KEY,
  hash text NOT NULL,
  capability text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  method text,
  source text
);
CREATE INDEX IF NOT EXISTS opt_ins_hash_cap ON opt_ins (hash, capability);
`,

  sessions: `
CREATE TABLE IF NOT EXISTS sessions (
  hash text PRIMARY KEY,
  welcomed_at timestamptz,
  last_intent text,
  composer jsonb,
  onboarded boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,

  index: `
CREATE TABLE IF NOT EXISTS pointers (
  alias text PRIMARY KEY,
  kind text NOT NULL,
  target_db text NOT NULL,
  target_id text NOT NULL
);
`,

  messaging: `
CREATE TABLE IF NOT EXISTS receipts (
  id bigserial PRIMARY KEY,
  wamid text,
  graph_id text,
  direction text NOT NULL,
  hash text,
  body_redacted text,
  status text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_wamid ON receipts (wamid) WHERE wamid IS NOT NULL;
`,

  places: `
CREATE TABLE IF NOT EXISTS stations (
  id text PRIMARY KEY,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  lat double precision,
  lng double precision
);
`,

  fares: `
CREATE TABLE IF NOT EXISTS amounts (
  route_key text PRIMARY KEY,
  station_id text NOT NULL,
  dest text NOT NULL,
  chart numeric NOT NULL,
  chart_id text
);
`,

  charts: `
CREATE TABLE IF NOT EXISTS charts (
  id text PRIMARY KEY,
  authority text,
  effective date,
  status text,
  notice text
);
`,

  operators: `
CREATE TABLE IF NOT EXISTS operators (
  id text PRIMARY KEY,
  name text NOT NULL,
  class text
);
`,

  stops: `
CREATE TABLE IF NOT EXISTS stops (
  id text PRIMARY KEY,
  name text,
  lat double precision,
  lng double precision
);
`,

  fares_reports: `
CREATE TABLE IF NOT EXISTS reports (
  id bigserial PRIMARY KEY,
  route_key text NOT NULL,
  station_id text NOT NULL,
  dest text NOT NULL,
  amount numeric NOT NULL,
  chart numeric NOT NULL,
  hash text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_route ON reports (route_key);

CREATE TABLE IF NOT EXISTS aggregates (
  route_key text PRIMARY KEY,
  avg_reported numeric NOT NULL,
  chart numeric NOT NULL,
  pct numeric NOT NULL,
  reports int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,

  roads: `
CREATE TABLE IF NOT EXISTS conditions (
  id bigserial PRIMARY KEY,
  road text NOT NULL,
  state text NOT NULL,
  hash text,
  at timestamptz NOT NULL DEFAULT now()
);
`,

  report_road_condition: `
CREATE TABLE IF NOT EXISTS reports (
  id bigserial PRIMARY KEY,
  road_key text NOT NULL,
  road text NOT NULL,
  condition text NOT NULL,
  kind text,
  where_text text,
  delay text,
  hash text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_road ON reports (road_key);

CREATE TABLE IF NOT EXISTS latest (
  road_key text PRIMARY KEY,
  road text NOT NULL,
  condition text NOT NULL,
  kind text,
  where_text text,
  delay text,
  status text NOT NULL,
  confirmations int NOT NULL DEFAULT 0,
  reports int NOT NULL DEFAULT 0,
  reported_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id bigserial PRIMARY KEY,
  road_key text NOT NULL,
  road text NOT NULL,
  condition text,
  caption text,
  mime text NOT NULL,
  bytes bytea NOT NULL,
  wa_media_id text,
  hash text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photos_road ON photos (road_key);
CREATE INDEX IF NOT EXISTS photos_at ON photos (at DESC);
`,

  fuel: `
CREATE TABLE IF NOT EXISTS pumps (
  id bigserial PRIMARY KEY,
  station_id text NOT NULL,
  area text,
  petrol numeric,
  diesel numeric,
  hash text,
  at timestamptz NOT NULL DEFAULT now()
);
`,

  queues: `
CREATE TABLE IF NOT EXISTS pings (
  id bigserial PRIMARY KEY,
  route_key text NOT NULL,
  station_id text NOT NULL,
  dest text NOT NULL,
  state text NOT NULL,
  hash text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pings_route ON pings (route_key);

CREATE TABLE IF NOT EXISTS latest (
  route_key text PRIMARY KEY,
  state text NOT NULL,
  at timestamptz NOT NULL,
  pings int NOT NULL
);
`,

  incidents: `
CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY,
  road text NOT NULL,
  kind text,
  status text NOT NULL,
  confirmations int NOT NULL DEFAULT 0,
  reported_at timestamptz NOT NULL DEFAULT now()
);
`,

  broadcasts: `
CREATE TABLE IF NOT EXISTS sends (
  id bigserial PRIMARY KEY,
  hash text NOT NULL,
  template text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sends_hash_at ON sends (hash, at);
`,

  entry: `
CREATE TABLE IF NOT EXISTS beacons (
  id bigserial PRIMARY KEY,
  slug text,
  channel text,
  at timestamptz NOT NULL DEFAULT now()
);
`,

  partners: `
CREATE TABLE IF NOT EXISTS receipts (
  id bigserial PRIMARY KEY,
  partner text NOT NULL,
  kind text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
`,

  ai: `
CREATE TABLE IF NOT EXISTS settings (
  id int PRIMARY KEY CHECK (id = 1),
  model text NOT NULL,
  base_url text NOT NULL,
  timeout_ms int NOT NULL DEFAULT 8000,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (id, model, base_url, timeout_ms)
VALUES (1, 'openai/gpt-oss-20b', 'https://router.huggingface.co/v1', 8000)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS examples (
  id bigserial PRIMARY KEY,
  text text NOT NULL,
  intent text NOT NULL,
  arg text,
  places text[] NOT NULL DEFAULT '{}',
  scope text,
  compare boolean NOT NULL DEFAULT false,
  past boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS examples_text ON examples (lower(text));

CREATE TABLE IF NOT EXISTS calls (
  id bigserial PRIMARY KEY,
  text text NOT NULL,
  intent text,
  nlu text,
  places text[] NOT NULL DEFAULT '{}',
  ms int,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calls_at ON calls (at DESC);
`,

  survey: `
CREATE TABLE IF NOT EXISTS meta (
  id int PRIMARY KEY CHECK (id = 1),
  dataset text,
  collected text,
  note text,
  currency text,
  rebase_factor numeric,
  stations int,
  routes int,
  stops int,
  loaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stations (
  id text PRIMARY KEY,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  lat double precision,
  lng double precision,
  region text,
  branch text,
  branches text[] NOT NULL DEFAULT '{}',
  destination_count int
);

CREATE TABLE IF NOT EXISTS routes (
  route_key text PRIMARY KEY,
  station_id text NOT NULL,
  dest text NOT NULL,
  dest_name text,
  fare_2015 numeric,
  fare_est numeric,
  chart numeric NOT NULL,
  chart_status text,
  chart_id text,
  route_id text,
  stop_count int,
  observations int,
  mode text,
  stops text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS routes_station ON routes (station_id);

CREATE TABLE IF NOT EXISTS stops (
  id text PRIMARY KEY,
  name text,
  lat double precision,
  lng double precision,
  terminal boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS charts (
  id text PRIMARY KEY,
  authority text,
  effective_from date,
  status text,
  note text,
  rebase_factor numeric,
  covers text[] NOT NULL DEFAULT '{}'
);
`
};
