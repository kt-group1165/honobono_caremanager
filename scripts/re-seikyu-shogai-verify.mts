/**
 * 障害福祉の月遅れ・返戻・過誤 再請求 合流ロジック (re-seikyu-shogai.ts) の
 * 純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/re-seikyu-shogai-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   loadReSeikyuShogai は元々1つの巨大な async 関数で、grouping/絞り込み/
 *   warnings整形/並び替えのロジックが全部 DBループの中に埋め込まれており
 *   ハーネスから呼べなかった (VERIFICATION_RULES.md 7-1b と同型)。
 *   ★ money-safety: ここでは金額計算 (aggregateMonthlyShogaiSeikyu) には
 *   一切触れない。今回切り出したのは「フラグの合流・絞り込み・並び替え」の
 *   4関数だけで、式は1文字も変えていない (tsc --noEmit 0エラーで確認済み)。
 *
 *   検証したい実際の懸念:
 *     ① フラグの立っていない利用者が誤って混入しないか (attachReSeikyuFlags)
 *     ② 同じ月に複数の理由 (月遅れ+過誤 等) が同時に立った場合の合成
 *     ③ warnings のノイズ除去 (無関係な利用者の警告が紛れ込まないか)
 *     ④ 並び順 (元提供月優先 → ふりがな) が壊れていないか
 */
import {
  groupFlaggedByMonth,
  attachReSeikyuFlags,
  filterReSeikyuWarnings,
  sortReSeikyuRows,
  type ShogaiReSeikyuRow,
} from "@/lib/shogai-seikyu/re-seikyu-shogai";
import type { ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const seikyuRow = (o: Partial<ShogaiSeikyuRow> & { user_id: string; user_name: string }): ShogaiSeikyuRow =>
  ({
    user_name_kana: null,
    ...o,
  }) as ShogaiSeikyuRow;

// ── groupFlaggedByMonth ───────────────────────────────────────────────────
{
  const flagged = [
    { client_id: "c1", target_month: "2026-05", tsukiokure: true, henrei: false, kago: false },
    { client_id: "c2", target_month: "2026-05", tsukiokure: false, henrei: true, kago: false },
    {
      client_id: "c3",
      target_month: "2026-04",
      tsukiokure: false,
      henrei: false,
      kago: true,
      kago_moushitate_date: "2026-06-01",
      kago_jiyu_code: "01",
      kago_dougetsu: true,
    },
  ];
  const byMonth = groupFlaggedByMonth(flagged);
  eq("★ 月ごとに別グループになる", [...byMonth.keys()].sort(), ["2026-04", "2026-05"]);
  eq("同じ月の複数利用者は同じグループに入る", byMonth.get("2026-05")?.size, 2);
  eq("★ tsukiokure/henrei/kago は boolean に正規化される (!!)", byMonth.get("2026-05")?.get("c1")?.reasons, { tsukiokure: true, henrei: false, kago: false });
  eq("★ kago=false の行は kago付帯情報が null", byMonth.get("2026-05")?.get("c1")?.kago, null);
  eq("★ kago=true の行は付帯情報を保持する", byMonth.get("2026-04")?.get("c3")?.kago, { moushitateDate: "2026-06-01", jiyuCode: "01", dougetsu: true });
  const withUndefinedKago = groupFlaggedByMonth([
    { client_id: "c4", target_month: "2026-03", tsukiokure: false, henrei: false, kago: true },
  ]);
  eq("★ 過誤付帯列が無い(migration未適用)環境でも null 埋めで通る", withUndefinedKago.get("2026-03")?.get("c4")?.kago, { moushitateDate: null, jiyuCode: null, dougetsu: false });
}

// ── attachReSeikyuFlags ───────────────────────────────────────────────────
{
  const clientFlags = new Map([
    ["c1", { reasons: { tsukiokure: true, henrei: false, kago: false }, kago: null }],
  ]);
  const rows = [
    seikyuRow({ user_id: "c1", user_name: "対象太郎" }),
    seikyuRow({ user_id: "c2", user_name: "対象外花子" }),
  ];
  const out = attachReSeikyuFlags(rows, "2026-05", "202605", clientFlags);
  eq("★ フラグの無い利用者は含めない (対象外花子が混入しない)", out.map((r) => r.user_id), ["c1"]);
  eq("元提供月キーが付与される", out[0].__origMonthKey, "2026-05");
  eq("ym (YYYYMM) が付与される", out[0].ym, "202605");
  eq("理由が付与される", out[0].__reasons, { tsukiokure: true, henrei: false, kago: false });
}

// ── filterReSeikyuWarnings ─────────────────────────────────────────────────
{
  const clientFlags = new Map([
    ["c1", { reasons: { tsukiokure: true, henrei: false, kago: false }, kago: null }],
  ]);
  const rows = [
    seikyuRow({ user_id: "c1", user_name: "対象太郎" }),
    seikyuRow({ user_id: "c2", user_name: "対象外花子" }),
  ];
  const warnings = [
    "対象太郎さん: 支給量を超えています",
    "対象外花子さん: 市町村変更があります",
  ];
  const filtered = filterReSeikyuWarnings(warnings, rows, clientFlags, 2026, 5);
  eq("★ フラグの立っている利用者の警告だけ残る (対象外花子は除外)", filtered.length, 1);
  eq("★ 和暦プレフィックスが付く (R8/5 = 2026-2018)", filtered[0].startsWith("[再請求 R8/5] "), true);
  eq("元の文言はそのまま保持される", filtered[0].includes("対象太郎さん: 支給量を超えています"), true);

  const noMatch = filterReSeikyuWarnings(["無関係な警告"], rows, clientFlags, 2026, 5);
  eq("★ どの対象者にも一致しない警告は落とす", noMatch.length, 0);
}

// ── sortReSeikyuRows ──────────────────────────────────────────────────────
{
  const mk = (o: { user_id: string; user_name: string; kana: string | null; month: string }): ShogaiReSeikyuRow =>
    ({
      ...seikyuRow({ user_id: o.user_id, user_name: o.user_name, user_name_kana: o.kana }),
      __origMonthKey: o.month,
      ym: o.month.replace("-", ""),
      __reasons: { tsukiokure: true, henrei: false, kago: false },
      __kago: null,
    }) as ShogaiReSeikyuRow;

  const rows = [
    mk({ user_id: "c1", user_name: "佐藤", kana: "サトウ", month: "2026-05" }),
    mk({ user_id: "c2", user_name: "青山", kana: "アオヤマ", month: "2026-04" }),
    mk({ user_id: "c3", user_name: "伊藤", kana: "イトウ", month: "2026-04" }),
  ];
  const sorted = sortReSeikyuRows(rows);
  eq("★ 元提供月が古いほう(2026-04)が先", sorted.map((r) => r.__origMonthKey), ["2026-04", "2026-04", "2026-05"]);
  eq("★ 同じ月内はふりがな順(アオヤマ→イトウ)", sorted.slice(0, 2).map((r) => r.user_name), ["青山", "伊藤"]);

  const noKana = [
    mk({ user_id: "c4", user_name: "山田", kana: null, month: "2026-04" }),
    mk({ user_id: "c5", user_name: "青田", kana: null, month: "2026-04" }),
  ];
  eq("★ ふりがな未設定は氏名でフォールバック比較 (?? user_name)", sortReSeikyuRows(noKana).map((r) => r.user_name), ["山田", "青田"].sort((a, b) => a.localeCompare(b, "ja")));
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① フラグ絞り込みを忘れる壊れた実装 (対象外の利用者まで混入する)
  const clientFlags = new Map([
    ["c1", { reasons: { tsukiokure: true, henrei: false, kago: false }, kago: null }],
  ]);
  const rows = [seikyuRow({ user_id: "c1", user_name: "対象太郎" }), seikyuRow({ user_id: "c2", user_name: "対象外花子" })];
  const correct = attachReSeikyuFlags(rows, "2026-05", "202605", clientFlags);
  const broken = rows.map((r) => ({ ...r, __origMonthKey: "2026-05", ym: "202605", __reasons: { tsukiokure: true, henrei: false, kago: false }, __kago: null })); // ★ フィルタなし
  const detected1 = correct.length !== broken.length;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: フラグ絞り込みの有無を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ フラグ絞り込みを忘れる(対象外利用者が混入する)バグを検出できる (正=${correct.length}件 / 壊れた版=${broken.length}件)`);

  // ② 和暦変換の年号定数を間違える壊れた実装 (2018 → 2019)
  const correctPrefix = filterReSeikyuWarnings(["対象太郎さん: x"], rows.slice(0, 1), clientFlags, 2026, 5)[0];
  const brokenPrefix = `[再請求 R${2026 - 2019}/5] 対象太郎さん: x`; // ★ 令和元年のオフセットを間違える
  const detected2 = correctPrefix !== brokenPrefix;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 和暦オフセットの違いを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 和暦オフセット(2018/2019)の取り違えを検出できる (正=${correctPrefix} / 壊れた版=${brokenPrefix})`);
}

console.log(`\n障害 月遅れ・返戻・過誤 再請求 合流ロジック (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
