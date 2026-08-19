/**
 * 障害の突合 (shogai-densou-diff.mts) を全拠点まとめて回す。
 *
 * 伝送データ/<拠点>/訪問介護/障害/<提供年月>/ほのぼのから/KJ*.CSV を走査し、
 *   - 事業所番号 = KJ のコントロールレコード 項7
 *   - office_id  = offices.business_number 一致 (無ければ 拠点名で部分一致)
 * を解決して 1 拠点ずつ実行、末尾の一致/不一致だけを表で出す。
 *
 *   MONTH=202606 npx tsx scripts/shogai-densou-diff-all.mts
 *   MONTH=202606 AREAS=中央,高品 npx tsx scripts/shogai-densou-diff-all.mts
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";

const MONTH = process.env.MONTH ?? "202606";
const ONLY = (process.env.AREAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// ⚠ URL.pathname は日本語パスを %E4%BB%8B… に URL エンコードするので使えない。
//   fileURLToPath で戻す (伝送データ/ が全部日本語ディレクトリなので必ず踏む)
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DENSOU = join(ROOT, "伝送データ");

function loadEnv() {
  const t = readFileSync(join(ROOT, ".env.local"), "utf8");
  const e: Record<string, string> = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const { data: offices, error } = await sb
  .from("offices")
  .select("id, name, business_number, shogai_business_number");
if (error) {
  console.error(`✗ 事業所取得失敗: ${error.message}`);
  process.exit(1);
}
// ⚠ 障害は介護と **別番号**。offices.business_number で引くと 1 件も当たらない
const byBn = new Map(
  (offices ?? [])
    .filter((o) => o.shogai_business_number)
    .map((o) => [o.shogai_business_number as string, o]),
);

interface Job { area: string; dir: string; bn: string; officeId: string }
const jobs: Job[] = [];
const skipped: string[] = [];

for (const area of readdirSync(DENSOU)) {
  if (ONLY.length && !ONLY.includes(area)) continue;
  const dir = join(DENSOU, area, "訪問介護", "障害", MONTH, "ほのぼのから");
  if (!existsSync(dir)) continue;
  const kj = readdirSync(dir).find((f) => /^KJ.*\.CSV$/i.test(f));
  if (!kj) { skipped.push(`${area}: KJ ファイル無し`); continue; }
  const text = Encoding.convert(readFileSync(join(dir, kj)), {
    to: "UNICODE", from: "SJIS", type: "string",
  }) as string;
  const first = text.split(/\r?\n/).find(Boolean) ?? "";
  const bn = (first.split(",")[6] ?? "").replace(/^"|"$/g, "").trim();
  // 障害の事業所番号は介護と別番号。offices に無い拠点はここで落ちる
  const off = byBn.get(bn);
  if (!off) { skipped.push(`${area}: 事業所番号 ${bn} が offices に無い`); continue; }
  jobs.push({ area, dir, bn, officeId: off.id });
}

const results: string[] = [];
for (const j of jobs) {
  let out = "";
  try {
    out = execFileSync(
      "npx",
      ["tsx", "scripts/shogai-densou-diff.mts"],
      {
        cwd: ROOT,
        encoding: "utf8",
        shell: true,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          OFFICE_ID: j.officeId,
          SHOGAI_BN: j.bn,
          DENSOU_DIR: `${j.area}/訪問介護/障害/${MONTH}`,
        },
      },
    );
  } catch (e) {
    results.push(`${j.area.padEnd(8)} ✗ 実行失敗: ${(e as Error).message.split("\n")[0]}`);
    continue;
  }
  const pick = (label: string) => {
    const i = out.indexOf(label);
    if (i < 0) return "—";
    const m = /一致 (\d+) 名 \/ 不一致 (\d+) 名 \(総 (\d+) 名\)/.exec(out.slice(i, i + 400));
    return m ? `${m[1]}/${m[3]}` : "—";
  };
  // 不一致の内訳: 「利用者ごと片方にしか居ない」(= 再請求や取込漏れ) と「値が違う」を分ける。
  //   前者は伝送をもう一方の請求サイクル分も貰えば解決することが多い。
  //   ⚠ サービスコード単位の差分行も「ほに無し / 新に無し」と出るので、
  //     利用者単位の行 (括弧付きの `(ほのぼののみ)` / `(新のみ)`) だけを数える。
  const j121 = out.slice(out.indexOf("J121 明細書"), out.indexOf("J611 実績記録票"));
  const onlyHb = (j121.match(/新に無し \(ほのぼののみ\)/g) ?? []).length;
  const onlyNew = (j121.match(/ほのぼのに無し \(新のみ\)/g) ?? []).length;
  results.push(
    `${j.area.padEnd(8)} J121 ${pick("J121 明細書").padStart(7)}   J611 ${pick("J611 実績記録票").padStart(7)}` +
      `   (ほのみ ${String(onlyHb).padStart(2)} / 新のみ ${String(onlyNew).padStart(2)})`,
  );
}

console.log(`\n===== 障害 突合 ${MONTH} (${jobs.length} 拠点) =====`);
for (const r of results) console.log("  " + r);
if (skipped.length) {
  console.log("\n--- スキップ ---");
  for (const s of skipped) console.log("  " + s);
}
