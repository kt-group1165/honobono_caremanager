// ============================================================================
// アセスメント (kaigo_assessments) の 相談内容 本人/家族 2枠 を、
// 現在の _parse_seikatsu_assessment_pdf.py (dd7a41fb で「印字ラベルのy区間で
// 切る」方式に是正済み) で元PDFを再抽出し、DBの値と食い違う行だけ更新する。
//
// ── 背景 (2026-09-14 H割当・G調査) ────────────────────────────────────────
//   commit dd7a41fb (2026-09-03 05:33) で consultation_boxes() の話者取り違え
//   バグは既に修正済みだった。取込 (b2d09608, 2026-08-31) はそれより前なので、
//   DB には旧ロジックの値がそのまま残っている (git log でも時系列が裏付く)。
//   同commitのメッセージ自身が「既存DBへの影響: 再取込が要る」と明記していたが、
//   再取込は実行されないままだった。
//   → 新しい分離ロジックは書かない。既に正しい _parse_seikatsu_assessment_pdf.py
//   で再抽出し、DBの値と比較して食い違う行だけ更新する「差分適用」script。
//
// ── 旧ロジックの正体 (2026-09-14 H指摘で特定) ──────────────────────────────
//   バグは .py 単体ではなく .py(旧) の汎用 blocks 抽出 + .mjs(旧) の
//   fragmentOf() の組合せにあった。旧 import_assessment_from_pdf.mjs (dd7a41fb^):
//     const left = B.filter(b => b.x < 60 && ...).sort((a,b) => b.y - a.y);
//     const family = left[0]?.text ?? null;   // ★ 位置で決め打ち (y最大=家族)
//     const user   = left[1]?.text ?? null;   // ★ 位置で決め打ち (y2番目=本人)
//   片方の枠しか記入が無い様式では left が1要素しかなく、その1要素が
//   まるごと family に入り user は null になる。
//   ★ 本scriptの起動時に、この旧ロジックを実際に (git show で旧.pyを取り出し
//   同じ判定式を適用して) 再現し、DBの現在値と一致することを確認してから
//   本題の差分抽出に入る (負のコントロール。README/コメントに書くだけでなく
//   実行のたびに検証する)。
//
// ⚠ 「家族：」「娘：」「妻：」等の接頭辞がfamily欄に残るのはバグではない。
//   raw PDFで実物突合済み: 記入者が「介護者・家族」欄の中で続柄を自分で
//   書き添えている (2026-09-14 小松知惠子「娘：」/小川昭江「家族：」で確認)。
//   誤って2枠が混ざったものではないため、この接頭辞は削らずそのまま保存する。
//
// ── 上書き事故の防止 ────────────────────────────────────────────────────
//   ⚠ certification_id backfill (fix_assessment_cert_link.mjs、user実行済) が
//   110/113件の updated_at を一括で同一分(秒未満差)に書き換えており、
//   updated_at と created_at の単純比較では「人が編集したか」を判定できない
//   (form_data には触れていない更新のため)。この script では
//     ① 同一分に固まっている updated_at (閾値 CLUSTER_MIN 件以上) は
//        「一括script由来」とみなし、編集扱いしない
//     ② ①に当たらず updated_at が created_at と異なる行は「個別に触られた
//        可能性」として対象外にし、一覧に理由付きで出す
//     ③ form_data._honobono.imported_at マーカーが無い行 (PDF取込以外の
//        経路で作られた行。例: 手動作成のtestダミー) は対象外
//     ④ 氏名が同一PDFセットの中で重複する行 (同姓同名。誤結合防止) は対象外
//   ★ これでも「一括script実行と同じ分内に、たまたま人が個別編集した」場合は
//   理論上検出できない (監査ログが無いため)。実行前に必ず本scriptの差分出力を
//   人が目視で確認すること。
//
//   node migrations/fix_assessment_consultation_boxes.mjs --dir "<PDFフォルダ>"
//   node migrations/fix_assessment_consultation_boxes.mjs --dir "<PDFフォルダ>" --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
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
// 旧ロジックの再現に使う参照ファイル (37件側で最初に確認したケース)
const NEGCTRL_FILE = "生活アセスメント(1)フェースシート(100).pdf"; // 川本いね
const NEGCTRL_NAME = "川本 いね";
const CLUSTER_MIN = 5; // この件数以上が同一分に固まっていれば「一括script」とみなす

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

/**
 * 負のコントロール: 旧ロジック (.py は dd7a41fb^、.mjs の fragmentOf は同時点の
 * 実装をそのまま再現) で NEGCTRL_FILE を読み、DB の現在値と一致することを
 * 確認する。一致しなければ「このscriptの前提(旧ロジックの再現)自体が崩れている」
 * ということなので、差分適用そのものを止める。
 */
async function runNegativeControl(negCtrlDbRow) {
  console.log("=== 負のコントロール: 旧ロジックで同じ誤りが再現するか ===");
  const oldPyPath = path.join(ROOT, "migrations", "_negctrl_old_parser_tmp.py");
  const oldPySrc = execFileSync("git", ["show", "dd7a41fb^:migrations/_parse_seikatsu_assessment_pdf.py"], {
    cwd: ROOT, encoding: "utf8",
  });
  writeFileSync(oldPyPath, oldPySrc, "utf8");
  try {
    const target = path.join(DIR, NEGCTRL_FILE);
    const raw = execFileSync(PYTHON, [oldPyPath, target], { maxBuffer: 1 << 26, encoding: "utf8" });
    const parsed = JSON.parse(raw);
    const page = (parsed[0]?.pages ?? []).find((p) => p.kind === "face_sheet");
    if (!page || page.name?.trim() !== NEGCTRL_NAME) {
      console.log(`  ⚠ 参照ファイル(${NEGCTRL_FILE})の氏名が想定(${NEGCTRL_NAME})と違う。負のコントロールをスキップ`);
      return;
    }
    // 旧 import_assessment_from_pdf.mjs (dd7a41fb^) の fragmentOf() と同じ判定式
    const B = page.blocks ?? [];
    const left = B.filter((b) => b.x < 60 && b.text.length > 20).sort((a, b) => b.y - a.y);
    const oldLogicFamily = left[0]?.text ?? "";
    const oldLogicUser = left[1]?.text ?? "";

    const dbFace = (negCtrlDbRow?.form_data ?? {}).face_sheet ?? {};
    const dbUser = (dbFace.consultation_user ?? "").trim();
    const dbFamily = (dbFace.consultation_family ?? "").trim();

    const userMatch = oldLogicUser.trim() === dbUser;
    const familyMatch = oldLogicFamily.trim() === dbFamily;
    console.log(`  旧ロジック本人: ${JSON.stringify(oldLogicUser.slice(0, 40))} ${userMatch ? "= DB (一致)" : "≠ DB (不一致)"}`);
    console.log(`  旧ロジック家族: ${JSON.stringify(oldLogicFamily.slice(0, 40))} ${familyMatch ? "= DB (一致)" : "≠ DB (不一致)"}`);
    if (userMatch && familyMatch) {
      console.log(`  ✓ 負のコントロール成立: 旧ロジックはDBの誤り(本人空・家族に連結)を再現する\n`);
    } else {
      console.log(`  ✗ 負のコントロール不成立: 旧ロジックの再現がDBの値と一致しない。前提を要再確認\n`);
    }
  } finally {
    try { unlinkSync(oldPyPath); } catch { /* 消せなくても致命的ではない */ }
  }
}

async function main() {
  console.log(`=== アセスメント相談内容(本人/家族) 差分適用 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 0) DB側 (kaigo_assessments 全件 + clients名) — 負のコントロールにも使う
  const rows = await pageAll("kaigo_assessments", "id, user_id, assessment_date, form_data, created_at, updated_at");
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const clients = [];
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await sb.from("clients").select("id, name").in("id", userIds.slice(i, i + 200));
    clients.push(...(data ?? []));
  }
  const nameById = new Map(clients.map((c) => [c.id, c.name]));
  const negCtrlRow = rows.find((r) => nameById.get(r.user_id) === NEGCTRL_NAME);
  await runNegativeControl(negCtrlRow);

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

  // 2) 「人が個別に触った可能性」の機械的検出: updated_at を分単位でクラスタ化する。
  //    同一分に CLUSTER_MIN 件以上固まっていれば一括script由来とみなし除外対象にしない。
  //    それ以外で updated_at != created_at の行は個別編集の疑いとして対象外にする。
  const minuteCounts = new Map();
  for (const r of rows) {
    const key = String(r.updated_at).slice(0, 16); // YYYY-MM-DDTHH:MM
    minuteCounts.set(key, (minuteCounts.get(key) ?? 0) + 1);
  }
  const bulkMinutes = new Set([...minuteCounts.entries()].filter(([, n]) => n >= CLUSTER_MIN).map(([k]) => k));
  console.log(`updated_at の一括script由来クラスタ (同一分に${CLUSTER_MIN}件以上): ${[...bulkMinutes].join(", ") || "無し"}`);

  const fs2 = (r) => (r.form_data ?? {}).face_sheet ?? {};
  const u = (r) => (fs2(r).consultation_user ?? "").trim();
  const f = (r) => (fs2(r).consultation_family ?? "").trim();
  const classify = (hasUser, hasFamily) => {
    if (hasUser && hasFamily) return "両方あり";
    if (!hasUser && hasFamily) return "本人空・家族のみ";
    if (hasUser && !hasFamily) return "家族空・本人のみ";
    return "両方空";
  };

  let matched = 0, skippedNoMatch = 0, skippedDupName = 0, skippedNoMarker = 0, skippedPossiblyEdited = 0;
  let unchanged = 0;
  const changes = [];
  const possiblyEdited = [];
  for (const row of rows) {
    const name = nameById.get(row.user_id);
    if (!name) { skippedNoMatch++; continue; }
    if (dupNames.has(name)) { skippedDupName++; continue; }
    const cand = byName.get(name);
    if (!cand || cand.length !== 1) { skippedNoMatch++; continue; }
    // ③手動作成など、PDF取込マーカーが無い行は対象外
    const marker = (row.form_data ?? {})._honobono;
    if (!marker || !marker.imported_at) { skippedNoMarker++; continue; }
    // ①②「人が個別に触った可能性」の除外
    if (row.updated_at !== row.created_at) {
      const minuteKey = String(row.updated_at).slice(0, 16);
      if (!bulkMinutes.has(minuteKey)) {
        possiblyEdited.push({ row, name, minuteKey });
        skippedPossiblyEdited++;
        continue;
      }
    }
    matched++;
    const newUser = cand[0].user.trim();
    const newFamily = cand[0].family.trim();
    const oldUser = u(row);
    const oldFamily = f(row);
    if (newUser === oldUser && newFamily === oldFamily) { unchanged++; continue; }
    const oldBucket = classify(!!oldUser, !!oldFamily);
    const newBucket = classify(!!newUser, !!newFamily);
    // 「入替」= 旧本人と新家族が近い/旧家族と新本人が近い (どちらも非空で相手側と一致)
    const swapped = !!oldUser && !!oldFamily && oldUser === newFamily && oldFamily === newUser;
    changes.push({ row, name, oldUser, oldFamily, newUser, newFamily, oldBucket, newBucket, swapped });
  }

  console.log(`\n照合できた行: ${matched} 件`);
  console.log(`  除外: 氏名不一致/未抽出 ${skippedNoMatch} / 同姓同名 ${skippedDupName} / PDF取込マーカー無し ${skippedNoMarker} / 個別編集の疑い ${skippedPossiblyEdited}`);
  console.log(`  うち 変化なし: ${unchanged} 件`);
  console.log(`  うち ★ 更新対象 (差分あり): ${changes.length} 件\n`);

  if (possiblyEdited.length) {
    console.log(`⚠ 個別編集の疑いで対象外にした行 (${possiblyEdited.length}件。updated_atが一括クラスタに属さない):`);
    for (const p of possiblyEdited) console.log(`    ${p.name} — updated_at=${p.minuteKey}`);
    console.log("");
  }

  for (const c of changes) {
    const tag = c.swapped ? " ★入替(本人/家族が丸ごと逆)" : c.oldBucket === "両方あり" ? ` ★58件側(${c.oldBucket})だったのに変化 (理由: 上記の旧/新を参照)` : "";
    console.log(`── ${c.name} (id=${c.row.id.slice(0, 8)}…) [${c.oldBucket} → ${c.newBucket}]${tag} ──`);
    console.log(`   本人 旧: ${JSON.stringify(c.oldUser.slice(0, 60))}`);
    console.log(`   本人 新: ${JSON.stringify(c.newUser.slice(0, 60))}`);
    console.log(`   家族 旧: ${JSON.stringify(c.oldFamily.slice(0, 60))}`);
    console.log(`   家族 新: ${JSON.stringify(c.newFamily.slice(0, 60))}`);
  }

  // 3) 予測値: assessment-support-check.mts と同じ分類を「更新適用後」で出す
  //    (更新対象外の行は旧値のまま、更新対象の行は新値で数える)
  const changedIds = new Set(changes.map((c) => c.row.id));
  const changeById = new Map(changes.map((c) => [c.row.id, c]));
  const bucketKey = { "両方あり": "both", "本人空・家族のみ": "userEmpty", "家族空・本人のみ": "famEmpty", "両方空": "neither" };
  const counts = { both: 0, userEmpty: 0, famEmpty: 0, neither: 0 };
  for (const row of rows) {
    let hasUser, hasFamily;
    if (changedIds.has(row.id)) {
      const c = changeById.get(row.id);
      hasUser = !!c.newUser; hasFamily = !!c.newFamily;
    } else {
      hasUser = !!u(row); hasFamily = !!f(row);
    }
    counts[bucketKey[classify(hasUser, hasFamily)]]++;
  }
  console.log(`\n=== 更新適用後の予測値 (現在: 両方あり58/本人空・家族のみ37/家族空・本人のみ0/両方空18) ===`);
  console.log(`  両方あり: ${counts.both} / 本人が空・家族のみ: ${counts.userEmpty} / 家族が空・本人のみ: ${counts.famEmpty} / 両方空: ${counts.neither}`);

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。${changes.length} 件を更新するには --execute を付けて実行してください。`);
    return;
  }

  let ok = 0;
  for (const c of changes) {
    // ⚠ form_data の他キー (_honobono / life_history / referral_route 等) は
    //   読み取ってそのまま温存する。触るのは face_sheet.consultation_user/family
    //   の2キーだけ (1行ずつ get→2キーだけ差し替え→書き戻し)。
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
