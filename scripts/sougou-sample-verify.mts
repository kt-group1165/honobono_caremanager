/**
 * 総合事業 サンプル (seed_sample_sougou_g.mjs) の再現可能な検証 — 段1(算定) + 段2(伝送様式)
 *
 *   node migrations/seed_sample_sougou_g.mjs --execute   # 先に投入
 *   npx tsx scripts/sougou-sample-verify.mts
 *   node migrations/seed_sample_sougou_g.mjs --delete --execute   # 撤去
 *
 * ── なぜ要るか (claude-06 割当・2026-09-05) ────────────────────────────────
 *   commit `71b3011` (2026-09-03 / G) で「限度額ちょうど/超過」等を投入→検証→撤去
 *   したが、★ 検証は ad-hoc で npm script が1本も残っていなかった。
 *   → 「一度の調査を常設の検査に変える」の逆側の実例 (再現手段が無い)。
 *   commit メッセージに残っていた数値・構造をもとにこの script を起こした。
 *
 * ⚠ commit時点の「1489単位」等の絶対値はマスタ改定で変わりうるため丸写ししない。
 *   期待値は seed_sample_sougou_g.mjs と同じ実行時のマスタ参照で導出し、
 *   commit メッセージの「構造的な主張」(限度額ちょうど→超過0 / -1→超過1単位 / 保険者2分割 /
 *   7113 と明細の合計一致 / レコード種別01・02・10 が出る) を検算する。
 *
 * ★ サンプル未投入のときは「合格」と言わない (verify-jogen-kanri.mts と同じ規律)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateSougouSeikyu } from "@/lib/visit-seikyu/aggregate-sougou";
import { buildSougouDensou } from "@/lib/kokuho-densou/build-sougou";

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TAG = "G";
const OFFICE_ID = "4015f747-4f75-4769-a1f2-dca3db6a24fc"; // リンクスヘルパーステーションいすみ
const OFFICE_NUMBER_122382 = "12A8600011"; // office_sougou_numbers (保険者122382)
const OFFICE_NUMBER_FALLBACK = "1278600398"; // 事業所の介護番号 (保険者122184の登録なし → フォールバック)
const YEAR = 2026, MONTH_NUM = 12;

let fails = 0, checks = 0;
const check = (label: string, cond: boolean, detail = "") => {
  checks++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fails++;
};

async function main() {
  console.log("総合事業サンプル (seed_sample_sougou_g) 段1+段2 検証\n");

  const { data: clients, error: cErr } = await sb
    .from("clients").select("id, user_number, care_level, insurer_number")
    .like("user_number", `Z${TAG}%`).order("user_number");
  if (cErr) throw new Error(`clients 取得失敗: ${cErr.message}`);
  console.log(`【分母】clients ${clients?.length ?? 0} 件 (期待 6件・ZG001-006)`);
  if (!clients || clients.length === 0) {
    console.log("⚠ 分母 0 — サンプル未投入。**合格でも不合格でもありません**。");
    console.log("   node migrations/seed_sample_sougou_g.mjs --execute で投入してください");
    process.exit(0);
  }
  if (clients.length !== 6) {
    console.log(`✗ サンプルが揃っていません (${clients.length}/6)。--delete --execute → --execute で入れ直してください`);
    process.exit(1);
  }
  const byUn = new Map(clients.map((c) => [c.user_number, c]));

  const { data: sched, error: sErr } = await sb
    .from("kaigo_visit_schedule").select("user_id, service_type, visit_date")
    .in("user_id", clients.map((c) => c.id)).eq("system", "総合事業").eq("status", "completed");
  if (sErr) throw new Error(`kaigo_visit_schedule 取得失敗: ${sErr.message}`);

  // ══ 段1: 算定 ══
  console.log("\n=== 段1: 算定 (aggregateSougouSeikyu) ===");
  const { rows } = await aggregateSougouSeikyu(sb, sched ?? [], {
    officeId: OFFICE_ID, year: YEAR, month: MONTH_NUM, unitPrice: 10, effectiveFormulaCodes: [],
  });
  check("集計行 6件", rows.length === 6, `${rows.length}`);
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  const zg = (no: string) => byId.get(byUn.get(no)!.id);

  // ZG005 限度額ちょうど → 超過0 / ZG006 限度額-1 → 超過1単位
  const r5 = zg("ZG005"), r6 = zg("ZG006");
  check("★ ZG005 限度額ちょうど → 超過0単位", r5?.overUnits === 0, `overUnits=${r5?.overUnits}`);
  check("★ ZG006 限度額-1 → 超過1単位", r6?.overUnits === 1, `overUnits=${r6?.overUnits}`);
  if (r6) {
    check("★ ZG006 超過1単位 = 自費 floor(1×単価)", r6.selfPayAmount === Math.floor((1 * Math.round(10 * 100)) / 100),
      `selfPayAmount=${r6.selfPayAmount}`);
  }
  // ⚠ 限度額超過の警告は aggregateSougouSeikyu ではなく buildSougouDensou 側で出る
  // (2026-09-05 に自分の sougou-jusho-carelevel-verify.mts で一度踏んだのと同じ勘違い)
  // ZG004: 1回につきコード×9回 (回数で単位が変わることの確認) — 恒等式 totalUnits = baseUnits の倍数性
  const r4 = zg("ZG004");
  check("ZG004 集計行がある", !!r4);
  // ZG002: 保険者=登録なし(122184)でもエラーにならず集計できる (フォールバック経路)
  const r2 = zg("ZG002");
  check("ZG002 (保険者122184・登録なし) も集計できる", !!r2 && r2.insurer_number === "122184",
    `insurer_number=${r2?.insurer_number}`);

  // ══ 段2: 伝送様式 (保険者ごとに2ファイルへ分割) ══
  console.log("\n=== 段2: 伝送様式 (71R1/7113・保険者2分割) ===");
  const group122382 = rows.filter((r) => r.insurer_number === "122382"); // 登録あり
  const group122184 = rows.filter((r) => r.insurer_number === "122184"); // 登録なし→フォールバック
  check("保険者122382 (登録あり) の対象者数", group122382.length === 4, `${group122382.length} (期待4: ZG001/003/005/006)`);
  check("保険者122184 (登録なし) の対象者数", group122184.length === 2, `${group122184.length} (期待2: ZG002/004)`);

  const F = (c: string[], n: number) => (c[n + 1] ?? "").replace(/"/g, "").trim();
  const buildAndCheck = (group: typeof rows, officeNumber: string, label: string) => {
    if (group.length === 0) return null;
    const built = buildSougouDensou(group, { officeNumber, year: YEAR, month: MONTH_NUM, unitPrice: 10 } as never);
    const lines = built.content.split(/\r?\n/).filter(Boolean).map((l) => l.split(","));
    const hoken = lines.find((c) => F(c, 1) === "7113" && F(c, 4) === "1");
    const basics = lines.filter((c) => F(c, 1) === "71R1" && F(c, 2) === "01");
    const details = lines.filter((c) => F(c, 1) === "71R1" && (F(c, 2) === "02" || F(c, 2) === "14"));
    const totals = lines.filter((c) => F(c, 1) === "71R1" && F(c, 2) === "10");
    check(`[${label}] レコード種別01(基本)が対象者数ぶん`, basics.length === group.length, `${basics.length}/${group.length}`);
    check(`[${label}] レコード種別10(集計)が対象者数ぶん`, totals.length === group.length, `${totals.length}/${group.length}`);
    check(`[${label}] レコード種別02が1件以上ある`, details.length > 0, `${details.length}`);
    if (hoken) {
      const sumUnits = group.reduce((s, r) => s + r.totalUnits, 0);
      const sumAmount = group.reduce((s, r) => s + r.totalAmount, 0);
      check(`[${label}] ★ 7113 項8単位数 = 明細合計`, Number(F(hoken, 8)) === sumUnits, `${F(hoken, 8)} vs ${sumUnits}`);
      check(`[${label}] ★ 7113 項9費用合計 = 明細合計`, Number(F(hoken, 9)) === sumAmount, `${F(hoken, 9)} vs ${sumAmount}`);
    } else {
      check(`[${label}] 7113 保険請求分の行がある`, false);
    }
    return built;
  };
  const built382 = buildAndCheck(group122382, OFFICE_NUMBER_122382, "保険者122382");
  buildAndCheck(group122184, OFFICE_NUMBER_FALLBACK, "保険者122184→フォールバック");
  check("★ ZG006 (限度額超過) の警告が伝送warningsに出る (buildSougouDensou側)",
    !!built382?.warnings.some((w) => w.includes("超過")),
    built382?.warnings.filter((w) => w.includes("超過")).join(" / "));

  console.log(`\n══ 合計 検査 ${checks} 件 / NG ${fails} 件 ══`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error("エラー:", e); process.exit(1); });
