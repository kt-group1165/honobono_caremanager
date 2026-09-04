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
 *
 * ■ SHOGAI_DIFF_JSON=<path> で機械可読の結果も書き出す (画面出力は変えない)
 *   回帰網 (npm run check:densou-diff) が読む。介護保険側の DIFF_JSON と同じ役割。
 *   ⚠ **分母 (総 N 名) も入れる**。2026-09-04 に引き継ぎの 476/505 と実測 472/504 が
 *     食い違ったとき、★ 分母が動いていたので「悪化した」と断定できなかった。
 *     一致数だけを焼くと同じことが起きる。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";

const MONTH = process.env.MONTH ?? "202606";
const TARGET_MONTH = `${MONTH.slice(0, 4)}-${MONTH.slice(4)}`;
const ONLY = (process.env.AREAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** 機械可読の結果の書き出し先。指定が無ければ従来どおり表示だけ */
const JSON_OUT = process.env.SHOGAI_DIFF_JSON ?? "";
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

/** 行の中身から短いハッシュを作る (指紋用。暗号強度は不要 — kaigo-densou-diff.mts と同じ式) */
function hashOf(lines: string[]): string {
  let h = 0x811c9dc5;
  for (const l of lines) {
    for (let i = 0; i < l.length; i++) {
      h ^= l.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * ディレクトリ内の伝送 CSV (SJIS) をまとめて指紋にする。
 *   ほのぼの側 = 真の外部入力 (KJ / TJ / JJ)。ここが変われば「データが変わった」
 *   当方側     = 新システム/ に書き出した J11 / J61 / J41
 * ⚠ 行数だけでは値の是正が透明になるので **中身のハッシュ**も持つ (介護保険側と同じ教訓)。
 */
function fingerprintDir(dir: string, re: RegExp): { rows: number; hash: string } {
  if (!existsSync(dir)) return { rows: 0, hash: "-" };
  const files = readdirSync(dir)
    .filter((f) => re.test(f))
    // ⚠ densou-explain.mts が同じ場所に書く注釈CSV (…_解説.csv) は伝送ファイルではない。
    //   除外しないと 四街道で honoRows 17,691 (実体は 470) と桁が変わる。
    //   しかも注釈は更新日が古いまま固まるので、指紋としても嘘をつく
    .filter((f) => !/_解説\.csv$/i.test(f))
    .sort();
  const lines: string[] = [];
  for (const f of files) {
    const text = Encoding.convert(readFileSync(join(dir, f)), {
      to: "UNICODE", from: "SJIS", type: "string",
    }) as string;
    // ファイル名は指紋に入れない (月から機械的に決まるので情報が無い)。中身だけ見る
    for (const l of text.split(/\r?\n/)) if (l.length) lines.push(l);
  }
  return { rows: lines.length, hash: hashOf(lines) };
}

interface Section { match: number; mismatch: number; total: number; onlyHono: number; onlyNew: number }
interface JobResult {
  area: string; officeId: string; bn: string; month: string;
  fingerprint: { honoRows: number; honoHash: string; newRows: number; newHash: string };
  j121: Section; j611: Section;
}
const jsonOut: JobResult[] = [];

const results: string[] = [];
for (const j of jobs) {
  let out = "";
  try {
    // ⚠ 2026-09-01 是正: 子プロセス (shogai-densou-diff.mts) に TARGET_MONTH を
    //   渡していなかったため、MONTH=202606 以外を指定しても子側は既定値 "2026-06" の
    //   DB データで突合していた (DENSOU_DIR は「ほのぼの側」のファイル選択にしか効かない)。
    //   2026-06 は既定値と一致するため気づかれずにいた。
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
          TARGET_MONTH,
          OFFICE_ID: j.officeId,
          SHOGAI_BN: j.bn,
          DENSOU_DIR: `${j.area}/訪問介護/障害/${MONTH}`,
        },
      },
    );
  } catch (e) {
    results.push(`${j.area.padEnd(8)} ✗ 実行失敗: ${(e as Error).message.split("\n")[0]}`);
    // ⚠ 失敗した拠点を JSON から黙って落とすと「測れていない」が「該当なし」に化ける。
    //   total=-1 (測れていない) で残し、回帰網に落とさせる (VERIFICATION_RULES 1-2)
    if (JSON_OUT) {
      const NM = { match: 0, mismatch: 0, total: -1, onlyHono: 0, onlyNew: 0 };
      jsonOut.push({
        area: j.area, officeId: j.officeId, bn: j.bn, month: MONTH,
        fingerprint: { honoRows: 0, honoHash: "-", newRows: 0, newHash: "-" },
        j121: { ...NM }, j611: { ...NM },
      });
    }
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

  if (!JSON_OUT) continue;
  // ── 機械可読の結果 ────────────────────────────────────────────────────────
  // ⚠ ここで分母 (総 N 名) を取り損ねると回帰網が「一致数だけ」になり、
  //   2026-09-04 と同じ「分母も動いたので悪化か判定できない」に戻る。
  //   分母が取れなかった (= 突合が最後まで走っていない) 拠点は total=-1 にして、
  //   回帰網側で ★ 測れていない として落とす (VERIFICATION_RULES 1-2)。
  // ⚠ 「片方にしか居ない」の印は層で書式が違う。**サービスコード単位の差分行**
  //   (`code 111111: 新に無し (ほ: …)`) を数えると受給者数より多くなるので、
  //   J121 は括弧付きの受給者単位の印だけを数える (既存の表示と同じ規則)。
  const section = (label: string, endLabel: string, reHono: RegExp, reNew: RegExp): Section => {
    const i = out.indexOf(label);
    const NOT_MEASURED = { match: 0, mismatch: 0, total: -1, onlyHono: 0, onlyNew: 0 };
    if (i < 0) return NOT_MEASURED;
    const e = out.indexOf(endLabel, i);
    const body = out.slice(i, e < 0 ? undefined : e);
    const m = /一致 (\d+) 名 \/ 不一致 (\d+) 名 \(総 (\d+) 名\)/.exec(body);
    if (!m) return NOT_MEASURED;
    return {
      match: Number(m[1]), mismatch: Number(m[2]), total: Number(m[3]),
      onlyHono: (body.match(reHono) ?? []).length,
      onlyNew: (body.match(reNew) ?? []).length,
    };
  };
  jsonOut.push({
    area: j.area, officeId: j.officeId, bn: j.bn, month: MONTH,
    fingerprint: {
      // ほのぼの側 = KJ / TJ / JJ (真の外部入力)。再請求フォルダも指紋に含める
      ...(() => {
        const a = fingerprintDir(j.dir, /^(KJ|TJ|JJ).*\.CSV$/i);
        const b = fingerprintDir(join(j.dir, "..", "ほのぼのから_再請求"), /^(KJ|TJ|JJ).*\.CSV$/i);
        return { honoRows: a.rows + b.rows, honoHash: `${a.hash}:${b.hash}` };
      })(),
      // 当方側 = 子プロセスが 新システム/ に書き出した J11 / J61 / J41
      ...(() => {
        const n = fingerprintDir(join(j.dir, "..", "新システム"), /^(J11|J61|J41).*\.CSV$/i);
        return { newRows: n.rows, newHash: n.hash };
      })(),
    },
    j121: section("J121 明細書", "J611 実績記録票", /新に無し \(ほのぼののみ\)/g, /ほのぼのに無し \(新のみ\)/g),
    j611: section("J611 実績記録票", "J411 上限管理結果票", /新に無し/g, /ほのぼのに無し/g),
  });
}

console.log(`\n===== 障害 突合 ${MONTH} (${jobs.length} 拠点) =====`);
for (const r of results) console.log("  " + r);
if (skipped.length) {
  console.log("\n--- スキップ ---");
  for (const s of skipped) console.log("  " + s);
}

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ month: MONTH, skipped, offices: jsonOut }, null, 2) + "\n",
    "utf8",
  );
  console.log(`\nSHOGAI_DIFF_JSON → ${JSON_OUT} (${jsonOut.length} 拠点 / スキップ ${skipped.length})`);
}
