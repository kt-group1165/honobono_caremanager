// ============================================================================
// 公費マスタCSV (利用者管理→CSV→公費) から client_kohi_records へ取込。
//   源: 利用者データ/<拠点>/公費1.CSV (USER_SUB で拠点切替)
//   列: 利用者番号,利用者名,住所,負担者番号(**6桁=法別を含まない**),受給者番号,確認日,
//       有効期限-開始日,有効期限-終了日,生活保護区分(単独/併用),...,本人支払額
//   2026-06 を含む券のみ取込。券期間(start/end)・生活保護区分・本人支払額つき。
//   これで aggregate.ts が保険/公費/本人負担を正しく分割 (単独=10割公費/併用=保険+生保)。
//
//   node migrations/import_kohi_master.mjs            # DRY RUN
//   node migrations/import_kohi_master.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const EXECUTE=process.argv.includes("--execute");
const TENANT="kt-group", MARK="[公費マスタ 2026-06]";
const MONTH_START="2026-06-01", MONTH_END="2026-06-30";
const USER_SUB=process.env.USER_SUB||"茂原";
const TAG=process.env.TAG||"";
const KAIGO=fileURLToPath(new URL("../",import.meta.url));
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
function parseLine(line){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const sjis=new TextDecoder("shift_jis");
const iso=(s)=>{const m=/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s||"").trim());return m?`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`:null;};
const numOr0=(s)=>{const v=parseInt((s||"").replace(/[^\d-]/g,""),10);return Number.isFinite(v)?v:0;};

// ── 法別番号の決め方 (2026-08-04 是正) ──────────────────────────────────────
// 公費1.CSV の「負担者番号」は **6桁で法別を含まない**。以前はここに 12 (生活保護) を
// 無条件で前置していたため、生保以外の公費が法別12 に化けて伝送に出ていた
// (大網 田森 フミ子・横川 良子 = 本当は法別81。請求書の区分2-法別81 が丸ごと欠落した)。
//
// 見分け: 「生活保護区分」列が 単独/併用 なら生保 (法別12)。**空なら生保ではない**。
// CSV に法別の列が無いので、生保以外はここの対応表で解決する。
// 未知の番号は黙って 12 を付けず除外して警告する (silent failure を作らない)。
//   126010 → 81: ほのぼの実伝送 (伝送データ/大網/訪問介護/介護/202606/ほのぼのから/
//                 KK260701.CSV の 7131/01 項7 = 81126010) で確認 2026-08-04
const HOBETSU_BY_FUTANSHA6 = {
  "126010": "81",
};
function resolveHobetsu(futansha6, seihoKubun){
  if(seihoKubun) return "12";                    // 単独 / 併用 = 生活保護
  return HOBETSU_BY_FUTANSHA6[futansha6] ?? null; // 空 = 生保以外 → 対応表で解決
}

async function main(){
  console.log(`=== 公費マスタ取込 ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  const csv=path.join(KAIGO,`利用者データ/${USER_SUB}/公費1.CSV`);
  const lines=sjis.decode(readFileSync(csv)).split(/\r?\n/).filter(l=>l);
  const H=parseLine(lines[0]).map(h=>h.replace(/^"|"$/g,"")); const gi=(n)=>H.indexOf(n);
  const iNum=gi("利用者番号"),iF=gi("負担者番号"),iJ=gi("受給者番号"),iS=gi("有効期限－開始日"),iE=gi("有効期限－終了日"),iK=gi("生活保護区分"),iHon=gi("本人支払額");

  const clients=[]; for(let x=0;;x+=1000){const {data,error}=await sb.from("clients").select("id,user_number").range(x,x+999);if(error)throw error;clients.push(...data);if(data.length<1000)break;}
  const idByNum={}; for(const c of clients) idByNum[String(c.user_number)]=c.id;
  if(TAG){ const mp=JSON.parse(readFileSync(path.join(KAIGO,`migrations/_meisai_num_to_client_${TAG}.json`),"utf8")); for(const[k,v]of Object.entries(mp)) idByNum[String(k)]=v; }

  const payloads=[]; const skipNoClient=new Set(); const unknownHobetsu=[];
  for(const ln of lines.slice(1)){ const c=parseLine(ln).map(x=>x.replace(/^"|"$/g,""));
    const start=iso(c[iS]), end=iso(c[iE]);
    if(!start||!end) continue;
    // 2026-06 を含む券のみ
    if(!(start<=MONTH_END && end>=MONTH_START)) continue;
    const cid=idByNum[c[iNum]]; if(!cid){ skipNoClient.add(c[iNum]); continue; }
    const futansha6=(c[iF]||"").trim();
    const seiho=(c[iK]||"").trim(); // 生活保護区分 (単独/併用)。空 = 生保ではない公費
    const hobetsu=resolveHobetsu(futansha6, seiho);
    if(!hobetsu){ unknownHobetsu.push(`${c[iNum]} ${c[1]} 負担者${futansha6}`); continue; }
    const futansha=futansha6.length===6?(hobetsu+futansha6):futansha6;
    payloads.push({ tenant_id:TENANT, client_id:cid, kohi_hobetsu:hobetsu,
      futansha_number:futansha, jukyusha_number:(c[iJ]||"").trim(),
      start_date:start, end_date:end, priority:1, honnin_futan:numOr0(c[iHon]),
      notes:`${MARK} ${seiho}`.trim() });
    console.log(`  ${c[iNum]} 法別${hobetsu} 負担者${futansha} 受給者${c[iJ]} 券${start}~${end} 区分${seiho||"(空=生保以外)"} 本人${numOr0(c[iHon])}`);
  }
  console.log(`\n投入対象: ${payloads.length}名 (対象外の利用者番号 ${skipNoClient.size}件はskip)`);
  if(unknownHobetsu.length){
    console.log(`\n★ 法別番号が決められないため除外: ${unknownHobetsu.length}件`);
    for(const u of unknownHobetsu) console.log(`    ${u}`);
    console.log(`  → HOBETSU_BY_FUTANSHA6 に「負担者番号6桁: "法別2桁"」を足してから流し直してください`);
    console.log(`     (法別はほのぼの実伝送 7131/01 項7 の先頭2桁で確認できます)`);
  }
  const tan=payloads.filter(p=>p.notes.includes("単独")).length, hei=payloads.filter(p=>p.notes.includes("併用")).length;
  console.log(`  単独(10割): ${tan} / 併用(保険+生保): ${hei}`);
  if(!EXECUTE){ console.log("※ DRY RUN。--execute で 旧公費(明細CSV分含む)削除→再投入。"); return; }
  // 旧公費(明細CSVマーカー and このマーカー)を削除して入れ直す。
  // ※ 他事業所分を消さないよう、今回の対象 client_id にスコープする
  const cids=[...new Set(payloads.map(p=>p.client_id))];
  await sb.from("client_kohi_records").delete().eq("notes","[MEISAI公費 2026-06]").in("client_id",cids);
  await sb.from("client_kohi_records").delete().like("notes",`${MARK}%`).in("client_id",cids);
  const { error }=await sb.from("client_kohi_records").insert(payloads);
  if(error){ console.error(`✗ 投入失敗: ${error.message}`); process.exit(1); }
  console.log(`✓ 完了: ${payloads.length}名`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});
