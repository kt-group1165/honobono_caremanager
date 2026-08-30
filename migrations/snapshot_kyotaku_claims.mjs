// ============================================================================
// 居宅レセプトの退避 / 突合。**アプリの一括生成が正しく計算できるか**を試すため。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   いま居宅のレセプトは伝送 (KK/8124) から取り込んだ値。つまり答えの写しで、
//   アプリの算定ロジック (要介護度→基本コード / 逓減制 / 特定事業所加算 /
//   処遇改善 / 単価) を一度も通していない。稼働後はほのぼのが無くなり、
//   この計算が毎月の請求額そのものになるので、稼働前に一度試しておく。
//
// ── 使い方 ────────────────────────────────────────────────────────────
//   1) 退避      node migrations/snapshot_kyotaku_claims.mjs save
//   2) 請求画面の「一括生成」を押す (対象事業所・対象月)
//   3) 突合      node migrations/snapshot_kyotaku_claims.mjs diff
//   4) 戻す      node migrations/snapshot_kyotaku_claims.mjs restore --execute
//
//   env: MONTH=2026-06 / AREA 相当の OFFICE=<事業所名の一部> (省略時は全事業所)
//
// ── 突合で無視するもの ────────────────────────────────────────────────
//   一括生成は **個別加算を全て OFF** で作る (初回・入院時情報連携・退院退所・
//   通院時・ターミナル・緊急時カンファは請求個人設定タブで人が入れる運用)。
//   なので個別加算が付いている利用者は「加算ぶんの差」として別枠で数え、
//   基本部分 (基本コード・単位・特定事業所加算・処遇改善・単価) の一致を見る。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODE = process.argv[2] ?? "diff";
const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const OFFICE = process.env.OFFICE || null;
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const SNAP_DIR = path.join(KAIGO, "migrations", "_snapshots");
const SNAP = path.join(SNAP_DIR, `kyotaku_claims_${MONTH}.json`);

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

/** 個別加算 (一括生成では必ず OFF になる列) */
const INDIVIDUAL_ADDONS = [
  "initial_addition", "initial_addition_units",
  "hospital_coordination", "hospital_coordination_units",
  "discharge_addition", "discharge_addition_units", "discharge_type",
  "medical_coordination", "medical_coordination_units",
  "terminal_care", "terminal_care_units",
  "emergency_conference", "emergency_conference_units",
];
/** 一括生成が計算する = 検証したい列 */
const CALC_FIELDS = [
  "care_support_code", "care_support_name", "units",
  "tokutei_kassan_type", "tokutei_kassan_units",
  "medical_coop_kassan", "medical_coop_kassan_units",
  "shoguu_kaizen_units", "shoguu_kaizen_code",
  "unit_price",
];

async function fetchClaims() {
  const { data: offs, error: e0 } = await sb.from("offices")
    .select("id, name").eq("service_type", "居宅介護支援");
  if (e0) { console.error(`✗ ${e0.message}`); process.exit(1); }
  const targets = (offs ?? []).filter((o) => !OFFICE || o.name.includes(OFFICE));
  const out = [];
  for (const off of targets) {
    const { data: a, error: e1 } = await sb.from("client_office_assignments")
      .select("client_id").eq("office_id", off.id);
    if (e1) { console.error(`✗ ${e1.message}`); process.exit(1); }
    const ids = [...new Set((a ?? []).map((x) => x.client_id))];
    for (let i = 0; i < ids.length; i += 80) {
      const { data, error } = await sb.from("kaigo_care_support_claims")
        .select("*, clients:user_id(name)")
        .in("user_id", ids.slice(i, i + 80)).eq("billing_month", MONTH);
      if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
      for (const c of data ?? []) out.push({ ...c, _office: off.name, _name: c.clients?.name ?? "?" });
    }
  }
  return out;
}

const hasIndividualAddon = (r) =>
  r.initial_addition || r.hospital_coordination || r.discharge_addition ||
  r.medical_coordination || r.terminal_care || r.emergency_conference;

async function main() {
  if (MODE === "save") {
    const rows = await fetchClaims();
    if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(SNAP, JSON.stringify({ month: MONTH, savedAt: new Date().toISOString(), rows }, null, 1), "utf8");
    console.log(`✓ ${rows.length} 件を退避しました → ${path.relative(KAIGO, SNAP)}`);
    console.log(`  個別加算あり ${rows.filter(hasIndividualAddon).length} 件 (一括生成では OFF になるので突合時は別枠)`);
    return;
  }

  if (!existsSync(SNAP)) { console.error(`✗ 退避がありません。先に save してください: ${SNAP}`); process.exit(1); }
  const snap = JSON.parse(readFileSync(SNAP, "utf8"));
  const byUser = new Map(snap.rows.map((r) => [r.user_id, r]));

  if (MODE === "restore") {
    const targets = OFFICE ? snap.rows.filter((r) => r._office.includes(OFFICE)) : snap.rows;
    console.log(`=== 退避から復元 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===`);
    console.log(`  ${targets.length} 件を書き戻します\n`);
    if (!EXECUTE) { console.log("※ DRY RUN。--execute で復元します。"); return; }
    for (const r of targets) {
      const row = { ...r };
      delete row.clients; delete row._office; delete row._name; delete row.id;
      const { error } = await sb.from("kaigo_care_support_claims")
        .upsert(row, { onConflict: "user_id,billing_month" });
      if (error) { console.error(`✗ ${r._name}: ${error.message}`); process.exit(1); }
    }
    console.log(`✓ ${targets.length} 件を復元しました`);
    return;
  }

  // diff
  const now = await fetchClaims();
  console.log(`=== アプリの一括生成 vs 伝送 ${MONTH} ===`);
  console.log(`  退避 ${snap.rows.length} 件 (${snap.savedAt}) / 現在 ${now.length} 件\n`);

  const perOffice = new Map();
  const detail = [];
  let onlyNow = 0, onlySnap = 0;
  for (const r of now) {
    const s = byUser.get(r.user_id);
    if (!s) { onlyNow++; continue; }
    const o = perOffice.get(r._office) ?? { ok: 0, ng: 0, addon: 0 };
    const diffs = CALC_FIELDS
      .filter((f) => String(r[f] ?? "") !== String(s[f] ?? ""))
      .map((f) => `${f}: 生成 ${r[f] ?? "(空)"} / 伝送 ${s[f] ?? "(空)"}`);
    if (hasIndividualAddon(s)) o.addon++;
    else if (diffs.length) { o.ng++; detail.push({ r, s, diffs }); }
    else o.ok++;
    perOffice.set(r._office, o);
  }
  for (const s of snap.rows) if (!now.some((r) => r.user_id === s.user_id)) onlySnap++;

  console.log(`  ${"事業所".padEnd(32)}${"一致".padStart(6)}${"不一致".padStart(8)}${"個別加算あり(対象外)".padStart(22)}`);
  for (const [name, o] of [...perOffice].sort()) {
    console.log(`  ${name.padEnd(32)}${String(o.ok).padStart(6)}${String(o.ng).padStart(8)}${String(o.addon).padStart(22)}${o.ng ? "  ★" : ""}`);
  }
  if (onlyNow || onlySnap) console.log(`\n  ⚠ 生成にのみ ${onlyNow} 件 / 伝送にのみ ${onlySnap} 件`);

  const show = detail.slice(0, 30);
  if (show.length) {
    console.log(`\n  -- 不一致の中身 (先頭 ${show.length} / 全 ${detail.length}) --`);
    for (const d of show) {
      console.log(`     ${d.s._office} ${d.s._name}`);
      for (const x of d.diffs) console.log(`         ${x}`);
    }
  } else {
    console.log(`\n  ✅ 基本部分はすべて一致 (個別加算ありの利用者を除く)`);
  }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
