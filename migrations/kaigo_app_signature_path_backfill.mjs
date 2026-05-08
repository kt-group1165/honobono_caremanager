// 電子署名 v2 backfill: 既存 signature_image_url から signature_image_path を抽出して書き戻す。
//
// signed URL の format:
//   https://<project>.supabase.co/storage/v1/object/sign/signatures/<path>?token=...
// から `<path>` を抽出して signature_image_path に保存する。
//
// usage:
//   $ DRY_RUN=true  node migrations/kaigo_app_signature_path_backfill.mjs   # default (dry run、変更しない)
//   $ DRY_RUN=false node migrations/kaigo_app_signature_path_backfill.mjs   # apply
//
// 環境変数:
//   - SUPABASE_URL = NEXT_PUBLIC_SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
//
// .env.local から読みたい場合:
//   $ node --env-file=.env.local migrations/kaigo_app_signature_path_backfill.mjs

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です');
  process.exit(1);
}

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
console.log(`DRY_RUN = ${DRY_RUN}`);

const admin = createClient(URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// signed URL → bucket 内 path を抽出
// 例: https://xxx.supabase.co/storage/v1/object/sign/signatures/kt-group/kaigo_visit_records/<uuid>.png?token=...
//      → 'kt-group/kaigo_visit_records/<uuid>.png'
function extractPathFromSignedUrl(signedUrl) {
  if (!signedUrl) return null;
  try {
    const u = new URL(signedUrl);
    // pathname: /storage/v1/object/sign/signatures/<path>
    const marker = '/object/sign/signatures/';
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return null;
    const path = u.pathname.slice(idx + marker.length);
    return path ? decodeURIComponent(path) : null;
  } catch {
    return null;
  }
}

async function backfillTable(table) {
  console.log(`\n=== ${table} ===`);
  // 全件取得 (1000 行 default limit 回避のため range で paginate)
  let from = 0;
  const PAGE = 1000;
  const all = [];
  for (;;) {
    const { data, error } = await admin
      .from(table)
      .select('id, signature_image_url, signature_image_path')
      .not('signature_image_url', 'is', null)
      .is('signature_image_path', null)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`  [ERROR] fetch failed: ${error.message}`);
      return { ok: 0, fail: 0, skip: 0 };
    }
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`  対象 (url 有 / path 無): ${all.length} 件`);

  let ok = 0;
  let fail = 0;
  let skip = 0;
  for (const row of all) {
    const path = extractPathFromSignedUrl(row.signature_image_url);
    if (!path) {
      console.log(`  [SKIP] id=${row.id}: path 抽出失敗 url=${(row.signature_image_url || '').slice(0, 80)}...`);
      skip++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [DRY] id=${row.id} → path=${path}`);
      ok++;
      continue;
    }
    const { error } = await admin
      .from(table)
      .update({ signature_image_path: path })
      .eq('id', row.id);
    if (error) {
      console.log(`  [FAIL] id=${row.id}: ${error.message}`);
      fail++;
    } else {
      console.log(`  [OK]  id=${row.id} → path=${path}`);
      ok++;
    }
  }
  console.log(`  → ${DRY_RUN ? 'DRY' : 'APPLY'} ok=${ok} fail=${fail} skip=${skip}`);
  return { ok, fail, skip };
}

const v = await backfillTable('kaigo_visit_records');
const s = await backfillTable('kaigo_support_records');

console.log(
  `\nTOTAL: ${DRY_RUN ? 'DRY' : 'APPLY'} ok=${v.ok + s.ok} fail=${v.fail + s.fail} skip=${v.skip + s.skip}`
);
if (DRY_RUN) {
  console.log('DRY_RUN=true (default). 実際に書き込むには DRY_RUN=false を渡してください。');
}
