// ============================================================================
// STEP2-総合: MEISAI 総合事業(A系)実績 → kaigo_visit_schedule (completed)
//   利用者は _meisai_num_to_client.json で紐付け。
//   service_type = 利用者の保険者→prefix(MB_/IC_/CS_) で引いた総合コードの service_name。
//   一宮のA3(訪サA・3)は該当コード未登録なので自動skip (要ほのぼの明細で解決)。
//   総合独自サービスは月額 → aggregate-sougou が unit_type='1月につき' で月1回課金。
//
//   node migrations/import_meisai_sougou_records.mjs            # DRY RUN
//   node migrations/import_meisai_sougou_records.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { findMeisaiFiles } from "./_meisai_files.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE=process.argv.includes("--execute");
// TARGET_MONTH=2026-07 で対象月を切替 (既定は 2026-06)。
// MONTH_FIRST はサービスコードの世代判定 (validInMonth) に使うので必ず同じ月にする。
const TARGET_MONTH=process.env.TARGET_MONTH||"2026-06";
const MONTH_FIRST=`${TARGET_MONTH}-01`;
const YM=TARGET_MONTH.replace("-","");
const OFFICE=process.env.OFFICE_ID||"e08c3706-ad59-4913-b4e2-67f2675422e9";
const AREA_DIR=process.env.AREA_DIR||"茂原";
const TAG=process.env.TAG||"";
// 保険者→総合コードprefix。app側 SOUGOU_PREFIX_BY_INSURER と一致させること。
// 大網エリア(大網白里/山武/九十九里)はみなし現行相当コードのみ→単位数全国共通なので MB_ 流用。
const PREFIX={
  "122101":"MB_", "124214":"IC_", "124230":"CS_",
  "122390":"OA_", "122374":"SM_", "124032":"KJ_", "122291":"SD_", // 大網白里/山武/九十九里/袖ケ浦(公式表投入済)
  "121012":"CB_","121020":"CB_","121038":"CB_","121046":"CB_","121053":"CB_","121061":"CB_", // 千葉市6区
  "122192":"IH_", "122069":"K_",                          // 市原市 / 木更津市
  "122283":"YT_",                                         // 四街道市 (国保連統一CSVから投入済)
  // いすみエリア (いすみ営業所の管轄)。**みなし現行相当コードのみ**で単位数は全国共通。
  //   実伝送 KK260804 で検算済: A21111=1176 / A21211=2349 / A21321=3727 / 処遇改善266‰
  //   いずれも MB_ と同値なので MB_ を流用する (大網エリアと同じ扱い)。
  "122184":"MB_", "122382":"MB_", "124412":"MB_",
  // 山武エリアの近隣市町村。実伝送 KK260803 で単位数が全国共通と一致 (同上)
  "122135":"MB_", "122358":"MB_", "124099":"MB_",
  "122168":"MB_",   // 八千代市 (花見川)。実伝送で全国共通単位数を確認
  "124263":"MB_",   // 睦沢町 (東郷)。同上
};
const STEP1_MARK=`[MEISAI-STEP1 ${TARGET_MONTH}${TAG?" "+TAG:""}]`;
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
const MEISAI=path.join(KAIGO,`サービス実績データ/${AREA_DIR}/${YM}`);
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const sjis=new TextDecoder("shift_jis");
const normStaff=(s)=>(s||"").normalize("NFKC").replace(/[\s　]/g,"").replace(/様$/,"");
async function fetchAll(t,cols,filt){const o=[];for(let f=0;;f+=1000){let q=sb.from(t).select(cols).range(f,f+999);if(filt)q=filt(q);const {data,error}=await q;if(error)throw new Error(`${t}:${error.message}`);o.push(...data);if(data.length<1000)break;}return o;}

async function main(){
  console.log(`=== STEP2-総合 実績取込 ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  const numToClient=JSON.parse(readFileSync(path.join(KAIGO,`migrations/_meisai_num_to_client${TAG?"_"+TAG:""}.json`),"utf8"));

  // MEISAI 総合行 (A系)
  const rows=[];
  for(const f of findMeisaiFiles(MEISAI)){
    const lines=sjis.decode(readFileSync(f)).split(/\r?\n/).filter(l=>l);
    const h=lines[0].split(","); const gi=(n)=>h.indexOf(n);
    for(const ln of lines.slice(1)){ const c=ln.split(",");
      const code=(c[gi("サービスコード")]||"").trim();
      if(!/^A[23]/.test(code)) continue;
      rows.push({num:(c[gi("利用者番号")]||"").trim(),code,date:(c[gi("日付")]||"").replace(/\//g,"-"),
        start:(c[gi("派遣開始時間")]||"").trim(),end:(c[gi("派遣終了時間")]||"").trim(),staff:(c[gi("職員名")]||"").trim()});
    }
  }
  console.log(`総合実績行: ${rows.length}`);

  // 利用者の保険者。STEP1 マーカー付きを優先し、無い利用者は認定レコード全体から補う。
  // ⚠ マーカーだけに頼ると、TAG 無しで取り込まれた拠点 (茂原・姉ム・四街道) で
  //   保険者が引けず総合事業が丸ごと未解決になる (2026-08-07 に 3 拠点で発生)。
  const insurerBy={};
  {
    const all=await fetchAll("client_insurance_records","client_id,insurer_number,notes");
    for(const r of all){ if(!r.insurer_number) continue;
      if(r.notes===STEP1_MARK) insurerBy[r.client_id]=r.insurer_number;         // 当拠点・当月が最優先
      else if(!(r.client_id in insurerBy)) insurerBy[r.client_id]=r.insurer_number; }
  }

  // 総合コード名 (prefix付き, 対象月)
  const sc=await fetchAll("kaigo_service_codes","service_code,service_name,unit_type,valid_from,valid_until",q=>q.eq("system","総合事業").eq("calculation_type","基本"));
  const nameByCode={}; for(const r of sc){ if((!r.valid_from||r.valid_from<=MONTH_FIRST)&&(!r.valid_until||r.valid_until>=MONTH_FIRST)) nameByCode[r.service_code]={name:r.service_name,ut:r.unit_type}; }

  // 職員
  const members=await fetchAll("members","id,name"); const memBy=new Map();
  for(const m of members){const k=normStaff(m.name); if(!memBy.has(k))memBy.set(k,[]); memBy.get(k).push(m.id);}

  const payloads=[]; let skipNoClient=0, skipNoCode=0; const skipCodes={};
  for(const r of rows){
    const cid=numToClient[r.num]; if(!cid){skipNoClient++;continue;}
    const insurer=insurerBy[cid]; const pref=PREFIX[insurer];
    const scode=pref?`${pref}${r.code}`:null;   // MEISAI A21111 → MB_A21111
    const info=scode?nameByCode[scode]:null;
    if(!info){ skipNoCode++; skipCodes[r.code+"@"+(insurer||"?")]=(skipCodes[r.code+"@"+(insurer||"?")]||0)+1; continue; }
    const sids=memBy.get(normStaff(r.staff))||[];
    payloads.push({ user_id:cid, staff_id:sids.length===1?sids[0]:null, visit_date:r.date,
      start_time:r.start, end_time:r.end, service_type:info.name, status:"completed",
      office_id:OFFICE, notes:`[MEISAI総合取込 ${TARGET_MONTH} code=${r.code}]` });
  }
  console.log(`取込可能: ${payloads.length} / skip(利用者未マップ):${skipNoClient} / skip(コード未解決):${skipNoCode}`);
  if(Object.keys(skipCodes).length) console.log(`  未解決内訳: ${JSON.stringify(skipCodes)}`);
  const uClients=new Set(payloads.map(p=>p.user_id));
  console.log(`取込対象 利用者数: ${uClients.size}`);
  if(payloads[0]) console.log("payloadサンプル:\n",JSON.stringify(payloads[0],null,1));

  if(!EXECUTE){ console.log("\n※ DRY RUN。--execute で 既存マーカー行削除→投入。"); return; }
  // 冪等: 既存の総合取込行を削除してから入れ直す。
  // ⚠ **必ず対象月に絞る**。月スコープが無いと他の月の実績まで消える (visit_records と同じ罠)。
  const [dy,dm]=TARGET_MONTH.split("-").map(Number);
  const MONTH_LAST=`${TARGET_MONTH}-${String(new Date(dy,dm,0).getDate()).padStart(2,"0")}`;
  const { error:delErr }=await sb.from("kaigo_visit_schedule").delete()
    .eq("office_id",OFFICE).like("notes","[MEISAI総合取込%")
    .gte("visit_date",MONTH_FIRST).lte("visit_date",MONTH_LAST);
  if(delErr){ console.error(`✗ 既存削除失敗: ${delErr.message}`); process.exit(1); }
  console.log("既存 総合取込行 削除完了");
  const CH=500; let done=0;
  for(let i=0;i<payloads.length;i+=CH){ const chunk=payloads.slice(i,i+CH);
    const {error}=await sb.from("kaigo_visit_schedule").insert(chunk);
    if(error){ console.error(`✗ (${done}済): ${error.message}`); process.exit(1); }
    done+=chunk.length; console.log(`  ${done}/${payloads.length}`);
  }
  console.log(`✓ 完了: ${done}行`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});
