/**
 * 障害の支給量超過で請求から外す訪問の判定 (planShikyuryoCut) の検証 (DB 不使用・純関数)
 *
 *   npm run check:shikyuryo-cap
 *
 * 期待値は ★ 実装の出力ではなく、ほのぼのの実伝送 (2026-06 TJ) から手で出している。
 *   いすみ 宮本菜々  家事 支給量 10.5h / 0.5h × 22 回 → ほのぼのは 21 回 (6/30 を請求しない)
 *   いすみ 尾崎昌代  家事 支給量 20h / 1 人換算 16h (・２人 込み 31.5h) → 全額請求 (外さない)
 *
 * 負のコントロール: ・２人 を数える実装に変えると 尾崎のケースで落ちること、
 *   「途中で達した訪問」も外す実装に変えると 境界のケースで落ちることを 2026-10-06 に確認。
 */
import { billedMinutesFromName, planShikyuryoCut, type CapRow } from "@/lib/shogai-seikyu/shikyuryo-cap";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};
const one = (min: number): CapRow => ({ billedMinutes: min, secondHelper: false });
const two = (min: number): CapRow => ({ billedMinutes: min, secondHelper: true });
const day = (d: number, t = "14:30") => `2026-06-${String(d).padStart(2, "0")}|${t}`;

// ① 宮本菜々: 家事 0.5h × 22 回、支給量 10.5h → 最後の 1 回 (6/30) だけ外す
{
  const days = [1, 2, 4, 8, 9, 11, 13, 15, 16, 18, 22, 23, 25, 29, 30, 3, 5, 10, 12, 17, 19, 24];
  const v = new Map(days.map((d) => [day(d), [one(30)]]));
  const p = planShikyuryoCut(v, 630);
  eq("宮本 外す訪問", p.cut, [day(30)]);
  eq("宮本 途中到達なし", p.straddle, []);
  eq("宮本 請求する時間", p.usedMinutes, 630);
}

// ② 尾崎昌代: 1 人換算 16h (・２人 込み 31.5h)、支給量 20h → 外さない
{
  const v = new Map<string, CapRow[]>();
  for (let d = 1; d <= 16; d++) v.set(day(d), [one(30), ...(d <= 15 ? [two(30)] : [])]);
  for (let d = 17; d <= 24; d++) v.set(day(d), [one(60), two(60)]);
  const p = planShikyuryoCut(v, 1200);
  eq("尾崎 外す訪問 (2人目は数えない)", p.cut, []);
  eq("尾崎 1人換算", p.usedMinutes, 960);
}

// ③ 訪問の途中で支給量に達する → 外さず straddle、その後の訪問は外す
{
  const v = new Map([[day(1), [one(60)]], [day(2), [one(60)]], [day(3), [one(30)]]]);
  const p = planShikyuryoCut(v, 90);
  eq("境界 途中到達", p.straddle, [day(2)]);
  eq("境界 その後は外す", p.cut, [day(3)]);
}

// ④ 日内の順序は開始時刻 (キー昇順)
{
  const v = new Map([[day(5, "17:00"), [one(30)]], [day(5, "09:00"), [one(30)]]]);
  eq("同日 後の訪問を外す", planShikyuryoCut(v, 30).cut, [day(5, "17:00")]);
}

// ⑤ 支給量 0 / 未設定は判定しない
{
  const v = new Map([[day(1), [one(600)]]]);
  eq("支給量0 は外さない", planShikyuryoCut(v, 0).cut, []);
}

// ⑥ 増 (家事夜増２．０) は同じ訪問の算定時間に入る
{
  const v = new Map([[day(1), [one(180), one(120)]], [day(2), [one(30)]]]);
  eq("増 込みで支給量に達する", planShikyuryoCut(v, 300).cut, [day(2)]);
}

// サービス名 → 算定時間
eq("名前 家事日０．５", billedMinutesFromName("家事日０．５"), 30);
eq("名前 身体日２．５・夜０．５", billedMinutesFromName("身体日２．５・夜０．５"), 180);
eq("名前 家事夜増２．０", billedMinutesFromName("家事夜増２．０"), 120);
eq("名前 通院１日４．０", billedMinutesFromName("通院１日４．０"), 240);
eq("名前 同援日１．０・区４", billedMinutesFromName("同援日１．０・区４"), 60);
eq("名前 身体日０．５・２人", billedMinutesFromName("身体日０．５・２人"), 30);
eq("名前 時間が無い", billedMinutesFromName("居介上限額管理加算"), null);

console.log(`check:shikyuryo-cap  ${pass} 件 合格 / ${fails.length} 件 不合格`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
