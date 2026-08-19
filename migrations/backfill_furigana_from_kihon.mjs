// ============================================================================
// 利用者のフリガナを ほのぼの「基本情報」CSV から補完する。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   障害の伝送 J121-01 は 項8 支給決定者氏名カナ / 項9 支給決定児童氏名カナ を出す。
//   ほのぼのは自分の DB のカナを載せているが、**PDF 出力 (基本情報・受給者証) には
//   カナ欄が無い**ため、障害だけを PDF から取り込んだ利用者はカナが空になる
//   (2026-08-07 四街道: 松戸孝雄 等で伝送が不一致)。
//   一方、介護保険側の 基本情報 CSV には**フリガナ列がある**ので、そこから引く。
//
//   ⚠ 漢字からの自動生成はしない。「松戸」を ﾏﾂﾄﾞ と読むか ﾏﾂﾄ かは機械では決まらず、
//     誤ったカナを伝送に載せることになる。**実データにあるものだけ**入れる。
//
// ── 突合 ──────────────────────────────────────────────────────────────
//   1) 氏名(空白除去) + 生年月日 が一致 … 確実
//   2) 氏名だけ一致 かつ CSV 側で**その氏名が一意**  … 同姓同名は入れない
//   既にフリガナが入っている利用者は触らない。
//
//   node migrations/backfill_furigana_from_kihon.mjs            # DRY RUN
//   node migrations/backfill_furigana_from_kihon.mjs --execute
//
//   ONLY_SHOGAI=1 を付けると障害の受給者証を持つ利用者だけに絞る。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const ONLY_SHOGAI = process.env.ONLY_SHOGAI === "1";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

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

const readCsv = (p) =>
  iconv
    .convert(readFileSync(p), { to: "UNICODE", from: "SJIS", type: "string" })
    .split(/\r?\n/)
    .filter((l) => l.length)
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")));

/** 氏名の正規化: 全半角空白を除去 (CSV は「松戸 孝雄」/ DB は「松戸 孝雄」で揺れる) */
const normName = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
/** 生年月日を YYYY-MM-DD に揃える (CSV は 1939/01/15 や 1939/1/15) */
const normBirth = (s) => {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
};

function collectKihonFiles(dir, out = []) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) collectKihonFiles(p, out);
    else if (/^基本情報.*\.CSV$/i.test(f.name)) out.push(p);
  }
  return out;
}

async function fetchAll(table, cols, filt) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    let q = sb.from(table).select(cols).range(f, f + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== フリガナ補完 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"}${ONLY_SHOGAI ? " (障害の受給者のみ)" : ""} ===\n`);

  // 1) 基本情報 CSV から辞書
  const files = collectKihonFiles(path.join(KAIGO, "利用者データ"));
  const byNameBirth = new Map(); // 氏名|生年月日 -> カナ
  const byName = new Map(); // 氏名 -> Set<カナ> (一意判定用)
  for (const p of files) {
    let rows;
    try { rows = readCsv(p); } catch { continue; }
    const h = rows[0] ?? [];
    const iN = h.indexOf("利用者名");
    const iF = h.indexOf("フリガナ");
    const iB = h.findIndex((x) => /生年月日/.test(x));
    if (iN < 0 || iF < 0) continue;
    for (const r of rows.slice(1)) {
      const n = normName(r[iN]);
      const kana = (r[iF] ?? "").trim();
      if (!n || !kana) continue;
      const b = normBirth(r[iB]);
      if (b) byNameBirth.set(`${n}|${b}`, kana);
      if (!byName.has(n)) byName.set(n, new Set());
      byName.get(n).add(kana);
    }
  }
  console.log(`基本情報 CSV ${files.length} 本 → 氏名+生年月日 ${byNameBirth.size} 件 / 氏名 ${byName.size} 件\n`);

  // 2) 対象の利用者
  let targetIds = null;
  if (ONLY_SHOGAI) {
    const certs = await fetchAll("shougai_certifications", "client_id");
    targetIds = [...new Set(certs.map((c) => c.client_id))];
  }
  const clients = [];
  if (targetIds) {
    for (let i = 0; i < targetIds.length; i += 100) {
      clients.push(
        ...(await fetchAll("clients", "id, name, furigana, birth_date", (q) =>
          q.in("id", targetIds.slice(i, i + 100)),
        )),
      );
    }
  } else {
    clients.push(...(await fetchAll("clients", "id, name, furigana, birth_date")));
  }
  const missing = clients.filter((c) => !(c.furigana ?? "").trim());
  console.log(`対象 ${clients.length} 名 / フリガナ未設定 ${missing.length} 名\n`);

  // 3) 突合
  const plan = [];
  const unresolved = [];
  let byBirth = 0, byNameOnly = 0;
  for (const c of missing) {
    const n = normName(c.name);
    const b = normBirth(c.birth_date);
    let kana = b ? byNameBirth.get(`${n}|${b}`) : undefined;
    let how = "氏名+生年月日";
    if (!kana) {
      const set = byName.get(n);
      // 同姓同名で読みが割れる場合は入れない (誤ったカナを伝送に載せない)
      if (set && set.size === 1) { kana = [...set][0]; how = "氏名のみ(一意)"; }
    }
    if (!kana) { unresolved.push(c); continue; }
    if (how === "氏名+生年月日") byBirth++; else byNameOnly++;
    plan.push({ id: c.id, name: c.name, kana, how });
  }
  console.log(`補完できる: ${plan.length} 名 (氏名+生年月日 ${byBirth} / 氏名のみ ${byNameOnly})`);
  for (const p of plan.slice(0, 15)) console.log(`   ${String(p.name).padEnd(14)} ${p.kana.padEnd(18)} ${p.how}`);
  if (plan.length > 15) console.log(`   … 他 ${plan.length - 15} 名`);
  console.log(`\n補完できない: ${unresolved.length} 名 (基本情報 CSV に無い / 同姓同名で読みが割れる)`);
  for (const c of unresolved.slice(0, 15)) console.log(`   ${c.name}`);
  if (unresolved.length > 15) console.log(`   … 他 ${unresolved.length - 15} 名`);

  if (!EXECUTE) { console.log(`\n※ DRY RUN。--execute で更新します。`); return; }
  if (!plan.length) { console.log(`\n更新対象なし。`); return; }

  let done = 0;
  for (const p of plan) {
    const { error } = await sb.from("clients").update({ furigana: p.kana }).eq("id", p.id);
    if (error) { console.error(`✗ ${p.name}: ${error.message}`); process.exit(1); }
    done++;
  }
  console.log(`\n✓ 完了: ${done} 名にフリガナを設定`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
