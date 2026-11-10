import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "../api";

type State = ApiResponse<typeof api, "getState">;
type Quest = State["dailyQuests"][number];
type CoreStat = State["coreStats"][number];
type WorldStat = State["worldStats"][number];

const fmtNum = (n: number): string => n.toLocaleString("id-ID");
const fmtRate = (n: number): string =>
  n.toLocaleString("id-ID", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

/** Inline Lucide-style stroke icons (24×24) per stat — no extra dependency. */
function StatIcon({ k, size = 20 }: { k: string; size?: number }) {
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (k) {
    case "STR": // Swords
      return (<svg {...common}><path d="m14.5 12.5-8 8a2.12 2.12 0 1 1-3-3l8-8" /><path d="m13 13 4-4" /><path d="m16 16 4-4" /><path d="m19 21 4-4" /><path d="M14.5 12.5 19 8l3-3-4.5-1L14 7.5" /><path d="M5 5l4 4" /><path d="m7 17-4 4" /></svg>);
    case "AGI": // Wind / Zap combo → Wind
      return (<svg {...common}><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" /><path d="M9.6 4.6A2 2 0 1 1 11 8H2" /><path d="M12.6 19.4A2 2 0 1 0 14 16H2" /></svg>);
    case "VIT": // HeartPulse
      return (<svg {...common}><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" /><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" /></svg>);
    case "INT": // Brain / BookOpen → Brain simplified as Lightbulb+Brain circuit
      return (<svg {...common}><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></svg>);
    case "PER": // Eye
      return (<svg {...common}><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" /></svg>);
    case "FAME": // Crown
      return (<svg {...common}><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" /><path d="M5 21h14" /></svg>);
    case "IMPACT": // Radar / Globe
      return (<svg {...common}><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" /><path d="M4 6h.01" /><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35" /><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67" /><path d="M12 18h.01" /><path d="m17 13 5-5" /><circle cx="17" cy="13" r="1" /></svg>);
    default: // Sparkle diamond
      return (<svg {...common}><path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" /></svg>);
  }
}

function RankBadge({ rank, level }: { rank: string; level: number }) {
  return (
    <div className="flex flex-col items-center">
      <div className="hud-rank-glow relative" aria-label={`Rank ${rank}, Level ${level}`}>
        <svg width="104" height="118" viewBox="0 0 104 118" aria-hidden="true">
          {/* outer shield */}
          <path d="M52 2 L98 16 V56 C98 86 78 104 52 116 C26 104 6 86 6 56 V16 Z" fill="#071801" stroke="#d8ff3d" strokeWidth="3" />
          <path d="M52 10 L90 22 V56 C90 81 73 96 52 106 C31 96 14 81 14 56 V22 Z" fill="#11300a" stroke="#303f2a" strokeWidth="2" />
          <path d="M52 18 L82 28 V56 C82 76 68 89 52 97 C36 89 22 76 22 56 V28 Z" fill="none" stroke="#d8ff3d" strokeWidth="1" strokeOpacity="0.45" strokeDasharray="4 3" />
          {/* top gem */}
          <path d="M52 14 l6 7 -6 7 -6 -7 z" fill="#884cfa" stroke="#d8ff3d" strokeWidth="1" />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center pt-3 font-pixel text-5xl text-lime" style={{ textShadow: "0 0 12px rgba(216,255,61,0.8), 3px 3px 0 #071801" }}>{rank}</span>
      </div>
      <span className="mt-1 border border-lime bg-void px-2 py-0.5 font-pixel text-[9px] tracking-wider text-white">LV {level}</span>
    </div>
  );
}

function TrendArrow({ trend }: { trend: CoreStat["trend"] }) {
  if (trend === "up")
    return <span className="text-lime" aria-label="momentum naik dari kemarin">▲</span>;
  if (trend === "down")
    return <span className="text-violet" aria-label="momentum turun dari kemarin">▼</span>;
  return <span className="text-mist" aria-label="momentum stabil dari kemarin">▬</span>;
}

function QuestRow({
  quest,
  pending,
  onToggle,
}: {
  quest: Quest;
  pending: boolean;
  onToggle: (quest: Quest, done: boolean) => void;
}) {
  const isAuto = quest.source === "auto";
  return (
    <li className={`flex items-start gap-3 border-b border-faint py-3 last:border-b-0 transition-colors ${quest.done ? "bg-lime/5" : ""}`}>
      <span className={`relative mt-0.5 shrink-0 ${quest.done ? "hud-pop" : ""}`} key={String(quest.done)}>
        <input
          type="checkbox"
          checked={quest.done}
          disabled={isAuto || pending}
          onChange={(e) => onToggle(quest, e.target.checked)}
          aria-label={`${quest.label} — ${quest.xp} XP`}
          className="block h-6 w-6 cursor-pointer appearance-none border-2 border-lime bg-void checked:bg-lime disabled:cursor-default disabled:opacity-70"
          style={quest.done ? { backgroundImage: "linear-gradient(45deg, transparent 42%, #071801 42%, #071801 58%, transparent 58%), linear-gradient(-45deg, transparent 42%, #071801 42%, #071801 58%, transparent 58%)", backgroundSize: "10px 10px", backgroundPosition: "center" } : undefined}
        />
        {quest.done && <span aria-hidden="true" className="pointer-events-none absolute -right-1 -top-2 text-[10px] text-lime">✦</span>}
      </span>
      <div className="min-w-0 flex-1">
        <p className={quest.done ? "text-mist line-through" : "text-white"}>
          {quest.label}
        </p>
        {isAuto && (
          <p className="mt-0.5 text-xs text-lime">
            Tercentang otomatis dari data tayang
          </p>
        )}
        {quest.breachDate && (
          <p className="mt-0.5 text-xs text-violet">
            Hutang editorial dari slot {quest.breachDate}
          </p>
        )}
      </div>
      <span className={`shrink-0 border px-2 py-1 font-pixel text-[10px] ${quest.done ? "border-lime bg-lime text-black" : "border-faint text-lime"}`}>
        +{quest.xp} XP
      </span>
    </li>
  );
}

type CoreKey = "STR" | "AGI" | "VIT" | "INT" | "PER";

function CoreStatRow({
  stat,
  unallocated,
  allocPending,
  onAllocate,
}: {
  stat: CoreStat;
  unallocated: number;
  allocPending: boolean;
  onAllocate: (key: CoreKey) => void;
}) {
  const reached = stat.momentum >= stat.target;
  const barPct = Math.min(100, stat.pct);
  return (
    <article className="border-b border-faint py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2.5 font-pixel text-xs text-lime">
          <span className={`flex h-9 w-9 items-center justify-center border ${reached ? "border-lime bg-lime text-black" : "border-lime/60 bg-void text-lime"}`}><StatIcon k={stat.key} size={20} /></span>
          {stat.key}
          {reached && <span className="border border-lime px-1.5 py-0.5 font-pixel text-[8px] text-lime">MAX</span>}
        </h3>
        <p className="text-xs text-mist">{stat.name}</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex items-baseline gap-2">
          <span className="text-xs text-mist">BASE</span>
          <span className="font-pixel text-2xl text-white">{stat.baseStat}</span>
          {unallocated > 0 && (
            <button
              type="button"
              disabled={allocPending}
              onClick={() => onAllocate(stat.key as CoreKey)}
              aria-label={`Tambah 1 poin alokasi ke ${stat.key}`}
              className="border border-lime px-2 py-1 font-pixel text-[10px] text-lime disabled:opacity-50"
            >
              [+]
            </button>
          )}
        </p>
        <p className="flex items-baseline gap-2">
          <span className="text-xs text-mist">MOMENTUM 7 HARI</span>
          <span className="font-pixel text-sm text-lime">
            {fmtRate(stat.momentum)}
          </span>
          <TrendArrow trend={stat.trend} />
          <span className="text-xs text-mist">
            / target {fmtRate(stat.target)} ({stat.pct}%)
          </span>
        </p>
      </div>
      <div
        className="relative mt-3 h-3 w-full border border-faint bg-void"
        role="progressbar"
        aria-valuenow={barPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Momentum ${stat.key} mencapai ${stat.pct} persen dari target`}
      >
        <div
          className={`hp-segments h-full ${reached ? "bg-lime" : "bg-lime/50"}`}
          style={{ width: `${barPct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-mist">
        {fmtNum(stat.lifetimePts)} poin seumur hidup
        {stat.allocated > 0 ? ` — termasuk +${stat.allocated} poin alokasi level` : ""}
      </p>
      <p className={`mt-2 text-sm ${reached ? "text-lime" : "text-white/85"}`}>
        {stat.note}
      </p>
    </article>
  );
}

function WorldStatRow({ stat }: { stat: WorldStat }) {
  const reached = stat.rate >= stat.target;
  const pct = Math.min(
    100,
    Math.round((stat.rate / stat.target) * 100),
  );
  return (
    <article className="border-b border-faint py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2.5 font-pixel text-xs text-lime">
          <span className={`flex h-9 w-9 items-center justify-center border ${reached ? "border-lime bg-lime text-black" : "border-violet/70 bg-void text-violet"}`}><StatIcon k={stat.key} size={20} /></span>
          {stat.key}
        </h3>
        <p className="text-xs text-mist">{stat.name}</p>
      </div>
      <p className="mt-3 flex flex-wrap items-baseline gap-2">
        <span className="font-pixel text-2xl text-white">
          {fmtNum(stat.total)}
        </span>
        <span className="text-xs text-mist">{stat.totalLabel}</span>
        <span className="text-xs text-mist">— laju</span>
        <span className="font-pixel text-sm text-lime">
          {fmtRate(stat.rate)}
        </span>
        <span className="text-xs text-mist">
          poin/hari / target {fmtRate(stat.target)}
        </span>
      </p>
      <div
        className="relative mt-3 h-3 w-full border border-faint bg-void"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${stat.key} mencapai ${pct} persen dari target`}
      >
        <div
          className={`hp-segments h-full ${reached ? "bg-lime" : "bg-violet/70"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className={`mt-3 text-sm ${reached ? "text-lime" : "text-white/85"}`}>
        {stat.note}
      </p>
    </article>
  );
}

export function TrackerPage() {
  const queryClient = useQueryClient();
  const [banner, setBanner] = useState<string | null>(null);
  const [followersInput, setFollowersInput] = useState("");
  const [reachInput, setReachInput] = useState("");
  const [rewardPop, setRewardPop] = useState<{ xp: number; id: number } | null>(null);

  useEffect(() => {
    if (!rewardPop) return;
    const t = setTimeout(() => setRewardPop(null), 2300);
    return () => clearTimeout(t);
  }, [rewardPop]);

  const state = useQuery({
    queryKey: ["grind-state"],
    queryFn: () => api.getState({}),
  });

  const applyResult = (next: State, prev: State | undefined) => {
    if (prev) {
      const gained = next.xp - prev.xp + (next.heldXp - prev.heldXp);
      if (gained > 0) setRewardPop({ xp: gained, id: Date.now() });
      if (next.rank !== prev.rank) {
        setBanner(
          `RANK UP — lulus Rank-Up Trial, sekarang Rank ${next.rank}`,
        );
      } else if (next.level > prev.level) {
        setBanner(
          `LEVEL UP — sekarang Level ${next.level}${next.unallocatedPoints > prev.unallocatedPoints ? `, +${next.unallocatedPoints - prev.unallocatedPoints} Unallocated Stat Point` : ""}`,
        );
      }
    }
    queryClient.setQueryData(["grind-state"], next);
  };

  const toggle = useMutation({
    mutationFn: (args: { questKey: string; done: boolean }) =>
      api.toggleQuest(args),
    onSuccess: (next) => {
      const prev = queryClient.getQueryData<State>(["grind-state"]);
      applyResult(next, prev);
    },
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshData({}),
    onSuccess: (next) => {
      const prev = queryClient.getQueryData<State>(["grind-state"]);
      applyResult(next, prev);
    },
  });

  const perfCheck = useMutation({
    mutationFn: () => api.logPerfCheck({}),
    onSuccess: (next) => {
      const prev = queryClient.getQueryData<State>(["grind-state"]);
      applyResult(next, prev);
      setBanner("Cek performa tercatat — PER +10 poin.");
    },
  });

  const metric = useMutation({
    mutationFn: (args: { kind: "followers" | "reach"; amount: number }) =>
      api.logMetric(args),
    onSuccess: (next) => {
      const prev = queryClient.getQueryData<State>(["grind-state"]);
      applyResult(next, prev);
      setFollowersInput("");
      setReachInput("");
    },
  });

  const allocate = useMutation({
    mutationFn: (args: {
      statKey: "STR" | "AGI" | "VIT" | "INT" | "PER";
    }) => api.allocateStat(args),
    onSuccess: (next) => {
      const prev = queryClient.getQueryData<State>(["grind-state"]);
      applyResult(next, prev);
    },
  });

  if (state.isPending) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="font-pixel text-xs text-lime">MEMUAT SYSTEM…</p>
      </main>
    );
  }

  if (state.error || !state.data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="border border-lime bg-panel p-5">
          <p className="font-pixel text-xs text-lime">SYSTEM ERROR</p>
          <p className="mt-3 text-white">
            Data tracker belum bisa dimuat. Coba lagi sebentar.
          </p>
          <button
            type="button"
            onClick={() => state.refetch()}
            className="mt-4 border border-lime bg-lime px-4 py-2 font-pixel text-[10px] text-black"
          >
            COBA LAGI
          </button>
        </div>
      </main>
    );
  }

  const s = state.data;
  const xpPct =
    s.xpForNextLevel > 0
      ? Math.min(100, Math.round((s.xpIntoLevel / s.xpForNextLevel) * 100))
      : 100;
  const dailyDone = s.dailyQuests.filter((q) => q.done).length;
  const weeklyDone = s.weeklyQuests.filter((q) => q.done).length;
  const trialLocked = s.trial !== null && s.trial.xpReached && !s.trial.passed;

  const submitMetric = (kind: "followers" | "reach") => {
    const raw = kind === "followers" ? followersInput : reachInput;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) return;
    metric.mutate({ kind, amount: Math.floor(amount) });
  };

  return (
    <main className="relative mx-auto max-w-3xl px-4 py-5 pb-12">
      {rewardPop && (
        <div key={rewardPop.id} aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-24 z-50 flex justify-center">
          <div className="hud-float-up flex items-center gap-2 border-2 border-lime bg-void px-4 py-2 shadow-[0_0_24px_rgba(216,255,61,0.45)]">
            <span className="text-lime">✦</span>
            <span className="font-pixel text-sm text-lime">+{rewardPop.xp} XP</span>
            <span className="font-pixel text-[9px] text-white">QUEST CLEAR!</span>
            <span className="text-lime">✦</span>
          </div>
        </div>
      )}
      {banner && (
        <div
          role="status"
          className="mb-4 border border-lime bg-panel2 px-4 py-3"
        >
          <p className="font-pixel text-[11px] leading-relaxed text-lime">
            {banner}
          </p>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="Tutup notifikasi"
            className="mt-2 text-xs text-mist underline"
          >
            Tutup
          </button>
        </div>
      )}

      {/* ------------------------------------------------ status panel */}
      <section
        aria-label="Status hunter"
        className="hud-corners border-2 border-lime bg-panel p-5"
      >
        {/* HUD top strip */}
        <div className="mb-4 flex items-center justify-between border-b border-faint pb-3">
          <span className="flex items-center gap-2 font-pixel text-[9px] text-mist"><span className={`inline-block h-2 w-2 ${s.penaltyZoneActive ? "bg-violet hud-blink" : "bg-lime"}`} /> HUNTER STATUS</span>
          <span className="font-pixel text-[9px] text-mist">UNRENDERED <span className="text-lime">◆</span> SYSTEM v2.0</span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="font-pixel text-[10px] text-mist">◷ LIVE TIME</p>
            <p className="mt-2 font-pixel text-5xl text-lime" style={{ textShadow: "0 0 14px rgba(216,255,61,0.35)" }}>{s.liveTime}</p>
            <p className="mt-2 font-pixel text-[10px] text-mist">
              HARI SEJAK TAYANG PERTAMA
            </p>
            <div className="mt-4 flex gap-1.5" aria-hidden="true">
              {Array.from({ length: 7 }).map((_, i) => (
                <span key={i} className={`h-2.5 w-5 border border-lime/50 ${i < Math.min(7, s.streakDays) ? "bg-lime" : "bg-void"}`} />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-mist">Streak pips — {s.streakDays} hari aktif</p>
          </div>
          <RankBadge rank={s.rank} level={s.level} />
        </div>

        <div className="mt-5">
          <p className="font-pixel text-[10px] text-mist">SYSTEM STATUS</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {s.statuses.length === 0 ? (
              <span className="border border-lime px-2 py-1 font-pixel text-[10px] text-lime">
                NORMAL
              </span>
            ) : (
              s.statuses.map((st) => (
                <span
                  key={st}
                  className={
                    st === "FULL SYNC"
                      ? "border border-lime bg-lime px-2 py-1 font-pixel text-[10px] text-black"
                      : "border border-violet px-2 py-1 font-pixel text-[10px] text-violet"
                  }
                >
                  {st}
                </span>
              ))
            )}
          </div>
          <ul className="mt-3 space-y-1">
            {s.buffs.map((b) => (
              <li key={b.key} className={`flex items-start gap-2 border px-2.5 py-2 text-xs ${b.active ? "border-lime/60 bg-lime/5" : "border-faint"}`}>
                <span aria-hidden="true" className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border text-[11px] ${b.active ? "border-lime bg-lime text-black" : "border-faint text-mist"}`}>{b.key === "IRON WILL" ? "♥" : b.key === "SHARP INSIGHT" ? "◎" : "✦"}</span>
                <span>
                  <span className={`font-pixel text-[9px] ${b.active ? "text-lime" : "text-mist"}`}>{b.name} — {b.active ? "AKTIF" : "TIDAK AKTIF"}</span>
                  <span className="mt-0.5 block text-mist">{b.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="flex items-center gap-2 font-pixel text-[10px] text-white">
              <span className={`flex h-6 w-6 items-center justify-center border font-pixel text-[9px] ${s.penaltyZoneActive ? "border-violet text-violet" : "border-lime bg-lime text-black"}`}>XP</span>
              {fmtNum(s.xp)} <span className="text-mist">/ HP BAR</span>
            </p>
            <p className="text-xs text-mist">
              {trialLocked
                ? `MAX — RANK UP TRIAL REQUIRED menuju Rank ${s.trial?.nextRank}`
                : `${fmtNum(s.xpIntoLevel)} / ${fmtNum(s.xpForNextLevel)} XP menuju Level ${s.level + 1} — ${xpPct}%`}
            </p>
          </div>
          {/* HP-style segmented bar: outer frame + ticks + shimmer + pulse */}
          <div className={`mt-2 border-2 bg-void p-1 ${s.penaltyZoneActive ? "border-violet" : "border-lime"}`}>
            <div
              className="hud-shimmer-wrap relative h-6 w-full bg-black/50"
              role="progressbar"
              aria-valuenow={xpPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Progres XP menuju level ${s.level + 1}: ${xpPct} persen`}
            >
              <div
                className={`hp-segments h-full transition-all duration-500 ${s.penaltyZoneActive ? "bg-violet hud-hp-danger" : xpPct <= 25 ? "bg-lime hud-hp-pulse" : "bg-lime"}`}
                style={{ width: `${xpPct}%`, boxShadow: "inset 0 -6px 0 rgba(0,0,0,0.28), inset 0 4px 0 rgba(255,255,255,0.22)" }}
              />
              <span className="absolute inset-0 flex items-center justify-center font-pixel text-[9px] text-white" style={{ textShadow: "1px 1px 0 #071801, -1px -1px 0 #071801" }}>{xpPct}%</span>
            </div>
          </div>
          <div className="mt-1 flex justify-between font-pixel text-[8px] text-mist" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>LV {s.level + 1}</span></div>
          <p className="mt-2 text-xs text-mist">
            XP tidak pernah turun. Penalti berbentuk status dan XP tertahan,
            bukan potongan XP.
          </p>
          {s.overflowXp > 0 && (
            <p className="mt-2 text-sm text-white">
              OVERFLOW XP: {fmtNum(s.overflowXp)} XP tersimpan di atas batas
              Rank {s.rank} — langsung masuk ke bar level begitu Rank-Up
              Trial lulus.
            </p>
          )}
          {s.heldXp > 0 && (
            <p className="mt-2 text-sm text-violet">
              BRANKAS PENALTI: {fmtNum(s.heldXp)} XP tertahan — cairkan dengan
              menyelesaikan Penalty Quest hari ini.
            </p>
          )}
          {s.unallocatedPoints > 0 && (
            <p className="mt-2 text-sm text-lime">
              UNALLOCATED STAT POINTS: {s.unallocatedPoints} poin — tekan [+]
              di Core Stat untuk mengalokasikannya.
            </p>
          )}
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-mist">Total tayangan</dt>
            <dd className="mt-1 font-pixel text-sm text-white">
              {fmtNum(s.totalPosts)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-mist">Follower</dt>
            <dd className="mt-1 font-pixel text-sm text-white">
              {fmtNum(s.followers)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-mist">Total reach</dt>
            <dd className="mt-1 font-pixel text-sm text-white">
              {fmtNum(s.totalReach)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-mist">
              Streak aktif{s.streakFrozen ? " (dibekukan)" : ""}
            </dt>
            <dd className="mt-1 font-pixel text-sm text-white">
              {s.streakDays} hari
            </dd>
          </div>
        </dl>
        {s.streakFrozen && (
          <p className="mt-3 text-sm text-violet">
            DEBUFF: EDITORIAL BREACH — streak dibekukan dan tidak bertambah
            sampai hutang Make-Up Editorial lunas.
          </p>
        )}
      </section>

      {/* --------------------------------------------------- rank trial */}
      {s.trial && (
        <section
          aria-label="Rank-Up Trial"
          className="mt-4 border border-lime bg-panel2 p-5"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-pixel text-xs text-lime">
              RANK-UP TRIAL — MENUJU RANK {s.trial.nextRank}
            </h2>
            <p className="text-xs text-mist">
              Level {s.trial.capLevel} MAX / {fmtNum(s.trial.promotionXp)} XP
            </p>
          </div>
          <p className="mt-2 text-sm text-white/85">
            {s.trial.xpReached
              ? s.trial.passed
                ? "Semua syarat terpenuhi — promosi diproses pada sinkronisasi berikutnya."
                : "Bar XP terkunci di MAX. Lulus semua syarat trial untuk naik rank; XP tambahan tersimpan sebagai Overflow XP."
              : "Syarat trial bisa disiapkan dari sekarang; kunci bar XP aktif begitu XP menyentuh batas promosi."}
          </p>
          <ul className="mt-3 space-y-2">
            {s.trial.conditions.map((c) => (
              <li key={c.label} className="flex items-start gap-2 text-sm">
                <span
                  className={c.met ? "text-lime" : "text-violet"}
                  aria-label={c.met ? "terpenuhi" : "belum terpenuhi"}
                >
                  {c.met ? "✓" : "✗"}
                </span>
                <span className="text-white/85">{c.label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* -------------------------------------------------------- quests */}
      <section aria-label="Quest harian" className="hud-corners mt-6 border border-lime/60 bg-panel p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 font-pixel text-xs text-lime"><span aria-hidden="true" className="flex h-7 w-7 items-center justify-center border border-lime bg-void text-sm">⚔</span> QUEST HARIAN</h2>
          <p className="text-xs text-mist">
            {dailyDone}/{s.dailyQuests.length} selesai — reset 00.00 WIB
          </p>
        </div>
        {s.penaltyZoneActive && (
          <div className="mt-3 border border-violet bg-void px-3 py-2">
            <p className="font-pixel text-[10px] text-violet">
              PENALTY ZONE ACTIVE
            </p>
            <p className="mt-1 text-sm text-white/85">
              Kemarin tanpa quest selesai. Semua XP hari ini masuk Brankas
              Penalti dulu. Penalty Quest: selesaikan minimal{" "}
              {s.penaltyQuestRequired} quest harian hari ini (
              {s.penaltyQuestDone}/{s.penaltyQuestRequired}) untuk
              mencairkan {fmtNum(s.heldXp)} XP tertahan. Gagal hari ini,
              XP tertahan hangus; XP lama tetap aman.
            </p>
          </div>
        )}
        <ul className="mt-2">
          {s.dailyQuests.map((q) => (
            <QuestRow
              key={q.key}
              quest={q}
              pending={toggle.isPending}
              onToggle={(quest, done) =>
                toggle.mutate({ questKey: quest.key, done })
              }
            />
          ))}
        </ul>
      </section>

      <section aria-label="Quest mingguan" className="mt-4 border border-lime/60 bg-panel p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 font-pixel text-xs text-lime"><span aria-hidden="true" className="flex h-7 w-7 items-center justify-center border border-lime bg-void text-sm">♜</span> QUEST MINGGUAN</h2>
          <p className="text-xs text-mist">
            {weeklyDone}/{s.weeklyQuests.length} selesai — reset hari Senin
          </p>
        </div>
        <ul className="mt-2">
          {s.weeklyQuests.map((q) => (
            <QuestRow
              key={q.key}
              quest={q}
              pending={toggle.isPending}
              onToggle={(quest, done) =>
                toggle.mutate({ questKey: quest.key, done })
              }
            />
          ))}
        </ul>
        <p className="mt-3 text-xs text-mist">
          Slot editorial Selasa/Sabtu 19.00 yang terlewat pada hari yang tetap
          aktif memicu DEBUFF: EDITORIAL BREACH — streak dibekukan dan muncul
          hutang Make-Up Editorial, tanpa potongan XP.
        </p>
      </section>

      {s.makeupQuests.length > 0 && (
        <section aria-label="Make-Up Quest" className="mt-4 border border-violet bg-panel p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-pixel text-xs text-violet">MAKE-UP QUEST</h2>
            <p className="text-xs text-mist">
              {s.makeupDebt} hutang editorial belum lunas
            </p>
          </div>
          <ul className="mt-2">
            {s.makeupQuests.map((q) => (
              <QuestRow
                key={q.breachDate ?? q.label}
                quest={q}
                pending={toggle.isPending}
                onToggle={(quest, done) =>
                  toggle.mutate({ questKey: quest.key, done })
                }
              />
            ))}
          </ul>
        </section>
      )}

      {/* --------------------------------------------------- core stats */}
      <section aria-label="Core Attributes" className="mt-8">
        <h2 className="flex items-center gap-2 font-pixel text-xs text-lime"><span aria-hidden="true" className="text-base">⬢</span> CORE ATTRIBUTES <span aria-hidden="true" className="h-px flex-1 bg-faint" /></h2>
        <p className="mt-2 text-sm text-mist">
          Base Stat permanen: 10 + poin seumur hidup dibagi 50 + poin
          alokasi level. Momentum adalah poin 7 hari terakhir dibagi 7 —
          radar jujur minggu ini, dan panahnya membandingkan dengan kemarin.
          {s.unallocatedPoints > 0
            ? ` Kamu punya ${s.unallocatedPoints} Unallocated Stat Point.`
            : ""}
        </p>
        <div className="mt-4 border border-lime/60 bg-panel p-5">
          {s.coreStats.map((stat) => (
            <CoreStatRow
              key={stat.key}
              stat={stat}
              unallocated={s.unallocatedPoints}
              allocPending={allocate.isPending}
              onAllocate={(key) => allocate.mutate({ statKey: key })}
            />
          ))}
        </div>
      </section>

      {/* ----------------------------------------------- world influence */}
      <section aria-label="World Influence" className="mt-8">
        <h2 className="flex items-center gap-2 font-pixel text-xs text-violet"><span aria-hidden="true" className="text-base">◎</span> WORLD INFLUENCE <span aria-hidden="true" className="h-px flex-1 bg-faint" /></h2>
        <p className="mt-2 text-sm text-mist">
          Dampak eksternal @unrender_media. Panel ini tidak ikut menguji
          Rank-Up Trial, jadi fluktuasi algoritma tidak menyandera status
          internal hunter.
        </p>
        <div className="mt-4 border border-lime/60 bg-panel p-5">
          {s.worldStats.map((stat) => (
            <WorldStatRow key={stat.key} stat={stat} />
          ))}
        </div>
      </section>

      {/* --------------------------------------------------- manual logs */}
      <section aria-label="Catat manual" className="mt-8 border border-lime/60 bg-panel p-5">
        <h2 className="font-pixel text-xs text-lime">CATAT MANUAL</h2>
        <p className="mt-2 text-sm text-mist">
          Angka yang tidak terbaca dari sheet dicatat di sini.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={perfCheck.isPending}
            onClick={() => perfCheck.mutate()}
            className="border border-lime px-4 py-2 font-pixel text-[10px] text-lime disabled:opacity-50"
          >
            SUDAH CEK PERFORMA (+PER)
          </button>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitMetric("followers");
            }}
          >
            <label
              htmlFor="followers-input"
              className="text-sm text-white"
            >
              Follower baru
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="followers-input"
                type="number"
                min={1}
                inputMode="numeric"
                value={followersInput}
                onChange={(e) => setFollowersInput(e.target.value)}
                placeholder="0"
                className="w-full border border-faint bg-void px-3 py-2 text-white"
              />
              <button
                type="submit"
                disabled={metric.isPending}
                className="shrink-0 border border-lime px-3 py-2 font-pixel text-[10px] text-lime disabled:opacity-50"
              >
                SIMPAN
              </button>
            </div>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitMetric("reach");
            }}
          >
            <label htmlFor="reach-input" className="text-sm text-white">
              Reach tambahan
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="reach-input"
                type="number"
                min={1}
                inputMode="numeric"
                value={reachInput}
                onChange={(e) => setReachInput(e.target.value)}
                placeholder="0"
                className="w-full border border-faint bg-void px-3 py-2 text-white"
              />
              <button
                type="submit"
                disabled={metric.isPending}
                className="shrink-0 border border-lime px-3 py-2 font-pixel text-[10px] text-lime disabled:opacity-50"
              >
                SIMPAN
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* --------------------------------------------------------- sync */}
      <section aria-label="Sinkronisasi data" className="mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            className="border border-lime bg-lime px-4 py-2 font-pixel text-[10px] text-black disabled:opacity-50"
          >
            {refresh.isPending ? "MENYINKRONKAN…" : "SINKRONKAN DATA TAYANG"}
          </button>
          <p className="text-xs text-mist">
            {s.lastSyncAt
              ? `Terakhir sinkron ${new Date(s.lastSyncAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB dari sheet MASTER_POST_LOG.`
              : "Belum pernah sinkron dari sheet."}
          </p>
        </div>
        {s.syncError && (
          <p className="mt-2 text-sm text-violet">
            Sinkron terakhir gagal ({s.syncError}). Angka yang tampil adalah
            data tersimpan terakhir.
          </p>
        )}
      </section>
    </main>
  );
}
