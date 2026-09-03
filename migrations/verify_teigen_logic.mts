/**
 * 逓減制 (居宅介護支援費ⅱ/ⅲ) 自動判定ロジックの検証。
 *
 * claims-content.tsx の 5-g/5-h ブロックが使う「実際の関数」
 * (fetchTeigenSettings / teigenTierForIndex / resolveTeigenBase /
 *  fetchKyotakuMasterForMonth / resolveCertForMonth) を import し、
 * seed_teigen_test_office.mjs で作ったテスト事業所に対して
 * 同じ手順 (DB 読み取り → ソート → tier 判定 → 基本コード解決) を実行する。
 *
 * Part A: 現状の DB に対して実際の fetchTeigenSettings をそのまま呼ぶ
 *         (teigen_kanwa_from 列が無ければ null が返り、機能が丸ごと無効化される
 *          ことを確認する — これが移行漏れの検出そのもの)
 * Part B: 移行が適用された前提のシミュレーション (caremane_jokin_kansan だけで
 *         判定し、kanwa=false 固定) で claims-content.tsx と同じアルゴリズムを
 *         再現し、実際に kaigo_care_support_claims へ INSERT して結果を検証する
 *         (テスト事業所・テスト月に限定。安全に delete 可能)
 * Part C: 緩和要件 (kanwa=true) と FTE が非整数のケースを純粋関数レベルで検証する
 *         (DB 列が無いため B の統合テストでは再現できないぶんを補う)
 *
 * Usage:
 *   npx tsx migrations/verify_teigen_logic.mts
 *
 * ⚠ Part B は kaigo_care_support_claims への INSERT を伴う (テスト事業所の
 *   billing_month=TEST_BILLING_MONTH_B 分のみ)。dry-run フラグは無いが、書き込み先は
 *   テスト事業所の利用者 + 専用月に限定しているため本番データへの影響はない。
 *   SKIP_INSERT=1 を付けると INSERT をスキップし判定結果の表示のみ行う。
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  fetchTeigenSettings,
  fetchKyotakuMasterForMonth,
  teigenTierForIndex,
  resolveTeigenBase,
  isYoboShienLevel,
  calcTotals,
  KYOTAKU_TEIGEN_FALLBACK,
  type TeigenTier,
  type TeigenTaisei,
} from "../src/app/(authenticated)/billing/claims/claims-shared";
import { resolveCertForMonth } from "../src/lib/cert-for-month";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(path: string) {
  try {
    const env = readFileSync(path, "utf8");
    const vars: Record<string, string> = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const SB_URL = envKaigo.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = envKaigo.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SB_URL, SB_KEY);

const TEST_OFFICE_BUSINESS_NUMBER = "9999999901";
const MARKER = "[fake テスト用-teigen-20260903]";
const TEST_BILLING_MONTH_B = "2026-06"; // Part B (INSERT する専用月)
const SKIP_INSERT = process.env.SKIP_INSERT === "1";

type GenUser = { id: string; name: string; user_number: string | null };

async function getTestOfficeId(): Promise<string> {
  const { data, error } = await supabase
    .from("offices")
    .select("id")
    .eq("business_number", TEST_OFFICE_BUSINESS_NUMBER)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("テスト事業所が見つかりません。先に seed_teigen_test_office.mjs --execute を実行してください");
  return data.id;
}

async function loadOfficeUsersAndCerts(officeId: string, billingMonth: string) {
  const { data: assigns, error: aErr } = await supabase
    .from("client_office_assignments")
    .select("client_id")
    .eq("office_id", officeId);
  if (aErr) throw aErr;
  const officeClientIds = (assigns ?? []).map((a) => a.client_id as string);

  const { data: clientRows, error: cErr } = await supabase
    .from("clients")
    .select("id, name, user_number")
    .eq("status", "active")
    .eq("is_facility", false)
    .is("deleted_at", null)
    .in("id", officeClientIds);
  if (cErr) throw cErr;
  const users = (clientRows ?? []) as GenUser[];

  const { data: planRows, error: pErr } = await supabase
    .from("kaigo_care_plans")
    .select("user_id")
    .in("user_id", users.map((u) => u.id))
    .eq("status", "active");
  if (pErr) throw pErr;
  const activeUserIds = new Set((planRows ?? []).map((p) => p.user_id as string));

  const [y, m] = billingMonth.split("-").map(Number);
  const certForMonth = await resolveCertForMonth(supabase as any, Array.from(activeUserIds), y, m);
  const certMap = new Map<string, { care_level: string }>();
  for (const [clientId, cert] of certForMonth) {
    if (!cert.care_level) continue;
    certMap.set(clientId, { care_level: cert.care_level });
  }
  return { officeClientIds, users, activeUserIds, certMap };
}

/** claims-content.tsx 5-h のロジックをそのまま再現 (tierByUser 構築) */
function assignTiers(
  users: GenUser[],
  activeUserIds: Set<string>,
  certMap: Map<string, { care_level: string }>,
  fte: number,
  kanwa: boolean,
) {
  const tierByUser = new Map<string, TeigenTier>();
  const yokaigoUsers: GenUser[] = [];
  let yoboCount = 0;
  for (const user of users) {
    if (!activeUserIds.has(user.id)) continue;
    const cert = certMap.get(user.id);
    if (!cert) continue;
    if (isYoboShienLevel(cert.care_level)) {
      yoboCount++; // このテストデータに委託 (itaku) は無い
    } else if (/^要介護[1-5]$/.test(cert.care_level)) {
      yokaigoUsers.push(user);
    }
  }
  yokaigoUsers.sort((a, b) => {
    const na = Number(a.user_number);
    const nb = Number(b.user_number);
    const aNum = a.user_number != null && a.user_number !== "" && Number.isFinite(na);
    const bNum = b.user_number != null && b.user_number !== "" && Number.isFinite(nb);
    if (aNum && bNum && na !== nb) return na - nb;
    if (aNum !== bNum) return aNum ? -1 : 1;
    const byName = a.name.localeCompare(b.name, "ja");
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
  const yoboOffset = yoboCount / 3;
  yokaigoUsers.forEach((u, idx) => {
    tierByUser.set(u.id, teigenTierForIndex(yoboOffset + idx + 1, fte, kanwa));
  });
  return { tierByUser, yokaigoUsers, yoboCount, yoboOffset };
}

async function partA() {
  console.log("\n========== Part A: 現状の DB で fetchTeigenSettings を実行 ==========");
  const officeId = await getTestOfficeId();
  const result = await fetchTeigenSettings(supabase as any, officeId, TEST_BILLING_MONTH_B);
  if (result === null) {
    console.log("❌ fetchTeigenSettings が null を返した (逓減制の自動判定が機能していない)");
    console.log("   → offices.teigen_kanwa_from 列が未適用 (migrations/teigen_kanwa_effective_date.sql) の可能性が高い。");
    console.log("   → offices.caremane_jokin_kansan にどんな値を入れても、この状態では tier 自動判定は一切発火しない。");
  } else {
    console.log("✅ fetchTeigenSettings:", result);
  }
  return result;
}

async function partB() {
  console.log("\n========== Part B: 移行適用後シミュレーション (実データ経由の統合テスト) ==========");
  const officeId = await getTestOfficeId();

  // caremane_jokin_kansan は現行スキーマにも存在するので直接読める (teigen_kanwa_from だけが無い)
  const { data: officeRow, error: offErr } = await supabase
    .from("offices")
    .select("caremane_jokin_kansan")
    .eq("id", officeId)
    .single();
  if (offErr) throw offErr;
  const fte = Number(officeRow.caremane_jokin_kansan ?? 0);
  const kanwa = false; // teigen_kanwa_from 未適用のため、この統合テストでは常に Ⅰ体制
  console.log(`   fte=${fte} kanwa=${kanwa} (teigen_kanwa_from 列が無いため常に false)`);

  const { users, activeUserIds, certMap } = await loadOfficeUsersAndCerts(officeId, TEST_BILLING_MONTH_B);
  console.log(`   users=${users.length} activeUserIds=${activeUserIds.size} certMap=${certMap.size}`);

  const { tierByUser, yokaigoUsers, yoboCount, yoboOffset } = assignTiers(users, activeUserIds, certMap, fte, kanwa);
  console.log(`   要支援(委託でない)カウント=${yoboCount} → offset=${yoboOffset.toFixed(4)}`);
  console.log(`   要介護 対象者=${yokaigoUsers.length}`);

  const tiers = [...tierByUser.values()];
  const actualCounts = {
    "ⅰ": tiers.filter((t) => t === "ⅰ").length,
    "ⅱ": tiers.filter((t) => t === "ⅱ").length,
    "ⅲ": tiers.filter((t) => t === "ⅲ").length,
  };
  console.log(`   実測 tier 内訳: ⅰ=${actualCounts["ⅰ"]} / ⅱ=${actualCounts["ⅱ"]} / ⅲ=${actualCounts["ⅲ"]}`);

  // 期待値 (seed script と同じ計算式で独立に再計算)
  const expectedCounts = { "ⅰ": 0, "ⅱ": 0, "ⅲ": 0 };
  const mismatches: string[] = [];
  yokaigoUsers.forEach((u, idx) => {
    const ordinal = idx + 1;
    const cumCount = yoboOffset + ordinal;
    const per = cumCount / fte;
    const second = kanwa ? 50 : 45;
    const expected: TeigenTier = per < second ? "ⅰ" : per < 60 ? "ⅱ" : "ⅲ";
    expectedCounts[expected]++;
    const actual = tierByUser.get(u.id);
    if (actual !== expected) {
      mismatches.push(`     ✗ #${ordinal} user_number=${u.user_number} 期待=${expected} 実際=${actual}`);
    }
  });
  console.log(`   独立再計算 内訳: ⅰ=${expectedCounts["ⅰ"]} / ⅱ=${expectedCounts["ⅱ"]} / ⅲ=${expectedCounts["ⅲ"]}`);
  if (mismatches.length === 0) {
    console.log("   ✅ 境界値ズレ 0 件 (独立再計算と完全一致)");
  } else {
    console.log(`   ❌ 境界値ズレ ${mismatches.length} 件:`);
    mismatches.forEach((m) => console.log(m));
  }

  // 基本コード解決 (KYOTAKU_TEIGEN_FALLBACK / kaigo_service_codes 実マスタ) の検証
  const monthMaster = await fetchKyotakuMasterForMonth(supabase as any, TEST_BILLING_MONTH_B);
  console.log(`   fetchKyotakuMasterForMonth.fromMaster=${monthMaster.fromMaster} (false ならフォールバック使用)`);

  const codeMismatches: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const taisei: TeigenTaisei = kanwa ? "Ⅱ" : "Ⅰ";
  for (const u of yokaigoUsers) {
    const tier = tierByUser.get(u.id);
    if (!tier) continue;
    const cert = certMap.get(u.id)!;
    const info = resolveTeigenBase(monthMaster.teigenBase, taisei, tier, cert.care_level);
    if (!info) {
      codeMismatches.push(`     ✗ user_number=${u.user_number} care_level=${cert.care_level} tier=${tier} → resolveTeigenBase が null`);
      continue;
    }
    // フォールバック表と実マスタが一致しているかクロスチェック
    const fb = KYOTAKU_TEIGEN_FALLBACK[taisei][tier];
    const isLight = cert.care_level === "要介護1" || cert.care_level === "要介護2";
    const fbInfo = isLight ? fb.light : fb.heavy;
    if (fbInfo.code !== info.code || fbInfo.units !== info.units) {
      codeMismatches.push(
        `     ⚠ user_number=${u.user_number} tier=${tier}: マスタ=${info.code}/${info.units}単位 フォールバック=${fbInfo.code}/${fbInfo.units}単位 (世代改定等で乖離。要確認)`,
      );
    }
    const { total_amount } = calcTotals(info.units, 0, 0, 10.0, 0);
    rows.push({
      user_id: u.id,
      billing_month: TEST_BILLING_MONTH_B,
      care_support_code: info.code,
      care_support_name: info.name,
      units: info.units,
      unit_price: 10.0,
      total_amount,
      insurance_amount: total_amount,
      status: "draft",
      notes: `${MARKER} 逓減制検証: tier=${tier} ordinal確認用`,
      created_at: now,
    });
  }
  if (codeMismatches.length === 0) {
    console.log("   ✅ 基本コード解決: 全員 resolveTeigenBase 成功 / フォールバック表と実マスタが一致");
  } else {
    console.log(`   基本コード解決の所見 ${codeMismatches.length} 件:`);
    codeMismatches.forEach((m) => console.log(m));
  }

  if (!SKIP_INSERT) {
    console.log(`\n   kaigo_care_support_claims へ INSERT (テスト事業所・${TEST_BILLING_MONTH_B} 分。${rows.length} 件)...`);
    // 冪等性のため、テスト月のこの marker 行を先に削除してから入れ直す
    await supabase
      .from("kaigo_care_support_claims")
      .delete()
      .eq("billing_month", TEST_BILLING_MONTH_B)
      .like("notes", `%${MARKER}%`);
    const BATCH = 100;
    let ins = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await supabase.from("kaigo_care_support_claims").insert(batch);
      if (error) {
        console.error(`   ❌ insert失敗 (batch ${i}):`, error.message);
      } else {
        ins += batch.length;
      }
    }
    console.log(`   INSERT 完了: ${ins}/${rows.length} 件`);

    // 実際に INSERT された行を読み戻して tier 別コード分布を再確認 (DB round-trip の最終確認)
    const { data: inserted, error: readErr } = await supabase
      .from("kaigo_care_support_claims")
      .select("care_support_code, units, notes")
      .eq("billing_month", TEST_BILLING_MONTH_B)
      .like("notes", `%${MARKER}%`);
    if (readErr) throw readErr;
    const byCode = new Map<string, number>();
    for (const r of inserted ?? []) {
      const code = r.care_support_code as string;
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    console.log(`   DB 読み戻し: ${inserted?.length ?? 0} 件。コード別件数:`);
    for (const [code, cnt] of [...byCode.entries()].sort()) {
      console.log(`     ${code}: ${cnt} 件`);
    }
  } else {
    console.log("   SKIP_INSERT=1 のため INSERT は行いません");
  }

  return { mismatches, codeMismatches, actualCounts, expectedCounts };
}

function partC() {
  console.log("\n========== Part C: 純粋関数レベルの境界値・緩和要件 (kanwa=true) 検証 ==========");
  console.log("   (DB 列 teigen_kanwa_from が無いため統合テストでは再現できない分)");

  // C-1: fte=1.0, kanwa=true (緩和要件あり = 50件で逓減)
  console.log("\n   C-1: fte=1.0, kanwa=true (体制Ⅱ, 50/60 境界)");
  const casesC1 = [48, 49, 50, 51, 59, 60, 61];
  for (const cum of casesC1) {
    console.log(`     cumCount=${cum} → ${teigenTierForIndex(cum, 1.0, true)}`);
  }
  const c1ok =
    teigenTierForIndex(49, 1.0, true) === "ⅰ" &&
    teigenTierForIndex(50, 1.0, true) === "ⅱ" &&
    teigenTierForIndex(59, 1.0, true) === "ⅱ" &&
    teigenTierForIndex(60, 1.0, true) === "ⅲ";
  console.log(`     判定: ${c1ok ? "✅ 期待どおり (49→ⅰ, 50→ⅱ, 59→ⅱ, 60→ⅲ)" : "❌ 境界がズレている"}`);

  // C-2: fte=1.0, kanwa=false (45/60 境界) — Part B と同じだが pure function 単体でも再確認
  console.log("\n   C-2: fte=1.0, kanwa=false (体制Ⅰ, 45/60 境界)");
  const c2ok =
    teigenTierForIndex(44, 1.0, false) === "ⅰ" &&
    teigenTierForIndex(45, 1.0, false) === "ⅱ" &&
    teigenTierForIndex(59, 1.0, false) === "ⅱ" &&
    teigenTierForIndex(60, 1.0, false) === "ⅲ";
  console.log(`     44→${teigenTierForIndex(44, 1.0, false)} 45→${teigenTierForIndex(45, 1.0, false)} 59→${teigenTierForIndex(59, 1.0, false)} 60→${teigenTierForIndex(60, 1.0, false)}`);
  console.log(`     判定: ${c2ok ? "✅ 期待どおり" : "❌ 境界がズレている"}`);

  // C-3: 非整数 FTE (fte=1.2) — 「45件 ÷ 常勤換算数」の按分が境界をどこにずらすか
  console.log("\n   C-3: fte=1.2, kanwa=false (45×1.2=54 が理論境界)");
  const fte = 1.2;
  for (const cum of [53, 54, 55, 71, 72, 73]) {
    const per = cum / fte;
    console.log(`     cumCount=${cum} → per=${per.toFixed(3)} → ${teigenTierForIndex(cum, fte, false)}`);
  }
  // per = cum/1.2 が 45 を跨ぐのは cum=54 (per=45.0 ちょうど) から。60 を跨ぐのは cum=72 (per=60.0)
  const c3ok =
    teigenTierForIndex(53, fte, false) === "ⅰ" &&
    teigenTierForIndex(54, fte, false) === "ⅱ" &&
    teigenTierForIndex(71, fte, false) === "ⅱ" &&
    teigenTierForIndex(72, fte, false) === "ⅲ";
  console.log(`     判定: ${c3ok ? "✅ 期待どおり (54件目でⅱ, 72件目でⅲ)" : "❌ 境界がズレている"}`);

  // C-4: fte<=0 (未設定) は常に (ⅰ) — fetchTeigenSettings 側で null 化されるので通常は来ないが、
  //      teigenTierForIndex 単体としての防御的挙動を確認
  console.log("\n   C-4: fte<=0 の防御");
  console.log(`     fte=0 → ${teigenTierForIndex(1000, 0, false)} (期待: ⅰ)`);
  console.log(`     fte=-1 → ${teigenTierForIndex(1000, -1, false)} (期待: ⅰ)`);

  return { c1ok, c2ok, c3ok };
}

async function main() {
  const a = await partA();
  const b = await partB();
  const c = partC();

  console.log("\n========== 総括 ==========");
  console.log(`Part A (現状 fetchTeigenSettings): ${a === null ? "❌ null (機能無効化中)" : "✅ 動作"}`);
  console.log(
    `Part B (統合テスト 境界値ズレ): ${b.mismatches.length === 0 ? "✅ 0件" : `❌ ${b.mismatches.length}件`}`,
  );
  console.log(
    `Part B (基本コード解決): ${b.codeMismatches.length === 0 ? "✅ 問題なし" : `⚠ ${b.codeMismatches.length}件の所見`}`,
  );
  console.log(`Part C (純粋関数 境界値): ${c.c1ok && c.c2ok && c.c3ok ? "✅ 全ケース一致" : "❌ ズレあり"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
