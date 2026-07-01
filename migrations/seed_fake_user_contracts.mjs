/**
 * OY001-OY010 (= 訪問介護 fake 利用者 10 名) に
 *   重要事項説明書 + 契約書 の 2 件を kaigo_user_contracts に seed する。
 *
 * 想定 office:
 *   訪問介護 office_id = 4f14d50c-76b5-4f44-ac41-ed6d01f53a30 (Ｈａｎａヘルパーステーションおゆみ野)
 *
 * マーカー:
 *   - notes に「[fake テスト用-contract]」
 *   - content._sample_marker = "fake-contract-YYYY-MM"
 *
 * Usage:
 *   node migrations/seed_fake_user_contracts.mjs              # DRY RUN
 *   node migrations/seed_fake_user_contracts.mjs --execute    # 本番
 *
 * 削除する場合:
 *   DELETE FROM kaigo_user_contracts
 *    WHERE notes LIKE '%[fake テスト用-contract]%';
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

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
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL =
  envKaigo.NEXT_PUBLIC_SUPABASE_URL ||
  envCal.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  envKaigo.SUPABASE_SERVICE_ROLE_KEY ||
  envCal.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

const TENANT_ID = "kt-group";
// 契約書兼重要事項説明書 は居宅介護支援事業所カテゴリ用
const KYOTAKU_OFFICE_ID = "1b22d425-2ec4-4c2f-a002-c1c994e94507"; // Ｈａｎａ居宅支援センターおゆみ野 (居宅介護支援)
const FAKE_MARKER = "[fake テスト用-contract]";
const SAMPLE_MARKER = "fake-contract-2026-06";

const EXECUTE = process.argv.includes("--execute");

// OY001-OY010 を user_number で取る (seed_fake_houmonkaigo_clients.mjs と同じ user_no を想定)
const TARGET_USER_NUMBERS = Array.from({ length: 10 }, (_, i) =>
  `OY${String(i + 1).padStart(3, "0")}`,
);

const TODAY = new Date();
function ymd(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function addYears(d, n) {
  const c = new Date(d);
  c.setFullYear(c.getFullYear() + n);
  return c;
}

// ──────────────────────────────────────────────────
// content (= JSONB) の section テンプレ (リアルなダミー)
// ──────────────────────────────────────────────────
function jujikouContent() {
  return {
    _sample_marker: SAMPLE_MARKER,
    company_name: "株式会社KTグループ Ｈａｎａヘルパーステーションおゆみ野",
    company_address: "千葉県千葉市緑区おゆみ野中央 1-2-3",
    company_phone: "043-291-0001",
    company_fax: "043-291-0002",
    representative: "代表取締役 道面 賢治",
    service_types: "訪問介護 (身体介護・生活援助)、介護予防訪問介護相当サービス",
    operating_days: "月曜日〜日曜日 (年中無休)",
    operating_hours: "8:30 - 17:30 (緊急時は時間外対応可)",
    fee_structure:
      "介護保険適用の場合は利用者負担割合 (1〜3割)。\n身体介護: 30分未満 ¥ 250、30分〜1時間 ¥ 395、1時間以上 ¥ 580 等。\n生活援助: 20分以上45分未満 ¥ 182 等。",
    payment_method: "翌月10日までに口座振替 (登録口座より引落) または銀行振込。",
    cancel_policy:
      "前日18時以降のキャンセル: 利用料の50%。\n当日キャンセル: 利用料の100%。\nただしご本人の体調急変・入院等やむを得ない場合は不要。",
    complaint_contact: "サービス提供責任者 佐藤 美咲",
    complaint_phone: "043-291-0001",
    external_complaint_contact:
      "千葉市介護保険課 (043-245-5061)\n千葉県国民健康保険団体連合会 (043-254-7411)",
    emergency_response:
      "サービス提供中の急変時は直ちに救急要請 (119) 後、主治医とご家族に連絡。\n夜間休日: 緊急連絡先 080-0000-0000。",
    privacy_handling:
      "個人情報は介護サービス提供と連携機関 (主治医・市町村・サービス担当者会議メンバー) との連絡調整のみに使用。第三者提供は本人同意なく行わない。",
  };
}

function keiyakuContent() {
  return {
    _sample_marker: SAMPLE_MARKER,
    contract_period_text:
      "契約締結日より1年間。利用者・事業者いずれからも申出が無い限り、自動的に1年間更新するものとする。",
    service_scope:
      "訪問介護計画書に基づき、ホームヘルパーが居宅を訪問して以下を提供する:\n・身体介護 (入浴、排泄、食事介助、移動介助、通院介助 等)\n・生活援助 (掃除、洗濯、調理、買物 等)\n・その他、利用者の自立した日常生活を支援するために必要なサービス",
    fee_text:
      "介護保険給付の対象となるサービスは介護保険法に定める基準額。\n利用者負担は所得に応じ1〜3割。\n介護保険給付対象外のサービスは別途規定する料金。",
    payment_terms:
      "毎月1日〜末日分を翌月10日までに、登録口座から自動引落とする。\n領収書および明細を遅滞なく交付する。",
    termination_conditions:
      "次のいずれかに該当した場合、契約を解除することができる:\n① 利用者・代理人より書面による申出があったとき\n② 利用者の入院・入所等により本サービス提供が困難となったとき\n③ 利用者・代理人が正当な理由なく利用料を3ヶ月以上滞納したとき\n④ 事業者が指定取消等を受けたとき",
    damages_clause:
      "事業者は、サービス提供にあたり利用者の生命・身体・財産に損害を生じさせた場合 (事業者の責に帰すべき事由による) は、その損害を賠償する。\n事業者は損害賠償責任保険に加入している。",
    complaint_handling:
      "苦情は事業所内の苦情受付担当者にて受付け、誠意をもって対応する。\n解決が困難な場合は、市町村・国保連合会にも相談できる。",
    confidentiality:
      "事業者およびその従業者は、業務上知り得た利用者およびその家族に関する情報を、正当な理由なく第三者に漏らさない。\n契約終了後も同様とする。",
  };
}

// 利用者ごとに少しだけ揺らぎを入れる
function jujikouContentFor(user) {
  const base = jujikouContent();
  base.privacy_handling +=
    `\n[個別補足] ${user.name} 様の主治医情報の共有について同意確認済。`;
  return base;
}
function keiyakuContentFor(user) {
  const base = keiyakuContent();
  base.service_scope += `\n[備考] ${user.name} 様: 介護度に応じて週次サービス計画を更新する。`;
  return base;
}

async function main() {
  console.log(`\n📂 fake 重要事項説明書 / 契約書 seed`);
  console.log(`🏢 office = Ｈａｎａ居宅支援センターおゆみ野 (${KYOTAKU_OFFICE_ID})`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実書込)" : "🔍 DRY RUN");
  console.log("");

  const sb = createClient(SB_URL, SB_KEY);

  // clients 解決
  const { data: clientRows, error: clientErr } = await sb
    .from("clients")
    .select("id, name, user_number")
    .eq("tenant_id", TENANT_ID)
    .in("user_number", TARGET_USER_NUMBERS);
  if (clientErr) {
    console.error("❌ clients 取得失敗:", clientErr.message);
    process.exit(1);
  }
  const clients = clientRows ?? [];
  console.log(`👥 対象利用者: ${clients.length} / ${TARGET_USER_NUMBERS.length} 名`);
  if (clients.length === 0) {
    console.log(
      "⚠️ OY001-OY010 が見つかりません。先に seed_fake_houmonkaigo_clients.mjs を実行してください。",
    );
    process.exit(1);
  }

  const userIds = clients.map((c) => c.id);

  // 既存の fake contracts を user_id + sample_marker でチェック
  // (note: notes LIKE は jsonb 内 _sample_marker と独立に判定)
  const { data: existingRows } = await sb
    .from("kaigo_user_contracts")
    .select("id, user_id, contract_type, notes")
    .in("user_id", userIds)
    .like("notes", `%${FAKE_MARKER}%`);
  const existingByKey = new Set(
    (existingRows ?? []).map((r) => `${r.user_id}__${r.contract_type}`),
  );
  console.log(`📋 既存 fake contracts: ${existingByKey.size} 件 (= skip)`);

  // 各利用者 × 2 件 (重要事項説明書 + 契約書)
  const issuedDateBase = addDays(TODAY, -30); // 1 ヶ月前に発行 (= リアルな運用想定)
  const issuedDateStr = ymd(issuedDateBase);
  const effectiveFromStr = ymd(issuedDateBase);
  const effectiveUntilStr = ymd(addYears(issuedDateBase, 1));

  // 2026-06-29: 1 値運用に統一。重要事項説明書 + 契約書 の 2 件を merge し、
  // 「契約書兼重要事項説明書」を 1 利用者 1 件 INSERT。
  const rowsToInsert = [];
  for (const c of clients) {
    if (existingByKey.has(`${c.id}__契約書兼重要事項説明書`)) continue;
    const merged = {
      ...jujikouContentFor(c),
      ...keiyakuContentFor(c),
    };
    rowsToInsert.push({
      tenant_id: TENANT_ID,
      user_id: c.id,
      office_id: KYOTAKU_OFFICE_ID,
      contract_type: "契約書兼重要事項説明書",
      business_type: "居宅介護支援",
      issued_date: issuedDateStr,
      effective_from: effectiveFromStr,
      effective_until: effectiveUntilStr,
      signed_at: issuedDateStr,
      signed_by_name: c.name,
      signed_by_relation: "本人",
      content: merged,
      attachment_url: null,
      status: "issued",
      notes: `${c.user_number} 契約書兼重要事項説明書 ${FAKE_MARKER}`,
    });
  }

  console.log(`\n📊 INSERT 予定: ${rowsToInsert.length} 件 (= 契約書兼重要事項説明書)`);

  if (rowsToInsert.length === 0) {
    console.log("✅ 既に全件 seed 済みです");
    return;
  }

  if (!EXECUTE) {
    console.log("\n🔍 DRY RUN 終了。--execute で本番実行。");
    return;
  }

  // 100 件ずつ chunked insert (= PostgREST body 制限対策)
  const CHUNK = 100;
  let inserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK);
    const { error } = await sb.from("kaigo_user_contracts").insert(chunk);
    if (error) {
      console.error(`❌ INSERT 失敗 (offset=${i}):`, error.message);
      process.exit(1);
    }
    inserted += chunk.length;
    console.log(`   ↪ ${inserted} / ${rowsToInsert.length} 件 INSERT 完了`);
  }

  // 件数確認 (silent failure 防止)
  const { count: verifyCount, error: verifyErr } = await sb
    .from("kaigo_user_contracts")
    .select("id", { count: "exact", head: true })
    .in("user_id", userIds)
    .like("notes", `%${FAKE_MARKER}%`);
  if (verifyErr) {
    console.error("⚠️ verify 失敗:", verifyErr.message);
  } else {
    console.log(`\n✅ 完了: DB 内の fake contracts 件数 = ${verifyCount}`);
  }
}

main().catch((err) => {
  console.error("❌ 想定外エラー:", err);
  process.exit(1);
});
