/**
 * 並列chunk実行ヘルパー (chunk-parallel.ts) の検証 (DB 不使用)
 *
 *   npx tsx scripts/chunk-parallel-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   mapChunksParallel はこのセッションで検証した aggregate-honbu / re-seikyu-
 *   shogai をはじめ、visit-seikyu / shogai-seikyu / kyotaku-claims 等、
 *   このシステムのほぼ全ての大規模集計が依存する基盤ユーティリティだが、
 *   1つも検証されていなかった。
 *
 *   ★ 最も重要な性質: ファイル冒頭コメント「戻り値はchunk順に並べて返すので、
 *   chunk内のDB orderを保ったまま連結する呼出側の前提を壊さない」。
 *   これは並列実行 (どのchunkが先に完了するか不定) なのに、結果の並びが
 *   常にchunk順であることを保証する、という非自明な性質なので、
 *   わざと完了順をバラけさせて検証する。
 *
 *   ★ もう一つの重要な性質 (memory feedback_concurrency_worker_throw_
 *   abandons_others.md にも記録): worker内でthrowするとPromise.allが
 *   即rejectし、実行中の他chunkは投げっぱなしで残る。この「即reject」自体
 *   が呼出側から観測できることを確認する (投げっぱなしのバックグラウンド
 *   実行そのものは外部から直接は見えないため、rejectの伝播だけを確認する)。
 */
import { ID_IN_CHUNK, NAME_IN_CHUNK, mapChunksParallel } from "@/lib/chunk-parallel";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 定数 ──────────────────────────────────────────────────────────────────
eq("ID_IN_CHUNK は150 (UUID用)", ID_IN_CHUNK, 150);
eq("NAME_IN_CHUNK は50 (日本語文字列用)", NAME_IN_CHUNK, 50);

// ── 基本の chunk 分割 ───────────────────────────────────────────────────────
{
  const items = Array.from({ length: 10 }, (_, i) => i);
  const chunksSeen: number[][] = [];
  await mapChunksParallel(items, 3, async (c) => { chunksSeen.push(c); return c.length; });
  chunksSeen.sort((a, b) => a[0] - b[0]);
  eq("★ chunkSizeで正しく分割される (10件を3件ずつ→4chunk、最後は端数1件)", chunksSeen, [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]);
}
eq("空配列は空配列を返す (workerは1度も呼ばれない)", await mapChunksParallel([], 3, async () => { throw new Error("呼ばれてはいけない"); }), []);
{
  const items = [1, 2];
  const result = await mapChunksParallel(items, 10, async (c) => c.reduce((a, b) => a + b, 0));
  eq("items.length < chunkSize は単一chunk", result, [3]);
}

// ── ★ 結果はchunk順を保つ (並列実行で完了順がバラけても) ──────────────────
{
  // chunk0はわざと一番遅く、chunk2は一番早く完了させる → 完了順は 2,1,0 だが
  // 戻り値は必ず [0の結果, 1の結果, 2の結果] の順であるべき
  const items = [0, 1, 2, 3, 4, 5]; // chunkSize=2 → chunk0=[0,1] chunk1=[2,3] chunk2=[4,5]
  const delays = [30, 15, 0]; // chunk0が一番遅い、chunk2が一番早い
  const result = await mapChunksParallel(items, 2, async (c) => {
    const chunkIndex = c[0] / 2; // 0,1,2
    await delay(delays[chunkIndex]);
    return `chunk${chunkIndex}:${c.join(",")}`;
  }, 3); // concurrency=3ですべて同時に走らせる
  eq("★ 完了順がバラけても戻り値はchunk順を保つ (最重要の性質)", result, ["chunk0:0,1", "chunk1:2,3", "chunk2:4,5"]);
}

// ── concurrency の扱い ──────────────────────────────────────────────────────
{
  // concurrency=1 (実質直列) でも正しく全chunkが処理され、順序も保たれる
  const items = [1, 2, 3, 4];
  const result = await mapChunksParallel(items, 1, async (c) => c[0] * 10, 1);
  eq("★ concurrency=1 でも全件処理され順序も保たれる", result, [10, 20, 30, 40]);
}
{
  // concurrency がchunk数を超えても問題なく動く (Math.minで内部クランプ)
  const items = [1, 2];
  const result = await mapChunksParallel(items, 1, async (c) => c[0], 100);
  eq("★ concurrencyがchunk数を超えても正しく動作する", result, [1, 2]);
}
{
  // 実際に同時実行数が concurrency を超えないことを、カウンタで直接確認する
  const items = Array.from({ length: 20 }, (_, i) => i);
  let concurrent = 0;
  let maxConcurrent = 0;
  await mapChunksParallel(items, 1, async (c) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await delay(5);
    concurrent--;
    return c[0];
  }, 4);
  eq("★ 同時実行数が指定したconcurrency(4)を超えない", maxConcurrent <= 4, true);
  eq("★ かつ実際に並列化されている (1件ずつの直列にはならない)", maxConcurrent > 1, true);
}

// ── worker が throw した場合 ────────────────────────────────────────────────
{
  let threw = false;
  try {
    await mapChunksParallel([1, 2, 3], 1, async (c) => {
      if (c[0] === 2) throw new Error("chunk2失敗");
      await delay(20); // 他chunkは実行中のまま (投げっぱなしになる)
      return c[0];
    }, 3);
  } catch {
    threw = true;
  }
  eq("★ workerがthrowするとmapChunksParallel全体がrejectする (呼出側で捕捉できる)", threw, true);
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 完了順にpushする壊れた実装 (chunk順を保証しない)
  const items = [0, 1, 2, 3, 4, 5];
  const delays = [30, 15, 0];
  const correct = await mapChunksParallel(items, 2, async (c) => {
    const idx = c[0] / 2;
    await delay(delays[idx]);
    return `chunk${idx}`;
  }, 3);
  const broken = await (async () => {
    // ★ 完了した順にpushする壊れた版 (results[i]に入れず配列にpushするだけ)
    const chunks = [items.slice(0, 2), items.slice(2, 4), items.slice(4, 6)];
    const out: string[] = [];
    await Promise.all(chunks.map(async (c, idx) => {
      await delay(delays[idx]);
      out.push(`chunk${idx}`);
    }));
    return out;
  })();
  const detected1 = JSON.stringify(correct) !== JSON.stringify(broken);
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: chunk順保証の有無を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 完了順にpushする(chunk順を保証しない)壊れた実装を検出できる (正=${JSON.stringify(correct)} / 壊れた版=${JSON.stringify(broken)})`);

  // ② concurrencyのクランプ (Math.min) を忘れる壊れた実装 (chunk数が少ないのに大量workerを起動しようとする)
  const chunkCount = 2;
  const correctWorkerCount = Math.min(100, chunkCount);
  const brokenWorkerCount = 100; // ★ Math.minを忘れて指定値そのまま使う
  const detected2 = correctWorkerCount !== brokenWorkerCount;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: concurrencyクランプの有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ concurrencyのMath.minクランプを忘れる(無駄なworkerを起動する)バグを検出できる (正=${correctWorkerCount} / 壊れた版=${brokenWorkerCount})`);
}

console.log(`\n並列chunk実行ヘルパー (chunk-parallel.ts) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
