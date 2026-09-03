/**
 * 障害福祉 利用者負担上限額管理 の検算用テストデータ (隔離)
 *
 *   node migrations/seed_fake_jogen_kanri_test.mjs             # DRY RUN
 *   node migrations/seed_fake_jogen_kanri_test.mjs --execute   # 投入
 *
 * すべて tenant_id='test' + marker `[fake テスト用-jogen-20260903]` を付ける。
 * 本番データ (tenant_id='kt-group') には一切触れない。
 * 投入した id は _fake_jogen_test_manifest.json に書き出し、削除 script がそれで消す。
 *
 * 単価は 10.00 円/単位 固定 (offices.unit_price=10 / area_category='その他') にして
 * 総費用額 = 総単位数 × 10 で手計算できるようにしている。
 * 処遇改善加算は kaigo_office_addon_periods を作らない = 加算なし。
 * 初回加算は contract_start_date を対象月と別月にして発生させない。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");

const MARKER = "[fake テスト用-jogen-20260903]";
const TENANT = "test";
const MONTH = "2026-09"; // 対象月
const UNIT_PRICE = 10.0;

// ─── env ──────────────────────────────────────────────────────────────────────
const rawEnv = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const env = {};
for (const line of rawEnv.split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) throw new Error(".env.local に SUPABASE の URL / SERVICE_ROLE_KEY がありません");

async function rest(path, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
async function insert(table, rows) {
  if (rows.length === 0) return [];
  if (!EXECUTE) return rows;
  const out = [];
  for (let i = 0; i < rows.length; i += 500) {
    out.push(...(await rest(table, { method: "POST", body: JSON.stringify(rows.slice(i, i + 500)) })));
  }
  return out;
}

// ─── サービスコード (2026-09 有効世代) ──────────────────────────────────────────
// 111111 身体日０．５ = 256 単位 / 111211 身体早２．５ = 943 単位
const CODE_A = { code: "111111", name: "身体日０．５", units: 256, category: "11" };
const CODE_B = { code: "111211", name: "身体早２．５", units: 943, category: "11" };

// ─── 事業所 (2 つ: 兼務利用者の office scope 検証用) ─────────────────────────────
const OFFICE1 = {
  id: randomUUID(),
  tenant_id: TENANT,
  name: `ZZテスト上限管理ヘルパーステーション甲 ${MARKER}`,
  service_type: "訪問介護",
  designation_type: "介護保険",
  app_type: "kaigo-app",
  business_number: "9999900001",
  shogai_business_number: "9999800001",
  area_category: "その他",
  unit_price: UNIT_PRICE,
  is_active: false,
  sort_order: 99001,
  notes: MARKER,
};
const OFFICE2 = {
  id: randomUUID(),
  tenant_id: TENANT,
  name: `ZZテスト上限管理ヘルパーステーション乙 ${MARKER}`,
  service_type: "訪問介護",
  designation_type: "介護保険",
  app_type: "kaigo-app",
  business_number: "9999900002",
  shogai_business_number: "9999800002",
  area_category: "その他",
  unit_price: UNIT_PRICE,
  is_active: false,
  sort_order: 99002,
  notes: MARKER,
};

/**
 * 検証パターン。
 *   pattern  ① 自事業所管理・単独 / ② 自事業所管理・複数(按分) /
 *            ③ 他事業所管理・結果入力済 / ④ 他事業所管理・結果未入力
 */
const CLIENTS = [
  {
    tag: "A",
    name: "ZZテスト 上限太郎",
    kana: "ゼツトテスト ジヨウゲンタロウ",
    beneficiary: "9990000001",
    limit: 4600,
    income: "一般1",
    seiho: false,
    kubun: "自事業所",
    pattern: "① 自事業所管理・単独利用",
    records: [{ office: 1, code: CODE_A, count: 20 }],
    kanri: [
      {
        office: 1,
        result: 2,
        amount: 4600,
        lines: [
          { office_number: "9999800001", office_name: "(自事業所)", total_amount: 51200, user_amount: 4600, adjusted_amount: 4600, is_self: true },
        ],
      },
    ],
  },
  {
    tag: "B",
    name: "ZZテスト 按分次郎",
    kana: "ゼツトテスト アンブンジロウ",
    beneficiary: "9990000002",
    limit: 9300,
    income: "一般1",
    seiho: false,
    kubun: "自事業所",
    pattern: "② 自事業所管理・3事業所 (按分あり)",
    records: [{ office: 1, code: CODE_A, count: 5 }],
    kanri: [
      {
        office: 1,
        result: 3,
        amount: 1280,
        lines: [
          { office_number: "9999800001", office_name: "(自事業所)", total_amount: 12800, user_amount: 1280, adjusted_amount: 1280, is_self: true },
          { office_number: "1211111111", office_name: "ZZテスト外部事業所X", total_amount: 80000, user_amount: 8000, adjusted_amount: 8000, is_self: false },
          { office_number: "1212222222", office_name: "ZZテスト外部事業所Y", total_amount: 30000, user_amount: 3000, adjusted_amount: 20, is_self: false },
        ],
      },
    ],
  },
  {
    tag: "C",
    name: "ZZテスト 他管三郎",
    kana: "ゼツトテスト タカンサブロウ",
    beneficiary: "9990000003",
    limit: 37200,
    income: "一般2",
    seiho: false,
    kubun: "他事業所",
    kanriOfficeNumber: "1213333333",
    kanriOfficeName: "ZZテスト他社上限管理事業所",
    pattern: "③ 他事業所管理・管理結果 入力済 (区分3)",
    records: [{ office: 1, code: CODE_B, count: 60 }],
    kanri: [{ office: 1, result: 3, amount: 12000, lines: [] }],
  },
  {
    tag: "D",
    name: "ZZテスト 未入四郎",
    kana: "ゼツトテスト ミニユウシロウ",
    beneficiary: "9990000004",
    limit: 9300,
    income: "一般1",
    seiho: false,
    kubun: "他事業所",
    kanriOfficeNumber: "1213333333",
    kanriOfficeName: "ZZテスト他社上限管理事業所",
    pattern: "④ 他事業所管理・管理結果 未入力 (過大請求ケース)",
    records: [{ office: 1, code: CODE_A, count: 50 }],
    kanri: [],
  },
  {
    tag: "E",
    name: "ZZテスト 生保五郎",
    kana: "ゼツトテスト セイホゴロウ",
    beneficiary: "9990000005",
    limit: 0,
    income: "生活保護",
    seiho: true,
    kubun: "他事業所",
    kanriOfficeNumber: "1213333333",
    kanriOfficeName: "ZZテスト他社上限管理事業所",
    pattern: "④ 他事業所管理・未入力 だが 上限0円 (対照群 = 過大請求なし)",
    records: [{ office: 1, code: CODE_A, count: 25 }],
    kanri: [],
  },
  {
    tag: "F",
    name: "ZZテスト 充当六子",
    kana: "ゼツトテスト ジユウトウロクコ",
    beneficiary: "9990000006",
    limit: 4600,
    income: "低所得2",
    seiho: false,
    kubun: "他事業所",
    kanriOfficeNumber: "1213333333",
    kanriOfficeName: "ZZテスト他社上限管理事業所",
    pattern: "③ 他事業所管理・入力済 (区分1 = 管理事業所で充当済 → 当事業所0円)",
    records: [{ office: 1, code: CODE_A, count: 30 }],
    kanri: [{ office: 1, result: 1, amount: 0, lines: [] }],
  },
  {
    tag: "G",
    name: "ZZテスト 兼務七海",
    kana: "ゼツトテスト ケンムナナミ",
    beneficiary: "9990000007",
    limit: 37200,
    income: "一般2",
    seiho: false,
    kubun: "他事業所",
    kanriOfficeNumber: "1213333333",
    kanriOfficeName: "ZZテスト他社上限管理事業所",
    pattern: "③ 他事業所管理・入力済 × 当社2事業所 (office scope 検証)",
    records: [
      { office: 1, code: CODE_B, count: 60 },
      { office: 2, code: CODE_B, count: 10 },
    ],
    kanri: [
      { office: 1, result: 3, amount: 20000, lines: [] },
      { office: 2, result: 3, amount: 8000, lines: [] },
    ],
  },
];

// ─── 行の組み立て ─────────────────────────────────────────────────────────────
const offices = [OFFICE1, OFFICE2];
const officeById = { 1: OFFICE1, 2: OFFICE2 };

const clientRows = [];
const certRows = [];
const assignRows = [];
const recordRows = [];
const kanriRows = [];
const kohiRows = [];

let seq = 0;
for (const c of CLIENTS) {
  const clientId = randomUUID();
  c._id = clientId;
  clientRows.push({
    id: clientId,
    tenant_id: TENANT,
    user_number: `ZZJOGEN${String(++seq).padStart(3, "0")}`,
    name: `${c.name} ${MARKER}`,
    furigana: c.kana,
    birth_date: "1960-01-01",
    gender: "男",
    status: "active",
    address: "千葉県テスト市テスト町1-1-1",
  });

  certRows.push({
    id: randomUUID(),
    tenant_id: TENANT,
    client_id: clientId,
    support_level: "区分3",
    primary_disability: "身体障害",
    certification_start_date: "2026-04-01",
    certification_end_date: "2027-03-31",
    beneficiary_number: c.beneficiary,
    insurer_municipality: "121012",
    service_types: ["居宅介護"],
    self_payment_limit: c.limit,
    seiho_flag: c.seiho,
    income_category: c.income,
    jogen_kanri_kubun: c.kubun,
    jogen_kanri_office_number: c.kanriOfficeNumber ?? (c.kubun === "自事業所" ? "9999800001" : null),
    jogen_kanri_office_name: c.kanriOfficeName ?? (c.kubun === "自事業所" ? OFFICE1.name : null),
    // 初回加算を発生させないため対象月と別月にする
    contract_start_date: "2026-04-01",
    contract_amount_text: "身体介護 30時間/月",
    shikyuryo_details: {},
    monthly_allocations: {},
    flag_special_area: false,
    notes: MARKER,
  });

  // 公費 (障害では請求計算に使われないが、実運用に近い厚みとして投入する)
  kohiRows.push({
    id: randomUUID(),
    tenant_id: TENANT,
    client_id: clientId,
    kohi_hobetsu: "21",
    futansha_number: "21120018",
    jukyusha_number: c.beneficiary,
    start_date: "2026-04-01",
    end_date: "2027-03-31",
    priority: 1,
    honnin_futan: 0,
    notes: MARKER,
  });

  const usedOffices = new Set(c.records.map((r) => r.office));
  for (const o of usedOffices) {
    assignRows.push({
      id: randomUUID(),
      tenant_id: TENANT,
      client_id: clientId,
      office_id: officeById[o].id,
      start_date: "2026-04-01",
      service_notes: MARKER,
    });
  }

  for (const r of c.records) {
    for (let i = 0; i < r.count; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      recordRows.push({
        id: randomUUID(),
        tenant_id: TENANT,
        office_id: officeById[r.office].id,
        client_id: clientId,
        service_date: `${MONTH}-${day}`,
        start_time: "09:00:00",
        end_time: r.code.code === "111111" ? "09:30:00" : "07:00:00",
        duration_minutes: r.code.code === "111111" ? 30 : 150,
        service_type: "居宅介護",
        service_category: r.code.category,
        service_code: r.code.code,
        unit_count: r.code.units,
        addons: [],
        status: "confirmed",
        notes: `${r.code.name} ${MARKER}`,
      });
    }
  }

  for (const k of c.kanri) {
    kanriRows.push({
      id: randomUUID(),
      tenant_id: TENANT,
      client_id: clientId,
      office_id: officeById[k.office].id,
      target_month: MONTH,
      kanri_result: k.result,
      kanri_result_amount: k.amount,
      office_lines: k.lines,
      notes: MARKER,
    });
  }
}

// ─── 出力 ─────────────────────────────────────────────────────────────────────
console.log(`${EXECUTE ? "★ EXECUTE" : "DRY RUN"}  対象月 ${MONTH} / tenant='${TENANT}' / marker=${MARKER}`);
console.log(`  offices ${offices.length} / clients ${clientRows.length} / certs ${certRows.length}`);
console.log(`  assignments ${assignRows.length} / kohi ${kohiRows.length}`);
console.log(`  shogai_service_records ${recordRows.length} / jogen_kanri_results ${kanriRows.length}`);
console.log("");
for (const c of CLIENTS) {
  const units = c.records.reduce((s, r) => s + r.code.units * r.count, 0);
  console.log(
    `  ${c.tag} ${c.name}  上限${c.limit.toLocaleString()}円  ${c.pattern}\n` +
      `      単位 ${units.toLocaleString()} → 総費用 ${(units * UNIT_PRICE).toLocaleString()}円  ` +
      `管理結果 ${c.kanri.length ? c.kanri.map((k) => `事業所${k.office}:区分${k.result}/${k.amount}円`).join(" ") : "未入力"}`,
  );
}

if (!EXECUTE) {
  console.log("\n(DRY RUN — 何も書いていません。--execute で投入)");
  process.exit(0);
}

await insert("offices", offices);
await insert("clients", clientRows);
await insert("shougai_certifications", certRows);
await insert("client_office_assignments", assignRows);
await insert("client_kohi_records", kohiRows);
await insert("shogai_service_records", recordRows);
await insert("shogai_jogen_kanri_results", kanriRows);

const manifest = {
  marker: MARKER,
  tenant: TENANT,
  month: MONTH,
  unit_price: UNIT_PRICE,
  offices: offices.map((o) => ({ id: o.id, name: o.name, shogai_business_number: o.shogai_business_number })),
  clients: CLIENTS.map((c) => ({
    id: c._id,
    tag: c.tag,
    name: c.name,
    beneficiary: c.beneficiary,
    limit: c.limit,
    kubun: c.kubun,
    pattern: c.pattern,
  })),
  ids: {
    offices: offices.map((o) => o.id),
    clients: clientRows.map((r) => r.id),
    certs: certRows.map((r) => r.id),
    assignments: assignRows.map((r) => r.id),
    kohi: kohiRows.map((r) => r.id),
    records: recordRows.map((r) => r.id),
    kanri: kanriRows.map((r) => r.id),
  },
};
writeFileSync(join(__dirname, "_fake_jogen_test_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

// 件数確認 (実際に INSERT されたかを DB 側で数える)
const cnt = async (table, filter) => {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}&select=id`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "count=exact", Range: "0-0" },
  });
  return r.headers.get("content-range")?.split("/")[1] ?? "?";
};
console.log("\n=== 件数確認 (DB 実測) ===");
console.log("  offices          :", await cnt("offices", `tenant_id=eq.${TENANT}&notes=eq.${encodeURIComponent(MARKER)}`));
console.log("  clients          :", await cnt("clients", `tenant_id=eq.${TENANT}&user_number=like.ZZJOGEN*`));
console.log("  certs            :", await cnt("shougai_certifications", `tenant_id=eq.${TENANT}&notes=eq.${encodeURIComponent(MARKER)}`));
console.log("  assignments      :", await cnt("client_office_assignments", `tenant_id=eq.${TENANT}&service_notes=eq.${encodeURIComponent(MARKER)}`));
console.log("  kohi             :", await cnt("client_kohi_records", `tenant_id=eq.${TENANT}&notes=eq.${encodeURIComponent(MARKER)}`));
console.log("  service_records  :", await cnt("shogai_service_records", `tenant_id=eq.${TENANT}&status=eq.confirmed`));
console.log("  jogen_kanri      :", await cnt("shogai_jogen_kanri_results", `tenant_id=eq.${TENANT}&notes=eq.${encodeURIComponent(MARKER)}`));
console.log("\nmanifest → migrations/_fake_jogen_test_manifest.json");
