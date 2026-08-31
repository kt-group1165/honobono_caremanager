// ============================================================================
// 既に取り込んだ「サービス利用票・提供票 (第6表)」の **表題部だけ**を埋め直す。
//
//   MONTH=2026-06 node migrations/backfill_riyouhyou_header.mjs            # DRY RUN
//   MONTH=2026-06 node migrations/backfill_riyouhyou_header.mjs --execute
//   AREA=四街道 …                     拠点を絞る
//   --overwrite                        既に値が入っている欄も PDF の値で上書きする
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   取込 (import_riyouhyou_service_usage.mjs) は 保険者名を認定
//   (client_insurance_records.insurer_name) からしか取っておらず、そこが NULL の
//   利用者は欄が空のまま画面に出ていた。担当者名に至っては取込が一切見ていない。
//     2026-08-31 実測: service-usage 1,880 件のうち
//       保険者名 空 1,439 件 / 担当者名 空 1,880 件 (= 全件)
//   事業所名は本文テキストから拾っていたため、氏名に区別記号が付く人
//   (「金子 和子1」「中村 光子 〇」「加藤 ＊道子」等) で 12 件落ちていた。
//   値は利用票 PDF の表題部に印字されている (2,016 ページで読めなかったのは
//   担当者名 4 件のみ) ので、そこから埋める。
//
// ── 触る範囲 (ここを広げないこと) ──────────────────────────────────────
//   kaigo_report_documents.content の
//   **insurer_name / support_office_name / support_staff_name のみ**。
//   予定・実績 (services[].planned / actual) とサービス行には一切触らない。
//   よって「人が入力した実績を壊す」経路が無く、取込 script のような
//   「消して入れ直す」も行わない (並行セッションと衝突しない)。
//
//   ⚠ 作成年月日・届出年月日は **ほのぼのの利用票でも空欄で印字される**
//     (「令和　年　月　日」のまま)。埋める値がどこにも無いので対象にしない。
//
// ── 帳票の引き当て ──────────────────────────────────────────────────────
//   利用者を引き直さず、**content の (保険者番号, 被保険者番号) と提供年月**で
//   既存帳票に当てる。取込が書いた値なので、引き当てのやり直しで別人に当たる
//   事故が起きない。被保険者番号は保険者の中でしか一意でないため対で引く。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRiyouhyouPdfs, parseRiyouhyouPages } from "./_riyouhyou_pdf.mjs";
import { extractGrid, pickIdentity } from "./_riyouhyou_grid.mjs";

const EXECUTE = process.argv.includes("--execute");
const OVERWRITE = process.argv.includes("--overwrite");
const MONTH = process.env.MONTH || "2026-06";
const AREA = process.env.AREA || "";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const YYYYMM = MONTH.replace("-", "");

const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** PDF の語 (座標つき) を PyMuPDF で取り出す */
function extractPages(pdfPath) {
  const py = [
    "import fitz, json, sys",
    "d = fitz.open(sys.argv[1])",
    "texts, words = [], []",
    "for i in range(d.page_count):",
    "    p = d[i]",
    "    texts.append(p.get_text())",
    '    words.append([{"x": w[0], "y": w[1], "t": w[4]} for w in p.get_text("words")])',
    'print(json.dumps({"texts": texts, "words": words}, ensure_ascii=False))',
  ].join("\n");
  // ⚠ Windows の python は既定 cp932 出力。UTF-8 を明示しないと氏名が壊れる
  const raw = execFileSync("python", ["-c", py, pdfPath], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

/** PostgREST の 1000 行上限を超えて全件取る */
async function fetchAll(build) {
  const out = [];
  const STEP = 1000;
  for (let from = 0; ; from += STEP) {
    const { data, error } = await build().range(from, from + STEP - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < STEP) return out;
  }
}

async function main() {
  console.log(`=== 利用票 表題部 (保険者名・担当者名) の埋め戻し (${MONTH}) ===`);
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");
  if (OVERWRITE) console.log("*** --overwrite: 既存の値も PDF の値で上書きする ***");

  // ── 1. PDF から (保険者番号|被保険者番号) → {保険者名, 担当者名} を作る ──
  // 置き場所は取込 script と同じ 利用者データ/<拠点>/<YYYYMM>/居宅/*.pdf
  const base = path.join(KAIGO, "利用者データ");
  const areas = (AREA ? [AREA] : readdirSync(base))
    .map((a) => ({ area: a, dir: path.join(base, a, YYYYMM, "居宅") }))
    .filter((x) => existsSync(x.dir));
  const files = [];
  for (const { dir } of areas) {
    const { files: fs_, empty } = findRiyouhyouPdfs(dir);
    for (const f of empty) console.log(`  ⚠ 0 バイト (出力失敗): ${path.basename(f)}`);
    files.push(...fs_);
  }
  if (!files.length) {
    console.error(`✗ 利用票 PDF が見つからない: 利用者データ/${AREA || "<拠点>"}/${YYYYMM}/居宅/*.pdf`);
    process.exit(1);
  }
  console.log(`拠点 ${areas.length} / PDF ${files.length} 本`);

  const fromPdf = new Map();      // key -> {insurerName, staffName, page}
  let pages = 0, noInsurerName = 0, noOfficeName = 0, noStaffName = 0;
  const conflicts = [];
  for (const f of files) {
    const { texts, words } = extractPages(f);
    for (let i = 0; i < words.length; i++) {
      if (!extractGrid(words[i])) continue;                 // 別表など対象外ページ
      const who = parseRiyouhyouPages([texts[i]], [words[i]])[0] ?? null;
      if (who?.month && who.month !== MONTH) continue;      // 出力月ズレ対策
      const id = pickIdentity(words[i]);
      const insurer = id.insurer ?? who?.insurer ?? null;
      const insured = id.insured ?? who?.insured ?? null;
      if (!insurer || !insured) continue;
      pages++;
      if (!id.insurerName) noInsurerName++;
      if (!id.officeName) noOfficeName++;
      if (!id.staffName) noStaffName++;
      const key = `${insurer}|${insured}`;
      const prev = fromPdf.get(key);
      if (!prev) {
        fromPdf.set(key, {
          insurerName: id.insurerName,
          officeName: id.officeName,
          staffName: id.staffName,
          page: `${path.basename(f)}#p${i + 1}`,
        });
      } else {
        // 同じ人が複数ページに跨る。空を埋めるのはよいが、値が食い違うなら黙って
        // 片方を採らずに記録する (列の取り違えを検出するため)
        for (const k of ["insurerName", "officeName", "staffName"]) {
          if (!prev[k] && id[k]) prev[k] = id[k];
          else if (prev[k] && id[k] && prev[k] !== id[k]) {
            conflicts.push(`${key} ${k}: 「${prev[k]}」(${prev.page}) vs 「${id[k]}」(${path.basename(f)}#p${i + 1})`);
          }
        }
      }
    }
  }
  console.log(`ページ ${pages} / 利用者 ${fromPdf.size}`);
  console.log(`  PDF で読めなかった: 保険者名 ${noInsurerName} / 事業所名 ${noOfficeName} / 担当者名 ${noStaffName} ページ`);
  if (conflicts.length) {
    console.log(`  ⚠ ページ間で値が食い違う ${conflicts.length} 件:`);
    conflicts.slice(0, 20).forEach((c) => console.log("     " + c));
  }

  // ── 2. 対象帳票を取る ──────────────────────────────────────────────────
  const docs = await fetchAll(() => sb
    .from("kaigo_report_documents")
    .select("id, user_id, content")
    .eq("report_type", "service-usage")
    .eq("report_month", MONTH)
    .order("id"));
  console.log(`service-usage 帳票 ${docs.length} 件 (${MONTH})`);

  // ── 3. 突き合わせて更新対象を決める ────────────────────────────────────
  const plan = [];
  const stat = { 番号なし: 0, PDFに無い: 0, 変更なし: 0 };
  const missing = [];
  for (const d of docs) {
    const c = d.content || {};
    const insurer = String(c.insurer_number ?? "").trim();
    const insured = String(c.insured_number ?? "").trim();
    if (!insurer || !insured) { stat.番号なし++; continue; }
    const src = fromPdf.get(`${insurer}|${insured}`);
    if (!src) {
      stat.PDFに無い++;
      missing.push(`${c.user_name ?? "?"} 保険者${insurer} 被保番${insured}`);
      continue;
    }

    const next = { ...c };
    const changed = [];
    for (const [field, value] of [
      ["insurer_name", src.insurerName],
      ["support_office_name", src.officeName],
      ["support_staff_name", src.staffName],
    ]) {
      if (!value) continue;
      const cur = String(c[field] ?? "").trim();
      if (cur && !OVERWRITE) continue;
      if (cur === value) continue;
      next[field] = value;
      changed.push(cur ? `${field}: 「${cur}」→「${value}」` : `${field}: 空 →「${value}」`);
    }
    if (!changed.length) { stat.変更なし++; continue; }
    plan.push({ id: d.id, name: c.user_name ?? "?", next, changed });
  }

  console.log("");
  console.log(`更新する ${plan.length} 件 / 変更なし ${stat.変更なし} / PDF に無い ${stat.PDFに無い} / 番号なし ${stat.番号なし}`);
  plan.slice(0, 15).forEach((p) => console.log(`  ${p.name}  ${p.changed.join(" , ")}`));
  if (plan.length > 15) console.log(`  … 他 ${plan.length - 15} 件`);
  if (missing.length) {
    console.log("  PDF に無い (先頭 10):");
    missing.slice(0, 10).forEach((m) => console.log("     " + m));
  }

  if (!EXECUTE) { console.log("\nDRY RUN。--execute で反映する。"); return; }

  // ── 4. 反映 (content 以外の列は触らない) ───────────────────────────────
  let ok = 0, ng = 0;
  for (const p of plan) {
    const { error } = await sb.from("kaigo_report_documents").update({ content: p.next }).eq("id", p.id);
    if (error) { ng++; console.error(`  ✗ ${p.name}: ${error.message}`); continue; }
    ok++;
    if (ok % 200 === 0) console.log(`  … ${ok}/${plan.length}`);
  }
  console.log(`\n反映 ${ok} 件 / 失敗 ${ng} 件`);
  if (ng) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
