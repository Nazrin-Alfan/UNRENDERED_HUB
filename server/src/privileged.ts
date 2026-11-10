// Tracker Grind-ku — host-side privileged functions.
//
// fetchSheetData reads the user's MASTER_POST_LOG Google Sheet through the
// Google Workspace CLI and the local UNRENDERED files that act as the
// live-time quest sources of truth: the content-bank INDEX.json (posts),
// approval_log.json (approval-widget decisions), tracker_opens.json
// (opens of this tracker page itself, appended by appendTrackerOpen),
// the three daily idea logs (research), and the two clipper Instagram
// accounts via instagram-cli (clip uploads). All are sources the sandboxed
// action runtime cannot reach directly, so the work happens here on the
// host and only plain data crosses back. Every local read is fail-soft:
// a missing file simply means "no evidence" for that quest.

import { execFile } from "node:child_process";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const execFileAsync = promisify(execFile);

export const privileged = definePrivilegedContracts({
  fetchSheetData: {
    request: z.object({ spreadsheetId: z.string() }),
    response: z.object({
      sheetValues: z.array(z.array(z.string())),
      sheetError: z.string().nullable(),
      indexEntries: z.array(
        z.object({
          id: z.string(),
          genre: z.string(),
          status: z.string(),
          postedAt: z.string().nullable(),
        }),
      ),
      approvalDates: z.array(z.string()),
      trackerOpenDates: z.array(z.string()),
      researchDates: z.array(z.string()),
      igPostDates: z.array(z.string()),
      fetchedAt: z.string(),
    }),
    timeoutMs: 90000,
  },
  appendTrackerOpen: {
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
    timeoutMs: 30000,
  },
  // Dashboard page (merged from dashboard-unrendered): same direct read of
  // the MASTER_POST_LOG sheet, plus the dashboard's richer INDEX fields
  // (title/postUrl), news_pending.json, and the @unrender_media profile.
  fetchLiveSources: {
    request: z.object({ spreadsheetId: z.string() }),
    response: z.object({
      sheetValues: z.array(z.array(z.string())),
      sheetError: z.string().nullable(),
      indexEntries: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          genre: z.string(),
          status: z.string(),
          postedAt: z.string().nullable(),
          postUrl: z.string().nullable(),
        }),
      ),
      pendingEntries: z.array(
        z.object({
          contentId: z.string(),
          status: z.string(),
          notifiedAt: z.string().nullable(),
        }),
      ),
      followers: z.number().nullable(),
      igPostCount: z.number().nullable(),
      fetchedAt: z.string(),
    }),
    timeoutMs: 90000,
  },
  // Draft News page: the scanned-news approval queue (news_pending.json
  // entries still awaiting_user) joined with their content-bank packages:
  // title, caption text, cover and closing slide file names.
  fetchDraftPackages: {
    request: z.object({}),
    response: z.object({
      drafts: z.array(
        z.object({
          contentId: z.string(),
          title: z.string(),
          genre: z.string(),
          created: z.string().nullable(),
          notifiedAt: z.string().nullable(),
          caption: z.string(),
          coverFile: z.string().nullable(),
          closingFile: z.string().nullable(),
          hasVideo: z.boolean(),
          note: z.string().nullable(),
        }),
      ),
      fetchedAt: z.string(),
    }),
    timeoutMs: 60000,
  },
  // Lightweight draft references for the no-card upload pipeline: the
  // still-queued drafts (awaiting_user, not already posted) with only
  // contentId / title / folder — no caption text is read from disk, so a
  // scheduled poller can call this every few minutes cheaply.
  fetchDraftRefs: {
    request: z.object({}),
    response: z.object({
      drafts: z.array(
        z.object({
          contentId: z.string(),
          title: z.string(),
          folder: z.string(),
        }),
      ),
      fetchedAt: z.string(),
    }),
    timeoutMs: 30000,
  },
  // Draft News page, GASS history: the full approval-widget log
  // (approval_log.json) so past chat approvals can be shown as history
  // with a "chat" source label next to decisions recorded in the Hub.
  fetchApprovalLog: {
    request: z.object({}),
    response: z.object({
      entries: z.array(
        z.object({
          contentId: z.string(),
          title: z.string(),
          decision: z.string(),
          date: z.string(),
          time: z.string().nullable(),
        }),
      ),
      fetchedAt: z.string(),
    }),
    timeoutMs: 30000,
  },
  // Live posted truth from INDEX.json (status "posted" + post_url): the
  // upload script updates INDEX the moment a post airs, while the
  // dash_posted_log table only refreshes on dashboard syncs — the GASS
  // history reads this so a freshly aired post shows SUDAH TAYANG with
  // its link immediately instead of lingering as "tidak lagi di antrean".
  fetchPostedIndex: {
    request: z.object({}),
    response: z.object({
      posts: z.array(
        z.object({
          contentId: z.string(),
          title: z.string(),
          postUrl: z.string().nullable(),
          postedAt: z.string().nullable(),
        }),
      ),
      fetchedAt: z.string(),
    }),
    timeoutMs: 30000,
  },
  // Resolve ONE content-bank package by content id straight from
  // INDEX.json — no news_pending membership and no posted exclusion, so
  // the GASS history can still open the cover/caption of a post that
  // already aired and left the queue (packages are never moved on disk).
  fetchPackageById: {
    request: z.object({ contentId: z.string() }),
    response: z.object({
      found: z.boolean(),
      caption: z.string(),
      coverFile: z.string().nullable(),
      closingFile: z.string().nullable(),
      hasVideo: z.boolean(),
    }),
    timeoutMs: 30000,
  },
  // One package image (cover or closing slide) downscaled to a JPEG data
  // URL with GraphicsMagick, so the client never pulls the full-size PNG.
  readDraftImage: {
    request: z.object({
      contentId: z.string(),
      kind: z.enum(["cover", "closing"]),
      maxWidth: z.number(),
    }),
    response: z.object({ dataUrl: z.string().nullable() }),
    timeoutMs: 30000,
  },
});

const GWS_CLI = "/opt/hatch/bin/hatch_gws_cli";
const IG_CLI = "/opt/hatch/bin/instagram-cli";
const INDEX_PATH = "/home/hatch/workspace/unrendered/content-bank/INDEX.json";
const APPROVAL_LOG_PATH = "/home/hatch/workspace/unrendered/approval_log.json";
const TRACKER_OPENS_PATH = "/home/hatch/workspace/unrendered/tracker_opens.json";
const IDEA_LOG_PATHS = [
  "/home/hatch/workspace/goals/unrendered-gaming-media/hidden_files/opini-ideas-log.md",
  "/home/hatch/workspace/goals/unrendered-gaming-media/hidden_files/bedah-ideas-log.md",
  "/home/hatch/workspace/goals/unrendered-gaming-media/hidden_files/tierlist-ideas-log.md",
];
const PENDING_PATH = "/home/hatch/workspace/unrendered/news_pending.json";
const CONTENT_BANK_DIR = "/home/hatch/workspace/unrendered/content-bank";
const GM_CLI = "/usr/bin/gm";
const CLIP_ACCOUNTS = [
  { accountId: "17841445204547067", username: "clipactivedaily" },
  { accountId: "17841423877866047", username: "santadailyclip" },
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function fetchSheet(spreadsheetId: string): Promise<{
  values: string[][];
  error: string | null;
}> {
  try {
    const params = JSON.stringify({
      spreadsheetId,
      range: "MASTER_POST_LOG!A1:Z2000",
    });
    const { stdout } = await execFileAsync(
      GWS_CLI,
      ["sheets", "spreadsheets", "values", "get", "--params", params],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
    );
    const parsed = JSON.parse(stdout) as { values?: unknown };
    const raw = Array.isArray(parsed.values) ? parsed.values : [];
    const values = raw.map((row) =>
      Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [],
    );
    return { values, error: null };
  } catch (e) {
    return {
      values: [],
      error:
        e instanceof Error ? e.message.slice(0, 300) : "sheet read failed",
    };
  }
}

async function readIndexEntries(): Promise<
  Array<{
    id: string;
    genre: string;
    status: string;
    postedAt: string | null;
  }>
> {
  try {
    const raw = JSON.parse(await readFile(INDEX_PATH, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null,
      )
      .map((e) => ({
        id:
          typeof e.id === "string"
            ? e.id
            : typeof e.content_id === "string"
              ? e.content_id
              : "",
        genre: typeof e.genre === "string" ? e.genre : "",
        status: typeof e.status === "string" ? e.status : "",
        postedAt: typeof e.posted_at === "string" ? e.posted_at : null,
      }))
      .filter((e) => e.id !== "");
  } catch {
    return [];
  }
}

/** Dates (YYYY-MM-DD, WIB) with at least one approval-widget decision. */
async function readApprovalDates(): Promise<string[]> {
  try {
    const raw = JSON.parse(
      await readFile(APPROVAL_LOG_PATH, "utf8"),
    ) as unknown;
    const entries: unknown[] = Array.isArray(raw)
      ? raw
      : typeof raw === "object" && raw !== null
        ? ((raw as Record<string, unknown>).entries as unknown[] | undefined) ??
          []
        : [];
    const dates = new Set<string>();
    for (const e of entries) {
      if (typeof e !== "object" || e === null) continue;
      const d = (e as Record<string, unknown>).date;
      if (typeof d === "string" && DATE_RE.test(d)) dates.add(d);
    }
    return [...dates].sort();
  } catch {
    return [];
  }
}

/** Minutes-padded chronological stamp in Asia/Jakarta (WIB). */
function wibStamp(): { date: string; time: string } {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date()).map((p) => [p.type, p.value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const hour = parts.hour === "24" ? "00" : parts.hour;
    return { date, time: `${hour}:${parts.minute}` };
  } catch {
    const s = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      date: `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`,
      time: `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`,
    };
  }
}

/**
 * Dates on which the tracker page itself was opened. The trail is written
 * by appendTrackerOpen below (one entry per getState call); opening the
 * separate UNRENDERED dashboard does NOT count as a performance check.
 */
async function readTrackerOpenDates(): Promise<string[]> {
  try {
    const raw = JSON.parse(
      await readFile(TRACKER_OPENS_PATH, "utf8"),
    ) as unknown;
    if (!Array.isArray(raw)) return [];
    const dates = new Set<string>();
    for (const e of raw) {
      if (typeof e !== "object" || e === null) continue;
      const d = (e as Record<string, unknown>).date;
      if (typeof d === "string" && DATE_RE.test(d)) dates.add(d);
    }
    return [...dates].sort();
  } catch {
    return [];
  }
}

/** Dates with a new entry in any of the three daily idea logs. */
async function readResearchDates(): Promise<string[]> {
  const dates = new Set<string>();
  for (const path of IDEA_LOG_PATHS) {
    try {
      const text = await readFile(path, "utf8");
      for (const line of text.split("\n")) {
        const m = /^\s*-\s*(\d{4}-\d{2}-\d{2})\b/.exec(line);
        if (m?.[1]) dates.add(m[1]);
      }
    } catch {
      // a missing log simply contributes no dates
    }
  }
  return [...dates].sort();
}

/**
 * WIB dates on which the two clipper Instagram accounts published media.
 * instagram-cli returns posts newest-first with UTC `created_at`
 * timestamps; they are shifted +7h to WIB calendar dates.
 */
async function fetchIgPostDates(): Promise<string[]> {
  const dates = new Set<string>();
  await Promise.all(
    CLIP_ACCOUNTS.map(async (acct) => {
      try {
        const { stdout } = await execFileAsync(
          IG_CLI,
          [
            "posts",
            "--account-id",
            acct.accountId,
            "--username",
            acct.username,
          ],
          { maxBuffer: 16 * 1024 * 1024, timeout: 45_000 },
        );
        const parsed = JSON.parse(stdout) as {
          posts?: Array<{ created_at?: unknown }>;
        };
        for (const p of parsed.posts ?? []) {
          if (typeof p.created_at !== "string") continue;
          const t = Date.parse(`${p.created_at.replace(" ", "T")}Z`);
          if (!Number.isFinite(t)) continue;
          const wib = new Date(t + 7 * 60 * 60 * 1000);
          const date = `${wib.getUTCFullYear()}-${String(wib.getUTCMonth() + 1).padStart(2, "0")}-${String(wib.getUTCDate()).padStart(2, "0")}`;
          dates.add(date);
        }
      } catch {
        // an unreachable account contributes no dates
      }
    }),
  );
  return [...dates].sort().reverse().slice(0, 60);
}

/** INDEX.json entries with the extra fields the dashboard page needs. */
async function readDashboardIndexEntries(): Promise<
  Array<{
    id: string;
    title: string;
    genre: string;
    status: string;
    postedAt: string | null;
    postUrl: string | null;
  }>
> {
  try {
    const raw = JSON.parse(await readFile(INDEX_PATH, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null,
      )
      .map((e) => ({
        id:
          typeof e.id === "string"
            ? e.id
            : typeof e.content_id === "string"
              ? e.content_id
              : "",
        title: typeof e.title === "string" ? e.title : "",
        genre: typeof e.genre === "string" ? e.genre : "",
        status: typeof e.status === "string" ? e.status : "",
        postedAt: typeof e.posted_at === "string" ? e.posted_at : null,
        postUrl: typeof e.post_url === "string" ? e.post_url : null,
      }))
      .filter((e) => e.id !== "");
  } catch {
    return [];
  }
}

async function readPendingEntries(): Promise<
  Array<{ contentId: string; status: string; notifiedAt: string | null }>
> {
  try {
    const raw = JSON.parse(await readFile(PENDING_PATH, "utf8")) as {
      pending?: unknown;
    };
    const arr = Array.isArray(raw.pending) ? raw.pending : [];
    return arr
      .filter(
        (e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null,
      )
      .map((e) => ({
        contentId: typeof e.content_id === "string" ? e.content_id : "",
        status: typeof e.status === "string" ? e.status : "",
        notifiedAt: typeof e.notified_at === "string" ? e.notified_at : null,
      }))
      .filter((e) => e.contentId !== "");
  } catch {
    return [];
  }
}

async function fetchDashboardInstagram(): Promise<{
  followers: number | null;
  igPostCount: number | null;
}> {
  try {
    const { stdout } = await execFileAsync(
      IG_CLI,
      [
        "profile",
        "--username",
        "unrender_media",
        "--account-id",
        "17841454349922454",
      ],
      { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
    );
    const parsed = JSON.parse(stdout) as {
      profiles?: Array<{
        follower_count?: unknown;
        post_count?: unknown;
      }>;
    };
    const profile = parsed.profiles?.[0];
    return {
      followers:
        typeof profile?.follower_count === "number"
          ? profile.follower_count
          : null,
      igPostCount:
        typeof profile?.post_count === "number" ? profile.post_count : null,
    };
  } catch {
    return { followers: null, igPostCount: null };
  }
}

// ------------------------------------------------------- Draft News page

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** Folder and file names inside the content bank are single path segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type DraftPackage = {
  contentId: string;
  title: string;
  genre: string;
  folder: string;
  created: string | null;
  notifiedAt: string | null;
  caption: string;
  coverFile: string | null;
  closingFile: string | null;
  hasVideo: boolean;
  note: string | null;
};

type FullIndexEntry = {
  id: string;
  title: string;
  genre: string;
  status: string;
  folder: string;
  files: string[] | null;
  captionFile: string | null;
  captionInline: string | null;
  created: string | null;
};

/** INDEX.json entries with every field the Draft page needs. */
async function readFullIndexEntries(): Promise<Map<string, FullIndexEntry>> {
  const map = new Map<string, FullIndexEntry>();
  try {
    const raw = JSON.parse(await readFile(INDEX_PATH, "utf8")) as unknown;
    if (!Array.isArray(raw)) return map;
    for (const e of raw) {
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      const id =
        typeof r.id === "string"
          ? r.id
          : typeof r.content_id === "string"
            ? r.content_id
            : "";
      if (id === "" || map.has(id)) continue;
      map.set(id, {
        id,
        title: typeof r.title === "string" ? r.title : "",
        genre: typeof r.genre === "string" ? r.genre : "",
        status: typeof r.status === "string" ? r.status : "",
        folder: typeof r.folder === "string" ? r.folder : "",
        files: Array.isArray(r.files)
          ? r.files.filter((f): f is string => typeof f === "string")
          : null,
        captionFile: typeof r.caption_file === "string" ? r.caption_file : null,
        captionInline:
          typeof r.caption === "string" && r.caption.trim() !== ""
            ? r.caption
            : null,
        created:
          typeof r.created === "string"
            ? r.created
            : typeof r.date === "string"
              ? r.date
              : null,
      });
    }
  } catch {
    // an unreadable index simply yields no packages
  }
  return map;
}

async function readPendingRaw(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = JSON.parse(await readFile(PENDING_PATH, "utf8")) as {
      pending?: unknown;
    };
    return Array.isArray(raw.pending)
      ? raw.pending.filter(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null,
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Pick the slide image for one slot from a package's file names: the 4:5
 * upload variant wins, then files named "cover"/"final". The closing slot
 * only considers files named "closing"; the cover slot excludes them.
 */
function pickDraftFile(names: string[], kind: "cover" | "closing"): string | null {
  const images = names.filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()));
  const pool =
    kind === "closing"
      ? images.filter((f) => f.toLowerCase().includes("closing"))
      : images.filter((f) => !f.toLowerCase().includes("closing"));
  if (pool.length === 0) return null;
  const score = (f: string) =>
    (f.includes("4x5") ? 4 : 0) +
    (f.toLowerCase().includes("cover") ? 2 : 0) +
    (f.toLowerCase().includes("final") ? 1 : 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Resolve one queue item to its on-disk package (fail-soft per field). */
async function resolveDraftPackage(
  pending: Record<string, unknown>,
  index: Map<string, FullIndexEntry>,
): Promise<DraftPackage | null> {
  const contentId =
    typeof pending.content_id === "string" ? pending.content_id : "";
  if (contentId === "") return null;
  const entry = index.get(contentId);
  // A package the index already marks as aired is never shown as a draft,
  // even if the pending file still lists it as awaiting approval.
  if (entry?.status === "posted") return null;

  const folderRaw =
    entry?.folder ||
    (typeof pending.folder === "string" ? pending.folder : "");
  const folder = SAFE_SEGMENT.test(folderRaw) ? folderRaw : "";
  const dir = folder !== "" ? join(CONTENT_BANK_DIR, folder) : null;

  let names: string[] = entry?.files ?? [];
  if (names.length === 0 && dir) {
    names = await readdir(dir).catch(() => [] as string[]);
  }

  let caption = entry?.captionInline ?? "";
  if (caption === "" && dir) {
    const capName =
      entry?.captionFile && SAFE_SEGMENT.test(entry.captionFile)
        ? entry.captionFile
        : "caption.txt";
    caption = await readFile(join(dir, capName), "utf8").catch(() => "");
  }

  return {
    contentId,
    title: entry?.title ?? "",
    genre: entry?.genre || "NEWS",
    folder,
    created: entry?.created ?? null,
    notifiedAt:
      typeof pending.notified_at === "string" ? pending.notified_at : null,
    caption: caption.trim(),
    coverFile: pickDraftFile(names, "cover"),
    closingFile: pickDraftFile(names, "closing"),
    hasVideo: names.some((f) => f.toLowerCase().endsWith(".mp4")),
    note: typeof pending.note === "string" ? pending.note : null,
  };
}

/**
 * Resolve a package straight from its INDEX entry — used for posts that
 * already aired (or otherwise left the queue): the folder and files stay
 * in the content bank forever, only the queue membership ends.
 */
async function resolvePackageFromIndexEntry(entry: FullIndexEntry): Promise<{
  folder: string;
  caption: string;
  coverFile: string | null;
  closingFile: string | null;
  hasVideo: boolean;
}> {
  const folder = SAFE_SEGMENT.test(entry.folder) ? entry.folder : "";
  const dir = folder !== "" ? join(CONTENT_BANK_DIR, folder) : null;

  let names: string[] = entry.files ?? [];
  if (names.length === 0 && dir) {
    names = await readdir(dir).catch(() => [] as string[]);
  }

  let caption = entry.captionInline ?? "";
  if (caption === "" && dir) {
    const capName =
      entry.captionFile && SAFE_SEGMENT.test(entry.captionFile)
        ? entry.captionFile
        : "caption.txt";
    caption = await readFile(join(dir, capName), "utf8").catch(() => "");
  }

  return {
    folder,
    caption: caption.trim(),
    coverFile: pickDraftFile(names, "cover"),
    closingFile: pickDraftFile(names, "closing"),
    hasVideo: names.some((f) => f.toLowerCase().endsWith(".mp4")),
  };
}

async function fetchAllDraftPackages(): Promise<DraftPackage[]> {
  const [pending, index] = await Promise.all([
    readPendingRaw(),
    readFullIndexEntries(),
  ]);
  const seen = new Set<string>();
  const drafts: DraftPackage[] = [];
  for (const p of pending) {
    if (p.status !== "awaiting_user") continue;
    const cid = typeof p.content_id === "string" ? p.content_id : "";
    if (cid === "" || seen.has(cid)) continue;
    seen.add(cid);
    const pkg = await resolveDraftPackage(p, index);
    if (pkg) drafts.push(pkg);
  }
  return drafts;
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async fetchSheetData(args) {
    const [
      sheet,
      indexEntries,
      approvalDates,
      trackerOpenDates,
      researchDates,
      igPostDates,
    ] = await Promise.all([
      fetchSheet(args.spreadsheetId),
      readIndexEntries(),
      readApprovalDates(),
      readTrackerOpenDates(),
      readResearchDates(),
      fetchIgPostDates(),
    ]);
    return {
      sheetValues: sheet.values,
      sheetError: sheet.error,
      indexEntries,
      approvalDates,
      trackerOpenDates,
      researchDates,
      igPostDates,
      fetchedAt: new Date().toISOString(),
    };
  },

  async appendTrackerOpen() {
    // Append-only trail: read the existing list, push one entry per call,
    // never delete older entries. Read failures start from an empty list.
    let entries: unknown[] = [];
    try {
      const raw = JSON.parse(
        await readFile(TRACKER_OPENS_PATH, "utf8"),
      ) as unknown;
      if (Array.isArray(raw)) entries = raw;
    } catch {
      entries = []; // file does not exist yet (or is unreadable JSON)
    }
    const { date, time } = wibStamp();
    entries.push({ date, time, source: "tracker_open" });
    await writeFile(
      TRACKER_OPENS_PATH,
      `${JSON.stringify(entries, null, 2)}\n`,
      "utf8",
    );
    return { ok: true };
  },

  async fetchLiveSources(args) {
    const [sheet, indexEntries, pendingEntries, ig] = await Promise.all([
      fetchSheet(args.spreadsheetId),
      readDashboardIndexEntries(),
      readPendingEntries(),
      fetchDashboardInstagram(),
    ]);
    return {
      sheetValues: sheet.values,
      sheetError: sheet.error,
      indexEntries,
      pendingEntries,
      followers: ig.followers,
      igPostCount: ig.igPostCount,
      fetchedAt: new Date().toISOString(),
    };
  },

  async fetchDraftPackages() {
    const drafts = await fetchAllDraftPackages();
    return {
      drafts: drafts.map((d) => ({
        contentId: d.contentId,
        title: d.title,
        genre: d.genre,
        created: d.created,
        notifiedAt: d.notifiedAt,
        caption: d.caption,
        coverFile: d.coverFile,
        closingFile: d.closingFile,
        hasVideo: d.hasVideo,
        note: d.note,
      })),
      fetchedAt: new Date().toISOString(),
    };
  },

  async fetchDraftRefs() {
    // Same queue + posted guard as fetchAllDraftPackages, but metadata
    // only: INDEX.json title/folder, no caption.txt reads, no directory
    // listings. Drafts whose INDEX status is already "posted" are left
    // out, mirroring resolveDraftPackage.
    const [pending, index] = await Promise.all([
      readPendingRaw(),
      readFullIndexEntries(),
    ]);
    const seen = new Set<string>();
    const drafts: Array<{ contentId: string; title: string; folder: string }> =
      [];
    for (const p of pending) {
      if (p.status !== "awaiting_user") continue;
      const contentId = typeof p.content_id === "string" ? p.content_id : "";
      if (contentId === "" || seen.has(contentId)) continue;
      seen.add(contentId);
      const entry = index.get(contentId);
      if (entry?.status === "posted") continue;
      const folderRaw =
        entry?.folder || (typeof p.folder === "string" ? p.folder : "");
      drafts.push({
        contentId,
        title: entry?.title ?? "",
        folder: SAFE_SEGMENT.test(folderRaw) ? folderRaw : "",
      });
    }
    return { drafts, fetchedAt: new Date().toISOString() };
  },

  async fetchApprovalLog() {
    const entries: Array<{
      contentId: string;
      title: string;
      decision: string;
      date: string;
      time: string | null;
    }> = [];
    try {
      const raw = JSON.parse(
        await readFile(APPROVAL_LOG_PATH, "utf8"),
      ) as unknown;
      const list: unknown[] = Array.isArray(raw)
        ? raw
        : typeof raw === "object" && raw !== null
          ? ((raw as Record<string, unknown>).entries as
              | unknown[]
              | undefined) ?? []
          : [];
      for (const e of list) {
        if (typeof e !== "object" || e === null) continue;
        const r = e as Record<string, unknown>;
        const contentId =
          typeof r.content_id === "string" ? r.content_id : "";
        const date = typeof r.date === "string" ? r.date : "";
        if (contentId === "" || !DATE_RE.test(date)) continue;
        entries.push({
          contentId,
          title: typeof r.title === "string" ? r.title : "",
          decision: typeof r.decision === "string" ? r.decision : "",
          date,
          time: typeof r.time === "string" ? r.time : null,
        });
      }
    } catch {
      // a missing/unreadable log simply means no chat history
    }
    return { entries, fetchedAt: new Date().toISOString() };
  },

  async fetchPostedIndex() {
    const entries = await readDashboardIndexEntries();
    return {
      posts: entries
        .filter((e) => e.status === "posted")
        .map((e) => ({
          contentId: e.id,
          title: e.title,
          postUrl: e.postUrl,
          postedAt: e.postedAt,
        })),
      fetchedAt: new Date().toISOString(),
    };
  },

  async fetchPackageById(args) {
    const index = await readFullIndexEntries();
    const entry = index.get(args.contentId);
    if (!entry) {
      return {
        found: false,
        caption: "",
        coverFile: null,
        closingFile: null,
        hasVideo: false,
      };
    }
    const pkg = await resolvePackageFromIndexEntry(entry);
    return {
      found: true,
      caption: pkg.caption,
      coverFile: pkg.coverFile,
      closingFile: pkg.closingFile,
      hasVideo: pkg.hasVideo,
    };
  },

  async readDraftImage(args) {
    try {
      const [pending, index] = await Promise.all([
        readPendingRaw(),
        readFullIndexEntries(),
      ]);
      const p = pending.find((e) => e.content_id === args.contentId);
      // Queue path first; when the draft already aired it leaves the
      // queue (and resolveDraftPackage excludes posted entries), so fall
      // back to resolving the package straight from its INDEX entry —
      // the GASS history reads covers of aired posts through this path.
      let resolved: { folder: string; coverFile: string | null; closingFile: string | null } | null =
        p ? await resolveDraftPackage(p, index) : null;
      if (!resolved) {
        const entry = index.get(args.contentId);
        if (entry) resolved = await resolvePackageFromIndexEntry(entry);
      }
      if (!resolved || resolved.folder === "") return { dataUrl: null };
      const pkg = resolved;
      const file = args.kind === "cover" ? pkg.coverFile : pkg.closingFile;
      if (!file || basename(file) !== file) return { dataUrl: null };
      const width = Math.min(1600, Math.max(200, Math.round(args.maxWidth)));
      const src = join(CONTENT_BANK_DIR, pkg.folder, file);
      const tmp = join(
        tmpdir(),
        `hub-draft-${args.contentId}-${args.kind}-${width}.jpg`,
      );
      try {
        await execFileAsync(
          GM_CLI,
          ["convert", src, "-resize", `${width}x>`, "-quality", "84", tmp],
          { timeout: 25_000 },
        );
        const bytes = await readFile(tmp);
        return {
          dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        };
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
    } catch {
      return { dataUrl: null };
    }
  },
});
