// 残差の内訳分析 (READ ONLY): 実績起点の給付管理 vs KY の差を、限度額との関係で分類する
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const sjis = new TextDecoder("shift_jis");
function pl(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const padIns=(s)=>(s||"").trim().replace(/\s/g,"").padStart(10,"0");
const padInsurer=(s)=>(s||"").trim().replace(/\s/g,"").padStart(6,"0");
const num=(s)=>Number(String(s||"").replace(/[^\d.-]/g,""))||0;
const YM="202606";

const csv=sjis.decode(readFileSync(path.join(KAIGO,"サービス実績データ/全居宅/202606/全居宅事業所別請求額.CSV"))).split(/\r?\n/).filter(l=>l).map(pl);
const H=csv[0],g=(n)=>H.indexOf(n);
const OFFICES=JSON.parse(process.env.OFFICES);

let cats={"限度額超過(ケアマネ調整)":0,"限度額内なのに差":0};
const samples=[];
for(const [bn,tag] of OFFICES){
  const mine=csv.slice(1).filter(r=>(r[g("事業所番号（支援事業所）")]||"").trim()===bn);
  const hasMeisai=new Set();
  for(const r of mine){ if((r[g("サービス区分")]||"").trim()!=="明細") continue;
    hasMeisai.add([padIns(r[g("被保険者番号")]),padInsurer(r[g("保険者番号")]),(r[g("事業所番号（提供事業所）")]||"").trim(),(r[g("サービス種類コード（提供事業所）")]||"").trim(),(r[g("サービスコード")]||"").trim()].join("|")); }
  const agg=new Map(), limitByUser=new Map();
  for(const r of mine){
    const kubun=(r[g("サービス区分")]||"").trim();
    if(kubun==="支給限度額対象外") continue;
    if(num(r[g("給付率")])===0) continue;
    const dk=[padIns(r[g("被保険者番号")]),padInsurer(r[g("保険者番号")]),(r[g("事業所番号（提供事業所）")]||"").trim(),(r[g("サービス種類コード（提供事業所）")]||"").trim(),(r[g("サービスコード")]||"").trim()].join("|");
    if(kubun==="明細・小計"&&hasMeisai.has(dk)) continue;
    const k=[padIns(r[g("被保険者番号")]),padInsurer(r[g("保険者番号")]),(r[g("事業所番号（提供事業所）")]||"").trim(),(r[g("サービス種類コード（提供事業所）")]||"").trim()].join("|");
    agg.set(k,(agg.get(k)||0)+num(r[g("サービス単位／金額")]));
  }
  for(const [k,v] of [...agg]) if(v<=0) agg.delete(k);
  const ky=sjis.decode(readFileSync(path.join(KAIGO,`伝送データ/${tag}/居宅/202606/ほのぼのから/KY260701.CSV`))).split(/\r?\n/).filter(l=>l).map(pl).filter(r=>r[2]==="8222"&&r[3]===YM);
  const kyAgg=new Map(), kyLimit=new Map();
  for(const r of ky){
    const u=[padIns(r[10]),padInsurer(r[4].replace(/^0+/,""))].join("|");
    if(r[9]==="99"){ kyLimit.set(u,num(r[16])); continue; }
    kyAgg.set([u,(r[18]||"").trim(),(r[20]||"").trim()].join("|"),(kyAgg.get([u,(r[18]||"").trim(),(r[20]||"").trim()].join("|"))||0)+num(r[21]));
  }
  const users=new Set([...agg.keys(),...kyAgg.keys()].map(k=>k.split("|").slice(0,2).join("|")));
  for(const u of users){
    const m=[...agg].filter(([k])=>k.startsWith(u+"|"));
    const y=[...kyAgg].filter(([k])=>k.startsWith(u+"|"));
    const keys=new Set([...m.map(([k])=>k),...y.map(([k])=>k)]);
    let ok=true; for(const k of keys) if((agg.get(k)??0)!==(kyAgg.get(k)??0)) ok=false;
    if(ok) continue;
    const mt=m.reduce((s,[,v])=>s+v,0), yt=y.reduce((s,[,v])=>s+v,0), lim=kyLimit.get(u)??0;
    const over = mt>lim && lim>0;
    const cat = over ? (yt===lim ? "限度額超過→KYが限度額ちょうど" : "限度額超過(調整あり)") : "限度額内なのに差";
    cats[cat]=(cats[cat]||0)+1;
    if(samples.length<25) samples.push(`${tag} ${u} 実績${mt} KY${yt} 限度額${lim} [${cat}]`);
  }
}
console.log("残差の分類:");
for(const [k,v] of Object.entries(cats).sort((a,b)=>b[1]-a[1])) if(v) console.log(`  ${k.padEnd(30)} ${v}名`);
console.log("\nサンプル:"); samples.forEach(s=>console.log("  "+s));
