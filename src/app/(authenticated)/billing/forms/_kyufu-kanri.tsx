"use client";

/**
 * 給付管理票 (様式第十一) — 伝送の 8221/8222 に対応する紙様式。
 *
 * 居宅介護支援の国保請求で、これまで伝送ファイル (K{YYYYMM}.CSV) しか出せなかった
 * 給付管理票の紙 (控え・保険者提出用) を出せるようにしたもの。
 * データは伝送と同じ KyufuKanriUser を受け取るので、紙と伝送で数字がズレない。
 *
 * 利用者 1 名 = 1 枚 (保険者変更の分割票は呼出側が票ごとに渡す)。
 * 桝・罫線の流儀は _meisai.tsx / _seikyu.tsx に合わせている。
 */

import React from "react";
import type { KyufuKanriUser } from "@/lib/kokuho-densou/build-kyotaku";

const F = '"MS Mincho","ＭＳ 明朝","游明朝",serif';
const B = "0.5pt solid #000";
const BG = "#f5f5f5";

/** 桝目 (1 文字 1 マス) */
function DigitCells({
  value,
  cells,
  cw = 5,
}: {
  value: string;
  cells: number;
  cw?: number;
}) {
  const cs = (value ?? "").padEnd(cells, " ").slice(0, cells).split("");
  return (
    <span style={{ display: "inline-flex" }}>
      {cs.map((c, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: `${cw}mm`,
            height: `${cw + 1}mm`,
            border: B,
            marginRight: "-0.5pt",
            textAlign: "center",
            lineHeight: `${cw + 1}mm`,
            fontFamily: '"MS Gothic",monospace',
            fontSize: "8pt",
            background: "#fff",
          }}
        >
          {c.trim()}
        </span>
      ))}
    </span>
  );
}

/** 和暦 (元号番号 + 年月日) に分解。空文字は全欄空 */
function wareki(iso: string | null | undefined) {
  if (!iso) return { era: "", y: "", m: "", d: "" };
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return { era: "", y: "", m: "", d: "" };
  const yr = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  if (yr >= 2019) return { era: "令和", y: String(yr - 2018).padStart(2, "0"), m, d };
  if (yr >= 1989) return { era: "平成", y: String(yr - 1988).padStart(2, "0"), m, d };
  return { era: "昭和", y: String(yr - 1925).padStart(2, "0"), m, d };
}

const fmtDate = (iso: string | null | undefined) => {
  const w = wareki(iso);
  return w.era ? `${w.era}${Number(w.y)}年${Number(w.m)}月${Number(w.d)}日` : "";
};

/** 作成区分 (8221 項5) の表示 */
const SAKUSEI_LABELS: { code: string; label: string }[] = [
  { code: "1", label: "新規" },
  { code: "2", label: "修正" },
  { code: "3", label: "取消" },
];

/** 指定/基準該当/地域密着型 の識別コード → 表示 */
const SHITEI_LABELS: Record<string, string> = {
  "1": "指定",
  "2": "基準該当",
  "3": "地域密着",
  "5": "地域密着",
};

/** 明細欄の最小行数 (公式様式の桝目再現) */
const MIN_LINES = 10;

export function KyufuKanriPrintSheet({
  user,
  /** 居宅介護支援事業所番号 (要介護=43 / 要支援=46) */
  officeNumber,
  officeName,
  /** 対象年月 (令和年 / 月)。省略時は user.ym から導出 */
  reiwa,
  month,
}: {
  user: KyufuKanriUser;
  officeNumber: string;
  officeName: string | null;
  reiwa?: number;
  month?: number;
}) {
  // 対象年月: props 優先 / 無ければ user.ym (YYYYMM)
  const ym = user.ym ?? "";
  const derivedYear = ym.length === 6 ? Number(ym.slice(0, 4)) : null;
  const derivedMonth = ym.length === 6 ? Number(ym.slice(4, 6)) : null;
  const r = reiwa ?? (derivedYear ? derivedYear - 2018 : 0);
  const m = month ?? derivedMonth ?? 0;

  const birth = wareki(user.birthDate);
  const genderIndex = user.gender?.includes("男")
    ? 1
    : user.gender?.includes("女")
      ? 2
      : null;

  const lines = user.lines ?? [];
  const totalPlanned = lines.reduce((s, l) => s + (l.plannedUnits ?? 0), 0);
  const emptyLines = Math.max(0, MIN_LINES - lines.length);

  const th: React.CSSProperties = {
    border: B,
    padding: "0.8mm",
    fontSize: "7pt",
    fontWeight: "normal",
    textAlign: "center",
    background: BG,
    lineHeight: 1.15,
    verticalAlign: "middle",
  };
  const td: React.CSSProperties = {
    border: B,
    padding: "0.8mm",
    fontSize: "8pt",
    verticalAlign: "middle",
    background: "#fff",
    lineHeight: 1.2,
  };
  const lb: React.CSSProperties = { ...th, textAlign: "center" };

  return (
    <div
      className="kyufu-kanri-print-sheet"
      style={{
        padding: "6mm 6mm",
        fontFamily: F,
        color: "#000",
        fontSize: "8pt",
        lineHeight: 1.3,
        width: "210mm",
        maxWidth: "210mm",
        boxSizing: "border-box",
      }}
    >
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 0; }
          .kyufu-kanri-print-sheet { page-break-after: always; break-after: page; }
          .kyufu-kanri-print-sheet:last-child { page-break-after: auto; break-after: auto; }
          .kyufu-kanri-print-sheet table { page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>

      {/* ── 標題行 ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: "2mm",
        }}
      >
        <div style={{ width: "22%", fontSize: "8pt" }}>
          {r > 0 && m > 0 ? `令和 ${r} 年 ${m} 月分` : ""}
        </div>
        <div
          style={{
            textAlign: "center",
            flex: 1,
            fontSize: "13pt",
            fontWeight: "bold",
            letterSpacing: "0.5em",
          }}
        >
          給付管理票
        </div>
        <div
          style={{
            width: "22%",
            textAlign: "right",
            fontSize: "11pt",
            fontWeight: "bold",
          }}
        >
          様式第十一
        </div>
      </div>

      {/* ── 保険者 / 作成区分 ── */}
      <table
        style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}
      >
        <colgroup>
          <col style={{ width: "14%" }} />
          <col style={{ width: "26%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "16%" }} />
        </colgroup>
        <tbody>
          <tr>
            <td style={lb}>保険者番号</td>
            <td style={td}>
              <DigitCells value={user.insurerNumber} cells={6} />
            </td>
            <td style={lb}>保険者名</td>
            <td style={td}>{user.insurerName ?? ""}</td>
            <td style={lb}>
              給付管理票
              <br />
              作成区分
            </td>
            <td style={{ ...td, fontSize: "7pt", textAlign: "center" }}>
              {SAKUSEI_LABELS.map((s) => {
                const on = (user.sakuseiKubun ?? "1") === s.code;
                return (
                  <span key={s.code} style={{ marginRight: "1.5mm" }}>
                    <span
                      style={
                        on
                          ? {
                              border: "1pt solid #000",
                              borderRadius: "50%",
                              padding: "0 1mm",
                              fontWeight: "bold",
                            }
                          : undefined
                      }
                    >
                      {s.code}
                    </span>
                    {s.label}
                  </span>
                );
              })}
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── 被保険者 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "14%" }} />
          <col style={{ width: "38%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "34%" }} />
        </colgroup>
        <tbody>
          <tr>
            <td style={lb}>被保険者番号</td>
            <td style={td}>
              <DigitCells value={user.insuredNumber} cells={10} />
            </td>
            <td style={lb}>フリガナ</td>
            <td style={{ ...td, fontSize: "7.5pt" }}>{user.userKana ?? ""}</td>
          </tr>
          <tr>
            <td style={lb}>被保険者氏名</td>
            <td style={{ ...td, fontSize: "10pt", fontWeight: "bold" }}>
              {user.userName}
            </td>
            <td style={lb}>生年月日</td>
            <td style={td}>
              {birth.era ? (
                <>
                  {birth.era}
                  {Number(birth.y)}年{Number(birth.m)}月{Number(birth.d)}日
                </>
              ) : (
                ""
              )}
              <span style={{ marginLeft: "4mm", fontSize: "7.5pt" }}>
                性別{" "}
                <span style={genderIndex === 1 ? { fontWeight: "bold" } : undefined}>
                  1.男
                </span>{" "}
                <span style={genderIndex === 2 ? { fontWeight: "bold" } : undefined}>
                  2.女
                </span>
              </span>
            </td>
          </tr>
          <tr>
            <td style={lb}>
              要介護
              <br />
              状態区分
            </td>
            <td style={{ ...td, fontSize: "9pt" }}>{user.careLevel ?? ""}</td>
            <td style={lb}>
              区分支給
              <br />
              限度基準額
            </td>
            <td style={td}>
              <span style={{ fontFamily: '"MS Gothic",monospace', fontSize: "10pt" }}>
                {user.limitUnits ? user.limitUnits.toLocaleString() : ""}
              </span>
              <span style={{ fontSize: "7pt", marginLeft: "1.5mm" }}>単位／月</span>
            </td>
          </tr>
          <tr>
            <td style={lb}>限度額適用期間</td>
            <td colSpan={3} style={{ ...td, fontSize: "8pt" }}>
              {fmtDate(user.limitStart)}
              <span style={{ margin: "0 2mm" }}>から</span>
              {fmtDate(user.limitEnd)}
              <span style={{ marginLeft: "2mm" }}>まで</span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── 居宅介護支援事業所 / 介護支援専門員 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "-0.5pt",
        }}
      >
        <colgroup>
          <col style={{ width: "14%" }} />
          <col style={{ width: "24%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "48%" }} />
        </colgroup>
        <tbody>
          <tr>
            <td style={lb}>
              居宅介護支援
              <br />
              事業所番号
            </td>
            <td style={td}>
              <DigitCells value={officeNumber} cells={10} />
            </td>
            <td style={lb}>
              事業所
              <br />
              名称
            </td>
            <td style={td}>{officeName ?? ""}</td>
          </tr>
          <tr>
            <td style={lb}>
              担当介護支援
              <br />
              専門員番号
            </td>
            <td style={td}>
              <DigitCells value={user.careManagerNumber ?? ""} cells={10} />
            </td>
            <td style={lb}>
              担当介護支援
              <br />
              専門員氏名
            </td>
            <td style={td} />
          </tr>
        </tbody>
      </table>

      {/* ── 給付管理票 明細欄 ── */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: "2mm",
        }}
      >
        <colgroup>
          <col style={{ width: "12%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "30%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "14%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={th}>
              指定／基準該当
              <br />
              ／地域密着型
            </th>
            <th style={th}>
              サービス事業所
              <br />
              事業所番号
            </th>
            <th style={th}>事業所名</th>
            <th style={th}>
              サービス
              <br />
              種類（コード）
            </th>
            <th style={th}>
              給付計画
              <br />
              単位数
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            // 項18 が未設定なら伝送 builder と同じ導出 (71〜78 = 地域密着 / 他 = 指定)
            const kind = (l.serviceKindCode ?? "").trim();
            const shitei =
              (l.shiteiKubun ?? "").trim() ||
              (/^7[1-8]$/.test(kind) ? "5" : "1");
            return (
              <tr key={i}>
                <td style={{ ...td, textAlign: "center", fontSize: "7.5pt" }}>
                  {SHITEI_LABELS[shitei] ?? shitei}
                </td>
                <td
                  style={{
                    ...td,
                    fontFamily: '"MS Gothic",monospace',
                    textAlign: "center",
                  }}
                >
                  {l.officeNumber}
                </td>
                <td style={{ ...td, fontSize: "7.5pt" }}>
                  {l.providerName ?? ""}
                </td>
                <td style={{ ...td, fontSize: "7.5pt" }}>
                  {l.serviceTypeName ?? ""}
                  <span
                    style={{
                      fontFamily: '"MS Gothic",monospace',
                      marginLeft: "1.5mm",
                    }}
                  >
                    （{kind}）
                  </span>
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontFamily: '"MS Gothic",monospace',
                  }}
                >
                  {(l.plannedUnits ?? 0).toLocaleString()}
                </td>
              </tr>
            );
          })}
          {Array.from({ length: emptyLines }).map((_, i) => (
            <tr key={`empty-${i}`} style={{ height: "6mm" }}>
              <td style={td} />
              <td style={td} />
              <td style={td} />
              <td style={td} />
              <td style={td} />
            </tr>
          ))}
          <tr>
            <td colSpan={4} style={{ ...lb, textAlign: "right" }}>
              合計
            </td>
            <td
              style={{
                ...td,
                textAlign: "right",
                fontFamily: '"MS Gothic",monospace',
                fontWeight: "bold",
                fontSize: "10pt",
              }}
            >
              {totalPlanned.toLocaleString()}
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── 枚数 (右下) ── */}
      <div
        style={{ display: "flex", justifyContent: "flex-end", marginTop: "2mm" }}
      >
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td
                style={{
                  ...td,
                  width: "8mm",
                  textAlign: "center",
                  fontFamily: '"MS Gothic",monospace',
                }}
              >
                1
              </td>
              <td style={{ ...td, width: "12mm", fontSize: "7pt", textAlign: "center" }}>
                枚目
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
