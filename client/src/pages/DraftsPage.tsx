import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "../api";

type DraftsData = ApiResponse<typeof api, "getDrafts">;
type Draft = DraftsData["drafts"][number];
type DecisionKind = "gass" | "revisi" | "skip";
type TabFilter = "all" | "waiting" | DecisionKind;

// ------------------------------------------------------------ formatting

function ageLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} mnt`;
  if (hours < 24) return `${Math.round(hours)} jam`;
  return `${Math.floor(hours / 24)} hari`;
}

function fmtWib(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = new Date(t + 7 * 60 * 60 * 1000);
  const date = `${String(s.getUTCDate()).padStart(2, "0")}/${String(
    s.getUTCMonth() + 1,
  ).padStart(2, "0")}`;
  const clock = `${String(s.getUTCHours()).padStart(2, "0")}.${String(
    s.getUTCMinutes(),
  ).padStart(2, "0")}`;
  return `${date} ${clock} WIB`;
}

function fmtCreated(dateStr: string | null): string {
  if (!dateStr) return "";
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ------------------------------------------------------------ images

function DraftImage(props: {
  contentId: string;
  kind: "cover" | "closing";
  size: "thumb" | "full";
  enabled: boolean;
  label: string;
  className?: string;
}) {
  const q = useQuery({
    queryKey: ["draft-img", props.contentId, props.kind, props.size],
    queryFn: () =>
      api.getDraftImage({
        contentId: props.contentId,
        kind: props.kind,
        size: props.size,
      }),
    enabled: props.enabled,
    staleTime: 10 * 60 * 1000,
  });
  if (q.isPending) {
    return (
      <div
        className={`flex items-center justify-center bg-[var(--space-surface-alt)] text-[11px] text-[var(--dim)] ${props.className ?? ""}`}
        aria-label={`Memuat ${props.label}`}
      >
        MEMUAT…
      </div>
    );
  }
  if (!q.data?.dataUrl) {
    return (
      <div
        className={`flex items-center justify-center bg-[var(--space-surface-alt)] px-2 text-center text-[11px] text-[var(--dim)] ${props.className ?? ""}`}
      >
        {props.label} tidak ada
      </div>
    );
  }
  return (
    <img
      src={q.data.dataUrl}
      alt={props.label}
      className={`object-cover ${props.className ?? ""}`}
      loading="lazy"
    />
  );
}

// ------------------------------------------------------------ one draft

const DECISION_LABEL: Record<DecisionKind, string> = {
  gass: "GASS UPLOAD",
  revisi: "REVISI",
  skip: "TIDAK APPROVE",
};

function DecisionBadge(props: { draft: Draft }) {
  const d = props.draft.decision;
  if (!d) return null;
  const style =
    d.decision === "gass"
      ? "border-[var(--accent)] bg-[var(--accent)] text-[#071801]"
      : d.decision === "revisi"
        ? "border-[var(--accent-2)] bg-[var(--accent-2)] text-white"
        : "border-[var(--danger)] bg-[var(--danger)] text-white";
  return (
    <div className="mt-3">
      <span
        className={`inline-block border px-2 py-1 text-[11px] font-bold ${style}`}
      >
        KEPUTUSAN: {DECISION_LABEL[d.decision]}
      </span>
      <span className="ml-2 text-[11px] text-[var(--dim)]">
        {fmtWib(d.decidedAt)}
      </span>
      {d.note ? (
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
          Catatan revisi: {d.note}
        </p>
      ) : null}
    </div>
  );
}

function DraftCard(props: { draft: Draft }) {
  const { draft } = props;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [revisiOpen, setRevisiOpen] = useState(false);
  const [note, setNote] = useState(draft.decision?.note ?? "");

  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => {
    if (savedAt === 0) return;
    const t = setTimeout(() => setSavedAt(0), 6000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const decide = useMutation({
    mutationFn: async (args: { decision: DecisionKind; note?: string }) =>
      await api.decideDraft({
        contentId: draft.contentId,
        decision: args.decision,
        note: args.note,
        title: draft.title,
      }),
    onSuccess: () => {
      setRevisiOpen(false);
      setSavedAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      void queryClient.invalidateQueries({ queryKey: ["gass-history"] });
    },
  });

  const active = draft.decision?.decision;
  const btnBase =
    "flex-1 border px-2 py-2.5 text-[11px] font-bold tracking-wide disabled:opacity-50";
  const btnStyle = (kind: DecisionKind) => {
    if (active === kind) {
      return kind === "gass"
        ? "border-[var(--accent)] bg-[var(--accent)] text-[#071801]"
        : kind === "revisi"
          ? "border-[var(--accent-2)] bg-[var(--accent-2)] text-white"
          : "border-[var(--danger)] bg-[var(--danger)] text-white";
    }
    return kind === "gass"
      ? "border-[var(--accent)] text-[var(--accent)]"
      : kind === "revisi"
        ? "border-[var(--accent-2)] text-white"
        : "border-[var(--danger)] text-[var(--danger)]";
  };

  return (
    <article className="pixel-frame bg-[var(--surface)] px-3 py-3">
      <div className="flex gap-3">
        <DraftImage
          contentId={draft.contentId}
          kind="cover"
          size="thumb"
          enabled={draft.hasCover}
          label={`Cover ${draft.title || draft.contentId}`}
          className="aspect-[4/5] w-24 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug text-[var(--text)]">
            {draft.title || draft.contentId}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
            {draft.contentId} · {draft.genre}
            {draft.created ? ` · dibuat ${fmtCreated(draft.created)}` : ""}
            <br />
            menunggu {ageLabel(draft.ageHours)} · masuk antrean{" "}
            {fmtWib(draft.notifiedAt)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {draft.hasVideo ? (
              <span className="border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--dim)]">
                ADA VIDEO
              </span>
            ) : null}
            {!draft.hasClosing ? (
              <span className="border border-[var(--warn)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--warn)]">
                TANPA PENUTUP
              </span>
            ) : null}
          </div>
          <DecisionBadge draft={draft} />
        </div>
      </div>

      {/* caption */}
      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <p
          className={`whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)] ${
            open ? "" : "line-clamp-3"
          }`}
        >
          {draft.caption || "(caption kosong)"}
        </p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-2 text-xs font-bold text-[var(--accent)]"
        >
          {open ? "TUTUP PAKET" : "LIHAT PAKET LENGKAP (COVER + PENUTUP)"}
        </button>
        {open ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <figure>
              <DraftImage
                contentId={draft.contentId}
                kind="cover"
                size="full"
                enabled={draft.hasCover}
                label={`Cover ${draft.title || draft.contentId}`}
                className="aspect-[4/5] w-full"
              />
              <figcaption className="mt-1 text-center text-[11px] text-[var(--dim)]">
                COVER
              </figcaption>
            </figure>
            <figure>
              <DraftImage
                contentId={draft.contentId}
                kind="closing"
                size="full"
                enabled={draft.hasClosing}
                label={`Slide penutup ${draft.title || draft.contentId}`}
                className="aspect-[4/5] w-full"
              />
              <figcaption className="mt-1 text-center text-[11px] text-[var(--dim)]">
                PENUTUP
              </figcaption>
            </figure>
          </div>
        ) : null}
        {open && draft.note ? (
          <p className="mt-3 border border-[var(--border)] px-2.5 py-2 text-xs leading-relaxed text-[var(--dim)]">
            Catatan scan: {draft.note}
          </p>
        ) : null}
      </div>

      {/* decisions */}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={decide.isPending || active === "gass"}
          onClick={() => {
            // Repeat-tap guard: an already-recorded decision never fires
            // the mutation again (the server also treats it as a no-op).
            if (active !== "gass") decide.mutate({ decision: "gass" });
          }}
          aria-label={
            active === "gass"
              ? `Sudah di-gass ${draft.title || draft.contentId}`
              : `Gass upload ${draft.title || draft.contentId}`
          }
          className={`${btnBase} ${btnStyle("gass")}`}
        >
          {decide.isPending && decide.variables?.decision === "gass"
            ? "MENYIMPAN…"
            : active === "gass"
              ? "SUDAH DI-GASS ✓"
              : "GASS UPLOAD"}
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => {
            setNote(draft.decision?.note ?? "");
            setRevisiOpen((v) => !v);
          }}
          aria-label={`Minta revisi ${draft.title || draft.contentId}`}
          className={`${btnBase} ${btnStyle("revisi")}`}
        >
          REVISI
        </button>
        <button
          type="button"
          disabled={decide.isPending || active === "skip"}
          onClick={() => {
            if (active !== "skip") decide.mutate({ decision: "skip" });
          }}
          aria-label={
            active === "skip"
              ? `Sudah tidak approve ${draft.title || draft.contentId}`
              : `Tidak approve ${draft.title || draft.contentId}`
          }
          className={`${btnBase} ${btnStyle("skip")}`}
        >
          {decide.isPending && decide.variables?.decision === "skip"
            ? "MENYIMPAN…"
            : active === "skip"
              ? "SUDAH TIDAK APPROVE ✓"
              : "TIDAK APPROVE"}
        </button>
      </div>
      {savedAt > 0 ? (
        <p role="status" className="mt-2 text-xs font-bold text-[var(--accent)]">
          ✓ Keputusan tersimpan
          {decide.data?.alreadyRecorded
            ? " — keputusan ini memang sudah tercatat sebelumnya, tidak didobel."
            : draft.decision
              ? `: ${DECISION_LABEL[draft.decision.decision]}.`
              : "."}
        </p>
      ) : null}
      {revisiOpen ? (
        <div className="mt-2">
          <label
            htmlFor={`revisi-note-${draft.contentId}`}
            className="text-xs font-semibold text-[var(--text)]"
          >
            Yang perlu direvisi
          </label>
          <textarea
            id={`revisi-note-${draft.contentId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Contoh: headline diganti, cover kurang kontras, angka di caption dicek lagi…"
            className="mt-1 w-full border border-[var(--accent-2)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: "revisi", note })}
              className="flex-1 border border-[var(--accent-2)] bg-[var(--accent-2)] px-2 py-2 text-[11px] font-bold text-white disabled:opacity-50"
            >
              {decide.isPending ? "MENYIMPAN…" : "SIMPAN KEPUTUSAN REVISI"}
            </button>
            <button
              type="button"
              onClick={() => setRevisiOpen(false)}
              className="border border-[var(--border)] px-3 py-2 text-[11px] font-bold text-[var(--dim)]"
            >
              BATAL
            </button>
          </div>
        </div>
      ) : null}
      {decide.isError ? (
        <p className="mt-2 text-xs text-[var(--danger)]">
          Keputusan gagal disimpan. Coba lagi.
        </p>
      ) : null}
    </article>
  );
}

// ------------------------------------------------------------ GASS history

type GassHistoryData = ApiResponse<typeof api, "getGassHistory">;
type HistoryEntry = GassHistoryData["entries"][number];

const HISTORY_STATUS: Record<
  HistoryEntry["status"],
  { label: string; style: string }
> = {
  queued: {
    label: "MASIH DI ANTREAN",
    style: "border-[var(--warn)] text-[var(--warn)]",
  },
  posted: {
    label: "SUDAH TAYANG",
    style: "border-[var(--accent)] text-[var(--accent)]",
  },
  gone: {
    label: "TIDAK LAGI DI ANTREAN",
    style: "border-[var(--border)] text-[var(--dim)]",
  },
};

function HistoryRow(props: { entry: HistoryEntry }) {
  const { entry } = props;
  const status = HISTORY_STATUS[entry.status];
  const [open, setOpen] = useState(false);
  // The package (cover, closing, caption) stays in the content bank even
  // after the post airs, so a history row can still be read in full.
  const pkg = useQuery({
    queryKey: ["history-package", entry.contentId],
    queryFn: () => api.getHistoryPackage({ contentId: entry.contentId }),
    enabled: open,
    staleTime: 10 * 60 * 1000,
  });
  return (
    <article className="pixel-frame bg-[var(--surface)] px-3 py-3">
      <h3 className="text-sm font-semibold leading-snug text-[var(--text)]">
        {entry.title || entry.contentId}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
        {entry.contentId} · di-GASS {fmtWib(entry.decidedAt)} ·{" "}
        {entry.source === "hub" ? "lewat Hub ini" : "lewat chat NEWS"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="border border-[var(--accent)] bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-bold text-[#071801]">
          GASS UPLOAD
        </span>
        <span
          className={`border px-1.5 py-0.5 text-[10px] font-semibold ${status.style}`}
        >
          {status.label}
        </span>
        {entry.postUrl ? (
          <a
            href={entry.postUrl}
            target="_blank"
            rel="noreferrer"
            className="border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)] underline"
          >
            LIHAT POSTINGAN
          </a>
        ) : null}
      </div>

      {/* read the package back: cover + closing + caption */}
      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={
            open
              ? `Tutup paket ${entry.title || entry.contentId}`
              : `Baca paket ${entry.title || entry.contentId}`
          }
          className="text-xs font-bold text-[var(--accent)]"
        >
          {open ? "TUTUP PAKET" : "BACA PAKET (COVER + PENUTUP + CAPTION)"}
        </button>
        {open ? (
          pkg.isPending ? (
            <p className="mt-3 text-xs text-[var(--dim)]">Memuat paket…</p>
          ) : pkg.isError || !pkg.data?.found ? (
            <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
              Paket berita ini tidak ditemukan lagi di content bank, jadi
              cover dan caption-nya tidak bisa ditampilkan.
            </p>
          ) : (
            <>
              <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">
                {pkg.data.caption || "(caption kosong)"}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <figure>
                  <DraftImage
                    contentId={entry.contentId}
                    kind="cover"
                    size="full"
                    enabled={pkg.data.hasCover}
                    label={`Cover ${entry.title || entry.contentId}`}
                    className="aspect-[4/5] w-full"
                  />
                  <figcaption className="mt-1 text-center text-[11px] text-[var(--dim)]">
                    COVER
                  </figcaption>
                </figure>
                <figure>
                  <DraftImage
                    contentId={entry.contentId}
                    kind="closing"
                    size="full"
                    enabled={pkg.data.hasClosing}
                    label={`Slide penutup ${entry.title || entry.contentId}`}
                    className="aspect-[4/5] w-full"
                  />
                  <figcaption className="mt-1 text-center text-[11px] text-[var(--dim)]">
                    PENUTUP
                  </figcaption>
                </figure>
              </div>
            </>
          )
        ) : null}
      </div>
    </article>
  );
}

// ------------------------------------------------------------ the page

const PAGE_SIZE = 20;

export function DraftsPage() {
  const drafts = useQuery({
    queryKey: ["drafts"],
    queryFn: () => api.getDrafts({}),
    refetchInterval: 60_000,
  });
  const history = useQuery({
    queryKey: ["gass-history"],
    queryFn: () => api.getGassHistory({}),
    refetchInterval: 60_000,
  });
  const [tab, setTab] = useState<TabFilter>("waiting");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [tab, sort, search]);

  const data = drafts.data;
  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const list = data.drafts.filter((d) => {
      if (tab === "waiting" && d.decision !== null) return false;
      if (
        (tab === "revisi" || tab === "skip") &&
        d.decision?.decision !== tab
      )
        return false;
      if (tab === "gass") return false; // the GASS tab renders history instead
      if (
        q !== "" &&
        !d.title.toLowerCase().includes(q) &&
        !d.contentId.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
    // Server order is newest first; "oldest" = longest waiting first.
    return sort === "oldest" ? [...list].reverse() : list;
  }, [data, tab, sort, search]);

  // The GASS tab is a true history: every gass decision ever recorded
  // (Hub + chat approvals), newest first — not a filter over the queue.
  const historyFiltered = useMemo(() => {
    const entries = history.data?.entries ?? [];
    const q = search.trim().toLowerCase();
    const list =
      q === ""
        ? entries
        : entries.filter(
            (e) =>
              e.title.toLowerCase().includes(q) ||
              e.contentId.toLowerCase().includes(q),
          );
    return sort === "oldest" ? [...list].reverse() : list;
  }, [history.data, sort, search]);

  const chips: Array<{ id: TabFilter; label: string; count?: number }> = [
    { id: "waiting", label: "MENUNGGU", count: data?.counts.waiting },
    { id: "all", label: "SEMUA", count: data?.counts.total },
    { id: "gass", label: "HISTORI GASS", count: history.data?.entries.length },
    { id: "revisi", label: "REVISI", count: data?.counts.revisi },
    { id: "skip", label: "TIDAK APPROVE", count: data?.counts.skip },
  ];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-4">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h1 className="font-pixel text-[13px] text-[var(--accent)]">
            DRAFT NEWS
          </h1>
          <button
            type="button"
            onClick={() => void drafts.refetch()}
            disabled={drafts.isFetching}
            className="shrink-0 bg-[var(--accent)] px-3 py-2 text-xs font-bold text-[#071801] disabled:opacity-50"
            aria-label="Muat ulang daftar draft dari antrean"
          >
            {drafts.isFetching ? "MEMUAT…" : "MUAT ULANG"}
          </button>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-[var(--dim)]">
          News hasil scanning yang menunggu keputusan
          {data
            ? ` · ${data.counts.waiting} menunggu dari ${data.counts.total} draft · data per ${fmtWib(data.fetchedAt)}`
            : ""}
          . Tombol di tiap draft mencatat keputusanmu; upload dan
          penjadwalannya berjalan lewat script setelah tahap ini. Draft
          yang sudah diputuskan tetap tampil di tab SEMUA dengan badge
          keputusannya; tab MENUNGGU hanya menampilkan yang belum
          diputuskan. Berita yang sudah tayang keluar dari antrean ini
          dan pindah ke tab HISTORI GASS, lengkap dengan status tayang,
          tautan postingannya, dan tombol BACA PAKET untuk membuka lagi
          cover, penutup, dan caption-nya. Tab HISTORI GASS menyimpan
          semua keputusan gass yang pernah kamu buat, termasuk
          persetujuan lama lewat chat NEWS.
        </p>

        {drafts.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">
            Memuat draft…
          </p>
        ) : drafts.isError ? (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--danger)]">Draft gagal dimuat.</p>
            <button
              type="button"
              onClick={() => void drafts.refetch()}
              className="mt-3 border border-[var(--border)] px-4 py-2 text-sm"
            >
              Coba lagi
            </button>
          </div>
        ) : data && data.counts.total === 0 && tab !== "gass" ? (
          <div className="pixel-frame bg-[var(--surface)] px-4 py-8 text-center">
            <p className="font-pixel text-[13px] text-[var(--accent)]">
              ANTREAN KOSONG
            </p>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
              Tidak ada news hasil scanning yang menunggu keputusan saat ini.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setTab(c.id)}
                  aria-pressed={tab === c.id}
                  className={`border px-2.5 py-1.5 text-[11px] font-bold ${
                    tab === c.id
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[#071801]"
                      : "border-[var(--border)] text-[var(--dim)]"
                  }`}
                >
                  {c.label}
                  {c.count != null ? ` (${c.count})` : ""}
                </button>
              ))}
            </div>
            <div className="mb-4 flex gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari judul atau ID…"
                aria-label="Cari draft berdasarkan judul atau ID"
                className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
              />
              <button
                type="button"
                onClick={() =>
                  setSort((s) => (s === "oldest" ? "newest" : "oldest"))
                }
                aria-label={
                  sort === "newest"
                    ? "Urutan sekarang: terbaru ke terlama. Ketuk untuk ubah ke terlama ke terbaru"
                    : "Urutan sekarang: terlama ke terbaru. Ketuk untuk ubah ke terbaru ke terlama"
                }
                aria-pressed={sort === "newest"}
                className="shrink-0 border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--dim)]"
              >
                {sort === "newest"
                  ? "URUTAN: TERBARU → TERLAMA"
                  : "URUTAN: TERLAMA → TERBARU"}
              </button>
            </div>

            {tab === "gass" ? (
              history.isPending ? (
                <p className="py-10 text-center text-sm text-[var(--dim)]">
                  Memuat histori GASS…
                </p>
              ) : history.isError ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-[var(--danger)]">
                    Histori GASS gagal dimuat.
                  </p>
                  <button
                    type="button"
                    onClick={() => void history.refetch()}
                    className="mt-3 border border-[var(--border)] px-4 py-2 text-sm"
                  >
                    Coba lagi
                  </button>
                </div>
              ) : historyFiltered.length === 0 ? (
                <div className="pixel-frame bg-[var(--surface)] px-4 py-8 text-center">
                  <p className="font-pixel text-[13px] text-[var(--accent)]">
                    BELUM ADA HISTORI GASS
                  </p>
                  <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
                    Belum ada keputusan GASS UPLOAD yang tercatat, baik dari
                    Hub ini maupun dari chat NEWS. Begitu ada, catatannya
                    tetap tersimpan di sini walau draft-nya sudah tayang
                    atau keluar dari antrean.
                  </p>
                </div>
              ) : (
                <>
                  <p className="mb-3 text-xs leading-relaxed text-[var(--dim)]">
                    Semua keputusan GASS UPLOAD yang pernah tercatat, dari
                    yang terbaru: keputusan dari Hub ini dan persetujuan
                    lama lewat chat NEWS, lengkap dengan statusnya sekarang.
                    Ketuk BACA PAKET di tiap baris untuk membuka lagi cover,
                    penutup, dan caption beritanya, termasuk yang sudah
                    tayang.
                  </p>
                  <div className="flex flex-col gap-3">
                    {historyFiltered.slice(0, visible).map((e) => (
                      <HistoryRow key={e.key} entry={e} />
                    ))}
                  </div>
                  {visible < historyFiltered.length ? (
                    <button
                      type="button"
                      onClick={() => setVisible((v) => v + PAGE_SIZE)}
                      className="mt-4 w-full border border-[var(--border)] py-3 text-xs font-bold text-[var(--accent)]"
                    >
                      TAMPILKAN LEBIH BANYAK ({historyFiltered.length - visible}{" "}
                      lagi)
                    </button>
                  ) : null}
                </>
              )
            ) : filtered.length === 0 ? (
              <p className="py-10 text-center text-sm text-[var(--dim)]">
                Tidak ada draft yang cocok dengan filter ini.
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-4">
                  {filtered.slice(0, visible).map((d) => (
                    <DraftCard key={d.contentId} draft={d} />
                  ))}
                </div>
                {visible < filtered.length ? (
                  <button
                    type="button"
                    onClick={() => setVisible((v) => v + PAGE_SIZE)}
                    className="mt-4 w-full border border-[var(--border)] py-3 text-xs font-bold text-[var(--accent)]"
                  >
                    TAMPILKAN LEBIH BANYAK ({filtered.length - visible}{" "}
                    lagi)
                  </button>
                ) : null}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
