CREATE TABLE dash_posts (
  content_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  profile_visits INTEGER,
  follows INTEGER,
  engagement INTEGER,
  er_pct REAL,
  tier TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  post_url TEXT
);
--> statement-breakpoint
CREATE TABLE dash_posted_log (
  content_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  posted_at TEXT NOT NULL,
  post_url TEXT
);
--> statement-breakpoint
CREATE TABLE dash_queue_items (
  content_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT 'NEWS',
  notified_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE dash_account_stats (
  id INTEGER PRIMARY KEY,
  followers INTEGER,
  ig_post_count INTEGER,
  updated_at TEXT
);
--> statement-breakpoint
CREATE TABLE dash_slot_choices (
  slot_date TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE dash_sync_state (
  id INTEGER PRIMARY KEY,
  last_sync_at TEXT
);
