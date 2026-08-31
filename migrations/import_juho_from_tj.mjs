// ============================================================================
// ⚠⚠ **未完成 / 現在は使わない** (2026-08-30)
//   投入はできるが **集計側が拾えない**。
//   aggregate.ts は service_type を障害マスタの名前と完全一致で引く。
//   「重度訪問介護」という名前はマスタに無いので、時刻から引き直す経路に入るが、
//   重訪は **積み上げ型** (1 提供から段を複数出す) なのでその経路では扱えない。
//   実際に投入したら おゆみ野 の「ほのぼののみ」が 1 → 10 名に悪化したため撤回した。
//
//   使うには先に集計側の対応が要る:
//     ・service_type が「重度訪問介護」の行を積み上げで解決する経路を aggregate.ts に足す
//     ・または取込時点で段に展開して入れる (juhoConvsForDay 相当をこちらに持つ)
//
// 重度訪問介護の実績を **TJ (実績記録票) から** 取り込む。
//
// ── なぜ TJ から取るのか ──────────────────────────────────────────────
//   ほのぼのは 給与用 と 請求用 を別々に入力している。
//
//     NEXT 賃金集計 (MEISAI)   09:00-12:00 + 12:00-13:00 + 13:00-17:00   8.0h  給与
//     more 実績記録票 (TJ)     09:00-12:00 +               13:00-17:00   7.0h  請求
//
//   12:00-13:00 は **休憩**。給与は払うが請求はできない (事業所の持ち出し)。
//   MEISAI には休憩を示す列が無い (3 行とも「重度15％」で時間の長さしか違わない)ので、
//   MEISAI から起こすと **休憩ぶんまで請求してしまう** (おゆみ野だけで 213時間ぶん)。
//
//   → **過去分は TJ を正とする**。TJ はほのぼのが実際に請求した記録そのもの。
//   → 運用開始後はシフトに「休憩」区分を持たせて 1 入力から出し分ける (別途)。
//
// ── TJ の読み方 ───────────────────────────────────────────────────────
//   レコード種別 "2" / 様式 "J611" / 明細区分 "02" が 1 提供
//     c[4] 提供年月  c[5] 市町村番号  c[6] 事業所番号  c[7] 受給者証番号
//     c[9] **提供通番** (月内の連番。日ではない)   c[10] **日**
//     c[12] サービスコード (**重訪は空**)
//     ⚠ 1 日 2 行の利用者だと通番と日がたまたま一致するので取り違えやすい。
//       1 日 3 行以上ある人 (おゆみ野 1221113051) で 通番31/日26 のようにズレる。
//     c[15] 開始 HHMM  c[16] 終了 HHMM
//     c[17] 算定時間 (**10進時間 ×100**。0750 = 7.50時間)  c[20] 人数
//   詳細は docs/TJ_JISSEKI_STRUCTURE.md
//
//   node migrations/import_juho_from_tj.mjs            # DRY RUN
//   node migrations/import_juho_from_tj.mjs --execute
//   env: MONTH=2026-06 / AREA=おゆみ野 (省略時は全拠点)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { assertRefsExist } from "./_fk_guard.mjs";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const YM = MONTH.replace("-", "");
const ONLY_AREA = process.env.AREA || null;
const TENANT = "kt-group";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const MARKER = "[TJ重訪取込";

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

const sp = (l) => l.split(",").map((s) => s.replace(/^"|"$/g, ""));
const walk = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const hhmm = (s) => {
  const t = String(s ?? "").padStart(4, "0");
  if (!/^\d{4}$/.test(t)) return null;
  return `${t.slice(0, 2)}:${t.slice(2)}`;
};

async function fetchAll(table, select, tweak) {
  let out = [], from = 0;
  for (;;) {
    let q = sb.from(table).select(select).order("id").order("id").range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) { console.error(`✗ ${table}: ${error.message}`); process.exit(1); }
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`=== 重訪の実績を TJ から取込 ${MONTH} ` +
    `${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const files = walk(path.join(KAIGO, "伝送データ"))
    .filter((f) => /TJ\d+\.CSV$/i.test(f) && f.includes(YM))
    .filter((f) => !ONLY_AREA || f.includes(path.sep + ONLY_AREA + path.sep));
  console.log(`  TJ ファイル ${files.length} 件`);

  // 事業所: 障害事業所番号 → office
  const offices = await fetchAll("offices", "id, name, shogai_business_number");
  const offByBn = new Map(offices.filter((o) => o.shogai_business_number)
    .map((o) => [o.shogai_business_number, o]));

  // 受給者証番号 → client_id
  const certs = await fetchAll("shougai_certifications",
    "client_id, beneficiary_number, clients(name)");
  const byJukyu = new Map();
  for (const c of certs) {
    if (!c.beneficiary_number) continue;
    if (!byJukyu.has(c.beneficiary_number)) byJukyu.set(c.beneficiary_number, new Set());
    byJukyu.get(c.beneficiary_number).add(c.client_id);
  }

  const rowsByOffice = new Map();
  const problems = [];
  let juhoRows = 0;
  for (const f of files) {
    const area = path.relative(path.join(KAIGO, "伝送データ"), f).split(path.sep)[0];
    const recs = iconv.decode(readFileSync(f), "Shift_JIS").split(/\r?\n/)
      .filter((l) => l.trim()).map(sp)
      .filter((c) => c[0] === "2" && c[2] === "J611" && c[3] === "02" && !c[12]);
    if (!recs.length) continue;
    juhoRows += recs.length;
    for (const c of recs) {
      const bn = c[6], jukyu = c[7], day = Number(c[10]);
      const off = offByBn.get(bn);
      if (!off) { problems.push(`${area}: 事業所番号 ${bn} が未登録`); continue; }
      const ids = byJukyu.get(jukyu);
      if (!ids) { problems.push(`${area}: 受給者証 ${jukyu} が当方に無い`); continue; }
      if (ids.size > 1) { problems.push(`${area}: 受給者証 ${jukyu} が複数の利用者に紐づく`); continue; }
      const start = hhmm(c[15]), end = hhmm(c[16]);
      if (!start || !end) { problems.push(`${area}: ${jukyu} 日${day} 時刻が読めない`); continue; }
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        problems.push(`${area}: ${jukyu} 日付が範囲外 (${c[10]})`); continue;
      }
      const date = `${MONTH}-${String(day).padStart(2, "0")}`;
      const key = off.id;
      if (!rowsByOffice.has(key)) rowsByOffice.set(key, { office: off, area, rows: [] });
      rowsByOffice.get(key).rows.push({
        tenant_id: TENANT, user_id: [...ids][0], office_id: off.id,
        visit_date: date, start_time: start, end_time: end,
        // サービス名は集計側 (aggregate.ts) が段を解決するので、ここでは素の重訪として入れる
        service_type: "重度訪問介護",
        status: "completed", system: "障害",
        notes: `${MARKER} ${MONTH} ${area} 受給者証=${jukyu}]`,
      });
    }
  }

  console.log(`  TJ の重訪行 ${juhoRows} 行\n`);
  for (const { office, area, rows } of rowsByOffice.values()) {
    const users = new Set(rows.map((r) => r.user_id));
    console.log(`  ${area.padEnd(8)} ${office.name.padEnd(28)} ${String(rows.length).padStart(4)}行 / ${users.size}名`);
  }
  if (problems.length) {
    const uniq = [...new Set(problems)];
    console.log(`\n  ⚠ 取り込めないもの ${problems.length} 件 (${uniq.length} 種)`);
    for (const p of uniq.slice(0, 10)) console.log(`     ${p}`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で反映します。"); return; }

  const all = [...rowsByOffice.values()].flatMap((v) => v.rows);
  // ★ 削除の前に FK を検証する
  await assertRefsExist(sb, all, [{ column: "user_id", table: "clients", label: "利用者" }],
    { hint: "受給者証 → client_id の解決を確認" });

  const [y, m] = MONTH.split("-").map(Number);
  const LAST = `${MONTH}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  for (const { office, area, rows } of rowsByOffice.values()) {
    // 冪等: この取込が入れた行だけを消す (MEISAI 由来の行は別マーカーなので触らない)
    const { error: dErr } = await sb.from("kaigo_visit_schedule").delete()
      .eq("office_id", office.id).like("notes", `${MARKER}%`)
      .gte("visit_date", `${MONTH}-01`).lte("visit_date", LAST);
    if (dErr) { console.error(`✗ ${area} 削除: ${dErr.message}`); process.exit(1); }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("kaigo_visit_schedule").insert(rows.slice(i, i + 500));
      if (error) { console.error(`✗ ${area} INSERT: ${error.message}`); process.exit(1); }
    }
    console.log(`  ✓ ${area} ${rows.length}行`);
  }
  console.log(`\n✓ 合計 ${all.length} 行を投入しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
