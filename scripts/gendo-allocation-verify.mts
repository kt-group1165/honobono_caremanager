/**
 * 区分支給限度基準額 超過の割振り (gendo-allocation.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/gendo-allocation-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   resolveManualOverUnits / computeAutoAllocation / remainingToAllocate は
 *   既にexport済みの純関数だが、scripts/smoke.mts のコメントに名前が
 *   言及されているだけで実際にはimport/testされておらず、実質未検証だった。
 *   ★ money-safety: 超過単位はそのまま自費金額に直結する
 *   (訪問介護の請求集計がこの値を自費単位として使う。ファイル冒頭コメント)。
 */
import {
  resolveManualOverUnits,
  computeAutoAllocation,
  remainingToAllocate,
  type GendoAllocationLine,
} from "@/lib/gendo-allocation";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ★ eq() は JSON.stringify で比較するが、JSON.stringify(new Map(...)) は常に "{}" になり
//   Map の中身を比較したことにならない (3-9: 負のコントロールが鳴らない検査は無意味)。
//   Map を比較するときは必ずこれで entries の配列に変換してから eq() に渡す。
const mapEntries = (m: Map<string, number>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));

const line = (o: Partial<GendoAllocationLine> & { line_key: string }): GendoAllocationLine => ({
  office_id: "o1",
  provider_name: null,
  service_category: null,
  service_label: null,
  total_units: 0,
  over_units: 0,
  source: "auto",
  ...o,
});

// ── resolveManualOverUnits ────────────────────────────────────────────────
eq("lines が undefined → null (機械判定にフォールバック)", resolveManualOverUnits(undefined, "o1"), null);
eq("★ manual 行が無い (autoのみ) → null (ケアマネ未確定は機械判定)", resolveManualOverUnits([line({ line_key: "a", source: "auto", over_units: 100 })], "o1"), null);
eq("★ manual 行があればその over_units を返す", resolveManualOverUnits([line({ line_key: "a", source: "manual", over_units: 150 })], "o1"), 150);
eq("★ 同一officeの複数manual行は合算する", resolveManualOverUnits([
  line({ line_key: "a", source: "manual", over_units: 100 }),
  line({ line_key: "b", source: "manual", over_units: 50 }),
], "o1"), 150);
eq("★ 他事業所 (office_id不一致) のmanual行は無視する", resolveManualOverUnits([
  line({ line_key: "a", office_id: "o1", source: "manual", over_units: 100 }),
  line({ line_key: "b", office_id: "o2", source: "manual", over_units: 999 }),
], "o1"), 100);
eq("★ 負のover_unitsは0にクランプして合算 (マイナス自費は無い)", resolveManualOverUnits([
  line({ line_key: "a", source: "manual", over_units: -30 }),
], "o1"), 0);
eq("空配列はmanual行無しと同じ扱いでnull", resolveManualOverUnits([], "o1"), null);

// ── computeAutoAllocation ─────────────────────────────────────────────────
{
  const lines = [{ line_key: "a", total_units: 500 }, { line_key: "b", total_units: 300 }];
  eq("★ 限度額以下 (合計以下) なら全行0 (超過なし)", mapEntries(computeAutoAllocation(lines, 1000)), [["a", 0], ["b", 0]]);
  eq("★ 合計 = 限度額ちょうど も超過なし (境界)", mapEntries(computeAutoAllocation(lines, 800)), [["a", 0], ["b", 0]]);
}
{
  // 単位数の大きい行から寄せる。合計800, 限度600 → 超過200 → aが500持つので a に200寄せる (bは0)
  const lines = [{ line_key: "a", total_units: 500 }, { line_key: "b", total_units: 300 }];
  eq("★ 超過分は単位数の大きい行(a)から消化する", mapEntries(computeAutoAllocation(lines, 600)), [["a", 200], ["b", 0]]);
}
{
  // 1行では吸収しきれず複数行にまたがる。合計800, 限度100 → 超過700。a(500)を全部+b(300)から200
  const lines = [{ line_key: "a", total_units: 500 }, { line_key: "b", total_units: 300 }];
  eq("★ 1行で吸収しきれない超過は次に大きい行にも寄せる (aを使い切ってからb)", mapEntries(computeAutoAllocation(lines, 100)), [["a", 500], ["b", 200]]);
}
{
  // 1行だけがtotal_unitsを超える寄せを受けない (自分の総単位数が上限)
  const lines = [{ line_key: "a", total_units: 100 }];
  eq("★ 1行あたりの割振りは自分自身のtotal_unitsを超えない", computeAutoAllocation(lines, 0).get("a"), 100);
}
{
  // 負のtotal_unitsは0扱い
  const lines = [{ line_key: "a", total_units: -50 }, { line_key: "b", total_units: 200 }];
  eq("★ 負のtotal_unitsは合計計算で0扱いされる", computeAutoAllocation(lines, 100).get("b"), 100);
}
eq("空配列は空Map", mapEntries(computeAutoAllocation([], 100)), []);

// ── remainingToAllocate ───────────────────────────────────────────────────
{
  const lines = [{ total_units: 500, over_units: 200 }, { total_units: 300, over_units: 0 }];
  eq("★ 完全に割振り済み (超過200=割振済200) なら残り0", remainingToAllocate(lines, 600), 0);
}
{
  const lines = [{ total_units: 500, over_units: 100 }, { total_units: 300, over_units: 0 }];
  eq("★ 割振り不足 (超過200のうち100しか割振っていない) は残り100", remainingToAllocate(lines, 600), 100);
}
{
  const lines = [{ total_units: 500, over_units: 250 }, { total_units: 300, over_units: 0 }];
  eq("★ 割振り過剰 (超過200なのに250割振っている) は残りが負数 (ケアマネの入力ミスを検知できる)", remainingToAllocate(lines, 600), -50);
}
eq("超過なし (合計<=限度額) なら残り0 (割振りも不要)", remainingToAllocate([{ total_units: 100, over_units: 0 }], 1000), 0);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 単位数の大きい行から消化する順序を守らない壊れた実装 (配列の並び順のまま消化)
  const lines = [{ line_key: "a", total_units: 500 }, { line_key: "b", total_units: 300 }];
  const correct = computeAutoAllocation(lines, 600);
  const brokenAllocation = (() => {
    // ★ ソートせず配列順のまま (a,b) 消化する版。この例ではたまたま同じ結果になるので
    //    順序が逆の入力で確認する
    const total = lines.reduce((s, l) => s + l.total_units, 0);
    let remaining = Math.max(0, total - 600);
    const result = new Map<string, number>();
    for (const l of lines) result.set(l.line_key, 0);
    for (const l of [...lines].reverse()) { // ★ b,a の順 (小さい方から消化)
      if (remaining <= 0) break;
      const take = Math.min(remaining, l.total_units);
      result.set(l.line_key, take);
      remaining -= take;
    }
    return result;
  })();
  const detected1 = JSON.stringify([...correct.entries()]) !== JSON.stringify([...brokenAllocation.entries()]);
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 消化順序(単位数降順)の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 消化順序を単位数降順から逆にするバグを検出できる (正=${JSON.stringify([...correct.entries()])} / 壊れた版=${JSON.stringify([...brokenAllocation.entries()])})`);

  // ② resolveManualOverUnits で負のover_unitsをクランプしない壊れた実装
  const lines2 = [line({ line_key: "a", source: "manual", over_units: -30 })];
  const correct2 = resolveManualOverUnits(lines2, "o1");
  const broken2 = lines2.reduce((s, l) => s + l.over_units, 0); // ★ Math.max(0,...) を忘れる (負のまま合算)
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 負のover_unitsクランプの有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 負のover_unitsをクランプし忘れるバグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\n区分支給限度基準額 超過の割振り (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
