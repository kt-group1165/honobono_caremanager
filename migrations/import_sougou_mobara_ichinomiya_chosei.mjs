// ============================================================================
// 総合事業サービスコード投入: 茂原市(MB_) / 一宮町(IC_) / 長生村(CS_)
//   源:
//     一宮町 サービスコード/一宮町/R8.6.1A2.csv   (cp932, 保険者124214)
//     長生村 サービスコード/長生村/202606.csv      (cp932, 保険者124230)
//     茂原市 サービスコード/茂原市/茂原総合事業（R8.6~）.pdf  (単位はPDF・名称は項目標準)
//   target: kaigo_service_codes (system='総合事業', service_code=<prefix>A2xxxx)
//
//   CSV列: 0保険者,1種類,2項目,3適用開始YYYYMM,4適用終了YYYYMM,5名称,6単位,7単位種別(3=月/2=日/1=回)
//   UNIQUE(system, service_code, valid_from) 衝突は skip (冪等)
//
//   node migrations/import_sougou_mobara_ichinomiya_chosei.mjs            # DRY RUN
//   node migrations/import_sougou_mobara_ichinomiya_chosei.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EXECUTE = process.argv.includes("--execute");
const SYSTEM = "総合事業";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const SC_DIR = path.join(KAIGO, "サービスコード");
function loadEnv(){ const t=readFileSync(path.join(KAIGO,".env.local"),"utf8"); const e={}; for(const l of t.split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,"");} return e; }
const env=loadEnv();
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});

const UNIT_TYPE={ "1":"1回につき","2":"1日につき","3":"1月につき","01":"1回につき","02":"1日につき","03":"1月につき" };
const sjis=new TextDecoder("shift_jis");

// CSV municipality (一宮/長生)
function parseCsvCity(file, insurer){
  const text=sjis.decode(readFileSync(file));
  const out=[];
  for(const line of text.split(/\r?\n/)){
    if(!line.trim()) continue;
    const c=line.split(",");
    if(c.length<8 || c[0].trim()!==insurer) continue;
    const cat=c[1].trim(), item=c[2].trim(), vf=c[3].trim(), vu=c[4].trim();
    const name=c[5].replace(/　+$/,"").trim();
    const units=/^-?\d+$/.test(c[6].trim())?parseInt(c[6],10):null;
    const utype=UNIT_TYPE[c[7].trim()]||"1回につき";
    const valid_from = /^\d{6}$/.test(vf)?`${vf.slice(0,4)}-${vf.slice(4,6)}-01`:null;
    let valid_until=null;
    if(vu!=="999999" && /^\d{6}$/.test(vu)){ const y=+vu.slice(0,4),m=+vu.slice(4,6); const last=new Date(y,m,0).getDate(); valid_until=`${vu.slice(0,4)}-${vu.slice(4,6)}-${String(last).padStart(2,"0")}`; }
    out.push({cat,item,name,units,utype,valid_from,valid_until});
  }
  return out;
}

// 項目コード→標準情報 (一宮A2現行版から作る。全国標準の項目構造=name/unit_type/units)
function buildItemInfo(rows){ const m={}; for(const r of rows){ if(r.cat==="A2" && r.valid_until===null) m[r.cat+r.item]={name:r.name,utype:r.utype,units:r.units}; } return m; }

// 茂原PDF: (項目, units) を抽出 (units はASCIIで読める=茂原の実値)。
// 単位種別・名称は全国標準の項目構造 (一宮A2現行=itemInfo) から解決。
//   → 茂原の「独自サービス単位」は茂原PDFの実数字を使う (代用しない)。
//   → 6xxx(処遇改善)/C2xx/D2xx等は全国一律の率のため、PDFで読めない分は
//     全国標準値(itemInfo)で補完する (これらは市町村非依存)。
function parseMobaraPdf(pdf, itemInfo){
  const py=`
import fitz,re,json
d=fitz.open(r"${pdf}")
t="\\n".join(d[i].get_text() for i in range(d.page_count))
lines=[l.strip() for l in t.split("\\n") if l.strip()]
out={}; i=0
while i<len(lines):
    if lines[i]=="A2":
        item=lines[i+1] if i+1<len(lines) else ""
        u=None
        for j in range(i+2,min(i+20,len(lines))):
            m=re.match(r'^(-?\\d+)\\s*単位$',lines[j]) or re.match(r'^(-?\\d+)\\s+1.{0,3}$',lines[j])
            if m: u=int(m.group(1));break
        if re.match(r'^[0-9A-Z]{4}$',item) and u is not None: out["A2"+item]=u
        i+=1
    else: i+=1
print(json.dumps(out,ensure_ascii=False))
`;
  const r=spawnSync("python",["-c",py],{encoding:"utf-8"});
  if(r.status!==0){ console.error("茂原PDF抽出失敗:",r.stderr); return []; }
  const pdfUnits=JSON.parse(r.stdout.trim()||"{}"); // {A2xxxx: units}
  const out=[];
  // itemInfo(全国標準の全A2項目) を土台に、単位は茂原PDF優先で解決
  for(const fullcode of Object.keys(itemInfo)){        // fullcode = "A2xxxx"
    const info=itemInfo[fullcode];
    const units = fullcode in pdfUnits ? pdfUnits[fullcode] : info.units; // 茂原PDF優先
    const item=fullcode.slice(2);
    out.push({cat:"A2",item,name:info.name,units,utype:info.utype,valid_from:"2025-04-01",valid_until:null,
      _src: (fullcode in pdfUnits ? "茂原PDF" : "全国標準")});
  }
  return out;
}

function toRecord(prefix, notes, r){
  let calc="基本";
  if(typeof r.units==="number" && r.units<0) calc="減算";
  else if(r.name.includes("加算")) calc="加算";
  else if(r.name.includes("減算")) calc="減算";
  const CAT_NAME={A2:"訪問介護相当・独自サービス",A6:"通所介護相当・独自サービス",AF:"介護予防ケアマネジメント"};
  return { system:SYSTEM, service_category:r.cat, service_category_name:(CAT_NAME[r.cat]||`総合事業 ${r.cat}`)+` (${notes.split(" ")[0]})`,
    service_code:`${prefix}${r.cat}${r.item}`,
    service_name:r.name, units:r.units, unit_type:r.utype, calculation_type:calc,
    valid_from:r.valid_from, valid_until:r.valid_until, notes };
}

async function main(){
  console.log(`=== 総合事業コード投入 ${EXECUTE?"【EXECUTE】":"【DRY RUN】"} ===\n`);
  // 一宮町: A2(独自/月額) + A3(訪問型サービスA/定率/回) の両CSV
  const iyA2=parseCsvCity(path.join(SC_DIR,"一宮町/R8.6.1A2.csv"),"124214");
  const iyA3=parseCsvCity(path.join(SC_DIR,"一宮町/R1a3csv.csv"),"124214");
  const iyRows=iyA2.concat(iyA3);
  const nsRows=parseCsvCity(path.join(SC_DIR,"長生村/202606.csv"),"124230");
  // 茂原市(122101): 独自サービスの単位は茂原PDFの実値を使用 (代用しない)。
  //   単位種別・名称は全国標準の項目構造(一宮A2現行=itemInfo)で解決。
  //   PDFで読めない加算/減算(6xxx/C2/D2=全国一律の率)は全国標準値で補完。
  const itemInfo=buildItemInfo(iyA2);
  const mbRows=parseMobaraPdf(path.join(SC_DIR,"茂原市/茂原総合事業（R8.6~）.pdf"),itemInfo);

  const sets=[
    {prefix:"MB_",notes:"茂原市 総合事業(122101)",rows:mbRows},
    {prefix:"IC_",notes:"一宮町 総合事業(124214)",rows:iyRows},
    {prefix:"CS_",notes:"長生村 総合事業(124230)",rows:nsRows},
  ];
  let all=[];
  for(const s of sets){
    const recs=s.rows.filter(r=>r.units!==null && r.valid_from).map(r=>toRecord(s.prefix,s.notes,r));
    const cur=recs.filter(r=>!r.valid_until);
    console.log(`${s.prefix} (${s.notes}): ${recs.length}件  現行: ${cur.length}`);
    // 該当クライアントが使う基本コードをサンプル表示
    recs.filter(r=>!r.valid_until && /A(21111|21211|31031)$/.test(r.service_code)).forEach(r=>console.log(`    ${r.service_code} ${r.service_name} ${r.units}単位 ${r.unit_type}${r._src?" ["+r._src+"]":""}`));
    all=all.concat(recs);
  }
  console.log(`\n投入対象 合計: ${all.length}件`);
  // 茂原の単位ソース内訳
  const mbSrc={}; for(const r of mbRows){ mbSrc[r._src]=(mbSrc[r._src]||0)+1; }
  console.log(`茂原 単位ソース: ${JSON.stringify(mbSrc)}`);

  if(!EXECUTE){ console.log("※ DRY RUN。--execute で 既存MB_/IC_/CS_削除→再投入。"); return; }

  // 既存の MB_/IC_/CS_ 総合コードを削除してから入れ直す (代用データの一掃)
  for(const pref of ["MB_","IC_","CS_"]){
    const { error }=await sb.from("kaigo_service_codes").delete().eq("system",SYSTEM).like("service_code",`${pref}%`);
    if(error){ console.error(`✗ 削除失敗 ${pref}: ${error.message}`); process.exit(1); }
  }
  console.log("既存 MB_/IC_/CS_ 削除完了");

  const CH=500; let ins=0;
  for(let i=0;i<all.length;i+=CH){
    const chunk=all.slice(i,i+CH);
    const { error }=await sb.from("kaigo_service_codes").insert(chunk);
    if(error){ console.error(`✗ insert失敗 (${ins}済): ${error.message}`); process.exit(1); }
    ins+=chunk.length;
    console.log(`  ${ins}/${all.length}`);
  }
  console.log(`✓ 完了: ${all.length}件 insert`);
}
main().catch(e=>{console.error("ERROR:",e.message);process.exit(1);});
