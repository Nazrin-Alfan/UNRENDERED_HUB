// Tracker Grind-ku — persistent game state.
//
// state:          single-row key/value store (xp balance, last processed day,
//                 sync bookkeeping).
// quest_log:      one row per quest completion (date + quest key + source).
//                 Manual rows can be removed (uncheck); auto rows are rebuilt
//                 from the sheet on every sync.
// snapshots:      one row per WIB day with that day's point totals, used for
//                 the up/down arrows vs yesterday.
// metric_events:  manual metric entries the sheet cannot see: research/ideas
//                 (INT), performance checks (PER), extra followers (FAME),
//                 extra reach (IMPACT), clip uploads (quest evidence).
// sync_posts:     per-content-id record of posts already folded in from the
//                 sheet / content bank, so a sync never double-counts.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const state = sqliteTable("state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const questLog = sqliteTable("quest_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD, WIB
  questKey: text("quest_key").notNull(),
  xp: integer("xp").notNull(),
  source: text("source", { enum: ["auto", "manual"] }).notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  date: text("date").primaryKey(), // YYYY-MM-DD, WIB
  liveTime: integer("live_time").notNull(),
  strPts: real("str_pts").notNull(),
  agiPts: real("agi_pts").notNull(),
  vitPts: real("vit_pts").notNull(),
  intPts: real("int_pts").notNull(),
  perPts: real("per_pts").notNull(),
  famePts: real("fame_pts").notNull(),
  impactPts: real("impact_pts").notNull(),
});

export const metricEvents = sqliteTable("metric_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD, WIB
  kind: text("kind", {
    enum: ["research", "perf_check", "followers", "reach", "clip"],
  }).notNull(),
  amount: real("amount").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const syncPosts = sqliteTable("sync_posts", {
  contentId: text("content_id").primaryKey(),
  date: text("date").notNull(), // YYYY-MM-DD the post aired, WIB
  genre: text("genre").notNull(),
});

// ---------------------------------------------------------------------------
// Dashboard UNRENDERED tables (merged into UNRENDERED Hub, 2026-11-07).
// Prefixed `dash_` so they never collide with the tracker tables above.
//   dash_posts        : every row of MASTER_POST_LOG (metrics per content)
//   dash_posted_log   : items that actually aired (INDEX status=posted)
//   dash_queue_items  : packages awaiting approval (news_pending awaiting_user)
//   dash_account_stats: single row (id=1) with Instagram profile numbers
//   dash_slot_choices : user-chosen editorial topics per Tue/Sat slot date
//   dash_sync_state   : single row (id=1) with last successful refresh time

export const dashPosts = sqliteTable("dash_posts", {
  contentId: text("content_id").primaryKey(),
  date: text("date").notNull(), // YYYY-MM-DD (WIB)
  time: text("time").notNull().default(""), // HH:MM
  genre: text("genre").notNull().default(""),
  title: text("title").notNull().default(""),
  format: text("format").notNull().default(""),
  reach: integer("reach"),
  likes: integer("likes"),
  comments: integer("comments"),
  shares: integer("shares"),
  saves: integer("saves"),
  profileVisits: integer("profile_visits"),
  follows: integer("follows"),
  engagement: integer("engagement"),
  erPct: real("er_pct"),
  tier: text("tier").notNull().default(""),
  category: text("category").notNull().default(""),
  topic: text("topic").notNull().default(""),
  postUrl: text("post_url"),
});

export const dashPostedLog = sqliteTable("dash_posted_log", {
  contentId: text("content_id").primaryKey(),
  title: text("title").notNull().default(""),
  genre: text("genre").notNull().default(""),
  postedAt: text("posted_at").notNull(), // ISO 8601 with +07:00 offset
  postUrl: text("post_url"),
});

export const dashQueueItems = sqliteTable("dash_queue_items", {
  contentId: text("content_id").primaryKey(),
  title: text("title").notNull().default(""),
  genre: text("genre").notNull().default("NEWS"),
  notifiedAt: text("notified_at").notNull(), // ISO 8601 with offset
});

export const dashAccountStats = sqliteTable("dash_account_stats", {
  id: integer("id").primaryKey(),
  followers: integer("followers"),
  igPostCount: integer("ig_post_count"),
  updatedAt: text("updated_at"),
});

export const dashSlotChoices = sqliteTable("dash_slot_choices", {
  slotDate: text("slot_date").primaryKey(), // YYYY-MM-DD
  topic: text("topic").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const dashSyncState = sqliteTable("dash_sync_state", {
  id: integer("id").primaryKey(),
  lastSyncAt: text("last_sync_at"),
});

// ---------------------------------------------------------------------------
// Draft News page (added 2026-11-10): the user's decision per scanned news
// draft in the approval queue (news_pending.json awaiting_user). The queue
// itself stays in the source files; only the decision is stored here.
// decision: "gass" (gas upload) / "revisi" / "skip" (tidak approve).

export const draftDecisions = sqliteTable("draft_decisions", {
  contentId: text("content_id").primaryKey(),
  decision: text("decision", { enum: ["gass", "revisi", "skip"] }).notNull(),
  note: text("note").notNull().default(""),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Append-only log of EVERY draft decision made in the Hub (added
// 2026-11-10 so the GASS tab is a real history, not just a filter over the
// current queue). draft_decisions above keeps only the latest decision per
// draft and the draft itself leaves getDrafts once it exits the queue, so
// history rows snapshot the title at decision time and are never updated
// or deleted. Chat approvals live in approval_log.json and are merged in
// by getGassHistory with source "chat".
export const draftDecisionHistory = sqliteTable("draft_decision_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  contentId: text("content_id").notNull(),
  title: text("title").notNull().default(""),
  decision: text("decision", { enum: ["gass", "revisi", "skip"] }).notNull(),
  note: text("note").notNull().default(""),
  source: text("source", { enum: ["hub", "chat"] }).notNull().default("hub"),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
