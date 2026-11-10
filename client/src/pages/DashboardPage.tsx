import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "../api";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type QueueItem = Dashboard["queue"]["actionable"][number];
type MetricPost = Dashboard["performance"]["topContent"][number];
type Slot = Dashboard["slots"][number];

// ------------------------------------------------------------ formatting

const numFmt = new Intl.NumberFormat("id-ID");

function fmtNum(n: number | null | undefined): string {
  return n == null ? "—" : numFmt.format(n);
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;
}

function fmtDateId(dateStr: string): string {
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtShortDate(dateStr: string): string {
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function fmtWibClock(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = new Date(t + 7 * 60 * 60 * 1000);
  return `${String(s.getUTCHours()).padStart(2, "0")}.${String(s.getUTCMinutes()).padStart(2, "0")}`;
}

function fmtSync(iso: string | null): string {
  if (!iso) return "belum pernah";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = new Date(t + 7 * 60 * 60 * 1000);
  const date = `${String(s.getUTCDate()).padStart(2, "0")}/${String(s.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${date} ${fmtWibClock(iso)} WIB`;
}

function ageLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} mnt lalu`;
  if (hours < 24) return `${Math.round(hours)} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

// ------------------------------------------------------------ small pieces

function SectionHead(props: { title: string; note?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="font-pixel text-[13px] text-[var(--accent)]">{props.title}</h2>
      {props.note ? (
        <span className="text-right text-xs text-[var(--dim)]">{props.note}</span>
      ) : null}
    </div>
  );
}

function BucketBadge(props: { bucket: QueueItem["bucket"] }) {
  if (props.bucket === "hampir_basi")
    return (
      <span className="shrink-0 border border-[var(--warn)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--warn)]">
        HAMPIR BASI
      </span>
    );
  return (
    <span className="shrink-0 border border-[var(--accent)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--accent)]">
      SEGAR
    </span>
  );
}

function QueueRow(props: { item: QueueItem; stale?: boolean }) {
  const { item } = props;
  return (
    <li className="flex items-start justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium leading-snug text-[var(--text)]">
          {item.title || item.contentId}
        </p>
        <p className="mt-0.5 text-xs text-[var(--dim)]">
          {item.contentId} · {item.genre} · siap sejak {ageLabel(item.ageHours)}
        </p>
      </div>
      {props.stale ? (
        <span className="shrink-0 border border-[var(--danger)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--danger)]">
          BASI
        </span>
      ) : (
        <BucketBadge bucket={item.bucket} />
      )}
    </li>
  );
}

function MetricRow(props: { post: MetricPost; rank?: number }) {
  const p = props.post;
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug text-[var(--text)]">
          {props.rank != null ? (
            <span className="font-pixel mr-2 text-[11px] text-[var(--accent)]">
              {props.rank}
            </span>
          ) : null}
          {p.title || p.contentId}
        </p>
        <p className="mt-0.5 text-xs text-[var(--dim)]">
          {p.genre} · {fmtShortDate(p.date)} {p.time ? `· ${p.time.replace(":", ".")}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-pixel text-[13px] text-[var(--text)]">{fmtNum(p.reach)}</p>
        <p className="mt-0.5 text-[11px] text-[var(--dim)]">
          reach · ER {fmtPct(p.erPct)} · suka {fmtNum(p.likes)} · bagikan {fmtNum(p.shares)}
        </p>
      </div>
    </>
  );
  return (
    <li className="border-b border-[var(--border)] py-2.5 last:border-b-0">
      {p.postUrl ? (
        <a
          href={p.postUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-start justify-between gap-3"
          aria-label={`Buka postingan ${p.title || p.contentId} di Instagram`}
        >
          {body}
        </a>
      ) : (
        <div className="flex items-start justify-between gap-3">{body}</div>
      )}
    </li>
  );
}

function SlotRow(props: { slot: Slot }) {
  const { slot } = props;
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (topic: string) => api.setSlotTopic({ date: slot.date, topic }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const statusChip =
    slot.status === "tayang" ? (
      <span className="border border-[var(--accent)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--accent)]">
        SUDAH TAYANG
      </span>
    ) : slot.status === "terpilih" ? (
      <span className="border border-[var(--accent-2)] px-1.5 py-0.5 text-[11px] font-semibold text-[#b794ff]">
        TOPIK TERPILIH
      </span>
    ) : (
      <span className="border border-[var(--dim)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--dim)]">
        MENUNGGU IDE
      </span>
    );

  return (
    <li className="border-b border-[var(--border)] py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--text)]">
            {slot.weekday}, {fmtShortDate(slot.date)} · 19.00 WIB
          </p>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            Rotasi saran: {slot.suggestedGenre}
            {slot.postedGenre ? ` · tayang sebagai ${slot.postedGenre}` : ""}
          </p>
          {slot.topic ? (
            <p className="mt-1.5 text-sm leading-snug text-[var(--text)]">{slot.topic}</p>
          ) : (
            <p className="mt-1.5 text-sm italic text-[var(--dim)]">
              Belum ada topik untuk slot ini.
            </p>
          )}
        </div>
        <div className="shrink-0">{statusChip}</div>
      </div>

      {slot.status !== "tayang" ? (
        editing ? (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(draft);
            }}
          >
            <input
              aria-label={`Topik slot ${slot.weekday} ${fmtShortDate(slot.date)}`}
              className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              placeholder="Tulis topik editorial…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={300}
            />
            <button
              type="submit"
              disabled={save.isPending}
              className="shrink-0 bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[#071801] disabled:opacity-50"
            >
              Simpan
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="shrink-0 border border-[var(--border)] px-3 py-2 text-sm text-[var(--dim)]"
            >
              Batal
            </button>
          </form>
        ) : (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(slot.topic ?? "");
                setEditing(true);
              }}
              className="border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text)]"
              aria-label={`${slot.status === "terpilih" ? "Ubah" : "Isi"} topik slot ${slot.weekday} ${fmtShortDate(slot.date)}`}
            >
              {slot.status === "terpilih" ? "Ubah topik" : "Isi topik"}
            </button>
            {slot.status === "terpilih" ? (
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate("")}
                className="border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--dim)] disabled:opacity-50"
                aria-label={`Kosongkan topik slot ${slot.weekday} ${fmtShortDate(slot.date)}`}
              >
                Kosongkan
              </button>
            ) : null}
          </div>
        )
      ) : null}
      {save.isError ? (
        <p className="mt-1.5 text-xs text-[var(--danger)]">Gagal menyimpan, coba lagi.</p>
      ) : null}
    </li>
  );
}

// ------------------------------------------------------------ app

export function DashboardPage() {
  const queryClient = useQueryClient();
  const dash = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard({}),
    refetchInterval: 60_000,
  });
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: () => api.refreshDashboardData({}),
    onSuccess: (r) => {
      setRefreshNote(
        r.ok
          ? `Sheet terbaca langsung: ${fmtNum(r.posts)} baris MASTER_POST_LOG, ${fmtNum(r.posted)} tayang, ${fmtNum(r.queue)} antrean. Data di bawah sudah yang terbaru.`
          : `Gagal membaca sheet langsung${r.error ? `: ${r.error}` : ""}. Data lama tetap ditampilkan.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: () =>
      setRefreshNote("Gagal membaca sheet langsung. Coba lagi sebentar lagi."),
  });

  const data = dash.data;
  const hasData = data != null && data.performance.loggedPosts + data.performance.postedCount + data.queue.totalWaiting > 0;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-4">
        {/* sync bar */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-xs text-[var(--dim)]">
            Terhubung langsung ke Google Sheet · data per{" "}
            {data ? fmtSync(data.syncedAt) : "—"} · sumber: MASTER_POST_LOG, content
            bank, @unrender_media
          </p>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="shrink-0 bg-[var(--accent)] px-3 py-2 text-xs font-bold text-[#071801] disabled:opacity-50"
            aria-label="Perbarui data dashboard langsung dari Google Sheet"
          >
            {refresh.isPending ? "MEMBACA SHEET…" : "PERBARUI DATA"}
          </button>
        </div>
        {refreshNote ? (
          <p className="mb-4 border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs leading-relaxed text-[var(--dim)]">
            {refreshNote}
          </p>
        ) : null}

        {dash.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">Memuat dashboard…</p>
        ) : dash.isError ? (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--danger)]">Dashboard gagal dimuat.</p>
            <button
              type="button"
              onClick={() => void dash.refetch()}
              className="mt-3 border border-[var(--border)] px-4 py-2 text-sm"
            >
              Coba lagi
            </button>
          </div>
        ) : data && !hasData ? (
          <div className="pixel-frame bg-[var(--surface)] px-4 py-8 text-center">
            <p className="font-pixel text-[13px] text-[var(--accent)]">BELUM ADA DATA</p>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
              Dashboard ini terhubung langsung ke Google Sheet MASTER_POST_LOG, content
              bank, dan profil Instagram. Ketuk PERBARUI DATA di atas untuk membaca
              sheet-nya sekarang.
            </p>
          </div>
        ) : data ? (
          <div className="flex flex-col gap-8">
            {/* ---------- HARI INI ---------- */}
            <section aria-label="Hari ini">
              <div className="pixel-frame bg-[var(--surface)] px-4 py-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-[var(--dim)]">
                      {fmtDateId(data.today.dateStr)}
                    </p>
                    <p className="mt-1 text-sm font-semibold">Berita tayang hari ini</p>
                  </div>
                  <div className="flex gap-1.5 pt-1" aria-label={`${data.today.postedCount} dari ${data.today.cap} slot terpakai`}>
                    {Array.from({ length: data.today.cap }, (_, i) => (
                      <span
                        key={i}
                        className={
                          i < data.today.postedCount
                            ? "block h-3.5 w-3.5 bg-[var(--accent)]"
                            : "block h-3.5 w-3.5 border border-[var(--accent)]"
                        }
                      />
                    ))}
                  </div>
                </div>
                <p className="font-pixel mt-3 text-[44px] leading-none text-[var(--accent)]">
                  {data.today.postedCount}
                  <span className="text-[20px] text-[var(--dim)]">/{data.today.cap}</span>
                </p>
                <p className="mt-3 text-sm text-[var(--text)]">
                  {data.today.remaining > 0
                    ? `Sisa ${data.today.remaining} slot hari ini.`
                    : "Kuota 3 berita hari ini sudah penuh."}
                </p>
                {data.today.remaining > 0 ? (
                  data.today.safeNow ? (
                    <p className="mt-1 text-sm font-medium text-[var(--accent)]">
                      Slot berikutnya aman sekarang.
                    </p>
                  ) : (
                    <p className="mt-1 text-sm font-medium text-[var(--warn)]">
                      Jendela aman berikutnya: {fmtWibClock(data.today.nextSafeFrom)} sampai{" "}
                      {fmtWibClock(data.today.nextSafeTo)} WIB (jeda 2 sampai 3 jam dari
                      tayangan terakhir).
                    </p>
                  )
                ) : null}
                {data.today.posts.length > 0 ? (
                  <ul className="mt-3 border-t border-[var(--border)]">
                    {data.today.posts.map((p) => (
                      <li
                        key={p.contentId}
                        className="flex items-baseline justify-between gap-3 py-2 text-sm"
                      >
                        <span className="min-w-0 truncate">
                          {p.postUrl ? (
                            <a
                              href={p.postUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="underline decoration-[var(--accent)] underline-offset-2"
                            >
                              {p.title || p.contentId}
                            </a>
                          ) : (
                            p.title || p.contentId
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-[var(--dim)]">
                          {p.time.replace(":", ".")} WIB
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 border-t border-[var(--border)] pt-3 text-xs leading-relaxed text-[var(--dim)]">
                    Belum ada yang tayang hari ini.
                    {data.today.lastPostLabel
                      ? ` Tayangan terakhir: ${data.today.lastPostLabel}.`
                      : ""}
                  </p>
                )}
              </div>
            </section>

            {/* ---------- PENGINGAT BASI ---------- */}
            {data.stale.count > 0 ? (
              <section aria-label="Pengingat paket basi">
                <div className="border border-[var(--danger)] bg-[var(--surface)] px-4 py-4">
                  <SectionHead
                    title="PENGINGAT: FRAMING BASI"
                    note={`${data.stale.count} paket`}
                  />
                  <p className="mb-2 text-sm leading-relaxed text-[var(--text)]">
                    {data.stale.count} paket di antrean sudah lewat 24 jam. Jangan diketuk
                    apa adanya, cek dulu apakah framing dan faktanya masih relevan.
                  </p>
                  <ul>
                    {data.stale.items.map((item) => (
                      <QueueRow key={item.contentId} item={item} stale />
                    ))}
                  </ul>
                  {data.stale.count > data.stale.items.length ? (
                    <p className="pt-2 text-xs text-[var(--dim)]">
                      …dan {data.stale.count - data.stale.items.length} paket basi lainnya.
                    </p>
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* ---------- ANTREAN ---------- */}
            <section aria-label="Antrean persetujuan">
              <SectionHead
                title="ANTREAN SIAP TAYANG"
                note={`${data.queue.totalWaiting} menunggu keputusan`}
              />
              <div className="border border-[var(--border)] bg-[var(--surface)] px-4 py-2">
                <p className="border-b border-[var(--border)] py-2 text-xs text-[var(--dim)]">
                  {data.queue.freshCount} segar · {data.queue.staleSoonCount} hampir basi ·
                  yang hampir basi diurutkan paling atas, ketuk yang itu dulu.
                </p>
                {data.queue.actionable.length > 0 ? (
                  <ul>
                    {data.queue.actionable.map((item) => (
                      <QueueRow key={item.contentId} item={item} />
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-sm text-[var(--dim)]">
                    Tidak ada paket segar di antrean saat ini.
                  </p>
                )}
              </div>
            </section>

            {/* ---------- PERFORMA ---------- */}
            <section aria-label="Performa">
              <SectionHead title="PERFORMA" note="dari MASTER_POST_LOG" />
              <div className="grid grid-cols-3 gap-2">
                <div className="border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
                  <p className="font-pixel text-[18px] text-[var(--accent)]">
                    {fmtNum(data.account.followers)}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-tight text-[var(--dim)]">
                    Follower Instagram
                  </p>
                </div>
                <div className="border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
                  <p className="font-pixel text-[18px] text-[var(--accent)]">
                    {fmtNum(data.performance.postedCount)}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-tight text-[var(--dim)]">
                    Total postingan tayang
                  </p>
                </div>
                <div className="border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
                  <p className="font-pixel text-[18px] text-[var(--accent)]">
                    {fmtNum(data.performance.loggedPosts)}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-tight text-[var(--dim)]">
                    Paket tercatat di log
                  </p>
                </div>
              </div>

              <h3 className="mb-1 mt-5 text-sm font-semibold">Konten paling jalan</h3>
              <div className="border border-[var(--border)] bg-[var(--surface)] px-4 py-1">
                {data.performance.topContent.length > 0 ? (
                  <ul>
                    {data.performance.topContent.map((p, i) => (
                      <MetricRow key={p.contentId} post={p} rank={i + 1} />
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-sm text-[var(--dim)]">
                    Reach belum terisi di log untuk konten mana pun.
                  </p>
                )}
              </div>
              <p className="mt-2 text-xs text-[var(--dim)]">
                Reach terisi untuk {data.performance.reachFilled} dari{" "}
                {data.performance.loggedPosts} baris log; baris tanpa angka memang belum
                diisi insight-nya di sheet.
              </p>

              <h3 className="mb-1 mt-5 text-sm font-semibold">Rata-rata per genre</h3>
              <div className="border border-[var(--border)] bg-[var(--surface)] px-4 py-2">
                <table className="w-full text-sm" aria-label="Rata-rata reach dan ER per genre">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--dim)]">
                      <th className="py-2 pr-2 font-medium">Genre</th>
                      <th className="py-2 pr-2 text-right font-medium">Post</th>
                      <th className="py-2 pr-2 text-right font-medium">Rata2 reach</th>
                      <th className="py-2 text-right font-medium">Rata2 ER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.performance.genreStats.map((g) => (
                      <tr key={g.genre} className="border-b border-[var(--border)] last:border-b-0">
                        <td className="py-2 pr-2 font-medium">{g.genre}</td>
                        <td className="py-2 pr-2 text-right">{fmtNum(g.posts)}</td>
                        <td className="py-2 pr-2 text-right">{fmtNum(g.avgReach)}</td>
                        <td className="py-2 text-right">{fmtPct(g.avgEr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="mb-1 mt-5 text-sm font-semibold">Reach konten terakhir</h3>
              <div className="border border-[var(--border)] bg-[var(--surface)] px-4 py-1">
                <ul>
                  {data.performance.recentContent.map((p) => (
                    <MetricRow key={p.contentId} post={p} />
                  ))}
                </ul>
              </div>
            </section>

            {/* ---------- KALENDER EDITORIAL ---------- */}
            <section aria-label="Kalender editorial">
              <SectionHead
                title="KALENDER EDITORIAL"
                note="Selasa & Sabtu · 19.00 WIB"
              />
              <div className="border border-[var(--border)] bg-[var(--surface)] px-4 py-1">
                <ul>
                  {data.slots.map((slot) => (
                    <SlotRow key={slot.date} slot={slot} />
                  ))}
                </ul>
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
