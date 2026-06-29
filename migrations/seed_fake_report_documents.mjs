/**
 * 各帳票種別 (REPORT_CONFIG の 6 種類) のサンプル「保存済み帳票」を
 * 訪問介護 fake 利用者 (OY001-010) に投入する seed script。
 *
 * 投入先 table:
 *   - kaigo_report_documents (= 全 6 種類が同じ table、content jsonb)
 *
 * 帳票種別:
 *   - care-plan-1       居宅サービス計画書（第1表）       certification_id 必要
 *   - care-plan-2       居宅サービス計画書（第2表）       certification_id 必要
 *   - care-plan-3       週間サービス計画表（第3表）       certification_id 必要
 *   - support-progress  居宅介護支援経過（第5表）         report_month (最新月) 必要
 *   - service-usage     利用票・提供票                     report_month (最新月) 必要
 *   - service-usage-detail サービス利用票別表             report_month (最新月) 必要
 *
 * マーカー:
 *   content._sample_marker = "fake-reports-2026-06"
 *   → 後で cleanup script で全削除可能。
 *
 * 冪等性:
 *   同マーカー + 同 (user_id, report_type) があれば skip。
 *
 * Usage:
 *   node migrations/seed_fake_report_documents.mjs               # DRY RUN
 *   node migrations/seed_fake_report_documents.mjs --execute     # 本番実行
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(p) {
  try {
    const e = readFileSync(p, "utf8");
    const v = {};
    for (const l of e.split("\n")) {
      const m = l.match(/^([^=]+)=(.+)$/);
      if (m) v[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return v;
  } catch { return {}; }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL =
  envKaigo.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  envKaigo.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

const EXECUTE = process.argv.includes("--execute");
const TENANT_ID = "kt-group";
const FAKE_MARKER = "fake-reports-2026-06";

// 対象帳票
const REPORT_CONFIG = {
  "care-plan-1":          { titleJa: "居宅サービス計画書（第1表）",  needsPeriod: false },
  "care-plan-2":          { titleJa: "居宅サービス計画書（第2表）",  needsPeriod: false },
  "care-plan-3":          { titleJa: "週間サービス計画表（第3表）",  needsPeriod: false },
  "support-progress":     { titleJa: "居宅介護支援経過（第5表）",    needsPeriod: true  },
  "service-usage":        { titleJa: "利用票・提供票",                needsPeriod: true  },
  "service-usage-detail": { titleJa: "サービス利用票別表",            needsPeriod: true  },
};

// 最新月 (= 投入対象の report_month)
function currentYearMonth() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
const REPORT_MONTH = currentYearMonth();

// 和暦
function fmtReiwa(dStr) {
  if (!dStr) return "　　年　月　日";
  try {
    const d = new Date(dStr);
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    if (y >= 2019) return `令和${y - 2018}年${m}月${day}日`;
    return `${y}年${m}月${day}日`;
  } catch { return dStr; }
}
function fmtJaYearMonth(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-").map((x) => parseInt(x, 10));
  return `${y}年${m}月`;
}
function fmtToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// content builders ─────────────────────────────────────────────

function buildCarePlan1(user, cert) {
  return {
    plan_type: "継続",
    cert_status: cert ? "認定済" : "申請中",
    user_name: user.name,
    birth_date: user.birth_date ?? "",
    address: [user.postal_code ? `〒${user.postal_code}` : "", user.address ?? ""].filter(Boolean).join(" "),
    care_level: cert?.care_level ?? "",
    cert_period: cert ? `${fmtReiwa(cert.certification_start_date)}　〜　${fmtReiwa(cert.certification_end_date)}` : "",
    creator_name: "ケアマネ 太郎",
    office_name: "Ｈａｎａ居宅支援センターおゆみ野",
    creation_date: fmtReiwa(fmtToday()),
    initial_creation_date: fmtReiwa(cert?.certification_start_date ?? fmtToday()),
    issue_analysis:
      "本人は自宅での生活継続を強く希望されている。" +
      "家族の介護負担軽減のため、訪問介護と福祉用具の活用を中心に支援を行う必要がある。" +
      "認知機能の低下に伴う見守りも課題である。",
    review_opinion: "認定審査会の意見特になし。",
    overall_policy:
      "在宅生活継続のため必要な支援を行う。" +
      "ご本人の自立支援と家族介護者の負担軽減を両立させ、" +
      "安心して在宅生活が送れるよう、各サービスを連携して提供する。",
    living_support_reason: "",
    _sample_marker: FAKE_MARKER,
  };
}

function buildCarePlan2(user, cert) {
  const planPeriod = cert
    ? `${fmtReiwa(cert.certification_start_date)}〜${fmtReiwa(cert.certification_end_date)}`
    : "";
  const blocks = [
    {
      needs: "身体機能の低下があり、入浴や清潔保持に支援が必要",
      long_term_goal: "在宅生活を継続し、清潔で快適な生活が送れる",
      long_term_period: planPeriod,
      goals: [{
        short_term_goal: "週3回の入浴で身体の清潔を保つことができる",
        short_term_period: planPeriod,
        services: [
          { content: "入浴介助・身体清拭", insurance_flag: "○", type: "訪問介護", provider: "Ｈａｎａヘルパーステーションおゆみ野", frequency: "週3回（月・水・金）", period: planPeriod },
          { content: "シャワーチェア・手すりレンタル", insurance_flag: "○", type: "福祉用具貸与", provider: "Ｈａｎａ福祉用具花見川", frequency: "常時", period: planPeriod },
        ],
      }],
    },
    {
      needs: "独居のため食事準備や買物等の家事援助が必要",
      long_term_goal: "栄養バランスの取れた食事を継続して摂取できる",
      long_term_period: planPeriod,
      goals: [{
        short_term_goal: "週2回の生活援助で食事と環境整備が維持できる",
        short_term_period: planPeriod,
        services: [
          { content: "調理・買物・掃除", insurance_flag: "○", type: "訪問介護", provider: "Ｈａｎａヘルパーステーションおゆみ野", frequency: "週2回（火・木）", period: planPeriod },
        ],
      }],
    },
  ];
  return {
    user_name: user.name,
    creation_date: fmtReiwa(fmtToday()),
    blocks,
    _sample_marker: FAKE_MARKER,
  };
}

function buildCarePlan3(user, cert) {
  // 週間サービス計画表 (CARE_PLAN3_TIME_ROWS の key 形式: h00, h02, ..., h22)
  const emptyDay = () => ({ mon: "", tue: "", wed: "", thu: "", fri: "", sat: "", sun: "" });
  const schedule = {};
  for (const k of ["h00","h02","h04","h06","h08","h10","h12","h14","h16","h18","h20","h22"]) {
    schedule[k] = emptyDay();
  }
  // 10:00 帯に入浴介助 (月水金) / 14:00 帯に生活援助 (火木)
  schedule.h10.mon = "訪問介護（入浴介助）";
  schedule.h10.wed = "訪問介護（入浴介助）";
  schedule.h10.fri = "訪問介護（入浴介助）";
  schedule.h14.tue = "訪問介護（生活援助：調理・買物）";
  schedule.h14.thu = "訪問介護（生活援助：掃除・洗濯）";
  return {
    user_name: user.name,
    creation_date: fmtReiwa(fmtToday()),
    care_level: cert?.care_level ?? "",
    plan_period: cert
      ? `${fmtReiwa(cert.certification_start_date)}〜${fmtReiwa(cert.certification_end_date)}`
      : "",
    schedule,
    daily_activities: "起床・洗面・着替え　／　食事（朝・昼・夕）　／　テレビ視聴　／　入浴（週3回）　／　就寝",
    other_services: "福祉用具貸与（シャワーチェア・手すり）",
    _sample_marker: FAKE_MARKER,
  };
}

function buildSupportProgress(user, reportMonth) {
  // 月内日付ベースで支援記録 4 件
  const [y, m] = reportMonth.split("-").map((x) => parseInt(x, 10));
  const d = (day) => `${y}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  return {
    user_name: user.name,
    creation_date: fmtReiwa(fmtToday()),
    creator_name: "ケアマネ 太郎",
    entries: [
      { date: d(3),  category: "電話",                   content: "ご家族より体調確認の連絡あり。発熱や不調なし、食事も摂れているとのこと。次回訪問予定を確認。" },
      { date: d(10), category: "訪問",                   content: "月次モニタリング訪問。ADL に大きな変化なし。入浴サービスも継続できており満足度高い。次月もこのまま継続。" },
      { date: d(17), category: "サービス担当者会議",     content: "ヘルパーステーション、福祉用具事業所同席にて担当者会議実施。サービス内容について課題なし、現状継続の方針を確認。" },
      { date: d(24), category: "モニタリング",           content: "目標達成状況確認。短期目標『週3回の入浴維持』は達成中。次月以降も継続評価。" },
    ],
    _sample_marker: FAKE_MARKER,
  };
}

function buildServiceUsage(user, cert, reportMonth) {
  return {
    insurer_number: cert?.insurer_number ?? "",
    insured_number: cert?.insured_number ?? "",
    insurer_name: "千葉市",
    user_name: user.name,
    care_level: cert?.care_level ?? "",
    limit_amount: cert?.service_limit_amount ?? 19705,
    limit_period: cert
      ? `${fmtReiwa(cert.certification_start_date)}〜${fmtReiwa(cert.certification_end_date)}`
      : "",
    creation_date: fmtReiwa(fmtToday()),
    submission_date: fmtReiwa(fmtToday()),
    report_month: reportMonth,
    services: [
      { time: "週3回（月・水・金）", content: "身体介護2 (入浴介助)",   provider: "Ｈａｎａヘルパーステーションおゆみ野", planned: Array(31).fill(false), actual: Array(31).fill(false), category: "11", units: 396 },
      { time: "週2回（火・木）",     content: "生活援助2 (調理・掃除)", provider: "Ｈａｎａヘルパーステーションおゆみ野", planned: Array(31).fill(false), actual: Array(31).fill(false), category: "11", units: 181 },
      { time: "常時",                content: "シャワーチェア貸与",     provider: "Ｈａｎａ福祉用具花見川",               planned: Array(31).fill(false), actual: Array(31).fill(false), category: "17", units: 100, manual_units: 100 },
    ],
    _sample_marker: FAKE_MARKER,
  };
}

function buildServiceUsageDetail(user, cert, reportMonth) {
  return {
    creation_date: fmtReiwa(fmtToday()),
    user_name: user.name,
    insurer_number: cert?.insurer_number ?? "",
    insured_number: cert?.insured_number ?? "",
    care_level: cert?.care_level ?? "",
    limit_amount: cert?.service_limit_amount ?? 19705,
    limit_period: cert
      ? `${fmtReiwa(cert.certification_start_date)}〜${fmtReiwa(cert.certification_end_date)}`
      : "",
    report_month: reportMonth,
    items: [
      {
        provider_name: "Ｈａｎａヘルパーステーションおゆみ野", provider_number: "1271234567",
        service_content: "身体介護2 (入浴介助)", service_code: "111313",
        units: 396, discount_units: 396, count: 12, service_units: 4752,
        over_type_units: 0, over_limit_units: 0, within_limit_units: 4752,
        unit_price: 11.40, total_cost: 54172, benefit_rate: 90,
        insurance_claim: 48755, fixed_copay: 0, user_copay: 5417, user_full_pay: 0,
      },
      {
        provider_name: "Ｈａｎａヘルパーステーションおゆみ野", provider_number: "1271234567",
        service_content: "生活援助2 (調理・掃除)", service_code: "112313",
        units: 181, discount_units: 181, count: 8, service_units: 1448,
        over_type_units: 0, over_limit_units: 0, within_limit_units: 1448,
        unit_price: 11.40, total_cost: 16507, benefit_rate: 90,
        insurance_claim: 14856, fixed_copay: 0, user_copay: 1651, user_full_pay: 0,
      },
      {
        provider_name: "Ｈａｎａ福祉用具花見川", provider_number: "1279876543",
        service_content: "シャワーチェア貸与", service_code: "171001",
        units: 100, discount_units: 100, count: 1, service_units: 100,
        over_type_units: 0, over_limit_units: 0, within_limit_units: 100,
        unit_price: 10.00, total_cost: 1000, benefit_rate: 90,
        insurance_claim: 900, fixed_copay: 0, user_copay: 100, user_full_pay: 0,
      },
    ],
    limit_management: [
      { service_type: "訪問介護",     limit: 19705, total_units: 6200, over_units: 0 },
      { service_type: "福祉用具貸与", limit: 19705, total_units: 100,  over_units: 0 },
    ],
    short_stay_days: { prev: 0, current: 0, total: 0 },
    _sample_marker: FAKE_MARKER,
  };
}

function buildContent(reportType, user, cert, reportMonth) {
  switch (reportType) {
    case "care-plan-1":          return buildCarePlan1(user, cert);
    case "care-plan-2":          return buildCarePlan2(user, cert);
    case "care-plan-3":          return buildCarePlan3(user, cert);
    case "support-progress":     return buildSupportProgress(user, reportMonth);
    case "service-usage":        return buildServiceUsage(user, cert, reportMonth);
    case "service-usage-detail": return buildServiceUsageDetail(user, cert, reportMonth);
    default: throw new Error(`unknown reportType: ${reportType}`);
  }
}

// main ──────────────────────────────────────────────────────────

async function main() {
  console.log(`\n[fake-reports seed]`);
  console.log(`  tenant_id  = ${TENANT_ID}`);
  console.log(`  marker     = ${FAKE_MARKER}`);
  console.log(`  reportMonth (for needsPeriod 帳票) = ${REPORT_MONTH}`);
  console.log(`  mode       = ${EXECUTE ? "EXECUTE (本番書込)" : "DRY RUN"}`);
  console.log(``);

  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  // 対象利用者: OY001-010
  const { data: users, error: ue } = await sb.from("clients")
    .select("id, user_number, name, birth_date, postal_code, address")
    .like("user_number", "OY%")
    .order("user_number");
  if (ue) { console.error("clients fetch error:", ue.message); process.exit(1); }
  if (!users || users.length === 0) {
    console.error("対象利用者 (OY%) が見つかりません。");
    process.exit(1);
  }
  console.log(`対象利用者: ${users.length} 名`);
  for (const u of users) console.log(`  - ${u.user_number} ${u.name}  (${u.id})`);
  console.log(``);

  // 各利用者の最新 cert (= 認定済み 1 件目)
  const ids = users.map((u) => u.id);
  const { data: certsAll, error: ce } = await sb.from("client_insurance_records")
    .select("id, client_id, care_level, certification_start_date, certification_end_date, certification_status, insurer_number, insured_number, service_limit_amount, care_manager, care_office_id")
    .in("client_id", ids)
    .order("certification_start_date", { ascending: false, nullsFirst: false });
  if (ce) { console.error("cert fetch error:", ce.message); process.exit(1); }
  const latestCertByClient = new Map();
  for (const c of certsAll ?? []) {
    if (latestCertByClient.has(c.client_id)) continue;
    if (c.certification_status !== "認定済み") continue;
    latestCertByClient.set(c.client_id, c);
  }
  console.log(`最新 cert 取得: ${latestCertByClient.size} / ${users.length} 名`);
  console.log(``);

  // 既存マーカーで skip 判定
  const { data: existing, error: exErr } = await sb.from("kaigo_report_documents")
    .select("id, user_id, report_type, content")
    .in("user_id", ids);
  if (exErr) { console.error("existing fetch error:", exErr.message); process.exit(1); }
  const existingKeys = new Set();
  for (const r of existing ?? []) {
    const marker = r?.content?._sample_marker;
    if (marker === FAKE_MARKER) {
      existingKeys.add(`${r.user_id}|${r.report_type}`);
    }
  }
  console.log(`既存 fake-reports skip 数: ${existingKeys.size}`);
  console.log(``);

  // 投入予定リスト構築
  const toInsert = [];
  const reportTypes = Object.keys(REPORT_CONFIG);
  for (const user of users) {
    const cert = latestCertByClient.get(user.id) ?? null;
    for (const reportType of reportTypes) {
      const key = `${user.id}|${reportType}`;
      if (existingKeys.has(key)) continue;

      const cfg = REPORT_CONFIG[reportType];
      const needsCert = reportType.startsWith("care-plan-");
      if (needsCert && !cert) {
        console.warn(`  skip: ${user.user_number} ${reportType} (cert 無し)`);
        continue;
      }
      const reportMonth = cfg.needsPeriod ? REPORT_MONTH : null;
      const content = buildContent(reportType, user, cert, reportMonth);
      const title = cfg.needsPeriod
        ? `${cfg.titleJa}（${fmtJaYearMonth(reportMonth)}）`
        : `${cfg.titleJa}　${fmtReiwa(fmtToday())}`;

      toInsert.push({
        tenant_id: TENANT_ID,
        user_id: user.id,
        certification_id: needsCert ? cert.id : null,
        report_type: reportType,
        title,
        report_month: reportMonth,
        care_plan_id: null,
        content,
        status: "completed",
      });
    }
  }

  // dry-run 集計
  const byType = {};
  for (const r of toInsert) {
    byType[r.report_type] = (byType[r.report_type] ?? 0) + 1;
  }
  console.log(`\n投入予定: 合計 ${toInsert.length} 件`);
  for (const t of reportTypes) {
    console.log(`  ${t.padEnd(22)} ${byType[t] ?? 0} 件`);
  }
  console.log(``);

  if (!EXECUTE) {
    console.log("DRY RUN 完了。`--execute` で本番投入。");
    return;
  }

  // 本番 INSERT (chunk 30)
  let ok = 0, ng = 0;
  for (let i = 0; i < toInsert.length; i += 30) {
    const chunk = toInsert.slice(i, i + 30);
    const { data, error } = await sb.from("kaigo_report_documents")
      .insert(chunk)
      .select("id");
    if (error) {
      ng += chunk.length;
      console.error(`INSERT chunk ${i}: ${error.message}`);
    } else {
      ok += data?.length ?? 0;
      console.log(`  inserted chunk ${i}: +${data?.length ?? 0}`);
    }
  }
  console.log(`\n投入結果: 成功 ${ok} 件 / 失敗 ${ng} 件`);

  // 確認 SQL (件数)
  const { count: afterCount } = await sb.from("kaigo_report_documents")
    .select("*", { count: "exact", head: true })
    .in("user_id", ids);
  console.log(`OY% 利用者の全帳票数 (現在): ${afterCount}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
