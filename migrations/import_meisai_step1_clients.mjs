// ============================================================================
// STEP1: ほのぼの利用者マスタ → clients / client_insurance_records / client_office_assignments
//   源:
//     利用者データ/基本情報_______.CSV  … 利用者番号・氏名・生年月日・住所・性別
//     利用者データ/介護保険1.CSV         … 被保険者番号・保険者・要介護度・認定期間・給付率・限度額・ケアマネ
//   対象: MEISAI①介護 に登場する利用者番号(116名) のみ (利用者番号で確実結合)
//   投入先office: リンクスヘルパーステーション (business_number=1271500942)
//
//   使い方:
//     node migrations/import_meisai_step1_clients.mjs            # DRY RUN (書込なし)
//     node migrations/import_meisai_step1_clients.mjs --execute  # 本番
//
//   ⚠ 実行順序: この script は**認定レコードを入れ直す** (再利用の利用者も含む) ため、
//     link_caremanager_office.mjs / import_meisai_kohi.mjs / import_meisai_plan_units.mjs は
//     **必ずこの後**に流すこと。先に流すと care_office_id や公費が消える。
//
//       1. import_meisai_step1_clients.mjs     利用者・認定
//       2. import_meisai_kohi.mjs              公費
//       3. link_caremanager_office.mjs         担当居宅介護支援事業所 (伝送 項19/20)
//       4. import_meisai_visit_records.mjs     介護実績     ※OFFICE_BN で事業所を指定
//       5. import_meisai_sougou_records.mjs    総合事業実績
//       6. import_meisai_addon_lines.mjs       加算行
//       7. import_meisai_plan_units.mjs        計画単位数
//
//   ロールバック用に、--execute 時は作成した client_id を
//     migrations/_meisai_step1_created_ids.json に記録する。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { findMeisaiFiles } from "./_meisai_files.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
// 事業所パラメータ (env で切替。デフォルト=茂原/リンクスヘルパー)
const OFFICE_BUSINESS_NUMBER = process.env.OFFICE_BN || "1271500942";
const AREA_DIR = process.env.AREA_DIR || "茂原"; // サービス実績データ配下
const USER_SUB = process.env.USER_SUB || "茂原";         // 利用者データ配下
const TAG = process.env.TAG || "";                        // 大網は "大網" 等 (mark/マッピング分離用)
const IMPORT_MARK = `[MEISAI-STEP1 2026-06${TAG ? " " + TAG : ""}]`;
const MAP_FILE = `migrations/_meisai_num_to_client${TAG ? "_" + TAG : ""}.json`;
const CREATED_FILE = `migrations/_meisai_step1_created_ids${TAG ? "_" + TAG : ""}.json`;
const DELETED_FILE = `migrations/_meisai_step1_deleted${TAG ? "_" + TAG : ""}.json`;
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const USER_DIR = path.join(KAIGO, "利用者データ", USER_SUB);
const MEISAI_DIR = path.join(KAIGO, "サービス実績データ", AREA_DIR, "202606");

function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});

// ---- CSV (SJIS, quoted) ----
const sjis=new TextDecoder("shift_jis");
function parseLine(line){ // 簡易CSV: "..."カンマ区切り
  const out=[]; let cur="",q=false;
  for(let i=0;i<line.length;i++){ const ch=line[i];
    if(q){ if(ch==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else { if(ch==='"')q=true; else if(ch===","){out.push(cur);cur="";} else cur+=ch; }
  }
  out.push(cur); return out;
}
function readCsv(p){
  const text=sjis.decode(readFileSync(p));
  const lines=text.split(/\r?\n/).filter(l=>l!=="");
  const header=parseLine(lines[0]).map(h=>h.trim());
  const idx={}; header.forEach((h,i)=>idx[h]=i);
  const rows=lines.slice(1).map(parseLine);
  return {idx,rows};
}
// ---- normalize ----
const zen2han=(s)=>(s||"").replace(/[０-９]/g,(c)=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));
const isoDate=(s)=>{ s=(s||"").trim(); const m=/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s); return m?`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`:null; };
const careLevel=(s)=>zen2han((s||"").trim()); // 要介護１→要介護1
const num=(s)=>{ const v=(s||"").trim(); return v===""?null:v; };

async function main(){
  console.log(`=== STEP1 利用者マスタ投入 ${EXECUTE?"【本番 EXECUTE】":"【DRY RUN】"} ===\n`);

  // 1) 対象利用者番号 = MEISAI①介護
  const targetNums=new Set();
  for(const f of findMeisaiFiles(MEISAI_DIR)){
    const {idx,rows}=readCsv(f);
    // ①介護(11xxxx) + ②総合事業(A2/A3) を対象 (③障害以降は別途)
    for(const c of rows){ const code=(c[idx["サービスコード"]]||"").trim(); if(/^11[1-7]/.test(code)||/^A[23]/.test(code)) targetNums.add((c[idx["利用者番号"]]||"").trim()); }
  }
  console.log(`対象利用者(MEISAI①介護): ${targetNums.size}名\n`);

  // 2) マスタ読込
  const base=readCsv(path.join(USER_DIR,"基本情報_______.CSV"));
  const kaigo=readCsv(path.join(USER_DIR,"介護保険1.CSV"));
  const baseByNum=new Map(); for(const r of base.rows) baseByNum.set((r[base.idx["利用者番号"]]||"").trim(), r);
  // 介護保険は1利用者に複数行(履歴)。**対象月に有効な認定**を採る。
  //   ⚠ 「最新1件」で採ってはいけない。更新申請のレコードは開始日が未来なので、
  //     全履歴を出力してもらうと 2026-07 開始の証を拾って 6 月請求がズレる
  //     (高品で 認定期間 20260701-20290630 を出してしまい伝送と不一致になった)。
  //   対象月にかかる行が複数あれば開始日が新しい方。1 つも無ければ最新で代替し警告する。
  const MONTH_START="2026-06-01", MONTH_END="2026-06-30";
  const kaigoByNum=new Map();
  const certFallback=[];
  {
    const rowsByNum=new Map();
    for(const r of kaigo.rows){
      const n=(r[kaigo.idx["利用者番号"]]||"").trim();
      if(!rowsByNum.has(n)) rowsByNum.set(n,[]);
      r._start=isoDate(r[kaigo.idx["認定有効期間－開始日"]])||"";
      r._end=isoDate(r[kaigo.idx["認定有効期間－終了日"]])||"";
      rowsByNum.get(n).push(r);
    }
    for(const [n,rows] of rowsByNum){
      const covering=rows.filter(r=>(!r._start||r._start<=MONTH_END)&&(!r._end||r._end>=MONTH_START));
      const pick=(covering.length?covering:rows).sort((a,b)=>(b._start||"").localeCompare(a._start||""))[0];
      if(!covering.length && rows.length) certFallback.push(`${n}: 対象月に有効な認定なし → ${pick._start}〜${pick._end} で代替`);
      kaigoByNum.set(n,pick);
    }
  }

  // 3) office
  const {data:offs,error:oe}=await sb.from("offices").select("id,name").eq("business_number",OFFICE_BUSINESS_NUMBER);
  if(oe) throw new Error(oe.message);
  const office=offs[0]; console.log(`office: ${office.name} (${office.id})\n`);

  // 4) 既存 clients.user_number
  const existing=new Map();
  // **氏名+生年月日** の索引。障害の受給者証取込が先に走っていると、その利用者は
  //   user_number 衝突でリナンバーされている (211 山田圭子 → 100211) ため、
  //   番号だけで探すと見つからず**同じ人をもう 1 件作ってしまう**。
  //   氏名+生年月日 で拾って再利用し、番号を本来の番号に戻す。
  const byNameBirth=new Map();
  for(let from=0;;from+=1000){ const {data,error}=await sb.from("clients").select("id,user_number,name,birth_date").range(from,from+999); if(error)throw new Error(error.message);
    for(const c of data){ if(c.user_number!=null) existing.set(String(c.user_number),c);
      if(c.birth_date) byNameBirth.set(`${(c.name||"").normalize("NFKC").replace(/[\s　]/g,"")}|${c.birth_date}`,c); }
    if(data.length<1000)break; }
  const normNm=(s)=>(s||"").normalize("NFKC").replace(/[\s　]/g,"");

  // 衝突判定: 同一user_numberの既存clientの参照数を調べる
  async function refCount(cid){
    const {count:a}=await sb.from("client_office_assignments").select("client_id",{count:"exact",head:true}).eq("client_id",cid);
    const {count:v}=await sb.from("kaigo_visit_schedule").select("id",{count:"exact",head:true}).eq("user_id",cid);
    return (a||0)+(v||0);
  }

  // 5) build payloads
  const toCreate=[]; const issues=[]; const reuse=[]; const toDeleteJunk=[]; const conflicts=[];
  for(const n of targetNums){
    const b=baseByNum.get(n), k=kaigoByNum.get(n);
    if(!b){ issues.push(`${n}: 基本情報に無い`); continue; }
    const name=(b[base.idx["利用者名"]]||"").trim();
    const ex=existing.get(n);
    let unOverride=null; // user_number 衝突時のリナンバー値 (マッピングは元番号nで繋ぐ)
    let reuseId=null, renumberFrom=null;
    if(ex){
      if(normNm(ex.name)===normNm(name)){ reuseId=ex.id; } // 同一人物→再利用 (認定は下で作って更新する)
      const refs=reuseId?0:await refCount(ex.id);
      if(reuseId){ /* 再利用: ゴミ判定も衝突判定も不要 */ }
      else
      if(refs===0){ toDeleteJunk.push({num:n,id:ex.id,name:ex.name}); } // ゴミ行→削除して作成
      // 別人衝突 (2147483647等のゴミ番号を複数人が共有): user_numberをリナンバーして新規作成
      else { unOverride=`${n}-${TAG||OFFICE_BUSINESS_NUMBER}`; conflicts.push(`${n}: 既存"${ex.name}"(参照${refs})と別人"${name}"衝突 → user_number=${unOverride} で新規作成`); }
    }
    const bd=isoDate(b[base.idx["生年月日"]]);
    if(!bd) issues.push(`${n} ${name}: 生年月日欠落`);
    // 番号では見つからなかったが**氏名+生年月日が一致する既存 client** があれば再利用する
    //   (障害の受給者証取込でリナンバーされた同一人物。作り直すと二重登録になる)
    if(bd){
      const hit=byNameBirth.get(`${normNm(name)}|${bd}`);
      if(hit && (!ex || ex.id!==hit.id) && !reuseId){
        reuseId=hit.id;
        renumberFrom=String(hit.user_number)!==n?String(hit.user_number):null;
      }
    }
    const client={
      user_number:unOverride??n, name, tenant_id:TENANT, status:"active", is_provisional:false,
      furigana:num(b[base.idx["フリガナ"]]), gender:num(b[base.idx["性別"]]), birth_date:bd,
      postal_code:num(b[base.idx["郵便番号"]]), address:num(b[base.idx["住所"]]),
      phone:num(b[base.idx["電話番号"]]), mobile:num(b[base.idx["携帯番号"]]),
      blood_type:(()=>{ const bt=zen2han((b[base.idx["血液型"]]||"").trim()).toUpperCase(); return /^(A|B|O|AB)$/.test(bt)?bt:null; })(),
    };
    let ins=null;
    if(k){
      const cl=careLevel(k[kaigo.idx["要介護度"]]);
      const cs=(k[kaigo.idx["認定状況"]]||"").trim();
      if(cs && cs!=="認定済み") issues.push(`${n} ${name}: 認定状況=${cs}`);
      client.insured_number=num(k[kaigo.idx["被保険者番号"]]);
      client.insurer_number=num(k[kaigo.idx["保険者番号"]]);
      client.care_level=cl||null;
      client.certification_start_date=isoDate(k[kaigo.idx["認定有効期間－開始日"]]);
      client.certification_end_date=isoDate(k[kaigo.idx["認定有効期間－終了日"]]);
      client.benefit_rate=num(k[kaigo.idx["給付率"]]);
      client.care_manager=num(k[kaigo.idx["担当ケアマネジャー"]]);
      client.care_manager_org=num(k[kaigo.idx["支援事業所（正式名称）"]]);
      ins={
        tenant_id:TENANT, effective_date:isoDate(k[kaigo.idx["認定有効期間－開始日"]])||"2000-04-01",
        insured_number:num(k[kaigo.idx["被保険者番号"]]), insurer_number:num(k[kaigo.idx["保険者番号"]]),
        insurer_name:num(k[kaigo.idx["保険者"]]), care_level:cl||null, certification_status:cs||null, record_status:cs||null,
        certification_start_date:isoDate(k[kaigo.idx["認定有効期間－開始日"]]),
        certification_end_date:isoDate(k[kaigo.idx["認定有効期間－終了日"]]),
        service_limit_amount:num(k[kaigo.idx["区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）"]]),
        service_limit_period_start:isoDate(k[kaigo.idx["適用期間－開始日（居宅ｻｰﾋﾞｽ区分）"]]),
        service_limit_period_end:isoDate(k[kaigo.idx["適用期間－終了日（居宅ｻｰﾋﾞｽ区分）"]]),
        benefit_rate:num(k[kaigo.idx["給付率"]]),
        care_manager:num(k[kaigo.idx["担当ケアマネジャー"]]), care_manager_org:num(k[kaigo.idx["支援事業所（正式名称）"]]),
        care_office_name:num(k[kaigo.idx["支援事業所（正式名称）"]]),
        qualification_date:isoDate(k[kaigo.idx["資格取得日"]]),
        certification_date:isoDate(k[kaigo.idx["認定年月日"]]),
        service_restriction:num(k[kaigo.idx["サービス限定"]]),
        notes:IMPORT_MARK,
      };
    } else {
      issues.push(`${n} ${name}: 介護保険1に無い(保険情報なし→請求不可)`);
    }
    if(reuseId) reuse.push({num:n,name,id:reuseId,renumberFrom,client,ins});
    else toCreate.push({num:n,name,client,ins});
  }

  console.log(`― 投入計画 ―`);
  console.log(`  新規作成: ${toCreate.length}名 / 既存再利用(同一人物): ${reuse.length}名`);
  console.log(`  衝突ゴミ行 削除→作成: ${toDeleteJunk.length}件`);
  toDeleteJunk.forEach(d=>console.log(`   🗑 user_number=${d.num} "${d.name}" (参照0) を削除して実在者を作成`));
  if(conflicts.length){ console.log(`  ⛔ 別人衝突(手動要): ${conflicts.length}件`); conflicts.forEach(s=>console.log(`   ${s}`)); }
  if(certFallback.length){
    console.log(`  ⚠ 対象月に有効な認定が無い利用者 ${certFallback.length}名 (最新で代替):`);
    for(const c of certFallback.slice(0,10)) console.log(`   ${c}`);
    if(certFallback.length>10) console.log(`   … 他 ${certFallback.length-10}件`);
  }
  console.log(`  データ品質フラグ: ${issues.length}件`);
  issues.slice(0,25).forEach(s=>console.log(`   ⚠ ${s}`));
  if(issues.length>25) console.log(`   … 他 ${issues.length-25}件`);
  console.log(`  合計 紐付け対象(assignment作成): ${toCreate.length+reuse.length}名 / 期待116名`);
  console.log("");
  if(toCreate[0]){
    console.log("clients payload サンプル:\n",JSON.stringify(toCreate[0].client,null,1));
    console.log("\nclient_insurance_records payload サンプル:\n",JSON.stringify(toCreate[0].ins,null,1),"\n");
  }

  if(!EXECUTE){ console.log("※ DRY RUN。--execute で 削除→clients/insurance/assignment を投入。"); return; }

  // ---- EXECUTE ----
  const mapping={}; // MEISAI利用者番号 → client_id
  const log={created:[],reused:[],deleted:[]};

  // 5a) ゴミ行削除 (内容をログ保存してから)
  for(const d of toDeleteJunk){
    const {data:row}=await sb.from("clients").select("*").eq("id",d.id).single();
    log.deleted.push(row);
    const {error}=await sb.from("clients").delete().eq("id",d.id);
    if(error){ console.error(`✗ 削除失敗 ${d.num}: ${error.message}`); process.exit(1); }
  }
  writeFileSync(path.join(KAIGO,DELETED_FILE),JSON.stringify(log.deleted,null,1));

  // 5b) 新規作成
  for(const t of toCreate){
    const {data:cRow,error:cErr}=await sb.from("clients").insert(t.client).select("id").single();
    if(cErr){ console.error(`✗ clients ${t.num} ${t.name}: ${cErr.message}`); writeFileSync(path.join(KAIGO,CREATED_FILE),JSON.stringify(log.created,null,1)); process.exit(1); }
    const cid=cRow.id; log.created.push(cid); mapping[t.num]=cid;
    if(t.ins){ const {error:iErr}=await sb.from("client_insurance_records").insert({...t.ins,client_id:cid}); if(iErr) console.error(`✗ insurance ${t.num}: ${iErr.message}`); }
    const {error:aErr}=await sb.from("client_office_assignments").insert({tenant_id:TENANT,client_id:cid,office_id:office.id,start_date:"2026-06-01",home_care_categories:[]});
    if(aErr) console.error(`✗ assignment ${t.num}: ${aErr.message}`);
  }
  // 5c) 再利用(同一人物): assignment が無ければ追加
  for(const r of reuse){
    mapping[r.num]=r.id; log.reused.push(r.id);
    // 再利用でも**認定情報は入れ直す** (対象月の認定に更新するため)。
    //   同じ取込マーカーの行だけ消して入れ直すので、手入力の認定は壊さない。
    if(r.client){
      const { user_number, ...attrs } = r.client;
      const upd = r.renumberFrom ? { ...attrs, user_number: r.num } : attrs;
      const { error:uErr } = await sb.from("clients").update(upd).eq("id", r.id);
      if(uErr) console.error(`✗ clients update ${r.num}: ${uErr.message}`);
    }
    if(r.ins){
      await sb.from("client_insurance_records").delete().eq("client_id", r.id).eq("notes", IMPORT_MARK);
      const { error:iErr } = await sb.from("client_insurance_records").insert({ ...r.ins, client_id: r.id });
      if(iErr) console.error(`✗ insurance(reuse) ${r.num}: ${iErr.message}`);
    }
    // 障害取込でリナンバーされていた分は本来の利用者番号に戻す
    //   (同じ番号のゴミ行は 5a で削除済なので衝突しない)
    if(r.renumberFrom){
      const {error}=await sb.from("clients").update({user_number:r.num}).eq("id",r.id);
      if(error) console.error(`x renumber ${r.renumberFrom}->${r.num} ${r.name}: ${error.message}`);
      else console.log(`  ${r.name}: user_number ${r.renumberFrom} -> ${r.num} に戻しました`);
    }
    const {count}=await sb.from("client_office_assignments").select("client_id",{count:"exact",head:true}).eq("client_id",r.id).eq("office_id",office.id);
    if(!count){ const {error}=await sb.from("client_office_assignments").insert({tenant_id:TENANT,client_id:r.id,office_id:office.id,start_date:"2026-06-01",home_care_categories:[]}); if(error) console.error(`✗ assignment(reuse) ${r.num}: ${error.message}`); }
  }
  writeFileSync(path.join(KAIGO,CREATED_FILE),JSON.stringify(log.created,null,1));
  writeFileSync(path.join(KAIGO,MAP_FILE),JSON.stringify(mapping,null,1));
  console.log(`✓ 完了: 作成${log.created.length} / 再利用${log.reused.length} / 削除${log.deleted.length}`);
  console.log(`  マッピング → migrations/_meisai_num_to_client.json (${Object.keys(mapping).length}名)`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});
