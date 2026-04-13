"use client";

import React from "react";

const FONT = '"MS Mincho","ＭＳ 明朝","游明朝","Yu Mincho","Hiragino Mincho ProN",serif';
const B = "1px solid #222";
const B2 = "2px solid #000";
const BG = "#f9f9f9";

function Digits({ value, len, size = 20 }: { value: string; len: number; size?: number }) {
  const chars = value.replace(/-/g, "").padEnd(len, " ").slice(0, len).split("");
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      {chars.map((c, i) => (
        <span key={i} style={{
          display: "inline-block", width: size, height: size + 2,
          border: B, textAlign: "center", lineHeight: `${size + 2}px`,
          fontSize: size > 16 ? "10pt" : "8pt", fontFamily: "monospace",
          marginRight: -1, backgroundColor: "#fff",
        }}>
          {c.trim()}
        </span>
      ))}
    </span>
  );
}

function p2(n: number): string { return String(n).padStart(2, "0"); }

interface SeikyuProps {
  providerNumber: string;
  officeName: string;
  officeAddress: string;
  officePhone: string;
  postalCode: string;
  billingMonth: string;
  totalCount: number;
  totalUnits: number;
  totalAmount: number;
  insuranceAmount: number;
  userCopay: number;
}

export function SeikyuForm(props: SeikyuProps) {
  const {
    providerNumber, officeName, officeAddress, officePhone, postalCode,
    billingMonth, totalCount, totalUnits, totalAmount, insuranceAmount, userCopay,
  } = props;

  const hd: React.CSSProperties = {
    border: B, padding: "2px 4px", fontSize: "7.5pt", verticalAlign: "middle",
    fontFamily: FONT, backgroundColor: BG, fontWeight: "normal", textAlign: "center",
  };
  const td: React.CSSProperties = {
    border: B, padding: "2px 5px", fontSize: "8.5pt", verticalAlign: "middle",
    fontFamily: FONT, backgroundColor: "#fff",
  };
  const tdR: React.CSSProperties = { ...td, textAlign: "right" };
  const ROW = "24px";

  const bm = (() => {
    const [y, m] = billingMonth.split("-").map(Number);
    if (y >= 2019) return { era: "令和", y: y - 2018, m };
    return { era: "平成", y: y - 1988, m };
  })();

  const publicRows: { code: string; label: string }[] = [
    { code: "12", label: "生保\n居宅・施設サービス\n介護予防サービス\n地域密着型サービス等" },
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

  // 斜線セルのスタイル
  const slashCell: React.CSSProperties = {
    ...td,
    background: "repeating-linear-gradient(135deg, transparent, transparent 3px, #ccc 3px, #ccc 4px)",
  };

  return (
    <div style={{ fontFamily: FONT, fontSize: "8.5pt", color: "#000", width: "195mm" }}>
      {/* ──── 年月 ──── */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "2mm" }}>
        <span style={{ border: B2, padding: "2px 6px", fontSize: "9pt" }}>
          {bm.era}
          <Digits value={p2(bm.y)} len={2} size={16} />年
          <Digits value={p2(bm.m)} len={2} size={16} />月分
        </span>
      </div>

      {/* ──── タイトル ──── */}
      <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "14pt", marginBottom: "4mm", letterSpacing: "0.4em" }}>
        介護給付費請求書
      </div>

      {/* ──── 事業所情報（右寄せ） ──── */}
      <table style={{ width: "55%", borderCollapse: "collapse", border: B2, marginBottom: "3mm", marginLeft: "auto" }}>
        <tbody>
          <tr style={{ height: ROW }}>
            <td style={{ ...hd, width: "25%" }}>事業所番号</td>
            <td style={td}><Digits value={providerNumber} len={10} /></td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}>名称</td>
            <td style={{ ...td, fontWeight: "bold" }}>{officeName}</td>
          </tr>
          <tr>
            <td style={hd}>請求<br />事業所</td>
            <td style={{ ...td, fontSize: "7.5pt", lineHeight: 1.4 }}>
              <div>〒{postalCode}</div>
              <div>{officeAddress}</div>
            </td>
          </tr>
          <tr style={{ height: ROW }}>
            <td style={hd}>連絡先</td>
            <td style={td}>{officePhone}</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 宛先 ──── */}
      <div style={{ fontSize: "10pt", marginBottom: "1mm" }}>
        <b>保　険　者</b>
      </div>
      <div style={{ fontSize: "9pt", marginBottom: "1mm", paddingLeft: "10mm" }}>
        （別　記）殿
      </div>
      <div style={{ fontSize: "8.5pt", marginBottom: "4mm" }}>
        下記のとおり請求します。　{bm.era}{bm.y}年　月　日
      </div>

      {/* ──── 保険請求 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "9pt", marginBottom: "1mm" }}>保険請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "4mm" }}>
        <thead>
          <tr>
            <th style={{ ...hd, width: "18%" }} rowSpan={2}>区分</th>
            <th style={hd} colSpan={5}>サービス費用</th>
            <th style={hd} colSpan={5}>特定入所者介護サービス費等</th>
          </tr>
          <tr>
            <th style={{ ...hd, width: "6%" }}>件数</th>
            <th style={{ ...hd, width: "9%" }}>単位数・<br />点数</th>
            <th style={{ ...hd, width: "9%" }}>費用合計</th>
            <th style={{ ...hd, width: "9%" }}>保険<br />請求額</th>
            <th style={{ ...hd, width: "7%" }}>利用者<br />負担</th>
            <th style={{ ...hd, width: "6%" }}>件数</th>
            <th style={{ ...hd, width: "9%" }}>費用<br />合計</th>
            <th style={{ ...hd, width: "9%" }}>利用者<br />負担</th>
            <th style={{ ...hd, width: "9%" }}>公費<br />請求額</th>
            <th style={{ ...hd, width: "9%" }}>保険<br />請求額</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: "30px" }}>
            <td style={{ ...td, fontSize: "6pt", lineHeight: 1.2 }}>
              居宅・総合事業サービス<br />
              介護予防サービス<br />
              地域密着型サービス等
            </td>
            <td style={tdR}>{totalCount}</td>
            <td style={tdR}>{totalUnits.toLocaleString()}</td>
            <td style={tdR}>{totalAmount.toLocaleString()}</td>
            <td style={{ ...tdR, fontWeight: "bold" }}>{insuranceAmount.toLocaleString()}</td>
            <td style={tdR}>{userCopay}</td>
            <td style={tdR}>0</td>
            <td style={tdR}>0</td>
            <td style={tdR}>0</td>
            <td style={tdR}>0</td>
            <td style={tdR}>0</td>
          </tr>
          <tr style={{ height: "22px" }}>
            <td style={{ ...td, fontSize: "6pt" }}>居宅介護支援・<br />介護予防支援</td>
            <td style={tdR}></td>
            <td style={tdR}></td>
            <td style={tdR}></td>
            <td style={tdR}></td>
            <td style={tdR}></td>
            <td style={slashCell}></td>
            <td style={slashCell}></td>
            <td style={slashCell}></td>
            <td style={slashCell}></td>
            <td style={slashCell}></td>
          </tr>
          <tr style={{ height: ROW, fontWeight: "bold" }}>
            <td style={{ ...hd, fontWeight: "bold" }}>合計</td>
            <td style={tdR}>{totalCount}</td>
            <td style={tdR}>{totalUnits.toLocaleString()}</td>
            <td style={tdR}>{totalAmount.toLocaleString()}</td>
            <td style={{ ...tdR, fontSize: "10pt" }}>{insuranceAmount.toLocaleString()}</td>
            <td style={tdR}>{userCopay}</td>
            <td style={tdR}>0</td>
            <td style={tdR}>0</td>
            <td style={tdR}>0</td>
            <td style={tdR}>0</td>
            <td style={tdR}>0</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 公費請求 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "9pt", marginBottom: "1mm" }}>公費請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "4mm" }}>
        <thead>
          <tr>
            <th style={hd} colSpan={2}>区分</th>
            <th style={hd} colSpan={4}>サービス費用</th>
            <th style={hd} colSpan={3}>特定入所者介護サービス費等</th>
          </tr>
          <tr>
            <th style={{ ...hd, width: "4%" }}></th>
            <th style={{ ...hd, width: "14%" }}></th>
            <th style={{ ...hd, width: "7%" }}>件数</th>
            <th style={{ ...hd, width: "10%" }}>単位数・<br />点数</th>
            <th style={{ ...hd, width: "10%" }}>費用<br />合計</th>
            <th style={{ ...hd, width: "10%" }}>公費<br />請求額</th>
            <th style={{ ...hd, width: "7%" }}>件数</th>
            <th style={{ ...hd, width: "10%" }}>費用<br />合計</th>
            <th style={{ ...hd, width: "10%" }}>公費<br />請求額</th>
          </tr>
        </thead>
        <tbody>
          {publicRows.map((row) => (
            <tr key={row.code} style={{ height: "18px" }}>
              <td style={{ ...hd, fontSize: "7pt" }}>{row.code}</td>
              <td style={{ ...td, fontSize: "5.5pt", lineHeight: 1.1, whiteSpace: "pre-line" }}>{row.label}</td>
              <td style={td}></td>
              <td style={td}></td>
              <td style={td}></td>
              <td style={td}></td>
              <td style={td}></td>
              <td style={td}></td>
              <td style={td}></td>
            </tr>
          ))}
          <tr style={{ height: ROW, fontWeight: "bold" }}>
            <td colSpan={2} style={{ ...hd, fontWeight: "bold" }}>合計</td>
            <td style={td}></td>
            <td style={td}></td>
            <td style={td}></td>
            <td style={td}></td>
            <td style={td}></td>
            <td style={td}></td>
            <td style={tdR}>0</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 区分 ──── */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2 }}>
        <thead>
          <tr>
            <th style={hd} colSpan={2}>区分</th>
            <th style={hd} colSpan={3}>サービス費用</th>
            <th style={hd} colSpan={3}>特定入所者介護サービス費等</th>
          </tr>
          <tr>
            <th style={{ ...hd, width: "4%" }}></th>
            <th style={{ ...hd, width: "18%" }}></th>
            <th style={{ ...hd, width: "7%" }}>件数</th>
            <th style={{ ...hd, width: "10%" }}>単位数・<br />点数</th>
            <th style={{ ...hd, width: "11%" }}>費用<br />合計</th>
            <th style={{ ...hd, width: "7%" }}>件数</th>
            <th style={{ ...hd, width: "10%" }}>費用<br />合計</th>
            <th style={{ ...hd, width: "11%" }}>公費<br />請求額</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: ROW }}>
            <td style={{ ...hd, fontSize: "8pt" }}>43</td>
            <td style={td}>居宅介護支援</td>
            <td style={tdR}>{totalCount}</td>
            <td style={tdR}>{totalUnits.toLocaleString()}</td>
            <td style={tdR}>{totalAmount.toLocaleString()}</td>
            <td style={slashCell}></td>
            <td style={slashCell}></td>
            <td style={slashCell}></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
