/**
 * 居宅介護支援 サンプルデータ検証 (担当 J / マーカー j) — SAMPLE_DATA_PROTOCOL.md §5
 *
 *   npx tsx scripts/kyotaku-sample-verify.mts
 *
 * migrations/seed_sample_kyotaku_j.mjs で投入した 2026-12 のサンプルを
 * **実アプリと同じローダ** (fetchKyotakuClaimRows) で読み、
 *   段1 算定・単位数  … 手計算した期待値と突合
 *   段2 伝送様式      … 8124 / 7111 の項番・恒等式
 * を**両方**確認する。出力は scratch (伝送データ/ には置かない)。
 *
 * ── 手計算 (単価 11.05 → ×100 = 1105。居宅介護支援費は 10割給付) ──
 *   総額 = floor(Σ単位 × 1105 / 100) / 保険請求額 = 総額 / 利用者負担 = 0
 * ────────────────────────────────────────────────────────
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildKeikakuhiFile, buildKyufuKanriFile, SERVICE_KIND_CODE,
  type KeikakuhiUser, type KyufuKanriUser } from "@/lib/kokuho-densou/build-kyotaku";
import { fetchKyotakuClaimRows } from "@/app/(authenticated)/billing/seikyu/_seikyu-context";

const MONTH_KEY = "2026-12";
const YEAR = 2026, MONTH = 12;
const OFFICE_NAME = "Ｈａｎａ居宅支援センター高品";
const OUT_DIR = process.env.SCRATCH_DIR ??
  "C:/Users/domen-PC/AppData/Local/Temp/claude/C--Users-domen-PC-Downloads---------/31bf862a-cdf3-4bba-8f37-0cc2e112febd/scratchpad";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

/** 段1 の期待値 (seed の memo と対応。単価 11.05 で手計算) */
const EXPECT: Record<string, { units: number; amount: number; codes: string[]; note: string }> = {
  ZJ001: { units: 1086, amount: 12000, codes: ["432111"], note: "基本のみ 要1" },
  ZJ002: { units: 1411, amount: 15591, codes: ["432211"], note: "基本のみ 要3" },
  ZJ003: { units: 1386, amount: 15315, codes: ["432111", "434001"], note: "初回加算300" },
  // 特定事業所加算Ⅱ = 434003 (421単位)。実伝送 8124 で 5,696 件使われている実コード
  //   (当初 434002 = Ⅰ と書いていたのは私の期待値の誤り。3-5 で実出力に寄せた)
  ZJ004: { units: 1870, amount: 20663, codes: ["432211", "434003", "436191"], note: "特定Ⅱ421 + 処遇38" },
  ZJ005: { units: 1661, amount: 18354, codes: ["432211", "436125"], note: "入院時情報連携Ⅰ250" },
  ZJ006: { units: 1536, amount: 16972, codes: ["432111", "436132"], note: "退院退所450" },
  ZJ007: { units: 408, amount: 4508, codes: ["436100", "436191"], note: "★基本コード無し (ターミナルのみ)" },
  ZJ008: { units: 1086, amount: 12000, codes: ["432111"], note: "公費併用" },
  ZJ009: { units: 1411, amount: 15591, codes: ["432211"], note: "公費単独 (H番号)" },
  ZJ011: { units: 543, amount: 6000, codes: ["432111", ""], note: "運営基準減算 (減算行はコード無し)" },
  ZJ012: { units: 1411, amount: 15591, codes: ["432211"], note: "給付管理3事業所" },
};
/** 転居は 1 人 2 レセプト。保険者ごとに同額 */
const EXPECT_TENKYO = { count: 2, unitsEach: 1086, amountEach: 12000 };

const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
const num = (s: string) => (s === "" ? 0 : Number(s));
const fails: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const { data: office, error: oe } = await sb.from("offices")
    .select("id, name, business_number, unit_price").eq("name", OFFICE_NAME).maybeSingle();
  if (oe) throw new Error(`事業所取得失敗: ${oe.message}`);
  if (!office) throw new Error(`事業所が無い: ${OFFICE_NAME}`);
  console.log(`=== 居宅介護支援 サンプル検証 ${MONTH_KEY} / ${office.name} (${office.business_number}) 単価 ${office.unit_price} ===\n`);

  // 実アプリと同じローダ
  const rows = await fetchKyotakuClaimRows(sb, MONTH_KEY, office.id, { excludeNonKokuho: true });
  const targets = rows.filter((r) => r.claimStatus !== "draft");
  console.log(`ローダが返したレセプト: ${rows.length} 件 (確定 ${targets.length})`);
  // ★ 「0件でした」を出す前に、拾えるはずの条件で動いていることを確かめる (規律 2章)
  if (rows.length === 0) {
    const { count } = await sb.from("kaigo_care_support_claims")
      .select("id", { count: "exact", head: true }).eq("billing_month", MONTH_KEY);
    throw new Error(`ローダが 0 件。DB には ${count} 件ある → ローダの条件を確認すること`);
  }

  // ── 段1: 算定・単位数 ────────────────────────────────────
  console.log("\n=== 段1. 算定・単位数 (手計算と突合) ===");
  const byNumber = new Map<string, typeof targets>();
  for (const r of targets) {
    const tag = /Z J?\w+/.exec("") ? "" : (r.user_name.match(/居宅サンプル(\d+)/)?.[0] ?? r.user_name);
    void tag;
  }
  // user_number でタグを引く
  const { data: cs, error: ce } = await sb.from("clients")
    .select("id, user_number, name").like("user_number", "ZJ%");
  if (ce) throw new Error(`利用者取得失敗: ${ce.message}`);
  const tagById = new Map((cs ?? []).map((c) => [c.id, c.user_number as string]));
  for (const r of targets) {
    const tag = tagById.get(r.user_id) ?? "?";
    if (!byNumber.has(tag)) byNumber.set(tag, [] as never);
    (byNumber.get(tag) as unknown as typeof targets).push(r);
  }
  console.log(`  タグ別: ${[...byNumber.entries()].map(([k, v]) => `${k}:${v.length}`).join(" ")}`);

  for (const [tag, exp] of Object.entries(EXPECT)) {
    const got = byNumber.get(tag);
    if (!got || got.length === 0) { check(false, `${tag} レセプトが取れない`, exp.note); continue; }
    if (got.length !== 1) { check(false, `${tag} レセプトが ${got.length} 件`, "1 件のはず"); continue; }
    const r = got[0];
    const diffs: string[] = [];
    if (r.totalUnits !== exp.units) diffs.push(`単位 ${r.totalUnits} ≠ ${exp.units}`);
    const amount = Math.floor((r.totalUnits * Math.round(office.unit_price * 100)) / 100);
    if (amount !== exp.amount) diffs.push(`総額 ${amount} ≠ ${exp.amount}`);
    const codes = r.lines.map((l) => l.code);
    for (const c of exp.codes) if (!codes.includes(c)) diffs.push(`コード ${c || "(空)"} が明細に無い (実際: ${codes.join(",")})`);
    check(diffs.length === 0, `${tag} ${exp.note}`, diffs.length ? diffs.join(" / ") : `${r.totalUnits}単位 ${amount}円`);
  }
  // 転居: 1 人 2 レセプト
  {
    const got = byNumber.get("ZJ010") ?? ([] as never as typeof targets);
    check(got.length === EXPECT_TENKYO.count, "ZJ010 ★転居は 1 人 2 レセプト", `${got.length} 件`);
    const insurers = new Set(got.map((r) => r.insurer_number));
    check(insurers.size === 2, "ZJ010 保険者が 2 種類", [...insurers].join(","));
    for (const r of got) {
      const amt = Math.floor((r.totalUnits * Math.round(office.unit_price * 100)) / 100);
      check(r.totalUnits === EXPECT_TENKYO.unitsEach && amt === EXPECT_TENKYO.amountEach,
        `ZJ010 ${r.insurer_number} の金額`, `${r.totalUnits}単位 ${amt}円`);
    }
  }

  // ── 段2: 伝送様式 ────────────────────────────────────────
  console.log("\n=== 段2. 伝送様式 (8124 / 7111) ===");
  const users: KeikakuhiUser[] = targets.map((u) => ({
    userName: u.user_name, insurerNumber: u.insurer_number ?? "", insuredNumber: u.insured_number ?? "",
    birthDate: u.birth_date, gender: u.gender, careLevel: u.care_level,
    certStart: u.certStart, certEnd: u.certEnd, requestDate: u.requestDate ?? null,
    serviceCode: u.serviceCode, units: u.totalUnits,
    lines: u.lines.map((l) => ({ code: l.code, units: l.units, count: l.count })),
    careManagerNumber: u.careManagerNumber, kohiTandoku: u.kohiTandoku, kohiHobetsu: u.kohiHobetsu,
    kohiFutanshaNumber: u.kohiFutansha, kohiJukyushaNumber: u.kohiJukyusha,
    midMonthInsurerChange: u.midMonthInsurerChange,
  }));
  const f = buildKeikakuhiFile(users, {
    officeNumber: office.business_number, year: YEAR, month: MONTH,
    unitPrice: office.unit_price, shoriYear: YEAR, shoriMonth: MONTH,
  });
  console.log(`  生成: ${f.fileName} (${f.dataRecordCount} レコード) / warning ${f.warnings.length} 件`);
  for (const w of f.warnings.slice(0, 8)) console.log(`     ⚠ ${w}`);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, f.fileName), f.content, "utf8");
  console.log(`  出力先 (scratch): ${join(OUT_DIR, f.fileName)}`);

  const lines = f.content.split(/\r?\n/).filter(Boolean).map((l) => l.split(","));
  const hoken = lines.find((c) => F(c, 1) === "7111" && F(c, 4) === "1");
  const kohi = new Map(lines.filter((c) => F(c, 1) === "7111" && F(c, 4) === "2").map((c) => [F(c, 5), c]));
  const byUser = new Map<string, string[][]>();
  for (const c of lines) {
    if (F(c, 1) !== "8124") continue;
    const k = F(c, 7);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k)!.push(c);
  }
  check(!!hoken, "7111 保険請求分が 1 本");
  // 恒等式: 7111 の件数・単位・費用 == 明細の合計 (公費単独を除く)
  const hokenUsers = users.filter((u) => !u.kohiTandoku);
  const expCount = hokenUsers.length;
  const expUnits = hokenUsers.reduce((s, u) => s + u.units, 0);
  const expCost = hokenUsers.reduce((s, u) => s + Math.floor((u.units * Math.round(office.unit_price * 100)) / 100), 0);
  check(num(F(hoken!, 7)) === expCount, "7111 項7 件数 == 保険請求分の人数", `${F(hoken!, 7)} / ${expCount}`);
  check(num(F(hoken!, 8)) === expUnits, "7111 項8 単位数 == Σ単位", `${F(hoken!, 8)} / ${expUnits}`);
  check(num(F(hoken!, 9)) === expCost, "7111 項9 費用合計 == Σ総額", `${F(hoken!, 9)} / ${expCost}`);
  check(num(F(hoken!, 10)) === expCost, "7111 項10 保険請求額 == 費用合計 (10割給付)", F(hoken!, 10));
  check(num(F(hoken!, 12)) === 0, "7111 項12 利用者負担 = 0 (10割給付)", F(hoken!, 12));

  // 8124: 各レセプトで 項21 == Σ項20 / 項22 == floor(項21 × 単価)
  let idOk = 0, amtOk = 0;
  for (const [insured, rs] of byUser) {
    const last = rs[rs.length - 1];
    const sum20 = rs.reduce((s, c) => s + num(F(c, 20)), 0);
    if (num(F(last, 21)) === sum20) idOk++;
    else fails.push(`8124 ${insured}: 項21 ${F(last, 21)} ≠ Σ項20 ${sum20}`);
    if (num(F(last, 22)) === Math.floor((sum20 * Math.round(office.unit_price * 100)) / 100)) amtOk++;
    else fails.push(`8124 ${insured}: 項22 ${F(last, 22)} ≠ floor(${sum20}×単価)`);
    if (F(last, 16) !== "99") fails.push(`8124 ${insured}: 最終行の行番号が 99 でない (${F(last, 16)})`);
  }
  check(idOk === byUser.size, "8124 全レセプトで 項21 == Σ項20", `${idOk} / ${byUser.size}`);
  check(amtOk === byUser.size, "8124 全レセプトで 項22 == floor(項21×単価)", `${amtOk} / ${byUser.size}`);

  // ★ 基本コード無し (ZJ007) が様式で落ちていないか
  {
    const zj007 = targets.find((r) => tagById.get(r.user_id) === "ZJ007");
    const rs = zj007 ? byUser.get(zj007.insured_number ?? "") : undefined;
    check(!!rs && rs.length === 2, "★ ZJ007 (基本コード無し) が 8124 に 2 行で出る", rs ? `${rs.length} 行` : "出ていない");
    if (rs) {
      const codes = rs.map((c) => F(c, 17));
      check(!codes.some((c) => c.startsWith("432")), "ZJ007 に基本コード(432xxx)が無い", codes.join(","));
      check(num(F(rs[rs.length - 1], 21)) === 408, "ZJ007 合計単位数 408", F(rs[rs.length - 1], 21));
    }
  }
  // ★ 公費単独 (ZJ009) は保険請求分に入らず公費請求分へ
  {
    const zj009 = targets.find((r) => tagById.get(r.user_id) === "ZJ009");
    check(!!zj009?.kohiTandoku, "ZJ009 が公費単独として解決されている", String(zj009?.kohiTandoku));
    const k12 = kohi.get("12");
    check(!!k12, "法別12 の公費請求分レコードがある", k12 ? `件数 ${F(k12, 7)}` : "なし");
  }
  // ★ 公費併用 (ZJ008) は 8124 項8/9 が空
  {
    const zj008 = targets.find((r) => tagById.get(r.user_id) === "ZJ008");
    const rs = zj008 ? byUser.get(zj008.insured_number ?? "") : undefined;
    if (rs) check(F(rs[0], 8) === "" && F(rs[0], 9) === "", "ZJ008 (公費併用) は 項8/9 が空",
      `[${F(rs[0], 8)}][${F(rs[0], 9)}]`);
    else check(false, "ZJ008 が 8124 に出ていない");
  }
  // ★ 転居 (ZJ010) は保険者違いの 2 明細
  {
    const zj010 = targets.filter((r) => tagById.get(r.user_id) === "ZJ010");
    const insureds = new Set(zj010.map((r) => r.insured_number ?? ""));
    const found = [...insureds].filter((i) => byUser.has(i));
    check(found.length === 2, "★ ZJ010 (転居) が 8124 に 2 明細", `${found.length} / 期待 2`);
  }

  // ── 段2b: 給付管理票 (8222) ────────────────────────────
  console.log("\n=== 段2b. 給付管理票 (8222) ===");
  {
    const ids = [...tagById.keys()];
    const { data: ben, error: be } = await sb.from("kaigo_benefit_management")
      .select("user_id, service_type, service_kind_code, shitei_kubun, provider_number, planned_units")
      .eq("billing_month", MONTH_KEY).in("user_id", ids);
    if (be) throw new Error(`給付管理の取得に失敗: ${be.message}`);
    const byU = new Map<string, NonNullable<typeof ben>>();
    for (const r of ben ?? []) {
      if (!byU.has(r.user_id)) byU.set(r.user_id, [] as never);
      byU.get(r.user_id)!.push(r);
    }
    console.log(`  給付管理行: ${(ben ?? []).length} 件 / 利用者 ${byU.size} 名`);
    check((ben ?? []).length === 3, "給付管理の行数 (ZJ012 の 3 事業所)", `${(ben ?? []).length}`);

    const kUsers: KyufuKanriUser[] = [];
    for (const [uid, rs] of byU) {
      const claim = targets.find((t) => t.user_id === uid);
      kUsers.push({
        userName: claim?.user_name ?? "", insurerNumber: claim?.insurer_number ?? "",
        insuredNumber: claim?.insured_number ?? "", birthDate: claim?.birth_date ?? null,
        gender: claim?.gender ?? null, careLevel: claim?.care_level ?? null,
        limitStart: claim?.certStart ?? null, limitEnd: claim?.certEnd ?? null,
        limitUnits: 30938, // 要介護4 の区分支給限度基準額
        careManagerNumber: claim?.careManagerNumber ?? null,
        lines: rs.map((r) => ({
          officeNumber: (r.provider_number ?? "").trim(),
          serviceKindCode: (r.service_kind_code ?? "").trim() || SERVICE_KIND_CODE[r.service_type] || "",
          shiteiKubun: r.shitei_kubun ?? null,
          plannedUnits: r.planned_units ?? 0,
        })),
      });
    }
    const k = buildKyufuKanriFile(kUsers, {
      officeNumber: office.business_number, year: YEAR, month: MONTH,
      unitPrice: office.unit_price, shoriYear: YEAR, shoriMonth: MONTH,
    });
    console.log(`  生成: ${k.fileName} (${k.dataRecordCount} レコード) / warning ${k.warnings.length} 件`);
    for (const w of k.warnings.slice(0, 4)) console.log(`     ⚠ ${w}`);
    writeFileSync(join(OUT_DIR, k.fileName), k.content, "utf8");
    const kl = k.content.split(/\r?\n/).filter(Boolean).map((l) => l.split(","));
    const det = kl.filter((c) => F(c, 1) === "8222" && F(c, 8) !== "99");
    const end = kl.find((c) => F(c, 1) === "8222" && F(c, 8) === "99");
    check(det.length === 3, "8222 明細 3 行 (事業所ごと)", `${det.length}`);
    check(!!end, "8222 終端行 (99) がある");
    if (end) {
      const sum = det.reduce((s2, c) => s2 + num(F(c, 20)), 0);
      check(num(F(end, 24)) === sum, "★ 8222 終端 項24 == Σ明細 項20", `${F(end, 24)} / Σ${sum}`);
      check(sum === 23000, "給付計画単位数の合計 = 12000+8000+3000", `${sum}`);
      check(num(F(end, 15)) === 30938, "終端 項15 = 区分支給限度基準額 (要介護4)", F(end, 15));
    }
    const offs = det.map((c) => F(c, 17));
    check(JSON.stringify(offs) === JSON.stringify([...offs].sort()), "明細は事業所番号の昇順", offs.join(" < "));
  }

  console.log(`\n${fails.length === 0 ? "すべて PASS" : `★ ${fails.length} 件 FAIL`}`);
  for (const x of fails) console.log(`  - ${x}`);
  if (fails.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
