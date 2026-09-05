/**
 * 移動支援 (千葉市地域生活支援給付) の算定コード解決 (idou-shien-code.ts) の
 * 検証 (DB 不使用)
 *
 *   npx tsx scripts/idou-shien-code-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   bandOf/resolveIdouCode/calcMinutes/resolveChiikiBathCode/splitIntoBands/
 *   buildCompositeName/compositeNameFromTimes が1つも検証されていなかった。
 *
 *   ★ money-safety / 実際の事故一歩手前だった箇所: ファイル内コメント
 *   「2026-09-03まで municipality 引数が無く、呼出側が市町村を渡し忘れても
 *   動いてしまった。結果、茂原市・いすみ市等の利用者にも千葉市の単位数が
 *   付く経路があった (受給者証テーブルが空だったため実害0件で済んでいた)」。
 *   この module の単位数・コード体系は千葉市R6.4.1専用で、他市町村には
 *   一切当てはまらないため、municipality ゲートが正しく働くことを最優先で
 *   検証する。
 */
import {
  bandOf,
  resolveIdouCode,
  calcMinutes,
  resolveChiikiBathCode,
  splitIntoBands,
  buildCompositeName,
  compositeNameFromTimes,
  SUPPORTED_IDOU_MUNICIPALITY,
  type IdouCodeResult,
} from "@/lib/idou-shien-code";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── bandOf: 時間帯境界 ──────────────────────────────────────────────────
eq("★ 深夜終わり際 (5:59=359分)", bandOf(359), "深夜");
eq("★ 早朝開始 (6:00=360分、境界含む)", bandOf(360), "早朝");
eq("早朝終わり際 (7:59=479分)", bandOf(479), "早朝");
eq("★ 日中開始 (8:00=480分、境界含む)", bandOf(480), "日中");
eq("日中終わり際 (17:59=1079分)", bandOf(1079), "日中");
eq("★ 夜間開始 (18:00=1080分、境界含む)", bandOf(1080), "夜間");
eq("夜間終わり際 (21:59=1319分)", bandOf(1319), "夜間");
eq("★ 深夜開始 (22:00=1320分、境界含む)", bandOf(1320), "深夜");
eq("深夜終わり際 (23:59=1439分)", bandOf(1439), "深夜");
eq("★ 0:00 (0分) も深夜", bandOf(0), "深夜");

// ── resolveIdouCode: municipality ゲート (★ 実際の事故一歩手前) ──────────
eq("★ 千葉市以外は unsupported_municipality (推測で単価を作らない)", resolveIdouCode("茂原市", "10:00", "11:00", 0, true), { reason: "unsupported_municipality", municipality: "茂原市" });
eq("★ municipality が null は unsupported (municipalityはnull表示)", resolveIdouCode(null, "10:00", "11:00", 0, true), { reason: "unsupported_municipality", municipality: null });
eq("★ municipality が空文字も unsupported", resolveIdouCode("", "10:00", "11:00", 0, true), { reason: "unsupported_municipality", municipality: null });
eq("★ municipality が undefined も unsupported (呼出側の渡し忘れを検知)", resolveIdouCode(undefined, "10:00", "11:00", 0, true), { reason: "unsupported_municipality", municipality: null });
eq("前後の空白はtrimして一致判定する (千葉市は通る)", (resolveIdouCode(` ${SUPPORTED_IDOU_MUNICIPALITY} `, "10:00", "11:00", 0, true) as IdouCodeResult).band, "日中");

// ── resolveIdouCode: 入力異常系 ────────────────────────────────────────────
eq("時刻未入力 (start空) は no_time", resolveIdouCode("千葉市", "", "11:00", 0, true), { reason: "no_time" });
eq("時刻未入力 (end空) は no_time", resolveIdouCode("千葉市", "10:00", "", 0, true), { reason: "no_time" });
eq("★ 終了<=開始 (日跨ぎでない) は invalid_range", resolveIdouCode("千葉市", "11:00", "10:00", 0, true), { reason: "invalid_range" });
eq("同時刻は invalid_range", resolveIdouCode("千葉市", "10:00", "10:00", 0, true), { reason: "invalid_range" });

// ── resolveIdouCode: 時間帯跨ぎ検出 ────────────────────────────────────────
{
  const r = resolveIdouCode("千葉市", "17:00", "19:00", 0, true) as IdouCodeResult & { reason?: string };
  eq("★ 日中→夜間 の跨ぎは cross_band (単一時間帯コードでは解決しない)", "reason" in r ? { reason: r.reason, bands: (r as { bands?: string[] }).bands } : null, { reason: "cross_band", bands: ["日中", "夜間"] });
}
{
  // 終了時刻ちょうど境界 (18:00) は「その直前まで提供」なので日中のまま (跨がない)
  const r = resolveIdouCode("千葉市", "17:00", "18:00", 0, true) as IdouCodeResult;
  eq("★ 終了時刻がちょうど帯境界(18:00)なら直前の分(17:59)で判定し日中のまま (跨がない)", r.band, "日中");
}

// ── resolveIdouCode: 正常系 (身体あり・日中・実例と一致) ───────────────────
{
  // check-idou-lines.mts のフィクスチャ (023115=移動1日中1.0=441単位) と一致することを確認
  const r = resolveIdouCode("千葉市", "10:00", "11:00", 0, true) as IdouCodeResult;
  eq("★ 10:00-11:00 身体あり 日中 → 023115 (既存フィクスチャと一致)", r.code, "023115");
  eq("2人目コードは+1", r.code2nd, "023116");
  eq("単位数は441 (基準280系列の bracket2)", r.units, 441);
  eq("bracket=2 (30分刻みの2つ分)", r.bracket, 2);
  eq("ラベル", r.label, "移動1日中1.0");
}
{
  // 身体なし・夜間 (掛率1.25)
  const r = resolveIdouCode("千葉市", "19:00", "19:30", 0, false) as IdouCodeResult;
  eq("身体なし・夜間30分 → bracket1", r.bracket, 1);
  eq("★ 夜間は掛率1.25 (基準116×1.25=145、四捨五入)", r.units, 145);
  eq("コード系列は移動2 (身体なし) の夜間開始番号", r.code, "027215");
  eq("ラベル", r.label, "移動2夜間0.5");
}

// ── resolveIdouCode: 控除時間 (deductMinutes) ──────────────────────────────
{
  const r = resolveIdouCode("千葉市", "10:00", "11:00", 15, true) as IdouCodeResult;
  eq("★ 控除15分を引いた45分 (bracket=2、切り上げなので30分超は2区分)", r.bracket, 2);
}
{
  const r = resolveIdouCode("千葉市", "10:00", "11:00", 30, true) as IdouCodeResult;
  eq("★ 控除30分を引いた30分ちょうど → bracket=1", r.bracket, 1);
}
eq("★ 控除が実績時間以上なら算定時間0以下となり invalid_range", resolveIdouCode("千葉市", "10:00", "11:00", 60, true), { reason: "invalid_range" });
eq("★ 負の控除は0クランプされる (マイナス分は増やさない)", (resolveIdouCode("千葉市", "10:00", "11:00", -100, true) as IdouCodeResult).bracket, 2);

// ── resolveIdouCode: 日跨ぎ (深夜のみ許容) ─────────────────────────────────
{
  const r = resolveIdouCode("千葉市", "23:00", "00:30", 0, true) as IdouCodeResult;
  eq("★ 22時以降開始→翌6時までの日跨ぎは深夜として許容される", r.band, "深夜");
  eq("算定時間90分 → bracket3", r.bracket, 3);
}
eq("★ 深夜帯の範囲外の日跨ぎ (21時開始→翌1時) は invalid_range (許容範囲外)", resolveIdouCode("千葉市", "21:00", "01:00", 0, true), { reason: "invalid_range" });

// ── resolveIdouCode: 系列上限超過 (over_max) ───────────────────────────────
{
  // 深夜の実働8時間 (22:00→翌6:00) はmaxBrackets=13 (6.5h) を超える現実的なケース
  const r = resolveIdouCode("千葉市", "22:00", "06:00", 0, true) as { reason: string; band?: string; maxBrackets?: number };
  eq("★ 深夜帯フル勤務 (8時間) は系列上限(6.5時間=13区分)を超えて over_max", r, { reason: "over_max", band: "深夜", maxBrackets: 13 });
}
{
  // ちょうど上限 (6.5時間=390分) は超過しない
  const r = resolveIdouCode("千葉市", "22:00", "04:30", 0, true) as IdouCodeResult;
  eq("★ ちょうど上限(13区分)は超過しない (境界含む)", r.bracket, 13);
}

// ── calcMinutes ───────────────────────────────────────────────────────────
eq("通常の算定時間", calcMinutes("09:00", "10:00", 0), 60);
eq("★ 控除ありの算定時間", calcMinutes("09:00", "10:00", 15), 45);
eq("★ 負の控除は0クランプ", calcMinutes("09:00", "10:00", -10), 60);
eq("★ 控除が実績時間以上なら null (0以下は算定不能)", calcMinutes("09:00", "09:10", 20), null);
eq("★ 日跨ぎ (深夜のみ) は加算して計算する", calcMinutes("23:00", "00:30", 0), 90);
eq("★ 深夜帯外の日跨ぎは null", calcMinutes("21:00", "01:00", 0), null);
eq("時刻未入力は null", calcMinutes("", "10:00", 0), null);
eq("終了<=開始 (日跨ぎでない) は null", calcMinutes("11:00", "10:00", 0), null);

// ── resolveChiikiBathCode ──────────────────────────────────────────────────
eq("通常 (中止でない・3人体制でない)", resolveChiikiBathCode(false, false), "041110");
eq("★ 3人体制", resolveChiikiBathCode(true, false), "041111");
eq("★ 中止", resolveChiikiBathCode(false, true), "041120");
eq("★ 3人体制かつ中止", resolveChiikiBathCode(true, true), "041121");

// ── splitIntoBands ─────────────────────────────────────────────────────────
eq("単一帯 (10:00-11:00) は1セグメント", splitIntoBands(600, 660), [{ band: "日中", minutes: 60 }]);
eq("★ 帯境界 (17:00-19:00) で2セグメントに分割される", splitIntoBands(1020, 1140), [{ band: "日中", minutes: 60 }, { band: "夜間", minutes: 60 }]);
{
  // 23:00→翌06:00 (深夜フル) は 22:00-24:00 と 0:00-6:00 の2セグメントが「深夜」として結合される
  const segs = splitIntoBands(1380, 1800); // 1800 = 1440+360 (翌6:00)
  eq("★ 深夜の日跨ぎは1セグメントに結合される (22:00-24:00 と 0:00-6:00 を合算)", segs, [{ band: "深夜", minutes: 420 }]);
}

// ── buildCompositeName ─────────────────────────────────────────────────────
eq("★ 複合名はセグメントを「・」で連結する (ドキュメント例と一致)", buildCompositeName(true, [{ band: "深夜", minutes: 30 }, { band: "早朝", minutes: 90 }, { band: "日中", minutes: 30 }]), "移動1深夜0.5・早朝1.5・日中0.5");
eq("身体なしの接頭辞", buildCompositeName(false, [{ band: "日中", minutes: 30 }]), "移動2日中0.5");

// ── compositeNameFromTimes ─────────────────────────────────────────────────
eq("単一帯 (跨がない) は null (resolveIdouCode側が扱うため)", compositeNameFromTimes("10:00", "11:00", 0, true), null);
eq("★ 帯を跨ぐと複合名を返す", compositeNameFromTimes("17:00", "19:00", 0, true), "移動1日中1.0・夜間1.0");
eq("★ 控除ありの複合は帯配分の判断が要るため null (手動へ逃がす)", compositeNameFromTimes("17:00", "19:00", 10, true), null);
eq("時刻未入力は null", compositeNameFromTimes("", "19:00", 0, true), null);
eq("跨がない日跨ぎ不可の逆転は null", compositeNameFromTimes("19:00", "17:00", 0, true), null);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① ★ 実際の事故一歩手前の再現: municipalityチェックを省略する壊れた実装
  const brokenResolve = (municipality: string | null | undefined, start: string, end: string) => {
    // ★ municipality を一切見ずに常に千葉市の単価表で解決してしまう
    return resolveIdouCode(SUPPORTED_IDOU_MUNICIPALITY, start, end, 0, true);
  };
  const correct = resolveIdouCode("茂原市", "10:00", "11:00", 0, true);
  const broken = brokenResolve("茂原市", "10:00", "11:00");
  const detected1 = JSON.stringify(correct) !== JSON.stringify(broken);
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: municipalityゲート省略を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ municipalityチェックを省略し千葉市の単価を他市町村にも適用してしまうバグを検出できる (正=${JSON.stringify(correct)} / 壊れた版=${JSON.stringify(broken)})`);

  // ② 終了時刻の帯判定を e (そのまま) にする壊れた実装 (18:00終了が夜間に誤判定される)
  const correctBand = (resolveIdouCode("千葉市", "17:00", "18:00", 0, true) as IdouCodeResult).band;
  const brokenBand = bandOf(18 * 60); // ★ e-1 ではなく e で判定 (正はe-1)
  const detected2 = correctBand !== brokenBand;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 終了時刻の帯判定(e-1 vs e)の違いを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 終了時刻ちょうどの帯境界(18:00)をe-1でなくeで判定するバグを検出できる (正=${correctBand} / 壊れた版=${brokenBand})`);
}

console.log(`\n移動支援 算定コード解決 (idou-shien-code.ts) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
