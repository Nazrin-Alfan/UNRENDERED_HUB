import { useState, type ComponentType } from "react";
import { TrackerPage } from "./pages/TrackerPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DraftsPage } from "./pages/DraftsPage";

// UNRENDERED Hub — multi-page shell.
//
// To add a new page later: create the component under ./pages/, then add
// ONE entry to PAGES below (id, tab label, component). The tab bar and
// page switching pick it up automatically; existing pages stay untouched.
const PAGES = [
  { id: "tracker", label: "TRACKER", component: TrackerPage },
  { id: "draft", label: "DRAFT", component: DraftsPage },
  { id: "dashboard", label: "DASHBOARD", component: DashboardPage },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  component: ComponentType;
}>;

type PageId = (typeof PAGES)[number]["id"];

export function App() {
  const [page, setPage] = useState<PageId>("tracker");
  const Active = PAGES.find((p) => p.id === page)?.component ?? TrackerPage;

  return (
    <div>
      <nav
        aria-label="Halaman UNRENDERED Hub"
        className="sticky top-0 z-40 border-b-2 border-lime bg-void/95"
      >
        <div className="mx-auto flex max-w-3xl items-stretch gap-1 px-4">
          <span
            aria-hidden="true"
            className="flex items-center pr-2 font-pixel text-[9px] text-mist"
          >
            UNRENDERED <span className="pl-1 text-lime">◆</span>
          </span>
          {PAGES.map((p) => {
            const active = p.id === page;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPage(p.id)}
                aria-current={active ? "page" : undefined}
                className={`border-b-2 px-3 py-3 font-pixel text-[10px] tracking-wider transition-colors ${
                  active
                    ? "border-lime bg-panel2 text-lime"
                    : "border-transparent text-mist hover:text-white"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </nav>
      <Active />
    </div>
  );
}
