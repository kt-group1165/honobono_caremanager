/**
 * 訪問介護 手順書 動作確認用 サンプル多件 INSERT
 *
 * 実行: cd apps/kaigo-app && node migrations/_insert_sample_multi.mjs
 *
 * 既存「溝渕 幸子 v1」(短期目標更新の為) は保持しつつ、追加で:
 *  - 溝渕 幸子 v2 (初回相談)
 *  - 田中 太郎 v1 (入浴介助追加)
 *  - 田中 太郎 v2 (初回)
 *  - 佐藤 花子 v1 (区分変更)
 *
 * 重複チェック: client_name + plan_start_date 既存なら skip
 */

import { readFileSync } from "fs";
const env = readFileSync('../calendar-app/.env.local', 'utf8').split('\n').reduce((a,l) => { const m = l.match(/^([^=]+)=(.+)$/); if (m) a[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); return a; }, {});
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const TENANT = 'kt-group';
const OFFICE_ID = '4f14d50c-76b5-4f44-ac41-ed6d01f53a30'; // Hanaヘルパーステーションおゆみ野

const SAMPLES = [
  // 溝渕 幸子 v2 (古い、初回)
  {
    client_name: '溝渕 幸子',
    plan_start_date: '2025-10-01',
    plan_end_date: '2026-03-31',
    author_name: '斉藤悠希弥',
    creation_reason: '初回相談',
    special_notes: '初回サービス、本人ペースを優先しゆっくり馴染んで頂く',
    weekly_schedule: {
      mon: { '1': { time_range: '8:50-9:20', service_kind: '身体1' } },
      tue: {}, wed: {},
      thu: { '1': { time_range: '8:50-9:20', service_kind: '身体1' } },
      fri: {}, sat: {}, sun: {},
    },
    services: [
      { service_no: 1, time_range: '8:50-9:20', service_kind: '身体1', special_notes: '初回数回は同行訪問',
        steps: [
          { content: '訪問・手洗・挨拶', minutes: 5, detail: '訪問。手洗い、うがいを済ませ、ご本人様に挨拶。体調を確認する。' },
          { content: '服薬確認', minutes: 5, detail: '朝食後薬の飲み忘れ確認。' },
          { content: '通所(送り出し)', minutes: 15, detail: '通所準備、玄関口まで歩行見守り、通所スタッフへ引き継ぎ。' },
          { content: '記録', minutes: 5, detail: 'サービス終了時に記録票を記載。' },
        ]
      },
    ],
  },
  // 田中 太郎 v1 (新しい、入浴介助追加)
  {
    client_name: '田中 太郎',
    plan_start_date: '2026-01-01',
    plan_end_date: '2026-12-31',
    author_name: '山田 美咲',
    creation_reason: '入浴介助追加',
    special_notes: '入浴後の血圧確認を必ず実施',
    weekly_schedule: {
      mon: { '1': { time_range: '10:00-11:30', service_kind: '身体2' } },
      tue: {},
      wed: { '1': { time_range: '10:00-11:30', service_kind: '身体2' } },
      thu: {}, fri: { '1': { time_range: '10:00-11:30', service_kind: '身体2' } },
      sat: {}, sun: {},
    },
    services: [
      { service_no: 1, time_range: '10:00-11:30', service_kind: '身体2', special_notes: '入浴時は転倒に注意',
        steps: [
          { content: '訪問・手洗・挨拶', minutes: 5, detail: '訪問。手洗い、うがいを済ませ、ご本人様に挨拶。体調・血圧を確認する。' },
          { content: '入浴準備', minutes: 10, detail: '浴室の温度確認、着替え準備、シャワーチェア設置。' },
          { content: '入浴介助', minutes: 30, detail: '洗体・洗髪を介助。本人の希望する湯温で。\n適宜休憩を取り、入浴後の状態確認を行う。' },
          { content: '更衣・整容', minutes: 15, detail: '清拭、着替え介助、ドライヤー。' },
          { content: '水分補給・血圧測定', minutes: 10, detail: 'お茶を提供、血圧を測定し記録。' },
          { content: '片付け・記録', minutes: 10, detail: '浴室片付け、サービス記録票を記載。' },
        ]
      },
    ],
  },
  // 田中 太郎 v2 (古い、初回)
  {
    client_name: '田中 太郎',
    plan_start_date: '2025-04-01',
    plan_end_date: '2025-12-31',
    author_name: '山田 美咲',
    creation_reason: '初回',
    special_notes: null,
    weekly_schedule: {
      mon: { '1': { time_range: '10:00-11:00', service_kind: '身体1' } },
      tue: {}, wed: {},
      thu: { '1': { time_range: '10:00-11:00', service_kind: '身体1' } },
      fri: {}, sat: {}, sun: {},
    },
    services: [
      { service_no: 1, time_range: '10:00-11:00', service_kind: '身体1', special_notes: null,
        steps: [
          { content: '訪問・手洗・挨拶', minutes: 5, detail: '訪問。手洗い、うがいを済ませ、ご本人様に挨拶。' },
          { content: '清拭', minutes: 30, detail: '全身清拭。陰部洗浄含む。' },
          { content: '着替え', minutes: 15, detail: '着替え介助。' },
          { content: '記録', minutes: 10, detail: 'サービス記録票を記載。' },
        ]
      },
    ],
  },
  // 佐藤 花子 v1 (区分変更)
  {
    client_name: '佐藤 花子',
    plan_start_date: '2026-06-01',
    plan_end_date: '2027-05-31',
    author_name: '鈴木 健太',
    creation_reason: '区分変更（要介護2→要介護3）',
    special_notes: '要介護度上がったため、通所利用日に加え訪問日数を増加',
    weekly_schedule: {
      mon: { '1': { time_range: '9:00-9:45', service_kind: '身体1生活1' } },
      tue: { '1': { time_range: '15:00-16:00', service_kind: '生活2' } },
      wed: { '1': { time_range: '9:00-9:45', service_kind: '身体1生活1' } },
      thu: { '1': { time_range: '15:00-16:00', service_kind: '生活2' } },
      fri: { '1': { time_range: '9:00-9:45', service_kind: '身体1生活1' } },
      sat: {}, sun: {},
    },
    services: [
      { service_no: 1, time_range: '9:00-9:45', service_kind: '身体1生活1', special_notes: '月水金は朝の身体介護+生活',
        steps: [
          { content: '訪問・手洗・挨拶', minutes: 5, detail: '訪問。手洗い、うがいを済ませ、ご本人様に挨拶。体調を確認する。' },
          { content: '排泄介助', minutes: 10, detail: 'トイレ誘導、後始末、手洗い介助。' },
          { content: '朝食準備', minutes: 15, detail: '朝食を温めて配膳、お茶を準備。' },
          { content: '服薬確認', minutes: 5, detail: '朝食後薬を確認、飲み忘れがあればその場で服薬。' },
          { content: '片付け・記録', minutes: 10, detail: '食器片付け、記録票を記載。' },
        ]
      },
      { service_no: 2, time_range: '15:00-16:00', service_kind: '生活2', special_notes: '火木は生活援助のみ',
        steps: [
          { content: '訪問・手洗・挨拶', minutes: 5, detail: '訪問。手洗い、うがいを済ませ、ご本人様に挨拶。' },
          { content: '掃除', minutes: 30, detail: 'リビング・廊下・トイレの掃除。\n床は掃除機+水拭き、トイレは便座・便器を中心に。' },
          { content: '洗濯', minutes: 15, detail: '洗濯物を洗濯機にかけ、終了後干す。' },
          { content: '記録', minutes: 10, detail: 'サービス記録票を記載。' },
        ]
      },
    ],
  },
];

// 既存重複 check
const { data: existing } = await sb
  .from('kaigo_visit_procedure_documents')
  .select('client_name, plan_start_date')
  .eq('tenant_id', TENANT);
const existingSet = new Set((existing ?? []).map(r => `${r.client_name}|${r.plan_start_date}`));

let totalDocs = 0, totalSvcs = 0, totalSteps = 0, skipped = 0;
for (const s of SAMPLES) {
  const key = `${s.client_name}|${s.plan_start_date}`;
  if (existingSet.has(key)) {
    console.log(`  - skip (既存): ${key}`);
    skipped++;
    continue;
  }
  const { data: doc, error: docErr } = await sb
    .from('kaigo_visit_procedure_documents')
    .insert({
      tenant_id: TENANT,
      office_id: OFFICE_ID,
      client_name: s.client_name,
      plan_start_date: s.plan_start_date,
      plan_end_date: s.plan_end_date,
      author_name: s.author_name,
      creation_reason: s.creation_reason,
      special_notes: s.special_notes,
      weekly_schedule: s.weekly_schedule,
    })
    .select('id')
    .single();
  if (docErr) { console.error(`  ✗ ${key}:`, docErr.message); continue; }
  totalDocs++;
  console.log(`  ✓ ${s.client_name} (${s.plan_start_date} 〜 ${s.plan_end_date}) [${s.creation_reason}]`);
  for (const svc of s.services) {
    const { data: svcRow, error: svcErr } = await sb
      .from('kaigo_visit_procedure_services')
      .insert({
        document_id: doc.id,
        service_no: svc.service_no,
        time_range: svc.time_range,
        service_kind: svc.service_kind,
        special_notes: svc.special_notes,
      })
      .select('id')
      .single();
    if (svcErr) { console.error(`    ✗ svc${svc.service_no}:`, svcErr.message); continue; }
    totalSvcs++;
    const stepRows = svc.steps.map((st, i) => ({
      service_id: svcRow.id,
      step_no: i + 1,
      content: st.content,
      minutes: st.minutes,
      detail: st.detail,
    }));
    const { error: stepErr } = await sb.from('kaigo_visit_procedure_steps').insert(stepRows);
    if (stepErr) { console.error(`    ✗ steps:`, stepErr.message); continue; }
    totalSteps += stepRows.length;
  }
}

console.log(`\n✅ 完了 — docs=${totalDocs} svcs=${totalSvcs} steps=${totalSteps} (skipped=${skipped})`);
