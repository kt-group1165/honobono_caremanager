"use client";

import React from "react";

const B = "1px solid #000";
const FONT = '"MS Mincho","游明朝","Hiragino Mincho ProN",serif';

function DigitBoxes({ value, length, small }: { value: string; length: number; small?: boolean }) {
  const digits = value.padEnd(length, " ").slice(0, length).split("");
  const size = small ? 14 : 18;
  return (
    <span style={{ display: "inline-flex" }}>
      {digits.map((d, i) => (
        <span key={i} style={{
          display: "inline-block", width: size, height: size, border: B,
          textAlign: "center", lineHeight: `${size}px`,
          fontSize: small ? "7pt" : "9pt", fontFamily: "monospace",
          marginRight: i < length - 1 ? -1 : 0,
        }}>
          {d.trim()}
        </span>
      ))}
    </span>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

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
    billingMonth,
    totalCount, totalUnits, totalAmount, insuranceAmount, userCopay,
  } = props;

  const cell: React.CSSProperties = {
    border: B, padding: "1px 3px", fontSize: "8pt", verticalAlign: "middle", fontFamily: FONT,
  };
  const th: React.CSSProperties = {
    ...cell, fontWeight: "normal", backgroundColor: "#f8f8f8", textAlign: "center", fontSize: "7pt",
  };
  const tdR: React.CSSProperties = { ...cell, textAlign: "right" };
  const lineH = "22px";

  const bm = (() => {
    const [y, m] = billingMonth.split("-").map(Number);
    if (y >= 2019) return { era: "令和", year: y - 2018, month: m };
    return { era: "平成", year: y - 1988, month: m };
  })();

  // 公費区分の行（居宅介護支援では通常空）
  const publicRows = [
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

  return (
    <div style={{ fontFamily: FONT, fontSize: "8pt", color: "#000", width: "190mm", position: "relative" }}>
      {/* 年月 */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "4px", marginBottom: "2mm" }}>
        <span style={{ border: B, padding: "1px 4px", fontSize: "8pt" }}>
          {bm.era}
          <DigitBoxes value={pad2(bm.year)} length={2} small />年
          <DigitBoxes value={pad2(bm.month)} length={2} small />月分
        </span>
      </div>

      {/* タイトル */}
      <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "13pt", marginBottom: "3mm", letterSpacing: "0.3em" }}>
        介護給付費請求書
      </div>

      {/* 事業所情報（右寄せ） */}
      <table style={{ width: "55%", borderCollapse: "collapse", marginBottom: "3mm", marginLeft: "auto" }}>
        <tbody>
          <tr style={{ height: lineH }}>
            <td style={{ ...th, width: "25%" }}>事業所番号</td>
            <td style={cell}><DigitBoxes value={providerNumber} length={10} /></td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}>名称</td>
            <td style={cell}>{officeName}</td>
          </tr>
          <tr>
            <td style={th}>請求<br />事業所</td>
            <td style={cell}>
              <div>〒{postalCode}　{officeAddress}</div>
            </td>
          </tr>
          <tr style={{ height: lineH }}>
            <td style={th}>連絡先</td>
            <td style={cell}>{officePhone}</td>
          </tr>
        </tbody>
      </table>

      {/* 宛先 */}
      <div style={{ fontSize: "9pt", marginBottom: "2mm" }}>
        <b>保　険　者</b><br />
        <span style={{ marginLeft: "8mm" }}>（別記）殿</span>
      </div>
      <div style={{ fontSize: "8pt", marginBottom: "3mm" }}>
        下記のとおり請求します。　{bm.era}{bm.year}年{bm.month}月　日
      </div>

      {/* ──── 保険請求 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "9pt", marginBottom: "1mm" }}>保険請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "3mm" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: "22%" }}>区分</th>
            <th style={{ ...th, width: "8%" }}>件数</th>
            <th style={{ ...th, width: "12%" }}>単位数・<br />点数</th>
            <th style={{ ...th, width: "13%" }}>費用合計</th>
            <th style={{ ...th, width: "13%" }}>保険<br />請求額</th>
            <th style={{ ...th, width: "8%" }}>公費<br />請求額</th>
            <th style={{ ...th, width: "12%" }}>利用者<br />負担</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: "28px" }}>
            <td style={{ ...cell, fontSize: "6pt", lineHeight: "1.2" }}>
              居宅・総合事業<br />
              介護予防サービス<br />
              地域密着型サービス等
            </td>
            <td style={tdR}>{totalCount}</td>
            <td style={tdR}>{totalUnits.toLocaleString()}</td>
            <td style={tdR}>{totalAmount.toLocaleString()}</td>
            <td style={{ ...tdR, fontWeight: "bold" }}>{insuranceAmount.toLocaleString()}</td>
            <td style={tdR}>0</td>
            <td style={tdR}>{userCopay}</td>
          </tr>
          <tr style={{ height: "28px" }}>
            <td style={{ ...cell, fontSize: "6pt" }}>
              居宅介護支援・<br />介護予防支援
            </td>
            <td style={tdR}></td>
            <td style={tdR}></td>
            <td style={tdR}></td>
            <td style={tdR}></td>
            <td style={tdR}></td>
            <td style={tdR}></td>
          </tr>
          <tr style={{ height: lineH, backgroundColor: "#f0f0f0", fontWeight: "bold" }}>
            <td style={{ ...cell, textAlign: "center", fontWeight: "bold" }}>合計</td>
            <td style={tdR}>{totalCount}</td>
            <td style={tdR}>{totalUnits.toLocaleString()}</td>
            <td style={tdR}>{totalAmount.toLocaleString()}</td>
            <td style={{ ...tdR, color: "#1d4ed8", fontSize: "10pt" }}>{insuranceAmount.toLocaleString()}</td>
            <td style={tdR}>0</td>
            <td style={tdR}>{userCopay}</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 公費請求 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "9pt", marginBottom: "1mm" }}>公費請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "3mm" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: "5%" }} colSpan={2}>区分</th>
            <th style={th} colSpan={3}>サービス費用</th>
            <th style={th} colSpan={3}>特定入所者介護サービス費等</th>
          </tr>
          <tr>
            <th style={{ ...th, width: "5%" }}></th>
            <th style={{ ...th, width: "17%" }}></th>
            <th style={{ ...th, width: "8%" }}>件数</th>
            <th style={{ ...th, width: "12%" }}>単位数・<br />点数</th>
            <th style={{ ...th, width: "12%" }}>費用<br />合計</th>
            <th style={{ ...th, width: "12%" }}>公費<br />請求額</th>
            <th style={{ ...th, width: "8%" }}>件数</th>
            <th style={{ ...th, width: "12%" }}>費用<br />合計</th>
          </tr>
        </thead>
        <tbody>
          {publicRows.map((row) => (
            <tr key={row.code} style={{ height: "16px" }}>
              <td style={{ ...cell, textAlign: "center", fontSize: "7pt" }}>{row.code}</td>
              <td style={{ ...cell, fontSize: "5.5pt", lineHeight: "1.1", whiteSpace: "pre-line" }}>{row.label}</td>
              <td style={cell}></td>
              <td style={cell}></td>
              <td style={cell}></td>
              <td style={cell}></td>
              <td style={cell}></td>
              <td style={cell}></td>
            </tr>
          ))}
          <tr style={{ height: lineH, fontWeight: "bold", backgroundColor: "#f0f0f0" }}>
            <td colSpan={2} style={{ ...cell, textAlign: "center" }}>合計</td>
            <td style={cell}></td>
            <td style={cell}></td>
            <td style={cell}></td>
            <td style={cell}></td>
            <td style={cell}></td>
            <td style={tdR}>0</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 区分 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "9pt", marginBottom: "1mm" }}>区分</div>
      <table style={{ width: "70%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: "8%" }} colSpan={2}>区分</th>
            <th style={th} colSpan={3}>サービス費用</th>
          </tr>
          <tr>
            <th style={{ ...th }}></th>
            <th style={{ ...th, width: "28%" }}></th>
            <th style={{ ...th, width: "10%" }}>件数</th>
            <th style={{ ...th, width: "12%" }}>単位数・<br />点数</th>
            <th style={{ ...th, width: "12%" }}>費用<br />合計</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: lineH }}>
            <td style={{ ...cell, textAlign: "center" }}>43</td>
            <td style={cell}>居宅介護支援</td>
            <td style={tdR}>{totalCount}</td>
            <td style={tdR}>{totalUnits.toLocaleString()}</td>
            <td style={tdR}>{totalAmount.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
