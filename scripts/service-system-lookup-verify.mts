/**
 * サービス名→制度区分 lookup (service-system-lookup.ts) の純関数部分の検証
 * (DB 不使用)
 *
 *   npx tsx scripts/service-system-lookup-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   resolveServiceSystemByPriority (getServiceSystemMap) /
 *   resolveUnambiguousServiceSystem (getUnambiguousServiceSystemMap) は
 *   どちらもDBを呼ぶ関数のループ内に埋め込まれておりハーネスから呼べな
 *   かったため切り出した (式は1文字も変えていない。tsc --noEmit 0エラー
 *   で確認済み)。isShogaiService は元から export 済みの純関数。
 *
 *   ★ resolveUnambiguousServiceSystem はファイル内コメントが明記する
 *   実際の事故の再発防止策そのもの: 「2026-08に重訪・総合事業が『介護』と
 *   記録されて238件を是正した前例がある」。曖昧な名前(複数制度にまたがる)
 *   を安易に1つに決め打ちしないことが、この関数の存在理由なので最優先で
 *   検証する。
 */
import {
  resolveServiceSystemByPriority,
  resolveUnambiguousServiceSystem,
  isShogaiService,
} from "@/lib/service-system-lookup";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};
const mapToObj = (m: Map<string, string>) => Object.fromEntries([...m.entries()].sort());

// ── resolveServiceSystemByPriority ────────────────────────────────────────
eq("単一制度の名前はそのまま", mapToObj(resolveServiceSystemByPriority([{ service_name: "身体介護1", system: "介護" }])), { 身体介護1: "介護" });
{
  // ★ 実際の懸念: 同名が複数制度にまたがると 介護 > 総合事業 > 独自 > 障害 の優先で1つに潰す
  const rows = [
    { service_name: "身体日0.5", system: "障害" },
    { service_name: "身体日0.5", system: "介護" },
  ];
  eq("★ 複数制度がヒットしたら介護が最優先", mapToObj(resolveServiceSystemByPriority(rows)), { "身体日0.5": "介護" });
}
{
  const rows = [
    { service_name: "訪問型サービス", system: "障害" },
    { service_name: "訪問型サービス", system: "総合事業" },
  ];
  eq("★ 総合事業 > 障害 (介護が無くても優先順位は保たれる)", mapToObj(resolveServiceSystemByPriority(rows)), { 訪問型サービス: "総合事業" });
}
{
  const rows = [
    { service_name: "重度訪問介護", system: "障害" },
    { service_name: "重度訪問介護", system: "独自" },
  ];
  eq("★ 独自 > 障害", mapToObj(resolveServiceSystemByPriority(rows)), { 重度訪問介護: "独自" });
}
eq("空配列は空Map", mapToObj(resolveServiceSystemByPriority([])), {});
{
  // 順序に依存しないことの確認 (先に介護が来ても後で障害が来ても結果は同じ)
  const rowsA = [{ service_name: "X", system: "障害" }, { service_name: "X", system: "介護" }];
  const rowsB = [{ service_name: "X", system: "介護" }, { service_name: "X", system: "障害" }];
  eq("★ 入力順序に依存しない (min-priority reduceの結合則)", mapToObj(resolveServiceSystemByPriority(rowsA)), mapToObj(resolveServiceSystemByPriority(rowsB)));
}

// ── resolveUnambiguousServiceSystem (★ 238件是正の再発防止策) ─────────────
eq("単一制度の名前は決まる", mapToObj(resolveUnambiguousServiceSystem([{ service_name: "身体介護1", system: "介護" }])), { 身体介護1: "介護" });
{
  // ★ 複数制度にまたがる名前は「決めずに除外」する (優先順位で決め打ちしない)
  const rows = [
    { service_name: "重度訪問介護", system: "障害" },
    { service_name: "重度訪問介護", system: "総合事業" },
  ];
  eq("★ 複数制度にまたがる名前は結果に含めない (238件是正の再発防止)", mapToObj(resolveUnambiguousServiceSystem(rows)), {});
}
{
  // 同じ制度が複数行 (世代違い等) 来ても size=1 なので決まる
  const rows = [
    { service_name: "身体介護1", system: "介護" },
    { service_name: "身体介護1", system: "介護" },
  ];
  eq("同じ制度の重複行は size=1 のまま決まる", mapToObj(resolveUnambiguousServiceSystem(rows)), { 身体介護1: "介護" });
}
{
  // 複数の名前が混在: 曖昧なものだけ除外し、明確なものは残す
  const rows = [
    { service_name: "身体介護1", system: "介護" },
    { service_name: "重度訪問介護", system: "障害" },
    { service_name: "重度訪問介護", system: "総合事業" },
  ];
  eq("★ 明確な名前は残り、曖昧な名前だけ除外される (部分的な結果)", mapToObj(resolveUnambiguousServiceSystem(rows)), { 身体介護1: "介護" });
}
eq("空配列は空Map", mapToObj(resolveUnambiguousServiceSystem([])), {});

// ── isShogaiService ────────────────────────────────────────────────────────
{
  const map = new Map([["重度訪問介護", "障害"], ["身体介護1", "介護"]]);
  eq("障害制度の名前はtrue", isShogaiService(map, "重度訪問介護"), true);
  eq("介護制度の名前はfalse", isShogaiService(map, "身体介護1"), false);
  eq("マスタに無い名前はfalse", isShogaiService(map, "存在しない"), false);
}

// ── resolveServiceSystemByPriority と resolveUnambiguousServiceSystem の対比 ──
{
  // ★ 同じ曖昧な入力に対し、2つの関数が意図通り異なる振る舞いをすることを確認
  //   (前者は決め打ち、後者は除外。用途が違う=DBに書く用途では後者を使うべき)
  const rows = [
    { service_name: "重度訪問介護", system: "障害" },
    { service_name: "重度訪問介護", system: "総合事業" },
  ];
  const priority = resolveServiceSystemByPriority(rows);
  const unambiguous = resolveUnambiguousServiceSystem(rows);
  eq("★ 優先順位版は総合事業に決め打ちする (表示フィルタ用)", priority.get("重度訪問介護"), "総合事業");
  eq("★ 曖昧版はキー自体を持たない (DB書込用、誤記録を防ぐ)", unambiguous.has("重度訪問介護"), false);
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① ★ resolveUnambiguousServiceSystemが決め打ちしてしまう壊れた実装
  //   (2026-08に実際に起きた「重訪・総合事業が介護と記録される」事故の再現)
  const rows = [
    { service_name: "重度訪問介護", system: "障害" },
    { service_name: "重度訪問介護", system: "総合事業" },
  ];
  const correct = resolveUnambiguousServiceSystem(rows);
  const broken = resolveServiceSystemByPriority(rows); // ★ 誤って優先順位版を使ってしまう
  const detected1 = correct.has("重度訪問介護") !== broken.has("重度訪問介護");
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 曖昧な名前の決め打ちを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 曖昧な名前を優先順位で決め打ちしてしまう(2026-08の実事故の型)バグを検出できる (正=除外${!correct.has("重度訪問介護")} / 壊れた版=除外${!broken.has("重度訪問介護")})`);

  // ② 優先順位の比較を逆にする壊れた実装 (障害が最優先になってしまう)
  const rows2 = [{ service_name: "X", system: "障害" }, { service_name: "X", system: "介護" }];
  const correct2 = resolveServiceSystemByPriority(rows2).get("X");
  const REVERSED: Record<string, number> = { 介護: 3, 総合事業: 2, 独自: 1, 障害: 0 }; // ★ 優先順位を逆転
  const broken2 = (() => {
    const map = new Map<string, string>();
    for (const r of rows2) {
      const prev = map.get(r.service_name);
      if (prev == null || (REVERSED[r.system] ?? 9) < (REVERSED[prev] ?? 9)) map.set(r.service_name, r.system);
    }
    return map.get("X");
  })();
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 優先順位の逆転を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 優先順位(介護>総合事業>独自>障害)を逆転させるバグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\nサービス名→制度区分 lookup (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
