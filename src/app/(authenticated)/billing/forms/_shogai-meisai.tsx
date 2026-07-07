"use client";

/**
 * 障害請求の印刷様式 (billing-visit/shogai-seikyu 画面用)
 *
 *   1. ShogaiMeisaiPrintSheet    — 介護給付費・訓練等給付費等明細書 (様式第二相当、利用者 1 名 = 1 枚)
 *   2. ShogaiSeikyushoPrintSheet — 介護給付費・訓練等給付費等請求書 (様式第一相当、事業所単位の総括 1 枚)
 *   3. ShogaiRiyouSeikyuPrintSheet — 利用料請求書 (利用者向け、上限管理調整後の利用者負担額)
 *
 * 項目は伝送 interface の J121 (明細書情報) / J111 (請求書情報) に対応
 * (migrations/_if_shogai.txt / src/lib/shogai-densou/build.ts 参照)。
 * 枠線・桝目・A4 1 枚・inline style の作りは介護の様式第二 (_meisai.tsx) に倣う。
 */

import React from "react";
import type { ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";

// サービス種類コード (障害福祉サービス)
const SERVICE_TYPE_CODES: Record<string, string> = {
  居宅介護: "11",
  重度訪問介護: "12",
  行動援護: "13",
  同行援護: "14",
};

// ─── 帳票部品 (_meisai.tsx の MeisaiPrintSheet と同じ流儀) ────────────────────

// 桝目 (1 文字 = 1 マス)。右詰めで value を流し込み、余りは空マス
function DigitCells({
  value,
  cells,
  cw = 5,
  h = 6,
}: {
  value: string | null | undefined;
  cells: number;
  /** 1 マスの幅 (mm) */
  cw?: number;
  /** マスの高さ (mm) */
  h?: number;
}) {
  const chars = (value ?? "").padStart(cells, " ").slice(-cells).split("");
  return (
    <span style={{ display: "inline-flex", verticalAlign: "middle" }}>
      {chars.map((c, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: `${cw}mm`,
            height: `${h}mm`,
            border: "0.5pt solid #000",
            marginLeft: i === 0 ? 0 : "-0.5pt",
            textAlign: "center",
            lineHeight: `${h}mm`,
            fontFamily: '"MS Gothic","ＭＳ ゴシック",monospace',
            fontSize: "10pt",
            fontWeight: "bold",
          }}
        >
          {c === " " ? " " : c}
        </span>
      ))}
    </span>
  );
}

// 帳票の見出しセル (ラベル欄)
function Lb({
  children,
  style,
  rowSpan,
  colSpan,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  rowSpan?: number;
  colSpan?: number;
}) {
  return (
    <td
      rowSpan={rowSpan}
      colSpan={colSpan}
      style={{
        border: "0.5pt solid #000",
        padding: "0.8mm 1mm",
        textAlign: "center",
        fontWeight: "normal",
        fontSize: "7.5pt",
        lineHeight: 1.2,
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// 帳票の値セル
function Vc({
  children,
  style,
  rowSpan,
  colSpan,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  rowSpan?: number;
  colSpan?: number;
}) {
  return (
    <td
      rowSpan={rowSpan}
      colSpan={colSpan}
      style={{
        border: "0.5pt solid #000",
        padding: "0.8mm 1mm",
        fontSize: "8pt",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

// 集計欄の行ラベルセル
function AggLb({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        border: "0.5pt solid #000",
        padding: "0.6mm 1mm",
        fontSize: "7pt",
        lineHeight: 1.15,
        verticalAlign: "middle",
        width: "40%",
      }}
    >
      {children}
    </td>
  );
}

// 集計欄の値セル
function AggVc({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        border: "0.5pt solid #000",
        padding: "0.6mm 1.5mm",
        fontSize: "8.5pt",
        fontFamily: '"MS Gothic","ＭＳ ゴシック",monospace',
        textAlign: "right",
        verticalAlign: "middle",
        height: "4.7mm",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

const R2: React.CSSProperties = { textAlign: "right" };
const CT: React.CSSProperties = { textAlign: "center" };

// ════════════════════════════════════════════════════════════════════════════
// 1. 明細書 — 介護給付費・訓練等給付費等明細書 (利用者 1 名 = 1 枚、A4 縦)
// ════════════════════════════════════════════════════════════════════════════

export function ShogaiMeisaiPrintSheet({
  row,
  officeName,
  officeNumber,
  reiwa,
  month,
}: {
  row: ShogaiSeikyuRow;
  officeName: string | null;
  officeNumber: string | null;
  reiwa: number;
  month: number;
}) {
  // J121 集計情報レコードと同じ計算 (build.ts に合わせる)
  const ichiwari = Math.floor(row.totalAmount * 0.1); // 1割相当額
  const jogenChosei = Math.min(row.self_payment_limit, ichiwari); // 上限月額調整
  const hasKanri = row.kanriResult != null;
  // 上限額管理事業所番号: 自事業所管理なら自事業所、他事業所管理なら受給者証の記載
  const kanriOfficeNo =
    row.jogenKanriKubun === "自事業所"
      ? (officeNumber ?? "")
      : row.jogenKanriKubun === "他事業所"
        ? (row.jogenKanriOfficeNumber ?? "")
        : "";
  // サービス種類 (先頭明細の種類で代表。11:居宅介護 等)
  const primaryType = row.details[0]?.service_type ?? "";
  const typeCode = SERVICE_TYPE_CODES[primaryType] ?? "";

  // 明細行 (最低 6 行、空行で枠を埋める)
  const MIN_ROWS = 6;
  const emptyRows = Math.max(0, MIN_ROWS - row.details.length);

  const th: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "0.8mm",
    fontSize: "7pt",
    fontWeight: "normal",
    textAlign: "center",
    lineHeight: 1.15,
    verticalAlign: "middle",
  };

  return (
    <div
      style={{
        pageBreakAfter: "always",
        padding: "6mm 8mm",
        fontFamily: '"MS Mincho","ＭＳ 明朝","游明朝",serif',
        color: "#000",
        fontSize: "8pt",
        lineHeight: 1.3,
        width: "210mm",
        boxSizing: "border-box",
      }}
    >
      {/* ── 標題行 ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: "1.5mm",
        }}
      >
        <div style={{ width: "15%" }} />
        <div style={{ textAlign: "center", flex: 1 }}>
          <div style={{ fontSize: "11pt", fontWeight: "bold", letterSpacing: "1pt" }}>
            介護給付費・訓練等給付費等明細書
          </div>
          <div style={{ fontSize: "6.5pt", marginTop: "0.5mm" }}>
            （居宅介護、重度訪問介護、同行援護、行動援護、重度障害者等包括支援、短期入所、
            <br />
            療養介護、生活介護、施設入所支援、自立訓練、就労移行支援、就労継続支援 等）
          </div>
        </div>
        <div style={{ width: "15%", textAlign: "right", fontSize: "10pt", fontWeight: "bold" }}>
          様式第二
        </div>
      </div>

      {/* ── 最上段: 市町村番号 / 助成自治体番号 / 提供年月 ── */}
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <tbody>
          <tr>
            <td style={{ width: "58%", border: "0.5pt solid #000", padding: "1mm", verticalAlign: "top" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "1.5mm" }}>
                <span style={{ width: "26mm", fontSize: "7.5pt" }}>市町村番号</span>
                <DigitCells value={row.municipality ?? ""} cells={6} cw={5} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "1.5mm", marginTop: "1.5mm" }}>
                <span style={{ width: "26mm", fontSize: "7.5pt" }}>助成自治体番号</span>
                <DigitCells value="" cells={6} cw={5} />
              </div>
            </td>
            <td style={{ width: "42%", border: "0.5pt solid #000", padding: "1mm", verticalAlign: "middle" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "1.5mm" }}>
                <span style={{ fontSize: "8pt" }}>令和</span>
                <DigitCells value={String(reiwa).padStart(2, "0")} cells={2} cw={5} />
                <span style={{ fontSize: "8pt" }}>年</span>
                <DigitCells value={String(month).padStart(2, "0")} cells={2} cw={5} />
                <span style={{ fontSize: "8pt" }}>月分</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── 支給決定障害者等 (左) / 請求事業者 (右) ── */}
      <table
        style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", marginTop: "-0.5pt" }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "13%" }} />
          <col style={{ width: "32%" }} />
          <col style={{ width: "5%" }} />
          <col style={{ width: "13%" }} />
          <col style={{ width: "32%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb rowSpan={4} style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}>
              支給決定障害者等
            </Lb>
            <Lb>
              受給者証
              <br />
              番号
            </Lb>
            <Vc>
              <DigitCells value={row.beneficiary_number ?? ""} cells={10} cw={6} />
            </Vc>
            <Lb rowSpan={4} style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}>
              請求事業者
            </Lb>
            <Lb>
              事業所
              <br />
              番号
            </Lb>
            <Vc>
              <DigitCells value={officeNumber ?? ""} cells={10} cw={6} />
            </Vc>
          </tr>
          <tr>
            <Lb>（フリガナ）</Lb>
            <Vc style={{ fontSize: "7pt", height: "4mm" }}>{row.user_name_kana ?? ""}</Vc>
            <Lb rowSpan={2}>
              事業所
              <br />
              名称
            </Lb>
            <Vc rowSpan={2} style={{ fontWeight: "bold", fontSize: "9pt", verticalAlign: "middle" }}>
              {officeName ?? ""}
            </Vc>
          </tr>
          <tr>
            <Lb>
              支給決定障害
              <br />
              者等氏名
            </Lb>
            <Vc style={{ fontWeight: "bold", fontSize: "10pt" }}>{row.user_name}</Vc>
          </tr>
          <tr>
            <Lb>
              障害支援
              <br />
              区分
            </Lb>
            <Vc style={{ fontWeight: "bold", fontSize: "9pt" }}>{row.support_level ?? ""}</Vc>
            <Lb>
              利用者負担
              <br />
              上限月額
            </Lb>
            <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace', fontWeight: "bold" }}>
              {row.self_payment_limit.toLocaleString()} 円
              {row.seiho ? "（生活保護）" : ""}
            </Vc>
          </tr>
        </tbody>
      </table>

      {/* ── 利用者負担上限額管理 ── */}
      <table
        style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", marginTop: "-0.5pt" }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "18%" }} />
          <col style={{ width: "32%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "15%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb style={{ writingMode: "vertical-rl", fontSize: "6pt" }}>上限額管理</Lb>
            <Lb>
              上限額管理
              <br />
              事業所番号
            </Lb>
            <Vc>
              <DigitCells value={kanriOfficeNo} cells={10} cw={5} h={5} />
            </Vc>
            <Lb>管理結果</Lb>
            <Vc style={{ ...CT, fontFamily: '"MS Gothic",monospace', fontWeight: "bold" }}>
              {hasKanri ? row.kanriResult : ""}
            </Vc>
            <Lb>
              管理結果
              <br />
              額
            </Lb>
            <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
              {hasKanri && row.kanriResultAmount != null
                ? row.kanriResultAmount.toLocaleString()
                : ""}
            </Vc>
          </tr>
        </tbody>
      </table>

      {/* ── 給付費明細欄 ── */}
      <table
        style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", marginTop: "-0.5pt" }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "28%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "19%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={th} rowSpan={2}>
              給付費
              <br />
              明細欄
            </th>
            <th style={th}>サービス内容</th>
            <th style={th}>サービスコード</th>
            <th style={th}>単位数</th>
            <th style={th}>回数</th>
            <th style={th}>
              サービス
              <br />
              単位数
            </th>
            <th style={th}>摘要</th>
          </tr>
        </thead>
        <tbody>
          {row.details.map((d, i) => (
            <tr key={`${d.service_code ?? d.service_type}-${i}`}>
              {i === 0 && (
                <td
                  rowSpan={row.details.length + emptyRows}
                  style={{ border: "0.5pt solid #000" }}
                />
              )}
              <Vc style={{ fontSize: "7.5pt" }}>
                {d.service_type}
                {d.service_category ? ` ${d.service_category}` : ""}
              </Vc>
              <Vc style={{ padding: 0 }}>
                <DigitCells value={d.service_code ?? ""} cells={6} cw={3.5} h={5} />
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {d.unit_per.toLocaleString()}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>{d.count}</Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {d.units.toLocaleString()}
              </Vc>
              <Vc style={{ ...CT, fontSize: "7pt" }}></Vc>
            </tr>
          ))}
          {Array.from({ length: emptyRows }).map((_, i) => (
            <tr key={`empty-${i}`} style={{ height: "4.7mm" }}>
              <Vc></Vc>
              <Vc style={{ padding: 0 }}>
                <DigitCells value="" cells={6} cw={3.5} h={5} />
              </Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
              <Vc></Vc>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── 請求額集計欄 (J121 集計情報レコードの項目順) ── */}
      <table
        style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", marginTop: "-0.5pt" }}
      >
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "45%" }} />
          <col style={{ width: "50%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb rowSpan={10} style={{ writingMode: "vertical-rl", letterSpacing: "1pt" }}>
              請求額集計欄
            </Lb>
            <AggLb>①サービス種類コード／名称</AggLb>
            <AggVc style={{ textAlign: "left", fontFamily: "inherit" }}>
              <span style={{ fontFamily: '"MS Gothic",monospace', fontWeight: "bold" }}>
                {typeCode}
              </span>{" "}
              {primaryType}
            </AggVc>
          </tr>
          <tr>
            <AggLb>②給付単位数</AggLb>
            <AggVc>{row.totalUnits.toLocaleString()}</AggVc>
          </tr>
          <tr>
            <AggLb>③単位数単価</AggLb>
            <AggVc>
              {row.unitPrice.toFixed(2)} <span style={{ fontSize: "7pt" }}>円/単位</span>
            </AggVc>
          </tr>
          <tr>
            <AggLb>④総費用額（②×③）</AggLb>
            <AggVc>{row.totalAmount.toLocaleString()}</AggVc>
          </tr>
          <tr>
            <AggLb>⑤1割相当額</AggLb>
            <AggVc>{ichiwari.toLocaleString()}</AggVc>
          </tr>
          <tr>
            <AggLb>⑥利用者負担上限月額{row.seiho ? "（生活保護 = 負担なし）" : ""}</AggLb>
            <AggVc>{row.self_payment_limit.toLocaleString()}</AggVc>
          </tr>
          <tr>
            <AggLb>⑦上限月額調整（⑤⑥のうち少ない数）</AggLb>
            <AggVc>{jogenChosei.toLocaleString()}</AggVc>
          </tr>
          <tr>
            <AggLb>⑧上限額管理後利用者負担額</AggLb>
            <AggVc>{hasKanri ? row.userAmount.toLocaleString() : ""}</AggVc>
          </tr>
          <tr>
            <AggLb>⑨決定利用者負担額</AggLb>
            <AggVc style={{ fontWeight: "bold" }}>{row.userAmount.toLocaleString()}</AggVc>
          </tr>
          <tr>
            <AggLb>⑩請求額（給付費 ④－⑨）</AggLb>
            <AggVc style={{ fontWeight: "bold" }}>{row.benefitAmount.toLocaleString()}</AggVc>
          </tr>
        </tbody>
      </table>

      {/* ── 枚数 (右下) ── */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5mm" }}>
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <Vc style={{ ...CT, width: "8mm", fontFamily: '"MS Gothic",monospace' }}>1</Vc>
              <Vc style={{ ...CT, width: "12mm", fontSize: "7pt" }}>枚目</Vc>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. 請求書 — 介護給付費・訓練等給付費等請求書 (事業所単位の総括 1 枚)
//    J111 相当 = 市町村ごとの 件数/単位数/総費用額/利用者負担額/給付費請求額
// ════════════════════════════════════════════════════════════════════════════

export interface ShogaiSeikyuSummaryGroup {
  municipality: string | null;
  count: number;
  units: number;
  cost: number;
  userAmt: number;
  benefit: number;
}

export function ShogaiSeikyushoPrintSheet({
  groups,
  officeName,
  officeNumber,
  reiwa,
  month,
}: {
  groups: ShogaiSeikyuSummaryGroup[];
  officeName: string | null;
  officeNumber: string | null;
  reiwa: number;
  month: number;
}) {
  const total = groups.reduce(
    (acc, g) => ({
      count: acc.count + g.count,
      units: acc.units + g.units,
      cost: acc.cost + g.cost,
      userAmt: acc.userAmt + g.userAmt,
      benefit: acc.benefit + g.benefit,
    }),
    { count: 0, units: 0, cost: 0, userAmt: 0, benefit: 0 },
  );

  const th: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "1.2mm 1.5mm",
    fontSize: "8pt",
    fontWeight: "normal",
    textAlign: "center",
    background: "#f5f5f5",
  };
  const td: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "1.2mm 2mm",
    fontSize: "9pt",
    fontFamily: '"MS Gothic","ＭＳ ゴシック",monospace',
    textAlign: "right",
  };

  return (
    <div
      style={{
        pageBreakAfter: "always",
        padding: "10mm 12mm",
        fontFamily: '"MS Mincho","ＭＳ 明朝","游明朝",serif',
        color: "#000",
        fontSize: "9pt",
        lineHeight: 1.4,
        width: "210mm",
        boxSizing: "border-box",
      }}
    >
      {/* ── 標題 ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: "3mm",
        }}
      >
        <div style={{ width: "15%" }} />
        <div style={{ textAlign: "center", flex: 1, fontSize: "13pt", fontWeight: "bold", letterSpacing: "2pt" }}>
          介護給付費・訓練等給付費等請求書
        </div>
        <div style={{ width: "15%", textAlign: "right", fontSize: "10pt", fontWeight: "bold" }}>
          様式第一
        </div>
      </div>

      <div style={{ textAlign: "right", fontSize: "10pt", marginBottom: "2mm" }}>
        令和{reiwa}年{month}月分
      </div>

      {/* ── 宛先 / 請求事業者 ── */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4mm" }}>
        <div style={{ fontSize: "10pt", paddingTop: "3mm" }}>
          （請求先）各市町村長　殿
          <div style={{ fontSize: "7.5pt", marginTop: "2mm", color: "#000" }}>
            下記のとおり請求します。
          </div>
        </div>
        <table style={{ borderCollapse: "collapse", width: "80mm" }}>
          <tbody>
            <tr>
              <Lb style={{ width: "24mm" }}>事業所番号</Lb>
              <Vc style={{ fontFamily: '"MS Gothic",monospace', fontWeight: "bold", fontSize: "9pt" }}>
                {officeNumber ?? ""}
              </Vc>
            </tr>
            <tr>
              <Lb>
                事業者及び
                <br />
                その事業所の名称
              </Lb>
              <Vc style={{ fontWeight: "bold", fontSize: "9pt" }}>{officeName ?? ""}</Vc>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── 請求金額 (給付費請求額 合計) ── */}
      <div style={{ marginBottom: "4mm" }}>
        <span
          style={{
            border: "1pt solid #000",
            padding: "2mm 6mm",
            fontSize: "12pt",
            fontWeight: "bold",
          }}
        >
          請求金額　{total.benefit.toLocaleString()} 円
        </span>
      </div>

      {/* ── 市町村別 総括表 (J111 相当) ── */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>市町村番号</th>
            <th style={th}>件数</th>
            <th style={th}>単位数</th>
            <th style={th}>総費用額</th>
            <th style={th}>利用者負担額</th>
            <th style={th}>給付費請求額</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g, i) => (
            <tr key={`${g.municipality ?? ""}-${i}`}>
              <td style={{ ...td, textAlign: "center" }}>{g.municipality ?? "（未設定）"}</td>
              <td style={td}>{g.count.toLocaleString()}</td>
              <td style={td}>{g.units.toLocaleString()}</td>
              <td style={td}>{g.cost.toLocaleString()}</td>
              <td style={td}>{g.userAmt.toLocaleString()}</td>
              <td style={td}>{g.benefit.toLocaleString()}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: "bold" }}>
            <td style={{ ...td, textAlign: "center", background: "#f5f5f5", fontFamily: "inherit" }}>
              合計
            </td>
            <td style={td}>{total.count.toLocaleString()}</td>
            <td style={td}>{total.units.toLocaleString()}</td>
            <td style={td}>{total.cost.toLocaleString()}</td>
            <td style={td}>{total.userAmt.toLocaleString()}</td>
            <td style={{ ...td, fontWeight: "bold" }}>{total.benefit.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>

      <p style={{ marginTop: "4mm", fontSize: "7.5pt" }}>
        ※ 障害福祉サービス (介護給付費等)。件数・単位数・金額は明細書 (J121 相当) の集計値。
      </p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. 利用料請求書 — 利用者向け (上限管理調整後の利用者負担額を請求)
//    riyou-seikyu の RiyouSeikyuPrintSheet に倣う (利用者 1 名 = 1 枚)
// ════════════════════════════════════════════════════════════════════════════

export function ShogaiRiyouSeikyuPrintSheet({
  row,
  officeName,
  reiwa,
  month,
}: {
  row: ShogaiSeikyuRow;
  officeName: string | null;
  reiwa: number;
  month: number;
}) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  return (
    <div className="p-10 text-black" style={{ pageBreakAfter: "always" }}>
      <h1 className="mb-8 text-center text-2xl font-bold tracking-[0.5em]">
        利用料請求書
      </h1>

      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="inline-block border-b border-black pb-1 pr-12 text-lg">
            {row.user_name} 様
          </p>
          <p className="mt-3 text-sm">
            令和{reiwa}年{month}月分の障害福祉サービス利用料を下記のとおりご請求申し上げます。
          </p>
        </div>
        <div className="text-right text-sm leading-6">
          <p>発行日: {issueDate}</p>
          <p className="mt-3 font-medium">{officeName ?? ""}</p>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <span className="border border-black px-4 py-2 text-lg font-bold">
          ご請求金額 ¥{row.userAmount.toLocaleString()} －
        </span>
        <span className="text-xs">(消費税: 非課税)</span>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1.5 text-left">項目</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">総費用額</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">負担上限月額</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">金額</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1.5">
              障害福祉サービス利用者負担額
              {row.kanriResult != null && row.kanriResult !== 2 ? " (上限管理調整後)" : ""}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{row.totalAmount.toLocaleString()}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{row.self_payment_limit.toLocaleString()}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{row.userAmount.toLocaleString()}
            </td>
          </tr>
          <tr className="font-bold">
            <td className="border border-black px-2 py-1.5" colSpan={3}>
              合計
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              ¥{row.userAmount.toLocaleString()}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="mt-6 text-xs text-gray-700">
        ※ 本請求は障害福祉サービス利用に伴う利用者負担分です (総単位数{" "}
        {row.totalUnits.toLocaleString()} 単位、単価 {row.unitPrice.toFixed(2)} 円/単位
        {row.seiho ? "、生活保護受給のため負担なし" : ""})。
      </p>
    </div>
  );
}
