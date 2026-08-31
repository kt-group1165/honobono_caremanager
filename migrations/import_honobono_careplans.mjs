/**
 * ほのぼの PDF 出力のケアプランを kaigo-app に「データとして」取り込む バッチ移行スクリプト。
 *
 * 入力: apps/kaigo-app/ケアプランほのぼの出力/<利用者名>/_extracted.json
 *   (PDF から Claude が構造化抽出した中間ファイル。人がレビュー・補正できる)
 *   ケアプラン（１〜４）.pdf そのものは読まない。抽出済 JSON のみを読む。
 *
 * 書込先 (調査済スキーマ / 新パターン = junction + insurance_records):
 *   1. clients                      … 氏名+生年月日で突合、無ければ新規 (user_number 採番)
 *   2. client_office_assignments    … 自事業所(KT居宅)へ紐付け ← 無いと自事業所タブに出ない
 *   3. client_insurance_records     … 認定情報 (担当居宅=care_offices / ケアマネ=care_managers)
 *   4. kaigo_care_plans             … 計画メタ 1 件 (care_plan_id の器)
 *   5. kaigo_report_documents ×3    … care-plan-1 / care-plan-2 / care-plan-3 の content(jsonb)
 *
 * マスタ resolve (無ければ新規 = ユーザー指示):
 *   - offices      (自事業所, app_type='kaigo-app')  … 名前突合。無ければ ★エラー停止 (勝手に作らない)
 *   - care_offices (担当居宅マスタ)                    … 名前突合。無ければ新規作成
 *   - care_managers(ケアマネ個人)                      … 名前+care_office 突合。無ければ新規作成
 *
 * Usage:
 *   node migrations/import_honobono_careplans.mjs                 # DRY RUN (書込まない・計画表示)
 *   node migrations/import_honobono_careplans.mjs --execute       # 本番実行
 *   node migrations/import_honobono_careplans.mjs --only "相場 宗太郎"   # 対象フォルダ限定
 *   node migrations/import_honobono_careplans.mjs --force         # 既存 care-plan 帳票を上書き
 *
 * 冪等性: kaigo_report_documents.content._source_folder で取込済を検出しスキップ (--force で上書き)。
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "ケアプランほのぼの出力");
const TENANT_ID = "kt-group";

const EXECUTE = process.argv.includes("--execute");
const FORCE = process.argv.includes("--force");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

// ── env ──
function loadEnvFile(path) {
  try {
    const vars = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch { return {}; }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envKaigo.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envKaigo.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)"); process.exit(1); }

const sb = createClient(SB_URL, SB_KEY);

// ── helpers ──
const normName = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "").toLowerCase();

async function fetchAll(table, select, filters = {}) {
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).order("id").order("id").range(from, from + 999);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function nextUserNumber() {
  // clients を tenant で走査し数値 user_number の max+1 (packages/shared user-number.ts と同流儀)
  const rows = await fetchAll("clients", "user_number", { tenant_id: TENANT_ID });
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.user_number ?? "").replace(/[^0-9]/g, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

// 抽出 JSON を読む
function loadExtracted() {
  if (!existsSync(ROOT)) { console.error(`❌ フォルダが無い: ${ROOT}`); process.exit(1); }
  const out = [];
  for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    if (ONLY && dir.name !== ONLY) continue;
    const jsonPath = join(ROOT, dir.name, "_extracted.json");
    if (!existsSync(jsonPath)) { console.warn(`   ⚠️  ${dir.name}: _extracted.json が無い (未抽出) — スキップ`); continue; }
    try {
      const data = JSON.parse(readFileSync(jsonPath, "utf8"));
      out.push({ folder: dir.name, data });
    } catch (e) {
      console.warn(`   ⚠️  ${dir.name}: _extracted.json パース失敗: ${e.message} — スキップ`);
    }
  }
  return out;
}

// ── マスタ resolve ──
let _offices = null, _careOffices = null;
async function getOffices() { if (!_offices) _offices = await fetchAll("offices", "id, name, business_number, app_type, service_type", { tenant_id: TENANT_ID }); return _offices; }
async function getCareOffices() { if (!_careOffices) _careOffices = await fetchAll("care_offices", "id, name, office_number", { tenant_id: TENANT_ID }); return _careOffices; }

async function resolveSelfOffice(name) {
  const offices = await getOffices();
  const target = normName(name);
  // 居宅系のみ対象 (app_type='kaigo-app')。名前完全一致 → 前方/部分一致 の順。
  const kaigo = offices.filter((o) => (o.app_type ?? "") === "kaigo-app" || o.app_type == null);
  let hits = kaigo.filter((o) => normName(o.name) === target);
  if (hits.length === 0) hits = kaigo.filter((o) => normName(o.name).includes(target) || target.includes(normName(o.name)));
  return hits;
}

async function resolveOrPlanCareOffice(name) {
  const cos = await getCareOffices();
  const target = normName(name);
  let hit = cos.find((o) => normName(o.name) === target);
  if (!hit) hit = cos.find((o) => normName(o.name).includes(target) || target.includes(normName(o.name)));
  return hit ?? null;
}

// ── main ──
async function main() {
  console.log(`\n📂 ほのぼのケアプラン取込  (${EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN"}${FORCE ? " / FORCE" : ""})`);
  console.log(`   tenant_id = ${TENANT_ID}`);
  console.log(`   入力      = ${ROOT}`);
  if (ONLY) console.log(`   対象限定  = ${ONLY}`);
  console.log("");

  const items = loadExtracted();
  if (items.length === 0) { console.error("❌ 取込対象 (_extracted.json) がありません。"); process.exit(1); }
  console.log(`対象利用者: ${items.length} 名\n`);

  let okCount = 0, skipCount = 0, errCount = 0;

  for (const { folder, data } of items) {
    console.log(`── ${folder} ─────────────────────────────`);
    try {
      const c = data.client ?? {};
      const ins = data.insurance ?? {};

      // 1) 自事業所 (offices) resolve — 無ければ停止 (勝手に作らない)
      const selfHits = await resolveSelfOffice(data.kyotaku_office?.name ?? "");
      if (selfHits.length !== 1) {
        console.error(`   ❌ 自事業所(offices) が一意に定まりません: "${data.kyotaku_office?.name}" → ${selfHits.length} 件`);
        if (selfHits.length > 1) selfHits.forEach((o) => console.error(`        候補: ${o.name} (${o.id})`));
        else {
          const all = (await getOffices()).filter((o) => (o.app_type ?? "kaigo-app") === "kaigo-app");
          console.error(`        kaigo-app offices 一覧: ${all.map((o) => o.name).join(" / ") || "(なし)"}`);
        }
        errCount++; console.log(""); continue;
      }
      const office = selfHits[0];
      console.log(`   自事業所: ${office.name} (${office.id})`);

      // 2) 担当居宅 (care_offices) resolve or plan-create
      let careOffice = await resolveOrPlanCareOffice(data.kyotaku_office?.name ?? "");
      if (careOffice) {
        console.log(`   担当居宅(care_offices): ${careOffice.name} (${careOffice.id})`);
      } else if (EXECUTE) {
        const { data: co, error } = await sb.from("care_offices")
          .insert({ tenant_id: TENANT_ID, name: data.kyotaku_office.name, office_number: office.business_number ?? null })
          .select("id, name, office_number").single();
        if (error) throw new Error(`care_offices insert: ${error.message}`);
        careOffice = co; _careOffices.push(co);
        console.log(`   担当居宅(care_offices): ${co.name} (${co.id}) ★新規作成`);
      } else {
        console.log(`   担当居宅(care_offices): "${data.kyotaku_office?.name}" ★新規作成予定`);
      }

      // 3) ケアマネ (care_managers) resolve or plan-create
      let careManagerId = null;
      const cmName = data.care_manager ?? "";
      if (cmName) {
        const cmRows = await fetchAll("care_managers", "id, name, care_office_id, active", { tenant_id: TENANT_ID });
        const hit = cmRows.find((m) => normName(m.name) === normName(cmName));
        if (hit) { careManagerId = hit.id; console.log(`   ケアマネ(care_managers): ${hit.name} (${hit.id})`); }
        else if (EXECUTE && careOffice) {
          const { data: cm, error } = await sb.from("care_managers")
            .insert({ tenant_id: TENANT_ID, care_office_id: careOffice.id, name: cmName, active: true })
            .select("id").single();
          if (error) throw new Error(`care_managers insert: ${error.message}`);
          careManagerId = cm.id; console.log(`   ケアマネ(care_managers): ${cmName} (${cm.id}) ★新規作成`);
        } else {
          console.log(`   ケアマネ(care_managers): "${cmName}" ★新規作成予定`);
        }
      }

      // 4) clients match-or-create (氏名 + 生年月日)
      let clientId = null;
      {
        const rows = await fetchAll("clients", "id, name, birth_date, gender, furigana, insured_number, insurer_number, is_facility", { tenant_id: TENANT_ID });
        const hit = rows.find((r) => !r.is_facility && normName(r.name) === normName(c.name) && (r.birth_date ?? "") === (c.birth_date ?? ""));
        if (hit) {
          clientId = hit.id;
          console.log(`   利用者(clients): 既存マッチ ${hit.name} (${hit.id})  性別=${hit.gender ?? "?"} 被保番=${hit.insured_number ?? "(空)"}`);
          // 認定に使う被保番/保険者番号は既存 clients から補完
          if (!ins.insured_number && hit.insured_number) ins.insured_number = hit.insured_number;
          if (!ins.insurer_number && hit.insurer_number) ins.insurer_number = hit.insurer_number;
        } else if (EXECUTE) {
          const userNumber = await nextUserNumber();
          const payload = {
            tenant_id: TENANT_ID, user_number: userNumber,
            name: c.name, furigana: c.furigana || c.name,
            birth_date: c.birth_date, gender: c.gender || "男",
            address: c.address ?? null, phone: c.phone ?? null,
            emergency_contact_name: c.emergency_contact_name ?? null,
            emergency_contact_phone: c.emergency_contact_phone ?? null,
            status: "active", is_facility: false, is_provisional: false,
          };
          const { data: nc, error } = await sb.from("clients").insert(payload).select("id").single();
          if (error) throw new Error(`clients insert: ${error.message}`);
          clientId = nc.id;
          console.log(`   利用者(clients): ★新規作成 ${c.name} (${nc.id}) user_number=${userNumber}`);
        } else {
          const userNumber = await nextUserNumber();
          console.log(`   利用者(clients): ★新規作成予定 ${c.name} (user_number≈${userNumber}, 生年月日=${c.birth_date}, 性別=${c.gender || "男(推定)"})`);
        }
      }

      // 5) client_office_assignments (自事業所紐付け) — 無ければ作成
      if (clientId) {
        const asg = await fetchAll("client_office_assignments", "id, office_id, end_date", { client_id: clientId });
        const active = asg.find((a) => a.office_id === office.id && !a.end_date);
        if (active) console.log(`   自事業所紐付け: 既存あり`);
        else if (EXECUTE) {
          const today = new Date().toISOString().slice(0, 10);
          const { error } = await sb.from("client_office_assignments")
            .insert({ tenant_id: TENANT_ID, client_id: clientId, office_id: office.id, start_date: today });
          if (error) throw new Error(`client_office_assignments insert: ${error.message}`);
          console.log(`   自事業所紐付け: ★作成`);
        } else console.log(`   自事業所紐付け: ★作成予定`);
      } else {
        console.log(`   自事業所紐付け: (利用者新規のため execute 時に作成)`);
      }

      // 6) client_insurance_records (認定) — cert_start 一致が無ければ作成
      // certificationId は帳票 (kaigo_report_documents) に必ず付与する。
      // reports 画面の一覧は認定 (certification_id) で絞るため、NULL だと一覧に出ず
      // 空帳票が自動生成される (2026-07-14 相場さんで発覚した事故)。
      let certificationId = null;
      if (clientId) {
        const recs = await fetchAll("client_insurance_records", "id, certification_start_date", { client_id: clientId });
        const dup = recs.find((r) => (r.certification_start_date ?? "") === (ins.certification_start_date ?? ""));
        if (dup) {
          certificationId = dup.id;
          console.log(`   認定(client_insurance_records): 既存あり (${ins.certification_start_date})`);
        }
        else if (EXECUTE) {
          const payload = {
            tenant_id: TENANT_ID, client_id: clientId,
            care_level: ins.care_level ?? null,
            certification_status: ins.certification_status ?? null,
            certification_date: ins.certification_date ?? null,
            certification_start_date: ins.certification_start_date ?? null,
            certification_end_date: ins.certification_end_date ?? null,
            insurer_number: ins.insurer_number ?? null,
            insurer_name: ins.insurer_name ?? null,
            insured_number: ins.insured_number ?? null,
            service_limit_amount: ins.service_limit_amount ?? null,
            care_office_id: careOffice?.id ?? null,
            care_manager_id: careManagerId,
            care_manager: cmName || null,
          };
          const { data: newCert, error } = await sb.from("client_insurance_records").insert(payload).select("id").single();
          if (error) throw new Error(`client_insurance_records insert: ${error.message}`);
          certificationId = newCert.id;
          // clients 認定キャッシュ列を同期 (一覧・各画面の表示用。正本は client_insurance_records)
          const { error: cuErr } = await sb.from("clients").update({
            care_level: ins.care_level ?? null,
            insured_number: ins.insured_number ?? null,
            insurer_number: ins.insurer_number ?? null,
            certification_start_date: ins.certification_start_date ?? null,
            certification_end_date: ins.certification_end_date ?? null,
            care_office_id: careOffice?.id ?? null,
            care_manager_id: careManagerId,
            care_manager: cmName || null,
          }).eq("id", clientId);
          if (cuErr) console.warn(`   ⚠️  clients 認定キャッシュ同期: ${cuErr.message}`);
          console.log(`   認定(client_insurance_records): ★作成 (${ins.care_level} / ${ins.certification_start_date}〜${ins.certification_end_date})`);
        } else {
          console.log(`   認定(client_insurance_records): ★作成予定 (${ins.care_level} / ${ins.certification_start_date}〜${ins.certification_end_date} / 被保番=${ins.insured_number ?? "(空・要補完)"})`);
        }
      } else {
        console.log(`   認定(client_insurance_records): (利用者新規のため execute 時に作成)`);
      }

      // 7) kaigo_care_plans (メタ器) + 8) kaigo_report_documents ×3
      const plans = [
        ["care-plan-1", "第1表 居宅サービス計画書(1)", data.care_plan_1],
        ["care-plan-2", "第2表 居宅サービス計画書(2)", data.care_plan_2],
        ["care-plan-3", "第3表 週間サービス計画表", data.care_plan_3],
      ].filter(([, , content]) => content && Object.keys(content).length > 0);

      if (clientId) {
        // 既取込チェック (content._source_folder)
        const existDocs = await fetchAll("kaigo_report_documents", "id, report_type, care_plan_id, content", { user_id: clientId });
        const alreadyByType = new Map();
        let reusePlanId = null;
        for (const d of existDocs) {
          const src = d.content && typeof d.content === "object" ? d.content._source_folder : null;
          if (src === folder) { alreadyByType.set(d.report_type, d.id); if (d.care_plan_id) reusePlanId = d.care_plan_id; }
        }

        if (alreadyByType.size > 0 && !FORCE) {
          console.log(`   ケアプラン帳票: 既取込あり (${[...alreadyByType.keys()].join(", ")}) — スキップ (--force で上書き)`);
          skipCount++; console.log(""); continue;
        }

        if (EXECUTE) {
          // care_plan メタ
          const longGoals = (data.care_plan_2?.blocks ?? []).map((b) => b.long_term_goal).filter(Boolean).join("／");
          const shortGoals = (data.care_plan_2?.blocks ?? []).flatMap((b) => (b.goals ?? []).map((g) => g.short_term_goal)).filter(Boolean).join("／");
          let plan;
          if (reusePlanId) {
            // --force 再取込: 既存の care_plan を再利用 (二重作成しない)
            await sb.from("kaigo_care_plans").update({
              start_date: "2026-02-01", end_date: "2027-01-31",
              long_term_goals: longGoals || null, short_term_goals: shortGoals || null,
            }).eq("id", reusePlanId);
            plan = { id: reusePlanId };
          } else {
            const existPlans = await fetchAll("kaigo_care_plans", "plan_number", { user_id: clientId });
            const nextPlanNo = existPlans.reduce((m, p) => Math.max(m, Number(p.plan_number) || 0), 0) + 1;
            const { data: np, error: pErr } = await sb.from("kaigo_care_plans").insert({
              user_id: clientId, plan_number: nextPlanNo, plan_type: "居宅サービス計画",
              start_date: "2026-02-01", end_date: "2027-01-31",
              long_term_goals: longGoals || null, short_term_goals: shortGoals || null,
              status: "active", tenant_id: TENANT_ID,
            }).select("id").single();
            if (pErr) throw new Error(`kaigo_care_plans insert: ${pErr.message}`);
            plan = np;
          }

          for (const [rtype, title, content] of plans) {
            const merged = { ...content, _source: "honobono-pdf", _source_folder: folder };
            // 第2表: emergency-sheets が読むフラット services[] を blocks から生成 (parseCarePlan2 と同形)
            if (rtype === "care-plan-2") {
              merged.services = (content.blocks ?? [])
                .flatMap((b) => (b.goals ?? []).flatMap((g) => g.services ?? []))
                .filter((s) => s && s.content);
            }
            const payload = {
              user_id: clientId, report_type: rtype, title, report_month: null,
              care_plan_id: plan.id, certification_id: certificationId, status: "draft", tenant_id: TENANT_ID,
              content: merged,
            };
            const existingId = alreadyByType.get(rtype);
            if (existingId && FORCE) {
              const { error } = await sb.from("kaigo_report_documents").update({ content: payload.content, title, care_plan_id: plan.id, certification_id: certificationId }).eq("id", existingId);
              if (error) throw new Error(`report_documents update ${rtype}: ${error.message}`);
            } else {
              const { error } = await sb.from("kaigo_report_documents").insert(payload);
              if (error) throw new Error(`report_documents insert ${rtype}: ${error.message}`);
            }
          }
          console.log(`   ケアプラン帳票: ★${FORCE && alreadyByType.size ? "上書き" : "作成"} (${plans.map((p) => p[0]).join(", ")})`);
        } else {
          console.log(`   ケアプラン帳票: ★作成予定 (${plans.map((p) => p[0]).join(", ")})`);
          for (const [rtype, , content] of plans) {
            if (rtype === "care-plan-2") console.log(`        第2表: ニーズ ${content.blocks?.length ?? 0} 件 / サービス ${(content.blocks ?? []).flatMap((b) => (b.goals ?? []).flatMap((g) => g.services ?? [])).length} 件`);
            if (rtype === "care-plan-3" && content._needs_review) console.log(`        第3表: ⚠️ 週間グリッド配置は要確認 (_needs_review)`);
          }
        }
      } else {
        console.log(`   ケアプラン帳票: ★作成予定 (${plans.map((p) => p[0]).join(", ")}) (利用者新規のため execute 時)`);
      }

      okCount++;
    } catch (e) {
      console.error(`   ❌ ${folder}: ${e.message}`);
      errCount++;
    }
    console.log("");
  }

  console.log(`═══════════════════════════════════════════`);
  console.log(`  処理OK ${okCount} / スキップ ${skipCount} / エラー ${errCount}`);
  if (!EXECUTE) console.log(`\n✅ DRY RUN 完了。問題なければ --execute で本番反映。`);
  else console.log(`\n✅ EXECUTE 完了。`);
}

main().catch((e) => { console.error(e); process.exit(1); });
