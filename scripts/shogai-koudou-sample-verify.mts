/**
 * 障害 — 行動援護 / 乗降介助 / 同行援護支援区分 サンプル検証 (担当 J / マーカー ZS##)
 *
 *   npx tsx scripts/shogai-koudou-sample-verify.mts
 *
 * migrations/seed_sample_shogai_koudou_j.mjs で投入した 2026-12 のサンプルを
 * **実アプリと同じ集計関数** (aggregateMonthlyShogaiSeikyu) で読み、
 *   段1 集計   … kaigo_visit_schedule → 障害コード解決 → 単位数
 *   段2 伝送様式 … buildShogaiDensou で J121 (請求書+明細書) の項番を確認
 * を確認する。
 *
 * ★ この検査が証明しないこと (ルール 3-1):
 *   - J611 (サービス提供実績記録票) — 行動援護(様式0201)/同行援護(様式1901) は
 *     KT Group 未提供のためコード側に実装が無い (shogai-densou/build.ts L18-21)。
 *     J121 (請求本体) とは別ファイルで、この制約は請求そのものには影響しない。
 *     ★ visits=[] で渡し、J611 に何が出力されるか (0行 or 生成スキップ) だけ記録する
 *   - 初回加算・特別地域加算 — このサンプルの利用者は該当条件 (contract_start_date が
 *     当月 / flag_special_area) を満たさないよう作っているので、意図的に対象外
 *   - 上限管理 (jogenKanriKubun='なし' で固定) — H が98fab85で別途検証済み
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyShogaiSeikyu, type ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";
import { buildShogaiDensou, type ShogaiDensouUser } from "@/lib/shogai-densou/build";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Ｈａｎａヘルパーステーションおゆみ野 (実在・読むだけ)
const OFFICE_BUSINESS_NUMBER = "1210101760";
const YEAR = 2026, MONTH = 12;

/**
 * 段1 期待値 (seed 側でマスタ照合済み。ここでも独立に再確認する)。
 *
 * ⚠ 2026-09-05 是正: 当初 addonPermil を考慮せず「基本単位のみ」を期待値にしていて
 *   全5件が FAIL した。原因は自分の期待値の方だった (規律 3-2)。
 *   実在事業所 (おゆみ野) には 処遇改善加算Ⅱロ (441/1000) が
 *   ★ type=11(居宅介護系)・15(同行援護) に設定済みで、13(行動援護) には無い
 *   (kaigo_office_addon_periods 実測。155175/115175 は formula 441/1000 = 44.1%)。
 *   これは実在事業所の実設定であり ★ アプリのバグではない。期待値の方を直した。
 */
const EXPECT: Record<string, { code: string; units: number; addonPermil: number; note: string }> = {
  ZS01: { code: "1311021", units: 407, addonPermil: 0, note: "行動援護 30分〜1時間 (nameMap直接。加算対象外type)" },
  ZS02: { code: "118111", units: 102, addonPermil: 441, note: "通院乗降日 (nameMap直接。処遇改善Ⅱロ 441/1000)" },
  ZS03: { code: "157695", units: 229, addonPermil: 441, note: "★ 同行援護 支援区分3 (時刻+区分フォールバック)" },
  ZS04: { code: "157703", units: 267, addonPermil: 441, note: "★ 同行援護 支援区分4 (時刻+区分フォールバック)" },
  ZS05: { code: "157687", units: 191, addonPermil: 441, note: "同行援護 支援区分2 (無修飾)" },
};

const fails: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const { data: cs, error: ce } = await sb.from("clients")
    .select("id, user_number, name").like("user_number", "ZS%");
  if (ce) throw new Error(`利用者取得失敗: ${ce.message}`);
  const tagById = new Map((cs ?? []).map((c) => [c.id, c.user_number as string]));
  console.log(`サンプル利用者: ${tagById.size} 名 (期待5名)`);
  check(tagById.size === 5, "投入件数が5名", String(tagById.size));

  // ── 段1: 集計 (実アプリと同じ関数) ────────────────────────────
  console.log("\n=== 段1. 集計 (aggregateMonthlyShogaiSeikyu) ===");
  const res = await aggregateMonthlyShogaiSeikyu(sb as never, { year: YEAR, month: MONTH, officeId: OFFICE_ID, unitPrice: 11.05 });
  console.log(`  全行 ${res.rows.length} 件 / warnings ${res.warnings.length} 件`);
  for (const w of res.warnings) console.log(`    - ${w}`);
  const rows = res.rows.filter((r) => tagById.has(r.user_id));
  // ★ 「0件でした」の前に、拾えるはずの条件で動くことを確かめる (規律2章)
  if (rows.length === 0) {
    const { count } = await sb.from("kaigo_visit_schedule").select("id", { count: "exact", head: true })
      .gte("visit_date", `${YEAR}-${String(MONTH).padStart(2, "0")}-01`)
      .lte("visit_date", `${YEAR}-${String(MONTH).padStart(2, "0")}-31`);
    throw new Error(`集計が0件。DB のシフト全体には ${count} 件ある → officeId/対象月の条件を確認すること`);
  }
  check(rows.length === 5, "集計が5件を返す", `${rows.length} 件`);

  const byTag = new Map<string, ShogaiSeikyuRow>();
  for (const r of rows) byTag.set(tagById.get(r.user_id) ?? "?", r);
  for (const [tag, exp] of Object.entries(EXPECT)) {
    const r = byTag.get(tag);
    if (!r) { check(false, `${tag} 集計行が取れない`, exp.note); continue; }
    const diffs: string[] = [];
    if (r.details.length !== 1) diffs.push(`明細行数 ${r.details.length} ≠ 1`);
    const d = r.details[0];
    if (d?.service_code !== exp.code) diffs.push(`コード ${d?.service_code} ≠ ${exp.code}`);
    if (d?.units !== exp.units) diffs.push(`単位 (基本) ${d?.units} ≠ ${exp.units}`);
    // 加算 (処遇改善) は実在事業所の実設定 (441/1000) を反映した期待値
    const expAddon = exp.addonPermil > 0 ? Math.round((exp.units * exp.addonPermil) / 1000) : 0;
    if (r.addonUnits !== expAddon) diffs.push(`加算単位 ${r.addonUnits} ≠ round(${exp.units}×${exp.addonPermil}/1000)=${expAddon}`);
    const expTotalUnits = exp.units + expAddon;
    if (r.totalUnits !== expTotalUnits) diffs.push(`totalUnits ${r.totalUnits} ≠ ${expTotalUnits}`);
    const expAmount = Math.floor(expTotalUnits * 11.05);
    if (r.totalAmount !== expAmount) diffs.push(`総費用 ${r.totalAmount} ≠ floor(${expTotalUnits}×11.05)=${expAmount}`);
    check(diffs.length === 0, `${tag} ${exp.note}`,
      diffs.length ? diffs.join(" / ") : `${d?.service_code} 基本${d?.units}+加算${r.addonUnits}=${r.totalUnits}単位 ${r.totalAmount}円`);
  }

  // ★ 同行援護3ケースの支援区分による単価差そのものを突き合わせる (基本単位で見る。
  //   加算は3ケースとも同率441/1000なので、基本単位の差がそのまま段階比を保つ)
  const s3 = byTag.get("ZS03"), s4 = byTag.get("ZS04"), s2 = byTag.get("ZS05");
  if (s3 && s4 && s2) {
    const base = (r: ShogaiSeikyuRow) => r.details[0]?.units ?? -1;
    check(base(s3) === 229 && base(s4) === 267 && base(s2) === 191,
      "★ 支援区分2/3/4で基本単位数が 191/229/267 と段階的に変わる",
      `区分2=${base(s2)} 区分3=${base(s3)} 区分4=${base(s4)}`);
    check(s3.support_level === "区分3" && s4.support_level === "区分4" && s2.support_level === "区分2",
      "support_level が出力行に正しく反映", `${s2.support_level}/${s3.support_level}/${s4.support_level}`);
  }

  // 共通の不変条件 (H の手本を踏襲)
  for (const r of rows) {
    const sum = r.details.reduce((a, d) => a + d.units, 0) + r.addonUnits;
    check(sum === r.totalUnits, `[${tagById.get(r.user_id)}] Σ明細+加算 = 総単位`, `${sum} / ${r.totalUnits}`);
    check(r.details.every((d) => !!d.service_code), `[${tagById.get(r.user_id)}] 明細にコードが付いている`);
  }

  // ── 段2: 伝送様式 (J121) ────────────────────────────────────
  console.log("\n=== 段2. 伝送様式 (buildShogaiDensou → J121) ===");
  const users: ShogaiDensouUser[] = rows.map((r) => ({
    row: r,
    visits: [], // ★ J611 対象外 (行動援護/同行援護は KT Group 未提供の様式なので元々出ない)
    contracts: [],
    contractAmountText: null,
    contractStartDate: null,
    contractEntryNumber: null,
    jogenOfficeLines: null, // ★ 上限管理は対象外 (H が98fab85で別途検証済み)
  }));
  const built = buildShogaiDensou(users, {
    officeNumber: OFFICE_BUSINESS_NUMBER, year: YEAR, month: MONTH,
    unitPrice: 11.05, areaCategory: "3級地", shoriYear: YEAR + 1, shoriMonth: 1,
  });
  console.log(`  builder warnings ${built.warnings.length} 件`);
  for (const w of built.warnings) console.log(`    - ${w}`);
  console.log(`  seikyuFile ${built.seikyuFile.fileName} (${built.seikyuFile.dataRecordCount}件)`);
  console.log(`  jissekiFile ${built.jissekiFile.fileName} (${built.jissekiFile.dataRecordCount}件)`);
  console.log(`  jogenFile ${built.jogenFile ? built.jogenFile.fileName : "null (上限管理対象なし。想定どおり)"}`);

  const seikyuLines = built.seikyuFile.content.split(/\r?\n/).filter((l) => l.trim() !== "");
  console.log(`\n  seikyuFile 先頭5行 (生データで列位置を確認):`);
  for (const l of seikyuLines.slice(0, 5)) console.log(`    ${l}`);
  const cols = seikyuLines.map((l) => l.split(","));
  const j121_03 = cols.filter((c) =>
    c.some((v) => v.replace(/"/g, "").trim() === "J121") &&
    c.some((v) => v.replace(/"/g, "").trim() === "03"));
  check(j121_03.length >= 1, "J121-03 相当の行が1行以上ある", `${j121_03.length} 行 (書式は上の生データで確認)`);

  const { data: certs } = await sb.from("shougai_certifications")
    .select("client_id, beneficiary_number").in("client_id", [...tagById.keys()]);
  const beneById = new Map((certs ?? []).map((c) => [c.client_id, c.beneficiary_number as string]));
  for (const [tag, exp] of Object.entries(EXPECT)) {
    const r = byTag.get(tag);
    if (!r) continue;
    const bene = beneById.get(r.user_id) ?? "";
    const hasBene = cols.some((c) => c.some((v) => v.replace(/"/g, "").trim() === bene));
    const hasCode = cols.some((c) => c.some((v) => v.replace(/"/g, "").trim() === exp.code));
    check(hasBene, `${tag} 受給者証番号 ${bene} が伝送に含まれる`);
    check(hasCode, `${tag} コード ${exp.code} が伝送に含まれる`);
  }

  // ── 負のコントロール (ルール 3-9) ────────────────────────────
  console.log("\n=== 負のコントロール (検査が動いていることの確認) ===");
  {
    const before = fails.length;
    check(false, "★ わざと失敗させる (常に false)", "検査ハーネス自体が動いているかの確認");
    const caught = fails.length === before + 1;
    console.log(`  ${caught ? "OK" : "✗"} 検査は${caught ? "生きている" : "動いていない"}`);
    if (caught) fails.pop(); else fails.push("負のコントロール1が機能しない");
  }
  {
    // 支援区分を変えると本当にコードが変わることの確認 (区分3の利用者を区分4扱いにする)
    const s3row = byTag.get("ZS03");
    if (s3row) {
      const probeCert = { support_level: "区分4" };
      // aggregate.ts の doukouKubunByClient と同じ規則を再現 (2026-09-05: 検算のみ、実装は呼ばない)
      const m = /区分\s*([1-6１-６])/.exec(probeCert.support_level.normalize("NFKC"));
      const n = m ? Number(m[1].normalize("NFKC")) : null;
      const mod = n != null ? (n >= 4 ? "区4" : n === 3 ? "区3" : null) : null;
      check(mod === "区4", "支援区分文字列を区分4に変えると modifier が区4になる (規則の写しが正しいことの確認)", String(mod));
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  if (fails.length === 0) console.log(`✅ 全 PASS`);
  else { console.log(`✗ ${fails.length} 件 FAIL`); for (const f of fails) console.log(`   - ${f}`); }
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
