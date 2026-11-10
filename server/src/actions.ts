// Tracker Grind-ku — server actions.
//
// Game model v2.0 (Blueprint Final, spec locked by the user 2026-11-07):
//
//   Dual-Layer stats. Five Core Stats (STR, AGI, VIT, INT, PER) each show:
//   - Base Stat (permanent, never decreases):
//       10 + floor(lifetime category points / 50) + allocated level points
//   - Momentum 7 Hari (dynamic): points earned in the last 7 days / 7,
//     compared against a per-stat target momentum. This replaces the old
//     lifetime-average (points / live time), which soft-locked VIT below
//     10.0 forever and froze late-game movement.
//   FAME and IMPACT live in a separate World Influence panel: totals plus
//   lifetime rates (points / live time); they never gate rank trials.
//
//   XP never decreases. Level curve is triangular: cumulative XP to reach
//   level L is 100 * L(L-1)/2 (level 8 = 2800). Ranks are NOT automatic:
//   level is capped at 9/19/29/39/49 per rank (E/D/C/B/A) and crossing
//   needs a Rank-Up Trial; XP past the cap is Overflow XP and flushes in
//   when the trial passes. From level 9 onward (forward-only), each level
//   grants +3 Unallocated Stat Points the user assigns via allocateStat.
//
//   Penalties (no XP cuts):
//   - Empty day (0 daily quests) -> next day is Penalty Zone: all quest XP
//     earned that day is held in the XP Vault (Held XP). Completing the
//     Penalty Quest (>= 3 daily quests that day) flushes the vault. If a
//     penalty day ends with < 3 daily quests, the held XP burns to 0.
//     An empty day also resets the streak (by definition of the streak).
//   - Missed Tue/Sat 19.00 editorial slot on an otherwise active day ->
//     [DEBUFF: EDITORIAL BREACH]: streak frozen (not reset), a Make-Up
//     Editorial quest appears per missed slot; debt blocks nothing else.
//
//   Buffs:
//   - VIT momentum >= 10.0 -> [BUFF: IRON WILL]: +10% XP on daily quests.
//   - INT and PER momentum both at target -> [BUFF: SHARP INSIGHT]:
//     +25 XP on editorial quests.
//   - 5/5 core momentums at target -> [FULL SYNC]: +30 XP at each daily
//     sync (00.43 WIB cron) and Streak Supply Drops double.
//   - Streak milestones: every 7 streak days -> Streak Supply Drop
//     +50 XP (+100 under FULL SYNC).
//
//   Rank-Up Trials (core stats only):
//   - E->D at level 9 MAX (4500 XP): >= 3/5 core momentums at target with
//     VIT mandatory at target, plus both editorial slots of the current
//     week completed.
//   - D->C at level 19 MAX: >= 4/5 at target and no penalty in 7 days.
//   - C->B, B->A, A->S: 5/5 at target simultaneously.
//
//   Baseline (verified 2026-11-07, supplied by the user): live time 22,
//   82 posts, lifetime points STR 2530, AGI 820, VIT 210, INT 320
//   (backfill), PER 160 (backfill), FAME 150 (15 followers), IMPACT 2879
//   (total reach), XP 2800 (level 8). Baseline 7-day momentum points
//   (window ending 2026-11-07): STR 610 (87.1/day), AGI 180 (25.7/day),
//   VIT 70 (10.0/day), INT 0, PER 0. The baseline window contribution
//   decays proportionally as the 7-day window slides past it, assuming
//   the baseline points were spread evenly across that window.
//
//   Auto-completion (live-time logic, user-approved 2026-11-07): every
//   quest has ONE source of truth, read by a privileged host function on
//   every open (15-minute cache, same as the dashboard) and on the daily
//   00.43 WIB sync: pull data -> auto-check -> compute XP/momentum ->
//   evaluate penalty and streak.
//   - news1 / news3: content-bank INDEX.json entries with status "posted"
//     on that date (news + editorial both count).
//   - approve: approval_log.json decisions on that date (any decision);
//     fallback: at least one INDEX post that date.
//   - clip: new Instagram media that date on @clipactivedaily or
//     @santadailyclip (TikTok/YouTube stay manual — no readable trail).
//   - research: a new entry that date in one of the three idea logs
//     (opini / bedah / tierlist); trail-less research stays manual.
//   - edit_tue / edit_sat: an editorial post (OPINI / BEDAH / TIER LIST /
//     SATIRE) on the slot date in INDEX.json / MASTER_POST_LOG.
//   - Performance checks (PER): opening THIS tracker page. Every getState
//     call appends {date, time, source: "tracker_open"} (WIB) to
//     tracker_opens.json; a date present there records one auto
//     performance check that day (+10 PER pts, max one per day, not per
//     open). Opening the separate UNRENDERED dashboard does NOT count,
//     and the 00.43 sync (refreshData) never writes an open entry.
//   Auto rows rebuild from sources on every sync and grant their XP once
//   (buff- and penalty-aware) when they first appear; auto beats manual
//   on the next read. Posts fold in from the baseline date itself: the
//   baseline totals already contain that date's points (see the
//   momentumFor note), so baseline-date posts drive the post COUNT and
//   the quests, while point deltas accrue only for later dates.
//   The "Training" daily quest was removed by user decision 2026-11-07.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
type SpaceDb,
} from "@hatch/space-sdk";
import { and, eq } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";
import { DashboardActions } from "./dashboard";
import { DraftActions } from "./drafts";

const SPREADSHEET_ID = "10W8xWifcMMPycmwo6VUzsFMsqoDHtXtKqJaDWn4eIrU";
const SYNC_MAX_AGE_MS = 15 * 60 * 1000;

const FIRST_DATE = "2026-10-16";
const BASELINE_DATE = "2026-11-07";
const BASE = {
  posts: 82,
  xp: 2800, // cumulative threshold of level 8
  strPts: 2530,
  agiPts: 820,
  vitPts: 210,
  intPts: 320, // backfill: 82 posts imply historical research
  perPts: 160, // backfill: 82 posts imply historical trend reading
  famePts: 150,
  followers: 15,
  impactPts: 2879,
};
// Points inside the 7-day window ending on BASELINE_DATE (verified).
const BASE_MOM_7D = {
  str: 610,
  agi: 180,
  vit: 70,
  int: 0,
  per: 0,
} as const;

const EDITORIAL_GENRES = new Set(["OPINI", "BEDAH", "TIER LIST", "SATIRE"]);

const DAILY_QUESTS = [
  { key: "news1", label: "Tayang 1 berita", xp: 30 },
  { key: "news3", label: "Tayang 3 berita (bonus komplit)", xp: 50 },
  { key: "approve", label: "Cek dan approve antrean", xp: 10 },
  { key: "clip", label: "Upload 1 klip", xp: 40 },
  { key: "research", label: "Riset 1 topik atau ide", xp: 20 },
] as const;

const WEEKLY_QUESTS = [
  { key: "edit_tue", label: "Editorial Selasa 19.00", xp: 100, dow: 2 },
  { key: "edit_sat", label: "Editorial Sabtu 19.00", xp: 100, dow: 6 },
] as const;

const MAKEUP_XP = 100;
const PENALTY_QUEST_REQUIRED = 3;

const DAILY_KEYS = new Set<string>(DAILY_QUESTS.map((q) => q.key));
const WEEKLY_KEYS = new Set<string>(WEEKLY_QUESTS.map((q) => q.key));

type CoreKey = "STR" | "AGI" | "VIT" | "INT" | "PER";
const CORE_KEYS: CoreKey[] = ["STR", "AGI", "VIT", "INT", "PER"];

const CORE_DEFS: Array<{
  key: CoreKey;
  momKey: "str" | "agi" | "vit" | "int" | "per";
  name: string;
  target: number;
  weakness: string;
}> = [
  {
    key: "STR",
    momKey: "str",
    name: "Strength — Tayangan",
    target: 120,
    weakness:
      "Produksimu kurang konsisten. Artinya kamu kurang tayang, kurang menjaga ritme harian, atau terlalu banyak hari kosong.",
  },
  {
    key: "AGI",
    momKey: "agi",
    name: "Agility — Approve",
    target: 40,
    weakness:
      "Responmu lambat. Artinya kamu kurang cepat approve, atau antrean dibiarkan menunggu sampai framingnya basi.",
  },
  {
    key: "VIT",
    momKey: "vit",
    name: "Vitality — Daya Tahan",
    target: 10,
    weakness:
      "Daya tahanmu putus-putus. Artinya kamu kurang menjaga streak harian, gampang absen sehari lalu kehilangan ritme.",
  },
  {
    key: "INT",
    momKey: "int",
    name: "Intelligence — Riset dan Ide",
    target: 20,
    weakness:
      "Risetmu kurang. Artinya kamu kurang menggali ide dan fakta baru, atau terlalu mengandalkan berita yang datang sendiri.",
  },
  {
    key: "PER",
    momKey: "per",
    name: "Perception — Cek Performa",
    target: 10,
    weakness:
      "Kamu kurang membaca tren dan audiens. Artinya kamu jarang cek performa, jadi tidak tahu konten apa yang sebenarnya jalan.",
  },
];

const WORLD_DEFS = [
  {
    key: "FAME",
    name: "Fame — Popularitas",
    target: 10,
    weakness:
      "Kamu kurang dikenal. Artinya kamu kurang promosi, kurang sebar ke luar, kurang kolaborasi, atau kurang tampil di tempat audiens barumu berada.",
  },
  {
    key: "IMPACT",
    name: "Impact — Jangkauan",
    target: 150,
    weakness:
      "Jangkauanmu kecil. Artinya kontenmu kurang menyebar, hook kurang kuat, atau kurang dibagikan orang.",
  },
] as const;

// ------------------------------------------------------------- date helpers

const DAY_MS = 24 * 60 * 60 * 1000;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function fmtDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Today's date and minutes since midnight in Asia/Jakarta. */
function nowWib(): { dateStr: string; minutes: number } {
  const shifted = new Date(Date.now() + WIB_OFFSET_MS);
  return {
    dateStr: fmtDate(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate(),
    ),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function addDays(dateStr: string, days: number): string {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  const d = new Date(t + days * DAY_MS);
  return fmtDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Whole days from a to b (b - a). */
function diffDays(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );
}

/** 0 = Sunday ... 6 = Saturday, for a YYYY-MM-DD date. */
function dowOf(dateStr: string): number {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`)).getUTCDay();
}

function mondayOf(dateStr: string): string {
  const dow = dowOf(dateStr);
  return addDays(dateStr, -((dow + 6) % 7));
}

/** Live time (World Age): days elapsed since the first post. */
function liveTimeFor(dateStr: string): number {
  return Math.max(1, diffDays(FIRST_DATE, dateStr));
}

// ------------------------------------------------------------ level helpers

/** Cumulative XP needed to REACH level L (level 1 = 0): 100 * L(L-1)/2. */
function xpThreshold(level: number): number {
  return 50 * level * (level - 1);
}

function levelForXp(xp: number): number {
  let level = 1;
  while (xpThreshold(level + 1) <= xp) level += 1;
  return level;
}

const RANKS = ["E", "D", "C", "B", "A", "S"] as const;
type Rank = (typeof RANKS)[number];

/** Highest level allowed while holding a rank (rank-up trial gate). */
const CAP_LEVEL: Record<Rank, number> = {
  E: 9,
  D: 19,
  C: 29,
  B: 39,
  A: 49,
  S: Number.POSITIVE_INFINITY,
};

function nextRank(rank: Rank): Rank | null {
  const i = RANKS.indexOf(rank);
  return i >= 0 && i < RANKS.length - 1 ? RANKS[i + 1]! : null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

// --------------------------------------------------------------- state rows

type Db = SpaceDb<typeof schema>;
type QuestLogRow = typeof schema.questLog.$inferSelect;
type SyncPostRow = typeof schema.syncPosts.$inferSelect;

async function readState(db: Db): Promise<Map<string, string>> {
  const rows = await db.select().from(schema.state);
  return new Map(rows.map((r) => [r.key, r.value]));
}

async function writeState(
  db: Db,
  entries: Array<[string, string]>,
): Promise<void> {
  for (const [key, value] of entries) {
    await db
      .insert(schema.state)
      .values({ key, value })
      .onConflictDoUpdate({
        target: schema.state.key,
        set: { value },
      });
  }
}

type Allocations = Record<CoreKey, number>;

function parseAllocations(raw: string | undefined): Allocations {
  const out: Allocations = { STR: 0, AGI: 0, VIT: 0, INT: 0, PER: 0 };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const k of CORE_KEYS) {
      const v = parsed[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        out[k] = Math.floor(v);
      }
    }
  } catch {
    // corrupted allocation blob: fall back to zeroes
  }
  return out;
}

interface StateNums {
  xp: number;
  rank: Rank;
  heldXp: number;
  allocations: Allocations;
  lastProcessedDate: string;
  lastSyncAt: number;
  lastSheetReach: number | null;
  syncError: string | null;
  lastFullSyncDate: string;
  lastSupplyStreak: number;
}

function stateNums(map: Map<string, string>): StateNums {
  const rawRank = map.get("rank") ?? "E";
  return {
    xp: Number(map.get("xp") ?? BASE.xp),
    rank: (RANKS as readonly string[]).includes(rawRank)
      ? (rawRank as Rank)
      : "E",
    heldXp: Number(map.get("heldXp") ?? 0),
    allocations: parseAllocations(map.get("allocations")),
    lastProcessedDate: map.get("lastProcessedDate") ?? BASELINE_DATE,
    lastSyncAt: Number(map.get("lastSyncAt") ?? 0),
    lastSheetReach:
      map.get("lastSheetReach") == null
        ? null
        : Number(map.get("lastSheetReach")),
    syncError: map.get("syncError") ?? null,
    lastFullSyncDate: map.get("lastFullSyncDate") ?? "",
    lastSupplyStreak: Number(map.get("lastSupplyStreak") ?? 0),
  };
}

/** Level actually displayed: raw level from XP, capped by the rank gate. */
function cappedLevel(xp: number, rank: Rank): number {
  return Math.min(levelForXp(xp), CAP_LEVEL[rank]);
}

/** Unallocated stat points: +3 per level from level 9 onward, minus spent. */
function unallocatedFor(st: StateNums): number {
  const earned = 3 * Math.max(0, cappedLevel(st.xp, st.rank) - 8);
  const spent = CORE_KEYS.reduce((sum, k) => sum + st.allocations[k], 0);
  return Math.max(0, earned - spent);
}

async function ensureInit(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({ key: schema.state.key })
    .from(schema.state)
    .limit(1);
  if (existing.length > 0) return;
  await writeState(db, [
    ["xp", String(BASE.xp)],
    ["rank", "E"],
    ["heldXp", "0"],
    ["allocations", "{}"],
    ["lastProcessedDate", BASELINE_DATE],
    ["lastSyncAt", "0"],
    ["initializedAt", new Date().toISOString()],
  ]);
  await db
    .insert(schema.snapshots)
    .values({
      date: BASELINE_DATE,
      liveTime: 22,
      strPts: BASE.strPts,
      agiPts: BASE.agiPts,
      vitPts: BASE.vitPts,
      intPts: BASE.intPts,
      perPts: BASE.perPts,
      famePts: BASE.famePts,
      impactPts: BASE.impactPts,
    })
    .onConflictDoNothing();
}

// ------------------------------------------------------------------- sync

function parseNum(cell: string | undefined): number {
  if (!cell) return 0;
  const cleaned = cell.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

interface SheetData {
  sheetValues: string[][];
  sheetError: string | null;
  indexEntries: Array<{
    id: string;
    genre: string;
    status: string;
    postedAt: string | null;
  }>;
  approvalDates: string[];
  trackerOpenDates: string[];
  researchDates: string[];
  igPostDates: string[];
  fetchedAt: string;
}

/**
 * Grants the XP of a quest that an auto source completed for the first
 * time. Same rules as a manual check: IRON WILL adds +10% on daily
 * quests, SHARP INSIGHT adds +25 on editorial quests (both read from the
 * momentum of the quest's own date), and on a Penalty Zone day the gain
 * is held in the XP Vault until that date reaches the Penalty Quest
 * threshold. Research and clip completions also leave their metric-event
 * trail (INT points / clip evidence), at most one event per date.
 */
async function awardAutoXp(
  ctx: Ctx,
  row: { date: string; questKey: string; xp: number },
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const isDaily = DAILY_KEYS.has(row.questKey);
  const isWeekly = WEEKLY_KEYS.has(row.questKey);

  const delta = await loadDelta(ctx);
  const mom = momentumFor(row.date, delta);
  let gain = row.xp;
  if (isDaily && mom.vit >= 10) gain += Math.round(row.xp * 0.1);
  if (isWeekly && mom.int >= 20 && mom.per >= 10) gain += 25;

  if (row.questKey === "research" || row.questKey === "clip") {
    const kind = row.questKey === "research" ? "research" : "clip";
    const existing = await db
      .select()
      .from(schema.metricEvents)
      .where(
        and(
          eq(schema.metricEvents.kind, kind),
          eq(schema.metricEvents.date, row.date),
        ),
      );
    if (existing.length === 0) {
      await db.insert(schema.metricEvents).values({
        date: row.date,
        kind,
        amount: 1,
      });
    }
  }

  const st = stateNums(await readState(db));
  const log = await db.select().from(schema.questLog);
  if (!isPenaltyDay(log, row.date)) {
    await writeState(db, [["xp", String(st.xp + gain)]]);
    return;
  }
  let held = st.heldXp + gain;
  let xp = st.xp;
  if (dailyCountOn(log, row.date) >= PENALTY_QUEST_REQUIRED) {
    xp += held;
    held = 0;
  }
  await writeState(db, [
    ["xp", String(xp)],
    ["heldXp", String(held)],
  ]);
}

async function syncFromSources(
  ctx: Ctx,
): Promise<{ ok: boolean; newPosts: number; error: string | null }> {
  const db = ctx.db<typeof schema>();
  let live: SheetData;
  try {
    live = await ctx.executePrivileged(privileged.fetchSheetData, {
      spreadsheetId: SPREADSHEET_ID,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : "sync gagal";
    await writeState(db, [["syncError", msg]]);
    return { ok: false, newPosts: 0, error: msg };
  }

  const updates: Array<[string, string]> = [
    ["lastSyncAt", String(Date.now())],
  ];

  // Total reach from the sheet (column H). Only trust a non-empty read.
  if (!live.sheetError && live.sheetValues.length > 1) {
    let reach = 0;
    for (const row of live.sheetValues.slice(1)) reach += parseNum(row[7]);
    if (reach > 0) updates.push(["lastSheetReach", String(Math.round(reach))]);
    updates.push(["syncError", ""]);
  } else if (live.sheetError) {
    updates.push(["syncError", live.sheetError]);
  }

  // Fold in newly posted content-bank entries. Entries dated ON the
  // baseline date are included: they drive the post count and the quests,
  // while their points are already inside the verified baseline totals
  // (computePoints / loadDelta only accrue points for later dates).
  const known = new Set(
    (await db.select().from(schema.syncPosts)).map((r) => r.contentId),
  );
  let newPosts = 0;
  for (const entry of live.indexEntries) {
    if (entry.status !== "posted" || !entry.postedAt) continue;
    const date = entry.postedAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < BASELINE_DATE || known.has(entry.id)) continue;
    known.add(entry.id);
    await db.insert(schema.syncPosts).values({
      contentId: entry.id,
      date,
      genre: entry.genre.toUpperCase(),
    });
    newPosts += 1;
  }

  // Remember every completion that already exists (auto or manual) so a
  // rebuilt auto row never grants its XP twice; auto beats manual on the
  // next read because the auto row is re-derived from its source.
  const prevLog = await db.select().from(schema.questLog);
  const prevDone = new Set(prevLog.map((r) => `${r.date}|${r.questKey}`));

  // Rebuild auto quest rows from all live-time sources.
  await db
    .delete(schema.questLog)
    .where(eq(schema.questLog.source, "auto"));
  const posts = await db.select().from(schema.syncPosts);
  const byDate = new Map<string, { total: number; editorial: boolean }>();
  for (const p of posts) {
    const cur = byDate.get(p.date) ?? { total: 0, editorial: false };
    cur.total += 1;
    if (EDITORIAL_GENRES.has(p.genre)) cur.editorial = true;
    byDate.set(p.date, cur);
  }
  const autoRows: Array<{
    date: string;
    questKey: string;
    xp: number;
    source: "auto";
  }> = [];
  for (const [date, info] of byDate) {
    if (info.total >= 1)
      autoRows.push({ date, questKey: "news1", xp: 30, source: "auto" });
    if (info.total >= 3)
      autoRows.push({ date, questKey: "news3", xp: 50, source: "auto" });
    if (info.editorial) {
      const dow = dowOf(date);
      if (dow === 2)
        autoRows.push({ date, questKey: "edit_tue", xp: 100, source: "auto" });
      if (dow === 6)
        autoRows.push({ date, questKey: "edit_sat", xp: 100, source: "auto" });
    }
  }
  // Approve: a logged widget decision that date, with the INDEX fallback
  // (a posted post implies a "gass upload" tap even if its log entry is
  // missing). Dates before the baseline are baseline history.
  const approveDates = new Set<string>(
    live.approvalDates.filter((d) => d >= BASELINE_DATE),
  );
  for (const date of byDate.keys()) approveDates.add(date);
  for (const date of approveDates) {
    autoRows.push({ date, questKey: "approve", xp: 10, source: "auto" });
  }
  // Research: a new idea-log entry that date.
  for (const date of live.researchDates) {
    if (date < BASELINE_DATE) continue;
    autoRows.push({ date, questKey: "research", xp: 20, source: "auto" });
  }
  // Clip: new Instagram media that date on either clipper account.
  for (const date of live.igPostDates) {
    if (date < BASELINE_DATE) continue;
    autoRows.push({ date, questKey: "clip", xp: 40, source: "auto" });
  }
  if (autoRows.length > 0) {
    await db.insert(schema.questLog).values(autoRows);
  }

  // Grant XP for auto completions that appear for the first time, in a
  // deterministic order (date, then spec quest order) so Penalty Quest
  // flush checks see a stable sequence.
  const grantOrder = [
    "news1",
    "news3",
    "approve",
    "clip",
    "research",
    "edit_tue",
    "edit_sat",
  ];
  const fresh = autoRows
    .filter((r) => !prevDone.has(`${r.date}|${r.questKey}`))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        grantOrder.indexOf(a.questKey) - grantOrder.indexOf(b.questKey),
    );
  for (const row of fresh) {
    await awardAutoXp(ctx, row);
  }

  // Performance checks from the tracker open trail: exactly one AUTO
  // perf_check event per open date (never one per open). Auto credits are
  // tracked in their own state set, separate from manual button checks,
  // so a manual check on the same date neither duplicates nor suppresses
  // the open-trail credit, and rebuilds never re-credit a date.
  const stateMap = await readState(db);
  let perfCredited: string[] = [];
  try {
    const parsed = JSON.parse(stateMap.get("trackerPerfDates") ?? "[]");
    if (Array.isArray(parsed)) {
      perfCredited = parsed.filter(
        (d): d is string => typeof d === "string",
      );
    }
  } catch {
    perfCredited = [];
  }
  const perfCreditedSet = new Set(perfCredited);
  let perfChanged = false;
  for (const date of live.trackerOpenDates) {
    if (date < BASELINE_DATE || perfCreditedSet.has(date)) continue;
    perfCreditedSet.add(date);
    perfChanged = true;
    await db.insert(schema.metricEvents).values({
      date,
      kind: "perf_check",
      amount: 1,
    });
  }
  if (perfChanged) {
    updates.push([
      "trackerPerfDates",
      JSON.stringify([...perfCreditedSet].sort()),
    ]);
  }

  await writeState(db, updates);
  return { ok: !live.sheetError, newPosts, error: live.sheetError };
}

// ------------------------------------------------------- points & momentum

interface Points {
  str: number;
  agi: number;
  vit: number;
  int: number;
  per: number;
  fame: number;
  impact: number;
}

/** Lifetime category points: baseline + all recorded deltas. */
async function computePoints(ctx: Ctx): Promise<{
  points: Points;
  deltaPosts: number;
  followers: number;
}> {
  const db = ctx.db<typeof schema>();
  const st = stateNums(await readState(db));
  const posts = await db.select().from(schema.syncPosts);
  const events = await db.select().from(schema.metricEvents);
  const log = await db.select().from(schema.questLog);

  // Points accrue only for posts after the baseline date; baseline-date
  // posts are already inside the verified baseline totals (they still
  // count toward totalPosts via deltaPosts below).
  const pointPosts = posts.filter((p) => p.date > BASELINE_DATE);
  let strDelta = 0;
  for (const p of pointPosts) {
    strDelta += EDITORIAL_GENRES.has(p.genre) ? 100 : 30;
  }
  const agiDelta = pointPosts.length * 10;

  const activeDeltaDays = new Set(
    log.filter((r) => r.date > BASELINE_DATE).map((r) => r.date),
  ).size;

  let research = 0;
  let perfChecks = 0;
  let manualFollowers = 0;
  let manualReach = 0;
  for (const e of events) {
    if (e.kind === "research") research += e.amount;
    else if (e.kind === "perf_check") perfChecks += e.amount;
    else if (e.kind === "followers") manualFollowers += e.amount;
    else if (e.kind === "reach") manualReach += e.amount;
  }

  const sheetReach = st.lastSheetReach ?? BASE.impactPts;
  return {
    points: {
      str: BASE.strPts + strDelta,
      agi: BASE.agiPts + agiDelta,
      vit: BASE.vitPts + activeDeltaDays * 10,
      int: BASE.intPts + research * 20,
      per: BASE.perPts + perfChecks * 10,
      fame: BASE.famePts + manualFollowers * 10,
      impact: sheetReach + manualReach,
    },
    deltaPosts: posts.length,
    followers: BASE.followers + manualFollowers,
  };
}

interface DeltaData {
  /** Per-date delta points for dates after the baseline. */
  byDate: Map<string, { str: number; agi: number; int: number; per: number }>;
  /** Dates after the baseline with at least one completed quest. */
  activeDates: Set<string>;
}

async function loadDelta(ctx: Ctx): Promise<DeltaData> {
  const db = ctx.db<typeof schema>();
  const posts = await db.select().from(schema.syncPosts);
  const events = await db.select().from(schema.metricEvents);
  const log = await db.select().from(schema.questLog);

  const byDate = new Map<
    string,
    { str: number; agi: number; int: number; per: number }
  >();
  const bump = (
    date: string,
    patch: Partial<{ str: number; agi: number; int: number; per: number }>,
  ) => {
    const cur = byDate.get(date) ?? { str: 0, agi: 0, int: 0, per: 0 };
    cur.str += patch.str ?? 0;
    cur.agi += patch.agi ?? 0;
    cur.int += patch.int ?? 0;
    cur.per += patch.per ?? 0;
    byDate.set(date, cur);
  };
  for (const p of posts) {
    // Baseline-date posts are covered by the baseline window totals (see
    // momentumFor); only later posts add momentum points here.
    if (p.date <= BASELINE_DATE) continue;
    bump(p.date, {
      str: EDITORIAL_GENRES.has(p.genre) ? 100 : 30,
      agi: 10,
    });
  }
  for (const e of events) {
    if (e.kind === "research") bump(e.date, { int: e.amount * 20 });
    else if (e.kind === "perf_check") bump(e.date, { per: e.amount * 10 });
  }
  const activeDates = new Set(
    log.filter((r) => r.date > BASELINE_DATE).map((r) => r.date),
  );
  return { byDate, activeDates };
}

type MomPoints = { str: number; agi: number; vit: number; int: number; per: number };

/**
 * Momentum (points per day) for the 7-day window ending on `dateStr`.
 * Baseline points count for the overlap with the baseline window
 * [BASELINE-6, BASELINE], spread evenly; newer points come from deltas.
 */
function momentumFor(dateStr: string, delta: DeltaData): MomPoints {
  const windowStart = addDays(dateStr, -6);
  const baseStart = addDays(BASELINE_DATE, -6);
  let overlap = 0;
  for (let d = windowStart; d <= dateStr; d = addDays(d, 1)) {
    if (d >= baseStart && d <= BASELINE_DATE) overlap += 1;
  }
  const share = overlap / 7;
  const pts: MomPoints = {
    str: BASE_MOM_7D.str * share,
    agi: BASE_MOM_7D.agi * share,
    vit: BASE_MOM_7D.vit * share,
    int: BASE_MOM_7D.int * share,
    per: BASE_MOM_7D.per * share,
  };
  for (let d = windowStart; d <= dateStr; d = addDays(d, 1)) {
    if (d < BASELINE_DATE) continue;
    const day = delta.byDate.get(d);
    if (d === BASELINE_DATE) {
      // The baseline date itself is covered by the baseline totals for
      // posts and active days, but research / performance logs written on
      // it are new tracker activity (baseline INT/PER momentum is 0), so
      // they count toward momentum without double-counting.
      if (day) {
        pts.int += day.int;
        pts.per += day.per;
      }
      continue;
    }
    if (day) {
      pts.str += day.str;
      pts.agi += day.agi;
      pts.int += day.int;
      pts.per += day.per;
    }
    if (delta.activeDates.has(d)) pts.vit += 10;
  }
  return {
    str: round1(pts.str / 7),
    agi: round1(pts.agi / 7),
    vit: round1(pts.vit / 7),
    int: round1(pts.int / 7),
    per: round1(pts.per / 7),
  };
}

function coreAtTargetCount(mom: MomPoints): number {
  return CORE_DEFS.filter((def) => mom[def.momKey] >= def.target).length;
}

// ------------------------------------------- penalty, breach, streak logic

function dailyCountOn(log: QuestLogRow[], date: string): number {
  return log.filter((r) => r.date === date && DAILY_KEYS.has(r.questKey))
    .length;
}

/**
 * An empty day = 0 daily quests completed. Days before the baseline are
 * historical (covered by the verified baseline) and never count as empty.
 */
function isEmptyDay(log: QuestLogRow[], date: string): boolean {
  if (date < BASELINE_DATE) return false;
  return dailyCountOn(log, date) === 0;
}

/** Penalty Zone is active on `date` when the day before was empty. */
function isPenaltyDay(log: QuestLogRow[], date: string): boolean {
  return isEmptyDay(log, addDays(date, -1));
}

/** Uncovered editorial breaches (missed slots on otherwise active days). */
function computeBreaches(
  log: QuestLogRow[],
  posts: SyncPostRow[],
  today: string,
  minutes: number,
): string[] {
  const breaches: string[] = [];
  const slotDates = new Set<string>();
  for (
    let d = addDays(BASELINE_DATE, 1);
    d <= today;
    d = addDays(d, 1)
  ) {
    const dow = dowOf(d);
    if (dow !== 2 && dow !== 6) continue;
    slotDates.add(d);
    const slotPassed = d < today || minutes >= 19 * 60;
    if (!slotPassed) continue;
    const byPost = posts.some(
      (p) => p.date === d && EDITORIAL_GENRES.has(p.genre),
    );
    const byQuest = log.some(
      (r) =>
        r.date === d &&
        (r.questKey === "edit_tue" || r.questKey === "edit_sat"),
    );
    if (byPost || byQuest) continue;
    // A fully empty day is a Penalty Zone case, not an editorial breach.
    if (dailyCountOn(log, d) >= 1) breaches.push(d);
  }

  // Make-up credits: manual make-up quests + editorial posts that did not
  // satisfy their own slot (extra posts on a slot day, or posts on
  // non-slot days). Each credit covers the earliest earlier breach.
  const credits: string[] = log
    .filter((r) => r.questKey === "makeup")
    .map((r) => r.date);
  const editorialByDate = new Map<string, number>();
  for (const p of posts) {
    if (!EDITORIAL_GENRES.has(p.genre)) continue;
    editorialByDate.set(p.date, (editorialByDate.get(p.date) ?? 0) + 1);
  }
  for (const [date, count] of editorialByDate) {
    const extras = count - (slotDates.has(date) ? 1 : 0);
    for (let i = 0; i < extras; i += 1) credits.push(date);
  }
  credits.sort();

  const used = new Array<boolean>(credits.length).fill(false);
  const uncovered: string[] = [];
  for (const breach of breaches) {
    const idx = credits.findIndex((c, i) => !used[i] && c > breach);
    if (idx >= 0) used[idx] = true;
    else uncovered.push(breach);
  }
  return uncovered;
}

function streakEndingAt(activeDates: Set<string>, end: string): number {
  let streak = 0;
  let cursor = end;
  while (activeDates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * Current streak. While a make-up debt is open, the streak is FROZEN at
 * its value on the earliest uncovered breach date (EDITORIAL BREACH).
 */
function computeStreak(
  log: QuestLogRow[],
  uncoveredBreaches: string[],
  today: string,
): { days: number; frozen: boolean } {
  const activeDates = new Set(log.map((r) => r.date));
  const firstBreach = uncoveredBreaches[0];
  if (firstBreach) {
    return { days: streakEndingAt(activeDates, firstBreach), frozen: true };
  }
  const cursor = activeDates.has(today) ? today : addDays(today, -1);
  return { days: streakEndingAt(activeDates, cursor), frozen: false };
}

// --------------------------------------------------------- day processing

/**
 * Runs once per new WIB day (also driven by the 00.43 cron via
 * refreshData): burns unflushed Held XP from failed penalty days and
 * grants the FULL SYNC daily bonus. XP is never cut here.
 */
async function applyDayProcessing(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const st = stateNums(await readState(db));
  const { dateStr: today } = nowWib();
  if (st.lastProcessedDate >= today) return;

  const log = await db.select().from(schema.questLog);

  // Burn: a fully elapsed penalty day that ended with < 3 daily quests
  // loses whatever XP was held during it.
  let heldXp = st.heldXp;
  for (
    let d = addDays(st.lastProcessedDate, 1);
    d < today;
    d = addDays(d, 1)
  ) {
    if (isPenaltyDay(log, d) && dailyCountOn(log, d) < PENALTY_QUEST_REQUIRED) {
      heldXp = 0;
    }
  }

  const entries: Array<[string, string]> = [
    ["heldXp", String(heldXp)],
    ["lastProcessedDate", today],
  ];

  // FULL SYNC: +30 XP once per day while all 5 core momentums are at target.
  if (st.lastFullSyncDate !== today) {
    const delta = await loadDelta(ctx);
    const mom = momentumFor(today, delta);
    if (coreAtTargetCount(mom) === 5) {
      entries.push(["xp", String(st.xp + 30)]);
      entries.push(["lastFullSyncDate", today]);
    }
  }

  await writeState(db, entries);
}

/** Streak Supply Drop: +50 XP at every 7-day streak milestone (+100 FULL SYNC). */
async function checkSupplyDrop(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const st = stateNums(await readState(db));
  const { dateStr: today, minutes } = nowWib();
  const log = await db.select().from(schema.questLog);
  const posts = await db.select().from(schema.syncPosts);
  const breaches = computeBreaches(log, posts, today, minutes);
  const streak = computeStreak(log, breaches, today);
  if (streak.frozen) return;
  if (streak.days < 7 || streak.days % 7 !== 0) return;
  if (st.lastSupplyStreak >= streak.days) return;
  const delta = await loadDelta(ctx);
  const mom = momentumFor(today, delta);
  const bonus = coreAtTargetCount(mom) === 5 ? 100 : 50;
  await writeState(db, [
    ["xp", String(st.xp + bonus)],
    ["lastSupplyStreak", String(streak.days)],
  ]);
}

// ----------------------------------------------------------- rank trials

interface TrialCondition {
  label: string;
  met: boolean;
}

async function trialConditions(
  ctx: Ctx,
  rank: Rank,
): Promise<{ conditions: TrialCondition[]; allMet: boolean }> {
  const db = ctx.db<typeof schema>();
  const { dateStr: today } = nowWib();
  const delta = await loadDelta(ctx);
  const mom = momentumFor(today, delta);
  const count = coreAtTargetCount(mom);
  const conditions: TrialCondition[] = [];

  if (rank === "E") {
    const log = await db.select().from(schema.questLog);
    const monday = mondayOf(today);
    const tueDone = log.some(
      (r) => r.questKey === "edit_tue" && r.date >= monday && r.date <= today,
    );
    const satDone = log.some(
      (r) => r.questKey === "edit_sat" && r.date >= monday && r.date <= today,
    );
    conditions.push(
      {
        label: `Minimal 3 dari 5 Core Stat mencapai Momentum 100% target (sekarang ${count}/5)`,
        met: count >= 3,
      },
      {
        label: "Momentum VIT wajib mencapai target 10,0",
        met: mom.vit >= 10,
      },
      {
        label: "2 Editorial minggu berjalan tuntas (Selasa dan Sabtu)",
        met: tueDone && satDone,
      },
    );
  } else if (rank === "D") {
    const log = await db.select().from(schema.questLog);
    let penaltyFree = true;
    for (let i = 1; i <= 7; i += 1) {
      if (isEmptyDay(log, addDays(today, -i))) {
        penaltyFree = false;
        break;
      }
    }
    conditions.push(
      {
        label: `Minimal 4 dari 5 Core Stat mencapai Momentum 100% target (sekarang ${count}/5)`,
        met: count >= 4,
      },
      {
        label: "Tidak ada penalti selama 7 hari terakhir",
        met: penaltyFree,
      },
    );
  } else {
    conditions.push({
      label: "Kelima Core Stat (5/5) mencapai Momentum 100% target bersamaan",
      met: count === 5,
    });
  }
  return { conditions, allMet: conditions.every((c) => c.met) };
}

/**
 * Promotes the rank when XP has reached the promotion threshold and the
 * trial conditions are met. Overflow XP then counts toward the level
 * automatically because the level cap lifts with the new rank.
 */
async function checkTrialPromotion(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  for (let guard = 0; guard < RANKS.length; guard += 1) {
    const st = stateNums(await readState(db));
    const nxt = nextRank(st.rank);
    if (!nxt) return;
    const promoXp = xpThreshold(CAP_LEVEL[st.rank] + 1);
    if (st.xp < promoXp) return;
    const { allMet } = await trialConditions(ctx, st.rank);
    if (!allMet) return;
    await writeState(db, [["rank", nxt]]);
  }
}

// ---------------------------------------------------------------- pipeline

/** Stores today's snapshot of lifetime points (kept for history). */
async function storeSnapshot(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const { dateStr: today } = nowWib();
  const { points } = await computePoints(ctx);
  await db
    .insert(schema.snapshots)
    .values({
      date: today,
      liveTime: liveTimeFor(today),
      strPts: points.str,
      agiPts: points.agi,
      vitPts: points.vit,
      intPts: points.int,
      perPts: points.per,
      famePts: points.fame,
      impactPts: points.impact,
    })
    .onConflictDoUpdate({
      target: schema.snapshots.date,
      set: {
        liveTime: liveTimeFor(today),
        strPts: points.str,
        agiPts: points.agi,
        vitPts: points.vit,
        intPts: points.int,
        perPts: points.per,
        famePts: points.fame,
        impactPts: points.impact,
      },
    });
}

/** Full pipeline: init -> (sync if stale) -> day processing -> trial -> snapshot. */
async function ensurePipeline(ctx: Ctx, forceSync: boolean): Promise<void> {
  await ensureInit(ctx);
  const db = ctx.db<typeof schema>();
  const st = stateNums(await readState(db));
  if (forceSync || Date.now() - st.lastSyncAt > SYNC_MAX_AGE_MS) {
    await syncFromSources(ctx);
  }
  await applyDayProcessing(ctx);
  await checkTrialPromotion(ctx);
  await checkSupplyDrop(ctx);
  await storeSnapshot(ctx);
}

// ------------------------------------------------------------------- view

const coreStatView = z.object({
  key: z.string(),
  name: z.string(),
  baseStat: z.number(),
  lifetimePts: z.number(),
  momentum: z.number(),
  target: z.number(),
  pct: z.number(),
  trend: z.enum(["up", "down", "flat"]),
  note: z.string(),
  allocated: z.number(),
});

const worldStatView = z.object({
  key: z.string(),
  name: z.string(),
  total: z.number(),
  totalLabel: z.string(),
  rate: z.number(),
  target: z.number(),
  note: z.string(),
});

const buffView = z.object({
  key: z.string(),
  name: z.string(),
  active: z.boolean(),
  description: z.string(),
});

const questView = z.object({
  key: z.string(),
  label: z.string(),
  xp: z.number(),
  done: z.boolean(),
  source: z.enum(["auto", "manual", "none"]),
  breachDate: z.string().nullable(),
});

const trialView = z.object({
  nextRank: z.string(),
  capLevel: z.number(),
  promotionXp: z.number(),
  xpReached: z.boolean(),
  passed: z.boolean(),
  conditions: z.array(
    z.object({ label: z.string(), met: z.boolean() }),
  ),
});

const stateResponse = z.object({
  today: z.string(),
  liveTime: z.number(),
  xp: z.number(),
  level: z.number(),
  rank: z.string(),
  xpIntoLevel: z.number(),
  xpForNextLevel: z.number(),
  overflowXp: z.number(),
  heldXp: z.number(),
  penaltyZoneActive: z.boolean(),
  penaltyQuestDone: z.number(),
  penaltyQuestRequired: z.number(),
  unallocatedPoints: z.number(),
  totalPosts: z.number(),
  followers: z.number(),
  totalReach: z.number(),
  streakDays: z.number(),
  streakFrozen: z.boolean(),
  makeupDebt: z.number(),
  statuses: z.array(
    z.enum(["PENALTY ZONE", "EDITORIAL BREACH", "FULL SYNC"]),
  ),
  buffs: z.array(buffView),
  trial: trialView.nullable(),
  dailyQuests: z.array(questView),
  weeklyQuests: z.array(questView),
  makeupQuests: z.array(questView),
  coreStats: z.array(coreStatView),
  worldStats: z.array(worldStatView),
  lastSyncAt: z.string().nullable(),
  syncError: z.string().nullable(),
});

type StateResponse = z.infer<typeof stateResponse>;

async function buildView(ctx: Ctx): Promise<StateResponse> {
  const db = ctx.db<typeof schema>();
  const st = stateNums(await readState(db));
  const { dateStr: today, minutes } = nowWib();
  const liveTime = liveTimeFor(today);
  const { points, deltaPosts, followers } = await computePoints(ctx);
  const delta = await loadDelta(ctx);
  const mom = momentumFor(today, delta);
  const momPrev = momentumFor(addDays(today, -1), delta);

  const log = await db.select().from(schema.questLog);
  const posts = await db.select().from(schema.syncPosts);

  // Level, rank gate, overflow.
  const level = cappedLevel(st.xp, st.rank);
  const nxt = nextRank(st.rank);
  const promotionXp = nxt ? xpThreshold(CAP_LEVEL[st.rank] + 1) : null;
  const capped = promotionXp !== null && st.xp >= promotionXp;
  const overflowXp = capped && promotionXp !== null ? st.xp - promotionXp : 0;
  const xpForNextLevel = xpThreshold(level + 1) - xpThreshold(level);
  const xpIntoLevel = capped
    ? xpForNextLevel
    : st.xp - xpThreshold(level);

  // Penalty zone, breaches, streak, statuses, buffs.
  const penaltyZoneActive = isPenaltyDay(log, today);
  const penaltyQuestDone = dailyCountOn(log, today);
  const breaches = computeBreaches(log, posts, today, minutes);
  const streak = computeStreak(log, breaches, today);
  const atTarget = coreAtTargetCount(mom);
  const ironWill = mom.vit >= 10;
  const sharpInsight = mom.int >= 20 && mom.per >= 10;
  const fullSync = atTarget === 5;

  const statuses: Array<"PENALTY ZONE" | "EDITORIAL BREACH" | "FULL SYNC"> =
    [];
  if (penaltyZoneActive) statuses.push("PENALTY ZONE");
  if (breaches.length > 0) statuses.push("EDITORIAL BREACH");
  if (fullSync) statuses.push("FULL SYNC");

  const buffs = [
    {
      key: "IRON WILL",
      name: "BUFF: IRON WILL",
      active: ironWill,
      description:
        "Momentum VIT mencapai 10,0 — semua quest harian memberi +10% XP.",
    },
    {
      key: "SHARP INSIGHT",
      name: "BUFF: SHARP INSIGHT",
      active: sharpInsight,
      description:
        "Momentum INT dan PER sama-sama mencapai target — quest editorial memberi +25 XP.",
    },
    {
      key: "FULL SYNC",
      name: "FULL SYNC",
      active: fullSync,
      description:
        "5/5 Core Stat mencapai target bersamaan — +30 XP tiap sinkronisasi harian pukul 00.43 WIB dan Streak Supply Drop berlipat dari +50 menjadi +100 XP.",
    },
  ];

  // Core stats (dual-layer).
  const lifetimeByMomKey: Record<string, number> = {
    str: points.str,
    agi: points.agi,
    vit: points.vit,
    int: points.int,
    per: points.per,
  };
  const coreStats = CORE_DEFS.map((def) => {
    const lifetimePts = lifetimeByMomKey[def.momKey] ?? 0;
    const momentum = mom[def.momKey];
    const before = momPrev[def.momKey];
    let trend: "up" | "down" | "flat" = "flat";
    if (momentum > before + 0.05) trend = "up";
    else if (momentum < before - 0.05) trend = "down";
    let note: string;
    if (momentum >= def.target) {
      if (def.key === "VIT") {
        note = "[BUFF: IRON WILL] aktif — semua quest harian memberi +10% XP.";
      } else if ((def.key === "INT" || def.key === "PER") && sharpInsight) {
        note =
          "[BUFF: SHARP INSIGHT] aktif — quest editorial memberi +25 XP.";
      } else {
        note = "Target tercapai, pertahankan.";
      }
    } else {
      note = def.weakness;
    }
    return {
      key: def.key,
      name: def.name,
      baseStat:
        10 + Math.floor(lifetimePts / 50) + st.allocations[def.key],
      lifetimePts: Math.round(lifetimePts),
      momentum,
      target: def.target,
      pct: Math.floor((momentum / def.target) * 100),
      trend,
      note,
      allocated: st.allocations[def.key],
    };
  });

  // World Influence (lifetime rates, kept off the core panel and trials).
  const worldStats = WORLD_DEFS.map((def) => {
    const isFame = def.key === "FAME";
    const pts = isFame ? points.fame : points.impact;
    const rate = round1(pts / liveTime);
    return {
      key: def.key,
      name: def.name,
      total: isFame ? followers : Math.round(points.impact),
      totalLabel: isFame ? "follower" : "reach",
      rate,
      target: def.target,
      note:
        rate >= def.target ? "Target tercapai, pertahankan." : def.weakness,
    };
  });

  // Quests for today (daily) and this week (weekly, Monday start).
  const monday = mondayOf(today);
  const findRow = (key: string, daily: boolean) =>
    log.find((r) =>
      daily
        ? r.questKey === key && r.date === today
        : r.questKey === key && r.date >= monday && r.date <= today,
    );
  const toView = (
    def: { key: string; label: string; xp: number },
    daily: boolean,
  ) => {
    const row = findRow(def.key, daily);
    return {
      key: def.key,
      label: def.label,
      xp: def.xp,
      done: Boolean(row),
      source: (row ? row.source : "none") as "auto" | "manual" | "none",
      breachDate: null,
    };
  };

  const makeupQuests = breaches.map((date) => ({
    key: "makeup",
    label: `Make-Up Editorial — tayang 1 editorial pengganti (hutang slot ${date})`,
    xp: MAKEUP_XP,
    done: false,
    source: "none" as const,
    breachDate: date,
  }));

  // Rank-up trial panel: shown at the rank's MAX level.
  let trial: z.infer<typeof trialView> | null = null;
  if (nxt && promotionXp !== null && level >= CAP_LEVEL[st.rank]) {
    const { conditions, allMet } = await trialConditions(ctx, st.rank);
    trial = {
      nextRank: nxt,
      capLevel: CAP_LEVEL[st.rank],
      promotionXp,
      xpReached: capped,
      passed: allMet,
      conditions,
    };
  }

  return {
    today,
    liveTime,
    xp: st.xp,
    level,
    rank: st.rank,
    xpIntoLevel,
    xpForNextLevel,
    overflowXp,
    heldXp: st.heldXp,
    penaltyZoneActive,
    penaltyQuestDone,
    penaltyQuestRequired: PENALTY_QUEST_REQUIRED,
    unallocatedPoints: unallocatedFor(st),
    totalPosts: BASE.posts + deltaPosts,
    followers,
    totalReach: Math.round(points.impact),
    streakDays: streak.days,
    streakFrozen: streak.frozen,
    makeupDebt: breaches.length,
    statuses,
    buffs,
    trial,
    dailyQuests: DAILY_QUESTS.map((q) => toView(q, true)),
    weeklyQuests: WEEKLY_QUESTS.map((q) => toView(q, false)),
    makeupQuests,
    coreStats,
    worldStats,
    lastSyncAt:
      st.lastSyncAt > 0 ? new Date(st.lastSyncAt).toISOString() : null,
    syncError: st.syncError ? st.syncError : null,
  };
}

// ---------------------------------------------------------------- actions

export const Actions = {
  getState: defineAction({
    description:
      "Returns the full Tracker Grind-ku v2 state: live time, XP (never decreases), capped level, rank, held XP and penalty status, streak, daily/weekly/make-up quests, the five dual-layer Core Stats with 7-day momentum, World Influence, buffs, and rank-up trial progress. Calling it means the tracker page was opened: it first appends a tracker_open entry (WIB date/time) to tracker_opens.json — that open is the performance-check source, worth one auto PER check per day — then, when the last sync is older than 15 minutes, re-reads every live-time source (MASTER_POST_LOG sheet, content-bank INDEX, approval log, tracker open trail, idea logs, clipper Instagram) and auto-checks the quests those sources prove.",
    request: z.object({}),
    response: stateResponse,
    privileged: [privileged.fetchSheetData, privileged.appendTrackerOpen],
    async handler(ctx): Promise<StateResponse> {
      // Opening the tracker page IS the performance check: log the open
      // before syncing so today's open counts in this very read. Logging
      // is best-effort and must never break the page.
      try {
        await ctx.executePrivileged(privileged.appendTrackerOpen, {});
      } catch {
        // the open trail is evidence, not a hard dependency
      }
      await ensurePipeline(ctx, false);
      return buildView(ctx);
    },
  }),

  refreshData: defineAction({
    description:
      "Forces a fresh sync from every live-time source (MASTER_POST_LOG sheet, content-bank INDEX, approval log, tracker open trail, idea logs, clipper Instagram): folds in new posts, rebuilds auto quest rows, grants XP for first-time auto completions, records tracker-open performance checks, then runs the daily processing (held-XP burn check, FULL SYNC bonus, rank trial check) and returns the updated tracker state. Used by the refresh button and the daily 00.43 WIB schedule. It deliberately does NOT append a tracker_open entry: a scheduled sync is not a page open.",
    request: z.object({}),
    response: stateResponse,
    privileged: [privileged.fetchSheetData],
    async handler(ctx): Promise<StateResponse> {
      await ensurePipeline(ctx, true);
      ctx.invalidateQueries();
      return buildView(ctx);
    },
  }),

  toggleQuest: defineAction({
    description:
      "Checks or unchecks a quest. Daily quests apply to today; weekly quests to their slot day this week; 'makeup' completes one Make-Up Editorial debt. Checking grants XP with active buffs (IRON WILL +10% daily, SHARP INSIGHT +25 editorial); during Penalty Zone the XP is held in the vault until 3 daily quests are done today. Auto-completed quests cannot be unchecked here.",
    request: z.object({
      questKey: z.string().min(1),
      done: z.boolean(),
    }),
    response: stateResponse,
    privileged: [privileged.fetchSheetData],
    async handler(ctx, args): Promise<StateResponse> {
      await ensurePipeline(ctx, false);
      const db = ctx.db<typeof schema>();
      const { dateStr: today } = nowWib();
      const isDaily = DAILY_KEYS.has(args.questKey);
      const isWeekly = WEEKLY_KEYS.has(args.questKey);
      const isMakeup = args.questKey === "makeup";
      if (!isDaily && !isWeekly && !isMakeup) {
        throw new Error(`quest tidak dikenal: ${args.questKey}`);
      }

      // Buffs and penalty state are read before the mutation.
      const delta = await loadDelta(ctx);
      const mom = momentumFor(today, delta);
      const ironWill = mom.vit >= 10;
      const sharpInsight = mom.int >= 20 && mom.per >= 10;
      const logBefore = await db.select().from(schema.questLog);
      const penaltyActive = isPenaltyDay(logBefore, today);

      const gainFor = (base: number): number => {
        let gain = base;
        if (isDaily && ironWill) gain += Math.round(base * 0.1);
        if ((isWeekly || isMakeup) && sharpInsight) gain += 25;
        return gain;
      };

      /** Routes a gain into XP, or into the vault during Penalty Zone. */
      const routeGain = async (amount: number): Promise<void> => {
        const st = stateNums(await readState(db));
        if (!penaltyActive) {
          await writeState(db, [["xp", String(st.xp + amount)]]);
          return;
        }
        let held = st.heldXp + amount;
        let xp = st.xp;
        const logNow = await db.select().from(schema.questLog);
        if (dailyCountOn(logNow, today) >= PENALTY_QUEST_REQUIRED) {
          xp += held;
          held = 0;
        }
        await writeState(db, [
          ["xp", String(xp)],
          ["heldXp", String(held)],
        ]);
      };

      /** Reverses a gain on uncheck (user correction, not a penalty). */
      const routeRemoval = async (amount: number): Promise<void> => {
        const st = stateNums(await readState(db));
        if (penaltyActive && st.heldXp > 0) {
          const fromHeld = Math.min(st.heldXp, amount);
          await writeState(db, [
            ["heldXp", String(st.heldXp - fromHeld)],
            ["xp", String(Math.max(0, st.xp - (amount - fromHeld)))],
          ]);
          return;
        }
        await writeState(db, [
          ["xp", String(Math.max(0, st.xp - amount))],
        ]);
      };

      if (isMakeup) {
        const posts = await db.select().from(schema.syncPosts);
        const { minutes } = nowWib();
        if (args.done) {
          const breaches = computeBreaches(logBefore, posts, today, minutes);
          if (breaches.length > 0) {
            await db.insert(schema.questLog).values({
              date: today,
              questKey: "makeup",
              xp: MAKEUP_XP,
              source: "manual",
            });
            await routeGain(gainFor(MAKEUP_XP));
          }
        } else {
          const rows = logBefore
            .filter((r) => r.questKey === "makeup" && r.source === "manual")
            .sort((a, b) => b.id - a.id);
          const row = rows[0];
          if (row) {
            await db
              .delete(schema.questLog)
              .where(eq(schema.questLog.id, row.id));
            await routeRemoval(gainFor(MAKEUP_XP));
          }
        }
      } else {
        const def = isDaily
          ? DAILY_QUESTS.find((q) => q.key === args.questKey)
          : WEEKLY_QUESTS.find((q) => q.key === args.questKey);
        if (!def) throw new Error(`quest tidak dikenal: ${args.questKey}`);

        // Target date: today for daily; the slot's weekday this week for weekly.
        let targetDate = today;
        if (isWeekly && "dow" in def) {
          const monday = mondayOf(today);
          targetDate = addDays(monday, (def.dow + 6) % 7);
        }

        const existing = await db
          .select()
          .from(schema.questLog)
          .where(
            and(
              eq(schema.questLog.questKey, args.questKey),
              eq(schema.questLog.date, targetDate),
            ),
          );
        const row = existing[0];

        if (args.done && !row) {
          await db.insert(schema.questLog).values({
            date: targetDate,
            questKey: args.questKey,
            xp: def.xp,
            source: "manual",
          });
          // Side effects that feed the stat points.
          if (args.questKey === "research") {
            await db.insert(schema.metricEvents).values({
              date: targetDate,
              kind: "research",
              amount: 1,
            });
          } else if (args.questKey === "clip") {
            await db.insert(schema.metricEvents).values({
              date: targetDate,
              kind: "clip",
              amount: 1,
            });
          }
          await routeGain(gainFor(def.xp));
        } else if (!args.done && row && row.source === "manual") {
          await db
            .delete(schema.questLog)
            .where(eq(schema.questLog.id, row.id));
          if (args.questKey === "research") {
            const evts = await db
              .select()
              .from(schema.metricEvents)
              .where(
                and(
                  eq(schema.metricEvents.kind, "research"),
                  eq(schema.metricEvents.date, targetDate),
                ),
              );
            const evt = evts[0];
            if (evt) {
              await db
                .delete(schema.metricEvents)
                .where(eq(schema.metricEvents.id, evt.id));
            }
          }
          await routeRemoval(gainFor(def.xp));
        }
      }

      await checkTrialPromotion(ctx);
      await checkSupplyDrop(ctx);
      await storeSnapshot(ctx);
      ctx.invalidateQueries();
      return buildView(ctx);
    },
  }),

  allocateStat: defineAction({
    description:
      "Allocates one Unallocated Stat Point (earned at +3 per level from level 9 onward) to a Core Stat, permanently raising its Base Stat by 1.",
    request: z.object({
      statKey: z.enum(["STR", "AGI", "VIT", "INT", "PER"]),
    }),
    response: stateResponse,
    privileged: [privileged.fetchSheetData],
    async handler(ctx, args): Promise<StateResponse> {
      await ensurePipeline(ctx, false);
      const db = ctx.db<typeof schema>();
      const st = stateNums(await readState(db));
      if (unallocatedFor(st) <= 0) {
        throw new Error(
          "Tidak ada Unallocated Stat Point yang tersedia. Naik level mulai dari Level 9 memberi +3 poin.",
        );
      }
      const allocations = { ...st.allocations };
      allocations[args.statKey] += 1;
      await writeState(db, [["allocations", JSON.stringify(allocations)]]);
      ctx.invalidateQueries();
      return buildView(ctx);
    },
  }),

  logPerfCheck: defineAction({
    description:
      "Logs one performance check (reading dashboard insights or post analytics), which feeds the PER stat at 10 points each.",
    request: z.object({}),
    response: stateResponse,
    privileged: [privileged.fetchSheetData],
    async handler(ctx): Promise<StateResponse> {
      await ensurePipeline(ctx, false);
      const db = ctx.db<typeof schema>();
      const { dateStr: today } = nowWib();
      await db.insert(schema.metricEvents).values({
        date: today,
        kind: "perf_check",
        amount: 1,
      });
      await storeSnapshot(ctx);
      ctx.invalidateQueries();
      return buildView(ctx);
    },
  }),

  logMetric: defineAction({
    description:
      "Logs a manual metric the sheet cannot see: new followers (feeds FAME, 10 points each) or additional reach (feeds IMPACT, 1 point per reach). Amount must be a positive whole number.",
    request: z.object({
      kind: z.enum(["followers", "reach"]),
      amount: z.number().int().positive().max(1000000),
    }),
    response: stateResponse,
    privileged: [privileged.fetchSheetData],
    async handler(ctx, args): Promise<StateResponse> {
      await ensurePipeline(ctx, false);
      const db = ctx.db<typeof schema>();
      const { dateStr: today } = nowWib();
      await db.insert(schema.metricEvents).values({
        date: today,
        kind: args.kind,
        amount: args.amount,
      });
      await storeSnapshot(ctx);
      ctx.invalidateQueries();
      return buildView(ctx);
    },
  }),

  // Dashboard page actions (getDashboard, refreshDashboardData,
  // saveDashboardSnapshot, setSlotTopic) live in ./dashboard.ts. The
  // dashboard refresh is named refreshDashboardData because refreshData
  // above belongs to the tracker page.
  ...DashboardActions,

  // Draft News page actions (getDrafts, getDraftImage, decideDraft) live
  // in ./drafts.ts.
  ...DraftActions,
} satisfies ActionsModule;
