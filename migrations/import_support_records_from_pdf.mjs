// ============================================================================
// ほのぼのの「居宅介護支援経過」PDF を kaigo_support_records に取り込む
//
// ── なぜ PDF か ────────────────────────────────────────────────────────
//   支援経過は ほのぼの が CSV で出せない (ケアマネ → CSV タブは計画書系の 4 つだけ)。
//   印刷 → Microsoft Print to PDF で出す。出し方は docs/HONOBONO_PDF_EXPORT.md。
//
// ── 読み方 ─────────────────────────────────────────────────────────────
//   段組がある帳票なので、テキストをそのまま取ると 1 行に「項目・内容・年月日」が
//   混ざる。**文字の x 座標**で列を切り分ける (_parse_shienkeika_pdf.py)。
//   pypdf を使うので python が要る。
//
//   node migrations/import_support_records_from_pdf.mjs --pdf <file...> --office 高品
//   node migrations/import_support_records_from_pdf.mjs --pdf <file...> --office 高品 --execute
//
// ⚠ 利用者の同定は **事業所 + 氏名**。PDF に利用者番号が無いので、
//   1 回の実行に複数拠点を混ぜてはいけない。同姓同名は取り込まず一覧に出す。
// ⚠ 同じ人を 2 回入れないよう、**(利用者, 日付, 内容) が既にあれば飛ばす**。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const argsAfter = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) out.push(process.argv[j]);
  return out;
};
const PDFS = argsAfter("--pdf");
const OFFICE_NAME = argsAfter("--office")[0] ?? null;
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/**
 * category は CHECK 制約がある。ほのぼの側の種別を許可値に寄せる。
 * ⚠ 寄せた結果は content に元の種別を残さない。元が知りたいときは PDF を見る。
 */
const CATEGORY_MAP = {
  "訪問": "訪問", "電話": "電話", "来所": "来所", "メール": "メール",
  "FAX": "FAX", "ＦＡＸ": "FAX",
  "カンファレンス": "カンファレンス",
  "サービス担当者会議": "サービス担当者会議",
  "モニタリング": "モニタリング",
  // ほのぼの独自の連絡手段。許可値に無いので「その他」に寄せる
  "MCS": "その他", "LINE": "その他", "ＬＩＮＥ": "その他",
};

const normName = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

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

function parsePdfs(files) {
  const script = path.join(ROOT, "migrations", "_parse_shienkeika_pdf.py");
  const raw = execFileSync("python", [script, ...files], {
    encoding: "utf8", maxBuffer: 1 << 28,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

async function main() {
  if (!PDFS.length) {
    console.error("使い方: --pdf <file...> [--office <名前>] [--execute]");
    process.exit(1);
  }
  for (const f of PDFS) if (!existsSync(f)) { console.error(`✗ ${f} が無い`); process.exit(1); }
  console.log(`=== 支援経過 PDF 取込 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  console.log(`  PDF ${PDFS.length} ファイル`);

  const people = parsePdfs(PDFS);
  const total = people.reduce((s, p) => s + p.records.length, 0);
  console.log(`  利用者 ${people.length} 名 / 記録 ${total} 件`);

  // 事業所を絞って clients に引き当てる
  let clients = [];
  if (OFFICE_NAME) {
    const { data: offs, error } = await sb.from("offices")
      .select("id, name").eq("tenant_id", TENANT)
      .eq("service_type", "居宅介護支援").ilike("name", `%${OFFICE_NAME}%`);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    if (!offs?.length) { console.error(`✗ 居宅事業所「${OFFICE_NAME}」が offices に無い`); process.exit(1); }
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

  const problems = [];
  for (const p of people) {
    const hits = byName.get(normName(p.name)) ?? [];
    // ⚠ 同姓同名は引き当てない。PDF に利用者番号が無いので決められない
    if (hits.length === 1) p.clientId = hits[0].id;
    else problems.push(`${p.name}: 当方の利用者が ${hits.length} 名`);
  }
  const ok = people.filter((p) => p.clientId);
  console.log(`  引き当て ${ok.length} / ${people.length} 名`);
  if (problems.length) {
    console.log(`\n  -- 引き当てられない ${problems.length} 名 --`);
    for (const q of problems) console.log(`     ${q}`);
  }

  // 既にある記録 (同じ日・同じ内容) は入れない
  const existing = new Set();
  {
    const ids = ok.map((p) => p.clientId);
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await fetchAll("kaigo_support_records", "user_id, record_date, content",
        (q) => q.in("user_id", ids.slice(i, i + 100)));
      // ⚠ 保存時に content の頭へ【項目】を足しているので、突合キーも
      //   **足したあとの形**で作らないと二重取込になる。【項目】が長いと
      //   先頭 40 文字では本文に届かず別人の記録と衝突するので 80 文字にする。
      for (const r of rows) existing.add(`${r.user_id}|${r.record_date}|${(r.content ?? "").slice(0, 80)}`);
    }
  }

  const rows = [];
  let dup = 0;
  const unknownCats = new Set();
  for (const p of ok) {
    for (const r of p.records) {
      if (!r.record_date || !r.content?.trim()) continue;
      const cat = CATEGORY_MAP[r.category];
      if (r.category && !cat) unknownCats.add(r.category);
      // 項目 (「モニタリング・8月分利用票交付」等) は content の頭に残す。
      // 専用の列が無いので落とさないためにこうする。
      const content = r.item?.trim() ? `【${r.item.trim()}】
${r.content}` : r.content;
      const key = `${p.clientId}|${r.record_date}|${content.slice(0, 80)}`;
      if (existing.has(key)) { dup++; continue; }
      existing.add(key);
      rows.push({
        tenant_id: TENANT, user_id: p.clientId,
        record_date: r.record_date,
        category: cat ?? "その他",
        // 項目 (「モニタリング・8月分利用票交付」等) は content の頭に残す。
        // 専用の列が無いので落とさないためにこうする。
        content,
      });
    }
  }
  console.log(`\n  入れる ${rows.length} 件 / 既にある ${dup} 件`);
  if (unknownCats.size) {
    console.log(`  ⚠ 許可値に無い種別を「その他」に寄せた: ${[...unknownCats].join(" / ")}`);
  }
  if (rows.length) {
    const r = rows[0];
    console.log(`\n  例) ${r.record_date} [${r.category}]`);
    console.log(`     ${r.content.replace(/\n/g, " / ").slice(0, 90)}`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }
  if (!rows.length) return;

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from("kaigo_support_records").insert(rows.slice(i, i + CHUNK));
    if (error) { console.error(`✗ 保存失敗: ${error.message}`); process.exit(1); }
    console.log(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  console.log(`\n✓ ${rows.length} 件を保存しました`);
}

main();
