// ============================================================================
// 番号衝突の是正: 利用者番号2147483647 は 佐藤喜美子/山口あき の2人が共有(ほのぼの破損)。
//   DBの client「2147483647」は STEP1 で山口あきの属性になったが、6月実績4件は
//   佐藤喜美子のもの(明細で佐藤=2147483647・種類11・被保番0000164640)。
//   → この client を佐藤喜美子の正しい属性/認定に訂正する(実績はそのまま=佐藤の分)。
//   山口あきはリンクスヘルパー6月請求に不在のため対象外。
//
//   node migrations/fix_sato_kimiko_2147483647.mjs            # DRY RUN
//   node migrations/fix_sato_kimiko_2147483647.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const EXECUTE=process.argv.includes("--execute");
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
const TARGET_NUM="2147483647", TARGET_NAME="佐藤 喜美子", TARGET_INSURED="0000164640";
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
function parseLine(line){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const sjis=new TextDecoder("shift_jis");
function readCsv(p){const lines=sjis.decode(readFileSync(p)).split(/\r?\n/).filter(l=>l);const H=parseLine(lines[0]).map(h=>h.replace(/^"|"$/g,""));return {H,rows:lines.slice(1).map(l=>parseLine(l).map(x=>x.replace(/^"|"$/g,"")))};}
const iso=(s)=>{const m=/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s||"").trim());return m?`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`:null;};
const zen2han=(s)=>(s||"").replace(/[０-９]/g,(c)=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));

async function main(){
  console.log(`=== 佐藤喜美子 訂正 ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  const base=readCsv(path.join(KAIGO,"利用者データ/茂原/基本情報_______.CSV"));
  const kaigo=readCsv(path.join(KAIGO,"利用者データ/茂原/介護保険1.CSV"));
  const b=base.rows.find(r=>r[base.H.indexOf("利用者番号")]===TARGET_NUM && r[base.H.indexOf("利用者名")]===TARGET_NAME);
  const k=kaigo.rows.find(r=>r[kaigo.H.indexOf("利用者番号")]===TARGET_NUM && r[kaigo.H.indexOf("被保険者番号")]===TARGET_INSURED);
  if(!b||!k){ console.error("マスタに佐藤喜美子の行が見つからない"); process.exit(1); }
  const gb=(n)=>b[base.H.indexOf(n)], gk=(n)=>k[kaigo.H.indexOf(n)];

  const {data:cl}=await sb.from("clients").select("id,name,insured_number").eq("user_number",TARGET_NUM);
  if(!cl?.length){ console.error("client(2147483647)なし"); process.exit(1); }
  const cid=cl[0].id;
  console.log(`対象client: ${cl[0].name} (被保番${cl[0].insured_number}) → 佐藤喜美子(被保番${TARGET_INSURED}) に訂正\n`);

  const clientUpd={
    name:gb("利用者名"), furigana:gb("フリガナ")||null,
    birth_date:iso(gb("生年月日")), gender:gb("性別")||null,
    postal_code:gb("郵便番号")||null, address:gb("住所")||null,
    insured_number:gk("被保険者番号"), insurer_number:gk("保険者番号"),
    care_level:zen2han(gk("要介護度")), certification_start_date:iso(gk("認定有効期間－開始日")),
    certification_end_date:iso(gk("認定有効期間－終了日")), benefit_rate:gk("給付率")||null,
    care_manager_org:gk("支援事業所（正式名称）")||null,
  };
  const insUpd={
    insured_number:gk("被保険者番号"), insurer_number:gk("保険者番号"),
    insurer_name:gk("保険者")||null, care_level:zen2han(gk("要介護度")),
    certification_start_date:iso(gk("認定有効期間－開始日")), certification_end_date:iso(gk("認定有効期間－終了日")),
    effective_date:iso(gk("認定有効期間－開始日")),
    service_limit_amount:gk("区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）")||null,
    service_limit_period_start:iso(gk("適用期間－開始日（居宅ｻｰﾋﾞｽ区分）")),
    service_limit_period_end:iso(gk("適用期間－終了日（居宅ｻｰﾋﾞｽ区分）")),
    benefit_rate:gk("給付率")||null, care_manager_org:gk("支援事業所（正式名称）")||null,
    care_office_name:gk("支援事業所（正式名称）")||null,
  };
  console.log("clients 更新:", JSON.stringify(clientUpd,null,1));
  console.log("\nclient_insurance_records 更新:", JSON.stringify(insUpd,null,1));

  if(!EXECUTE){ console.log("\n※ DRY RUN。--execute で訂正。"); return; }
  const {error:e1}=await sb.from("clients").update(clientUpd).eq("id",cid);
  if(e1){ console.error("clients更新失敗:",e1.message); process.exit(1); }
  const {error:e2}=await sb.from("client_insurance_records").update(insUpd).eq("client_id",cid).eq("notes","[MEISAI-STEP1 2026-06]");
  if(e2){ console.error("insurance更新失敗:",e2.message); process.exit(1); }
  console.log("✓ 完了: 佐藤喜美子に訂正");
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});
