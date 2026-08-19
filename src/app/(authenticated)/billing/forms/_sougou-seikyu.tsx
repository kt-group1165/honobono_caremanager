"use client";

/**
 * 介護予防・日常生活支援総合事業費請求書 (伝送 7113 に対応する紙様式)。
 *
 * 介護給付の様式第一 (_seikyu.tsx) と対になる総合事業版。桝・罫線の流儀は
 * _seikyu.tsx に合わせている (MS 明朝 / 桝目の D コンポーネント)。
 *
 * 7113 の項目 (IF仕様書 サービス事業所編 R5.4版 / migrations/_if_form2.txt 7443行〜):
 *   保険・公費等区分コード / 法別番号 / 請求情報区分コード /
 *   件数・単位数・費用合計・事業費請求額・公費請求額・利用者負担
 *
 * 「保険請求額」ではなく「事業費請求額」なのが介護給付との最大の違い
 * (総合事業は保険給付でなく市町村の事業費)。
 */

import React from "react";

const F = '"MS Mincho","ＭＳ 明朝","游明朝",serif';
const B = "1px solid #333";
const B2 = "1.5px solid #000";
const BG = "#f5f5f5";

/** 桝目 (1 文字 1 マス) */
function D({ v, n, s = 16 }: { v: string; n: number; s?: number }) {
  const cs = v.padEnd(n, " ").slice(0, n).split("");
  return (
    <span style={{ display: "inline-flex" }}>
      {cs.map((c, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: s,
            height: s + 1,
            border: B,
            textAlign: "center",
            lineHeight: `${s + 1}px`,
            fontSize: s > 14 ? "9pt" : "7pt",
            fontFamily: "monospace",
            marginRight: -1,
            background: "#fff",
          }}
        >
          {c.trim()}
        </span>
      ))}
    </span>
  );
}

function p(n: number) {
  return String(n).padStart(2, "0");
}

/** 公費請求欄の 1 行 (法別番号ごと) */
export interface SougouKohiRow {
  /** 法別番号 (12=生保 等) */
  code: string;
  count: number;
  units: number;
  cost: number;
  kohi: number;
}

interface Props {
  /** 総合事業の事業所番号 (介護保険と別番号のことがある) */
  providerNumber: string;
  officeName: string;
  officeAddress: string;
  officePhone: string;
  postalCode: string;
  /** 'YYYY-MM' (提供年月) */
  billingMonth: string;
  /** サービス費用 (事業費請求分) */
  totalCount: number;
  totalUnits: number;
  totalAmount: number;
  /** 事業費請求額 (介護給付の「保険請求額」に相当) */
  jigyohiAmount: number;
  /** 公費請求額 (サービス費用行の再掲元) */
  kohiRequestAmount: number;
  userCopay: number;
  /** 公費請求テーブルの明細 (法別番号ごと)。既定 [] = 全行空欄 */
  kohiRows?: SougouKohiRow[];
}

export function SougouSeikyuForm(props: Props) {
  const {
    providerNumber,
    officeName,
    officeAddress,
    officePhone,
    postalCode,
    billingMonth,
    totalCount,
    totalUnits,
    totalAmount,
    jigyohiAmount,
    kohiRequestAmount,
    userCopay,
    kohiRows = [],
  } = props;

  const h: React.CSSProperties = {
    border: B,
    padding: "1px 2px",
    fontSize: "6.5pt",
    verticalAlign: "middle",
    fontFamily: F,
    background: BG,
    textAlign: "center",
    lineHeight: 1.15,
  };
  const c: React.CSSProperties = {
    border: B,
    padding: "1px 3px",
    fontSize: "7.5pt",
    verticalAlign: "middle",
    fontFamily: F,
    background: "#fff",
  };
  const cR: React.CSSProperties = { ...c, textAlign: "right" };
  const num = (n: number) => (n === 0 ? "0" : n.toLocaleString());

  const bm = (() => {
    const [y, m] = billingMonth.split("-").map(Number);
    return y >= 2019
      ? { era: "令和", y: y - 2018, m }
      : { era: "平成", y: y - 1988, m };
  })();

  const kohiByCode = new Map(kohiRows.map((k) => [k.code, k]));
  const kohiTotal = {
    count: kohiRows.reduce((s, k) => s + k.count, 0),
    units: kohiRows.reduce((s, k) => s + k.units, 0),
    cost: kohiRows.reduce((s, k) => s + k.cost, 0),
    kohi: kohiRows.reduce((s, k) => s + k.kohi, 0),
  };

  // 総合事業で実際に出うる公費 (生保・中国残留邦人等)。
  // 介護給付の様式第一のような医療系公費は総合事業の対象外なので載せない。
  const publicRows = [
    { code: "12", label: "生保\n介護予防・日常生活\n支援総合事業" },
    { code: "25", label: "中国残留邦人等" },
  ];

  return (
    <div
      className="sougou-seikyu-print-sheet"
      style={{ fontFamily: F, fontSize: "7.5pt", color: "#000", width: "195mm" }}
    >
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 0; }
          .sougou-seikyu-print-sheet { page-break-after: always; break-after: page; }
          .sougou-seikyu-print-sheet:last-child { page-break-after: auto; break-after: auto; }
        }
      `}</style>

      {/* ──── ヘッダ: 年月 / タイトル / 様式番号 ──── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "1mm",
        }}
      >
        <div
          style={{
            border: B2,
            padding: "2px 5px",
            fontSize: "8pt",
            whiteSpace: "nowrap",
          }}
        >
          {bm.era}
          <D v={p(bm.y)} n={2} s={14} />年<D v={p(bm.m)} n={2} s={14} />月分
        </div>
        <div
          style={{
            fontWeight: "bold",
            fontSize: "12pt",
            letterSpacing: "0.15em",
            marginTop: "1mm",
            textAlign: "center",
          }}
        >
          介護予防・日常生活支援総合事業費請求書
        </div>
        <div style={{ fontSize: "8pt", whiteSpace: "nowrap", marginTop: "0.5mm" }}>
          様式第一の二
        </div>
      </div>

      {/* ──── 事業所情報 ──── */}
      <table
        style={{
          width: "56%",
          borderCollapse: "collapse",
          border: B2,
          marginBottom: "2mm",
          marginLeft: "auto",
        }}
      >
        <tbody>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, width: "22%" }}>事業所番号</td>
            <td style={c}>
              <D v={providerNumber} n={10} />
            </td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={h} rowSpan={3}>
              請求
              <br />
              事業所
            </td>
            <td style={{ ...c, fontWeight: "bold" }}>
              <span
                style={{
                  fontSize: "6pt",
                  fontWeight: "normal",
                  marginRight: "3mm",
                }}
              >
                名称
              </span>
              {officeName}
            </td>
          </tr>
          <tr>
            <td style={{ ...c, fontSize: "7pt", lineHeight: 1.3 }}>
              <span style={{ fontSize: "6pt", marginRight: "3mm" }}>所在地</span>〒
              {postalCode}
              <br />
              <span style={{ paddingLeft: "10mm" }}>{officeAddress}</span>
            </td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={c}>
              <span style={{ fontSize: "6pt", marginRight: "3mm" }}>連絡先</span>
              {officePhone}
            </td>
          </tr>
        </tbody>
      </table>

      {/* ──── 宛先 ──── */}
      <div
        style={{ fontSize: "9pt", marginBottom: "1mm", letterSpacing: "0.5em" }}
      >
        <b>保険者</b>
      </div>
      <div style={{ fontSize: "8pt", marginBottom: "1mm", paddingLeft: "8mm" }}>
        （　別　記　）殿
      </div>
      <div style={{ fontSize: "7.5pt", marginBottom: "2mm" }}>
        下記のとおり請求します。　{bm.era}
        {bm.y}年{bm.m}月14日
      </div>

      {/* ──── 事業費請求 ──── */}
      <div
        style={{ fontWeight: "bold", fontSize: "8.5pt", marginBottom: "0.5mm" }}
      >
        事業費請求
      </div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          border: B2,
          marginBottom: "3mm",
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            <th style={{ ...h, width: "28%" }} rowSpan={2}>
              区分
            </th>
            <th style={h} colSpan={6}>
              サービス費用
            </th>
          </tr>
          <tr>
            <th style={{ ...h, width: "10%" }}>件数</th>
            <th style={{ ...h, width: "12%" }}>
              単位数・
              <br />
              点数
            </th>
            <th style={{ ...h, width: "12.5%" }}>
              費用
              <br />
              合計
            </th>
            <th style={{ ...h, width: "12.5%" }}>
              事業費
              <br />
              請求額
            </th>
            <th style={{ ...h, width: "12.5%" }}>
              公費
              <br />
              請求額
            </th>
            <th style={{ ...h, width: "12.5%" }}>
              利用者
              <br />
              負担
            </th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: 26 }}>
            <td style={{ ...c, fontSize: "7pt" }}>
              介護予防・日常生活支援総合事業
            </td>
            <td style={cR}>{num(totalCount)}</td>
            <td style={cR}>{num(totalUnits)}</td>
            <td style={cR}>{num(totalAmount)}</td>
            <td style={{ ...cR, fontWeight: "bold" }}>{num(jigyohiAmount)}</td>
            <td style={cR}>{num(kohiRequestAmount)}</td>
            <td style={cR}>{num(userCopay)}</td>
          </tr>
          <tr style={{ height: 24 }}>
            <td style={{ ...c, ...h, fontSize: "7pt" }}>合計</td>
            <td style={cR}>{num(totalCount)}</td>
            <td style={cR}>{num(totalUnits)}</td>
            <td style={cR}>{num(totalAmount)}</td>
            <td style={{ ...cR, fontWeight: "bold" }}>{num(jigyohiAmount)}</td>
            <td style={cR}>{num(kohiRequestAmount)}</td>
            <td style={cR}>{num(userCopay)}</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 公費請求 (保険 (事業費) 請求の再掲) ──── */}
      <div
        style={{ fontWeight: "bold", fontSize: "8.5pt", marginBottom: "0.5mm" }}
      >
        公費請求
      </div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          border: B2,
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            <th style={{ ...h, width: "28%" }} rowSpan={2}>
              区分
            </th>
            <th style={h} colSpan={4}>
              サービス費用
            </th>
          </tr>
          <tr>
            <th style={{ ...h, width: "18%" }}>件数</th>
            <th style={{ ...h, width: "18%" }}>
              単位数・
              <br />
              点数
            </th>
            <th style={{ ...h, width: "18%" }}>
              費用
              <br />
              合計
            </th>
            <th style={{ ...h, width: "18%" }}>
              公費
              <br />
              請求額
            </th>
          </tr>
        </thead>
        <tbody>
          {publicRows.map((r) => {
            const k = kohiByCode.get(r.code);
            return (
              <tr key={r.code} style={{ height: 22 }}>
                <td style={{ ...c, fontSize: "6.5pt", whiteSpace: "pre-line" }}>
                  {r.label}
                </td>
                <td style={cR}>{k ? num(k.count) : ""}</td>
                <td style={cR}>{k ? num(k.units) : ""}</td>
                <td style={cR}>{k ? num(k.cost) : ""}</td>
                <td style={cR}>{k ? num(k.kohi) : ""}</td>
              </tr>
            );
          })}
          <tr style={{ height: 22 }}>
            <td style={{ ...c, ...h, fontSize: "7pt" }}>合計</td>
            <td style={cR}>{kohiTotal.count ? num(kohiTotal.count) : ""}</td>
            <td style={cR}>{kohiTotal.units ? num(kohiTotal.units) : ""}</td>
            <td style={cR}>{kohiTotal.cost ? num(kohiTotal.cost) : ""}</td>
            <td style={cR}>{kohiTotal.kohi ? num(kohiTotal.kohi) : ""}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
