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

// 公費請求テーブルの明細 (法別番号ごと)。省略時は全行空欄 (居宅介護支援の既定)。
export interface SeikyuKohiRow {
  code: string; // 法別番号 (12=生保 等)
  count: number; // 件数
  units: number; // 単位数・点数
  cost: number; // 費用合計
  kohi: number; // 公費請求額
}

interface Props {
  providerNumber: string; officeName: string; officeAddress: string;
  officePhone: string; postalCode: string; billingMonth: string;
  totalCount: number; totalUnits: number; totalAmount: number;
  insuranceAmount: number; userCopay: number;
  /** 保険請求の区分ラベル。既定=居宅介護支援。訪問介護等は別ラベルを渡す */
  kubunLabel?: string;
  /** 保険請求 公費請求額 合計 (生保等)。既定 0 */
  kohiRequestAmount?: number;
  /** 公費請求テーブルの明細 (法別番号ごと)。既定 [] = 全行空欄 */
  kohiRows?: SeikyuKohiRow[];
}

export function SeikyuForm(props: Props) {
  const {
    providerNumber, officeName, officeAddress, officePhone, postalCode,
    billingMonth, totalCount, totalUnits, totalAmount, insuranceAmount, userCopay,
    kohiRequestAmount = 0,
    kohiRows = [],
  } = props;
  const kohiByCode = new Map(kohiRows.map((k) => [k.code, k]));
  const kohiTotal = {
    count: kohiRows.reduce((s, k) => s + k.count, 0),
    units: kohiRows.reduce((s, k) => s + k.units, 0),
    cost: kohiRows.reduce((s, k) => s + k.cost, 0),
    kohi: kohiRows.reduce((s, k) => s + k.kohi, 0),
  };

  // ── 桝・罫線・セル共通スタイル ──
  const h: React.CSSProperties = { border: B, padding: "1px 2px", fontSize: "6pt", verticalAlign: "middle", fontFamily: F, background: BG, textAlign: "center", lineHeight: 1.15 };
  const c: React.CSSProperties = { border: B, padding: "1px 3px", fontSize: "7.5pt", verticalAlign: "middle", fontFamily: F, background: "#fff" };
  const cR: React.CSSProperties = { ...c, textAlign: "right" };
  const num = (n: number) => (n === 0 ? "0" : n.toLocaleString());

  const bm = (() => {
    const [y, m] = billingMonth.split("-").map(Number);
    return y >= 2019 ? { era: "令和", y: y - 2018, m } : { era: "平成", y: y - 1988, m };
  })();

  // ── 保険請求 サービス費用 行データ ──
  // ① 居宅・施設サービス等 に受領した単一区分の実績を入れる。② 居宅介護支援・介護予防支援 は 0。
  const svc1 = {
    count: totalCount, units: totalUnits, cost: totalAmount,
    hoken: insuranceAmount, kohi: kohiRequestAmount, user: userCopay,
  };
  const svc2 = { count: 0, units: 0, cost: 0, hoken: 0, kohi: 0, user: 0 };
  const svcTotal = {
    count: svc1.count + svc2.count, units: svc1.units + svc2.units,
    cost: svc1.cost + svc2.cost, hoken: svc1.hoken + svc2.hoken,
    kohi: svc1.kohi + svc2.kohi, user: svc1.user + svc2.user,
  };

  const publicRows = [
    { code: "12", label: "生保\n居宅・施設サービス\n介護予防サービス\n地域密着型サービス等" },
    { code: "12", label: "生保\n居宅介護支援・\n居宅予防支援", key: "12b" },
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
      {/* ──── ヘッダ: 年月（左上） / タイトル / 様式第一（右上） ──── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1mm" }}>
        <div style={{ border: B2, padding: "2px 5px", fontSize: "8pt", whiteSpace: "nowrap" }}>
          {bm.era}<D v={p(bm.y)} n={2} s={14} />年<D v={p(bm.m)} n={2} s={14} />月分
        </div>
        <div style={{ fontWeight: "bold", fontSize: "13pt", letterSpacing: "0.3em", marginTop: "1mm" }}>
          介護給付費請求書
        </div>
        <div style={{ fontSize: "8pt", whiteSpace: "nowrap", marginTop: "0.5mm" }}>様式第一</div>
      </div>

      {/* ──── 事業所情報（右寄せ） ──── */}
      <table style={{ width: "56%", borderCollapse: "collapse", border: B2, marginBottom: "2mm", marginLeft: "auto" }}>
        <tbody>
          <tr style={{ height: 20 }}>
            <td style={{ ...h, width: "22%" }}>事業所番号</td>
            <td style={c}><D v={providerNumber} n={10} /></td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={h} rowSpan={3}>請求<br />事業所</td>
            <td style={{ ...c, fontWeight: "bold" }}>
              <span style={{ fontSize: "6pt", fontWeight: "normal", marginRight: "3mm" }}>名称</span>{officeName}
            </td>
          </tr>
          <tr>
            <td style={{ ...c, fontSize: "7pt", lineHeight: 1.3 }}>
              <span style={{ fontSize: "6pt", marginRight: "3mm" }}>所在地</span>〒{postalCode}<br />
              <span style={{ paddingLeft: "10mm" }}>{officeAddress}</span>
            </td>
          </tr>
          <tr style={{ height: 18 }}>
            <td style={c}>
              <span style={{ fontSize: "6pt", marginRight: "3mm" }}>連絡先</span>{officePhone}
            </td>
          </tr>
        </tbody>
      </table>

      {/* ──── 宛先 ──── */}
      <div style={{ fontSize: "9pt", marginBottom: "1mm", letterSpacing: "0.5em" }}><b>保険者</b></div>
      <div style={{ fontSize: "8pt", marginBottom: "1mm", paddingLeft: "8mm" }}>（　別　記　）殿</div>
      <div style={{ fontSize: "7.5pt", marginBottom: "2mm" }}>
        下記のとおり請求します。　{bm.era}{bm.y}年{bm.m}月14日
      </div>

      {/* ──── 保険請求 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "8.5pt", marginBottom: "0.5mm" }}>保険請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, marginBottom: "3mm", tableLayout: "fixed" }}>
        <thead>
          <tr>
            <th style={{ ...h, width: "17%" }} rowSpan={2}>区分</th>
            <th style={h} colSpan={6}>サービス費用</th>
            <th style={h} colSpan={5}>特定入所者介護サービス費等</th>
          </tr>
          <tr>
            <th style={{ ...h, width: "5.5%" }}>件数</th>
            <th style={{ ...h, width: "8%" }}>単位数・<br />点数</th>
            <th style={{ ...h, width: "8%" }}>費用<br />合計</th>
            <th style={{ ...h, width: "8%" }}>保険<br />請求額</th>
            <th style={{ ...h, width: "8%" }}>公費<br />請求額</th>
            <th style={{ ...h, width: "8%" }}>利用者<br />負担</th>
            <th style={{ ...h, width: "5.5%" }}>件数</th>
            <th style={{ ...h, width: "7%" }}>費用<br />合計</th>
            <th style={{ ...h, width: "7%" }}>利用者<br />負担</th>
            <th style={{ ...h, width: "7%" }}>公費<br />請求額</th>
            <th style={{ ...h, width: "7%" }}>保険<br />請求額</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: 30 }}>
            <td style={{ ...c, fontSize: "6pt", lineHeight: 1.2, whiteSpace: "pre-line" }}>
              {"居宅・施設サービス\n介護予防サービス\n地域密着型サービス等"}
            </td>
            <td style={cR}>{svc1.count}</td>
            <td style={cR}>{num(svc1.units)}</td>
            <td style={cR}>{num(svc1.cost)}</td>
            <td style={{ ...cR, fontWeight: "bold" }}>{num(svc1.hoken)}</td>
            <td style={cR}>{num(svc1.kohi)}</td>
            <td style={cR}>{num(svc1.user)}</td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
          </tr>
          <tr style={{ height: 24 }}>
            <td style={{ ...c, fontSize: "6pt", lineHeight: 1.2, whiteSpace: "pre-line" }}>
              {"居宅介護支援・\n介護予防支援"}
            </td>
            <td style={cR}>{svc2.count}</td>
            <td style={cR}>{num(svc2.units)}</td>
            <td style={cR}>{num(svc2.cost)}</td>
            <td style={cR}>{num(svc2.hoken)}</td>
            <td style={cR}>{num(svc2.kohi)}</td>
            <td style={cR}>{num(svc2.user)}</td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
            <td style={SLASH}></td>
          </tr>
          <tr style={{ height: 24, fontWeight: "bold" }}>
            <td style={{ ...h, fontWeight: "bold", fontSize: "8pt" }}>合計</td>
            <td style={cR}>{svcTotal.count}</td>
            <td style={cR}>{num(svcTotal.units)}</td>
            <td style={cR}>{num(svcTotal.cost)}</td>
            <td style={{ ...cR, fontWeight: "bold" }}>{num(svcTotal.hoken)}</td>
            <td style={cR}>{num(svcTotal.kohi)}</td>
            <td style={cR}>{num(svcTotal.user)}</td>
            <td style={cR}>0</td>
            <td style={cR}>0</td>
            <td style={cR}>0</td>
            <td style={cR}>0</td>
            <td style={cR}>0</td>
          </tr>
        </tbody>
      </table>

      {/* ──── 公費請求 ──── */}
      <div style={{ fontWeight: "bold", fontSize: "8.5pt", marginBottom: "0.5mm" }}>公費請求</div>
      <table style={{ width: "100%", borderCollapse: "collapse", border: B2, tableLayout: "fixed" }}>
        <thead>
          <tr>
            <th style={h} colSpan={2} rowSpan={2}>区分</th>
            <th style={h} colSpan={4}>サービス費用</th>
            <th style={h} colSpan={3}>特定入所者介護サービス費等</th>
          </tr>
          <tr>
            <th style={{ ...h, width: "6%" }}>件数</th>
            <th style={{ ...h, width: "11%" }}>単位数・<br />点数</th>
            <th style={{ ...h, width: "11%" }}>費用<br />合計</th>
            <th style={{ ...h, width: "11%" }}>公費<br />請求額</th>
            <th style={{ ...h, width: "6%" }}>件数</th>
            <th style={{ ...h, width: "11%" }}>費用<br />合計</th>
            <th style={{ ...h, width: "11%" }}>公費<br />請求額</th>
          </tr>
        </thead>
        <tbody>
          {publicRows.map((row, idx) => {
            const rowKey = row.key ?? row.code;
            // 法別行の明細は最初の 12 (居宅・施設サービス等) 行のみに反映。他は空欄。
            const k = !row.key && idx === 0 ? kohiByCode.get(row.code) : undefined;
            return (
              <tr key={rowKey} style={{ height: 18 }}>
                <td style={{ ...h, width: "5%", fontSize: "7pt" }}>{row.key ? "" : row.code}</td>
                <td style={{ ...c, width: "14%", fontSize: "5pt", lineHeight: 1.1, whiteSpace: "pre-line" }}>{row.label}</td>
                <td style={cR}>{k ? k.count : ""}</td>
                <td style={cR}>{k ? k.units.toLocaleString() : ""}</td>
                <td style={cR}>{k ? k.cost.toLocaleString() : ""}</td>
                <td style={cR}>{k ? k.kohi.toLocaleString() : ""}</td>
                <td style={SLASH}></td><td style={SLASH}></td><td style={SLASH}></td>
              </tr>
            );
          })}
          <tr style={{ height: 20, fontWeight: "bold" }}>
            <td colSpan={2} style={{ ...h, fontWeight: "bold", fontSize: "8pt" }}>合計</td>
            <td style={cR}>{kohiTotal.count || ""}</td>
            <td style={cR}>{kohiTotal.units ? kohiTotal.units.toLocaleString() : ""}</td>
            <td style={cR}>{kohiTotal.cost ? kohiTotal.cost.toLocaleString() : ""}</td>
            <td style={cR}>{kohiTotal.kohi ? kohiTotal.kohi.toLocaleString() : ""}</td>
            <td style={SLASH}></td><td style={SLASH}></td><td style={cR}>0</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
