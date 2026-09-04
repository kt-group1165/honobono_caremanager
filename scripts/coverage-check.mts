/**
 * 実データが 因子の組合せを **どこまで覆っているか** を測る (READ ONLY)
 *
 *   npx tsx scripts/coverage-check.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   「実データだけだと網羅性がない」は感覚では言える。★ 数字にする。
 *   scripts/sample-matrix.mts の因子を、実データ側で数えて
 *   ★ 覆えている値・覆えていない値 / 覆えている 2 因子ペア を出す。
 *   足りないぶんが ★ サンプルで埋めるべき量。
 *
 * ⚠ **所要時間は測っていない。**サービス名 (身体日１．０ 等) から時間を読み取るのは
 *   推測が入り、間違えると ★ 網羅率を実際より高く見せてしまう。
 *   測れないものを測ったことにしない。8 因子で測り、9 因子目は「未測定」と出す。
 *
 * ⚠ サービス名は **全角**が混ざる (２人 / １．０)。NFKC で正規化してから判定する。
 *   正規化しないと「2人」は ★ 0 件に見える (2026-09-03 に実際に踏んだ)。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu } from "@/lib/visit-seikyu/aggregate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY がありません。中止します。");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MONTHS = (process.env.MONTHS ?? "2026-06,2026-07").split(",").map((s) => s.trim());
const norm = (s: string) => (s ?? "").normalize("NFKC");

/** 測れる 8 因子。値の並びは sample-matrix.mts と合わせる */
const FACTORS: { name: string; values: string[] }[] = [
  { name: "要介護度", values: ["要支援1", "要支援2", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5"] },
  { name: "サービス", values: ["身体", "生活", "身体+生活", "通院"] },
  { name: "時間帯", values: ["日中", "早朝", "夜間", "深夜"] },
  { name: "2人派遣", values: ["1人", "2人"] },
  { name: "負担割合", values: ["1割", "2割", "3割"] },
  { name: "公費", values: ["なし", "あり"] },
  { name: "限度額", values: ["範囲内", "超過"] },
  { name: "初回加算", values: ["なし", "あり"] },
];

type Row = Awaited<ReturnType<typeof aggregateMonthlyVisitSeikyu>>["rows"][number];

/** 1 行 → 因子の値。★ 読めないものは null にして「覆えた」に数えない */
function classify(r: Row): (string | null)[] {
  const names = r.details.map((d) => norm(d.service_type));
  const has = (k: string) => names.some((n) => n.includes(k));
  const care = r.care_level && FACTORS[0].values.includes(norm(r.care_level)) ? norm(r.care_level) : null;
  const svc = has("通院") ? "通院"
    : (has("身体") && (has("生活") || has("家事"))) ? "身体+生活"
    : has("身体") ? "身体"
    : (has("生活") || has("家事")) ? "生活" : null;
  // 時間帯: 名前に 深/夜/早 が付くものが 1 つでもあれば その時間帯を含む扱い
  const zone = has("深") ? "深夜" : has("夜") ? "夜間" : has("早") ? "早朝" : "日中";
  const two = has("2人") ? "2人" : "1人";
  const copay = r.copay_rate === 0.1 ? "1割" : r.copay_rate === 0.2 ? "2割" : r.copay_rate === 0.3 ? "3割" : null;
  const kohi = r.kohiHobetsu ? "あり" : "なし";
  const limit = r.overUnits > 0 ? "超過" : "範囲内";
  const shokai = has("初回") ? "あり" : "なし";
  return [care, svc, zone, two, copay, kohi, limit, shokai];
}

async function main() {
  const { data: offices, error } = await sb
    .from("offices").select("id, name, tenant_id, unit_price, applied_formula_codes, service_type").order("name");
  if (error) throw new Error(`offices 取得に失敗: ${error.message}`);
  const targets = (offices ?? []).filter((o) => /訪問介護|ヘルパー/.test(String(o.name)) || String(o.service_type ?? "").includes("訪問介護"));

  const seenValue = FACTORS.map(() => new Set<string>());
  const seenPair = new Set<string>();
  let rows = 0;
  let unreadable = 0;
  for (const o of targets) {
    for (const m of MONTHS) {
      const [y, mo] = m.split("-").map(Number);
      let res;
      try {
        res = await aggregateMonthlyVisitSeikyu(sb, {
          officeId: o.id as string, tenantId: o.tenant_id as string, year: y, month: mo,
          unitPrice: (o.unit_price as number) ?? undefined,
          appliedFormulaCodes: (o.applied_formula_codes as string[]) ?? [],
        });
      } catch { continue; }
      for (const r of res.rows) {
        rows++;
        const c = classify(r);
        if (c.some((v) => v === null)) unreadable++;
        c.forEach((v, i) => { if (v) seenValue[i].add(v); });
        for (let i = 0; i < c.length; i++)
          for (let j = i + 1; j < c.length; j++)
            if (c[i] && c[j]) seenPair.add(`${i}:${c[i]}|${j}:${c[j]}`);
      }
    }
  }

  const allPairs: string[] = [];
  for (let i = 0; i < FACTORS.length; i++)
    for (let j = i + 1; j < FACTORS.length; j++)
      for (const a of FACTORS[i].values) for (const b of FACTORS[j].values) allPairs.push(`${i}:${a}|${j}:${b}`);

  console.log(`実データの網羅率 — 事業所 ${targets.length} / 月 ${MONTHS.join(" ")} / ★ ${rows} 行`);
  if (rows === 0) { console.log("★ FAIL 0 行です。網羅率は測れません。"); process.exit(1); }
  console.log(`  ⚠ 因子を読めなかった行: ${unreadable} 行 (要介護度 or サービス or 負担割合 が判定不能)\n`);

  console.log("── 値の網羅 (実データに 1 件でも出るか)");
  for (let i = 0; i < FACTORS.length; i++) {
    const miss = FACTORS[i].values.filter((v) => !seenValue[i].has(v));
    const mark = miss.length === 0 ? "  " : "★ ";
    console.log(`${mark}${FACTORS[i].name.padEnd(6)} ${FACTORS[i].values.length - miss.length}/${FACTORS[i].values.length}${miss.length ? `   ★ 出ない値: ${miss.join(" / ")}` : ""}`);
  }

  const covered = allPairs.filter((p) => seenPair.has(p));
  console.log(`\n── 2 因子ペアの網羅`);
  console.log(`   ${covered.length} / ${allPairs.length} = ★ ${((covered.length / allPairs.length) * 100).toFixed(1)}%`);
  console.log(`   ★ 実データに一度も出ない組合せ: ${allPairs.length - covered.length} 組`);

  // 出ないペアを因子の組ごとに集計 (どこが薄いかを見る)
  const gap = new Map<string, number>();
  for (const p of allPairs) {
    if (seenPair.has(p)) continue;
    const m = /^(\d+):.*\|(\d+):/.exec(p);
    if (!m) continue;
    const k = `${FACTORS[+m[1]].name} × ${FACTORS[+m[2]].name}`;
    gap.set(k, (gap.get(k) ?? 0) + 1);
  }
  console.log("\n── 薄いところ (出ないペアが多い因子の組)");
  for (const [k, v] of [...gap].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   ${k.padEnd(22)} ${v} 組`);

  console.log("\n⚠ 所要時間 (5 値) は ★ 未測定。サービス名からの読み取りは推測になるため。");
  console.log("   実際の網羅率はここより ★ 低い (因子が 1 つ増えると分母が増える)。");
}

main().catch((e) => { console.error(e); process.exit(1); });
