// ============================================================================
// kaigo_visit_schedule.system (制度区分) を ほのぼのの実伝送から起こす。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   同じ利用者の同じ月の訪問が **日単位で介護と障害に振り分けられている**。
//   2026-06 の実データで 26 名が該当 (佐藤裕史: 毎週月曜だけ介護 / 石井進: 2日だけ障害)。
//   限度額でも期間でもサービス内容でも説明がつかず、その都度の判断で決まっている。
//   稼働データ (MEISAI) には制度の区別が無く、サービス名も介護の名前しか入らないため
//   (秋山久子: 11 回すべて「身2夜」なのに ほのぼのは 7 回を介護 / 4 回を障害で請求)、
//   実績側に「どちらで請求したか」を持たないと再現できない。
//
//   ⚠ **これは検証にはならない** (伝送由来)。過去分の突合を前に進めるための移行データ。
//     運用開始後はシフト登録時に選ぶ (両制度を持つ利用者 59 名のみ選択が要る)。
//
// ── 判定 ──────────────────────────────────────────────────────────────
//   障害の実績記録票 (TJ = J611-02) に **日付 + 開始/終了時刻**が入っている。
//   ⚠ **日付だけで振り分けてはいけない**。同じ日に介護と障害の両方の訪問がある利用者が
//     いる (伊藤紀子 6/2: 13:00 障害 / 14:30 介護)。日付だけだと介護分まで障害に変わり
//     介護給付が過少になる (2026-08-07 に実際に踏んだ)。**開始時刻まで一致**を条件にする。
//   さらに、名前で既に制度が分かれている行 (障害名で登録済) は触らない。
//   名前で判別できないのは秋山久子のような例外だけ。
//   ⚠ 総合事業 (A系) は名前で確実に判別できるので触らない。
//
//   SY_OFFICE_ID=<uuid> SY_TJ=<TJファイル> SY_MONTH=2026-06 SY_LABEL=<拠点> \
//     node migrations/set_schedule_system_from_densou.mjs            # DRY RUN
//   … --execute で更新
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = process.env.SY_OFFICE_ID;
const TJ = process.env.SY_TJ;
const MONTH = process.env.SY_MONTH || "2026-06";
const LABEL = process.env.SY_LABEL || "";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

if (!OFFICE_ID || !TJ) {
  console.error("✗ SY_OFFICE_ID と SY_TJ を指定してください");
  process.exit(1);
}

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

const [Y, M] = MONTH.split("-").map(Number);
const FIRST = `${MONTH}-01`;
const LAST = `${MONTH}-${String(new Date(Y, M, 0).getDate()).padStart(2, "0")}`;

async function main() {
  console.log(`=== シフトの制度区分を伝送から設定 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ${LABEL} ${MONTH} ===\n`);

  // 1) 障害で提供した (受給者証番号, 日) を実績記録票から集める
  const rows = iconv
    .convert(readFileSync(TJ), { to: "UNICODE", from: "SJIS", type: "string" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")));
  const shogaiDays = new Map(); // 受給者証番号 -> Set(YYYY-MM-DD)
  for (const r of rows) {
    if (r[2] !== "J611" || r[3] !== "02") continue;
    const day = Number(r[10] ?? 0);
    if (!(day >= 1 && day <= 31)) continue;
    const hhmm = (r[15] ?? "").trim(); // 項14 開始時間 HHMM
    if (!/^\d{4}$/.test(hhmm)) continue;
    if (!shogaiDays.has(r[7])) shogaiDays.set(r[7], new Set());
    // キーは「日付 + 開始時刻」。同日に複数訪問があっても取り違えない
    shogaiDays.get(r[7]).add(`${MONTH}-${String(day).padStart(2, "0")} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`);
  }
  console.log(`障害の提供実績: ${shogaiDays.size} 名 / ${[...shogaiDays.values()].reduce((a, s) => a + s.size, 0)} 件 (日付+開始時刻)`);
  if (!shogaiDays.size) { console.log("対象なし。"); return; }

  // 2) 受給者証番号 -> client_id
  const { data: certs, error: e1 } = await sb
    .from("shougai_certifications")
    .select("client_id, beneficiary_number, clients(name)")
    .in("beneficiary_number", [...shogaiDays.keys()]);
  if (e1) { console.error(`✗ ${e1.message}`); process.exit(1); }
  const byBene = new Map(certs.map((c) => [c.beneficiary_number, c]));

  // 3) その事業所・その月のシフトを引き、日付で介護/障害に振り分ける
  const targets = [];
  for (const [bene, days] of shogaiDays) {
    const c = byBene.get(bene);
    if (!c) continue;
    targets.push({ client_id: c.client_id, name: c.clients?.name ?? "", days });
  }
  if (!targets.length) { console.log("受給者証が紐付く利用者がいません。"); return; }

  const { data: sched, error: e2 } = await sb
    .from("kaigo_visit_schedule")
    .select("id, user_id, visit_date, start_time, service_type, system")
    .eq("office_id", OFFICE_ID)
    .gte("visit_date", FIRST)
    .lte("visit_date", LAST)
    .in("user_id", targets.map((t) => t.client_id));
  if (e2) { console.error(`✗ ${e2.message}`); process.exit(1); }

  // ⚠ 「TJ に無い = 介護」は乱暴すぎた。介護マスタに **その名前が存在しない**
  //   サービス (重訪Ⅱ日中８．０ 等の障害専用名 / 総合事業名) まで介護と書いてしまい、
  //   集計側が障害から除外して請求漏れになる (2026-08-19 に 238 件是正)。
  //   介護に振るのは「介護マスタに名前があるサービス = 両制度にあり得る行」だけにする。
  const schedNames = Array.from(
    new Set((sched ?? []).map((s) => (s.service_type ?? "").trim()).filter(Boolean)),
  );
  const kaigoNames = new Set();
  for (let i = 0; i < schedNames.length; i += 50) {
    const { data, error } = await sb
      .from("kaigo_service_codes")
      .select("service_name")
      .eq("system", "介護")
      .in("service_name", schedNames.slice(i, i + 50));
    if (error) { console.error(`✗ 介護マスタ照合失敗: ${error.message}`); process.exit(1); }
    for (const c of data ?? []) kaigoNames.add(c.service_name.trim());
  }

  const toShogai = [], toKaigo = [];
  let skippedShogaiOnly = 0;
  for (const s of sched ?? []) {
    const t = targets.find((x) => x.client_id === s.user_id);
    if (!t) continue;
    const key = `${s.visit_date} ${(s.start_time ?? "").slice(0, 5)}`;
    if (t.days.has(key)) { toShogai.push(s.id); continue; }
    // TJ に無い。介護にあり得る名前のときだけ介護に振る (それ以外は未設定のまま)
    if (kaigoNames.has((s.service_type ?? "").trim())) toKaigo.push(s.id);
    else skippedShogaiOnly++;
  }
  if (skippedShogaiOnly) {
    console.log(
      `  (介護マスタに無い名前のため未設定のまま: ${skippedShogaiOnly} 件 — 重訪・総合事業等)`,
    );
  }
  for (const t of targets) {
    const mine = (sched ?? []).filter((s) => s.user_id === t.client_id);
    const sn = mine.filter((s) => t.days.has(`${s.visit_date} ${(s.start_time ?? "").slice(0, 5)}`)).length;
    console.log(`  ${t.name.padEnd(14)} シフト${String(mine.length).padStart(3)}件 → 障害${String(sn).padStart(3)} / 介護${String(mine.length - sn).padStart(3)}`);
  }
  console.log(`\n更新対象: 障害 ${toShogai.length} 件 / 介護 ${toKaigo.length} 件`);
  if (!EXECUTE) { console.log("※ DRY RUN。--execute で更新します。"); return; }

  for (const [ids, val] of [[toShogai, "障害"], [toKaigo, "介護"]]) {
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await sb
        .from("kaigo_visit_schedule").update({ system: val }).in("id", ids.slice(i, i + 100));
      if (error) { console.error(`✗ 更新失敗 (${val}): ${error.message}`); process.exit(1); }
    }
  }
  console.log(`✓ 完了: 障害 ${toShogai.length} / 介護 ${toKaigo.length}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
