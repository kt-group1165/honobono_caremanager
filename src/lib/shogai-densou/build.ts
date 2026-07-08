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
 *        基本情報(01, 172項目) + 明細情報(02, 113項目) × n … 利用者ごと
 *        様式種別番号 0101 (居宅介護) のみ対応
 *   3. J41 ファイル: J411 利用者負担上限額管理結果票情報
 *        基本情報(01) + 明細情報(02) × n … 自事業所が上限管理者の利用者のみ
 *
 * エンベロープ (共通編 1.2.2):
 *   コントロール: 1,連番,ボリューム通番0,データ件数,データ種別(J11/J41/J61),
 *                 市町村番号0,事業所番号,都道府県番号0,媒体区分1(伝送),処理対象年月,予備(空)
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

/** 決定サービスコード (契約情報レコード / 実績記録票のサービス内容) */
function decisionCode(category: string | null): string {
  const c = category ?? "";
  if (c.includes("乗降")) return "115000";
  if (c.includes("通院")) {
    return c.includes("伴わ") || c.includes("伴ず") ? "114000" : "113000";
  }
  if (c.includes("家事") || c.includes("生活")) return "112000";
  return "111000"; // 身体介護
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
      "1", // 媒体区分: 伝送
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
    // 明細情報レコード (02) — 14 項目 (サービス種類 11:居宅介護)
    seikyuParts.push([
      "J111", "02", ym, muni, office,
      "1", // 6 給付種別 (1:介護給付費等)
      "11", // 7 サービス種類コード
      String(count), String(units), String(cost), String(benefit), // 8-11
      "", String(userAmt), "", // 12-14 特対費/利用者負担額/自治体助成額
    ]);
  }

  // ── J121 明細書 (利用者ごと) ──
  for (const u of sorted) {
    const r = u.row;
    const muni = r.municipality ?? "";
    const jukyu = r.beneficiary_number ?? "";
    const ichiwari = Math.floor(r.totalAmount * 0.1);
    const jogenChosei = Math.min(r.self_payment_limit, ichiwari);
    const hasKanri = r.kanriResult != null;
    const kanriAfter = hasKanri ? r.userAmount : null;
    // 上限額管理事業所番号: 自事業所管理なら自事業所、他事業所管理なら受給者証の記載
    const kanriOfficeNo =
      r.jogenKanriKubun === "自事業所"
        ? office
        : (r.jogenKanriOfficeNumber ?? "");
    const serviceDays = new Set(u.visits.map((v) => v.date)).size;
    const firstDate = u.visits.map((v) => v.date).sort()[0] ?? null;
    const kaishiDate = dateNum(u.contractStartDate ?? firstDate);

    // 基本情報レコード (01) — 35 項目
    seikyuParts.push([
      "J121", "01", ym, muni, office, jukyu,
      "", // 7 助成自治体番号
      "", "", // 8-9 氏名カナ (任意)
      areaCode, // 10 地域区分コード
      "1", // 11 就労継続支援A型事業者負担減免措置実施 (1:無し)
      String(r.self_payment_limit), // 12 利用者負担上限月額①
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

    // 日数情報レコード (02) — 12 項目
    seikyuParts.push([
      "J121", "02", ym, muni, office, jukyu,
      "11", // 7 サービス種類コード
      kaishiDate, // 8 開始年月日
      "", // 9 終了年月日
      String(serviceDays), // 10 利用日数
      "", "", // 11-12 入院/外泊日数
    ]);

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
      seikyuParts.push([
        "J121", "03", ym, muni, office, jukyu,
        a.service_code, // 7 サービスコード (115121 等)
        String(a.units), // 8 単位数 (= 加算単位数)
        "1", // 9 回数
        String(a.units), // 10 サービス単位数
        "", // 11 摘要
      ]);
    }

    // 集計情報レコード (04) — 33 項目
    seikyuParts.push([
      "J121", "04", ym, muni, office, jukyu,
      "11", // 7 サービス種類コード
      "1", // 8 集計欄分類番号
      String(serviceDays), // 9 サービス利用日数
      String(r.totalUnits), // 10 給付単位数
      unitPrice5, // 11 単位数単価
      "0", // 12 給付率 (R6仕様: 0 固定)
      String(r.totalAmount), // 13 総費用額
      String(ichiwari), // 14 1割相当額
      String(ichiwari), // 15 利用者負担額②
      String(jogenChosei), // 16 上限月額調整
      "", "", // 17-18 A型減免
      hasKanri && kanriAfter != null ? String(kanriAfter) : "", // 19 調整後利用者負担額
      hasKanri && kanriAfter != null ? String(kanriAfter) : "", // 20 上限額管理後利用者負担額
      String(r.userAmount), // 21 決定利用者負担額
      String(r.benefitAmount), // 22 請求額 給付費
      "", "", "", // 23-25 高額/特対費/自治体助成
      "", "", "", "", // 26-29 特定障害者特別給付費
      "", "", "", "", // 30-33 利用日数管理票
    ]);

    // 契約情報レコード (05) — 11 項目 × 決定サービスコード
    const codes = Array.from(
      new Set(r.details.map((d) => decisionCode(d.service_category))),
    );
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

  // ══ 2. J61 ファイル (J611 実績記録票 様式1=0101) ═══════════════════════════
  const jissekiParts: string[][] = [];
  for (const u of sorted) {
    const r = u.row;
    const muni = r.municipality ?? "";
    const jukyu = r.beneficiary_number ?? "";

    // 明細情報レコード (02) — 113 項目 × 提供日時
    const visits = [...u.visits].sort((a, b) =>
      (a.date + (a.startTime ?? "")).localeCompare(b.date + (b.startTime ?? "")),
    );
    // 提供通番: 同一決定コードで間隔 2 時間未満の連続提供は同一番号 (乗降は常に新番号)
    let tsuban = 0;
    let prevKey = "";
    let prevEndMs = 0;
    const goukei = new Map<number, { hours: number; count: number }>();
    for (const v of visits) {
      const code = decisionCode(v.category);
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

      const f = new Array<string>(113).fill("");
      f[0] = "J611";
      f[1] = "02";
      f[2] = ym;
      f[3] = muni;
      f[4] = office;
      f[5] = jukyu;
      f[6] = "0101"; // 様式種別番号 (居宅介護)
      f[7] = String(tsuban); // 8 提供通番
      f[8] = String(Number(v.date.slice(8, 10))).padStart(2, "0"); // 9 日付
      f[9] = "1"; // 10 サービス提供回数
      f[10] = code; // 11 サービス内容 (決定コード)
      f[11] = "11"; // 12 ヘルパー資格 (11:初任者等)
      f[13] = hhmm(v.startTime); // 14 開始時間
      f[14] = hhmm(v.endTime); // 15 終了時間
      if (code === "115000") {
        f[16] = "1"; // 17 乗降 (回数)
      } else if (hours > 0) {
        f[15] = fmtHours4(hours); // 16 算定時間数
      }
      f[18] = "1"; // 19 派遣人数
      jissekiParts.push(f);
    }

    // 基本情報レコード (01) — 172 項目 (明細より前に挿入)
    const b = new Array<string>(172).fill("");
    b[0] = "J611";
    b[1] = "01";
    b[2] = ym;
    b[3] = muni;
    b[4] = office;
    b[5] = jukyu;
    b[6] = "0101";
    // 合計1〜5 (項番16〜32): 内訳100% と 算定時間数計 のみ設定 (減算ヘルパーなし前提)
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
    // 利用者の明細の直前に基本情報を挿入
    jissekiParts.splice(jissekiParts.length - visits.length, 0, b);
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
      String(r.self_payment_limit), // 10 利用者負担上限月額
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
