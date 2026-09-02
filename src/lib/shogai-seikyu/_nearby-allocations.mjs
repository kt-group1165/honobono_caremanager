// ============================================================================
// 障害 時間帯配分の「近傍探索」— **TS と .mjs の両方から使う唯一の実装**。
//
//   `natural` と同じ合計 step 数を保ったまま、各要素 1 以上・ずれ 2 step 以内の
//   配分を、ずれの小さい順に列挙する (natural 自身は含めない)。
//   時間帯は最大 4 つなので素朴な全探索でよい。
//
//   ⚠ なぜ .mjs なのか:
//     この規則は `src/lib/shogai-seikyu/code-from-time.ts` (集計・実績記録票・突合が使う)
//     と `migrations/import_meisai_shougai_records.mjs` (取込) の**両方**で要る。
//     取込は Node で直接動く .mjs で、**TS を import できない**。
//     逆に .mjs は TS からも import できる (tsconfig の allowJs + moduleResolution:bundler)
//     ので、**共通の実体を .mjs に置いて双方が import する**形にした。
//     型は同じディレクトリの _nearby-allocations.d.mts が与える。
//
//   ⚠ 2026-09-03 まで両者が逐語コピーだった (コメントで「同じ規則にすること」と
//     注意書きするだけ)。**一致しているうちに**切り出したので、
//     「どちらが正か」を判断する必要がなかった。乖離してからでは判断が要る。
// ============================================================================

/**
 * @param {number[]} natural  時間帯ごとの自然な step 数
 * @param {number} totalUnits 保ちたい合計 step 数
 * @returns {number[][]} ずれの小さい順の配分 (natural 自身は含まない)
 */
export function nearbyAllocations(natural, totalUnits) {
  const n = natural.length;
  if (n < 2 || totalUnits < n) return [];
  const out = [];
  const cur = [];
  const walk = (i, left) => {
    if (i === n - 1) {
      if (left < 1 || Math.abs(left - natural[i]) > 2) return;
      const a = [...cur, left];
      const d = a.reduce((s, v, k) => s + Math.abs(v - natural[k]), 0);
      if (d > 0) out.push({ a, d });
      return;
    }
    const lo = Math.max(1, natural[i] - 2);
    const hi = Math.min(natural[i] + 2, left - (n - 1 - i));
    for (let v = lo; v <= hi; v++) {
      cur.push(v);
      walk(i + 1, left - v);
      cur.pop();
    }
  };
  walk(0, totalUnits);
  out.sort((x, y) => x.d - y.d);
  return out.map((x) => x.a);
}
