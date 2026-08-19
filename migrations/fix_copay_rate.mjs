// 負担割合(copay_rate)を明細CSVの給付率(保険分)から設定。
//   給付率90→1割 / 80→2割 / 70→3割。STEP1では未設定=全員1割になっていた。
//   client_insurance_records.copay_rate を insured_number で更新。
//   node migrations/fix_copay_rate.mjs [--execute]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { findDataFile } from "./_meisai_files.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const EXECUTE=process.argv.includes("--execute");
const AREA_DIR=process.env.AREA_DIR||"茂原";
const TAG=process.env.TAG||"";
// TARGET_MONTH=2026-07 で対象月を切替 (既定は 2026-06)。STEP1 のマーカーと揃える。
const TARGET_MONTH=process.env.TARGET_MONTH||"2026-06";
const YM=TARGET_MONTH.replace("-","");
const STEP1_MARK=`[MEISAI-STEP1 ${TARGET_MONTH}${TAG?" "+TAG:""}]`;
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const sjis=new TextDecoder("shift_jis");
function parseLine(line){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
async function main(){
  console.log(`=== copay_rate設定 ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  // フォルダ構成が事業所ごとに違うので対象月配下を再帰で探す
  const csv=findDataFile(path.join(KAIGO,"サービス実績データ",AREA_DIR,YM),"介護請求(明細付)_一覧.CSV");
  if(!csv){ console.error(`✗ サービス実績データ/${AREA_DIR}/${YM} 配下に 介護請求(明細付)_一覧.CSV がありません`); process.exit(1); }
  console.log(`  取込元: ${path.relative(KAIGO,csv)}`);
  const lines=sjis.decode(readFileSync(csv)).split(/\r?\n/).filter(l=>l);
  const H=parseLine(lines[0]).map(x=>x.replace(/^"|"$/g,""));const iIns=H.indexOf("被保険者番号"),iType=H.indexOf("サービス種類コード"),iKyu=H.indexOf("給付率(保険分)");
  const kyuBy={};
  // 種類11(介護) と A2/A3(総合) 両方から給付率を拾う (総合のみ利用者=3割等が漏れていた)。
  // 介護を優先(種類11で上書き)。copayは利用者属性なので通常同値。
  for(const l of lines.slice(1)){const c=parseLine(l).map(x=>x.replace(/^"|"$/g,""));
    const ty=c[iType]; if(ty!=="11" && !/^A[23]/.test(ty)) continue;
    const g=(c[iKyu]||"").trim(); if(!g) continue;
    if(ty==="11" || !(c[iIns] in kyuBy)) kyuBy[c[iIns]]=g; // 種類11優先
  }
  const copayOf=(g)=>{const n=parseInt(g,10);if(n>=90)return 1;if(n>=80)return 2;if(n>=70)return 3;return null;};
  const byCopay={};for(const g of Object.values(kyuBy)){const c=copayOf(g);byCopay[c]=(byCopay[c]||0)+1;}
  console.log("給付率→copay分布:",JSON.stringify(byCopay));
  console.log("2割(copay=2)の被保番:", Object.entries(kyuBy).filter(([,g])=>copayOf(g)===2).map(([i])=>i).join(", "));
  if(!EXECUTE){ console.log("\n※ DRY RUN。--execute で copay_rate更新。"); return; }
  let ok=0, nomatch=0;
  for(const [ins,g] of Object.entries(kyuBy)){
    const cr=copayOf(g); if(cr==null)continue;
    const {error,count}=await sb.from("client_insurance_records").update({copay_rate:String(cr)},{count:"exact"}).eq("insured_number",ins).eq("notes",STEP1_MARK);
    if(error){ console.error(`✗ ${ins}: ${error.message}`); process.exit(1); }
    if(count>0) ok++; else nomatch++;
  }
  console.log(`✓ 完了: ${ok}名の copay_rate 設定 (marker不一致で未更新: ${nomatch})`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});
