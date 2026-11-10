DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE quest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  quest_key TEXT NOT NULL,
  xp INTEGER NOT NULL,
  source TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE snapshots (
  date TEXT PRIMARY KEY,
  live_time INTEGER NOT NULL,
  str_pts REAL NOT NULL,
  agi_pts REAL NOT NULL,
  vit_pts REAL NOT NULL,
  int_pts REAL NOT NULL,
  per_pts REAL NOT NULL,
  fame_pts REAL NOT NULL,
  impact_pts REAL NOT NULL
);
--> statement-breakpoint
CREATE TABLE metric_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE sync_posts (
  content_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  genre TEXT NOT NULL
);
