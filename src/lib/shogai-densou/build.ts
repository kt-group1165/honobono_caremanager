/**
 * 障害福祉サービス 電子請求受付システム向け 伝送ファイル生成
 *
 * 厚労省「インタフェース仕様書 サービス事業所編 (令和7年4月)」準拠。
 *   https://www.mhlw.go.jp/content/12200000/001469723.pdf (事業所編)
 *   https://www.mhlw.go.jp/content/12200000/001469710.pdf (共通編)
 * 仕様書の抜粋は apps/kaigo-app/migrations/_if_shogai.txt に保存済み。
 *
 * 生成ファイル (すべて CSV 可変長 / Shift_JIS / CRLF):
 *   1. J11 ファイル: J111 請求書情報 + J121 明細書情報
 *        J111 = 基本情報(01) + 明細情報(02)         … 市町村ごと
 *        J121 = 基本情報(01) + 日数情報(02) + 明細情報(03) × n
 *               + 集計情報(04) + 契約情報(05) × n    … 利用者ごと
 *   2. J61 ファイル: J611 サービス提供実績記録票情報
 *        基本情報(01, 172項目) + 明細情報(02, 113項目) × n … 利用者 × 様式ごと
 *        対応様式: 0101 (様式1 居宅介護) / 0301 (様式3-1 重度訪問介護)
 *        ※ 行動援護 (0201)・同行援護 (1901) 等は KT Group 未提供のため対象外
 *          (提供開始時に IF 仕様書の該当様式定義を確認して追加すること)
 *        ※ 0302 (様式3-2 重訪 時間帯集計) は平成21年4月以降不使用 — 送付しない
 *   3. J41 ファイル: J411 利用者負担上限額管理結果票情報
 *        基本情報(01) + 明細情報(02) × n … 自事業所が上限管理者の利用者のみ
 *
 * エンベロープ (共通編 1.2.2):
 *   コントロール: 1,連番,ボリューム通番0,データ件数,データ種別(J11/J41/J61),
 *                 市町村番号0,事業所番号,都道府県番号0,媒体区分7(インターネット伝送),処理対象年月,予備(空)
 *   データ:       2,連番,<項目...>
 *   エンド:       3,連番
 *
 * 空欄項目は空文字のまま出力 (可変長 CSV)。Shift_JIS 変換は呼出側 (UI) で行う。
 */

import type { ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";

// ─── 入力型 ──────────────────────────────────────────────────────────────────

/** 実績記録票用の 1 回分の提供実績 */
export interface ShogaiDensouVisit {
  date: string; // YYYY-MM-DD
  startTime: string | null; // HH:MM(:SS)
  endTime: string | null;
  durationMinutes: number | null;
  category: string | null; // 身体 / 家事 / 通院 等
  serviceCode: string | null;
  /** マスタのサービス名 (重訪の「・２人」「・同行ｎ」判定に使用。不明は null) */
  serviceName?: string | null;
}

/** 上限管理結果票の関係事業所行 (shogai_jogen_kanri_results.office_lines) */
export interface ShogaiDensouKanriLine {
  office_number: string;
  office_name: string;
  total_amount: number;
  user_amount: number;
  adjusted_amount: number;
  is_self: boolean;
}

export interface ShogaiDensouUser {
  row: ShogaiSeikyuRow;
  visits: ShogaiDensouVisit[];
  /** 受給者証 事業者記入欄 (契約支給量) */
  contractAmountText: string | null;
  contractStartDate: string | null; // YYYY-MM-DD
  contractEntryNumber: string | null;
  /** 自事業所が上限管理者のときの関係事業所一覧 (それ以外は null) */
  jogenOfficeLines: ShogaiDensouKanriLine[] | null;
}

export interface ShogaiDensouOptions {
  /** 請求事業所番号 (10 桁) */
  officeNumber: string;
  /** サービス提供年月 */
  year: number;
  month: number; // 1-12
  /** 単位数単価 (円)。集計情報レコードは ×1000 の 5 桁 (整数2+小数3) */
  unitPrice: number;
  /** 事業所マスタの地域区分 ("1級地"〜"7級地" / "その他") → 地域区分コード 01〜07/20 */
  areaCategory: string | null;
}

export interface ShogaiDensouFile {
  content: string; // Shift_JIS 変換前
  fileName: string; // 英字始まり 8 桁以内 + .CSV
  dataRecordCount: number;
}

export interface ShogaiDensouResult {
  /** J11 (請求書+明細書) / J61 (実績記録票) / J41 (上限管理結果票; 対象なしは null) */
  seikyuFile: ShogaiDensouFile;
  jissekiFile: ShogaiDensouFile;
  jogenFile: ShogaiDensouFile | null;
  warnings: string[];
}

// ─── コード値・整形 ──────────────────────────────────────────────────────────

/** 決定サービスコード (契約情報レコード / 実績記録票のサービス内容)。印刷様式 (_shogai-meisai.tsx) からも参照。
 *  category は「種類コード」("11" 居宅介護 等) が入り身体/家事の内容を持たない場合があるため、
 *  マスタ名 (serviceName)・コード先頭 (serviceCode) も併用して判定する (2026-07-17 照合で家事誤判定を修正)。 */
export function decisionCode(
  category: string | null,
  serviceName?: string | null,
  serviceCode?: string | null,
): string {
  const c = `${category ?? ""} ${serviceName ?? ""}`;
  if (c.includes("乗降")) return "115000";
  if (c.includes("通院")) {
    return c.includes("伴わ") || c.includes("伴ず") ? "114000" : "113000";
  }
  if (c.includes("家事") || c.includes("生活")) return "112000";
  if (c.includes("身体")) return "111000";
  // フォールバック: コード先頭で家事を補完 (居宅介護 家事援助=1161/1162 日夜・1176 0.25刻み)。
  // 身体は既定なので補完不要。通院/乗降はコード帯が確定していないため名称依存。
  if (/^(116[1-9]|1176)/.test(serviceCode ?? "")) return "112000";
  return "111000"; // 身体介護 (既定)
}

/** 実績記録票 基本情報レコードの合計欄スロット (合計1〜5) */
function goukeiSlot(code: string): 1 | 2 | 3 | 4 | 5 {
  switch (code) {
    case "113000":
      return 2; // 通院介助 (伴う)
    case "112000":
      return 3; // 家事援助
    case "114000":
      return 4; // 通院介助 (伴わない)
    case "115000":
      return 5; // 通院等乗降介助 (回数)
    default:
      return 1; // 身体介護
  }
}

/** サービスコード先頭 2 桁 → サービス種類コード (11 居宅 / 12 重訪 / 13 行動 / 15 同行)。
 *  コード未設定・非数値は従来どおり居宅介護 (11) 扱い */
function serviceTypeCode(code: string | null): string {
  const p = (code ?? "").slice(0, 2);
  return /^\d{2}$/.test(p) ? p : "11";
}

// 実績記録票の様式種別番号 (IF仕様書 事業所編 (4) 様式と様式種別番号の対応):
//   サービス種類 11 → 0101 (様式1 居宅介護) / 12 → 0301 (様式3-1 重度訪問介護)
//   行動援護 (0201)・同行援護 (1901) 等は KT Group 未提供のため対象外
//   0302 (様式3-2 重訪 時間帯集計) は平成21年4月以降不使用
const SERVICE_TYPE_LABELS: Record<string, string> = {
  "11": "居宅介護",
  "12": "重度訪問介護",
  "13": "行動援護",
  "14": "同行援護", // 旧コード系
  "15": "同行援護",
};

/** 重訪 明細 19 派遣人数: マスタ名の「・２人」表記 (同一時間の 2 人派遣は 1 行 + 派遣人数 2) */
function juhoNinzu(name: string | null | undefined): number {
  return /[2２]人/.test(name ?? "") ? 2 : 1;
}

/** 重訪 明細 80 同行支援: 熟練ヘルパー同行コード (124541 等) のマスタ名から判定。
 *  1 = 障害支援区分6の利用者に支援 (熟練が新任に同行) / 2 = 重度包括対象者に支援 (令和6年4月以降定義) */
function juhoDoukou(name: string | null | undefined): string {
  const n = name ?? "";
  if (/同行[1１]/.test(n)) return "1";
  if (/同行[2２]/.test(n)) return "2";
  return "";
}

/** 介護マスタの地域区分 → 障害 地域区分コード (01〜07 / 20:その他) */
function areaKubunCode(area: string | null): string {
  const m = (area ?? "").match(/([1-7１-７])\s*級地/);
  if (m) {
    const n = "１２３４５６７".indexOf(m[1]);
    return `0${n >= 0 ? n + 1 : Number(m[1])}`;
  }
  return "20";
}

const dateNum = (iso: string | null) => (iso ? iso.replaceAll("-", "") : "");

/** "HH:MM(:SS)" → "HHMM" */
const hhmm = (t: string | null) => (t ? t.slice(0, 5).replace(":", "") : "");

/** 時間数 → 整数部3桁+小数部2桁の5桁 (例 5.0h → "00500") */
const fmtHours5 = (hours: number) =>
  String(Math.round(hours * 100)).padStart(5, "0");

/** 時間数 → 整数部2桁+小数部2桁の4桁 (例 1.0h → "0100") */
const fmtHours4 = (hours: number) =>
  String(Math.round(hours * 100)).padStart(4, "0");

/** 契約支給量テキスト → 決定コード別の数量 (時間/回)。パース不能は null */
function parseContractAmounts(
  text: string | null,
  codes: string[],
): Map<string, number> | null {
  if (!text || codes.length === 0) return null;
  const out = new Map<string, number>();
  // "身体30 家事20" のようなカテゴリ別表記
  const pairs = Array.from(
    text.matchAll(/(身体|家事|生活|通院(?:伴う|伴わない|伴ず)?|乗降)[^\d]*([0-9]+(?:\.[0-9]+)?)/g),
  );
  if (pairs.length > 0) {
    for (const [, cat, num] of pairs) {
      out.set(decisionCode(cat), parseFloat(num));
    }
    // 表記のなかった決定コードは出力対象外にする
    return out;
  }
  // 単一数値 ("30時間" 等) は全決定コードに同値を設定
  const single = text.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!single) return null;
  for (const c of codes) out.set(c, parseFloat(single[1]));
  return out;
}

/** 利用者 1 名のサービス種類別集計 (J111 明細 / J121 日数・集計レコードの種類分割用) */
interface TypeAgg {
  typeCode: string; // 11 / 12 / ...
  units: number;
  cost: number;
  /** 決定利用者負担額 (複数種類時は先頭種類に集約 — 按分未検証) */
  userAmt: number;
  benefit: number;
}

/** details + addons をサービス種類コード別に集計する。
 *  単一種類 (通常) は利用者計 (totalUnits / totalAmount 等) をそのまま使い従来出力と一致させる。
 *  複数種類が混在する月は種類別単位数から費用を按分 (端数は先頭種類で調整) し、
 *  利用者負担は先頭種類に集約する — 負担額の種類間配分は制度上未確定のため warning を出す。 */
function userTypeAggs(
  u: ShogaiDensouUser,
  unitPrice100: number,
  warnings: string[],
): TypeAgg[] {
  const r = u.row;
  const unitsByType = new Map<string, number>();
  for (const d of r.details) {
    const tc = serviceTypeCode(d.service_code);
    unitsByType.set(tc, (unitsByType.get(tc) ?? 0) + d.units);
  }
  for (const a of r.addons) {
    const tc = serviceTypeCode(a.service_code);
    unitsByType.set(tc, (unitsByType.get(tc) ?? 0) + a.units);
  }
  const types = Array.from(unitsByType.keys()).sort();
  if (types.length <= 1) {
    return [
      {
        typeCode: types[0] ?? "11",
        units: r.totalUnits,
        cost: r.totalAmount,
        userAmt: r.userAmount,
        benefit: r.benefitAmount,
      },
    ];
  }
  warnings.push(
    `${r.user_name}: 複数サービス種類 (${types.map((t) => SERVICE_TYPE_LABELS[t] ?? t).join("+")}) が同月に混在しています — 利用者負担額は先頭種類に集約して出力します (種類間の按分は未検証。取込チェックで確認してください)`,
  );
  const aggs: TypeAgg[] = [];
  let costRest = r.totalAmount;
  let userRest = r.userAmount;
  types.forEach((tc, i) => {
    const units = unitsByType.get(tc)!;
    // 末尾以外は種類別単位数から費用を計算し、端数差は最後の種類で吸収 (合計を利用者計と一致させる)
    const cost =
      i === types.length - 1
        ? costRest
        : Math.floor((units * unitPrice100) / 100);
    costRest -= cost;
    // 利用者負担は先頭種類から順に費用の範囲内で充当 (合計 = 決定利用者負担額)
    const userAmt = Math.min(userRest, cost);
    userRest -= userAmt;
    aggs.push({ typeCode: tc, units, cost, userAmt, benefit: cost - userAmt });
  });
  return aggs;
}

/** コントロール+データ+エンドで包んでファイル文字列にする */
function wrapFile(
  dataParts: string[][],
  dataKind: "J11" | "J41" | "J61",
  officeNumber: string,
  processYm: string,
  fileName: string,
): ShogaiDensouFile {
  const lines: string[] = [];
  let recNo = 1;
  lines.push(
    [
      "1",
      String(recNo++),
      "0",
      String(dataParts.length),
      dataKind,
      "0",
      officeNumber,
      "0",
      "7", // 媒体区分: 7=伝送(インターネット)。1=伝送(ISDN)/2=MO/4=FD・CD-R。現行はインターネット請求
      processYm,
      "", // 予備 (設定しない)
    ].join(","),
  );
  for (const parts of dataParts) {
    lines.push(["2", String(recNo++), ...parts].join(","));
  }
  lines.push(["3", String(recNo++)].join(","));
  return {
    content: lines.join("\r\n") + "\r\n",
    fileName,
    dataRecordCount: dataParts.length,
  };
}

// ─── 本体 ────────────────────────────────────────────────────────────────────

export function buildShogaiDensou(
  users: ShogaiDensouUser[],
  opts: ShogaiDensouOptions,
): ShogaiDensouResult {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  // 処理対象年月 = 国保連合会で電算処理する年月 (= 提供月の翌月)
  const py = opts.month === 12 ? opts.year + 1 : opts.year;
  const pm = opts.month === 12 ? 1 : opts.month + 1;
  const processYm = `${py}${String(pm).padStart(2, "0")}`;
  const yy = String(opts.year).slice(2);
  const mm = String(opts.month).padStart(2, "0");

  const office = (opts.officeNumber ?? "").trim();
  if (!/^\d{10}$/.test(office)) {
    warnings.push(
      `事業所番号が 10 桁の数字ではありません ("${office}") — 事業所マスタで事業所番号を設定してください`,
    );
  }
  const areaCode = areaKubunCode(opts.areaCategory);
  if (areaCode === "20" && (opts.areaCategory ?? "") !== "その他") {
    warnings.push(
      `地域区分が未設定のため「20:その他」で出力します (事業所マスタで級地を設定してください)`,
    );
  }
  const unitPrice5 = String(Math.round(opts.unitPrice * 1000)).padStart(5, "0");

  const sorted = [...users].sort((a, b) =>
    (a.row.user_name_kana ?? a.row.user_name).localeCompare(
      b.row.user_name_kana ?? b.row.user_name,
      "ja",
    ),
  );

  for (const u of sorted) {
    if (!u.row.municipality || !/^\d{6}$/.test(u.row.municipality)) {
      warnings.push(
        `${u.row.user_name}: 市町村番号が 6 桁ではありません ("${u.row.municipality ?? ""}") — 受給者証で確認してください`,
      );
    }
    if (!u.row.beneficiary_number) {
      warnings.push(`${u.row.user_name}: 受給者証番号が未入力です`);
    }
    // 負担上限月額 未設定 (null)。0 円は有効値 (低所得区分等) なので警告しない
    if (u.row.self_payment_limit == null) {
      warnings.push(
        `${u.row.user_name}: 負担上限月額が未設定です — 受給者証で入力してください (負担 0 円の場合も 0 を入力)`,
      );
    }
    // J41↔J121 乖離: 上限管理結果の保存後に実績 (総費用額) が変わっていないか
    const selfLine = u.jogenOfficeLines?.find((l) => l.is_self);
    if (selfLine && selfLine.total_amount !== u.row.totalAmount) {
      warnings.push(
        `${u.row.user_name}: 上限管理結果が実績と不一致です (保存時 総費用額 ${selfLine.total_amount.toLocaleString()} 円 → 現在 ${u.row.totalAmount.toLocaleString()} 円) — 障害請求画面で調整計算を再実行・保存してください`,
      );
    }
  }

  // 利用者ごとのサービス種類別集計 (J111 明細 / J121 日数・集計の種類分割に共用)
  const aggsByUser = new Map<string, TypeAgg[]>();
  const unitPrice100 = Math.round(opts.unitPrice * 100);
  for (const u of sorted) {
    aggsByUser.set(u.row.user_id, userTypeAggs(u, unitPrice100, warnings));
  }

  // ══ 1. J11 ファイル (J111 請求書 + J121 明細書) ══════════════════════════
  const seikyuParts: string[][] = [];

  // ── J111 請求書 (市町村ごと) ──
  const byMuni = new Map<string, ShogaiDensouUser[]>();
  for (const u of sorted) {
    const key = u.row.municipality ?? "";
    if (!byMuni.has(key)) byMuni.set(key, []);
    byMuni.get(key)!.push(u);
  }
  for (const [muni, munUsers] of byMuni) {
    const count = munUsers.length;
    const units = munUsers.reduce((s, x) => s + x.row.totalUnits, 0);
    const cost = munUsers.reduce((s, x) => s + x.row.totalAmount, 0);
    const benefit = munUsers.reduce((s, x) => s + x.row.benefitAmount, 0);
    const userAmt = munUsers.reduce((s, x) => s + x.row.userAmount, 0);
    // 基本情報レコード (01) — 23 項目
    seikyuParts.push([
      "J111", "01", ym, muni, office,
      String(benefit), // 6 請求金額 (=給付費請求額合計)
      String(count), String(units), String(cost), String(benefit), // 7-10 小計
      "", String(userAmt), "", // 11-13 特対費/利用者負担/自治体助成
      "", "", "", // 14-16 特定障害者特別給付費 小計
      String(count), String(units), String(cost), String(benefit), // 17-20 合計
      "", String(userAmt), "", // 21-23
    ]);
    // 明細情報レコード (02) — 14 項目 × サービス種類 (11 居宅介護 / 12 重度訪問介護)
    const byType = new Map<
      string,
      { count: number; units: number; cost: number; userAmt: number; benefit: number }
    >();
    for (const x of munUsers) {
      for (const a of aggsByUser.get(x.row.user_id) ?? []) {
        const t = byType.get(a.typeCode) ?? {
          count: 0, units: 0, cost: 0, userAmt: 0, benefit: 0,
        };
        t.count += 1; // 件数 = その種類を含む明細書 (利用者) 数
        t.units += a.units;
        t.cost += a.cost;
        t.userAmt += a.userAmt;
        t.benefit += a.benefit;
        byType.set(a.typeCode, t);
      }
    }
    for (const tc of Array.from(byType.keys()).sort()) {
      const t = byType.get(tc)!;
      seikyuParts.push([
        "J111", "02", ym, muni, office,
        "1", // 6 給付種別 (1:介護給付費等)
        tc, // 7 サービス種類コード
        String(t.count), String(t.units), String(t.cost), String(t.benefit), // 8-11
        "", String(t.userAmt), "", // 12-14 特対費/利用者負担額/自治体助成額
      ]);
    }
  }

  // ── J121 明細書 (利用者ごと) ──
  for (const u of sorted) {
    const r = u.row;
    const muni = r.municipality ?? "";
    const jukyu = r.beneficiary_number ?? "";
    // 1割相当額 (totalAmount は整数なので /10 の floor で正確 — float 誤差回避)
    const ichiwari = Math.floor(r.totalAmount / 10);
    // 上限月額調整 = min(①上限月額, ②1割相当額)。上限未設定 (null) は調整なし = 1割相当額
    const jogenChosei =
      r.self_payment_limit != null
        ? Math.min(r.self_payment_limit, ichiwari)
        : ichiwari;
    const hasKanri = r.kanriResult != null;
    const kanriAfter = hasKanri ? r.userAmount : null;
    // 上限額管理事業所番号: 自事業所管理なら自事業所、他事業所管理なら受給者証の記載
    const kanriOfficeNo =
      r.jogenKanriKubun === "自事業所"
        ? office
        : (r.jogenKanriOfficeNumber ?? "");
    const firstDate = u.visits.map((v) => v.date).sort()[0] ?? null;
    // サービス種類別の実績 (日数レコード / 集計レコード / 実績記録票の様式分割に使用)
    const aggs = aggsByUser.get(r.user_id) ?? [];
    const visitsByType = new Map<string, ShogaiDensouVisit[]>();
    for (const v of u.visits) {
      const tc = serviceTypeCode(v.serviceCode);
      if (!visitsByType.has(tc)) visitsByType.set(tc, []);
      visitsByType.get(tc)!.push(v);
    }
    const typeDays = (tc: string) =>
      new Set((visitsByType.get(tc) ?? []).map((v) => v.date)).size;
    const typeFirstDate = (tc: string) =>
      (visitsByType.get(tc) ?? []).map((v) => v.date).sort()[0] ?? firstDate;

    // 基本情報レコード (01) — 35 項目
    seikyuParts.push([
      "J121", "01", ym, muni, office, jukyu,
      "", // 7 助成自治体番号
      "", "", // 8-9 氏名カナ (任意)
      areaCode, // 10 地域区分コード
      "1", // 11 就労継続支援A型事業者負担減免措置実施 (1:無し)
      r.self_payment_limit != null ? String(r.self_payment_limit) : "", // 12 利用者負担上限月額① (未設定は空 + 警告済)
      "1", // 13 就労継続支援A型減免対象者 (1:無し)
      "", // 14 障害支援区分コード (J131 のみ)
      hasKanri ? kanriOfficeNo : "", // 15 上限額管理事業所番号
      hasKanri ? String(r.kanriResult) : "", // 16 管理結果
      hasKanri && kanriAfter != null ? String(kanriAfter) : "", // 17 管理結果額
      "", "", // 18-19 日中支援加算欄
      String(r.totalUnits), // 20 給付単位数
      String(r.totalAmount), // 21 総費用額
      String(jogenChosei), // 22 上限月額調整
      "", "", // 23-24 A型減免
      hasKanri && kanriAfter != null ? String(kanriAfter) : "", // 25 調整後利用者負担額
      hasKanri && kanriAfter != null ? String(kanriAfter) : "", // 26 上限額管理後利用者負担額
      String(r.userAmount), // 27 決定利用者負担額
      String(r.benefitAmount), // 28 請求額 給付費
      "", "", "", // 29-31 高額/特対費/自治体助成
      "", "", "", "", // 32-35 特定障害者特別給付費
    ]);

    // 日数情報レコード (02) — 12 項目 × サービス種類
    for (const a of aggs) {
      seikyuParts.push([
        "J121", "02", ym, muni, office, jukyu,
        a.typeCode, // 7 サービス種類コード
        dateNum(u.contractStartDate ?? typeFirstDate(a.typeCode)), // 8 開始年月日
        "", // 9 終了年月日
        String(typeDays(a.typeCode)), // 10 利用日数
        "", "", // 11-12 入院/外泊日数
      ]);
    }

    // 明細情報レコード (03) — 11 項目 × サービスコード
    for (const d of r.details) {
      if (!d.service_code) {
        warnings.push(
          `${r.user_name}: サービスコード未設定の明細があります (${d.service_category ?? d.service_type})`,
        );
        continue;
      }
      seikyuParts.push([
        "J121", "03", ym, muni, office, jukyu,
        d.service_code, // 7 サービスコード
        String(d.unit_per), // 8 単位数
        String(d.count), // 9 回数
        String(d.units), // 10 サービス単位数
        "", // 11 摘要
      ]);
    }
    // 処遇改善加算等 (monthly_aggregate) — 月 1 回の加算行 (回数 1)。
    // 集計情報レコード (04) の給付単位数・総費用額は aggregate 側で加算込みのため
    // r.totalUnits / r.totalAmount にそのまま含まれる。
    for (const a of r.addons) {
      // 項8 単位数の桁: IF 仕様抜粋 (_if_shogai.txt L58-59「J121 明細情報レコード(03)」) に
      // バイト数の明記が無いため、保守的に 5 桁 (99999) 超で桁溢れ warning を出す
      // (処遇改善等の monthly_aggregate 加算は月合計単位に率を掛けるため大きくなりうる)
      if (a.units > 99999) {
        warnings.push(
          `${r.user_name}: 加算「${a.service_code}」の単位数 (${a.units.toLocaleString()}) が 5 桁 (99999) を超えています — J121 明細 (03) 項8/10 の桁溢れで取込エラーの可能性があるため実績を確認してください`,
        );
      }
      seikyuParts.push([
        "J121", "03", ym, muni, office, jukyu,
        a.service_code, // 7 サービスコード (115121 等)
        String(a.units), // 8 単位数 (= 加算単位数)
        "1", // 9 回数
        String(a.units), // 10 サービス単位数
        "", // 11 摘要
      ]);
    }

    // 集計情報レコード (04) — 33 項目 × サービス種類 (集計欄分類番号は種類ごとに 1 から採番)
    aggs.forEach((a, i) => {
      // 1割相当額 (a.cost は整数なので /10 の floor で正確)。単一種類時は従来の ichiwari と同値
      const ichiwariT = Math.floor(a.cost / 10);
      const jogenCoseiT =
        r.self_payment_limit != null
          ? Math.min(r.self_payment_limit, ichiwariT)
          : ichiwariT;
      seikyuParts.push([
        "J121", "04", ym, muni, office, jukyu,
        a.typeCode, // 7 サービス種類コード
        String(i + 1), // 8 集計欄分類番号
        String(typeDays(a.typeCode)), // 9 サービス利用日数
        String(a.units), // 10 給付単位数
        unitPrice5, // 11 単位数単価
        "0", // 12 給付率 (R6仕様: 0 固定)
        String(a.cost), // 13 総費用額
        String(ichiwariT), // 14 1割相当額
        String(ichiwariT), // 15 利用者負担額②
        String(jogenCoseiT), // 16 上限月額調整
        "", "", // 17-18 A型減免
        hasKanri ? String(a.userAmt) : "", // 19 調整後利用者負担額
        hasKanri ? String(a.userAmt) : "", // 20 上限額管理後利用者負担額
        String(a.userAmt), // 21 決定利用者負担額
        String(a.benefit), // 22 請求額 給付費
        "", "", "", // 23-25 高額/特対費/自治体助成
        "", "", "", "", // 26-29 特定障害者特別給付費
        "", "", "", "", // 30-33 利用日数管理票
      ]);
    });

    // 契約情報レコード (05) — 11 項目 × 決定サービスコード
    // 決定コードは居宅介護 (111000〜115000) のみ対応。重度訪問介護の決定コード
    // (121000 重度包括対象者 / 122000 区分6該当者 / 123000 その他 / 120901 加算移動介護) は
    // 受給者証の支給決定内容 (どの決定区分か) を構造化して保持していないため出力しない。
    const codes = Array.from(
      new Set(
        r.details
          .filter((d) => serviceTypeCode(d.service_code) === "11")
          .map((d) => decisionCode(d.service_category, null, d.service_code)),
      ),
    );
    if (aggs.some((a) => a.typeCode === "12")) {
      warnings.push(
        `${r.user_name}: 重度訪問介護の契約情報レコード (決定コード 121000/122000/123000) は未対応のため出力しません — 契約支給量審査は取込チェックで確認してください`,
      );
    }
    if (codes.length > 0) {
      const amounts = parseContractAmounts(u.contractAmountText, codes);
      if (!amounts) {
        warnings.push(
          `${r.user_name}: 契約支給量が未入力のため契約情報レコードを出力しません (受給者証ページで入力してください)`,
        );
      } else {
        for (const code of codes) {
          const amt = amounts.get(code);
          if (amt == null) {
            warnings.push(
              `${r.user_name}: 決定コード ${code} の契約支給量が読み取れません ("${u.contractAmountText}")`,
            );
            continue;
          }
          seikyuParts.push([
            "J121", "05", ym, muni, office, jukyu,
            code, // 7 決定サービスコード
            String(Math.round(amt * 100)).padStart(5, "0"), // 8 契約支給量 (整数3+小数2)
            dateNum(u.contractStartDate ?? firstDate), // 9 契約開始年月日
            "", // 10 契約終了年月日
            (u.contractEntryNumber ?? "1").padStart(2, "0"), // 11 事業者記入欄番号
          ]);
        }
      }
    }
  }

  // ══ 2. J61 ファイル (J611 実績記録票 — 様式1 0101 / 様式3-1 0301) ═══════════
  // サービス種類コード (コード先頭 2 桁) で様式を自動振り分けする。
  // 行動援護 (0201)・同行援護 (1901) 等は KT Group 未提供のため対象外 (warning のみ)。
  const jissekiParts: string[][] = [];
  for (const u of sorted) {
    const r = u.row;
    const muni = r.municipality ?? "";
    const jukyu = r.beneficiary_number ?? "";

    // J611 基本情報レコード (01) — 172 項目の共通ヘッダ部
    const baseKihon = (yoshiki: string): string[] => {
      const b = new Array<string>(172).fill("");
      b[0] = "J611";
      b[1] = "01";
      b[2] = ym;
      b[3] = muni;
      b[4] = office;
      b[5] = jukyu;
      b[6] = yoshiki; // 7 様式種別番号
      return b;
    };
    // J611 明細情報レコード (02) — 113 項目の共通ヘッダ部
    const baseMeisai = (yoshiki: string): string[] => {
      const f = new Array<string>(113).fill("");
      f[0] = "J611";
      f[1] = "02";
      f[2] = ym;
      f[3] = muni;
      f[4] = office;
      f[5] = jukyu;
      f[6] = yoshiki; // 7 様式種別番号
      return f;
    };

    // サービス種類別に実績を分割 (コード未設定の実績は従来どおり居宅介護 0101 扱い)
    const visitsByType = new Map<string, ShogaiDensouVisit[]>();
    for (const v of u.visits) {
      const tc = serviceTypeCode(v.serviceCode);
      if (!visitsByType.has(tc)) visitsByType.set(tc, []);
      visitsByType.get(tc)!.push(v);
    }
    for (const tc of Array.from(visitsByType.keys()).sort()) {
      if (tc !== "11" && tc !== "12") {
        warnings.push(
          `${r.user_name}: ${SERVICE_TYPE_LABELS[tc] ?? `サービス種類 ${tc}`} の実績記録票様式は未対応のため出力しません (KT Group 未提供サービス)`,
        );
      }
    }
    const kyotakuVisits = visitsByType.get("11") ?? [];
    const juhoVisits = visitsByType.get("12") ?? [];
    const detailTypes = new Set(
      (aggsByUser.get(r.user_id) ?? []).map((a) => a.typeCode),
    );

    // ── 様式1 (0101 居宅介護) ──────────────────────────────────────────────
    // 居宅の実績がある利用者に加え、従来どおり実績ゼロの利用者 (重訪等も無い) も
    // 空の基本情報レコードを出力する (出力対象の取りこぼしに気づけるように)
    if (
      kyotakuVisits.length > 0 ||
      (juhoVisits.length === 0 && !detailTypes.has("12"))
    ) {
      // 明細情報レコード (02) × 提供日時
      const visits = [...kyotakuVisits].sort((a, b) =>
        (a.date + (a.startTime ?? "")).localeCompare(b.date + (b.startTime ?? "")),
      );
      // 提供通番: 同一決定コードで間隔 2 時間未満の連続提供は同一番号 (乗降は常に新番号)
      let tsuban = 0;
      let prevKey = "";
      let prevEndMs = 0;
      const goukei = new Map<number, { hours: number; count: number }>();
      const rows: string[][] = [];
      // 同時2人派遣まとめ: 同一 (日×開始×終了×決定コード) の複数 visit = 同時複数ヘルパー。
      //   MEISAI importer は 1 人目=基本コード / 2 人目=・2人コード の別行で取込む (KJ明細は2行=2倍請求)
      //   が、実績記録票 (様式1) は 1 訪問=1行+派遣人数n (ほのぼの TJ 準拠。算定時間数は1人分)。
      //   → ここで同一時間ブロックを 1 行に合算し派遣人数を数える。
      const jissekiGrpKey = (v: ShogaiDensouVisit) =>
        `${v.date}|${hhmm(v.startTime)}|${hhmm(v.endTime)}|${decisionCode(v.category, v.serviceName, v.serviceCode)}`;
      const jissekiNinzu = new Map<string, number>();
      for (const v of visits) {
        const k = jissekiGrpKey(v);
        jissekiNinzu.set(k, (jissekiNinzu.get(k) ?? 0) + 1);
      }
      const jissekiSeen = new Set<string>();
      for (const v of visits) {
        const gk = jissekiGrpKey(v);
        if (jissekiSeen.has(gk)) continue; // 2人ペアの2行目以降はスキップ (1行に合算)
        jissekiSeen.add(gk);
        const ninzu = jissekiNinzu.get(gk) ?? 1;
        const code = decisionCode(v.category, v.serviceName, v.serviceCode);
        const startMs = v.startTime ? Date.parse(`${v.date}T${v.startTime}`) : 0;
        const endMs = v.endTime ? Date.parse(`${v.date}T${v.endTime}`) : startMs;
        const chain =
          code !== "115000" &&
          prevKey === `${v.date}_${code}` &&
          startMs > 0 &&
          prevEndMs > 0 &&
          startMs - prevEndMs < 2 * 60 * 60 * 1000;
        if (!chain) tsuban += 1;
        prevKey = `${v.date}_${code}`;
        prevEndMs = endMs;

        const hours = (v.durationMinutes ?? 0) / 60;
        const slot = goukeiSlot(code);
        const g = goukei.get(slot) ?? { hours: 0, count: 0 };
        g.hours += hours;
        g.count += 1;
        goukei.set(slot, g);

        const f = baseMeisai("0101");
        f[7] = String(tsuban); // 8 提供通番
        f[8] = String(Number(v.date.slice(8, 10))).padStart(2, "0"); // 9 日付
        f[9] = "1"; // 10 サービス提供回数
        f[10] = code; // 11 サービス内容 (決定コード)
        // 12 ヘルパー資格 (11:初任者等 12:基礎等 13:重訪 — _if_shogai.txt L103)。
        //    担当ヘルパーの実資格データを保持していないため "11" 固定 (下の warning で通知)
        f[11] = "11";
        f[13] = hhmm(v.startTime); // 14 開始時間
        f[14] = hhmm(v.endTime); // 15 終了時間
        if (code === "115000") {
          f[16] = "1"; // 17 乗降 (回数)
        } else if (hours > 0) {
          f[15] = fmtHours4(hours); // 16 算定時間数
        }
        // 19 派遣人数: マスタ名の「・２人」表記で 2 (同時2人派遣は 1 行 + 派遣人数 2)。
        //   居宅介護の同時2人派遣は「身体日0.5・2人」等の合成コードで取込まれる (MEISAI importer)。
        //   算定時間数 (項16) は 1 人分の実サービス時間のまま (ほのぼの TJ と一致 — 重訪の延べ倍計とは異なる)。
        f[18] = String(ninzu); // 19 派遣人数 (同時ヘルパー数=グループ内 visit 数)
        rows.push(f);
      }

      // 基本情報レコード (01) — 合計1〜5 (項番16〜32): 内訳100% と 算定時間数計 のみ設定 (減算ヘルパーなし前提)
      const b = baseKihon("0101");
      const slotIdx: Record<number, { uchiwake: number; kei: number }> = {
        1: { uchiwake: 15, kei: 18 }, // 項番16 / 19 (身体)
        2: { uchiwake: 19, kei: 22 }, // 項番20 / 23 (通院伴う)
        3: { uchiwake: 23, kei: 25 }, // 項番24 / 26 (家事)
        4: { uchiwake: 26, kei: 28 }, // 項番27 / 29 (通院伴わず)
        5: { uchiwake: 29, kei: 31 }, // 項番30 / 32 (乗降=回数)
      };
      for (const [slot, g] of goukei) {
        const idx = slotIdx[slot];
        if (slot === 5) {
          b[idx.uchiwake] = String(g.count).padStart(3, "0");
          b[idx.kei] = String(g.count).padStart(3, "0");
        } else if (g.hours > 0) {
          b[idx.uchiwake] = fmtHours5(g.hours);
          b[idx.kei] = fmtHours5(g.hours);
        }
      }
      jissekiParts.push(b, ...rows);

      // ⚠ ヘルパー資格 (明細 項12) はヘルパーの実資格データを保持していないため
      //   "11" (初任者等) 固定で出力している — 重訪側 (0301) の未保持項目 warning と同流儀で通知
      if (rows.length > 0) {
        warnings.push(
          `${r.user_name}: 実績記録票 (様式1) のヘルパー資格 (明細 項12) は実資格データ未保持のため「11 (介護福祉士・初任者等)」固定で出力します — 実態と異なる場合 (基礎研修等 12 / 重訪研修 13) は伝送前に手修正してください`,
        );
      }
    }

    // ── 様式3-1 (0301 重度訪問介護) ────────────────────────────────────────
    // 0301 で設定する項目 (IF仕様書 (5)(6) 入力必須項目と様式の対応表 [令和6年4月以降]):
    //   基本: 1-7(◎) / 19 合計1 算定時間数計 / 33 移動介護分 / 112 緊急時対応 /
    //         113 初回 / 115 行動障害支援連携 / 147 移動介護緊急時支援 (各加算回)
    //   明細: 1-9(◎) / 10 提供回数 / 14-16 開始・終了・算定時間数 / 18 移動 /
    //         19 派遣人数 / 35 備考 / 36 提供状況(1:入院 2:入院(長期)) /
    //         69 緊急時対応 / 70 初回 / 72 行動障害支援連携 / 80 同行支援 / 91 移動介護緊急時支援
    if (juhoVisits.length > 0) {
      const visits = [...juhoVisits].sort((a, b) =>
        (a.date + (a.startTime ?? "")).localeCompare(b.date + (b.startTime ?? "")),
      );
      // 提供通番: 重訪は 1 日の所要時間を通算して算定するため、同一日の提供に
      // 同一番号を設定する (明細※2 / 設定例③ No.1)。0 時またぎは日付単位で行が
      // 分かれている前提 (実績データは日単位で保持)。
      let tsuban = 0;
      let prevDate = "";
      const rows: string[][] = [];
      const lastRowIdxByDate = new Map<string, number>();
      const hoursByDate = new Map<string, number>();
      let nobeHours = 0; // 基本19 算定時間数計 = 延べ時間 (設定例 No.4: 10h×2人派遣=20h)
      let skippedNoTime = 0;
      let unknownName = 0;
      for (const v of visits) {
        const hours = (v.durationMinutes ?? 0) / 60;
        if (!v.startTime && !v.endTime && hours <= 0) {
          skippedNoTime += 1;
          continue;
        }
        if (v.serviceName == null) unknownName += 1;
        if (v.date !== prevDate) {
          tsuban += 1;
          prevDate = v.date;
        }
        const ninzu = juhoNinzu(v.serviceName);
        nobeHours += hours * ninzu;
        hoursByDate.set(v.date, (hoursByDate.get(v.date) ?? 0) + hours);

        const f = baseMeisai("0301");
        f[7] = String(tsuban); // 8 提供通番
        f[8] = String(Number(v.date.slice(8, 10))).padStart(2, "0"); // 9 日付
        // 10 サービス提供回数: 二人派遣で時間がずれた場合のみ 1人目'1'/2人目'2' (明細※3)。
        //    同一時間の 2 人派遣は「・２人」コード 1 行 + 派遣人数 2 で表すため設定しない (設定例 No.4)
        f[13] = hhmm(v.startTime); // 14 開始時間
        f[14] = hhmm(v.endTime); // 15 終了時間
        // 16 算定時間数: 1 日通算を同一通番の最終行にまとめて設定 (後段で埋める)
        // 18 移動: 移動介護 (決定コード 120901) の算定時間数 — 移動介護は未対応のため空欄
        f[18] = String(ninzu); // 19 派遣人数
        // 36 サービス提供の状況 (1:入院 2:入院(長期)) — 入院中の提供記録は未保持のため空欄
        f[79] = juhoDoukou(v.serviceName); // 80 同行支援 (熟練ヘルパー同行 1:区分6利用者 2:重度包括対象者)
        lastRowIdxByDate.set(v.date, rows.length);
        rows.push(f);
      }
      // 16 算定時間数 (整2+小2): 1 日の通算時間を同一日の最終行に設定 (設定例③ No.1/2)
      for (const [date, idx] of lastRowIdxByDate) {
        const h = hoursByDate.get(date) ?? 0;
        if (h > 0) rows[idx][15] = fmtHours4(h);
      }

      // 基本情報レコード (01)
      const b = baseKihon("0301");
      // 19 合計1 算定時間数計 (整3+小2): 重訪は内訳 (項番16-18) を設定せず合計のみ (対応表)
      if (nobeHours > 0) b[18] = fmtHours5(nobeHours);
      // 33 算定 移動介護分 / 112 緊急時対応加算 / 113 初回加算 / 115 行動障害支援連携加算 /
      // 147 移動介護緊急時支援加算: 実績データに保持していないため空欄 (下の warning で通知)
      jissekiParts.push(b, ...rows);

      // ⚠ データが無く埋められない項目の要確認 warning
      if (skippedNoTime > 0) {
        warnings.push(
          `${r.user_name}: 重訪実績のうち時間情報の無い ${skippedNoTime} 件を実績記録票から除外しました — 実績の開始/終了時間を確認してください`,
        );
      }
      if (unknownName > 0) {
        warnings.push(
          `${r.user_name}: 重訪実績 ${unknownName} 件のサービス名がマスタから解決できず、2人派遣/熟練同行の判定ができません — 派遣人数 1 として出力します (要確認)`,
        );
      }
      const juhoKasan = r.details.filter(
        (d) =>
          serviceTypeCode(d.service_code) === "12" &&
          /緊急時対応加算|初回加算|行動障害支援連携加算|移動介護緊急時支援加算|移動介護/.test(
            `${d.service_type} ${d.service_category ?? ""}`,
          ),
      );
      for (const k of juhoKasan) {
        warnings.push(
          `${r.user_name}: 重訪の加算「${k.service_type}」は実績記録票の加算欄 (基本情報 112/113/115/147・明細フラグ) に自動設定されません — 伝送前に要確認`,
        );
      }
    } else if (detailTypes.has("12")) {
      warnings.push(
        `${r.user_name}: 重度訪問介護の請求明細がありますが時間つき実績が無いため実績記録票 (様式3-1) を出力しません — 実績データを確認してください`,
      );
    }
  }

  // ══ 3. J41 ファイル (J411 上限管理結果票 — 自事業所管理のみ) ═══════════════
  const jogenParts: string[][] = [];
  for (const u of sorted) {
    const r = u.row;
    if (r.jogenKanriKubun !== "自事業所") continue;
    if (r.kanriResult == null || !u.jogenOfficeLines || u.jogenOfficeLines.length === 0) {
      warnings.push(
        `${r.user_name}: 自事業所上限管理ですが調整計算が未保存のため上限管理結果票を出力しません`,
      );
      continue;
    }
    const muni = r.municipality ?? "";
    const jukyu = r.beneficiary_number ?? "";
    const lines = u.jogenOfficeLines;
    const sumTotal = lines.reduce((s, l) => s + l.total_amount, 0);
    const sumUser = lines.reduce((s, l) => s + l.user_amount, 0);
    const sumAdj = lines.reduce((s, l) => s + l.adjusted_amount, 0);
    if (r.kanriResult === 3 && lines.some((l) => !l.is_self && l.total_amount === 0)) {
      warnings.push(
        `${r.user_name}: 関係事業所の総費用額が未入力 (0) のまま出力します — 管理結果 3 の場合は取込チェックで確認してください`,
      );
    }
    // 基本情報レコード (01) — 14 項目
    jogenParts.push([
      "J411", "01", ym,
      "1", // 4 作成区分 (1:新規)
      muni, office, jukyu,
      "", "", // 8-9 氏名カナ (任意)
      r.self_payment_limit != null ? String(r.self_payment_limit) : "", // 10 利用者負担上限月額 (未設定は空 + 警告済)
      String(r.kanriResult), // 11 管理結果
      String(sumTotal), String(sumUser), String(sumAdj), // 12-14 合計
    ]);
    // 明細情報レコード (02) — 11 項目 × 関係事業所
    lines.forEach((l, i) => {
      jogenParts.push([
        "J411", "02", ym, muni, office, jukyu,
        String(i + 1), // 7 項番
        l.is_self ? office : l.office_number, // 8 事業所番号
        String(l.total_amount), String(l.user_amount), String(l.adjusted_amount), // 9-11
      ]);
    });
  }

  return {
    seikyuFile: wrapFile(seikyuParts, "J11", office, processYm, `J11${yy}${mm}.CSV`),
    jissekiFile: wrapFile(jissekiParts, "J61", office, processYm, `J61${yy}${mm}.CSV`),
    jogenFile:
      jogenParts.length > 0
        ? wrapFile(jogenParts, "J41", office, processYm, `J41${yy}${mm}.CSV`)
        : null,
    warnings,
  };
}
