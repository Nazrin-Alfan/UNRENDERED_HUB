// Draft News page — server actions for the DRAFT tab of UNRENDERED Hub
// (added 2026-11-10 at the user's request).
//
// Data flow (single retrieval path): the scanned-news approval queue lives
// in ~/workspace/unrendered/news_pending.json (status awaiting_user) and the
// packages (cover, closing slide, caption) in the content bank. Both are
// host files the sandboxed runtime cannot read, so getDrafts /
// getDraftImage go through the privileged host functions
// fetchDraftPackages / readDraftImage (server/src/privileged.ts).
//
// The three decision buttons (GASS UPLOAD / REVISI / TIDAK APPROVE) only
// RECORD the decision in the draft_decisions table at this stage; the
// upload + scheduling script that acts on these decisions is a later
// phase the user asked to build separately. Every decision is ALSO
// appended to draft_decision_history (never overwritten), and
// getGassHistory merges that log with the chat approvals from
// approval_log.json so the GASS tab is a true history: entries survive
// the draft leaving the queue and show whether it already aired.

import { defineAction, z } from "@hatch/space-sdk";
import { eq } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";

const draftDecisionEnum = z.enum(["gass", "revisi", "skip"]);

const draftDecisionView = z.object({
  decision: draftDecisionEnum,
  note: z.string(),
  decidedAt: z.string(), // ISO 8601
});

const draftView = z.object({
  contentId: z.string(),
  title: z.string(),
  genre: z.string(),
  created: z.string().nullable(),
  notifiedAt: z.string().nullable(),
  ageHours: z.number(),
  caption: z.string(),
  hasCover: z.boolean(),
  hasClosing: z.boolean(),
  hasVideo: z.boolean(),
  note: z.string().nullable(),
  decision: draftDecisionView.nullable(),
});

const draftsResponse = z.object({
  drafts: z.array(draftView),
  fetchedAt: z.string(),
  counts: z.object({
    total: z.number(),
    waiting: z.number(),
    gass: z.number(),
    revisi: z.number(),
    skip: z.number(),
  }),
});
type DraftsResponse = z.infer<typeof draftsResponse>;

const draftImageResponse = z.object({ dataUrl: z.string().nullable() });
type DraftImageResponse = z.infer<typeof draftImageResponse>;

const decideResponse = z.object({
  ok: z.literal(true),
  decidedAt: z.string(),
  // true when the same decision (and note) was already recorded: the call
  // was a no-op repeat (e.g. a second tap on GASS), so nothing was written.
  alreadyRecorded: z.boolean(),
});
type DecideResponse = z.infer<typeof decideResponse>;

// ------------------------------------------------- approved-draft poller

const approvedDraftView = z.object({
  contentId: z.string(),
  folder: z.string(),
  title: z.string(),
  decidedAt: z.string(), // ISO 8601, when the current "gass" decision was made
});
const approvedDraftsResponse = z.object({
  drafts: z.array(approvedDraftView),
  fetchedAt: z.string(),
});
type ApprovedDraftsResponse = z.infer<typeof approvedDraftsResponse>;

// ------------------------------------------------------------ GASS history

const gassHistoryEntry = z.object({
  key: z.string(),
  contentId: z.string(),
  title: z.string(),
  decidedAt: z.string(), // ISO 8601
  source: z.enum(["hub", "chat"]),
  status: z.enum(["queued", "posted", "gone"]),
  postUrl: z.string().nullable(),
});
const gassHistoryResponse = z.object({
  entries: z.array(gassHistoryEntry),
  fetchedAt: z.string(),
});
type GassHistoryResponse = z.infer<typeof gassHistoryResponse>;

// Package contents for one GASS-history row (the BACA PAKET view): the
// caption text plus which slides exist, resolved from the content bank
// even after the post aired and left the approval queue.
const historyPackageResponse = z.object({
  found: z.boolean(),
  caption: z.string(),
  hasCover: z.boolean(),
  hasClosing: z.boolean(),
  hasVideo: z.boolean(),
});
type HistoryPackageResponse = z.infer<typeof historyPackageResponse>;

/** WIB wall-clock (date + HH:MM) from approval_log.json → ISO with offset. */
function wibIso(date: string, time: string | null): string {
  const t = /^\d{2}:\d{2}$/.test(time ?? "") ? time : "00:00";
  return `${date}T${t}:00+07:00`;
}

/** Epoch ms for an ISO string, falling back to a WIB-midnight date string. */
function draftTs(iso: string | null, dateOnly: string | null): number {
  if (iso) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    const t = Date.parse(`${dateOnly}T00:00:00+07:00`);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

export const DraftActions = {
  getDrafts: defineAction({
    description:
      "Returns every scanned news draft still awaiting approval (Draft page of UNRENDERED Hub): title, genre, caption, cover/closing availability, waiting time, and the decision recorded in the Hub if any.",
    request: z.object({}),
    response: draftsResponse,
    privileged: [privileged.fetchDraftPackages],
    async handler(ctx): Promise<DraftsResponse> {
      const live = await ctx.executePrivileged(
        privileged.fetchDraftPackages,
        {},
      );
      const db = ctx.db<typeof schema>();
      const decisionRows = await db.select().from(schema.draftDecisions);
      const byId = new Map(decisionRows.map((r) => [r.contentId, r]));

      const now = Date.now();
      const drafts = live.drafts.map((d) => {
        const ts = draftTs(d.notifiedAt, d.created);
        const row = byId.get(d.contentId);
        return {
          contentId: d.contentId,
          title: d.title,
          genre: d.genre,
          created: d.created,
          notifiedAt: d.notifiedAt,
          ageHours:
            ts > 0 ? Math.round(((now - ts) / 3_600_000) * 10) / 10 : 0,
          caption: d.caption,
          hasCover: d.coverFile !== null,
          hasClosing: d.closingFile !== null,
          hasVideo: d.hasVideo,
          note: d.note,
          decision: row
            ? {
                decision: row.decision,
                note: row.note,
                decidedAt: row.decidedAt.toISOString(),
              }
            : null,
        };
      });
      // Newest scan first; the client can re-sort by longest waiting.
      drafts.sort(
        (a, b) =>
          draftTs(b.notifiedAt, b.created) - draftTs(a.notifiedAt, a.created),
      );

      const counts = {
        total: drafts.length,
        waiting: drafts.filter((d) => d.decision === null).length,
        gass: drafts.filter((d) => d.decision?.decision === "gass").length,
        revisi: drafts.filter((d) => d.decision?.decision === "revisi")
          .length,
        skip: drafts.filter((d) => d.decision?.decision === "skip").length,
      };
      return { drafts, fetchedAt: live.fetchedAt, counts };
    },
  }),

  getDraftImage: defineAction({
    description:
      "Returns one draft package image (cover or closing slide) as a downscaled JPEG data URL for the Draft page: size thumb for list cards, full for the package detail view.",
    request: z.object({
      contentId: z.string().min(1),
      kind: z.enum(["cover", "closing"]),
      size: z.enum(["thumb", "full"]),
    }),
    response: draftImageResponse,
    privileged: [privileged.readDraftImage],
    async handler(ctx, args): Promise<DraftImageResponse> {
      return ctx.executePrivileged(privileged.readDraftImage, {
        contentId: args.contentId,
        kind: args.kind,
        maxWidth: args.size === "thumb" ? 560 : 1080,
      });
    },
  }),

  decideDraft: defineAction({
    description:
      "Records (or changes) the user's decision on one news draft: gass = gas upload, revisi = needs revision (note carries what to fix), skip = tidak approve. Updates the current-decision row AND appends an immutable entry to the decision history (draft_decision_history) so the GASS history survives decision changes and the draft leaving the queue. Idempotent: repeating the same decision with the same note is a no-op that writes nothing and returns alreadyRecorded=true. The upload itself runs later through the upload script; this action only stores the decision.",
    request: z.object({
      contentId: z.string().min(1),
      decision: draftDecisionEnum,
      note: z.string().max(2000).optional(),
      title: z.string().max(500).optional(),
    }),
    response: decideResponse,
    async handler(ctx, args): Promise<DecideResponse> {
      const db = ctx.db<typeof schema>();
      const note = (args.note ?? "").trim();
      // Idempotency guard: re-recording the SAME decision with the SAME
      // note (a repeat tap on GASS UPLOAD after the badge already flipped)
      // must not append a second history row — the user saw the draft stay
      // in the SEMUA tab and tapped again, producing duplicate history
      // entries (news-494, 2026-11-10). A changed decision or a changed
      // revisi note is still a real new decision and is recorded.
      const [existing] = await db
        .select()
        .from(schema.draftDecisions)
        .where(eq(schema.draftDecisions.contentId, args.contentId));
      if (
        existing &&
        existing.decision === args.decision &&
        existing.note === note
      ) {
        return {
          ok: true,
          decidedAt: existing.decidedAt.toISOString(),
          alreadyRecorded: true,
        };
      }
      const decidedAt = new Date();
      await db.batch([
        db
          .insert(schema.draftDecisions)
          .values({
            contentId: args.contentId,
            decision: args.decision,
            note,
            decidedAt,
          })
          .onConflictDoUpdate({
            target: schema.draftDecisions.contentId,
            set: { decision: args.decision, note, decidedAt },
          }),
        db.insert(schema.draftDecisionHistory).values({
          contentId: args.contentId,
          title: (args.title ?? "").trim(),
          decision: args.decision,
          note,
          source: "hub",
          decidedAt,
        }),
      ]);
      return { ok: true, decidedAt: decidedAt.toISOString(), alreadyRecorded: false };
    },
  }),

  getApprovedDrafts: defineAction({
    description:
      "Lightweight poller for the scheduled no-card Instagram upload pipeline: returns ONLY the news drafts whose LATEST recorded Hub decision is still 'gass' (gas upload) — contentId, content-bank folder, title, and the decision time — with no caption text. A draft whose decision was later changed to revisi/skip drops out, and drafts that already aired (in the posted log, or no longer in the approval queue) are excluded. Read-only: it writes nothing and uploads nothing itself.",
    request: z.object({}),
    response: approvedDraftsResponse,
    privileged: [privileged.fetchDraftRefs],
    async handler(ctx): Promise<ApprovedDraftsResponse> {
      const live = await ctx.executePrivileged(privileged.fetchDraftRefs, {});
      const db = ctx.db<typeof schema>();
      const [decisionRows, postedRows] = await Promise.all([
        db.select().from(schema.draftDecisions),
        db.select({ contentId: schema.dashPostedLog.contentId }).from(schema.dashPostedLog),
      ]);

      const postedIds = new Set(postedRows.map((r) => r.contentId));
      const refById = new Map(live.drafts.map((d) => [d.contentId, d]));

      const drafts = decisionRows
        .filter((r) => r.decision === "gass")
        // Only drafts still sitting in the approval queue can be uploaded;
        // anything that left the queue (aired, dropped) is not returned.
        .filter((r) => refById.has(r.contentId))
        // Belt and braces: never hand an already-aired post to the uploader.
        .filter((r) => !postedIds.has(r.contentId))
        .map((r) => {
          const ref = refById.get(r.contentId)!;
          return {
            contentId: r.contentId,
            folder: ref.folder,
            title: ref.title || r.contentId,
            decidedAt: r.decidedAt.toISOString(),
          };
        });
      // Oldest approval first, so the uploader works the queue in order.
      drafts.sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));
      return { drafts, fetchedAt: live.fetchedAt };
    },
  }),

  getGassHistory: defineAction({
    description:
      "Returns the real GASS history for the Draft page: every 'gass upload' decision ever recorded — Hub decisions from the append-only draft_decision_history log plus past chat approvals imported from approval_log.json (source-labeled 'chat') — newest first, each with its live status: still queued, already posted (with the post URL), or no longer tracked. Posted status is read live from INDEX.json (updated by the upload script the moment a post airs), with the dash_posted_log snapshot table only as a fallback, so a freshly aired post shows as posted immediately.",
    request: z.object({}),
    response: gassHistoryResponse,
    privileged: [
      privileged.fetchDraftPackages,
      privileged.fetchApprovalLog,
      privileged.fetchPostedIndex,
    ],
    async handler(ctx): Promise<GassHistoryResponse> {
      const [live, approval, postedIndex] = await Promise.all([
        ctx.executePrivileged(privileged.fetchDraftPackages, {}),
        ctx.executePrivileged(privileged.fetchApprovalLog, {}),
        ctx.executePrivileged(privileged.fetchPostedIndex, {}),
      ]);
      const db = ctx.db<typeof schema>();
      const [historyRows, postedRows] = await Promise.all([
        db.select().from(schema.draftDecisionHistory),
        db.select().from(schema.dashPostedLog),
      ]);

      const queuedIds = new Set(live.drafts.map((d) => d.contentId));
      const queueTitle = new Map(live.drafts.map((d) => [d.contentId, d.title]));
      // Live posted truth first: INDEX.json is updated by the upload
      // script at air time, while dash_posted_log waits for a dashboard
      // sync. The snapshot row only fills gaps the live read missed.
      const postedById = new Map(
        postedRows.map((r) => [
          r.contentId,
          { title: r.title, postUrl: r.postUrl },
        ]),
      );
      for (const p of postedIndex.posts) {
        postedById.set(p.contentId, {
          title: p.title,
          postUrl: p.postUrl,
        });
      }
      const statusOf = (contentId: string) =>
        postedById.has(contentId)
          ? ("posted" as const)
          : queuedIds.has(contentId)
            ? ("queued" as const)
            : ("gone" as const);

      type Entry = z.infer<typeof gassHistoryEntry>;
      const entries: Entry[] = [];

      // Hub decisions come from the append-only history log.
      for (const r of historyRows) {
        if (r.decision !== "gass") continue;
        const posted = postedById.get(r.contentId);
        entries.push({
          key: `hub-${r.id}`,
          contentId: r.contentId,
          title:
            r.title ||
            queueTitle.get(r.contentId) ||
            posted?.title ||
            r.contentId,
          decidedAt: r.decidedAt.toISOString(),
          source: "hub",
          status: statusOf(r.contentId),
          postUrl: posted?.postUrl ?? null,
        });
      }

      // Chat approvals: approval_log.json entries decided via the NEWS
      // chat widget ("gass upload" decisions only).
      for (const e of approval.entries) {
        if (!e.decision.trim().toLowerCase().startsWith("gass")) continue;
        const posted = postedById.get(e.contentId);
        entries.push({
          key: `chat-${e.contentId}-${e.date}-${e.time ?? ""}`,
          contentId: e.contentId,
          title:
            e.title || queueTitle.get(e.contentId) || posted?.title || e.contentId,
          decidedAt: wibIso(e.date, e.time),
          source: "chat",
          status: statusOf(e.contentId),
          postUrl: posted?.postUrl ?? null,
        });
      }

      // The history shows ONE entry per berita: if a draft was gassed,
      // changed, and gassed again, only its latest gass decision is the
      // visible one (decideDraft no longer writes exact repeats, but a
      // genuine change-and-regass still leaves two log rows).
      const latestByContent = new Map<string, Entry>();
      for (const e of entries) {
        const prev = latestByContent.get(e.contentId);
        if (!prev || Date.parse(e.decidedAt) >= Date.parse(prev.decidedAt)) {
          latestByContent.set(e.contentId, e);
        }
      }
      const deduped = [...latestByContent.values()];
      deduped.sort(
        (a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt),
      );
      return { entries: deduped, fetchedAt: live.fetchedAt };
    },
  }),

  getHistoryPackage: defineAction({
    description:
      "Returns the readable package (caption text + cover/closing availability) behind one GASS-history entry, resolved from the content bank by content id — works for posts that already aired and left the approval queue, so an aired news item can still be read from its history row. The cover/closing images themselves come through getDraftImage.",
    request: z.object({ contentId: z.string().min(1) }),
    response: historyPackageResponse,
    privileged: [privileged.fetchPackageById],
    async handler(ctx, args): Promise<HistoryPackageResponse> {
      const pkg = await ctx.executePrivileged(privileged.fetchPackageById, {
        contentId: args.contentId,
      });
      return {
        found: pkg.found,
        caption: pkg.caption,
        hasCover: pkg.coverFile !== null,
        hasClosing: pkg.closingFile !== null,
        hasVideo: pkg.hasVideo,
      };
    },
  }),
};
