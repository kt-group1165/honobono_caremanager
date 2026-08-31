// ============================================================================
// kaigo_visit_schedule.system (制度区分) を、サービス名から決まるものだけ埋める。
//
//   node migrations/backfill_schedule_system.mjs                      DRY RUN (全期間)
//   MONTH=2026-06 node migrations/backfill_schedule_system.mjs        DRY RUN (1 ヶ月)
//   MONTH=2026-06 node migrations/backfill_schedule_system.mjs --execute
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   `system` は 集計・実績記録票・シフト画面・経営分析 が「介護 / 障害 / 総合事業」を
//   切り分けるのに使う。請求額は service_type で拾うので変わらないが、
//   未設定だと制度別の画面がすべて空になる。
//
//   取込 script が system を書いていなかったため、2026-06 は 36,156 件中
//   **484 件しか設定されていなかった**。取込は「その拠点の当月ぶんを消して入れ直す」
//   ので、単発の是正 script で付けても翌回の取込で消える。
//   → 取込 3 本 (介護 / 総合事業 / 障害) に system を入れたうえで、
//     **既に入っている行**をこの script で埋める。
//
// ── 推測しない ──────────────────────────────────────────────────────────
//   サービス名がマスタで **1 制度にしか無いときだけ** 書く。
//   複数制度にある名前・マスタに無い名前は **触らない**。
//   外れた側まで書くと障害を「介護」と記録して請求漏れになる
//   (2026-08 に重訪・総合事業が「介護」になって 238 件を是正した前例がある)。
//
// ── 触らないもの ────────────────────────────────────────────────────────
//   既に system が入っている行は上書きしない (人が直した値を消さないため)。
// ============================================================================
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || null;   // "YYYY-MM"

function loadEnv() {
  const p = path.join(ROOT, ".env.local");
  const e = {};
  if (!existsSync(p)) return e;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("✗ .env.local に URL / SERVICE_ROLE_KEY が無い"); process.exit(1); }
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

/**
 * PostgREST は 1000 行で切るのでページングする。
 *
 * ⚠ **order を付けずにページングすると行が抜ける。**Postgres は ORDER BY 無しの
 *   順序を保証しないので、ページごとに並びが変わって重複・欠落が起きる。
 *   実際にこの script で 102,769 行を取ったとき「身体１生活１」が丸ごと落ちて
 *   「マスタに無い」と誤判定した。**同じコードを 2 回流して 20,206 件 → 34,696 件**
 *   と結果が変わったのが証拠 (2026-09-01)。呼出側で必ず order を渡すこと。
 */
async function all(q) {
  if (!/[?&]order=/.test(q)) throw new Error(`order 指定が無い (行が抜ける): ${q}`);
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${q} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    out.push(...j);
    if (j.length < 1000) return out;
  }
}

/** 名前を指定してマスタを引く (全件ページングより速く、取りこぼさない) */
async function fetchCodesByName(names) {
  const out = [];
  const list = [...new Set(names.filter(Boolean))];
  // ⚠ URL が長すぎると fetch がネットワーク層で落ちる ("fetch failed")。
  //   日本語名は encodeURIComponent で 1 文字 9 バイトになるので小さく刻む。
  const CH = 25;
  for (let i = 0; i < list.length; i += CH) {
    const inList = list.slice(i, i + CH)
      .map((n) => `"${String(n).replace(/"/g, '""')}"`).join(",");
    const q = "kaigo_service_codes?select=service_name,system,valid_from,valid_until"
      + `&calculation_type=eq.${encodeURIComponent("基本")}`
      + `&service_name=in.(${encodeURIComponent(inList)})`
      + "&order=service_name.asc,valid_from.asc";
    out.push(...await all(q));
  }
  return out;
}

/** 全角数字・記号を半角に寄せる (service-name-normalize.ts と同じ規則) */
function toHankakuDigits(s) {
  return String(s ?? "").replace(/[０-９．・（）]/g, (c) =>
    ({ "．": ".", "・": "・", "（": "(", "）": ")" })[c] ??
    String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 対象月に有効な世代か (valid_from <= 月末 かつ valid_until >= 月初 または null) */
function validIn(row, ym) {
  if (!ym) return true;
  const first = `${ym}-01`;
  const [y, m] = ym.split("-").map(Number);
  const last = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  if (row.valid_from && row.valid_from > last) return false;
  if (row.valid_until && row.valid_until < first) return false;
  return true;
}

async function main() {
  console.log(`=== 制度区分 (system) の backfill ${EXECUTE ? "【実行】" : "【DRY RUN】"}`
    + `${MONTH ? ` 対象月 ${MONTH}` : " 全期間"} ===\n`);

  // ⚠ 月末は Date.UTC で作る。`-32` のような日付は Postgres が 400 で弾く。
  //   ローカル Date + toISOString で作ると JST では 1 日ずれる (別途是正済の罠)。
  const range = (() => {
    if (!MONTH) return "";
    const [y, m] = MONTH.split("-").map(Number);
    const d = new Date(Date.UTC(y, m, 0));
    const last = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
      + `-${String(d.getUTCDate()).padStart(2, "0")}`;
    return `&visit_date=gte.${MONTH}-01&visit_date=lte.${last}`;
  })();
  const rows = await all(`kaigo_visit_schedule?select=id,visit_date,service_type,system${range}&order=id.asc`);
  const target = rows.filter((r) => !r.system && r.service_type);
  console.log(`  対象期間の予定・実績 ${rows.length} 件 / うち system 未設定 ${target.length} 件`);
  if (!target.length) { console.log("\n✓ 埋めるものは無い"); return; }

  // ── マスタ: 名前 → 制度の集合 ──
  // ⚠ 全件 (10 万行超) をページングすると取りこぼす。**使う名前だけ**引く。
  const codes = await fetchCodesByName(target.map((r) => r.service_type));
  const kinds = new Set(target.map((r) => r.service_type)).size;
  console.log(`  マスタ照会: ${kinds} 種 → ${codes.length} 世代
`);

  // 月ごとに「その月に有効な世代」で名前→制度を作る
  const mapByMonth = new Map();
  const monthOf = (d) => (typeof d === "string" && /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : "");
  for (const ym of new Set(target.map((r) => monthOf(r.visit_date)))) {
    const m = new Map();
    for (const c of codes) {
      if (!validIn(c, ym)) continue;
      const k = toHankakuDigits(c.service_name);
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(c.system);
    }
    // ⚠ 1 制度にしか無い名前だけ残す。複数制度にある名前は決められないので捨てる。
    const uniq = new Map();
    for (const [k, set] of m) if (set.size === 1) uniq.set(k, [...set][0]);
    mapByMonth.set(ym, { uniq, multi: [...m].filter(([, s]) => s.size > 1).map(([k]) => k) });
  }

  const bySys = new Map();
  const updates = [];
  const undecided = new Map();   // 名前 → 件数
  for (const r of target) {
    const ym = monthOf(r.visit_date);
    const { uniq } = mapByMonth.get(ym) ?? { uniq: new Map() };
    const sys = uniq.get(toHankakuDigits(r.service_type));
    if (!sys) {
      undecided.set(r.service_type, (undecided.get(r.service_type) ?? 0) + 1);
      continue;
    }
    bySys.set(sys, (bySys.get(sys) ?? 0) + 1);
    updates.push({ id: r.id, system: sys });
  }

  console.log("── 決まったもの ──");
  for (const [s, n] of [...bySys].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(s).padEnd(8, "　")}${String(n).padStart(7)} 件`);
  }
  console.log(`  ${"合計".padEnd(8, "　")}${String(updates.length).padStart(7)} 件`);

  const undecidedTotal = [...undecided.values()].reduce((a, b) => a + b, 0);
  console.log(`\n── 決まらなかったもの (触らない) ── ${undecidedTotal} 件 / ${undecided.size} 種`);
  for (const [k, n] of [...undecided].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    const ym = monthOf(target.find((r) => r.service_type === k)?.visit_date);
    const multi = mapByMonth.get(ym)?.multi ?? [];
    const why = multi.includes(toHankakuDigits(k)) ? "複数制度にある" : "マスタに無い";
    console.log(`  ${String(n).padStart(6)} 件  ${String(k).padEnd(30)} ${why}`);
  }
  if (undecided.size > 15) console.log(`  …他 ${undecided.size - 15} 種`);

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で反映します。");
    console.log("  ⚠ 既に system が入っている行は対象外 (人が直した値を上書きしない)。");
    return;
  }

  // ── 反映 ──
  //   ⚠ error を握りつぶさない。1 件でも落ちたらそこで止める。
  console.log("");
  let done = 0;
  const rejected = new Map();   // CHECK 制約に弾かれた値 → 件数
  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const part = updates.slice(i, i + CHUNK);
    // 同じ system のものをまとめて 1 リクエストにする
    const bySysChunk = new Map();
    for (const u of part) {
      if (!bySysChunk.has(u.system)) bySysChunk.set(u.system, []);
      bySysChunk.get(u.system).push(u.id);
    }
    for (const [sys, ids] of bySysChunk) {
      const r = await fetch(
        `${SB_URL}/rest/v1/kaigo_visit_schedule?id=in.(${ids.join(",")})&system=is.null`,
        {
          method: "PATCH",
          headers: { ...H, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({ system: sys }),
        });
      const body = await r.text();
      if (!r.ok) {
        // ⚠ CHECK 制約が許していない値 (23514) は **その値だけ諦めて続行**する。
        //   全部止めると、通る値まで入らない。どの値が弾かれたかは最後に必ず出す。
        if (body.includes('"23514"')) {
          if (!rejected.has(sys)) {
            rejected.set(sys, 0);
            console.error(`\n  ⚠ CHECK 制約が "${sys}" を許していない。この値だけ飛ばす。`);
          }
          rejected.set(sys, rejected.get(sys) + ids.length);
          continue;
        }
        console.error(`✗ ${sys}: ${r.status} ${body.slice(0, 200)}`);
        process.exit(1);
      }
      done += (JSON.parse(body) ?? []).length;
    }
    process.stderr.write(`\r  更新 ${done} / ${updates.length}`);
  }
  process.stderr.write("\n");

  // ── 検証: 読み直して数える ──
  const after = await all(`kaigo_visit_schedule?select=system${range}&order=id.asc`);
  const set = after.filter((r) => r.system).length;
  if (rejected.size) {
    console.log("\n🔴 CHECK 制約に弾かれて入らなかった値:");
    for (const [k, n] of rejected) console.log(`   ${k}  ${n} 件`);
    console.log(`
   kaigo_visit_schedule.system の CHECK がこの値を許していない。
   ⚠ 制約の定義がリポジトリに無い (SQL Editor で直接当てられている)。
     広げるには SQL Editor で DROP → ADD の順に流す:

   ALTER TABLE kaigo_visit_schedule DROP CONSTRAINT IF EXISTS kaigo_visit_schedule_system_check;
   ALTER TABLE kaigo_visit_schedule ADD CONSTRAINT kaigo_visit_schedule_system_check
     CHECK (system IS NULL OR system IN ('介護', '障害', '総合事業', '独自', '地域生活支援'));

   流したあとこの script をもう一度実行すれば残りが入る (冪等)。`);
  }
  console.log(`\n✓ ${done} 件を更新`);
  console.log(`  検証: ${after.length} 件中 system 設定済み ${set} 件 `
    + `(${Math.round((set / Math.max(1, after.length)) * 100)}%)`);
  console.log("\n⚠ 取込を回すと当月ぶんが消えて入れ直される。取込 script 側にも system を");
  console.log("  入れてあるので消えないが、古い取込 script を使うと再び消える。");
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
