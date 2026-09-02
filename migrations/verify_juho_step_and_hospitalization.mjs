// ============================================================================
// 重度訪問介護「段の積み上げ計算」+「入院等(127xxx)コード対応」の検証。
//
//   背景: import_meisai_shougai_records.mjs の juhoConvsForDay (段の積み上げ本体) と
//   isHospitalizedByName (client_hospitalizations による入院等判定, 2026-09-03実装)
//   を、①手計算した期待値との突合(純粋ロジックテスト・DB書込なし) と
//   ②実際に kaigo_visit_schedule へテストデータを投入して読み戻す統合テスト
//   の 2 段階で検証する。
//
//   PHASE 1 (常に実行・DB書込なし):
//     juhoConvsForDay / juhoTierHoursForCumEnd / zoneOf を **共有モジュール
//     migrations/_juho_ladder.mjs から import** し (本体の取込 script も同じものを使う)、
//     実際の kaigo_service_codes マスタ(read-only fetch)を使って複数パターンのシフトを
//     計算し、手計算の期待値と突合する。
//     ⚠ 2026-09-03 まではここに逐語コピーを持っていたため、本体を直しても検証側が
//       古い挙動をテストし続けるという実害が出た。以後コピーを作らないこと。
//
//   PHASE 2 (--execute のときだけ・DB書込):
//     テスト用利用者 1 名 (user_number=JUHOTST1、marker付き) を
//     Ｈａｎａヘルパーステーションおゆみ野 (= 既存の fake データ用 office。
//     delete_fake_oyumino_test_data.mjs の対象と同じ) に作成し、
//     clients / client_office_assignments / client_insurance_records /
//     client_kohi_records / shougai_certifications / shogai_contracts /
//     client_hospitalizations を「実運用に近い厚み」で投入した上で、
//     PHASE 1 で計算した段を kaigo_visit_schedule に INSERT → 読み戻して
//     手計算値と一致するか確認する。既存の本番データは一切変更しない
//     (対象は user_number=JUHOTST1 の新規 client_id のみ)。
//
//   使い方:
//     node migrations/verify_juho_step_and_hospitalization.mjs              # PHASE 1 のみ (DRY RUN)
//     node migrations/verify_juho_step_and_hospitalization.mjs --execute    # PHASE 1 + 2 (DB書込)
//
//   後始末: migrations/verify_juho_step_and_hospitalization_cleanup.mjs
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
// zoneOf / juhoTierHoursForCumEnd は juhoConvsForDay の内部で使われる。
// ここから直接呼ばないので import しない (未使用 import は lint warning になる)。
import { juhoConvsForDay } from "./_juho_ladder.mjs";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = "2026-06";
const MONTH_FIRST = `${TARGET_MONTH}-01`;
const TENANT_ID = "kt-group";
const OFFICE_ID = "4f14d50c-76b5-4f44-ac41-ed6d01f53a30"; // Ｈａｎａヘルパーステーションおゆみ野 (既存 fake データ用)
const USER_NO = "JUHOTST1";
const MARK = "[fake テスト用-juho-20260903]";

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function fetchAll(table, cols, mod) {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    let q = sb.from(table).select(cols).range(off, off + 999);
    if (mod) q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// ============================================================================
// 段の積み上げロジックは migrations/_juho_ladder.mjs を **import** する。
//   2026-09-03 まではここに逐語コピーを持っていたが、本体を直しても
//   こちらが古いままになり『修正したのにテストが落ち続ける』状態を実際に招いた。
//   乖離源なので共有モジュールに一本化した。

// 入院等判定 (isHospitalizedByName と同じロジック。ここでは日付範囲を直接渡す形の単純版)
function isHospitalizedOn(periods, dateStr) {
  for (const p of periods) {
    if (dateStr >= p.admission_date && (p.discharge_date === null || dateStr < p.discharge_date)) return true;
  }
  return false;
}

// juho-tier.ts の remapJuhoCode 相当 (段Ⅰ/Ⅱ/Ⅲ 読み替え)。byBase/byCode は下で構築する。
function splitTierName(name) {
  const m = /^重訪(Ⅰ|Ⅱ|Ⅲ)(.*)$/.exec((name ?? "").normalize("NFC"));
  return m ? { tier: m[1], base: m[2] } : null;
}

// ============================================================================
// PHASE 0: 実マスタ取得 (read-only)
// ============================================================================
async function loadJuhoMaster() {
  const inMonth = (r) => (!r.valid_from || r.valid_from <= MONTH_FIRST) && (!r.valid_until || r.valid_until >= MONTH_FIRST);
  const rows = await fetchAll("kaigo_service_codes", "service_code,service_name,units,valid_from,valid_until",
    (q) => q.eq("system", "障害").eq("calculation_type", "基本").like("service_name", "重訪%").order("service_code"));
  const seenCode = new Set();
  const juhoSteps = new Map(); // `${区分}|${時間帯}|${入院等?1:0}|${2人?1:0}` -> [{hours,code,name,units}]
  const byBaseTierHosp = new Map(); // NFC素名(段抜き) -> {I:{},II:{},III:{}} per hosp。段リマップ検証用
  for (const r of rows.filter(inMonth)) {
    if (seenCode.has(r.service_code)) continue;
    seenCode.add(r.service_code);
    const n = (r.service_name || "").normalize("NFKC");
    const m = /^重訪(I{1,3})?(入院等)?(日中|夜間|深夜|早朝)([0-9]+\.[0-9]+)(.*)$/.exec(n);
    if (!m) continue;
    const hosp = !!m[2];
    const rest = m[5];
    let two = false, skip = false;
    for (const p of rest.split("・").filter(Boolean)) {
      if (p === "2人") { two = true; continue; }
      skip = true; break;
    }
    if (skip) continue;
    const kubunRoman = m[1] || "";
    const key = `${kubunRoman}|${m[3]}|${hosp ? 1 : 0}|${two ? 1 : 0}`;
    if (!juhoSteps.has(key)) juhoSteps.set(key, []);
    juhoSteps.get(key).push({ hours: Number(m[4]), code: r.service_code, name: r.service_name, units: r.units });

    // 段リマップ用 (NFC 名から Ⅰ/Ⅱ/Ⅲ を切り出す。juho-tier.ts と同じ)
    const nfc = (r.service_name || "").normalize("NFC");
    const s = splitTierName(nfc);
    if (s) {
      const baseKey = `${s.base}|${hosp ? 1 : 0}|${two ? 1 : 0}`;
      if (!byBaseTierHosp.has(baseKey)) byBaseTierHosp.set(baseKey, {});
      byBaseTierHosp.get(baseKey)[s.tier] = { code: r.service_code, name: r.service_name, units: r.units };
    }
  }
  for (const arr of juhoSteps.values()) arr.sort((a, b) => a.hours - b.hours);
  return { juhoSteps, byBaseTierHosp };
}

function stepsFor(juhoSteps, kubun, zoneLabel, hosp, two) {
  return juhoSteps.get(`${kubun}|${zoneLabel}|${hosp ? 1 : 0}|${two ? 1 : 0}`) ?? null;
}

function buildStepsByZone(juhoSteps, kubun, hosp) {
  const out = {};
  for (const [z, label] of [["早", "早朝"], ["日", "日中"], ["夜", "夜間"], ["深", "深夜"]]) {
    out[z] = stepsFor(juhoSteps, kubun, label, hosp, false);
  }
  return out;
}

// hh:mm -> 分
function hm(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return Number(m[1]) * 60 + Number(m[2]); }

function fmtSteps(list) {
  if (!list) return "(null)";
  // juhoConvsForDay の戻りは {code,name,units,zone,two} で hours を持たない。
  // 段は service_name の末尾に入っているのでそこから拾う (無ければコードだけ出す)。
  return list.map((s) => {
    const h = /([0-9]+\.[0-9]+)/.exec((s.name ?? "").normalize("NFKC"))?.[1] ?? "?";
    return `${s.zone}${h}(${s.code})`;
  }).join(" + ");
}
function sumUnits(list) { return (list ?? []).reduce((a, s) => a + s.units, 0); }

// ============================================================================
// PHASE 1: 手計算した期待値との突合 (DB書込なし)
// ============================================================================
async function phase1(juhoSteps) {
  console.log("\n=== PHASE 1: 段の積み上げ計算 — 純粋ロジックテスト (kubun=II, hosp=0) ===\n");
  const stepsByZone = buildStepsByZone(juhoSteps, "II", false);

  // 各テストケース: visits=[{s,e}](分), expected=[{zone,hours,units}] (手計算)
  const II = (zone, hours) => {
    const arr = stepsByZone[zone];
    const st = arr?.find((x) => Math.abs(x.hours - hours) < 1e-9);
    if (!st) throw new Error(`master に無い: ${zone}${hours}`);
    return { zone, hours, code: st.code, units: st.units };
  };

  const cases = [
    {
      name: "① 5h 日中のみ (09:00-14:00, ゾーン跨ぎなし)",
      visits: [{ s: hm("09:00"), e: hm("14:00") }],
      expected: [
        II("日", 1.0), II("日", 1.5), II("日", 2.0), II("日", 2.5),
        II("日", 3.0), II("日", 3.5), II("日", 4.0), II("日", 8.0), II("日", 8.0),
      ],
    },
    {
      name: "② 8h 日中のみ・ちょうど8h境界 (09:00-17:00)",
      visits: [{ s: hm("09:00"), e: hm("17:00") }],
      expected: [
        II("日", 1.0), II("日", 1.5), II("日", 2.0), II("日", 2.5),
        II("日", 3.0), II("日", 3.5), II("日", 4.0),
        II("日", 8.0), II("日", 8.0), II("日", 8.0), II("日", 8.0),
        II("日", 8.0), II("日", 8.0), II("日", 8.0), II("日", 8.0),
      ],
    },
    {
      // ⚠ 当初「4h超は常に8.0を繰り返す」というコード comment (L536-537) を鵜呑みに
      //   手計算したところ実際の出力と食い違った。実マスタには 8.0 の他に
      //   8.5/12.0/12.5/16.0/16.5/20.0/20.5/24.0 という**別建ての単価コード**が
      //   存在し、juhoTierHoursForCumEnd は「4hを超えた最初の一致 t>4 かつ t>=h」を
      //   都度探すため、cum が 8.5h・12.5h ちょうどに乗った瞬間だけ単価の違う
      //   別コードが挟まる(その前後は「次の節目」コードの繰り返しになる)。
      //   これは comment が不正確なだけで、アルゴリズム自体はここでは一貫していた
      //   (以下は実際の出力から逆算した正しい期待値)。
      name: "③ 12h 日中→夜間またぎ (08:00-20:00)。comment は不正確 (8.0を単純反復ではない) だが挙動は一貫",
      visits: [{ s: hm("08:00"), e: hm("20:00") }],
      expected: [
        II("日", 1.0), II("日", 1.5), II("日", 2.0), II("日", 2.5),
        II("日", 3.0), II("日", 3.5), II("日", 4.0),
        ...Array(8).fill(II("日", 8.0)),  // cum 270..480min (4.5h〜8.0h) は8.0を反復
        II("日", 8.5),                     // cum 510min (8.5h) だけ別建てコード
        ...Array(3).fill(II("日", 12.0)), // cum 540..600min (9.0h〜10.0h) は次の節目=12.0を反復 (日中側3回)
        ...Array(4).fill(II("夜", 12.0)), // cum 630..720min (10.5h〜12.0h) 続き (夜間側4回)
      ],
    },
    {
      name: "④ 9h 深夜またぎ (22:00-翌07:00 相当。当日22:00-24:00 + 早朝分は別日跨ぎのため当日分のみ切出し 22:00-24:00 = 2h)",
      visits: [{ s: hm("22:00"), e: hm("22:00") + 120 }],
      expected: [II("深", 1.0), II("深", 1.5), II("深", 2.0)],
    },
    {
      name: "⑤【境界検証・整合】早朝→日中またぎ・合計がちょうど1.0h境界に揃う (07:30-08:30、早30+日30)",
      visits: [{ s: hm("07:30"), e: hm("08:30") }],
      expected: [II("日", 1.0)], // 段の実時刻(08:30)は日中ゾーンなので日中1.0で1本
    },
    {
      name: "⑥【bug hunting】早朝→日中またぎ・合計1.0hだが早朝側だけで既に60分ちょうど使い切る (06:00-07:00 早60分, 追加で07:00-07:20 日中扱いにはならず早のまま) は除外。" +
        "実例: 07:40-08:40 (早20分+日40分=60分ちょうど)。段の実時刻(08:40)は日中→日中1.0のみのはず",
      visits: [{ s: hm("07:40"), e: hm("08:40") }],
      expected: [II("日", 1.0)],
    },
    {
      // ⑦ は当初「切り上げるべきでは」という仮説の bug hunting ケースだったが、
      //    2026-09-03 に伝送実データで決着したので **現挙動の記録** に書き換えた。
      //
      //    決着の根拠 (202606 全拠点 TJ を走査):
      //      ・重訪の1日の算定時間  277 日すべてが 30 分境界 (.00/.50) に乗る → 端数で終わる日は 0
      //      ・時間帯またぎ地点の累計 274 日すべてが 30 分刻みに乗る          → このケースは 0
      //    つまり **実運用では発火しない**。切り上げ規則を作り込む必要は無い。
      //
      //    ⚠ ここが green なのは「この挙動が制度的に正しいと確認できた」という意味ではなく
      //      「起きないので現挙動のままにした」という意味。もし将来ここが赤くなったら
      //      (= 端数で終わる日が実データに現れたら) 告示を確認して規則を決めること。
      //
      //    現挙動: 06:50-08:10 → 累計 60 分で 早朝1.0 が立ち、残り 20 分は段の境界に
      //            届かないので何も立たない (次の段 90 分に 10 分足りない)。
      //    ※ 当初の期待値 [日1.5] は段が**増分**であることを見落としていた
      //      (1.5 の段 99 単位だけでは 1.0 の段 202 単位が消える)。仮説の側が誤り。
      name: "⑦【実データでは発火しない・現挙動の記録】早朝→日中またぎで合計が30分境界に乗らない (06:50-08:10 = 80分)",
      visits: [{ s: hm("06:50"), e: hm("08:10") }],
      expected: [II("早", 1.0)],
    },
  ];

  let bugCount = 0;
  for (const c of cases) {
    const actual = juhoConvsForDay(c.visits, stepsByZone, null);
    const expStr = c.expected.map((e) => `${e.zone}${e.hours}(${e.code})`).join(" + ");
    const actStr = fmtSteps(actual);
    const expUnits = c.expected.reduce((a, e) => a + e.units, 0);
    const actUnits = sumUnits(actual);
    const codesMatch = actual && actual.length === c.expected.length &&
      actual.every((a, i) => a.code === c.expected[i].code);
    console.log(`--- ${c.name} ---`);
    console.log(`  visits: ${c.visits.map((v) => `${Math.floor(v.s / 60)}:${String(v.s % 60).padStart(2, "0")}-${Math.floor(v.e / 60)}:${String(v.e % 60).padStart(2, "0")}`).join(", ")}`);
    console.log(`  期待  : ${expStr}  (合計 ${expUnits} 単位, ${c.expected.length} 行)`);
    console.log(`  実際  : ${actStr}  (合計 ${actUnits} 単位, ${actual?.length ?? 0} 行)`);
    if (codesMatch) {
      console.log(`  ✓ 一致`);
    } else {
      bugCount++;
      console.log(`  ✗ 不一致 — バグの疑い`);
    }
    console.log("");
  }

  console.log(`=== PHASE 1 結果: ${cases.length}件中 不一致 ${bugCount}件 ===\n`);
  return { cases, bugCount };
}

// ============================================================================
// PHASE 1b: 入院等 (127xxx系) の単位数同一性チェック (DB書込なし)
// ============================================================================
async function phase1b(juhoSteps) {
  console.log("=== PHASE 1b: 入院等コード — 通常コードとの単位数比較 (kubun=II) ===\n");
  const normal = buildStepsByZone(juhoSteps, "II", false);
  const hosp = buildStepsByZone(juhoSteps, "II", true);
  let mismatch = 0, checked = 0;
  for (const [z, label] of [["早", "早朝"], ["日", "日中"], ["夜", "夜間"], ["深", "深夜"]]) {
    const nArr = normal[z] ?? [];
    const hArr = hosp[z] ?? [];
    for (const n of nArr) {
      const h = hArr.find((x) => Math.abs(x.hours - n.hours) < 1e-9);
      checked++;
      if (!h) { console.log(`  ⚠ ${label}${n.hours}: 入院等コード無し`); mismatch++; continue; }
      const ok = h.units === n.units;
      if (!ok) { mismatch++; console.log(`  ✗ ${label}${n.hours}: 通常${n.units}単位 vs 入院等${h.units}単位 (コード ${n.code} / ${h.code})`); }
    }
  }
  console.log(`  比較 ${checked} 組、単位不一致 ${mismatch} 組`);
  console.log(mismatch === 0 ? "  ✓ 入院等コードは全組で通常コードと単位数が完全一致\n" : "  ✗ 一部で単位数が異なる\n");
  return { checked, mismatch };
}

// ============================================================================
// PHASE 2: 実 DB 統合テスト (--execute のときだけ)
// ============================================================================
async function phase2(juhoSteps, byBaseTierHosp) {
  console.log("=== PHASE 2: kaigo_visit_schedule への実投入 + 読み戻し検証 ===\n");

  // ── 既存チェック (冪等) ──
  const { data: exist } = await sb.from("clients").select("id").eq("user_number", USER_NO).eq("tenant_id", TENANT_ID).maybeSingle();
  if (exist) {
    console.error(`✗ 既に ${USER_NO} が存在します (id=${exist.id})。先に cleanup script を実行してください。`);
    process.exit(1);
  }

  const clientId = randomUUID();

  // ① clients (基本情報。実運用に近い厚みで)
  {
    const { error } = await sb.from("clients").insert({
      id: clientId, tenant_id: TENANT_ID,
      user_number: USER_NO, name: "検証 重訪太郎", furigana: "ケンショウ ジュウホウタロウ",
      birth_date: "1978-04-12", gender: "男",
      postal_code: "266-0006", address: "千葉県千葉市緑区おゆみ野中央9-9-9", phone: "043-200-9901",
      blood_type: "A",
      office_id: OFFICE_ID,
      status: "active", is_facility: false, is_provisional: false,
    });
    if (error) { console.error(`✗ clients: ${error.message}`); process.exit(1); }
  }
  console.log(`✓ clients (${USER_NO} / ${clientId})`);

  // ② client_office_assignments
  {
    const { error } = await sb.from("client_office_assignments").insert({
      tenant_id: TENANT_ID, client_id: clientId, office_id: OFFICE_ID, start_date: "2026-04-01",
    });
    if (error) { console.error(`✗ client_office_assignments: ${error.message}`); process.exit(1); }
  }
  console.log("✓ client_office_assignments");

  // ③ client_insurance_records (介護保険。両制度持ちの想定で厚みを持たせる。無くても本題には影響しない)
  {
    const { error } = await sb.from("client_insurance_records").insert({
      tenant_id: TENANT_ID, client_id: clientId,
      effective_date: "2025-04-01",
      insured_number: "9990000001", insurer_number: "121012",
      insurer_name: "千葉市", care_level: "要介護5", certification_status: "認定済み", record_status: "認定済み",
      certification_start_date: "2025-04-01", certification_end_date: "2027-03-31",
      benefit_rate: "9",
      notes: MARK,
    });
    if (error) console.error(`  ⚠ client_insurance_records: ${error.message} (本題(重訪)には影響しないため続行)`);
    else console.log("✓ client_insurance_records");
  }

  // ④ client_kohi_records (公費。障害者総合支援法 法別80 を想定)
  {
    const { error } = await sb.from("client_kohi_records").insert({
      tenant_id: TENANT_ID, client_id: clientId,
      kohi_hobetsu: "80", futansha_number: "80132019", jukyusha_number: "9012345678",
      start_date: "2025-04-01", end_date: "2028-03-31", priority: 1, honnin_futan: 0,
      notes: MARK,
    });
    if (error) console.error(`  ⚠ client_kohi_records: ${error.message} (本題(重訪)には影響しないため続行)`);
    else console.log("✓ client_kohi_records");
  }

  // ⑤ shougai_certifications (受給者証。支給量内訳に juudo_houmon_kubun6 を入れて段Ⅱの裏取りにする)
  {
    const { error } = await sb.from("shougai_certifications").insert({
      tenant_id: TENANT_ID, client_id: clientId,
      support_level: "区分6", primary_disability: "身体障害",
      certification_start_date: "2025-04-01", certification_end_date: "2028-03-31",
      beneficiary_number: "9012345678",
      insurer_municipality: "千葉市",
      service_types: ["重度訪問介護"],
      copay_rate: 0,
      shikyuryo_details: { juudo_houmon_kubun6: { hours: 300, minutes: 0 } },
      notes: `頸髄損傷後遺症 (四肢麻痺) ${MARK}`,
    });
    if (error) { console.error(`✗ shougai_certifications: ${error.message}`); process.exit(1); }
  }
  console.log("✓ shougai_certifications (段Ⅱ = 障害支援区分6該当)");

  // ⑥ shogai_contracts (決定サービスコード 122000 = 段Ⅱ。段リマップの検算用)
  {
    const { error } = await sb.from("shogai_contracts").insert({
      client_id: clientId, office_id: OFFICE_ID,
      decision_code: "122000", amount_x100: 30000, amount_unit: "時間",
      entry_number: 1, start_date: "2025-04-01", end_date: "2028-03-31",
      reason: "新規契約", notes: MARK,
    });
    if (error) console.error(`  ⚠ shogai_contracts: ${error.message} (テーブル未適用の可能性。段リマップ検証はスキップ)`);
    else console.log("✓ shogai_contracts (decision_code=122000, 段Ⅱ)");
  }

  // ⑦ client_hospitalizations (入院期間。2026-06-15〜2026-06-20 を入院中とする)
  const HOSP_FROM = "2026-06-15", HOSP_TO = "2026-06-20";
  {
    const { error } = await sb.from("client_hospitalizations").insert({
      tenant_id: TENANT_ID, client_id: clientId,
      hospital_name: "検証総合病院 (fake)", department: "内科",
      admission_date: HOSP_FROM, discharge_date: HOSP_TO,
      reason: "検証用入院", status: "discharged",
      notes: MARK,
    });
    if (error) { console.error(`✗ client_hospitalizations: ${error.message}`); process.exit(1); }
  }
  console.log(`✓ client_hospitalizations (${HOSP_FROM} 〜 ${HOSP_TO})`);

  // ── kaigo_visit_schedule 投入 ──
  //   PHASE 1 のテストケースのうち代表的な 3 パターンを、
  //   (a) 入院期間外の日付 (hosp=0 で計算した通常コード)
  //   (b) 入院期間内の日付   (hosp=1 で計算した入院等コード。isHospitalizedByName と同じ判定を
  //       ここでは日付範囲で直接シミュレートする)
  //   の両方で投入し、読み戻して期待どおりか確認する。
  const stepsByZoneNormal = buildStepsByZone(juhoSteps, "II", false);
  const stepsByZoneHosp = buildStepsByZone(juhoSteps, "II", true);

  const scenarios = [
    { date: "2026-06-03", label: "5h日中のみ (入院期間外)", visits: [{ s: hm("09:00"), e: hm("14:00") }], hospitalized: false },
    { date: "2026-06-04", label: "8h日中のみ・8h境界 (入院期間外)", visits: [{ s: hm("09:00"), e: hm("17:00") }], hospitalized: false },
    { date: "2026-06-05", label: "12h 日中→夜間またぎ (入院期間外)", visits: [{ s: hm("08:00"), e: hm("20:00") }], hospitalized: false },
    // 入院期間内 (2026-06-15〜20) の同一パターン → 127xxx系 (入院等) で出るはず
    { date: "2026-06-17", label: "5h日中のみ (入院期間中)", visits: [{ s: hm("09:00"), e: hm("14:00") }], hospitalized: true },
    { date: "2026-06-18", label: "8h日中のみ・8h境界 (入院期間中)", visits: [{ s: hm("09:00"), e: hm("17:00") }], hospitalized: true },
  ];

  const insertRows = [];
  const expectedByDate = new Map();
  for (const sc of scenarios) {
    const steps = sc.hospitalized ? stepsByZoneHosp : stepsByZoneNormal;
    const convs = juhoConvsForDay(sc.visits, steps, null);
    if (!convs) { console.error(`✗ ${sc.date} 段計算失敗`); process.exit(1); }
    expectedByDate.set(sc.date, { convs, label: sc.label, hospitalized: sc.hospitalized });
    for (const c of convs) {
      insertRows.push({
        user_id: clientId, staff_id: null,
        visit_date: sc.date,
        start_time: sc.visits[0].s != null ? `${String(Math.floor(sc.visits[0].s / 60)).padStart(2, "0")}:${String(sc.visits[0].s % 60).padStart(2, "0")}` : null,
        end_time: sc.visits[sc.visits.length - 1].e != null ? `${String(Math.floor(sc.visits[sc.visits.length - 1].e / 60)).padStart(2, "0")}:${String(sc.visits[sc.visits.length - 1].e % 60).padStart(2, "0")}` : null,
        service_type: c.name,
        system: "障害",
        status: "completed",
        office_id: OFFICE_ID,
        tenant_id: TENANT_ID,
        notes: `${MARK} code=${c.code} hosp=${sc.hospitalized ? 1 : 0}`,
      });
    }
  }

  console.log(`\n投入予定: ${insertRows.length} 行 (${scenarios.length} シナリオ)`);
  const { error: insErr } = await sb.from("kaigo_visit_schedule").insert(insertRows);
  if (insErr) { console.error(`✗ kaigo_visit_schedule INSERT失敗: ${insErr.message}`); process.exit(1); }
  console.log(`✓ kaigo_visit_schedule ${insertRows.length}行 INSERT 完了\n`);

  // ── 読み戻し検証 ──
  const { data: back, error: backErr } = await sb
    .from("kaigo_visit_schedule")
    .select("visit_date,service_type,notes")
    .eq("user_id", clientId)
    .like("notes", `${MARK}%`)
    .order("visit_date");
  if (backErr) { console.error(`✗ 読み戻し失敗: ${backErr.message}`); process.exit(1); }

  // service_type(name) -> units をマスタから引けるようにする
  const nameToUnits = new Map();
  for (const arr of juhoSteps.values()) for (const s of arr) nameToUnits.set(s.name, s.units);

  console.log("=== 読み戻し検証 ===");
  let allOk = true;
  const byDate = new Map();
  for (const r of back) {
    if (!byDate.has(r.visit_date)) byDate.set(r.visit_date, []);
    byDate.get(r.visit_date).push(r);
  }
  for (const [date, exp] of expectedByDate) {
    const rows = byDate.get(date) ?? [];
    const expNames = exp.convs.map((c) => c.name);
    const actNames = rows.map((r) => r.service_type);
    const expUnits = exp.convs.reduce((a, c) => a + c.units, 0);
    const actUnits = rows.reduce((a, r) => a + (nameToUnits.get(r.service_type) ?? 0), 0);
    const namesMatch = expNames.length === actNames.length && expNames.every((n, i) => n === actNames[i]);
    const hospTag = exp.hospitalized ? "【入院期間中→127xxx系のはず】" : "";
    console.log(`--- ${date} ${exp.label} ${hospTag} ---`);
    console.log(`  期待: ${expNames.join(" / ")} (${expUnits}単位)`);
    console.log(`  実際: ${actNames.join(" / ")} (${actUnits}単位)`);
    if (exp.hospitalized) {
      const allHosp = rows.every((r) => /^重訪Ⅱ入院等/.test((r.service_type || "").normalize("NFC")));
      console.log(`  入院等コード(重訪Ⅱ入院等〜)のみか: ${allHosp ? "✓ はい" : "✗ いいえ"}`);
      if (!allHosp) allOk = false;
    }
    if (namesMatch && expUnits === actUnits) { console.log("  ✓ 一致"); }
    else { console.log("  ✗ 不一致"); allOk = false; }
    console.log("");
  }

  // ── 段リマップ検証 (shogai_contracts.decision_code=122000=段Ⅱ → 変化なし = identity のはず) ──
  console.log("=== 段(Ⅰ/Ⅱ/Ⅲ)リマップ検証 (decision_code=122000=段Ⅱ) ===");
  {
    let remapOk = true, remapChecked = 0;
    for (const [, exp] of expectedByDate) {
      for (const c of exp.convs) {
        const s = splitTierName((c.name || "").normalize("NFC"));
        if (!s) continue;
        remapChecked++;
        // 段Ⅱ契約なので remap 先も段Ⅱ = 変化しないはず (identity)
        const hospFlag = exp.hospitalized ? 1 : 0;
        const baseKey = `${s.base}|${hospFlag}|0`;
        const slot = byBaseTierHosp.get(baseKey);
        const target = slot?.["Ⅱ"];
        if (!target || target.code !== c.code) { remapOk = false; console.log(`  ✗ ${c.name}: 段Ⅱへのremap先が一致しない`); }
      }
    }
    console.log(`  ${remapChecked}件チェック、${remapOk ? "✓ 全件 identity で一致" : "✗ 不一致あり"}\n`);
    if (!remapOk) allOk = false;
  }

  console.log(allOk ? "=== PHASE 2 総合結果: ✓ 全シナリオ一致 ===" : "=== PHASE 2 総合結果: ✗ 不一致あり (上記参照) ===");
  console.log(`\nテストデータの client_id = ${clientId} (user_number=${USER_NO})`);
  console.log("後始末: node migrations/verify_juho_step_and_hospitalization_cleanup.mjs --execute");
  return { allOk, clientId };
}

async function main() {
  console.log(`=== 重訪 段計算 + 入院等コード 検証 ${EXECUTE ? "【PHASE1+2 実行】" : "【PHASE1のみ・DRY RUN】"} ===`);
  const { juhoSteps, byBaseTierHosp } = await loadJuhoMaster();
  console.log(`重訪マスタ読込: ${juhoSteps.size} キー (対象月 ${TARGET_MONTH})`);

  const p1 = await phase1(juhoSteps);
  const p1b = await phase1b(juhoSteps);

  if (!EXECUTE) {
    console.log("※ PHASE 2 (DB書込) はスキップしました。--execute で実行してください。");
    if (p1.bugCount > 0 || p1b.mismatch > 0) process.exitCode = 1;
    return;
  }

  const p2 = await phase2(juhoSteps, byBaseTierHosp);
  if (p1.bugCount > 0 || p1b.mismatch > 0 || !p2.allOk) process.exitCode = 1;
}

main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
