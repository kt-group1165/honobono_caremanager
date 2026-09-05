/**
 * 障害福祉サービス コード検索・提供可否判定 (src/lib/shogai-fukushi/billing.ts) の検証 (DB 不使用)
 *
 *   npx tsx scripts/shogai-fukushi-billing-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   `findServiceCode` は障害記録の新規作成フォーム (shogai/records/new/_form.tsx)
 *   から呼ばれ、実績記録の時間帯からどのコード (= 単位数) を選ぶかを決める。
 *   ここを間違えると入力時点で誤った単位数が記録される。検証scriptが無かった。
 *
 *   規則 (ソースのコメント通り):
 *     候補 = service_type一致 かつ is_active かつ !is_addon
 *            かつ (serviceCategory指定時は service_category一致)
 *     時間帯マッチ: min_minutes(既定0) <= duration && duration < max_minutes(既定∞)
 *     マッチ無しは null
 *
 *   canProvideService は現状どこからも呼ばれていない (grep で確認済み・未使用)。
 *   将来使われる可能性がある障害支援区分の判定なので、境界だけ固定しておく。
 */
import { findServiceCode, canProvideService, type FindCodeInput } from "@/lib/shogai-fukushi/billing";
import type { ShogaiServiceCode } from "@/lib/shogai-fukushi/types";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const code = (o: Partial<ShogaiServiceCode> & { code: string }): ShogaiServiceCode => ({
  id: o.code,
  fiscal_year: 2026,
  service_type: "居宅介護",
  service_category: null,
  name: o.code,
  unit_count: 100,
  min_minutes: null,
  max_minutes: null,
  time_bracket: null,
  is_addon: false,
  is_active: true,
  notes: null,
  ...o,
});

const input = (o: Partial<FindCodeInput> = {}): FindCodeInput => ({
  serviceType: "居宅介護",
  durationMinutes: 30,
  ...o,
});

// ── 時間帯境界 (min <= duration < max) ──────────────────────────────────
{
  const codes = [
    code({ code: "A_0_30", min_minutes: 0, max_minutes: 30 }),
    code({ code: "B_30_60", min_minutes: 30, max_minutes: 60 }),
    code({ code: "C_60_", min_minutes: 60, max_minutes: null }),
  ];
  eq("★ min ちょうど (30分) は次の区分に入る (30-60側)", findServiceCode(codes, input({ durationMinutes: 30 }))?.code, "B_30_60");
  eq("★ max 直前 (29分) は前の区分のまま (0-30側)", findServiceCode(codes, input({ durationMinutes: 29 }))?.code, "A_0_30");
  eq("下限ちょうど (0分)", findServiceCode(codes, input({ durationMinutes: 0 }))?.code, "A_0_30");
  eq("★ max_minutes=null (最後の区分) は上限なしで拾う (999分)", findServiceCode(codes, input({ durationMinutes: 999 }))?.code, "C_60_");
  eq("59分は30-60側", findServiceCode(codes, input({ durationMinutes: 59 }))?.code, "B_30_60");
  eq("60分ちょうどは60-側", findServiceCode(codes, input({ durationMinutes: 60 }))?.code, "C_60_");
}

// ── min_minutes/max_minutes が両方 null (既定 0〜∞) ─────────────────────
eq("★ min/max とも null なら 0分〜∞ にマッチする (0分)", findServiceCode([code({ code: "X" })], input({ durationMinutes: 0 }))?.code, "X");
eq("min/max とも null なら 巨大な時間でもマッチする", findServiceCode([code({ code: "X" })], input({ durationMinutes: 100000 }))?.code, "X");

// ── is_active / is_addon の除外 ──────────────────────────────────────────
eq("★ is_active=false は候補から除外される", findServiceCode([code({ code: "X", is_active: false })], input()), null);
eq("★ is_addon=true (加算行) は候補から除外される", findServiceCode([code({ code: "X", is_addon: true })], input()), null);
eq("is_active=true かつ is_addon=false は候補になる", findServiceCode([code({ code: "X" })], input())?.code, "X");

// ── serviceType の一致 ──────────────────────────────────────────────────
eq("service_type が違えば除外される", findServiceCode([code({ code: "X", service_type: "重度訪問介護" })], input({ serviceType: "居宅介護" })), null);
eq("service_type が一致すれば候補になる", findServiceCode([code({ code: "X", service_type: "重度訪問介護" })], input({ serviceType: "重度訪問介護" }))?.code, "X");

// ── serviceCategory の指定/未指定 ────────────────────────────────────────
eq("★ serviceCategory 未指定なら service_category を問わずマッチする", findServiceCode([code({ code: "X", service_category: "身体介護" })], input())?.code, "X");
eq("★ serviceCategory 指定時は一致するものだけマッチする", findServiceCode([code({ code: "X", service_category: "家事援助" })], input({ serviceCategory: "身体介護" })), null);
eq("serviceCategory 指定時に一致すればマッチする", findServiceCode([code({ code: "X", service_category: "身体介護" })], input({ serviceCategory: "身体介護" }))?.code, "X");

// ── マッチ無し / 空配列 ──────────────────────────────────────────────────
eq("候補が空配列なら null", findServiceCode([], input()), null);
eq("時間帯がどれにも当てはまらなければ null", findServiceCode([code({ code: "X", min_minutes: 60, max_minutes: 90 })], input({ durationMinutes: 30 })), null);

// ── canProvideService (現状未使用だが境界を固定) ─────────────────────────
eq("★ disabilityClass=null は 判定不能 → true", canProvideService("居宅介護", null), true);
eq("居宅介護: 区分1 (最小) は true", canProvideService("居宅介護", 1), true);
eq("重度訪問介護: ★ 区分3 は false (4未満)", canProvideService("重度訪問介護", 3), false);
eq("重度訪問介護: ★ 区分4 ちょうど は true", canProvideService("重度訪問介護", 4), true);
eq("重度訪問介護: 区分6 (最大) は true", canProvideService("重度訪問介護", 6), true);
eq("行動援護: ★ 区分2 は false (3未満)", canProvideService("行動援護", 2), false);
eq("行動援護: ★ 区分3 ちょうど は true", canProvideService("行動援護", 3), true);
eq("同行援護: ★ 支援区分を問わず true (区分1でも)", canProvideService("同行援護", 1), true);
eq("同行援護: null でも true", canProvideService("同行援護", null), true);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 境界を <= max にしてしまう壊れた実装 (30分の人が両方の区分に二重マッチしうる)
  const codes = [code({ code: "A", min_minutes: 0, max_minutes: 30 }), code({ code: "B", min_minutes: 30, max_minutes: 60 })];
  const brokenMatch = (c: ShogaiServiceCode, duration: number) => {
    const min = c.min_minutes ?? 0, max = c.max_minutes ?? Number.MAX_SAFE_INTEGER;
    return duration >= min && duration <= max; // ★ わざと <= max にする (正は < max)
  };
  const correctPick = findServiceCode(codes, input({ durationMinutes: 30 }))?.code;
  const brokenPick = codes.find((c) => brokenMatch(c, 30))?.code; // 配列の先頭 "A" が先にヒットしてしまう
  const detected1 = correctPick !== brokenPick;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 境界(< vs <=)の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 上限境界を <= にする(二重マッチ)バグを検出できる (正=${correctPick} / 壊れた版=${brokenPick})`);

  // ② is_addon を見ない壊れた実装
  const withAddon = [code({ code: "ADDON", is_addon: true })];
  const correct2 = findServiceCode(withAddon, input());
  const broken2 = withAddon[0]; // is_addon を見ずに候補扱いした場合
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: is_addon除外の有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ is_addon を見ないバグを検出できる (正=${JSON.stringify(correct2)} / 壊れた版=${broken2.code})`);
}

console.log(`\n障害福祉 コード検索・提供可否判定 の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
