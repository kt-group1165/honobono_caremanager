// ============================================================================
// 初回加算等の加算を ほのぼの明細CSV を正として kaigo_visit_addon_lines へ投入。
//   源: サービス実績データ/茂原/202606/介護請求(明細付)_一覧.CSV の 種類11 加算行
//   対象: 114001(初回加算) 等 (処遇改善116184は office formula で自動計算されるため除外)
//   MEISAI稼働データは加算を明示しないため、請求の正=ほのぼの明細から取る。
//
//   node migrations/import_meisai_addon_lines.mjs            # DRY RUN
//   node migrations/import_meisai_addon_lines.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { findDataFile } from "./_meisai_files.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE=process.argv.includes("--execute");
const TENANT="kt-group", MONTH="2026-06";
const OFFICE=process.env.OFFICE_ID||"e08c3706-ad59-4913-b4e2-67f2675422e9";
const AREA_DIR=process.env.AREA_DIR||"茂原";
const TAG=process.env.TAG||"";
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
function parseLine(line){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const sjis=new TextDecoder("shift_jis");

async function main(){
  console.log(`=== 加算取込 ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  const csv=findBillingCsv(path.join(KAIGO,"サービス実績データ",AREA_DIR,"202606"));
  const lines=sjis.decode(readFileSync(csv)).split(/\r?\n/).filter(l=>l);
  const H=parseLine(lines[0]).map(h=>h.replace(/^"|"$/g,"")); const gi=(n)=>H.indexOf(n);
  const iType=gi("サービス種類コード"),iNum=gi("利用者番号"),iCode=gi("サービスコード"),iContent=gi("サービス内容"),iKaisu=gi("回数");
  // 種類11 の加算(処遇改善116184除く)を利用者×コードで集計
  const addons={}; // num -> {code -> {content,count}}
  for(const ln of lines.slice(1)){ const c=parseLine(ln).map(x=>x.replace(/^"|"$/g,""));
    if(c[iType]!=="11")continue; const code=c[iCode];
    if(code==="116184") continue;
    if(!/加算/.test(c[iContent]||"")) continue;
    const num=c[iNum]; addons[num]=addons[num]||{};
    addons[num][code]=addons[num][code]||{content:c[iContent],count:0};
    addons[num][code].count += parseInt(c[iKaisu]||"1",10);
  }
  // 利用者番号→client_id
  const clients=[]; for(let f=0;;f+=1000){const {data,error}=await sb.from("clients").select("id,user_number").range(f,f+999);if(error)throw error;clients.push(...data);if(data.length<1000)break;}
  const idByNum={}; for(const c of clients) idByNum[String(c.user_number)]=c.id;
  // TAG指定時: STEP1マッピングを overlay (ゴミ番号2147483647等の他事業所衝突を補正)
  if(TAG){ const mp=JSON.parse(readFileSync(path.join(KAIGO,`migrations/_meisai_num_to_client_${TAG}.json`),"utf8")); for(const[k,v]of Object.entries(mp)) idByNum[String(k)]=v; }

  const payloads=[];
  for(const num of Object.keys(addons)){
    const cid=idByNum[num]; if(!cid){ console.log(`  ⚠ ${num} client未登録`); continue; }
    for(const code of Object.keys(addons[num])){
      const a=addons[num][code];
      payloads.push({ tenant_id:TENANT, office_id:OFFICE, client_id:cid, target_month:MONTH, addon_code:code, count:a.count, system:"介護" });
      console.log(`  ${num} ${a.content}(${code}) count=${a.count}`);
    }
  }
  console.log(`\n投入対象: ${payloads.length}件`);
  if(!EXECUTE){ console.log("※ DRY RUN。--execute で投入(既存は upsert)。"); return; }

  // 既存の同office/月/system の取込分を消して入れ直す(冪等)。ただし116184等は元々入れてないので加算のみ対象。
  const { error }=await sb.from("kaigo_visit_addon_lines").upsert(payloads,{onConflict:"client_id,target_month,office_id,addon_code,system"});
  if(error){ console.error(`✗ 投入失敗: ${error.message}`); process.exit(1); }
  console.log(`✓ 完了: ${payloads.length}件`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});

// フォルダ構成が事業所ごとに違うので対象月配下を再帰で探す (_meisai_files.mjs)
function findBillingCsv(dir){
  const p=findDataFile(dir,"介護請求(明細付)_一覧.CSV");
  if(!p){ console.error(`✗ ${dir} 配下に 介護請求(明細付)_一覧.CSV がありません`); process.exit(1); }
  return p;
}
