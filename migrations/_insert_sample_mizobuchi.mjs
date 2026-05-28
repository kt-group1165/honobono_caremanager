import { readFileSync } from "fs";
const env = readFileSync('../calendar-app/.env.local', 'utf8').split('\n').reduce((a,l) => { const m = l.match(/^([^=]+)=(.+)$/); if (m) a[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); return a; }, {});
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Excel "③計画書" "④手順" から抽出した サンプル data (溝渕 幸子)
const TENANT = 'kt-group';
const OFFICE_ID = '4f14d50c-76b5-4f44-ac41-ed6d01f53a30'; // Hanaヘルパーステーションおゆみ野 (Excel: Hanaヘルパーステーション中央 ≒ おゆみ野中央 由来)

const weekly = {
  mon: { '1': { time_range: '8:50-9:20', service_kind: '身体1' } },
  tue: {},
  wed: {},
  thu: {
    '1': { time_range: '8:50-9:20', service_kind: '身体1' },
    '2': { time_range: '16:30-17:00', service_kind: '身体1' },
  },
  fri: {},
  sat: {},
  sun: {},
};

const { data: doc, error: docErr } = await sb
  .from('kaigo_visit_procedure_documents')
  .insert({
    tenant_id: TENANT,
    office_id: OFFICE_ID,
    client_name: '溝渕 幸子',
    plan_start_date: '2026-04-01',
    plan_end_date: '2027-03-31',
    author_name: '斉藤悠希弥',
    creation_reason: '短期目標更新の為',
    special_notes: 'ご本人様希望・他職種（医療）の提供時間により、サービス提供時間 変動あり。',
    weekly_schedule: weekly,
  })
  .select('id')
  .single();
if (docErr) { console.error('docErr:', docErr); process.exit(1); }
const docId = doc.id;
console.log('✓ document inserted:', docId);

// サービス① 8:50-9:20 身体1
const { data: s1, error: s1Err } = await sb.from('kaigo_visit_procedure_services').insert({
  document_id: docId, service_no: 1,
  time_range: '8:50-9:20', service_kind: '身体1',
  special_notes: 'ご本人様希望・他職種（医療）の提供時間により、サービス提供時間 変動あり',
}).select('id').single();
if (s1Err) { console.error('s1Err:', s1Err); process.exit(1); }

const s1Steps = [
  { step_no: 1, content: '訪問・手洗・挨拶', minutes: 5, detail: '訪問。手洗い、うがいを済ませ、ご本人様に挨拶。体調を確認する。' },
  { step_no: 2, content: '服薬確認',         minutes: 5, detail: '朝食後薬の飲み忘れが無いか確認する。飲み忘れがあった場合はその場で服薬して頂く。' },
  { step_no: 3, content: '通所(送り出し)',   minutes: 15, detail: '通所の準備、荷物確認。\nご本人のペースに合わせ、玄関口まで歩行の見守り、通所スタッフへ引き継ぎ、送り出しを行う。' },
  { step_no: 4, content: '記録',             minutes: 5, detail: 'サービス終了時に記録票を記載する。' },
].map(st => ({ ...st, service_id: s1.id }));
const { error: s1stepErr } = await sb.from('kaigo_visit_procedure_steps').insert(s1Steps);
if (s1stepErr) { console.error('s1stepErr:', s1stepErr); process.exit(1); }
console.log('✓ service 1 with', s1Steps.length, 'steps');

// サービス② 16:30-17:00 身体1
const { data: s2, error: s2Err } = await sb.from('kaigo_visit_procedure_services').insert({
  document_id: docId, service_no: 2,
  time_range: '16:30-17:00', service_kind: '身体1',
  special_notes: 'ご本人様希望・他職種（医療）の提供時間により、サービス提供時間 変動あり',
}).select('id').single();
if (s2Err) { console.error('s2Err:', s2Err); process.exit(1); }

const s2Steps = [
  { step_no: 1, content: '訪問・手洗・挨拶', minutes: 5, detail: '訪問。手洗い、うがいを済ませ、ご本人様に挨拶。体調を確認する。' },
  { step_no: 2, content: '通所(迎え入れ)',   minutes: 15, detail: '通所荷物の片づけ。\n通所スタッフから引き継ぎ、ご本人のペースに合わせ、居室まで歩行の見守り、迎え入れを行う。' },
  { step_no: 3, content: '共に行う家事',     minutes: 5, detail: 'ご本人様と一緒に可燃ゴミをまとめる。' },
  { step_no: 4, content: '記録',             minutes: 5, detail: 'サービス終了時に記録票を記載する。' },
].map(st => ({ ...st, service_id: s2.id }));
const { error: s2stepErr } = await sb.from('kaigo_visit_procedure_steps').insert(s2Steps);
if (s2stepErr) { console.error('s2stepErr:', s2stepErr); process.exit(1); }
console.log('✓ service 2 with', s2Steps.length, 'steps');

console.log('\n✅ sample inserted. doc_id =', docId);
console.log('   /visit-procedures で「溝渕 幸子」が見えるはず');
