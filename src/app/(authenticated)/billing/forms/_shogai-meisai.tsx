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
import { decisionCode, type ShogaiDensouVisit } from "@/lib/shogai-densou/build";
import { DECISION_CODES, type ShogaiContract } from "@/lib/shogai-densou/contracts";

// サービス種類コード (障害福祉サービス)
const SERVICE_TYPE_CODES: Record<string, string> = {
  居宅介護: "11",
  重度訪問介護: "12",
  行動援護: "13",
  同行援護: "14",
};

// サービス種類コード → 種類名 (処遇改善加算行の表示用 逆引き)
const SERVICE_TYPE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SERVICE_TYPE_CODES).map(([name, code]) => [code, name]),
);

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
  const ichiwari = Math.floor(row.totalAmount / 10); // 1割相当額 (整数演算)
  // 上限月額調整 = min(①,②)。上限未設定 (null) は調整なし = 1割相当額
  const jogenChosei =
    row.self_payment_limit != null
      ? Math.min(row.self_payment_limit, ichiwari)
      : ichiwari;
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

  // 明細行 = 所定明細 + 処遇改善加算行 (最低 6 行、空行で枠を埋める)
  const MIN_ROWS = 6;
  const bodyRows = row.details.length + row.addons.length;
  const emptyRows = Math.max(0, MIN_ROWS - bodyRows);

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
              {row.self_payment_limit != null
                ? `${row.self_payment_limit.toLocaleString()} 円`
                : "未設定"}
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
                  rowSpan={bodyRows + emptyRows}
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
          {/* 処遇改善加算等 (月次加算、回数 1) — J121 明細情報レコードと同じ行構成 */}
          {row.addons.map((a) => (
            <tr key={`addon-${a.service_code}`}>
              {row.details.length === 0 && (
                <td rowSpan={bodyRows + emptyRows} style={{ border: "0.5pt solid #000" }} />
              )}
              <Vc style={{ fontSize: "7.5pt" }}>
                {SERVICE_TYPE_NAMES[a.service_code.slice(0, 2)] ?? ""} {a.service_name}
              </Vc>
              <Vc style={{ padding: 0 }}>
                <DigitCells value={a.service_code} cells={6} cw={3.5} h={5} />
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {a.units.toLocaleString()}
              </Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>1</Vc>
              <Vc style={{ ...R2, fontFamily: '"MS Gothic",monospace' }}>
                {a.units.toLocaleString()}
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
            <AggVc>
              {row.self_payment_limit != null
                ? row.self_payment_limit.toLocaleString()
                : ""}
            </AggVc>
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
              {row.self_payment_limit != null
                ? `¥${row.self_payment_limit.toLocaleString()}`
                : "未設定"}
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

// ════════════════════════════════════════════════════════════════════════════
// 4. サービス提供実績記録票 — 居宅介護 (様式1、利用者 1 名 = 1 枚)
//    項目は伝送 J611 (基本情報 = 合計1〜5 / 明細情報 = 日別提供実績) に対応
//    (migrations/_if_shogai.txt 参照)。データは shogai_service_records の月実績。
// ════════════════════════════════════════════════════════════════════════════

// 決定サービスコード → 合計欄の区分名 (J611 合計1〜5 と同じ並び)
const KIROKU_SLOTS: { code: string; label: string; isCount: boolean }[] = [
  { code: "111000", label: "身体介護", isCount: false },
  { code: "113000", label: "通院介助(伴う)", isCount: false },
  { code: "112000", label: "家事援助", isCount: false },
  { code: "114000", label: "通院介助(伴わない)", isCount: false },
  { code: "115000", label: "通院等乗降介助", isCount: true },
];

const DECISION_NAMES: Record<string, string> = Object.fromEntries(
  KIROKU_SLOTS.map((s) => [s.code, s.label]),
);

/** 分 → 時間数 (小数2桁、例 90分 → "1.5") */
function fmtHours(mins: number): string {
  const h = Math.round((mins / 60) * 100) / 100;
  return String(h);
}

export function ShogaiJissekiKirokuhyoPrintSheet({
  row,
  visits,
  officeName,
  officeNumber,
  reiwa,
  month,
}: {
  row: ShogaiSeikyuRow;
  visits: ShogaiDensouVisit[];
  officeName: string | null;
  officeNumber: string | null;
  reiwa: number;
  month: number;
}) {
  const dow = (d: string) => "日月火水木金土"[new Date(d + "T00:00:00").getDay()];
  const hm = (t: string | null) => (t ? t.slice(0, 5) : "");
  const sorted = [...visits].sort((a, b) =>
    (a.date + (a.startTime ?? "")).localeCompare(b.date + (b.startTime ?? "")),
  );
  // 合計 (J611 基本情報 合計1〜5): 乗降 = 回数、それ以外 = 算定時間数計
  const totals = new Map<string, { mins: number; count: number }>();
  for (const v of sorted) {
    const code = decisionCode(v.category, v.serviceName, v.serviceCode);
    const t = totals.get(code) ?? { mins: 0, count: 0 };
    t.mins += v.durationMinutes ?? 0;
    t.count += 1;
    totals.set(code, t);
  }
  const totalMins = sorted
    .filter((v) => decisionCode(v.category, v.serviceName, v.serviceCode) !== "115000")
    .reduce((s, v) => s + (v.durationMinutes ?? 0), 0);

  const thc: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "0.8mm",
    fontSize: "7pt",
    fontWeight: "normal",
    textAlign: "center",
    lineHeight: 1.15,
    verticalAlign: "middle",
    background: "#f5f5f5",
  };
  const tdc: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "0.8mm 1mm",
    fontSize: "7.5pt",
    textAlign: "center",
    verticalAlign: "middle",
    fontFamily: '"MS Gothic","ＭＳ ゴシック",monospace',
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
        <div style={{ width: "20%", fontSize: "8pt" }}>
          令和{reiwa}年{month}月分
        </div>
        <div
          style={{
            textAlign: "center",
            flex: 1,
            fontSize: "11pt",
            fontWeight: "bold",
            letterSpacing: "1pt",
          }}
        >
          居宅介護サービス提供実績記録票
        </div>
        <div style={{ width: "20%", textAlign: "right", fontSize: "9pt", fontWeight: "bold" }}>
          様式1
        </div>
      </div>

      {/* ── ヘッダ: 受給者証番号 / 氏名 / 事業所番号 / 事業者名 ── */}
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "14%" }} />
          <col style={{ width: "36%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "36%" }} />
        </colgroup>
        <tbody>
          <tr>
            <Lb>受給者証番号</Lb>
            <Vc>
              <DigitCells value={row.beneficiary_number ?? ""} cells={10} cw={5} h={5} />
            </Vc>
            <Lb>事業所番号</Lb>
            <Vc>
              <DigitCells value={officeNumber ?? ""} cells={10} cw={5} h={5} />
            </Vc>
          </tr>
          <tr>
            <Lb>
              支給決定障害
              <br />
              者等氏名
            </Lb>
            <Vc style={{ fontWeight: "bold", fontSize: "9.5pt" }}>{row.user_name}</Vc>
            <Lb>
              事業者及び
              <br />
              その事業所名
            </Lb>
            <Vc style={{ fontWeight: "bold", fontSize: "9pt" }}>{officeName ?? ""}</Vc>
          </tr>
        </tbody>
      </table>

      {/* ── 日別グリッド (J611 明細情報レコード相当) ── */}
      <table
        style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", marginTop: "1.5mm" }}
      >
        <colgroup>
          <col style={{ width: "6%" }} />
          <col style={{ width: "6%" }} />
          <col style={{ width: "24%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "9%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={thc}>日付</th>
            <th style={thc}>曜日</th>
            <th style={thc}>
              サービス提供状況
              <br />
              (サービス内容)
            </th>
            <th style={thc}>開始時間</th>
            <th style={thc}>終了時間</th>
            <th style={thc}>
              算定
              <br />
              時間数
            </th>
            <th style={thc}>
              派遣
              <br />
              人数
            </th>
            <th style={thc}>
              初回
              <br />
              加算
            </th>
            <th style={thc}>
              利用者
              <br />
              確認欄
            </th>
            <th style={thc}>備考</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v, i) => {
            const code = decisionCode(v.category, v.serviceName, v.serviceCode);
            const isRide = code === "115000";
            return (
              <tr key={i} style={{ height: "5mm" }}>
                <td style={tdc}>{parseInt(v.date.slice(8, 10), 10)}</td>
                <td style={tdc}>{dow(v.date)}</td>
                <td style={{ ...tdc, textAlign: "left", fontFamily: "inherit" }}>
                  {v.category ?? DECISION_NAMES[code] ?? ""}
                </td>
                <td style={tdc}>{hm(v.startTime)}</td>
                <td style={tdc}>{hm(v.endTime)}</td>
                <td style={{ ...tdc, textAlign: "right" }}>
                  {isRide
                    ? "1回"
                    : v.durationMinutes
                      ? fmtHours(v.durationMinutes)
                      : ""}
                </td>
                <td style={tdc}>1</td>
                <td style={tdc}></td>
                <td style={tdc}></td>
                <td style={tdc}></td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr style={{ height: "5mm" }}>
              <td style={{ ...tdc, fontFamily: "inherit" }} colSpan={10}>
                対象月の提供実績がありません
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* ── 合計欄 (J611 基本情報 合計1〜5 相当) ── */}
      <table
        style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", marginTop: "-0.5pt" }}
      >
        <tbody>
          <tr>
            <Lb style={{ width: "10%" }} rowSpan={2}>
              合計
            </Lb>
            {KIROKU_SLOTS.map((s) => (
              <Lb key={s.code}>{s.label}</Lb>
            ))}
            <Lb style={{ background: "#f5f5f5" }}>算定時間数 計</Lb>
          </tr>
          <tr>
            {KIROKU_SLOTS.map((s) => {
              const t = totals.get(s.code);
              return (
                <Vc
                  key={s.code}
                  style={{
                    textAlign: "right",
                    fontFamily: '"MS Gothic",monospace',
                    height: "5mm",
                  }}
                >
                  {t
                    ? s.isCount
                      ? `${t.count} 回`
                      : `${fmtHours(t.mins)} 時間`
                    : ""}
                </Vc>
              );
            })}
            <Vc
              style={{
                textAlign: "right",
                fontFamily: '"MS Gothic",monospace',
                fontWeight: "bold",
              }}
            >
              {fmtHours(totalMins)} 時間
            </Vc>
          </tr>
        </tbody>
      </table>

      <p style={{ marginTop: "1.5mm", fontSize: "6.5pt" }}>
        ※ 伝送 J611 (サービス提供実績記録票情報) と同じ月実績から出力。初回加算等の加算欄は算定時に記入してください。
      </p>

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

/* ═══════════════════════════════════════════════════════════════════════════
   4. ShogaiFutanIchiranPrintSheet — 利用者負担額一覧表
   ──────────────────────────────────────────────────────────────────────────
   自事業所が「非」上限管理事業所のとき、上限管理事業所へ提出する一覧表
   (MORE の請求統合「負担一覧」相当)。上限管理区分が「他事業所」の利用者について、
   当事業所の 総費用額・利用者負担額 を記載する。1 提出先ぶんを 1 枚にまとめる。
   ═══════════════════════════════════════════════════════════════════════ */
export function ShogaiFutanIchiranPrintSheet({
  rows,
  officeName,
  officeNumber,
  reiwa,
  month,
}: {
  rows: ShogaiSeikyuRow[];
  officeName: string | null;
  officeNumber: string | null;
  reiwa: number;
  month: number;
}) {
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
  const tdc: React.CSSProperties = { ...td, textAlign: "center" };
  const tdl: React.CSSProperties = { ...td, textAlign: "left", fontFamily: '"MS Mincho","ＭＳ 明朝",serif' };
  const total = rows.reduce(
    (a, r) => ({ cost: a.cost + r.totalAmount, user: a.user + r.userAmount }),
    { cost: 0, user: 0 },
  );
  return (
    <div
      style={{
        pageBreakAfter: "always",
        padding: "12mm",
        fontFamily: '"MS Mincho","ＭＳ 明朝","游明朝",serif',
        color: "#000",
        fontSize: "9pt",
        lineHeight: 1.4,
        width: "210mm",
        boxSizing: "border-box",
      }}
    >
      <div style={{ textAlign: "center", fontSize: "13pt", fontWeight: "bold", letterSpacing: "2pt", marginBottom: "3mm" }}>
        利用者負担額一覧表
      </div>
      <div style={{ textAlign: "right", fontSize: "10pt", marginBottom: "1mm" }}>
        令和{reiwa}年{month}月分
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3mm", fontSize: "9pt" }}>
        <div style={{ paddingTop: "2mm" }}>（提出先）上限額管理事業所　御中</div>
        <table style={{ borderCollapse: "collapse", width: "80mm" }}>
          <tbody>
            <tr>
              <td style={{ ...th, width: "24mm", textAlign: "left" }}>事業所番号</td>
              <td style={{ ...tdc, fontWeight: "bold" }}>{officeNumber ?? ""}</td>
            </tr>
            <tr>
              <td style={{ ...th, textAlign: "left" }}>事業所名称</td>
              <td style={tdl}>{officeName ?? ""}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: "10mm" }}>No.</th>
            <th style={{ ...th, width: "34mm" }}>受給者証番号</th>
            <th style={th}>支給決定障害者等氏名</th>
            <th style={{ ...th, width: "40mm" }}>総費用額</th>
            <th style={{ ...th, width: "40mm" }}>利用者負担額</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.user_id}>
              <td style={tdc}>{i + 1}</td>
              <td style={tdc}>{r.beneficiary_number ?? ""}</td>
              <td style={tdl}>{r.user_name}</td>
              <td style={td}>{r.totalAmount.toLocaleString()}</td>
              <td style={td}>{r.userAmount.toLocaleString()}</td>
            </tr>
          ))}
          <tr>
            <td style={{ ...th, textAlign: "center" }} colSpan={3}>合計</td>
            <td style={{ ...td, fontWeight: "bold" }}>{total.cost.toLocaleString()}</td>
            <td style={{ ...td, fontWeight: "bold" }}>{total.user.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
      <div style={{ marginTop: "3mm", fontSize: "7.5pt", color: "#000" }}>
        ※ 本表は当事業所ぶんの総費用額・利用者負担額です。上限額管理事業所にて合算・調整のうえ、
        上限額管理結果票を作成してください。
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. ShogaiKeiyakuHoukokuPrintSheet — 契約内容(サービス提供)報告書
   ──────────────────────────────────────────────────────────────────────────
   受給者証の事業者記入欄に記載した契約内容を市町村へ報告する書類
   (MORE 請求管理「契約内容報告書」相当)。利用者 1 名 = 1 枚。

   ⚠ 契約支給量は **決定サービスコードごとに 1 行**ある (身体介護 / 家事援助 /
     通院等介助 … を別々に契約する)。以前は受給者証の contract_amount_text
     (自由記述 1 欄) を印字していたが、576 件中 33 件しか埋まっておらず
     ほぼ白紙で出ていた。shogai_contracts (664 件・構造化済) を明細表として印字する。
   ═══════════════════════════════════════════════════════════════════════ */
export interface ShogaiKeiyakuEntry {
  row: ShogaiSeikyuRow;
  /** 対象月に有効な自事業所の契約 (決定サービスコードごと) */
  contracts: ShogaiContract[];
  /** 受給者証の holder (支給決定者) カナ。無ければ null */
  holderNameKana: string | null;
  /** 旧・自由記述の契約支給量。contracts が空のときだけ補助的に出す */
  legacyAmountText: string | null;
}
export function ShogaiKeiyakuHoukokuPrintSheet({
  entry,
  officeName,
  officeNumber,
  reiwa,
  month,
}: {
  entry: ShogaiKeiyakuEntry;
  officeName: string | null;
  officeNumber: string | null;
  reiwa: number;
  month: number;
}) {
  const { row: r } = entry;
  const th: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "1.5mm 2mm",
    fontSize: "9pt",
    fontWeight: "normal",
    textAlign: "left",
    background: "#f5f5f5",
    width: "40mm",
    whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = {
    border: "0.5pt solid #000",
    padding: "1.5mm 2.5mm",
    fontSize: "9.5pt",
  };
  return (
    <div
      style={{
        pageBreakAfter: "always",
        padding: "14mm",
        fontFamily: '"MS Mincho","ＭＳ 明朝","游明朝",serif',
        color: "#000",
        fontSize: "9.5pt",
        lineHeight: 1.5,
        width: "210mm",
        boxSizing: "border-box",
      }}
    >
      <div style={{ textAlign: "center", fontSize: "13pt", fontWeight: "bold", letterSpacing: "2pt", marginBottom: "5mm" }}>
        契約内容（サービス提供）報告書
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5mm" }}>
        <div style={{ paddingTop: "3mm", fontSize: "10pt" }}>
          （提出先）支給決定市町村長　殿
        </div>
        <div style={{ fontSize: "9pt", textAlign: "right" }}>
          令和{reiwa}年{month}月<br />
          事業所番号：<span style={{ fontFamily: '"MS Gothic",monospace' }}>{officeNumber ?? ""}</span><br />
          事業所名称：{officeName ?? ""}
        </div>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          <tr>
            <td style={th}>受給者証番号</td>
            <td style={{ ...td, fontFamily: '"MS Gothic",monospace' }}>{r.beneficiary_number ?? ""}</td>
          </tr>
          <tr>
            <td style={th}>支給決定障害者等氏名</td>
            <td style={td}>{r.user_name}</td>
          </tr>
          {entry.holderNameKana && (
            <tr>
              <td style={th}>フリガナ</td>
              <td style={td}>{entry.holderNameKana}</td>
            </tr>
          )}
        </tbody>
      </table>

      {/* 契約内容は決定サービスコードごとに 1 行。受給者証の事業者記入欄と同じ並び */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "4mm" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: "auto", textAlign: "center" }}>サービス種別</th>
            <th style={{ ...th, width: "28mm", textAlign: "center" }}>契約支給量</th>
            <th style={{ ...th, width: "30mm", textAlign: "center" }}>契約日</th>
            <th style={{ ...th, width: "30mm", textAlign: "center" }}>契約終了日</th>
            <th style={{ ...th, width: "22mm", textAlign: "center" }}>記入欄番号</th>
          </tr>
        </thead>
        <tbody>
          {entry.contracts.length === 0 ? (
            <tr>
              <td style={{ ...td, textAlign: "center" }} colSpan={5}>
                {entry.legacyAmountText ?? "（契約支給量が未登録です）"}
              </td>
            </tr>
          ) : (
            entry.contracts.map((c) => (
              <tr key={c.id}>
                <td style={td}>
                  {DECISION_CODES[c.decision_code] ?? c.decision_code}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: '"MS Gothic",monospace' }}>
                  {c.amount_unit === "回"
                    ? `${c.amount_x100 / 100}回`
                    : `${Math.floor(c.amount_x100 / 100)}時間${String(Math.round(c.amount_x100 % 100)).padStart(2, "0")}分`}
                </td>
                <td style={{ ...td, textAlign: "center", fontFamily: '"MS Gothic",monospace' }}>
                  {c.start_date ?? ""}
                </td>
                <td style={{ ...td, textAlign: "center", fontFamily: '"MS Gothic",monospace' }}>
                  {c.end_date ?? ""}
                </td>
                <td style={{ ...td, textAlign: "center", fontFamily: '"MS Gothic",monospace' }}>
                  {c.entry_number ?? ""}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div style={{ marginTop: "6mm", fontSize: "8pt", color: "#000" }}>
        上記のとおり、指定障害福祉サービスの提供に係る契約内容を報告します。
      </div>
    </div>
  );
}
