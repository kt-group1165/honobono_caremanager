// ============================================================================
// 障害受給者証の「更新漏れ」だけを新しい世代として追加する (2026-09-05)
//
//   node migrations/import_shougai_cert_new_generation.mjs            # DRY RUN (既定)
//   node migrations/import_shougai_cert_new_generation.mjs --execute  # 本番 INSERT (user承認後のみ)
//   env: SRC=利用者データ/障害受給者証_全社_R8-09/受給者証_全社_R7-04以降.CSV (既定)
//
// ── なぜ既存の import_shougai_certs_from_honobono_csv.mjs を使わないか ──────
//   既存scriptは「対象の1行をUPDATEして期間を延長する」設計 (1受給者証番号=1行を
//   ずっと使い回す)。今回は「保存済みの世代は一切変更せず、新しい世代だけを
//   別行としてINSERTする」方針 (H指示・2026-09-05)。
//   ⚠ 実は既存の読み取り側 (aggregate.ts / 各画面) は全部
//     `.order("certification_start_date", {ascending:false})` で複数世代を
//     前提にした作りなので、1client=複数行になっても壊れない
//     (aggregate.ts:556-577 で対象月に有効な行を優先し、無ければ最新+警告、という
//     介護保険のcert-for-month.tsと同じ設計が既にある)。
//
// ── 対象の絞り込み (H指示・682件を全部入れない) ─────────────────────────────
//   ★ 「当方が持つその受給者証番号の最新のcertification_start_dateより
//      ★後の★ 開始日を持つ世代がCSVにある」ものだけ (= 純粋な更新漏れ)。
//   入れない:
//     - Aのうち古い世代 (当方の最新より前) — 履歴を増やさない (682件のほとんど)
//     - A' (受給者証番号自体が当方に無い486件) — 他事業所利用者の可能性、別判断
//     - B (当方にあってCSVに無い18件) — CSVの範囲外(R7/4/1以降)の可能性
//     - C (同じ開始日で終了日/上限額だけ違う10件) — どちらが正か判断が要る
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const SRC = process.env.SRC ?? "利用者データ/障害受給者証_全社_R8-09/受給者証_全社_R7-04以降.CSV";

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
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

const splitCsv = (line) => {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};
const iso = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const num = (s) => { const n = Number(String(s ?? "").trim()); return Number.isFinite(n) && s !== "" ? n : null; };
const isDummy = (name) => /テスト/.test(name ?? "") || /^[★◆◎●■☆〇○◇▲△▼▽※＊*]/.test((name ?? "").trim());

// import_shougai_certs_from_honobono_csv.mjs と同じ列マップ (SRD18・124列)
const C = { name: 1, birth: 3, kind: 17, facility: 18, jukyu: 19, issue: 20, city: 21, from: 22, to: 23, level: 24, limit: 57, jogenOffice: 64 };

async function fetchAll(table, select) {
  const out = []; let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`=== 障害受給者証 更新漏れ補完 ${EXECUTE ? "【EXECUTE — 絶対に自動実行しないこと】" : "【DRY RUN】"} ===`);
  console.log(`  ソース: ${SRC}\n`);

  const text = iconv.decode(readFileSync(path.join(KAIGO, SRC)), "Shift_JIS");
  const rows = text.split(/\r?\n/).filter(Boolean).slice(1).map((l) => splitCsv(l));
  const csvRows = [];
  let dummies = 0;
  for (const r of rows) {
    if (r.length <= C.limit) continue;
    if (isDummy(r[C.name])) { dummies++; continue; }
    const from = iso(r[C.from]);
    if (!from || !r[C.jukyu]) continue;
    csvRows.push({ name: r[C.name], jukyu: r[C.jukyu], from, to: iso(r[C.to]), level: r[C.level], limit: num(r[C.limit]), issue: iso(r[C.issue]), city: r[C.city], jogenOffice: r[C.jogenOffice] });
  }
  console.log(`  CSV有効行 ${csvRows.length} 件 (テスト登録除外 ${dummies})`);

  const mine = await fetchAll("shougai_certifications", "*");
  const byJukyu = new Map();
  for (const r of mine) {
    if (!r.beneficiary_number) continue;
    if (!byJukyu.has(r.beneficiary_number)) byJukyu.set(r.beneficiary_number, []);
    byJukyu.get(r.beneficiary_number).push(r);
  }
  console.log(`  当方 ${mine.length} 件 / 受給者証番号 ${byJukyu.size} 種\n`);

  const csvByJukyu = new Map();
  for (const r of csvRows) {
    if (!csvByJukyu.has(r.jukyu)) csvByJukyu.set(r.jukyu, []);
    csvByJukyu.get(r.jukyu).push(r);
  }

  // ── 「純粋な更新漏れ」だけを拾う ─────────────────────────────────────────
  // ⚠ CSVは同一(受給者証番号,開始日)の行がサービス種別ごとに複数出ることがある
  //   (石井咲妃の例で確認済み)。(jukyu, from) で重複排除してから候補にする。
  const candidates = [];
  for (const [jukyu, mineRows] of byJukyu) {
    const csvForJukyu = csvByJukyu.get(jukyu);
    if (!csvForJukyu) continue; // B (CSVに無い) — 対象外
    const latestMine = mineRows.reduce((a, b) => (b.certification_start_date ?? "") > (a.certification_start_date ?? "") ? b : a);
    const newer = csvForJukyu.filter((c) => c.from > latestMine.certification_start_date);
    const seenFrom = new Set();
    for (const c of newer) {
      if (seenFrom.has(c.from)) continue; // 同一開始日の重複行 (サービス種別違い) は1件に丸める
      seenFrom.add(c.from);
      candidates.push({ jukyu, base: latestMine, csv: c });
    }
  }
  console.log(`★ 更新漏れ候補 (当方の最新開始日より後の世代がCSVにある): ${candidates.length} 件\n`);

  // ── INSERT payload を組み立てる (base行を複製し、CSVの新しい値で上書き) ──
  const inserts = [];
  for (const { jukyu, base, csv } of candidates) {
    const payload = { ...base };
    delete payload.id; delete payload.created_at; delete payload.updated_at;
    payload.certification_start_date = csv.from;
    payload.certification_end_date = csv.to;
    if (csv.level) payload.support_level = `区分${csv.level.normalize("NFKC")}`;
    if (csv.limit != null) payload.self_payment_limit = csv.limit;
    if (csv.issue) payload.issue_date = csv.issue;
    if (csv.city) payload.insurer_municipality = csv.city;
    if (csv.jogenOffice) payload.jogen_kanri_office_name = csv.jogenOffice;
    inserts.push({ jukyu, client_id: base.client_id, name: csv.name, base, payload });
  }

  const { data: clients } = await sb.from("clients").select("id,name").in("id", [...new Set(inserts.map((i) => i.client_id))]);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));

  console.log(`--- 追加予定 ${inserts.length} 件 ---`);
  for (const i of inserts) {
    console.log(`${(nameOf.get(i.client_id) ?? i.name).padEnd(12)} [${i.jukyu}]`);
    console.log(`  既存(変更しない): ${i.base.certification_start_date}〜${i.base.certification_end_date} 区分${i.base.support_level ?? "?"} 上限${i.base.self_payment_limit}`);
    console.log(`  新規INSERT     : ${i.payload.certification_start_date}〜${i.payload.certification_end_date} 区分${i.payload.support_level ?? "?"} 上限${i.payload.self_payment_limit}`);
  }

  // ── ⑤ 投入後に何が変わるはずか (check:densouの「受給者証なし」への影響を予測) ──
  console.log(`\n=== 投入後に期待される変化 (検算用) ===`);
  for (const MONTH of ["2026-06", "2026-07"]) {
    const monthStart = `${MONTH}-01`;
    const [y, m] = MONTH.split("-").map(Number);
    const monthEnd = `${MONTH}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    const covers = (c) => {
      if (c.certification_start_date && c.certification_start_date > monthEnd) return false;
      if (c.certification_end_date && c.certification_end_date < monthStart) return false;
      return true;
    };
    const shoOkBefore = new Set(mine.filter(covers).map((s) => s.client_id));
    const newRowsThisMonth = inserts.filter((i) => covers(i.payload)).map((i) => i.client_id);
    const shoOkAfter = new Set([...shoOkBefore, ...newRowsThisMonth]);

    const { data: visits } = await sb.from("kaigo_visit_schedule")
      .select("user_id").eq("system", "障害").eq("status", "completed")
      .gte("visit_date", monthStart).lte("visit_date", monthEnd);
    const workedIds = new Set(visits.map((v) => v.user_id));
    const noCertBefore = [...workedIds].filter((id) => !shoOkBefore.has(id));
    const noCertAfter = [...workedIds].filter((id) => !shoOkAfter.has(id));
    console.log(`[${MONTH}] check:densou「対象月に有効な受給者証が無い」: ` +
      `現状 ${noCertBefore.length} 名 → 投入後の予測 ${noCertAfter.length} 名`);
  }

  console.log(`\n${EXECUTE ? "" : "※ DRY RUN のため INSERT していません。--execute は user 承認後のみ。"}`);
  if (!EXECUTE) return;

  let n = 0;
  for (const i of inserts) {
    const { error } = await sb.from("shougai_certifications").insert(i.payload);
    if (error) { console.error(`✗ ${nameOf.get(i.client_id)}: ${error.message}`); process.exit(1); }
    n++;
  }
  console.log(`✓ ${n} 件を新規INSERTしました (既存行は一切変更していません)`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
