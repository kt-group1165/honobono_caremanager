// ============================================================================
// 担当ケアマネ事業所番号を明細CSVから解決し client_insurance_records.care_office_id を設定。
//   源①(番号): 介護請求(明細付)_一覧.CSV の「居宅サービス計画事業所番号/名称」
//   源②(照合): 利用者データ/茂原/介護保険1.CSV の「支援事業所（正式名称）」
//   care_offices を office_number で解決 (無ければ番号+名称で作成)。
//   → aggregate.ts が伝送7131にケアマネ番号を載せ、「担当居宅未登録」警告が消える。
//
//   node migrations/link_caremanager_office.mjs            # DRY RUN
//   node migrations/link_caremanager_office.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { findDataFile } from "./_meisai_files.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const EXECUTE=process.argv.includes("--execute");
const TENANT="kt-group";
const AREA_DIR=process.env.AREA_DIR||"茂原";
const USER_SUB=process.env.USER_SUB||"茂原";
const TAG=process.env.TAG||"";
const STEP1_MARK=`[MEISAI-STEP1 2026-06${TAG?" "+TAG:""}]`;
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
function parseLine(line){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const sjis=new TextDecoder("shift_jis");
function readCsv(p){ const lines=sjis.decode(readFileSync(p)).split(/\r?\n/).filter(l=>l); const H=parseLine(lines[0]).map(h=>h.replace(/^"|"$/g,"")); return {H,rows:lines.slice(1).map(l=>parseLine(l).map(x=>x.replace(/^"|"$/g,"")))}; }
const norm=(s)=>(s||"").normalize("NFKC").replace(/[\s　＊*]/g,"");

async function main(){
  console.log(`=== ケアマネ番号リンク ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  // ① 明細CSV: 利用者番号→ケアマネ番号/名称
  const mei=readCsv(findBillingCsv(path.join(KAIGO,"サービス実績データ",AREA_DIR,"202606")));
  const gm=(n)=>mei.H.indexOf(n);
  const iNum=gm("利用者番号"),iCoNum=gm("居宅サービス計画事業所番号"),iCoName=gm("居宅サービス計画事業所名称");
  const byNum={};
  for(const r of mei.rows){ const n=r[iNum]; if(!byNum[n]) byNum[n]={num:(r[iCoNum]||"").trim(),name:(r[iCoName]||"").trim()}; }
  // ② 介護保険1.CSV: 利用者番号→支援事業所正式名称 (照合用)
  const ins=readCsv(path.join(KAIGO,`利用者データ/${USER_SUB}/介護保険1.CSV`));
  const gi=(n)=>ins.H.indexOf(n);
  const iiNum=gi("利用者番号"),iiName=gi("支援事業所（正式名称）");
  const insName={}; for(const r of ins.rows){ insName[r[iiNum]]=(r[iiName]||"").trim(); }

  // care_offices 既存 (office_number→id)
  const co=[]; for(let x=0;;x+=1000){const {data,error}=await sb.from("care_offices").select("id,office_number,name").range(x,x+999);if(error)throw error;co.push(...data);if(data.length<1000)break;}
  const coByNum=new Map(); for(const c of co) if(c.office_number) coByNum.set(String(c.office_number),c);
  // clients & 該当insurance
  const clients=[]; for(let x=0;;x+=1000){const {data,error}=await sb.from("clients").select("id,user_number").range(x,x+999);if(error)throw error;clients.push(...data);if(data.length<1000)break;}
  const idByNum={}; for(const c of clients) idByNum[String(c.user_number)]=c.id;
  if(TAG){ const mp=JSON.parse(readFileSync(path.join(KAIGO,`migrations/_meisai_num_to_client_${TAG}.json`),"utf8")); for(const[k,v]of Object.entries(mp)) idByNum[String(k)]=v; }

  const toCreate=new Map(); // office_number -> name (新規care_office)
  const setLinks=[]; const mismatches=[]; let noPlan=0;
  for(const num of Object.keys(byNum)){
    const cid=idByNum[num]; if(!cid) continue;
    const co=byNum[num];
    if(!co.num){ noPlan++; continue; } // 本人作成等でケアマネ番号なし
    // 照合: 明細名称 vs 保険名称
    const iN=insName[num];
    if(iN && norm(iN)!==norm(co.name)) mismatches.push(`${num}: 明細[${co.name}] ≠ 保険[${iN}]`);
    if(!coByNum.has(co.num)) toCreate.set(co.num, co.name);
    setLinks.push({num,cid,officeNum:co.num});
  }
  console.log(`ケアマネ番号あり利用者: ${setLinks.length} / 番号なし(本人作成等): ${noPlan}`);
  console.log(`care_offices 新規作成予定: ${toCreate.size}件`);
  for(const [n,nm] of toCreate) console.log(`   + ${n} ${nm}`);
  console.log(`\n名称クロスチェック 不一致: ${mismatches.length}件`);
  mismatches.slice(0,15).forEach(m=>console.log(`   ⚠ ${m}`));

  if(!EXECUTE){ console.log("\n※ DRY RUN。--execute で care_offices作成+care_office_id設定。"); return; }
  // care_offices 作成。名前(tenant_id,name) unique 衝突時は同名別番号の別事業所なので
  // 名前に番号を付けて別レコードとして作成する (伝送には明細の事業所番号が要るため既存流用は不可)。
  for(const [n,nm] of toCreate){
    const baseName=nm||`ケアマネ事業所${n}`;
    let {data,error}=await sb.from("care_offices").insert({tenant_id:TENANT,office_number:n,name:baseName}).select("id,office_number").single();
    if(error && /duplicate key|unique/i.test(error.message)){
      const alt=`${baseName} (${n})`;
      console.warn(`  ⚠ 同名別番号 care_office 衝突 → "${alt}" で作成: ${n}`);
      ({data,error}=await sb.from("care_offices").insert({tenant_id:TENANT,office_number:n,name:alt}).select("id,office_number").single());
    }
    if(error){ console.error(`✗ care_office作成 ${n}: ${error.message}`); process.exit(1); }
    coByNum.set(String(data.office_number),data);
  }
  // client_insurance_records.care_office_id を設定 (当該事業所の STEP1マーカー分)
  let ok=0;
  for(const l of setLinks){
    const co=coByNum.get(l.officeNum); if(!co) continue;
    const {error,count}=await sb.from("client_insurance_records").update({care_office_id:co.id},{count:"exact"}).eq("client_id",l.cid).eq("notes",STEP1_MARK);
    if(error){ console.error(`✗ link ${l.num}: ${error.message}`); process.exit(1); }
    if(count>0) ok++;
  }
  console.log(`✓ 完了: care_office新規${toCreate.size} / care_office_id設定 ${ok}名`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});

// フォルダ構成が事業所ごとに違うので対象月配下を再帰で探す (_meisai_files.mjs)
function findBillingCsv(dir){
  const p=findDataFile(dir,"介護請求(明細付)_一覧.CSV");
  if(!p){ console.error(`✗ ${dir} 配下に 介護請求(明細付)_一覧.CSV がありません`); process.exit(1); }
  return p;
}
