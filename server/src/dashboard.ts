// Dashboard UNRENDERED — server actions for the Dashboard page of
// UNRENDERED Hub (merged from the standalone dashboard-unrendered artifact
// on 2026-11-07; logic and behavior are unchanged).
//
// Data flow (DIRECT connection, single retrieval path):
//   The dashboard reads its sources directly through the privileged host
//   function fetchLiveSources (server/src/privileged.ts): the Google Sheet
//   MASTER_POST_LOG is read live via the Google Workspace CLI, alongside
//   content-bank INDEX.json, news_pending.json, and the Instagram profile.
//   syncFromSheet -> calls fetchLiveSources, parses the sheet rows and the
//                    local files, and replaces the dash_* snapshot tables
//                    (never touches dash_slot_choices, the user's picks).
//   getDashboard  -> syncs directly from the sheet first when the stored
//                    snapshot is missing or older than 15 minutes, then
//                    computes the dashboard view in Asia/Jakarta (WIB).
//   refreshDashboardData -> forces an immediate direct sync (the PERBARUI
//                    DATA button and the daily 07.43 schedule call this;
//                    named differently from the tracker's refreshData).
//   saveDashboardSnapshot -> compatibility action; validates + replaces
//                    the snapshot tables when handed a gathered payload.
//   setSlotTopic  -> user records/clears the chosen topic for one slot.

import { defineAction, z, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

const DASH_SPREADSHEET_ID = "10W8xWifcMMPycmwo6VUzsFMsqoDHtXtKqJaDWn4eIrU";
/** Re-read the sheet directly when the stored snapshot is older than this. */
const DASH_SYNC_MAX_AGE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- helpers

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Current wall-clock parts in Asia/Jakarta. */
function dashNowWib(): { dateStr: string; minutes: number; epochMs: number } {
  const shifted = new Date(Date.now() + WIB_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return {
    dateStr: `${y}-${m}-${d}`,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    epochMs: Date.now(),
  };
}

function dashParseIsoMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function dashMsToIso(ms: number): string {
  return new Date(ms).toISOString();
}

const DASH_DAY_MS = 24 * 60 * 60 * 1000;

function dashAddDays(dateStr: string, days: number): string {
  const [y = 1970, mo = 1, d = 1] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** 0=Sunday .. 6=Saturday for a YYYY-MM-DD date (timezone-free). */
function dashWeekdayOf(dateStr: string): number {
  const [y = 1970, mo = 1, d = 1] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

const DASH_EDITORIAL_GENRES = ["OPINI", "BEDAH", "TIER LIST", "SATIRE"];
const DASH_ROTATION = ["OPINI", "BEDAH", "TIER LIST"];

// ------------------------------------------------- direct sheet syncing

type DashLiveSources = {
  sheetValues: string[][];
  sheetError: string | null;
  indexEntries: Array<{
    id: string;
    title: string;
    genre: string;
    status: string;
    postedAt: string | null;
    postUrl: string | null;
  }>;
  pendingEntries: Array<{
    contentId: string;
    status: string;
    notifiedAt: string | null;
  }>;
  followers: number | null;
  igPostCount: number | null;
  fetchedAt: string;
};

/** Indonesian-formatted integer ('1.234' -> 1234); empty cell -> null. */
function dashParseIdInt(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Indonesian percent ('5,4%' -> 5.4); empty cell -> null. */
function dashParseIdPct(raw: string | undefined): number | null {
  const s = (raw ?? "").trim().replace("%", "").trim();
  if (!s) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * INDEX.json posted_at comes in mixed formats: ISO with +07:00 offset, or
 * '2026-10-18 19:13 WIB'. Normalize both to ISO 8601 with +07:00.
 */
function dashNormalizePostedAt(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes("T")) {
    return Number.isNaN(Date.parse(s)) ? null : s;
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ ](\d{2}):(\d{2})/);
  if (m) return `${m[1]}T${m[2]}:${m[3]}:00+07:00`;
  const d = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (d) return `${d[1]}T00:00:00+07:00`;
  const t = Date.parse(s.replace(" WIB", " +07:00"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Reads every source directly (sheet + local files + Instagram) through the
 * privileged host function and replaces the snapshot tables. Returns counts,
 * or an error when the sheet itself could not be read (existing data is
 * left untouched in that case).
 */
async function syncDashboardFromSheet(
  ctx: Ctx,
): Promise<
  | { ok: true; posts: number; posted: number; queue: number; syncedAt: string }
  | { ok: false; error: string }
> {
  let live: DashLiveSources;
  try {
    live = await ctx.executePrivileged(privileged.fetchLiveSources, {
      spreadsheetId: DASH_SPREADSHEET_ID,
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 300) : "koneksi ke sheet gagal",
    };
  }
  if (live.sheetError || live.sheetValues.length === 0) {
    return {
      ok: false,
      error: live.sheetError ?? "sheet MASTER_POST_LOG kosong atau tidak terbaca",
    };
  }

  const indexById = new Map(live.indexEntries.map((e) => [e.id, e]));

  // Sheet rows -> posts. Columns: A Content_ID, B Tanggal_Post, C Jam_Post,
  // D Genre, E Format_Visual, F Judul_Hook, H Reach, J Likes, K Comments,
  // L Shares, M Saves, N Profile_Visits, O Follows_Gained, P Total_Engagement,
  // Q ER_by_Reach, V Headline_Tier, W Kategori_News, X Topik.
  const posts: Array<typeof schema.dashPosts.$inferInsert> = [];
  const seen = new Set<string>();
  for (const row of live.sheetValues.slice(1)) {
    const contentId = (row[0] ?? "").trim();
    const date = (row[1] ?? "").trim();
    if (!contentId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(contentId)) {
      continue;
    }
    seen.add(contentId);
    posts.push({
      contentId,
      date,
      time: (row[2] ?? "").trim(),
      genre: (row[3] ?? "").trim(),
      format: (row[4] ?? "").trim(),
      title: (row[5] ?? "").trim(),
      reach: dashParseIdInt(row[7]),
      likes: dashParseIdInt(row[9]),
      comments: dashParseIdInt(row[10]),
      shares: dashParseIdInt(row[11]),
      saves: dashParseIdInt(row[12]),
      profileVisits: dashParseIdInt(row[13]),
      follows: dashParseIdInt(row[14]),
      engagement: dashParseIdInt(row[15]),
      erPct: dashParseIdPct(row[16]),
      tier: (row[21] ?? "").trim(),
      category: (row[22] ?? "").trim(),
      topic: (row[23] ?? "").trim(),
      postUrl: indexById.get(contentId)?.postUrl ?? null,
    });
  }

  // INDEX posted entries -> aired log. When INDEX has no usable posted_at
  // (missing, or a free-text note), fall back to the sheet's own
  // Tanggal_Post + Jam_Post for that Content_ID — also real source data.
  const sheetTimeById = new Map(posts.map((p) => [p.contentId, p]));
  const posted: Array<typeof schema.dashPostedLog.$inferInsert> = [];
  for (const e of live.indexEntries) {
    if (e.status !== "posted") continue;
    let postedAt = e.postedAt ? dashNormalizePostedAt(e.postedAt) : null;
    if (!postedAt) {
      const sheetRow = sheetTimeById.get(e.id);
      if (sheetRow) {
        const rawTime = sheetRow.time ?? "";
        const t = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : "00:00";
        postedAt = `${sheetRow.date}T${t}:00+07:00`;
      }
    }
    if (!postedAt) continue;
    posted.push({
      contentId: e.id,
      title: e.title,
      genre: e.genre,
      postedAt,
      postUrl: e.postUrl,
    });
  }

  // news_pending awaiting_user -> approval queue (aired items excluded).
  const postedIds = new Set(posted.map((p) => p.contentId));
  const queue: Array<typeof schema.dashQueueItems.$inferInsert> = [];
  for (const p of live.pendingEntries) {
    if (p.status !== "awaiting_user" || !p.notifiedAt) continue;
    if (postedIds.has(p.contentId)) continue;
    const idx = indexById.get(p.contentId);
    queue.push({
      contentId: p.contentId,
      title: idx?.title ?? "",
      genre: idx?.genre ?? "NEWS",
      notifiedAt: p.notifiedAt,
    });
  }

  // Instagram numbers: keep the last known values when the profile read
  // fails, instead of wiping them to null.
  const db = ctx.db<typeof schema>();
  const prevStats = await db.select().from(schema.dashAccountStats);
  const prev = prevStats[0];

  await db.delete(schema.dashPosts);
  await db.delete(schema.dashPostedLog);
  await db.delete(schema.dashQueueItems);
  await db.delete(schema.dashAccountStats);
  await db.delete(schema.dashSyncState);
  if (posts.length) await db.insert(schema.dashPosts).values(posts);
  if (posted.length) await db.insert(schema.dashPostedLog).values(posted);
  if (queue.length) await db.insert(schema.dashQueueItems).values(queue);
  await db.insert(schema.dashAccountStats).values({
    id: 1,
    followers: live.followers ?? prev?.followers ?? null,
    igPostCount: live.igPostCount ?? prev?.igPostCount ?? null,
    updatedAt: live.fetchedAt,
  });
  await db
    .insert(schema.dashSyncState)
    .values({ id: 1, lastSyncAt: live.fetchedAt });
  return {
    ok: true,
    posts: posts.length,
    posted: posted.length,
    queue: queue.length,
    syncedAt: live.fetchedAt,
  };
}

// ---------------------------------------------------------------- schemas

const dashMetricPost = z.object({
  contentId: z.string(),
  title: z.string(),
  genre: z.string(),
  date: z.string(),
  time: z.string(),
  reach: z.number().nullable(),
  likes: z.number().nullable(),
  comments: z.number().nullable(),
  shares: z.number().nullable(),
  saves: z.number().nullable(),
  follows: z.number().nullable(),
  erPct: z.number().nullable(),
  postUrl: z.string().nullable(),
});

const dashQueueItemView = z.object({
  contentId: z.string(),
  title: z.string(),
  genre: z.string(),
  notifiedAt: z.string(),
  ageHours: z.number(),
  bucket: z.enum(["segar", "hampir_basi", "basi"]),
});

const dashboardResponse = z.object({
  syncedAt: z.string().nullable(),
  account: z.object({
    followers: z.number().nullable(),
    igPostCount: z.number().nullable(),
  }),
  today: z.object({
    dateStr: z.string(),
    postedCount: z.number(),
    cap: z.number(),
    remaining: z.number(),
    posts: z.array(
      z.object({
        contentId: z.string(),
        title: z.string(),
        genre: z.string(),
        time: z.string(),
        postUrl: z.string().nullable(),
      }),
    ),
    lastPostAt: z.string().nullable(),
    lastPostLabel: z.string().nullable(),
    safeNow: z.boolean(),
    nextSafeFrom: z.string().nullable(),
    nextSafeTo: z.string().nullable(),
  }),
  queue: z.object({
    actionable: z.array(dashQueueItemView),
    freshCount: z.number(),
    staleSoonCount: z.number(),
    totalWaiting: z.number(),
  }),
  stale: z.object({
    count: z.number(),
    items: z.array(dashQueueItemView),
  }),
  performance: z.object({
    loggedPosts: z.number(),
    postedCount: z.number(),
    reachFilled: z.number(),
    topContent: z.array(dashMetricPost),
    recentContent: z.array(dashMetricPost),
    genreStats: z.array(
      z.object({
        genre: z.string(),
        posts: z.number(),
        avgReach: z.number().nullable(),
        avgEr: z.number().nullable(),
      }),
    ),
  }),
  slots: z.array(
    z.object({
      date: z.string(),
      weekday: z.string(),
      status: z.enum(["tayang", "terpilih", "menunggu"]),
      topic: z.string().nullable(),
      suggestedGenre: z.string(),
      postedTitle: z.string().nullable(),
      postedGenre: z.string().nullable(),
      isPast: z.boolean(),
    }),
  ),
});

type DashboardResponse = z.infer<typeof dashboardResponse>;

const dashRefreshResponse = z.object({
  ok: z.boolean(),
  syncedAt: z.string().nullable(),
  posts: z.number(),
  posted: z.number(),
  queue: z.number(),
  error: z.string().nullable(),
});

// ---------------------------------------------------------------- actions

export const DashboardActions = {
  getDashboard: defineAction({
    description:
      "Returns the full UNRENDERED dashboard view (Dashboard page of UNRENDERED Hub): today's posting slots, approval queue with staleness, performance metrics, and editorial calendar slots. Reads the MASTER_POST_LOG sheet directly first when the stored snapshot is missing or stale (older than 15 minutes).",
    request: z.object({}),
    response: dashboardResponse,
    privileged: [privileged.fetchLiveSources],
    async handler(ctx): Promise<DashboardResponse> {
      // Direct connection: if there is no snapshot yet, or it is older than
      // 15 minutes, read the sheet (and the other sources) right now, in
      // this request, before computing the view. A failed read falls back
      // to whatever is stored rather than failing the dashboard.
      {
        const probeDb = ctx.db<typeof schema>();
        const [syncProbe, postProbe] = await Promise.all([
          probeDb.select().from(schema.dashSyncState),
          probeDb.select({ id: schema.dashPosts.contentId }).from(schema.dashPosts).limit(1),
        ]);
        const lastSync = syncProbe[0]?.lastSyncAt ?? null;
        const lastMs = lastSync ? Date.parse(lastSync) : NaN;
        const stale =
          postProbe.length === 0 ||
          Number.isNaN(lastMs) ||
          Date.now() - lastMs > DASH_SYNC_MAX_AGE_MS;
        if (stale) {
          await syncDashboardFromSheet(ctx).catch(() => null);
        }
      }
      const db = ctx.db<typeof schema>();
      const [postRows, postedRows, queueRows, statsRows, syncRows, choiceRows] =
        await Promise.all([
          db.select().from(schema.dashPosts),
          db.select().from(schema.dashPostedLog).orderBy(asc(schema.dashPostedLog.postedAt)),
          db.select().from(schema.dashQueueItems),
          db.select().from(schema.dashAccountStats),
          db.select().from(schema.dashSyncState),
          db.select().from(schema.dashSlotChoices),
        ]);

      const { dateStr: todayStr, epochMs: nowMs } = dashNowWib();

      // ---- Hari ini ------------------------------------------------------
      const postedSorted = [...postedRows].sort(
        (a, b) => dashParseIsoMs(a.postedAt) - dashParseIsoMs(b.postedAt),
      );
      const todayPosts = postedSorted.filter(
        (p) => new Date(dashParseIsoMs(p.postedAt) + WIB_OFFSET_MS).toISOString().slice(0, 10) === todayStr,
      );
      const lastPosted = postedSorted[postedSorted.length - 1];
      const lastMs = lastPosted ? dashParseIsoMs(lastPosted.postedAt) : 0;
      const cap = 3;
      const remaining = Math.max(0, cap - todayPosts.length);

      let safeNow = true;
      let nextSafeFrom: string | null = null;
      let nextSafeTo: string | null = null;
      if (remaining === 0) {
        safeNow = false;
      } else if (todayPosts.length > 0 && lastPosted) {
        const from = lastMs + 2 * 60 * 60 * 1000;
        const to = lastMs + 3 * 60 * 60 * 1000;
        if (nowMs < from) {
          safeNow = false;
          nextSafeFrom = dashMsToIso(from);
          nextSafeTo = dashMsToIso(to);
        }
      }

      const fmtWibTime = (ms: number) => {
        const s = new Date(ms + WIB_OFFSET_MS);
        return `${String(s.getUTCHours()).padStart(2, "0")}.${String(s.getUTCMinutes()).padStart(2, "0")}`;
      };
      const lastPostLabel = lastPosted
        ? `${lastPosted.contentId} · ${new Date(lastMs + WIB_OFFSET_MS).toISOString().slice(0, 10)} ${fmtWibTime(lastMs)} WIB`
        : null;

      // ---- Antrean + basi -------------------------------------------------
      // Guard: a package that already aired (posted log) is never actionable,
      // even if the pending file still lists it as awaiting approval.
      const postedIds = new Set(postedRows.map((p) => p.contentId));
      const queueViews = queueRows
        .filter((q) => !postedIds.has(q.contentId))
        .map((q) => {
          const ageHours = Math.max(
            0,
            (nowMs - dashParseIsoMs(q.notifiedAt)) / (60 * 60 * 1000),
          );
          const bucket =
            ageHours > 24 ? "basi" : ageHours >= 12 ? "hampir_basi" : "segar";
          return {
            contentId: q.contentId,
            title: q.title,
            genre: q.genre,
            notifiedAt: q.notifiedAt,
            ageHours: Math.round(ageHours * 10) / 10,
            bucket,
          } as z.infer<typeof dashQueueItemView>;
        })
        .sort((a, b) => dashParseIsoMs(b.notifiedAt) - dashParseIsoMs(a.notifiedAt));

      const actionable = queueViews
        .filter((q) => q.bucket !== "basi")
        .sort((a, b) => {
          const rank = (v: z.infer<typeof dashQueueItemView>) =>
            v.bucket === "hampir_basi" ? 0 : 1;
          const r = rank(a) - rank(b);
          return r !== 0 ? r : dashParseIsoMs(b.notifiedAt) - dashParseIsoMs(a.notifiedAt);
        })
        .slice(0, 20);

      const staleItems = queueViews.filter((q) => q.bucket === "basi");

      // ---- Performa -------------------------------------------------------
      const toMetric = (
        p: typeof postRows[number],
      ): z.infer<typeof dashMetricPost> => ({
        contentId: p.contentId,
        title: p.title,
        genre: p.genre,
        date: p.date,
        time: p.time,
        reach: p.reach,
        likes: p.likes,
        comments: p.comments,
        shares: p.shares,
        saves: p.saves,
        follows: p.follows,
        erPct: p.erPct,
        postUrl: p.postUrl,
      });

      const withReach = postRows.filter((p) => p.reach != null);
      const topContent = [...withReach]
        .sort((a, b) => (b.reach ?? 0) - (a.reach ?? 0))
        .slice(0, 8)
        .map(toMetric);
      const recentContent = [...postRows]
        .sort((a, b) =>
          a.date === b.date
            ? b.time.localeCompare(a.time)
            : b.date.localeCompare(a.date),
        )
        .slice(0, 10)
        .map(toMetric);

      const genreMap = new Map<
        string,
        { posts: number; reachSum: number; reachN: number; erSum: number; erN: number }
      >();
      for (const p of postRows) {
        const g = p.genre || "LAINNYA";
        const e = genreMap.get(g) ?? {
          posts: 0,
          reachSum: 0,
          reachN: 0,
          erSum: 0,
          erN: 0,
        };
        e.posts += 1;
        if (p.reach != null) {
          e.reachSum += p.reach;
          e.reachN += 1;
        }
        if (p.erPct != null) {
          e.erSum += p.erPct;
          e.erN += 1;
        }
        genreMap.set(g, e);
      }
      const genreStats = [...genreMap.entries()]
        .map(([genre, e]) => ({
          genre,
          posts: e.posts,
          avgReach: e.reachN ? Math.round((e.reachSum / e.reachN) * 10) / 10 : null,
          avgEr: e.erN ? Math.round((e.erSum / e.erN) * 10) / 10 : null,
        }))
        .sort((a, b) => b.posts - a.posts);

      // ---- Kalender editorial --------------------------------------------
      const choiceMap = new Map(choiceRows.map((c) => [c.slotDate, c.topic]));
      const postedByDate = new Map<string, typeof postedRows[number]>();
      for (const p of postedSorted) {
        const d = new Date(dashParseIsoMs(p.postedAt) + WIB_OFFSET_MS)
          .toISOString()
          .slice(0, 10);
        if (DASH_EDITORIAL_GENRES.includes(p.genre)) postedByDate.set(d, p);
      }
      // Rotation anchor: 2026-11-03 was a Tuesday OPINI slot (opini-004 aired).
      const anchorMs = Date.UTC(2026, 10, 3);
      const slotDates: string[] = [];
      for (let back = 14; back >= -35 && slotDates.length < 10; back--) {
        const d = dashAddDays(todayStr, -back);
        const wd = dashWeekdayOf(d);
        if (wd === 2 || wd === 6) slotDates.push(d);
      }
      slotDates.sort();
      const slots = slotDates.map((d) => {
        const [y = 1970, mo = 1, dd = 1] = d.split("-").map(Number);
        const weeks = Math.floor((Date.UTC(y, mo - 1, dd) - anchorMs) / (7 * DASH_DAY_MS));
        const half = dashWeekdayOf(d) === 6 ? 1 : 0;
        const idx = ((weeks * 2 + half) % DASH_ROTATION.length + DASH_ROTATION.length) % DASH_ROTATION.length;
        const aired = postedByDate.get(d);
        const chosen = choiceMap.get(d) ?? null;
        return {
          date: d,
          weekday: dashWeekdayOf(d) === 2 ? "Selasa" : "Sabtu",
          status: (aired ? "tayang" : chosen ? "terpilih" : "menunggu") as
            | "tayang"
            | "terpilih"
            | "menunggu",
          topic: aired ? aired.title : chosen,
          suggestedGenre: DASH_ROTATION[idx] ?? "OPINI",
          postedTitle: aired ? aired.title : null,
          postedGenre: aired ? aired.genre : null,
          isPast: d < todayStr,
        };
      });

      const stats = statsRows[0];
      const sync = syncRows[0];

      return {
        syncedAt: sync?.lastSyncAt ?? null,
        account: {
          followers: stats?.followers ?? null,
          igPostCount: stats?.igPostCount ?? null,
        },
        today: {
          dateStr: todayStr,
          postedCount: todayPosts.length,
          cap,
          remaining,
          posts: todayPosts.map((p) => {
            const ms = dashParseIsoMs(p.postedAt);
            const s = new Date(ms + WIB_OFFSET_MS);
            return {
              contentId: p.contentId,
              title: p.title,
              genre: p.genre,
              time: `${String(s.getUTCHours()).padStart(2, "0")}:${String(s.getUTCMinutes()).padStart(2, "0")}`,
              postUrl: p.postUrl,
            };
          }),
          lastPostAt: lastPosted ? dashMsToIso(lastMs) : null,
          lastPostLabel,
          safeNow,
          nextSafeFrom,
          nextSafeTo,
        },
        queue: {
          actionable,
          freshCount: queueViews.filter((q) => q.bucket === "segar").length,
          staleSoonCount: queueViews.filter((q) => q.bucket === "hampir_basi").length,
          totalWaiting: queueViews.length,
        },
        stale: { count: staleItems.length, items: staleItems.slice(0, 15) },
        performance: {
          loggedPosts: postRows.length,
          postedCount: postedRows.length,
          reachFilled: withReach.length,
          topContent,
          recentContent,
          genreStats,
        },
        slots,
      };
    },
  }),

  saveDashboardSnapshot: defineAction({
    description:
      "Saves a fresh UNRENDERED dashboard data snapshot (post metrics, aired log, approval queue, account stats) gathered from the source sheet, content bank, and Instagram profile. Replaces the previous snapshot; editorial slot choices are preserved.",
    request: z.object({
      posts: z
        .array(
          z.object({
            contentId: z.string().min(1),
            date: z.string(),
            time: z.string().default(""),
            genre: z.string().default(""),
            title: z.string().default(""),
            format: z.string().default(""),
            reach: z.number().int().nullable().default(null),
            likes: z.number().int().nullable().default(null),
            comments: z.number().int().nullable().default(null),
            shares: z.number().int().nullable().default(null),
            saves: z.number().int().nullable().default(null),
            profileVisits: z.number().int().nullable().default(null),
            follows: z.number().int().nullable().default(null),
            engagement: z.number().int().nullable().default(null),
            erPct: z.number().nullable().default(null),
            tier: z.string().default(""),
            category: z.string().default(""),
            topic: z.string().default(""),
            postUrl: z.string().nullable().default(null),
          }),
        )
        .max(800),
      posted: z
        .array(
          z.object({
            contentId: z.string().min(1),
            title: z.string().default(""),
            genre: z.string().default(""),
            postedAt: z.string(),
            postUrl: z.string().nullable().default(null),
          }),
        )
        .max(400),
      queue: z
        .array(
          z.object({
            contentId: z.string().min(1),
            title: z.string().default(""),
            genre: z.string().default("NEWS"),
            notifiedAt: z.string(),
          }),
        )
        .max(400),
      account: z.object({
        followers: z.number().int().nullable().default(null),
        igPostCount: z.number().int().nullable().default(null),
      }),
      syncedAt: z.string(),
    }),
    response: z.object({
      ok: z.literal(true),
      posts: z.number(),
      posted: z.number(),
      queue: z.number(),
    }),
    async handler(ctx, args): Promise<{ ok: true; posts: number; posted: number; queue: number }> {
      const db = ctx.db<typeof schema>();
      // A package that already aired must never re-enter the approval queue,
      // even when the pending file still lists it as awaiting approval.
      const postedIds = new Set(args.posted.map((p) => p.contentId));
      const queue = args.queue.filter((q) => !postedIds.has(q.contentId));
      await db.delete(schema.dashPosts);
      await db.delete(schema.dashPostedLog);
      await db.delete(schema.dashQueueItems);
      await db.delete(schema.dashAccountStats);
      await db.delete(schema.dashSyncState);
      if (args.posts.length) {
        await db.insert(schema.dashPosts).values(args.posts.map((p) => ({ ...p })));
      }
      if (args.posted.length) {
        await db
          .insert(schema.dashPostedLog)
          .values(args.posted.map((p) => ({ ...p })));
      }
      if (queue.length) {
        await db
          .insert(schema.dashQueueItems)
          .values(queue.map((q) => ({ ...q })));
      }
      await db.insert(schema.dashAccountStats).values({
        id: 1,
        followers: args.account.followers,
        igPostCount: args.account.igPostCount,
        updatedAt: args.syncedAt,
      });
      await db
        .insert(schema.dashSyncState)
        .values({ id: 1, lastSyncAt: args.syncedAt });
      ctx.invalidateQueries();
      return {
        ok: true,
        posts: args.posts.length,
        posted: args.posted.length,
        queue: queue.length,
      };
    },
  }),

  refreshDashboardData: defineAction({
    description:
      "Refreshes the UNRENDERED dashboard page by reading the MASTER_POST_LOG Google Sheet directly (plus content bank, approval queue, and Instagram profile) and saving the new snapshot synchronously. This is the dashboard's refresh action (the tracker page has its own refreshData); the daily 07.43 WIB schedule targets this action.",
    request: z.object({}),
    response: dashRefreshResponse,
    privileged: [privileged.fetchLiveSources],
    async handler(ctx): Promise<z.infer<typeof dashRefreshResponse>> {
      const res = await syncDashboardFromSheet(ctx);
      if (!res.ok) {
        return {
          ok: false,
          syncedAt: null,
          posts: 0,
          posted: 0,
          queue: 0,
          error: res.error,
        };
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        syncedAt: res.syncedAt,
        posts: res.posts,
        posted: res.posted,
        queue: res.queue,
        error: null,
      };
    },
  }),

  setSlotTopic: defineAction({
    description:
      "Records the user's chosen editorial topic for one Tue/Sat 19:00 slot date on the dashboard's editorial calendar; an empty topic clears the choice back to 'waiting for an idea'.",
    request: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      topic: z.string().max(300),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const topic = args.topic.trim();
      if (!topic) {
        await db
          .delete(schema.dashSlotChoices)
          .where(eq(schema.dashSlotChoices.slotDate, args.date));
      } else {
        await db
          .insert(schema.dashSlotChoices)
          .values({ slotDate: args.date, topic })
          .onConflictDoUpdate({
            target: schema.dashSlotChoices.slotDate,
            set: { topic, updatedAt: new Date() },
          });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
};
