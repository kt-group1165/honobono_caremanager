// ============================================================================
// ほのぼのの「居宅介護支援経過」PDF を kaigo_support_records に取り込む
//
// ── なぜ PDF か ────────────────────────────────────────────────────────
//   支援経過は ほのぼの が CSV で出せない (ケアマネ → CSV タブは計画書系の 4 つだけ)。
//   印刷ダイアログの **利用者選択を「複数」**にすると全員分を 1 つの PDF に出せる
//   ので、それを読む。出し方は docs/HONOBONO_PDF_EXPORT.md。
//
// ── PDF の形 ───────────────────────────────────────────────────────────
//   利用者ごとにページが変わり、各ページの先頭にヘッダーが入る。
//
//     殿
//     作成年月日令和 7年12月16日
//     居宅サービス計画作成者氏名ほのぼの 管理者
//     Hana居宅高品                 ← 事業所名
//     青木 春夫                    ← 利用者名
//     令和 8年 8月31日居宅介護支援経過
//     利用者名
//     要介護３要介護度
//     内　　　　　容年月日 項　目
//     居宅契約・ア 二女宅を訪問し、…R 7/12/16
//     セスメント 談する。…火曜日
//                                  (訪問)
//
// ⚠ **段組がそのまま落ちるので 1 行に「項目・内容・年月日」が混ざる**。
//   行ごとに正規表現で切るのは無理。日付 (R 7/12/16) を手がかりにレコードの
//   区切りだけを見つけ、**中身は Claude に読ませて JSON にする**のが確実。
//   このスクリプトは
//     ① PDF を利用者ごとに割る
//     ② 利用者を当方の clients に引き当てる
//     ③ Claude に渡す用の JSON を書き出す
//   までをやる。抽出結果の取込は --load <json> で行う。
//
// ⚠ 利用者の同定は **事業所 + 氏名**。PDF に利用者番号が無いので、
//   1 ファイルに複数拠点を混ぜてはいけない。同姓同名は引き当てを止めて一覧に出す。
//
//   node migrations/import_support_records_from_pdf.mjs --pdf <file> --office <名前>
//   node migrations/import_support_records_from_pdf.mjs --load <抽出済み.json> --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const PDF = argOf("--pdf");
const LOAD = argOf("--load");
const OFFICE_NAME = argOf("--office");
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/** PDF をページごとのテキストにする (python の pypdf を使う。Node に PDF 依存を足さない) */
function readPdfPages(file) {
  const py = `
import sys, json, pypdf
r = pypdf.PdfReader(sys.argv[1])
print(json.dumps([p.extract_text() or "" for p in r.pages], ensure_ascii=False))
`;
  const raw = execFileSync("python", ["-c", py, file], {
    encoding: "utf8", maxBuffer: 1 << 28,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

/**
 * ページ先頭のヘッダーから利用者名・事業所名・要介護度を取る。
 * ヘッダーが無いページは前の利用者の続き。
 */
function headerOf(text) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const i = lines.findIndex((l) => l.includes("居宅介護支援経過"));
  if (i < 0) return null;
  // 「令和 8年 8月31日居宅介護支援経過」の 1つ上が利用者名、その上が事業所名
  const name = lines[i - 1] ?? "";
  const office = lines[i - 2] ?? "";
  const lv = lines.find((l) => /要介護度$/.test(l) || /要支援度$/.test(l));
  return {
    name: name.replace(/[\s　]+/g, " ").trim(),
    office: office.trim(),
    careLevel: lv ? lv.replace(/要介護度$|要支援度$/, "").trim() : null,
  };
}

async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const normName = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

async function split() {
  if (!existsSync(PDF)) { console.error(`✗ ${PDF} が無い`); process.exit(1); }
  console.log(`=== 支援経過 PDF を利用者ごとに割る ===\n  ${PDF}\n`);
  const pages = readPdfPages(PDF);
  console.log(`  ${pages.length} ページ`);

  const people = [];
  let cur = null;
  for (const [pi, text] of pages.entries()) {
    const h = headerOf(text);
    if (h?.name) {
      // 同じ利用者が続くページはまとめる
      if (!cur || normName(cur.name) !== normName(h.name)) {
        cur = { ...h, pages: [], firstPage: pi + 1 };
        people.push(cur);
      }
    }
    if (!cur) { console.log(`  ⚠ ${pi + 1} ページ目にヘッダーが無い (読み飛ばし)`); continue; }
    cur.pages.push(text);
  }
  console.log(`  利用者 ${people.length} 名`);

  // 事業所を絞って clients に引き当てる
  let clients = [];
  if (OFFICE_NAME) {
    const { data: offs, error } = await sb.from("offices")
      .select("id, name").eq("tenant_id", TENANT).ilike("name", `%${OFFICE_NAME}%`);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    if (!offs?.length) { console.error(`✗ 事業所「${OFFICE_NAME}」が offices に無い`); process.exit(1); }
    console.log(`  事業所: ${offs.map((o) => o.name).join(" / ")}`);
    const asg = await fetchAll("client_office_assignments", "client_id",
      (q) => q.in("office_id", offs.map((o) => o.id)));
    const ids = [...new Set(asg.map((a) => a.client_id))];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await sb.from("clients").select("id, name").in("id", ids.slice(i, i + 200));
      clients.push(...(data ?? []));
    }
  } else {
    clients = await fetchAll("clients", "id, name", (q) => q.eq("tenant_id", TENANT));
  }
  const byName = new Map();
  for (const c of clients) {
    const k = normName(c.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }

  let ok = 0;
  const problems = [];
  for (const p of people) {
    const hits = byName.get(normName(p.name)) ?? [];
    // ⚠ 同姓同名は引き当てない。PDF に利用者番号が無いので決められない
    if (hits.length === 1) { p.clientId = hits[0].id; ok++; }
    else problems.push(`${p.name}: 当方の利用者が ${hits.length} 名`);
  }
  console.log(`  引き当て ${ok} / ${people.length} 名`);
  if (problems.length) {
    console.log(`\n  -- 引き当てられない ${problems.length} 名 --`);
    for (const q of problems.slice(0, 20)) console.log(`     ${q}`);
  }

  const out = PDF.replace(/\.pdf$/i, "") + "_split.json";
  writeFileSync(out, JSON.stringify(people, null, 1), "utf8");
  console.log(`\n✓ ${out} に書き出しました`);
  console.log(`  次: この JSON を Claude に読ませて`);
  console.log(`      [{clientId, records:[{record_date, category, content, staff_name}]}]`);
  console.log(`      の形にしてから --load で取り込む`);
}

async function load() {
  if (!existsSync(LOAD)) { console.error(`✗ ${LOAD} が無い`); process.exit(1); }
  const data = JSON.parse(readFileSync(LOAD, "utf8"));
  console.log(`=== 支援経過を取込 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  // ⚠ category は CHECK 制約がある。許可値以外は「その他」に寄せる
  const ALLOWED = new Set(["電話", "訪問", "来所", "メール", "FAX",
    "カンファレンス", "サービス担当者会議", "モニタリング", "その他"]);

  const rows = [];
  for (const p of data) {
    if (!p.clientId) continue;
    for (const r of p.records ?? []) {
      if (!r.record_date || !r.content) continue;
      rows.push({
        tenant_id: TENANT, user_id: p.clientId,
        record_date: r.record_date,
        record_time: r.record_time ?? null,
        category: ALLOWED.has(r.category) ? r.category : "その他",
        content: r.content,
        staff_name: r.staff_name ?? null,
        // 後で消せるように出どころを残す
        notes: undefined,
      });
    }
  }
  console.log(`  ${data.length} 名 / ${rows.length} 行`);
  const bad = rows.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.record_date));
  if (bad.length) {
    console.error(`✗ 日付の形が違う行が ${bad.length} 件 (例: ${bad[0].record_date})`);
    process.exit(1);
  }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from("kaigo_support_records").insert(rows.slice(i, i + CHUNK));
    if (error) { console.error(`✗ 保存失敗: ${error.message}`); process.exit(1); }
    console.log(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  console.log(`\n✓ ${rows.length} 行を保存しました`);
}

if (LOAD) await load();
else if (PDF) await split();
else {
  console.error("使い方:");
  console.error("  --pdf <file> [--office <名前>]   PDF を利用者ごとに割って JSON を書き出す");
  console.error("  --load <json> [--execute]       抽出済み JSON を取り込む");
  process.exit(1);
}
