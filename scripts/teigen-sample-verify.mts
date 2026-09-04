/**
 * 逓減制 ⅱ/ⅲ + 特定事業所加算Ⅰ/Ⅲ/A + 減算3種 サンプル検証 (担当 J / マーカー ZT##)
 *
 *   npx tsx scripts/teigen-sample-verify.mts
 *
 * migrations/seed_sample_teigen_j.mjs で投入した 2026-12 のサンプルを
 * **実アプリと同じローダ** (fetchKyotakuClaimRows) で読み、
 *   段1 算定・単位数  … 手計算した期待値と突合
 *   段2 伝送様式      … 8124 (項21/項22) / 7111 の項番・恒等式
 * を確認する。
 *
 * ── なぜこれを入れるか (2026-09-04 H の実測) ──
 *   居宅介護支援の実データ 5,597 行のうち 逓減ⅱ/ⅲ 0件・特定事業所ⅠⅢA 0件・
 *   減算3種すべて0件。5,597行あっても実際に通っているパターンは1つだけだった。
 *   このサンプルで初めて 集計→伝送 の下流経路を通す。
 *
 * ★ この検査が証明しないこと (ルール 3-1):
 *   - 逓減 tier の**判定アルゴリズム自体** (claims-content.tsx の 5-g/5-h ブロック)。
 *     ★ ここでは「tier がⅱ/ⅲの claim が既にある状態」を直接作って下流だけを見る。
 *     判定アルゴリズムは kyotaku-teigen-verify.mts / verify_teigen_logic.mts で別途検証済み
 *   - 8222 (給付管理票) — 逓減/特定事業所加算/減算は居宅介護支援費(8124/7111)側の値で、
 *     8222 (他サービスの限度額管理) には影響しないため対象外
 *   - 予防(46) — 本日 9678c7e/d2ab274 で別セットとして既に全PASS済み。重複回避のため対象外
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildKeikakuhiFile, type KeikakuhiUser } from "@/lib/kokuho-densou/build-kyotaku";
import { fetchKyotakuClaimRows } from "@/app/(authenticated)/billing/seikyu/_seikyu-context";

const MONTH_KEY = "2026-12";
const YEAR = 2026, MONTH = 12;
const OFFICE_NAME_MARK = "テスト逓減・加算事業所 [sample-j-teigen-20260904]";
const OFFICE_BUSINESS_NUMBER = "9999900001";
const UNIT_PRICE = 11.05;

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

/** 段1/段2 共通の期待値 (seed と対応。単価 11.05 で node 二重検算済み) */
const EXPECT: Record<string, { units: number; amount: number; codes: string[]; level: string; note: string }> = {
  ZT01: { units: 1086, amount: 12000, codes: ["432111"], level: "要介護1", note: "パディングⅰ" },
  ZT09: { units: 544, amount: 6011, codes: ["433111"], level: "要介護2", note: "★逓減ⅱ境界 light" },
  ZT10: { units: 704, amount: 7779, codes: ["433211"], level: "要介護4", note: "逓減ⅱ heavy" },
  ZT11: { units: 544, amount: 6011, codes: ["433111"], level: "要介護1", note: "逓減ⅱ追加点" },
  ZT12: { units: 326, amount: 3602, codes: ["434111"], level: "要介護2", note: "★逓減ⅲ境界 light" },
  ZT13: { units: 422, amount: 4663, codes: ["434211"], level: "要介護5", note: "逓減ⅲ heavy" },
  ZT14: { units: 1605, amount: 17735, codes: ["432111", "434002"], level: "要介護1", note: "★特定事業所Ⅰ" },
  ZT15: { units: 1409, amount: 15569, codes: ["432111", "434004"], level: "要介護1", note: "★特定事業所Ⅲ" },
  ZT16: { units: 1200, amount: 13260, codes: ["432111", "434006"], level: "要介護1", note: "★特定事業所A" },
  ZT17: { units: 1075, amount: 11878, codes: ["432111", ""], level: "要介護1", note: "★BCP未策定減算" },
  ZT18: { units: 1075, amount: 11878, codes: ["432111", ""], level: "要介護1", note: "★虐待防止未実施減算" },
  ZT19: { units: 543, amount: 6000, codes: ["432111", ""], level: "要介護1", note: "★運営基準減算" },
};
/** 要介護状態区分コード (8124 項12) */
const CARE_CODE: Record<string, string> = { 要介護1: "21", 要介護2: "22", 要介護4: "24", 要介護5: "25" };

const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
const num = (s: string) => (s === "" ? 0 : Number(s));
const fails: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const { data: office, error: oe } = await sb.from("offices")
    .select("id, name, business_number, unit_price").eq("name", OFFICE_NAME_MARK).maybeSingle();
  if (oe) throw new Error(`事業所取得失敗: ${oe.message}`);
  if (!office) throw new Error(`テスト事業所が無い (seed_sample_teigen_j.mjs --execute を先に実行すること)`);
  check(office.business_number === OFFICE_BUSINESS_NUMBER, "テスト事業所番号が想定どおり", office.business_number);
  check(Number(office.unit_price) === UNIT_PRICE, "単価 11.05 (3級地)", String(office.unit_price));
  console.log(`=== 逓減・特定事業所加算・減算 サンプル検証 ${MONTH_KEY} / ${office.name} ===\n`);

  const { data: cs, error: ce } = await sb.from("clients")
    .select("id, user_number, name").like("user_number", "ZT%");
  if (ce) throw new Error(`利用者取得失敗: ${ce.message}`);
  const tagById = new Map((cs ?? []).map((c) => [c.id, c.user_number as string]));
  console.log(`サンプル利用者: ${tagById.size} 名 (期待19名)`);
  check(tagById.size === 19, "投入件数が19名", String(tagById.size));

  // ── 段1: 算定・単位数 (実アプリと同じローダ) ────────────────────────
  console.log("\n=== 段1. 算定・単位数 (fetchKyotakuClaimRows) ===");
  const rows = (await fetchKyotakuClaimRows(sb as never, MONTH_KEY, office.id, { excludeNonKokuho: true }))
    .filter((r) => tagById.has(r.user_id));
  // ★ 「0件でした」の前に、拾えるはずの条件で動くことを確かめる (規律 2章)
  if (rows.length === 0) {
    const { count } = await sb.from("kaigo_care_support_claims")
      .select("id", { count: "exact", head: true }).eq("billing_month", MONTH_KEY);
    throw new Error(`ローダが0件。DB全体には${count}件ある → ローダの条件を確認すること`);
  }
  check(rows.length === 19, "ローダが19件を返す", `${rows.length} 件`);

  const byTag = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byTag.set(tagById.get(r.user_id) ?? "?", r);
  for (const [tag, exp] of Object.entries(EXPECT)) {
    const r = byTag.get(tag);
    if (!r) { check(false, `${tag} レセプトが取れない`, exp.note); continue; }
    const diffs: string[] = [];
    if (r.totalUnits !== exp.units) diffs.push(`単位 ${r.totalUnits} ≠ ${exp.units}`);
    const amount = Math.floor((r.totalUnits * Math.round(UNIT_PRICE * 100)) / 100);
    if (amount !== exp.amount) diffs.push(`総額 ${amount} ≠ ${exp.amount}`);
    if (r.care_level !== exp.level) diffs.push(`要介護度 "${r.care_level}" ≠ "${exp.level}"`);
    const codes = r.lines.map((l) => l.code);
    if (codes.join(",") !== exp.codes.join(",")) diffs.push(`コード [${codes}] ≠ [${exp.codes}]`);
    check(diffs.length === 0, `${tag} ${exp.note}`,
      diffs.length ? diffs.join(" / ") : `${r.totalUnits}単位 ${amount}円 [${codes}]`);
  }
  // パディング (ZT01-08) が全部同一 (ⅰ) であることも確認
  const padding = ["ZT02", "ZT03", "ZT04", "ZT05", "ZT06", "ZT07", "ZT08"]
    .map((t) => byTag.get(t)?.totalUnits);
  check(padding.every((u) => u === 1086), "パディング7名も全員1086単位 (ⅰ)", padding.join(","));

  // ── 段2: 伝送様式 (8124 / 7111) ────────────────────────────
  console.log("\n=== 段2. 伝送様式 (8124 / 7111) ===");
  const toUser = (r: (typeof rows)[number]): KeikakuhiUser => ({
    userName: r.user_name, insurerNumber: r.insurer_number ?? "", insuredNumber: r.insured_number ?? "",
    birthDate: r.birth_date, gender: r.gender, careLevel: r.care_level,
    certStart: r.certStart, certEnd: r.certEnd, requestDate: r.requestDate ?? null,
    serviceCode: r.serviceCode, units: r.totalUnits,
    lines: r.lines.map((l) => ({ code: l.code, units: l.units, count: l.count })),
    careManagerNumber: r.careManagerNumber,
    kohiTandoku: r.kohiTandoku, kohiHobetsu: r.kohiHobetsu,
    kohiFutanshaNumber: r.kohiFutansha, kohiJukyushaNumber: r.kohiJukyusha,
    midMonthInsurerChange: r.midMonthInsurerChange,
  });
  const opts = { officeNumber: OFFICE_BUSINESS_NUMBER, year: YEAR, month: MONTH,
    unitPrice: UNIT_PRICE, shoriYear: YEAR + 1, shoriMonth: 1 };
  const built = buildKeikakuhiFile(rows.map(toUser), opts);
  const lines = built.content.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split(","));
  const rec8124 = lines.filter((c) => F(c, 1) === "8124");
  const rec7111 = lines.filter((c) => F(c, 1) === "7111");
  console.log(`  生成: 8124 ${rec8124.length} 行 / 7111 ${rec7111.length} 行 / ファイル名 ${built.fileName}`);
  // ★ 長さの検査を先に置く (空配列に every は必ず通る — 規律 2章⑪)
  if (rec8124.length === 0 || rec7111.length === 0) throw new Error("★ 明細/請求書が0行。以降の検査は意味を持たない");
  console.log(`  builder の警告 ${built.warnings.length} 件`);
  for (const w of built.warnings) console.log(`    - ${w}`);
  check(built.warnings.length === 0, "警告0件 (逓減/特定事業所/減算いずれも正常系)", `${built.warnings.length} 件`);

  for (const [tag, exp] of Object.entries(EXPECT)) {
    const r = byTag.get(tag);
    if (!r) continue;
    const mine = rec8124.filter((c) => F(c, 7) === (r.insured_number ?? ""));
    if (mine.length === 0) { check(false, `${tag} 8124が出ていない`); continue; }
    const last = mine[mine.length - 1];
    const diffs: string[] = [];
    if (F(last, 16) !== "99") diffs.push(`最終行の行番号 ${F(last, 16)} ≠ 99`);
    if (F(last, 12) !== CARE_CODE[exp.level]) diffs.push(`要介護度コード ${F(last, 12)} ≠ ${CARE_CODE[exp.level]}`);
    if (num(F(last, 21)) !== exp.units) diffs.push(`項21 合計単位 ${F(last, 21)} ≠ ${exp.units}`);
    if (num(F(last, 22)) !== exp.amount) diffs.push(`項22 請求金額 ${F(last, 22)} ≠ ${exp.amount}`);
    const sum20 = mine.reduce((s, c) => s + num(F(c, 18)) * num(F(c, 19)), 0);
    if (sum20 !== num(F(last, 21))) diffs.push(`Σ(項18×項19)=${sum20} ≠ 項21 ${F(last, 21)}`);
    check(diffs.length === 0, `${tag} 8124 (${mine.length}行) ${exp.note}`,
      diffs.length ? diffs.join(" / ") : `要介護度${F(last, 12)} ${F(last, 21)}単位 ${F(last, 22)}円`);
  }

  // 特定事業所加算・減算の明細行が実際に出ているか (コード/単位を直接見る)
  const tokuteiCases: [string, string, number][] = [["ZT14", "434002", 519], ["ZT15", "434004", 323], ["ZT16", "434006", 114]];
  for (const [tag, code, units] of tokuteiCases) {
    const r = byTag.get(tag)!;
    const mine = rec8124.filter((c) => F(c, 7) === (r.insured_number ?? ""));
    const line = mine.find((c) => F(c, 17) === code);
    check(!!line && num(F(line!, 18)) === units, `${tag} 特定事業所加算コード ${code} が ${units}単位で出る`,
      line ? `項18=${F(line, 18)}` : "行が見つからない");
  }
  const reductionCases = ["ZT17", "ZT18", "ZT19"];
  for (const tag of reductionCases) {
    const r = byTag.get(tag)!;
    const mine = rec8124.filter((c) => F(c, 7) === (r.insured_number ?? ""));
    const negLine = mine.find((c) => num(F(c, 18)) < 0);
    check(!!negLine, `${tag} 減算行 (負の単位数) が明細に出る`, negLine ? `項18=${F(negLine, 18)}` : "行が見つからない");
  }

  // 7111 の恒等式
  const hoken = rec7111.filter((c) => F(c, 4) === "1");
  check(hoken.length === 1, "7111 保険請求分", `${hoken.length} 行`);
  if (hoken.length === 1) {
    const h = hoken[0];
    const expCount = rows.length;
    const expUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
    const expAmt = rows.reduce((s, r) => s + Math.floor((r.totalUnits * Math.round(UNIT_PRICE * 100)) / 100), 0);
    const diffs: string[] = [];
    if (num(F(h, 7)) !== expCount) diffs.push(`件数 ${F(h, 7)} ≠ ${expCount}`);
    if (num(F(h, 8)) !== expUnits) diffs.push(`単位数 ${F(h, 8)} ≠ ${expUnits}`);
    if (num(F(h, 9)) !== expAmt) diffs.push(`費用合計 ${F(h, 9)} ≠ ${expAmt}`);
    if (num(F(h, 10)) !== expAmt) diffs.push(`保険請求額 ${F(h, 10)} ≠ ${expAmt} (10割給付)`);
    if (num(F(h, 12)) !== 0) diffs.push(`利用者負担 ${F(h, 12)} ≠ 0`);
    check(diffs.length === 0, "7111 の恒等式", diffs.length ? diffs.join(" / ") : `${expCount}件 ${expUnits}単位 ${expAmt}円`);
  }

  // ── 負のコントロール (ルール 3-9) ────────────────────────────
  console.log("\n=== 負のコントロール (検査が動いていることの確認) ===");
  {
    const zt09 = byTag.get("ZT09")!;
    const before = fails.length;
    check(zt09.totalUnits === 999, "★ わざと誤った期待値 (999単位) — 落ちるはず", `実際 ${zt09.totalUnits}`);
    const caught = fails.length === before + 1;
    console.log(`  ${caught ? "OK" : "✗"} 検査は${caught ? "生きている" : "動いていない"}`);
    if (caught) fails.pop(); else fails.push("負のコントロール1が機能しない");
  }
  {
    // 要介護度を ⅲ→ⅰ 相当に変えると 項12 が動くか (build-kyotaku側の負のコントロール)
    const zt12 = byTag.get("ZT12")!;
    const probe = buildKeikakuhiFile([{ ...toUser(zt12), careLevel: "要介護5" }], opts);
    const pl = probe.content.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(","))
      .filter((c) => F(c, 1) === "8124");
    const moved = F(pl[pl.length - 1], 12) !== CARE_CODE[zt12.care_level ?? ""];
    check(moved, "要介護度を変えると項12が動く (検査は生きている)",
      `${CARE_CODE[zt12.care_level ?? ""]} → ${F(pl[pl.length - 1], 12)}`);
  }
  {
    // 制度混在チェック (46/43の別実装済み検査) が この居宅サンプルでは鳴らないことを確認
    // (43系のみで構成されているので、誤って鳴っていないか = 過検出が無いことの確認)
    const anyMixWarning = built.warnings.some((w) => w.includes("別サービス種類"));
    check(!anyMixWarning, "居宅(43)のみの構成では制度混在の警告が誤って鳴らない", String(anyMixWarning));
  }

  console.log(`\n${"=".repeat(60)}`);
  if (fails.length === 0) console.log(`✅ 全 PASS`);
  else { console.log(`✗ ${fails.length} 件 FAIL`); for (const f of fails) console.log(`   - ${f}`); }
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
