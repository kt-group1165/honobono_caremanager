// ============================================================================
// kaigo_visit_schedule.system が未設定の **重度訪問介護 / 同行援護** 行に「障害」を立てる。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   重訪・同行援護は介護保険に存在しないサービスなので制度は一意に決まる。
//   なのに 2026-06 時点で 3,573 件が system=null だった (おゆみ野 2,383 / 中央 732 /
//   花見川 290 / やわた 168)。
//
//   集計そのものは service_type で拾っているので請求額は変わらないが、
//   シフト画面・実績記録票・経営分析が制度で切れなくなる。
//   (memory: feedback_negative_inference_system_label — 「片方に無い＝もう一方」は禁物。
//    ここは逆に **名前だけで制度が確定する**ケースなので安全に振れる)
//
// ── 安全策 ────────────────────────────────────────────────────────────
//   ・**障害マスタに実在するサービス名**のものだけ振る (名前の推測をしない)
//   ・既に system が入っている行は触らない (介護と入っていても上書きしない。
//     もし介護が入っていたら誤りの可能性があるので警告に出す)
//
//   node migrations/fix_schedule_system_juho.mjs            # DRY RUN
//   node migrations/fix_schedule_system_juho.mjs --execute
//   env: FROM=2026-06-01 TO=2026-06-30 (既定) / ALL=1 で全期間
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const ALL = process.env.ALL === "1";
const FROM = process.env.FROM || "2026-06-01";
const TO = process.env.TO || "2026-06-30";
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

async function fetchAll(table, select, tweak) {
  let out = [], from = 0;
  for (;;) {
    let q = sb.from(table).select(select).order("id").range(from, from + 999);
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
  console.log(`=== 重訪・同行援護 の system を「障害」に ` +
    `${ALL ? "(全期間)" : `${FROM}〜${TO}`} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 障害マスタに実在するサービス名だけを対象にする (推測で振らない)
  const codes = await fetchAll("kaigo_service_codes", "service_name, system",
    (q) => q.eq("system", "障害"));
  const shogaiNames = new Set(codes.map((c) => (c.service_name ?? "").trim()));
  console.log(`  障害マスタのサービス名 ${shogaiNames.size} 種`);

  const rows = await fetchAll("kaigo_visit_schedule",
    "id, system, service_type, office_id, visit_date, status",
    (q) => ALL ? q : q.gte("visit_date", FROM).lte("visit_date", TO));
  console.log(`  対象期間の予定・実績 ${rows.length} 件\n`);

  const isJuhoOrDoukou = (n) => /^重訪|^重度訪問|^同援|^同行援護/.test((n ?? "").trim());
  const cand = rows.filter((r) => isJuhoOrDoukou(r.service_type));
  const inMaster = cand.filter((r) => shogaiNames.has((r.service_type ?? "").trim()));
  const notInMaster = cand.filter((r) => !shogaiNames.has((r.service_type ?? "").trim()));

  const target = inMaster.filter((r) => r.system == null);
  const alreadyKaigo = inMaster.filter((r) => r.system === "介護");

  console.log(`  重訪・同行援護の行 ${cand.length} 件`);
  console.log(`     障害マスタに実在 ${inMaster.length} / 実在しない ${notInMaster.length}`);
  console.log(`     system 未設定 → 障害にする ${target.length} 件`);
  if (alreadyKaigo.length) {
    console.log(`  ⚠ system='介護' になっている ${alreadyKaigo.length} 件 (触らない。要確認)`);
  }
  if (notInMaster.length) {
    const names = [...new Set(notInMaster.map((r) => r.service_type))].slice(0, 10);
    console.log(`  ⚠ 障害マスタに無い名前 (振らない): ${names.join(" / ")}`);
  }

  // 事業所別
  const byOff = {};
  for (const r of target) byOff[r.office_id ?? "(なし)"] = (byOff[r.office_id ?? "(なし)"] ?? 0) + 1;
  const offs = await fetchAll("offices", "id, name");
  const nm = new Map(offs.map((o) => [o.id, o.name]));
  console.log(`\n  事業所別:`);
  for (const [k, v] of Object.entries(byOff).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(v).padStart(5)}  ${nm.get(k) ?? k}`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で反映します。"); return; }

  let n = 0;
  for (let i = 0; i < target.length; i += 200) {
    const chunk = target.slice(i, i + 200);
    const { error } = await sb.from("kaigo_visit_schedule")
      .update({ system: "障害", updated_at: new Date().toISOString() })
      .in("id", chunk.map((r) => r.id));
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    n += chunk.length;
    console.log(`  … ${n}/${target.length}`);
  }
  console.log(`\n✓ ${n} 件に system='障害' を設定しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
