// ============================================================================
// 初回加算等の加算を ほのぼの明細CSV を正として kaigo_visit_addon_lines へ投入。
//   源: サービス実績データ/茂原/202606/介護請求(明細付)_一覧.CSV の 種類11 加算行
//   対象: 114001(初回加算) 等 (処遇改善116184は office formula で自動計算されるため除外)
//   MEISAI稼働データは加算を明示しないため、請求の正=ほのぼの明細から取る。
//
//   node migrations/import_meisai_addon_lines.mjs            # DRY RUN
//   node migrations/import_meisai_addon_lines.mjs --execute
//
// ── 2026-09-01 修正: target_month は「行ごとの提供年月」から決める ──
//   従来は folder の月 (MONTH/YM) を全行に一律で書き込んでいたため、月遅れ請求
//   (提供年月 ≠ 請求年月。当該フォルダは請求年月基準で出力される) の加算行が
//   実際の提供月ではなく請求月に紐付いて記録されていた。姉ム2名・山武1名の
//   「初回加算(114001)が新システムのみに計上される」不一致の原因がこれ
//   (伝送突合ハーネスで確認済み。202606フォルダの一覧CSVに 提供年月=2026/04・
//   2026/05 の行が混在していた)。行の 提供年月 列を読んで target_month を決める
//   ように修正。旧・誤った月に入っていた行は EXECUTE 時に削除してから入れ直す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { findDataFile } from "./_meisai_files.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE=process.argv.includes("--execute");
// TARGET_MONTH=2026-07 で対象月を切替 (既定は 2026-06)。フォルダも同じ月を見る。
const MONTH=process.env.TARGET_MONTH||"2026-06";
const YM=MONTH.replace("-","");
const TENANT="kt-group";
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
  const csv=findBillingCsv(path.join(KAIGO,"サービス実績データ",AREA_DIR,YM));
  const lines=sjis.decode(readFileSync(csv)).split(/\r?\n/).filter(l=>l);
  const H=parseLine(lines[0]).map(h=>h.replace(/^"|"$/g,"")); const gi=(n)=>H.indexOf(n);
  const iType=gi("サービス種類コード"),iNum=gi("利用者番号"),iCode=gi("サービスコード"),iContent=gi("サービス内容"),iKaisu=gi("回数"),iTeikyo=gi("提供年月");
  // 加算(処遇改善は率計算なので除く)を利用者×コード×提供年月で集計。
  //   種類11 → system='介護' / A系 (総合事業) → system='総合事業'
  //   ⚠ 総合事業にも定額加算がある (A24001 訪問型独自サービス初回加算 200単位/月)。
  //     取り込まないと 限度額管理対象と処遇改善の母数が両方不足する
  //     (2026-08-07 花見川・K姉・いすみで検出)。
  //   ⚠ target_month は「提供年月」で決める (請求年月=フォルダの月ではない)。
  //     月遅れ請求の行は 提供年月 が過去月のまま一覧CSVに混ざって出てくるため、
  //     フォルダの月を一律で使うと過去月の加算が当月の明細に紛れ込む。
  const addons={}; // "num|code|month" -> {content,count,system,num,code,month}
  for(const ln of lines.slice(1)){ const c=parseLine(ln).map(x=>x.replace(/^"|"$/g,""));
    const type=c[iType]||""; const code=c[iCode]||"";
    const isSougou=/^A/.test(code);
    if(type!=="11" && !isSougou) continue;
    if(code==="116184") continue;              // 介護の処遇改善 (率計算)
    if(/^A2618|^A2626|^A2627|^A2638/.test(code)) continue; // 総合事業の処遇改善 (率計算)
    // ⚠ 総合事業の サービス内容 は略称で「加算」の字が入らないことがある
    //   (花見川 A24001 = 「訪介護相当サ初回」)。総合事業は**コードで**加算判定する
    //   (A2 4xxx/6xxx = 加算・減算帯)。介護 (種類11) は従来どおり名称で判定。
    const isAddonCode = isSougou ? /^A\d[46]/.test(code) : /加算/.test(c[iContent]||"");
    if(!isAddonCode) continue;
    const num=c[iNum]; const teikyo=(c[iTeikyo]||"").trim();
    const month=teikyo.includes("/") ? teikyo.replace("/","-") : MONTH; // 「2026/06」→「2026-06」。読めない時だけフォルダの月にfallback
    const key=`${num}|${code}|${month}`;
    addons[key]=addons[key]||{content:c[iContent],count:0,system:isSougou?"総合事業":"介護",num,code,month};
    addons[key].count += parseInt(c[iKaisu]||"1",10);
  }
  // 利用者番号→client_id
  const clients=[]; for(let f=0;;f+=1000){const {data,error}=await sb.from("clients").select("id,user_number").order("id").range(f,f+999);if(error)throw error;clients.push(...data);if(data.length<1000)break;}
  const idByNum={}; for(const c of clients) idByNum[String(c.user_number)]=c.id;
  // TAG指定時: STEP1マッピングを overlay (ゴミ番号2147483647等の他事業所衝突を補正)
  if(TAG){ const mp=JSON.parse(readFileSync(path.join(KAIGO,`migrations/_meisai_num_to_client_${TAG}.json`),"utf8")); for(const[k,v]of Object.entries(mp)) idByNum[String(k)]=v; }

  const payloads=[];
  let wrongMonthCount=0;
  for(const a of Object.values(addons)){
    const cid=idByNum[a.num]; if(!cid){ console.log(`  ⚠ ${a.num} client未登録`); continue; }
    payloads.push({ tenant_id:TENANT, office_id:OFFICE, client_id:cid, target_month:a.month, addon_code:a.code, count:a.count, system:a.system });
    const flag=a.month!==MONTH ? "  ⚠月遅れ(提供月≠フォルダ月)" : "";
    if(flag) wrongMonthCount++;
    console.log(`  ${a.num} [${a.system}] ${a.content}(${a.code}) target_month=${a.month} count=${a.count}${flag}`);
  }
  console.log(`\n投入対象: ${payloads.length}件 (うち提供月がフォルダ月と異なる=月遅れ ${wrongMonthCount}件)`);
  if(!EXECUTE){ console.log("※ DRY RUN。--execute で投入(既存は upsert)。旧・誤った月に入っていた行があれば削除してから入れ直す。"); return; }

  // 旧バグ (target_month=フォルダの月で固定) で誤った月に入っていた行を先に削除。
  // 対象: このoffice×このpayloadに含まれる (client_id, addon_code, system) の組み合わせで、
  //       今回計算した正しい target_month と異なる行。
  const keysInPayload=new Set(payloads.map(p=>`${p.client_id}|${p.addon_code}|${p.system}`));
  const { data: existing, error: fetchErr }=await sb.from("kaigo_visit_addon_lines")
    .select("id,client_id,addon_code,system,target_month").eq("office_id",OFFICE);
  if(fetchErr){ console.error(`✗ 既存行の取得失敗: ${fetchErr.message}`); process.exit(1); }
  const correctMonthOf=new Map(payloads.map(p=>[`${p.client_id}|${p.addon_code}|${p.system}`,p.target_month]));
  const staleIds=(existing??[])
    .filter(r=>keysInPayload.has(`${r.client_id}|${r.addon_code}|${r.system}`))
    .filter(r=>correctMonthOf.get(`${r.client_id}|${r.addon_code}|${r.system}`)!==r.target_month)
    .map(r=>r.id);
  if(staleIds.length>0){
    console.log(`\n旧・誤った月の行を削除: ${staleIds.length}件`);
    const { error: delErr }=await sb.from("kaigo_visit_addon_lines").delete().in("id",staleIds);
    if(delErr){ console.error(`✗ 削除失敗: ${delErr.message}`); process.exit(1); }
  }

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
