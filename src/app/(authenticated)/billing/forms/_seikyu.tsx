"use client";

import React from "react";

const F = '"MS Mincho","ＭＳ 明朝","游明朝",serif';
const B = "1px solid #333";
const B2 = "1.5px solid #000";
const BG = "#f5f5f5";

function D({ v, n, s = 16 }: { v: string; n: number; s?: number }) {
  const cs = v.padEnd(n, " ").slice(0, n).split("");
  return (
    <span style={{ display: "inline-flex" }}>
      {cs.map((c, i) => (
        <span key={i} style={{
          display: "inline-block", width: s, height: s + 1,
          border: B, textAlign: "center", lineHeight: `${s + 1}px`,
          fontSize: s > 14 ? "9pt" : "7pt", fontFamily: "monospace",
          marginRight: -1, background: "#fff",
        }}>{c.trim()}</span>
      ))}
    </span>
  );
}

function p(n: number) { return String(n).padStart(2, "0"); }

const SLASH: React.CSSProperties = {
  border: B, background: "repeating-linear-gradient(135deg, transparent, transparent 2px, #bbb 2px, #bbb 3px)",
};

interface Props {
  providerNumber: string; officeName: string; officeAddress: string;
  officePhone: string; postalCode: string; billingMonth: string;
  totalCount: number; totalUnits: number; totalAmount: number;
  insuranceAmount: number; userCopay: number;
}

export function SeikyuForm(props: Props) {
  const {
    providerNumber, officeName, officeAddress, officePhone, postalCode,
    billingMonth, totalCount, totalUnits, totalAmount, insuranceAmount, userCopay,
  } = props;

  const h: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "6pt", verticalAlign: "middle", fontFamily: F, background: BG, textAlign: "center" };
  const c: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "7.5pt", verticalAlign: "middle", fontFamily: F, background: "#fff" };
  const cR: React.CSSProperties = { ...c, textAlign: "right" };

  const bm = (() => {
    const [y, m] = billingMonth.split("-").map(Number);
    return y >= 2019 ? { era: "令和", y: y - 2018, m } : { era: "平成", y: y - 1988, m };
  })();

  const publicRows = [
    { code: "12", label: "生保\n居宅介護支援・\n介護予防支援" },
    { code: "10", label: "感染症 37条の2" },
    { code: "21", label: "障自・通院医療" },
    { code: "15", label: "障自・更生医療" },
    { code: "19", label: "原爆・一般" },
    { code: "54", label: "難病法" },
    { code: "51", label: "特定疾患等\n治療研究" },
    { code: "81", label: "被爆者助成" },
    { code: "86", label: "被爆体験者" },
    { code: "87", label: "有機ヒ素・緊急\n措置" },
    { code: "88", label: "水俣病総合対策\nメチル水銀" },
    { code: "66", label: "石綿・救済措置" },
    { code: "58", label: "障害者・支援措\n置(全額免除)" },
    { code: "25", label: "中国残留邦人等" },
  ];

  return (
    <div style={{ fontFamily: F, fontSize: "7.5pt", color: "#000", width: "195mm" }}>
      {/* ──── 年月（左上）+ タイトル ──── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "3mm" }}>
        <div style={{ border: B2, padding: "2px 5px", fontSize: "8pt" }}>
          {bm.era}<D v={p(bm.y)} n={2} s={14} />年<D v={p(bm.m)} n={2} s={14} />月分
        </div>
        <div style={{ fontWeight: "bold", fontSize: "13pt", letterSpacing: "0.3em" }}>
          介護給付費請求書
        </div>
      </div>

      {/* ──── 事業所情報（右寄せ） ──── */}
      <table style={{ width: "55%", borderCollapse: "collapse", border: B2, marginBottom: "3mm", marginLeft: "auto" }}>
        <tbody>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, width: "22%" }}>事業所番号</td>
            <td style={c}><D v={providerNumber} n={10} /></td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={h}>名称</td>
            <td style={{ ...c, fontWeight: "bold" }}>{officeName}</td>
          </tr>
          <tr>
            <td style={{ ...h, fontSize: "5pt" }}>請求<br />事業所</td>
            <td style={{ ...c, fontSize: "7pt", lineHeight: 1.3 }}>
              〒{postalCode}<br />{officeAddress}
            </td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={h}>連絡先</td>
            <td style={c}>電話番号　{officePhone}</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 宛先 ──── */}
      <div style={{ fontSize: "9pt", marginBottom: "1mm" }}><b>保　険　者</b></div>
      <div style={{ fontSize: "8pt", marginBottom: "1mm", paddingLeft: "8mm" }}>（　別　記　）殿</div>
      <div style={{ fontSize: "7.5pt", marginBottom: "3mm" }}>
        下記のとおり請求します。　{bm.era}{bm.y}年{bm.m}月14日
      </div>

      {/* ──── 保険請求 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "8.5pt", marginBottom: "0.5mm" }}>保険請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "3mm" }}>
        <thead>
          <tr>
            <th style={{ ...h, width: "16%" }} rowSpan={2}>区分</th>
            <th style={h} colSpan={5}>サービス費用</th>
            <th style={h} colSpan={4}>特定入所者介護サービス費等</th>
          </tr>
          <tr>
            <th style={{ ...h, width: "6%" }}>件数</th>
            <th style={{ ...h, width: "9%" }}>単位数・<br />点数</th>
            <th style={{ ...h, width: "9%" }}>費用合計</th>
            <th style={{ ...h, width: "9%" }}>公費<br />請求額</th>
            <th style={{ ...h, width: "9%" }}>保険<br />請求額</th>
            <th style={{ ...h, width: "6%" }}>件数</th>
            <th style={{ ...h, width: "9%" }}>費用<br />合計</th>
            <th style={{ ...h, width: "9%" }}>公費<br />請求額</th>
            <th style={{ ...h, width: "9%" }}>保険<br />請求額</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: 24 }}>
            <td style={{ ...c, fontSize: "6pt", lineHeight: 1.2 }}>
              居宅介護支援・<br />介護予防支援
            </td>
            <td style={cR}>{totalCount}</td>
            <td style={cR}>{totalUnits.toLocaleString()}</td>
            <td style={cR}>{totalAmount.toLocaleString()}</td>
            <td style={cR}>0</td>
            <td style={{ ...cR, fontWeight: "bold" }}>{insuranceAmount.toLocaleString()}</td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
          </tr>
          <tr style={{ height: 22, fontWeight: "bold" }}>
            <td style={{ ...h, fontWeight: "bold" }}>合計</td>
            <td style={cR}>{totalCount}</td>
            <td style={cR}>{totalUnits.toLocaleString()}</td>
            <td style={cR}>{totalAmount.toLocaleString()}</td>
            <td style={cR}>0</td>
            <td style={{ ...cR, fontSize: "9pt" }}>{insuranceAmount.toLocaleString()}</td>
            <td style={cR}>0</td>
            <td style={cR}>0</td>
            <td style={cR}>0</td>
            <td style={cR}>0</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 公費請求 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "8.5pt", marginBottom: "0.5mm" }}>公費請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2 }}>
        <thead>
          <tr>
            <th style={h} colSpan={2} rowSpan={2}>区分</th>
            <th style={h} colSpan={4}>サービス費用</th>
            <th style={h} colSpan={3}>特定入所者介護サービス費等</th>
          </tr>
          <tr>
            <th style={{ ...h, width: "6%" }}>件数</th>
            <th style={{ ...h, width: "9%" }}>単位数・<br />点数</th>
            <th style={{ ...h, width: "9%" }}>費用<br />合計</th>
            <th style={{ ...h, width: "9%" }}>公費<br />請求額</th>
            <th style={{ ...h, width: "6%" }}>件数</th>
            <th style={{ ...h, width: "9%" }}>費用<br />合計</th>
            <th style={{ ...h, width: "9%" }}>公費<br />請求額</th>
          </tr>
        </thead>
        <tbody>
          {publicRows.map((row) => (
            <tr key={row.code} style={{ height: 17 }}>
              <td style={{ ...h, width: "4%", fontSize: "7pt" }}>{row.code}</td>
              <td style={{ ...c, width: "14%", fontSize: "5pt", lineHeight: 1.1, whiteSpace: "pre-line" }}>{row.label}</td>
              <td style={c}></td><td style={c}></td><td style={c}></td><td style={c}></td>
              <td style={SLASH}></td><td style={SLASH}></td><td style={SLASH}></td>
            </tr>
          ))}
          <tr style={{ height: 20, fontWeight: "bold" }}>
            <td colSpan={2} style={{ ...h, fontWeight: "bold" }}>合計</td>
            <td style={c}></td><td style={c}></td><td style={c}></td><td style={c}></td>
            <td style={c}></td><td style={c}></td><td style={cR}>0</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
