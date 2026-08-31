// ============================================================================
// 公費(生活保護 法別12等)を ほのぼの明細CSV から client_kohi_records へ取込。
//   源: 介護請求(明細付)_一覧.CSV の 公費1負担者番号/受給者番号/本人負担
//   これで aggregate.ts が保険/公費/本人負担を正しく分割 → 伝送金額が一致。
//   法別 = 負担者番号 上2桁 (12=生活保護)。
//
//   node migrations/import_meisai_kohi.mjs            # DRY RUN
//   node migrations/import_meisai_kohi.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { findDataFile } from "./_meisai_files.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const EXECUTE=process.argv.includes("--execute");
const AREA_DIR=process.env.AREA_DIR||"茂原";
// ⚠ マーカーに拠点を入れる。入れないと冪等削除が**全事業所の公費を消す**
//   (2026-08-04: 四街道→さつきが丘→高品 と流すたびに前の事業所の公費が消えていた)
//
// 2026-08-31 監査での是正:
//   上の警告をコメントで書いていただけで TAG は optional・既定が空文字だった。
//   = 人が覚えている前提の防御。実際に無タグの `[MEISAI公費 2026-06]` が
//   8 行残っていた (全員 法別12 生保)。--execute では TAG を必須にする。
const TAG=process.env.TAG||"";
if(EXECUTE && !TAG){
  console.error("✗ TAG が未指定です。--execute には TAG=<拠点名> が必須。");
  console.error("  例: TAG=高品 AREA_DIR=高品 TARGET_MONTH=2026-06 node migrations/import_meisai_kohi.mjs --execute");
  console.error("  (TAG 無しだと冪等削除のマーカーが拠点を含まず、全事業所の公費を消します)");
  process.exit(1);
}
// TARGET_MONTH=2026-07 で対象月を切替 (既定は 2026-06)。フォルダも同じ月を見る。
const TARGET_MONTH=process.env.TARGET_MONTH||"2026-06";
const YM=TARGET_MONTH.replace("-","");
const TENANT="kt-group", MARK=`[MEISAI公費 ${TARGET_MONTH}${TAG?" "+TAG:""}]`;
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
function parseLine(line){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const sjis=new TextDecoder("shift_jis");
const numOr0=(s)=>{const v=parseInt((s||"").replace(/\..*$/,""),10);return Number.isFinite(v)?v:0;};

async function main(){
  console.log(`=== 公費取込 ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  // フォルダ構成が事業所ごとに違うので対象月配下を再帰で探す
  const csv=findDataFile(path.join(KAIGO,"サービス実績データ",AREA_DIR,YM),"介護請求(明細付)_一覧.CSV");
  if(!csv){ console.error(`✗ サービス実績データ/${AREA_DIR}/${YM} 配下に 介護請求(明細付)_一覧.CSV がありません`); process.exit(1); }
  console.log(`  取込元: ${path.relative(KAIGO,csv)}`);
  const lines=sjis.decode(readFileSync(csv)).split(/\r?\n/).filter(l=>l);
  const H=parseLine(lines[0]).map(h=>h.replace(/^"|"$/g,"")); const gi=(n)=>H.indexOf(n);
  const iNum=gi("利用者番号"),iName=gi("利用者名"),iF1=gi("公費1負担者番号"),iJ1=gi("公費1受給者番号"),iHon=gi("公費分本人負担"),iMei=gi("明細書番号");
  // 利用者ごと (公費1負担者番号あり) を集約 (明細書ベースdedupe)
  const kohi={}; const seen=new Set();
  for(const ln of lines.slice(1)){ const c=parseLine(ln).map(x=>x.replace(/^"|"$/g,""));
    const f=(c[iF1]||"").trim(); if(!f) continue;
    const num=c[iNum];
    if(!kohi[num]) kohi[num]={name:c[iName],futansha:f,jukyusha:(c[iJ1]||"").trim(),honnin:0};
    if(!seen.has(c[iMei])){ seen.add(c[iMei]); kohi[num].honnin += numOr0(c[iHon]); }
  }
  const clients=[]; for(let x=0;;x+=1000){const {data,error}=await sb.from("clients").select("id,user_number").range(x,x+999);if(error)throw error;clients.push(...data);if(data.length<1000)break;}
  const idByNum={}; for(const c of clients) idByNum[String(c.user_number)]=c.id;

  const payloads=[];
  for(const num of Object.keys(kohi)){
    const cid=idByNum[num]; const k=kohi[num];
    if(!cid){ console.log(`  ⚠ ${num} ${k.name} client未登録`); continue; }
    const hobetsu=k.futansha.slice(0,2);
    payloads.push({ tenant_id:TENANT, client_id:cid, kohi_hobetsu:hobetsu, futansha_number:k.futansha, jukyusha_number:k.jukyusha, start_date:null, end_date:null, priority:1, honnin_futan:k.honnin, notes:MARK });
    console.log(`  ${num} ${k.name}: 法別${hobetsu} 負担者${k.futansha} 受給者${k.jukyusha} 本人負担${k.honnin}`);
  }
  console.log(`\n投入対象: ${payloads.length}名`);
  if(!EXECUTE){ console.log("※ DRY RUN。--execute で投入(既存マーカー削除→再投入)。"); return; }
  // 冪等: 既存マーカー削除
  //   マーカー一致に加えて **今回投入する client に限定** する (二重防御)。
  //   万一マーカーが他拠点と衝突しても、今回対象外の利用者の公費は消えない。
  const targetClientIds=[...new Set(payloads.map(p=>p.client_id))];
  let deleted=0;
  for(let i=0;i<targetClientIds.length;i+=200){
    const chunk=targetClientIds.slice(i,i+200);
    const { error:delErr, count }=await sb.from("client_kohi_records")
      .delete({ count:"exact" }).eq("notes",MARK).in("client_id",chunk);
    if(delErr){ console.error(`✗ 既存削除失敗: ${delErr.message}`); process.exit(1); }
    deleted+=count??0;
  }
  console.log(`  既存マーカー削除: ${deleted}件`);
  const { error }=await sb.from("client_kohi_records").insert(payloads);
  if(error){ console.error(`✗ 投入失敗: ${error.message}`); process.exit(1); }
  console.log(`✓ 完了: ${payloads.length}名`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});
