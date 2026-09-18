/**
 * サンプル seed script (migrations/seed_sample_*.mjs) が「今も DRY RUN で起動するか」の常設チェック
 *
 *   npx tsx scripts/sample-seeds-smoke.mts
 *
 * ── なぜ要るか (claude-06 割当・2026-09-05) ────────────────────────────────
 *   「投入→検証→撤去し、コミットメッセージに結果を書いた」サンプルが、
 *   後日 `_sample_data.mjs` 側の安全チェック追加 (2026-09-03: tag+seq 必須化) に
 *   追随できず起動不能になっていたケースが同日中に **2 本** 見つかった
 *   (seed_sample_sougou_g.mjs / seed_sample_houmon_kaigo_k.mjs。どちらも
 *   sampleInsurance() に tag+seq を渡していなかった)。
 *   「一度の調査を常設の検査に変える」の逆で、記録は残っているのに
 *   再現手段が壊れている状態だった。
 *
 * ── 何を見るか ────────────────────────────────────────────────────────────
 *   migrations/seed_sample_*.mjs を **動的に列挙**して (ハードコードしない。
 *   新しい seed が増えても自動で対象に入る)、引数無し (= 各scriptの既定 DRY RUN)
 *   で `node <file>` を実行し、★ 例外を投げずに exit 0 で終わるかだけを見る。
 *   ⚠ DB へは一切書き込まない (どの script も引数無し = DRY RUN が既定という
 *   規約に依存している。規約自体が破られていないかは対象外)。
 *
 * ⚠ 0 件を目指す検査ではなく「動くこと」を見る検査だが、対象は毎回変わりうる
 *   (seed が増減する) ため、結果は毎回 分母つきで出す。
 */
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL("../migrations/", import.meta.url)));

function listSeedScripts(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^seed_sample_.*\.mjs$/.test(f))
    .sort();
}

// ⚠ 2026-09-18 実測 (H報告「2回続けてFAIL」を追跡): seed_sample_shogai_l.mjs は
//   壊れていなかった。DRY RUN でも kaigo_service_codes を system='障害' で絞って
//   **全件 (208,035 行)** を 1000 件ずつページングして取得しており (重訪の段を
//   本番と同じ _juho_ladder.mjs で再現するため、名前パターンで絞らずマスタを
//   一通り読む設計)、単独実行でも ~22 秒かかる (他15本は 1 秒未満〜数秒)。
//   旧タイムアウト 30 秒だと 6 セッション同時稼働時の DB 側の遅延を吸収できず、
//   execFileSync が SIGTERM で強制終了 → 「起動しない」に見えていた
//   (実際に H の手元では単独実行だと最後まで正常終了していた、と符合する)。
//   ★ 直したのは検査側 (タイムアウトの余裕)。負のコントロールは影響を受けない
//   (わざと壊した script は timeout を上げても即座に例外で落ちるだけ)。
const TIMEOUT_MS = 90_000;

function dryRunOk(absPath: string): { ok: boolean; detail: string } {
  try {
    execFileSync("node", [absPath], {
      cwd: path.dirname(absPath), encoding: "utf8", timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"], // 子プロセスの出力を親の画面に漏らさない
    });
    return { ok: true, detail: "" };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string; signal?: string };
    const tail = (err.stderr ?? err.stdout ?? err.message ?? "").toString().trim().split(/\r?\n/).slice(-5).join(" / ");
    const timedOut = err.signal === "SIGTERM" && !tail;
    return { ok: false, detail: timedOut ? `${TIMEOUT_MS / 1000}秒でタイムアウト (DB側の遅延の可能性。スクリプト自体は壊れていないかもしれない)` : tail };
  }
}

let fails = 0, checks = 0;
const check = (label: string, cond: boolean, detail = "") => {
  checks++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fails++;
};

console.log("サンプル seed script の DRY RUN 起動チェック\n");

// ── ★ 負のコントロール: わざと壊れた script を用意し、この検査が本当に検出できるか確認する ──
console.log("=== 負のコントロール (わざと壊す) ===");
{
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "seed-smoke-neg-"));
  const brokenPath = path.join(tmpDir, "seed_sample_broken_x.mjs");
  writeFileSync(brokenPath, "throw new Error('わざと壊した (負のコントロール)');\n");
  const negResult = dryRunOk(brokenPath);
  check("★ わざと壊した script は検出される (ok=false)", negResult.ok === false, negResult.detail);
  rmSync(tmpDir, { recursive: true, force: true });
}

// ── 本体: 実在する全 seed_sample_*.mjs ──
console.log("\n=== 本体: 全 seed_sample_*.mjs の DRY RUN ===");
const files = listSeedScripts(MIGRATIONS_DIR);
console.log(`【分母】migrations/seed_sample_*.mjs ${files.length} 本\n`);

const brokenFiles: string[] = [];
for (const f of files) {
  const abs = path.join(MIGRATIONS_DIR, f);
  const r = dryRunOk(abs);
  check(f, r.ok, r.ok ? "" : r.detail);
  if (!r.ok) brokenFiles.push(f);
}

console.log(`\n══ 合計 検査 ${checks} 件 / NG ${fails} 件 ══`);
console.log(`  seed_sample_*.mjs: ${files.length - brokenFiles.length}/${files.length} 本が DRY RUN で起動`);
if (brokenFiles.length > 0) {
  console.log(`  ★ 起動しないもの: ${brokenFiles.join(", ")}`);
}
if (fails > 0) process.exit(1);
