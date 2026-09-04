// ============================================================================
// 障害福祉サービス サンプルデータ投入 (担当 L / マーカー `l`)
//
//   SAMPLE_DATA_PROTOCOL.md に従う:
//     対象月 2026-12 固定 / user_number = ZL### / name 末尾 [sample-l]
//     notes 末尾 [sample-l-20260903] / 事業所は実在のものを使い offices は変更しない
//
//   使い方:
//     node migrations/seed_sample_shogai_l.mjs            # DRY RUN
//     node migrations/seed_sample_shogai_l.mjs --execute   # 投入
//     node migrations/seed_sample_shogai_l.mjs --delete    # 撤去
//     node migrations/seed_sample_shogai_l.mjs --verify    # 件数確認のみ
//
//   ⚠ 重訪の段は **本番と同じ _juho_ladder.mjs** で生成する。
//     手で段を書くとロジックを検証したことにならない。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { juhoConvsForDay } from "./_juho_ladder.mjs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const VERIFY = process.argv.includes("--verify");

const MONTH = "2026-12";
const TENANT = "kt-group";
const MARK = "[sample-l-20260903]";
const NAME_SUFFIX = "[sample-l]";
const OFFICE_NAME = "Ｈａｎａヘルパーステーション高品";

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// ─── 撤去 (先に用意する) ─────────────────────────────────────────────────────
async function removeAll() {
  const { data: cl, error: e0 } = await sb.from("clients").select("id,user_number,name").like("user_number", "ZL%");
  if (e0) die(`clients 取得失敗: ${e0.message}`);
  const ids = (cl ?? []).map((c) => c.id);
  console.log(`撤去対象の sample 利用者: ${ids.length} 名`);
  for (const c of cl ?? []) console.log(`   ${c.user_number} ${c.name}`);
  if (!ids.length) { console.log("(対象なし)"); return; }
  // ⚠ 2026-09-04 是正: --delete 単体では消さない (--execute が要る)
  if (!EXECUTE) { console.log("【DRY RUN】--delete --execute で実際に削除します"); return; }
  for (const [t, col] of [
    ["kaigo_visit_schedule", "user_id"],
    ["shogai_contracts", "client_id"],
    ["shougai_certifications", "client_id"],
    ["client_office_assignments", "client_id"],
  ]) {
    const { error, count } = await sb.from(t).delete({ count: "exact" }).in(col, ids);
    if (error) die(`${t} 削除失敗: ${error.message}`);
    console.log(`   ${t}: ${count ?? 0} 行 削除`);
  }
  const { error, count } = await sb.from("clients").delete({ count: "exact" }).in("id", ids);
  if (error) die(`clients 削除失敗: ${error.message}`);
  console.log(`   clients: ${count ?? 0} 行 削除`);
}

// ─── 件数確認 ────────────────────────────────────────────────────────────────
async function verify() {
  const { data: cl, error } = await sb.from("clients").select("id,user_number,name").like("user_number", "ZL%");
  if (error) die(`clients: ${error.message}`);
  console.log(`\n=== 件数確認 ===`);
  console.log(`  clients (ZL*): ${cl.length} 名`);
  const ids = cl.map((c) => c.id);
  if (!ids.length) return;
  for (const [t, col] of [
    ["client_office_assignments", "client_id"],
    ["shougai_certifications", "client_id"],
    ["shogai_contracts", "client_id"],
    ["kaigo_visit_schedule", "user_id"],
  ]) {
    const { count, error: e } = await sb.from(t).select("*", { count: "exact", head: true }).in(col, ids);
    if (e) die(`${t}: ${e.message}`);
    console.log(`  ${t}: ${count} 行`);
  }
  const { count: outside, error: e2 } = await sb
    .from("kaigo_visit_schedule").select("*", { count: "exact", head: true })
    .in("user_id", ids).or(`visit_date.lt.${MONTH}-01,visit_date.gt.${MONTH}-31`);
  if (e2) die(`月外チェック: ${e2.message}`);
  console.log(`  ⚠ 対象月 (${MONTH}) の外に出ている実績: ${outside} 行 ${outside === 0 ? "✓" : "★ 規約違反"}`);
}

async function main() {
  if (VERIFY) return verify();
  if (DELETE) { await removeAll(); return verify(); }

  console.log(`=== 障害サンプル投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} 対象月 ${MONTH} ===\n`);

  const { data: exist, error: eEx } = await sb.from("clients").select("id").like("user_number", "ZL%");
  if (eEx) die(`clients: ${eEx.message}`);
  if (exist.length) die(`sample 利用者が既に ${exist.length} 名います。先に --delete してください`);

  const { count: monthRows, error: eM } = await sb.from("kaigo_visit_schedule")
    .select("*", { count: "exact", head: true }).gte("visit_date", `${MONTH}-01`).lte("visit_date", `${MONTH}-31`);
  if (eM) die(`対象月チェック: ${eM.message}`);
  console.log(`対象月 ${MONTH} の既存実績: ${monthRows} 行 (他セッションのサンプルを含む)`);

  const { data: off, error: eO } = await sb.from("offices")
    .select("id,name,shogai_business_number,area_category,unit_price").eq("name", OFFICE_NAME).maybeSingle();
  if (eO) die(`offices: ${eO.message}`);
  if (!off) die(`事業所が見つかりません: ${OFFICE_NAME}`);
  console.log(`事業所: ${off.name} (障害番号 ${off.shogai_business_number} / ${off.area_category} / 単価 ${off.unit_price})\n`);

  const codes = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("kaigo_service_codes")
      .select("service_code,service_name,units,valid_from,valid_until")
      .eq("system", "障害").order("service_code").range(f, f + 999);
    if (error) die(`kaigo_service_codes: ${error.message}`);
    codes.push(...data);
    if (data.length < 1000) break;
  }
  const inM = (r) => (!r.valid_from || r.valid_from <= `${MONTH}-01`) && (!r.valid_until || r.valid_until >= `${MONTH}-01`);
  const live = codes.filter(inM);
  const byName = new Map();
  for (const c of live) if (!byName.has(c.service_name)) byName.set(c.service_name, c);
  const need = (n) => { const c = byName.get(n); if (!c) die(`マスタに無い: ${n}`); return c; };

  const stepsByZone = {};
  for (const [z, label] of [["早", "早朝"], ["日", "日中"], ["夜", "夜間"], ["深", "深夜"]]) {
    const arr = live
      .map((c) => {
        const m = /^重訪(I{1,3})?(日中|夜間|深夜|早朝)([0-9]+\.[0-9]+)$/.exec((c.service_name || "").normalize("NFKC"));
        return m && m[1] === "II" && m[2] === label
          ? { hours: Number(m[3]), code: c.service_code, name: c.service_name, units: c.units }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.hours - b.hours);
    stepsByZone[z] = arr.length ? arr : null;
  }
  if (!stepsByZone["日"]) die("重訪Ⅱ日中の段がマスタから作れません");

  const rep = (n, cnt, day0, s, e) =>
    Array.from({ length: cnt }, (_, i) => ({
      d: `${MONTH}-${String(day0 + i).padStart(2, "0")}`, s, e, n,
    }));

  const SAMPLES = [
    {
      no: "ZL001", name: "サンプル 身体家事", kubun: "区分3", limit: 0, seiho: false,
      jogen: { kubun: "なし", num: null, nm: null },
      note: "居宅介護 身体+家事。基本形",
      visits: [...rep("身体日１．０", 5, 1, "09:00", "10:00"), ...rep("家事日１．０", 3, 10, "13:00", "14:00")],
    },
    {
      no: "ZL002", name: "サンプル 深夜", kubun: "区分4", limit: 4600, seiho: false,
      jogen: { kubun: "なし", num: null, nm: null },
      note: "深夜帯。時間帯で単価が変わるか",
      visits: rep("身体深１．０", 2, 1, "23:00", "24:00"),
    },
    {
      no: "ZL003", name: "サンプル 同行援護", kubun: "区分3", limit: 9300, seiho: false,
      jogen: { kubun: "なし", num: null, nm: null },
      note: "同行援護 (様式1901 の経路)",
      visits: rep("同援日１．０", 4, 5, "10:00", "11:00"),
    },
    {
      no: "ZL004", name: "サンプル 上限他事業所未入力", kubun: "区分5", limit: 4600, seiho: false,
      jogen: { kubun: "他事業所", num: "1234567890", nm: "他社サンプル事業所" },
      note: "上限管理が他事業所で管理結果が未入力 (= 過大請求の型)",
      visits: rep("身体日１．５", 6, 10, "09:00", "10:30"),
    },
  ];

  // ── 時刻フォールバックを **わざと発火させる** サンプル ────────────────────
  //   service_type を **マスタに無い名前**にすると nameMap で引けず、
  //   shogaiCodeFromTime (時刻から6桁コードを引く経路) に落ちる。
  //   同行援護は区分でコードが変わるので、区分あり / 区分が引けない の両方を作る。
  SAMPLES.push({
    no: "ZL006", name: "サンプル 同行フォールバック区分4", kubun: "区分4", limit: 0, seiho: false,
    jogen: { kubun: "なし", num: null, nm: null },
    note: "マスタに無い名前 → 時刻フォールバック。区分4 なので ・区4 のコードが付くべき",
    visits: rep("同行援護（手入力）", 2, 20, "10:00", "11:00"),
    skipExpect: true,
  });
  SAMPLES.push({
    // ⚠ support_level は CHECK 制約付き。実在値は 区分1〜6 と「非該当」だけ (空文字は不可)
    no: "ZL007", name: "サンプル 同行フォールバック区分なし", kubun: "非該当", limit: 0, seiho: false,
    jogen: { kubun: "なし", num: null, nm: null },
    note: "同上だが受給者証が「非該当」で区分が無い → **推測せず落として warning** が出るべき",
    visits: rep("同行援護（手入力）", 2, 22, "10:00", "11:00"),
    skipExpect: true,
  });

  const juhoDays = [
    { d: `${MONTH}-01`, s: 9 * 60, e: 14 * 60 },
    { d: `${MONTH}-02`, s: 16 * 60, e: 22 * 60 },
  ];
  const juhoVisits = [];
  for (const day of juhoDays) {
    const convs = juhoConvsForDay([{ s: day.s, e: day.e }], stepsByZone, null);
    if (!convs) die(`重訪の段が解決できません: ${day.d}`);
    const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    convs.forEach((c, i) => juhoVisits.push({ d: day.d, s: hm(day.s), e: hm(day.e), n: c.name, addon: i > 0 }));
  }
  SAMPLES.push({
    no: "ZL005", name: "サンプル 重度訪問", kubun: "区分6", limit: 0, seiho: false,
    jogen: { kubun: "なし", num: null, nm: null },
    note: "重度訪問介護。段は _juho_ladder.mjs で生成 (本番と同じ経路)",
    visits: juhoVisits,
    // ⚠ 重訪は **支給決定 (shogai_contracts) が無いと集計が請求から外す** (fail-closed)。
    //   最初これを入れずに投入したら 20 件まるごと除外され warning が出た = 正しい挙動。
    //   122000 = 重度訪問介護 障害支援区分6該当者 → 段Ⅱ (juho-tier.ts の JUHO_DECISION_TIER)
    contracts: [{ decision_code: "122000", amount_x100: 20000, amount_unit: "時間" }],
  });

  console.log("=== 手計算した期待単位数 ===");
  for (const s of SAMPLES) {
    if (s.skipExpect) {
      console.log(`  ${s.no} ${s.name}`);
      console.log(`     (マスタに無い名前 = 時刻フォールバックの検証用。期待値は集計側で確認) [${s.note}]`);
      continue;
    }
    let sum = 0;
    const per = new Map();
    for (const v of s.visits) {
      const c = need(v.n);
      sum += c.units;
      per.set(v.n, (per.get(v.n) ?? 0) + 1);
    }
    console.log(`  ${s.no} ${s.name}`);
    for (const [n, cnt] of per) {
      const c = need(n);
      console.log(`     ${n} (${c.service_code}) ${c.units}単位 × ${cnt}回 = ${c.units * cnt}`);
    }
    console.log(`     → 所定単位数 合計 **${sum}**  [${s.note}]`);
  }
  console.log(`\n  サンプル利用者 ${SAMPLES.length} 名 / 実績 ${SAMPLES.reduce((a, s) => a + s.visits.length, 0)} 行`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で投入します"); return; }

  for (const s of SAMPLES) {
    const { data: cl, error: e1 } = await sb.from("clients").insert({
      tenant_id: TENANT, user_number: s.no, name: `${s.name}${NAME_SUFFIX}`,
      furigana: "サンプル", birth_date: "1950-01-01", gender: "男",
    }).select("id").single();
    if (e1) die(`clients insert (${s.no}): ${e1.message}`);
    const cid = cl.id;

    const { error: e2 } = await sb.from("client_office_assignments")
      .insert({ tenant_id: TENANT, client_id: cid, office_id: off.id });
    if (e2) die(`client_office_assignments (${s.no}): ${e2.message}`);

    const { error: e3 } = await sb.from("shougai_certifications").insert({
      tenant_id: TENANT, client_id: cid, support_level: s.kubun,
      certification_start_date: `${MONTH}-01`, certification_end_date: "2027-11-30",
      beneficiary_number: `9${s.no.slice(2)}0000`,
      insurer_municipality: "121004", copay_rate: 0.1,
      self_payment_limit: s.limit, seiho_flag: s.seiho,
      jogen_kanri_kubun: s.jogen.kubun,
      jogen_kanri_office_number: s.jogen.num, jogen_kanri_office_name: s.jogen.nm,
      notes: `サンプル: ${s.note} ${MARK}`,
    });
    if (e3) die(`shougai_certifications (${s.no}): ${e3.message}`);

    for (const con of s.contracts ?? []) {
      const { error: eC } = await sb.from("shogai_contracts").insert({
        tenant_id: TENANT, client_id: cid, office_id: off.id,
        decision_code: con.decision_code, amount_x100: con.amount_x100,
        amount_unit: con.amount_unit, entry_number: 1,
        start_date: `${MONTH}-01`, end_date: "2027-11-30",
        // ⚠ reason は CHECK 制約付き。実在値は「新規契約」のみ (659/659 行)
        reason: "新規契約", notes: `サンプル ${MARK}`,
      });
      if (eC) die(`shogai_contracts (${s.no}): ${eC.message}`);
    }

    const rows = s.visits.map((v) => ({
      user_id: cid, visit_date: v.d, start_time: v.s, end_time: v.e,
      service_type: v.n, system: "障害", status: "completed",
      office_id: off.id, tenant_id: TENANT,
      notes: `サンプル ${MARK}${v.addon ? " 加算行" : ""}`,
    }));
    const { error: e4 } = await sb.from("kaigo_visit_schedule").insert(rows);
    if (e4) die(`kaigo_visit_schedule (${s.no}): ${e4.message}`);
    console.log(`  ✓ ${s.no} ${s.name}: 実績 ${rows.length} 行`);
  }
  await verify();
}

main().catch((e) => die(e.message));
