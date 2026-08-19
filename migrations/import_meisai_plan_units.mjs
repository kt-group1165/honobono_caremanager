// ============================================================================
// 給付管理(計画単位数=区分支給限度基準内・自事業所分) を ほのぼの明細CSV から投入。
//   源: 介護請求(明細付)_一覧.CSV の 種類11 各明細書「計画単位数」
//   target: kaigo_monthly_plan_units (planned_units)。aggregate.ts が限度cap に使用。
//   実績 > 計画 の利用者(他事業所で限度消費)を正しく頭打ちにするために必須。
//
//   ⚠ 計画単位数は **事業所ごと** の値。1 人が複数事業所を使えば別々の値になる。
//     office_id 無しで upsert していた頃は後から取り込んだ事業所に上書きされ、
//     先に取り込んだ事業所の明細書が壊れた (齋藤祥江 K姉6,100 → 市原1,952)。
//     migrations/monthly_plan_units_office.sql を適用してから使うこと。
//
//   OFFICE_ID=<uuid> AREA_DIR=<拠点> TAG=<拠点> node migrations/import_meisai_plan_units.mjs
//   … --execute で upsert
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { findDataFile } from "./_meisai_files.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const EXECUTE=process.argv.includes("--execute");
// TARGET_MONTH=2026-07 で対象月を切替 (既定は 2026-06)。フォルダも同じ月を見る。
const TARGET_MONTH=process.env.TARGET_MONTH||"2026-06";
const YM=TARGET_MONTH.replace("-","");
const TENANT="kt-group", MONTH=`${TARGET_MONTH}-01`;
const AREA_DIR=process.env.AREA_DIR||"茂原";
const TAG=process.env.TAG||"";
const OFFICE_ID=process.env.OFFICE_ID||"";
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
function parseLine(line){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const sjis=new TextDecoder("shift_jis");

async function main(){
  console.log(`=== 計画単位数(給付管理)投入 ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  const csv=findBillingCsv(path.join(KAIGO,"サービス実績データ",AREA_DIR,YM));
  const lines=sjis.decode(readFileSync(csv)).split(/\r?\n/).filter(l=>l);
  const H=parseLine(lines[0]).map(h=>h.replace(/^"|"$/g,"")); const gi=(n)=>H.indexOf(n);
  const iMei=gi("明細書番号"),iNum=gi("利用者番号"),iType=gi("サービス種類コード"),iPlan=gi("計画単位数"),iKanri=gi("限度額管理対象単位数");
  // 種類11 (訪問介護) を正とし、**11 が無い利用者だけ総合事業 (A系) から拾う**。
  // 総合事業の 71R1 集計10 も計画単位数を出すので、A系しか無い人 (総合事業のみの利用者) は
  // ここで入れないと計画=実績になり、計画≠実績の月に不一致になる
  // (四街道 2026-06 田丸秀雄: 計画880 / 実績660)。
  // ⚠ table の一意キーは (client, month, office) で サービス種類を持たないため、
  //   11 と A系 を両方持つ人が出たら 11 を優先する (介護給付側が主)。
  const plan={}, planA={}; const seen=new Set();
  for(const ln of lines.slice(1)){ const c=parseLine(ln).map(x=>x.replace(/^"|"$/g,""));
    const type=c[iType]||"";
    const isSougou=/^A/.test(type)||/^A/.test(c[gi("サービスコード")]||"");
    if(type!=="11" && !isSougou) continue;
    if(seen.has(c[iMei]))continue; seen.add(c[iMei]);
    const v={planned:parseInt(c[iPlan]||"0",10),kanri:parseInt(c[iKanri]||"0",10)};
    if(type==="11") plan[c[iNum]]=v; else planA[c[iNum]]=v;
  }
  let fromSougou=0;
  for(const [num,v] of Object.entries(planA)){ if(plan[num])continue; plan[num]=v; fromSougou++; }
  if(fromSougou) console.log(`  総合事業のみの利用者から計画単位数を採用: ${fromSougou}名`);
  const clients=[]; for(let f=0;;f+=1000){const {data,error}=await sb.from("clients").select("id,user_number").range(f,f+999);if(error)throw error;clients.push(...data);if(data.length<1000)break;}
  const idByNum={}; for(const c of clients) idByNum[String(c.user_number)]=c.id;
  if(TAG){ const mp=JSON.parse(readFileSync(path.join(KAIGO,`migrations/_meisai_num_to_client_${TAG}.json`),"utf8")); for(const[k,v]of Object.entries(mp)) idByNum[String(k)]=v; }
  if(!OFFICE_ID){ console.error("✗ OFFICE_ID が未指定です (計画単位数は事業所ごとの値)"); process.exit(1); }
  // office_id 列が未適用なら従来どおり (client, month) で upsert して警告する
  const { error:probe }=await sb.from("kaigo_monthly_plan_units").select("office_id").limit(1);
  const hasOffice=!probe;
  if(!hasOffice) console.warn(`⚠ office_id 列が未適用 (${probe.code}) — 他事業所の値を上書きします。migrations/monthly_plan_units_office.sql を適用してください`);
  const payloads=[]; let capped=0, noClient=0;
  for(const num of Object.keys(plan)){
    const cid=idByNum[num]; if(!cid){noClient++;continue;}
    const p=plan[num];
    if(p.planned<p.kanri) capped++;
    const row={ tenant_id:TENANT, client_id:cid, target_month:MONTH, planned_units:p.planned, source:"honobono", notes:`[MEISAI計画単位数 ${TARGET_MONTH}${TAG?" "+TAG:""}]` };
    if(hasOffice) row.office_id=OFFICE_ID;
    payloads.push(row);
  }
  console.log(`投入対象: ${payloads.length}名 (client未登録skip ${noClient})`);
  console.log(`うち 計画<実績(頭打ち発生): ${capped}名`);
  if(!EXECUTE){ console.log("※ DRY RUN。--execute で upsert。"); return; }
  if(hasOffice){
    // 自事業所の当月分を入れ直す (旧 office_id NULL 行は残す = 復元不能なため)
    const { error:delErr }=await sb.from("kaigo_monthly_plan_units").delete().eq("office_id",OFFICE_ID).eq("target_month",MONTH);
    if(delErr){ console.error(`✗ 既存削除失敗: ${delErr.message}`); process.exit(1); }
  }
  const { error }=hasOffice
    ? await sb.from("kaigo_monthly_plan_units").insert(payloads)
    : await sb.from("kaigo_monthly_plan_units").upsert(payloads,{onConflict:"client_id,target_month"});
  if(error){ console.error(`✗ 投入失敗: ${error.message}`); process.exit(1); }
  console.log(`✓ 完了: ${payloads.length}名`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});

// フォルダ構成が事業所ごとに違うので対象月配下を再帰で探す (_meisai_files.mjs)
function findBillingCsv(dir){
  const p=findDataFile(dir,"介護請求(明細付)_一覧.CSV");
  if(!p){ console.error(`✗ ${dir} 配下に 介護請求(明細付)_一覧.CSV がありません`); process.exit(1); }
  return p;
}
