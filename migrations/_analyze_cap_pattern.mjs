// 限度額超過ケースで「どのサービス種類が削られたか」のパターン分析 (READ ONLY)
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
const cutKinds={}; const cases=[]; const patterns={};
for(const [bn,tag] of OFFICES){
  const mine=csv.slice(1).filter(r=>(r[g("事業所番号（支援事業所）")]||"").trim()===bn);
  const hasMeisai=new Set();
  for(const r of mine){ if((r[g("サービス区分")]||"").trim()!=="明細") continue;
    hasMeisai.add([padIns(r[g("被保険者番号")]),padInsurer(r[g("保険者番号")]),(r[g("事業所番号（提供事業所）")]||"").trim(),(r[g("サービス種類コード（提供事業所）")]||"").trim(),(r[g("サービスコード")]||"").trim()].join("|")); }
  const ratesByUser=new Map();
  for(const r of mine){ const u=`${padIns(r[g("被保険者番号")])}|${padInsurer(r[g("保険者番号")])}`;
    if(!ratesByUser.has(u))ratesByUser.set(u,new Set()); ratesByUser.get(u).add(num(r[g("給付率")])); }
  const rateMixed=new Set(); for(const [u,s] of ratesByUser) if(s.has(0)&&s.size>1) rateMixed.add(u);
  const agg=new Map();
  for(const r of mine){
    const kubun=(r[g("サービス区分")]||"").trim();
    if(kubun==="支給限度額対象外") continue;
    const u=`${padIns(r[g("被保険者番号")])}|${padInsurer(r[g("保険者番号")])}`;
    if(num(r[g("給付率")])===0&&rateMixed.has(u)) continue;
    const dk=[u,(r[g("事業所番号（提供事業所）")]||"").trim(),(r[g("サービス種類コード（提供事業所）")]||"").trim(),(r[g("サービスコード")]||"").trim()].join("|");
    if(kubun==="明細・小計"&&hasMeisai.has(dk)) continue;
    const k=[u,(r[g("事業所番号（提供事業所）")]||"").trim(),(r[g("サービス種類コード（提供事業所）")]||"").trim()].join("|");
    agg.set(k,(agg.get(k)||0)+num(r[g("サービス単位／金額")]));
  }
  for(const [k,v] of [...agg]) if(v<=0) agg.delete(k);
  const ky=sjis.decode(readFileSync(path.join(KAIGO,`伝送データ/${tag}/居宅/202606/ほのぼのから/KY260701.CSV`))).split(/\r?\n/).filter(l=>l).map(pl).filter(r=>r[2]==="8222"&&r[3]===YM);
  const kyAgg=new Map(), kyLimit=new Map();
  for(const r of ky){ const u=[padIns(r[10]),padInsurer(r[4].replace(/^0+/,""))].join("|");
    if(r[9]==="99"){ kyLimit.set(u,num(r[16])); continue; }
    const k=[u,(r[18]||"").trim(),(r[20]||"").trim()].join("|");
    kyAgg.set(k,(kyAgg.get(k)||0)+num(r[21])); }
  const users=new Set([...agg.keys(),...kyAgg.keys()].map(k=>k.split("|").slice(0,2).join("|")));
  for(const u of users){
    const m=[...agg].filter(([k])=>k.startsWith(u+"|"));
    const y=[...kyAgg].filter(([k])=>k.startsWith(u+"|"));
    const keys=new Set([...m.map(([k])=>k),...y.map(([k])=>k)]);
    let ok=true; for(const k of keys) if((agg.get(k)??0)!==(kyAgg.get(k)??0)) ok=false;
    if(ok) continue;
    const mt=m.reduce((s,[,v])=>s+v,0), yt=y.reduce((s,[,v])=>s+v,0), lim=kyLimit.get(u)??0;
    if(!(mt>lim&&lim>0&&yt===lim)) continue;   // 限度額ちょうどに収まったケースのみ
    // どの (提供|種類) が削られたか
    const cuts=[];
    for(const k of keys){ const a=agg.get(k)??0,b=kyAgg.get(k)??0; if(a!==b) cuts.push({kind:k.split("|")[3],from:a,to:b,d:b-a}); }
    const lines=m.map(([k,v])=>({kind:k.split("|")[3],units:v})).sort((a,b)=>b.units-a.units);
    const cutKindList=cuts.map(c=>c.kind).sort().join("+");
    cutKinds[cutKindList]=(cutKinds[cutKindList]||0)+1;
    // パターン判定: 削られたのは単位数最大の種類か / 最小か / 単一行か
    const cutSet=new Set(cuts.map(c=>c.kind));
    const pat = lines.length===1 ? "サービス1種類のみ"
      : cutSet.size>1 ? "複数種類にまたがる"
      : cutSet.has(lines[0].kind) ? "最大の種類を削る"
      : cutSet.has(lines[lines.length-1].kind) ? "最小の種類を削る" : "中間の種類を削る";
    patterns[pat]=(patterns[pat]||0)+1;
    if(cases.length<14) cases.push(`${tag} ${u.split("|")[0]} 超過${mt-lim} | 内訳:${lines.map(l=>l.kind+":"+l.units).join(" ")} | 削:${cuts.map(c=>c.kind+" "+c.from+"→"+c.to).join(", ")} [${pat}]`);
  }
}
console.log("=== 限度額ちょうどに収まったケースの削られ方 ===");
for(const [k,v] of Object.entries(patterns).sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(20)} ${v}名`);
console.log("\n=== 削られたサービス種類コードの組合せ ===");
for(const [k,v] of Object.entries(cutKinds).sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log(`  種類 ${k.padEnd(10)} ${v}名`);
console.log("\n=== ケース詳細 ==="); cases.forEach(c=>console.log("  "+c));
