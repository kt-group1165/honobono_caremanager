// 障害(身体/家事)の残差調査: 袖ケ浦・高品 (READ ONLY・DB書換なし)
// DUMP_PAYLOADS の中身と ほのぼの KJ (J121-03) をコード別に突合する。
import { readFileSync } from "node:fs";
import Encoding from "encoding-japanese";

function readKJ(path) {
  const buf = readFileSync(path);
  const text = Encoding.convert(buf, { to: "UNICODE", from: "SJIS", type: "string" });
  return text.split(/\r\n|\r|\n/).filter(Boolean).map((l) => l.split(",").map((f) => f.replace(/^"|"$/g, "")));
}

function tallyKJ(path) {
  const rows = readKJ(path);
  const detail = rows.filter((r) => r[2] === "J121" && r[3] === "03");
  const byCode = new Map();
  for (const r of detail) {
    const code = r[8];
    if (!code.startsWith("111") && !code.startsWith("112")) continue; // 身体/家事のみ
    const count = Number(r[10]);
    byCode.set(code, (byCode.get(code) ?? 0) + count);
  }
  return byCode;
}

function tallyDump(path) {
  const dump = JSON.parse(readFileSync(path, "utf8"));
  const byCode = new Map();
  const byCodeUsers = new Map();
  for (const entry of dump.billable) {
    const parts = entry.split("|");
    const code = parts[parts.length - 1];
    if (!code.startsWith("111") && !code.startsWith("112")) continue;
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
    if (!byCodeUsers.has(code)) byCodeUsers.set(code, new Set());
    byCodeUsers.get(code).add(parts[0]);
  }
  return { byCode, byCodeUsers, total: dump.billable.length };
}

function compare(label, kjPath, dumpPath) {
  console.log(`\n════ ${label} ════`);
  const kj = tallyKJ(kjPath);
  const { byCode: ours } = tallyDump(dumpPath);
  const codes = new Set([...kj.keys(), ...ours.keys()]);
  let kjTotal = 0, oursTotal = 0, diffTotal = 0;
  const rows = [];
  for (const code of codes) {
    const k = kj.get(code) ?? 0;
    const o = ours.get(code) ?? 0;
    kjTotal += k; oursTotal += o;
    if (k !== o) { diffTotal += Math.abs(k - o); rows.push({ code, kj: k, ours: o, diff: o - k }); }
  }
  console.log(`【分母】ほのぼの身体/家事 合計: ${kjTotal}件 / 当方合計: ${oursTotal}件`);
  console.log(`乖離のあるコード: ${rows.length}種 / 乖離の絶対値合計: ${diffTotal}`);
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  for (const r of rows) {
    console.log(`  ${r.code}  ほのぼの=${r.kj}  当方=${r.ours}  差=${r.diff > 0 ? "+" : ""}${r.diff}`);
  }
  return rows;
}

const sode = compare(
  "袖ケ浦",
  "伝送データ/袖ケ浦/訪問介護/障害/202606/ほのぼのから/KJ260801.CSV",
  "C:/Users/domen-PC/AppData/Local/Temp/shogai_check/sodegaura.json",
);
const taka = compare(
  "高品",
  "伝送データ/高品/訪問介護/障害/202606/ほのぼのから/KJ260802.CSV",
  "C:/Users/domen-PC/AppData/Local/Temp/shogai_check/takashina.json",
);

console.log("\n════ まとめ ════");
console.log(`袖ケ浦: 乖離の絶対値合計 = ${sode.reduce((s, r) => s + Math.abs(r.diff), 0)}`);
console.log(`高品:   乖離の絶対値合計 = ${taka.reduce((s, r) => s + Math.abs(r.diff), 0)}`);
