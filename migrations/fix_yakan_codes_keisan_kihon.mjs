// ============================================================================
// 夜間サービスコードの calculation_type を '加算' → '基本' に修正。
//   問題: 111112(身1夜)/111212(身2夜)/111412(身4夜)/117212(生2夜) がマスタで
//         calc='加算'。aggregate.ts の基本サービス解決は calc='基本' のみ引くため
//         夜間が0単位になり請求から欠落する (時間帯からの夜間計算も無い)。
//   対応: これらは所定単位に夜間25%を織込んだ合成の"基本相当"サービス(ほのぼの準拠)。
//         calc='基本' に変えるとアプリが基本として解決し、処遇改善/限度の基礎にも入る。
//   共有マスタ変更 (全事業所の夜間請求に効く=夜間を正しく請求できるようになる)。
//   変更前は _backup_yakan_calc_YYYYMMDD.json に保存 (可逆)。
//
//   node migrations/fix_yakan_codes_keisan_kihon.mjs            # DRY RUN
//   node migrations/fix_yakan_codes_keisan_kihon.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const EXECUTE=process.argv.includes("--execute");
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const CODES=["111112","111212","111412","117212"];

async function main(){
  console.log(`=== 夜間コード calc='加算'→'基本' ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  const { data:rows, error }=await sb.from("kaigo_service_codes")
    .select("id,service_code,service_name,units,calculation_type,valid_from,valid_until")
    .in("service_code",CODES).eq("system","介護");
  if(error) throw new Error(error.message);
  const targets=rows.filter(r=>r.calculation_type==="加算");
  console.log(`対象 ${CODES.length}コード / 全世代${rows.length}行 / うち calc='加算' ${targets.length}行:`);
  for(const r of targets) console.log(`  ${r.service_code} [${r.service_name}] ${r.units}単位 ${r.calculation_type} valid=${r.valid_from}~${r.valid_until||"null"}`);

  if(!EXECUTE){ console.log("\n※ DRY RUN。--execute で '基本' に更新。"); return; }

  // 変更前をバックアップ保存
  writeFileSync(path.join(KAIGO,"migrations/_backup_yakan_calc_20260716.json"), JSON.stringify(targets,null,1));
  let ok=0;
  for(const r of targets){
    const { error:uErr }=await sb.from("kaigo_service_codes").update({calculation_type:"基本"}).eq("id",r.id);
    if(uErr){ console.error(`✗ ${r.service_code} 更新失敗: ${uErr.message}`); process.exit(1); }
    ok++;
  }
  console.log(`✓ 完了: ${ok}行を '基本' に更新 (backup: _backup_yakan_calc_20260716.json)`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});
