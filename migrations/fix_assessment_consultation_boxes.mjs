// ============================================================================
// アセスメント (kaigo_assessments) の 相談内容 本人/家族 2枠 を、
// 現在の _parse_seikatsu_assessment_pdf.py (dd7a41fb で「印字ラベルのy区間で
// 切る」方式に是正済み) で元PDFを再抽出し、DBの値と食い違う行だけ更新する。
//
// ── 背景 (2026-09-14 H割当・G調査) ────────────────────────────────────────
//   commit dd7a41fb (2026-09-03) で consultation_boxes() の話者取り違えバグは
//   既に修正済みだった (旧実装は左カラムのブロックを y 降順で left[0]=家族/
//   left[1]=本人と★位置で決めており、片方の枠だけ記入された様式で本人の発言が
//   家族欄に入っていた)。同commitのメッセージ自身が「既存DBへの影響: 148枚/113件
//   を実測、是正には元PDFからの再取込が要る」と明記していたが、★ 再取込は
//   実行されないままDBには旧ロジックの値が残っていた (2026-09-14 実測で確認:
//   本人が空・家族のみ 37件のうち検証した12名全員が、現行scriptで再抽出すると
//   正しく分離できる)。
//
//   → 新しい分離ロジックは書かない。既に正しい _parse_seikatsu_assessment_pdf.py
//   で再抽出し、DBの値と比較して食い違う行だけ更新する「差分適用」script。
//
// ⚠ 「家族：」「娘：」「妻：」等の接頭辞がfamily欄に残るのはバグではない。
//   raw PDFで実物突合済み: 記入者が「介護者・家族」欄の中で続柄を自分で
//   書き添えている (2026-09-14 小松知惠子「娘：」/小川昭江「家族：」で確認)。
//   誤って2枠が混ざったものではないため、この接頭辞は削らずそのまま保存する。
//
// ── 上書き事故の防止 ────────────────────────────────────────────────────
//   ⚠ certification_id backfill (fix_assessment_cert_link.mjs、user実行済) が
//   110/113件の updated_at を一括で "2026-09-05T07:33" 台に書き換えており、
//   updated_at と created_at の単純比較では「人が編集したか」を判定できない
//   (form_data には触れていない更新のため)。この script では
//     ① form_data._honobono.imported_at マーカーが無い行 (PDF取込以外の経路
//        で作られた行。例: 手動作成のtestダミー) は対象外
//     ② 氏名が同一PDFセットの中で重複する行 (同姓同名。誤結合防止) は対象外
//   のみを機械的な安全網とする。★ これでも「UI経由でconsultation_user/family
//   だけを個別に手直しされていた」場合は理論上検出できない (監査ログが無いため)。
//   実行前に必ず本scriptの差分出力を人が目視で確認すること。
//
//   node migrations/fix_assessment_consultation_boxes.mjs --dir "<PDFフォルダ>"
//   node migrations/fix_assessment_consultation_boxes.mjs --dir "<PDFフォルダ>" --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const argAfter = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};
const DIR = argAfter("--dir") ?? "C:\\Users\\domen-PC\\Box\\10F内共有\\ほのぼのから出力";
const PYTHON = argAfter("--python") ?? "python";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function loadEnv() {
  const t = readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function pageAll(table, cols, apply, orderCol = "id") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order(orderCol).range(from, from + 999);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== アセスメント相談内容(本人/家族) 差分適用 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 1) 元PDFを現行 _parse_seikatsu_assessment_pdf.py で再抽出
  const files = readdirSync(DIR)
    .filter((f) => f.startsWith("生活アセスメント(1)フェースシート") && f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(DIR, f));
  console.log(`元PDF (フェースシート): ${files.length} 枚`);
  if (files.length === 0) { console.error(`✗ ${DIR} に該当PDFが無い`); process.exit(1); }

  const scriptPath = path.join(ROOT, "migrations", "_parse_seikatsu_assessment_pdf.py");
  const raw = execFileSync(PYTHON, [scriptPath, ...files], { maxBuffer: 1024 * 1024 * 64, encoding: "utf8" });
  const parsed = JSON.parse(raw);

  // 氏名 → 抽出結果 (同姓同名は複数入るので配列で持つ)
  const byName = new Map();
  for (const rec of parsed) {
    if (rec.error) { console.log(`⚠ 読込失敗: ${rec.file} — ${rec.error}`); continue; }
    const page = (rec.pages ?? []).find((p) => p.kind === "face_sheet");
    if (!page || !page.name) continue;
    const name = page.name.trim();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ file: rec.file, user: page.consultation_user ?? "", family: page.consultation_family ?? "" });
  }
  const dupNames = new Set([...byName.entries()].filter(([, v]) => v.length > 1).map(([k]) => k));
  console.log(`抽出できた氏名: ${byName.size} 名 (うち同姓同名で対象外: ${dupNames.size} 名)`);

  // 2) DB側 (kaigo_assessments 全件 + clients名)
  const rows = await pageAll("kaigo_assessments", "id, user_id, assessment_date, form_data, created_at, updated_at");
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const clients = [];
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await sb.from("clients").select("id, name").in("id", userIds.slice(i, i + 200));
    clients.push(...(data ?? []));
  }
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  const fs2 = (r) => (r.form_data ?? {}).face_sheet ?? {};
  const u = (r) => (fs2(r).consultation_user ?? "").trim();
  const f = (r) => (fs2(r).consultation_family ?? "").trim();

  let matched = 0, skippedNoMatch = 0, skippedDupName = 0, skippedNoMarker = 0;
  let unchanged = 0;
  const changes = [];
  for (const row of rows) {
    const name = nameById.get(row.user_id);
    if (!name) { skippedNoMatch++; continue; }
    if (dupNames.has(name)) { skippedDupName++; continue; }
    const cand = byName.get(name);
    if (!cand || cand.length !== 1) { skippedNoMatch++; continue; }
    // ①手動作成など、PDF取込マーカーが無い行は対象外 (元がPDF由来でない可能性)
    const marker = (row.form_data ?? {})._honobono;
    if (!marker || !marker.imported_at) { skippedNoMarker++; continue; }
    matched++;
    const newUser = cand[0].user.trim();
    const newFamily = cand[0].family.trim();
    const oldUser = u(row);
    const oldFamily = f(row);
    if (newUser === oldUser && newFamily === oldFamily) { unchanged++; continue; }
    changes.push({ row, name, oldUser, oldFamily, newUser, newFamily });
  }

  console.log(`\n照合できた行: ${matched} 件 (氏名不一致/未抽出: ${skippedNoMatch} / 同姓同名で対象外: ${skippedDupName} / PDF取込マーカー無しで対象外: ${skippedNoMarker})`);
  console.log(`  うち 変化なし: ${unchanged} 件`);
  console.log(`  うち ★ 更新対象 (差分あり): ${changes.length} 件\n`);

  for (const c of changes) {
    console.log(`── ${c.name} (id=${c.row.id.slice(0, 8)}…) ──`);
    console.log(`   本人 旧: ${JSON.stringify(c.oldUser.slice(0, 60))}`);
    console.log(`   本人 新: ${JSON.stringify(c.newUser.slice(0, 60))}`);
    console.log(`   家族 旧: ${JSON.stringify(c.oldFamily.slice(0, 60))}`);
    console.log(`   家族 新: ${JSON.stringify(c.newFamily.slice(0, 60))}`);
  }

  // 3) 予測値: assessment-support-check.mts と同じ分類を「更新適用後」で出す
  //    (更新対象外の行は旧値のまま、更新対象の行は新値で数える)
  const classify = (hasUser, hasFamily) => {
    if (hasUser && hasFamily) return "both";
    if (!hasUser && hasFamily) return "userEmpty";
    if (hasUser && !hasFamily) return "famEmpty";
    return "neither";
  };
  const changedIds = new Set(changes.map((c) => c.row.id));
  const changeById = new Map(changes.map((c) => [c.row.id, c]));
  const counts = { both: 0, userEmpty: 0, famEmpty: 0, neither: 0 };
  for (const row of rows) {
    let hasUser, hasFamily;
    if (changedIds.has(row.id)) {
      const c = changeById.get(row.id);
      hasUser = !!c.newUser; hasFamily = !!c.newFamily;
    } else {
      hasUser = !!u(row); hasFamily = !!f(row);
    }
    counts[classify(hasUser, hasFamily)]++;
  }
  console.log(`\n=== 更新適用後の予測値 (現在: 両方あり58/本人空・家族のみ37/家族空・本人のみ0/両方空18) ===`);
  console.log(`  両方あり: ${counts.both} / 本人が空・家族のみ: ${counts.userEmpty} / 家族が空・本人のみ: ${counts.famEmpty} / 両方空: ${counts.neither}`);

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。${changes.length} 件を更新するには --execute を付けて実行してください。`);
    return;
  }

  let ok = 0;
  for (const c of changes) {
    const newFormData = {
      ...c.row.form_data,
      face_sheet: {
        ...fs2(c.row),
        ...(c.newUser ? { consultation_user: c.newUser } : {}),
        ...(c.newFamily ? { consultation_family: c.newFamily } : {}),
      },
    };
    if (!c.newUser) delete newFormData.face_sheet.consultation_user;
    if (!c.newFamily) delete newFormData.face_sheet.consultation_family;
    const { error } = await sb
      .from("kaigo_assessments")
      .update({ form_data: newFormData })
      .eq("id", c.row.id);
    if (error) { console.error(`✗ ${c.name}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`\n✓ ${ok}/${changes.length} 件を更新しました`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
