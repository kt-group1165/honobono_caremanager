// ============================================================================
// 訪問入浴介護 サンプルデータ (SAMPLE_DATA_PROTOCOL 準拠 / 担当マーカー = c)
//
//   node migrations/seed_sample_bath_c.mjs                       # DRY RUN (既定)
//   node migrations/seed_sample_bath_c.mjs --execute             # 投入
//   node migrations/seed_sample_bath_c.mjs --delete              # ★ 撤去の DRY RUN (何も消さない)
//   node migrations/seed_sample_bath_c.mjs --delete --execute    # ★ 撤去を実行
//
// ── 前提 ────────────────────────────────────────────────────────────────
//   対象月     **2026-12 のみ** (2026-06/07 は実データ突合に使う月。1 行も入れない)
//   マーカー   clients.user_number = "ZC0nn" / name 末尾 "[sample-c]"
//              notes 末尾 "[sample-c-20260903]"
//   事業所     **実在のものを使う** (ムツミ訪問入浴)。offices は 1 バイトも変更しない
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   kaigo_bath_visit_records は本番 **0 行**で、訪問入浴の算定を一度も検証できていない。
//   サンプルを入れて初めて「単位数が正しいか」「様式が正しいか」を確かめられる。
//
// ── 入れるバリエーション (境界値を必ず含む) ───────────────────────────────
//   ZC001 全身浴・看護職員あり (121111 1266)  ×4 回 + 初回加算 (124113 200/月)
//         要介護3 / 1割 / 公費なし              → 限度額の内側
//   ZC002 部分浴 (121112 1139) と 職員のみ (121121 1203) と
//         職員のみ・部分浴 (121122 1083) を混在  ×各1 回
//         要介護1 / 2割 / **限度額ちょうど**を狙う
//   ZC003 全身浴 ×**多数** で **限度額超過** を作る
//         要介護1 (16,765) / 3割
//   ZC004 認知症専門ケア加算Ⅱ (126134 4単位/回) つき / 生活保護 (法別12) 公費単独
//   ZC005 **月末 (12/31) 1 回のみ** / 要支援2 → ⚠ 訪問入浴介護は要支援も対象
//         (介護予防訪問入浴介護)。境界: 月末 + 軽度
//
//   ⚠ 処遇改善は **offices を変更しない**という規約があるため、
//     集計呼出時に opts で渡して効くことを確認する (このデータには含めない)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const MONTH = "2026-12";
const TENANT = "kt-group";
const MARK = "[sample-c-20260903]";
const NAME_SUFFIX = "[sample-c]";
const NUM_PREFIX = "ZC";
// ⚠ CHECK 制約を投入前に実値で確認した (CLAUDE.md 4.1):
//    clients.gender = "男" / "女"  (**「男性」ではない** — members とは違う。1 回失敗した)
//    clients.status = "active" / "deceased"
/** 実在の訪問入浴事業所 (ムツミ訪問入浴)。**この行は一切変更しない** */
const OFFICE_ID = "ec87a203-53e2-40a5-b706-7fea402cde16";

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** 投入する利用者 (マーカーは user_number と name で二重に付ける) */
const PEOPLE = [
  { no: "ZC001", name: "見本 太郎", kana: "ミホン タロウ", birth: "1940-01-15", gender: "男",
    level: "要介護3", limit: 27048, copay: 0.1, insurer: "122192", insured: "ZC00000001", kohi: null },
  { no: "ZC002", name: "見本 花子", kana: "ミホン ハナコ", birth: "1938-03-03", gender: "女",
    level: "要介護1", limit: 16765, copay: 0.2, insurer: "122192", insured: "ZC00000002", kohi: null },
  { no: "ZC003", name: "見本 次郎", kana: "ミホン ジロウ", birth: "1935-07-20", gender: "男",
    level: "要介護1", limit: 16765, copay: 0.3, insurer: "122192", insured: "ZC00000003", kohi: null },
  { no: "ZC004", name: "見本 三郎", kana: "ミホン サブロウ", birth: "1942-11-11", gender: "男",
    level: "要介護5", limit: 36217, copay: 0.1, insurer: "122192", insured: "ZC00000004", kohi: "12" },
  { no: "ZC005", name: "見本 四郎", kana: "ミホン シロウ", birth: "1945-05-05", gender: "男",
    level: "要支援2", limit: 10531, copay: 0.1, insurer: "122192", insured: "ZC00000005", kohi: null },
];

const d = (day) => `${MONTH}-${String(day).padStart(2, "0")}`;
/** 訪問記録: [利用者, 日, 入浴種別, 職員のみ, 初回加算, 認知症加算] */
const VISITS = [
  // ZC001 全身浴 ×4 + 初回加算 (月 1 回のみ 200 単位)
  ["ZC001", 3, "全身浴", false, true, null],
  ["ZC001", 10, "全身浴", false, false, null],
  ["ZC001", 17, "全身浴", false, false, null],
  ["ZC001", 24, "全身浴", false, false, null],
  // ZC002 4 種のコードを 1 回ずつ (境界: 全パターンを踏む)
  ["ZC002", 2, "全身浴", false, false, null],   // 121111 1266
  ["ZC002", 9, "部分浴", false, false, null],   // 121112 1139
  ["ZC002", 16, "全身浴", true, false, null],   // 121121 1203
  ["ZC002", 23, "部分浴", true, false, null],   // 121122 1083
  // ZC003 全身浴 ×14 → 1266×14 = 17,724 > 16,765 (要介護1) = **限度額超過**
  ...Array.from({ length: 14 }, (_, i) => ["ZC003", i + 1, "全身浴", false, false, null]),
  // ZC004 認知症専門ケアⅡ (4 単位/回) ×3 + 生活保護 (公費単独)
  ["ZC004", 5, "全身浴", false, false, "II"],
  ["ZC004", 12, "全身浴", false, false, "II"],
  ["ZC004", 19, "全身浴", false, false, "II"],
  // ZC005 月末 1 回だけ (境界: 12/31)
  ["ZC005", 31, "全身浴", false, false, null],
];

/** 入浴種別 × 職員のみ → 算定コード (bath-records-content.tsx の resolveBathCode と同じ) */
const bathCode = (type, staffOnly) =>
  type === "全身浴" ? (staffOnly ? "121121" : "121111") : staffOnly ? "121122" : "121112";

async function findExisting() {
  const { data, error } = await sb
    .from("clients")
    .select("id, user_number, name")
    .like("user_number", `${NUM_PREFIX}%`);
  if (error) throw new Error(`clients 取得失敗: ${error.message}`);
  return data ?? [];
}

async function doDelete() {
  console.log(`=== 撤去 (マーカー ${NUM_PREFIX}* / ${MARK}) ===`);
  const existing = await findExisting();
  console.log(`  対象 clients: ${existing.length} 名  ${existing.map((c) => c.user_number).join(",")}`);
  if (existing.length === 0) { console.log("  対象なし"); return; }
  const ids = existing.map((c) => c.id);
  // ⚠ 2026-09-04 是正: 旧実装は `--delete` 単体で即実行されていた (新規約と不一致で
  //   dry-run のつもりで打つと消える事故の元)。--execute が無ければ何も消さない。
  if (!EXECUTE) { console.log(`  【DRY RUN】--delete --execute で実際に削除します`); return; }
  // 子 → 親 の順に消す
  for (const [table, col] of [
    ["kaigo_bath_visit_records", "client_id"],
    ["client_kohi_records", "client_id"],
    ["client_insurance_records", "client_id"],
    ["client_office_assignments", "client_id"],
  ]) {
    const { error, count } = await sb.from(table).delete({ count: "exact" }).in(col, ids);
    if (error) { console.error(`  ✗ ${table}: ${error.message}`); process.exitCode = 1; return; }
    console.log(`  ${table.padEnd(28)} ${count ?? 0} 行 削除`);
  }
  const { error: ce, count: cc } = await sb.from("clients").delete({ count: "exact" }).in("id", ids);
  if (ce) { console.error(`  ✗ clients: ${ce.message}`); process.exitCode = 1; return; }
  console.log(`  clients                      ${cc ?? 0} 行 削除`);
  const left = await findExisting();
  console.log(`  ★ 残り ${left.length} 件 ${left.length === 0 ? "✅ 0 件を確認" : "❌ 残っている"}`);
}

async function doSeed() {
  console.log(`=== 訪問入浴 サンプル投入 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===`);
  console.log(`    対象月 ${MONTH} / マーカー ${NUM_PREFIX}* ・ ${NAME_SUFFIX} ・ ${MARK}\n`);

  // 事業所が実在すること (変更はしない)
  const { data: off, error: oe } = await sb
    .from("offices").select("id, name, unit_price, business_number, service_type")
    .eq("id", OFFICE_ID).maybeSingle();
  if (oe) throw new Error(`offices 取得失敗: ${oe.message}`);
  if (!off) throw new Error(`事業所 ${OFFICE_ID} が実在しない`);
  if (off.service_type !== "訪問入浴") throw new Error(`事業所の種別が訪問入浴でない: ${off.service_type}`);
  console.log(`  事業所: ${off.name} (単価 ${off.unit_price} / 事業所番号 ${off.business_number}) — **変更しない**`);

  const existing = await findExisting();
  if (existing.length > 0) {
    console.log(`\n  ⚠ 既に ${existing.length} 件のサンプルがあります。先に --delete してください`);
    return;
  }

  console.log(`\n  投入予定: clients ${PEOPLE.length} 名 / 訪問記録 ${VISITS.length} 件`);
  for (const p of PEOPLE) {
    const v = VISITS.filter((x) => x[0] === p.no);
    const units = v.reduce((s, x) => s + (x[2] === "全身浴" ? (x[3] ? 1203 : 1266) : x[3] ? 1083 : 1139), 0);
    const shokai = v.some((x) => x[4]) ? 200 : 0;
    const ninchi = v.filter((x) => x[5] === "II").length * 4;
    const gross = units + shokai + ninchi;
    console.log(`     ${p.no} ${p.name.padEnd(8)} ${p.level} ${p.copay * 10}割 限度${p.limit.toLocaleString()}  訪問${v.length}回`);
    console.log(`          所定 ${units.toLocaleString()} + 初回 ${shokai} + 認知症 ${ninchi} = ${gross.toLocaleString()} 単位  ${gross > p.limit ? `★ 限度額超過 (+${(gross - p.limit).toLocaleString()})` : "限度内"}`);
  }

  if (!EXECUTE) { console.log(`\n【DRY RUN】書き込んでいません。--execute で投入 / --delete で撤去`); return; }

  // 1) clients
  const clientRows = PEOPLE.map((p) => ({
    tenant_id: TENANT, user_number: p.no, name: `${p.name}${NAME_SUFFIX}`, furigana: p.kana,
    birth_date: p.birth, gender: p.gender, care_level: p.level,
    insurer_number: p.insurer, insured_number: p.insured, copay_rate: p.copay,
    address: `千葉県サンプル市 ${MARK}`, office_id: OFFICE_ID, status: "active",
  }));
  const { data: ins, error: ie } = await sb.from("clients").insert(clientRows).select("id, user_number");
  if (ie) { console.error(`✗ clients: ${ie.message}`); process.exit(1); }
  const idBy = new Map(ins.map((r) => [r.user_number, r.id]));
  console.log(`  clients                      ${ins.length} 行`);

  // 2) 事業所割当 (無いと画面に出ない)
  const { error: ae } = await sb.from("client_office_assignments").insert(
    PEOPLE.map((p) => ({ tenant_id: TENANT, client_id: idBy.get(p.no), office_id: OFFICE_ID,
      start_date: `${MONTH}-01`, service_notes: MARK })),
  );
  if (ae) { console.error(`✗ client_office_assignments: ${ae.message}`); process.exit(1); }
  console.log(`  client_office_assignments    ${PEOPLE.length} 行`);

  // 3) 認定
  const { error: ce } = await sb.from("client_insurance_records").insert(
    PEOPLE.map((p) => ({
      tenant_id: TENANT, client_id: idBy.get(p.no), effective_date: `${MONTH}-01`,
      insurer_number: p.insurer, insured_number: p.insured, care_level: p.level,
      certification_start_date: "2026-04-01", certification_end_date: "2027-03-31",
      copay_rate: p.copay, service_limit_amount: p.limit, notes: MARK,
    })),
  );
  if (ce) { console.error(`✗ client_insurance_records: ${ce.message}`); process.exit(1); }
  console.log(`  client_insurance_records     ${PEOPLE.length} 行`);

  // 4) 公費 (生活保護 法別12)
  const kohiPeople = PEOPLE.filter((p) => p.kohi);
  if (kohiPeople.length) {
    const { error: ke } = await sb.from("client_kohi_records").insert(
      kohiPeople.map((p) => ({
        tenant_id: TENANT, client_id: idBy.get(p.no), kohi_hobetsu: p.kohi,
        futansha_number: "12121067", jukyusha_number: "9999999",
        start_date: `${MONTH}-01`, end_date: null, priority: 1, notes: MARK,
      })),
    );
    if (ke) { console.error(`✗ client_kohi_records: ${ke.message}`); process.exit(1); }
    console.log(`  client_kohi_records          ${kohiPeople.length} 行`);
  }

  // 5) 訪問入浴の記録
  const recRows = VISITS.map(([no, day, type, staffOnly, shokai, ninchi]) => ({
    tenant_id: TENANT, client_id: idBy.get(no), office_id: OFFICE_ID,
    visit_date: d(day), bath_type: type, staff_only: staffOnly, scheme: "介護保険",
    service_code: bathCode(type, staffOnly),
    addon_shokai: !!shokai, addon_ninchi: ninchi, addon_chuusankan: false,
    status: "confirmed", actual: true, planned: false,
    start_time: "10:00", end_time: "11:00", staff_ids: [],
    notes: MARK,
  }));
  const { error: re } = await sb.from("kaigo_bath_visit_records").insert(recRows);
  if (re) { console.error(`✗ kaigo_bath_visit_records: ${re.message}`); process.exit(1); }
  console.log(`  kaigo_bath_visit_records     ${recRows.length} 行`);

  // 6) 件数確認 (実際に入ったか)
  const { count, error: qe } = await sb.from("kaigo_bath_visit_records")
    .select("*", { count: "exact", head: true })
    .gte("visit_date", `${MONTH}-01`).lte("visit_date", `${MONTH}-31`);
  if (qe) { console.error(`✗ 件数確認: ${qe.message}`); process.exit(1); }
  console.log(`\n  ★ 件数確認: ${MONTH} の訪問入浴記録 ${count} 件`);
}

(DELETE ? doDelete() : doSeed()).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
