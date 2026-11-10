# Data Dummy UNRENDERED Hub (seed/)

Folder ini berisi **data dummy** untuk pengembangan UI/UX Hub. Semua konten di sini
FIKSI dan tidak pernah tayang. Jangan pernah meng-upload data dari folder ini ke
Instagram, dan jangan pernah mencampurnya ke content-bank asli.

## Yang dummy (folder `seed/` — semua fiksi)

| File | Isi | Jumlah |
| --- | --- | --- |
| `seed/drafts.json` | Contoh draft berita + riwayat keputusan (menunggu, GASS, revisi, tidak approve, sudah tayang) | 6 draft |
| `seed/dashboard.json` | Contoh statistik akun, log tayang, antrean, dan slot editorial | 1 akun, 5 log tayang |
| `seed/tracker.json` | Contoh stat dan quest harian Tracker Grind-ku | 5 stat, 5 quest |
| `seed/covers/dummy-cover-01.svg` s.d. `dummy-cover-06.svg` | Placeholder cover tiap draft dummy (SVG, bukan foto asli) | 6 file |
| `seed/covers/dummy-closing.svg` | Placeholder slide penutup | 1 file |

Ciri data dummy: tiap objek JSON punya `"dummy": true`, ID diawali `dummy-`,
URL postingan memakai `instagram.com/p/DUMMY...`, dan angka tracker sengaja
berbeda dari stat asli user.

## Yang BUKAN dummy (source asli Hub — jangan diubah sembarangan)

| Lokasi | Isi |
| --- | --- |
| `client/` | Source React (App, halaman Tracker / Dashboard / Draft) |
| `server/` | Source server (actions, dashboard, drafts, privileged) |
| `drizzle/` | Migrasi database (0001–0006) |
| `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.base.json`, `space.json` | Konfigurasi proyek |
| `AGENTS.md`, `DATA-PLAN.md` | Dokumen internal proyek |

## Yang BUKAN dummy tapi TIDAK ADA di repo ini (tetap di VM)

| Data | Lokasi asli | Keterangan |
| --- | --- | --- |
| Database live (`app.db`) | Direktori Hub di VM | Berisi keputusan, histori, dan state tracker asli |
| Content-bank + `INDEX.json` | `~/workspace/unrendered/content-bank/` | Paket berita asli (cover, caption) |
| Antrean (`news_pending.json`) | `~/workspace/unrendered/` | Antrean approval asli |
| `MASTER_POST_LOG` | Google Sheets | Log tayang asli |
| Kredensial (Meta, Instagram, Google) | `~/.config/` | Secret, tidak pernah masuk repo |

## Cara memakai data dummy

1. Jangan hubungkan `seed/` ke jalur upload. Data ini hanya untuk melihat dan
   mengembangkan tampilan.
2. Field-field di JSON seed mengikuti bentuk data asli yang dikembalikan
   action Hub (`getDrafts`, `getGassHistory`, `getDashboard`), supaya komponen
   UI bisa dikembangkan tanpa mengubah bentuk datanya.
3. Cover dummy berupa SVG placeholder (teks + warna UNRENDERED), bukan key art
   asli, karena file biner (PNG) tidak bisa masuk lewat jalur push yang sama.
