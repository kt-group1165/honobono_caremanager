/**
 * ほのぼの(身障) → kaigo-app 障害利用者 取込 (リンクス大網白里事業所)
 *
 * 入力: migrations/shougai_import_oami.json
 *   (= 基本情報 CSV + 大網受給者証.pdf を parse_shougai_oami.py で構造化したもの)
 *
 * 生成データ (1 利用者あたり):
 *   ① clients                    1 行 (氏名+生年月日で既存重複はスキップ or 流用)
 *   ② client_office_assignments  1 行 (office = リンクス大網白里事業所)
 *   ③ shougai_certifications     現在有効(なければ最新)の受給者証 1〜N 行
 *
 * 重複判定 (花見川と同じ):
 *   - 氏名(正規化) + 生年月日 一致 → 既存 client を流用 (INSERT しない)
 *   - user_number 一致だけでは流用しない (短番号が事業所エントリ番号と衝突するため)
 *   - user_number は NOT NULL + unique:
 *       衝突 (23505) → 元番号+100000 でリナンバー
 *       ほのぼの側で番号なし → 999901〜 の連番を採番
 *   - 流用 client にも assignment / cert は不足分のみ追加
 *   - 大網の障害 36 名の多くは介護 STEP1 で既に clients に居るはず (= 流用される想定)
 *
 * 拡張列 (shougai_cert_more_fields.sql) は適用状況を自動検出:
 *   適用済 → issue_date / income_category / shikyuryo_details / flag_h30_after も保存
 *   未適用 → 上記は notes 内テキストとして保存
 *
 * マーカー: shougai_certifications.notes 先頭に '[ほのぼの取込 2026-07-17 大網身障]'
 *
 * Usage:
 *   node migrations/import_honobono_shougai_oami.mjs              # DRY RUN
 *   node migrations/import_honobono_shougai_oami.mjs --execute    # 本番実行
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const SB_URL = envKaigo.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envKaigo.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY);

const TENANT_ID = "kt-group";
// env でマルチ事業所化 (未指定は大網デフォルト):
//   SH_OFFICE_ID  kaigo-app office_id
//   SH_MARKER     取込マーカー (notes 先頭・冪等キー)
//   SH_JSON       parse 出力 JSON ファイル名 (migrations/ 配下)
//   SH_LABEL      verify ログの事業所ラベル
// リンクス大網白里事業所=269d77bc / リンクスヘルパーステーション(茂原)=e08c3706-ad59-4913-b4e2-67f2675422e9
const OFFICE_ID = process.env.SH_OFFICE_ID || "269d77bc-5b61-4114-a2ea-e8dc2f220823";
const MARKER = process.env.SH_MARKER || "[ほのぼの取込 2026-07-17 大網身障]";
const OFFICE_LABEL = process.env.SH_LABEL || "大網";
const TODAY = new Date().toISOString().slice(0, 10);
const EXECUTE = process.argv.includes("--execute");

// 支給決定市町村 → 障害 市町村番号 (6 桁)
// 千葉市 = 121004: 花見川取込で確認済 (障害福祉は市単位。介護保険者番号 121012 等の区別とは別体系)
// 東金市 / 大網白里市 / 八街市 / 山武市 / 市原市 / 九十九里町 は未確認 → 推測で捏造せず warning。
//   → 市町村名がそのまま insurer_municipality に入り、伝送 build.ts が warning を出す。
//     ほのぼの受給者証画面で 6 桁を確認したらここに追記する。
const CITY_CODE = {
  千葉市: "121004",
};

const JSON_PATH = join(__dirname, process.env.SH_JSON || "shougai_import_oami.json");
const data = JSON.parse(readFileSync(JSON_PATH, "utf8"));

const norm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

function fmtQty(q) {
  return Object.entries(q || {})
    .map(([k, v]) =>
      v.hours != null ? `${k}${v.hours}時間${String(v.minutes ?? 0).padStart(2, "0")}分`
      : v.count != null ? `${k}${v.count}回` : k)
    .join(" / ");
}

async function main() {
  console.log(EXECUTE ? "🚀 EXECUTE モード" : "🔍 DRY RUN (--execute で本番実行)");
  console.log(`   取込元: ${JSON_PATH}`);
  console.log(`   利用者 ${data.clients.length} 名 / 受給者証 entry ${data.stats.total_cert_entries} 件 (取込対象 = 現在有効分のみ)`);

  // ── 拡張列 (shougai_cert_more_fields.sql) の適用検出 ──
  let extApplied = true;
  {
    const { error } = await sb
      .from("shougai_certifications")
      .select("issue_date, income_category, shikyuryo_details, flag_h30_after")
      .limit(1);
    if (error) {
      extApplied = false;
      console.log(`⚠️  拡張列 未適用 (${error.code}): 交付日/所得区分/支給量内訳は notes に格納します`);
      console.log("    → migrations/shougai_cert_more_fields.sql を SQL Editor で適用すると列に入ります");
    } else {
      console.log("✅ 拡張列 (shougai_cert_more_fields) 適用済 → フル項目で保存");
    }
  }

  // ── 上限管理区分 (jogen_kanri_kubun) の自動導出用 ──
  // 受給者証の上限管理事業所名を自事業所名と照合して 自/他/なし を機械判定する
  // (空=なし / 自事業所名と一致=自事業所+自障害番号 / それ以外=他事業所)。判断不要の転記。
  const { data: selfOffice } = await sb
    .from("offices")
    .select("name, business_number, shogai_business_number")
    .eq("id", OFFICE_ID)
    .maybeSingle();
  const SELF_NAME = selfOffice?.name ?? "";
  const SELF_SHOGAI_NUM = selfOffice?.shogai_business_number ?? selfOffice?.business_number ?? null;
  const normName = (s) => (s || "").normalize("NFKC").replace(/[\s　]/g, "");
  const deriveJogen = (officeName) => {
    if (!officeName) return { kubun: "なし", num: null };
    const a = normName(officeName), b = normName(SELF_NAME);
    return b && (a === b || a.includes(b) || b.includes(a))
      ? { kubun: "自事業所", num: SELF_SHOGAI_NUM }
      : { kubun: "他事業所", num: null };
  };

  // ── 既存 client の重複チェック (氏名正規化 + 生年月日) ──
  const existingByNameBirth = new Map();
  {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data: rows, error } = await sb
        .from("clients")
        .select("id, user_number, name, birth_date")
        .eq("tenant_id", TENANT_ID)
        .is("deleted_at", null)
        .range(from, from + PAGE - 1);
      if (error) { console.error(`❌ 既存チェック失敗: ${error.message}`); process.exit(1); }
      for (const r of rows ?? []) {
        if (r.birth_date) existingByNameBirth.set(`${norm(r.name)}|${r.birth_date}`, r);
      }
      if (!rows || rows.length < PAGE) break;
      from += PAGE;
    }
  }

  // ── 既存 assignment / cert (二重 INSERT 防止) ──
  const { data: exAsg, error: e3 } = await sb
    .from("client_office_assignments")
    .select("client_id")
    .eq("office_id", OFFICE_ID);
  if (e3) { console.error(`❌ 既存 assignment 取得失敗: ${e3.message}`); process.exit(1); }
  const assignedClientIds = new Set((exAsg ?? []).map((r) => r.client_id));

  const { data: exCerts, error: e4 } = await sb
    .from("shougai_certifications")
    .select("client_id, beneficiary_number, certification_start_date");
  if (e4) { console.error(`❌ 既存 cert 取得失敗: ${e4.message}`); process.exit(1); }
  const certKeys = new Set(
    (exCerts ?? []).map((r) => `${r.client_id}|${r.beneficiary_number}|${r.certification_start_date}`),
  );

  // ── plan 構築 ──
  const plan = [];
  const cityWarn = new Set();
  for (const c of data.clients) {
    const existing = existingByNameBirth.get(`${norm(c.name)}|${c.birth_date}`) ?? null;
    const clientId = existing ? existing.id : randomUUID();
    const certs = (c.current_certs ?? []).filter(
      (e) => !certKeys.has(`${clientId}|${e.cert_number}|${e.period_start}`),
    );
    for (const e of certs) {
      if (e.city && !CITY_CODE[e.city]) cityWarn.add(e.city);
    }
    plan.push({
      c, clientId,
      insertClient: !existing,
      reuseReason: existing ? "氏名+生年月日" : null,
      insertAssignment: !assignedClientIds.has(clientId),
      certs,
    });
  }

  const nClients = plan.filter((p) => p.insertClient).length;
  const nReuse = plan.length - nClients;
  const nAsg = plan.filter((p) => p.insertAssignment).length;
  const nCerts = plan.reduce((s, p) => s + p.certs.length, 0);
  console.log(`\n📊 plan: clients 新規 ${nClients} / 既存流用 ${nReuse}、assignments ${nAsg}、certifications ${nCerts}`);
  for (const p of plan) {
    const tags = [];
    if (!p.insertClient) tags.push(`既存流用(${p.reuseReason})`);
    if (!p.insertAssignment) tags.push("assignment済");
    const certStr = p.certs
      .map((e) => {
        const expired = e.period_end && e.period_end < TODAY ? "⚠️期限切れ" : "";
        const cc = e.city ? (CITY_CODE[e.city] ? `${e.city}(${CITY_CODE[e.city]})` : `${e.city}⚠️番号未解決`) : "";
        return `${e.cert_number} ${e.period_start}〜${e.period_end} ${e.support_level ?? "非該当"} ${e.service ?? "?"} ${cc} ${expired}`;
      })
      .join(" | ");
    console.log(`  ${(p.c.user_number ?? "(番号なし)").padEnd(12)} ${p.c.name.padEnd(9)} ${certStr} ${tags.join(" ")}`);
  }
  if (cityWarn.size) {
    console.log(`\n⚠️  市町村番号 未解決 ${cityWarn.size} 件 (推測せず。伝送前に受給者証で確認して CITY_CODE に追記):`);
    console.log(`   ${[...cityWarn].join(" / ")}`);
  }
  if (data.warnings?.length) {
    console.log(`\n⚠️  parse 時警告 ${data.warnings.length} 件:`);
    for (const w of data.warnings) console.log(`   - ${w}`);
  }

  if (!EXECUTE) {
    console.log("\n🔍 DRY RUN 終了 (何も書き込んでいません)");
    return;
  }

  // ── 実行 ──
  let okC = 0, okA = 0, okS = 0, ng = 0;
  let blankSeq = 999901; // 番号なし利用者の採番 (999901〜)
  for (const p of plan) {
    const c = p.c;
    if (p.insertClient) {
      const clientRow = {
        id: p.clientId,
        tenant_id: TENANT_ID,
        user_number: c.user_number ?? null,
        name: c.name,
        furigana: c.furigana ?? null,
        gender: c.gender,
        birth_date: c.birth_date,
        postal_code: c.postal_code,
        address: c.address || null,
        phone: c.phone,
        mobile: c.mobile,
        office_id: OFFICE_ID,
        status: "active",
        is_facility: false,
        is_provisional: false,
      };
      if (!clientRow.user_number) {
        clientRow.user_number = String(blankSeq++);
        console.warn(`  ⚠️ ${c.name}: ほのぼの番号なし → user_number=${clientRow.user_number} を採番`);
      }
      let { error } = await sb.from("clients").insert(clientRow);
      if (error && error.code === "23505" && /^\d{1,5}$/.test(clientRow.user_number)) {
        const renum = String(100000 + Number(clientRow.user_number));
        console.warn(`  ⚠️ ${c.name}: user_number=${clientRow.user_number} が unique 衝突 → ${renum} にリナンバー`);
        ({ error } = await sb.from("clients").insert({ ...clientRow, user_number: renum }));
      }
      if (error) { console.error(`  ✗ ${c.name} clients: ${error.message}`); ng++; continue; }
      okC++;
    }
    if (p.insertAssignment) {
      const { error } = await sb.from("client_office_assignments").insert({
        tenant_id: TENANT_ID,
        client_id: p.clientId,
        office_id: OFFICE_ID,
        start_date: TODAY,
      });
      if (error) { console.error(`  ✗ ${c.name} assignment: ${error.message}`); ng++; }
      else okA++;
    }
    for (const e of p.certs) {
      const cityCode = CITY_CODE[e.city] ?? null;
      const noteLines = [
        MARKER,
        `事業種別: ${e.jigyou ?? ""}${e.service ? `【${e.service}】` : ""} ${e.city ?? ""}`,
        `交付日: ${e.issue_date ?? "?"} / 所得区分: ${e.income_category ?? "?"} / 上限月額: ${e.payment_limit ?? "?"}円`,
        `支給量: ${fmtQty(e.quantities)}`,
      ];
      if (!cityCode && e.city) noteLines.push(`⚠️ 市町村番号 未解決: ${e.city}`);
      const jg = deriveJogen(e.jogen_kanri_office);
      const row = {
        tenant_id: TENANT_ID,
        client_id: p.clientId,
        support_level: e.support_level ?? "非該当",
        certification_start_date: e.period_start,
        certification_end_date: e.period_end,
        beneficiary_number: e.cert_number,
        insurer_municipality: cityCode ?? e.city ?? null,
        service_types: e.service ? [e.service] : Object.keys(e.quantities ?? {}),
        copay_rate: 0.1,
        self_payment_limit: e.payment_limit ?? null,
        jogen_kanri_office_name: e.jogen_kanri_office ?? null,
        jogen_kanri_kubun: jg.kubun,
        jogen_kanri_office_number: jg.num,
        notes: noteLines.join("\n"),
      };
      if (extApplied) {
        row.issue_date = e.issue_date ?? null;
        row.income_category = e.income_category ?? null;
        row.shikyuryo_details = e.quantities ?? null;
        row.flag_h30_after = !!e.flag_h30_after;
      }
      const { error } = await sb.from("shougai_certifications").insert(row);
      if (error) { console.error(`  ✗ ${c.name} cert ${e.cert_number}: ${error.message}`); ng++; }
      else okS++;
    }
  }

  console.log(`\n✅ 完了: clients ${okC} / assignments ${okA} / certifications ${okS}、失敗 ${ng}`);

  // ── 件数確認 (verify) ──
  const { count: cnt1 } = await sb
    .from("client_office_assignments")
    .select("*", { count: "exact", head: true })
    .eq("office_id", OFFICE_ID);
  const { count: cnt2 } = await sb
    .from("shougai_certifications")
    .select("*", { count: "exact", head: true })
    .like("notes", `${MARKER}%`);
  console.log(`🔎 verify: ${OFFICE_LABEL} assignments = ${cnt1}、取込マーカー付き certs = ${cnt2}`);
}

main().catch((e) => { console.error("❌ fatal:", e); process.exit(1); });
