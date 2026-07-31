/**
 * ケアプランデータ連携標準仕様 V4 — 第6表 (サービス利用票) 実績情報 CSV ビルダー
 *
 * 用途: 居宅サービス事業所 (訪問介護等) → 居宅介護支援事業所 (ケアマネ) へ
 *       サービス提供実績 (第6表【実績】) を CSV で連携する。
 *
 * 仕様書 (リポジトリ内に保存):
 *   - migrations/_if_careplan_v4_layout.txt … 第6表/実績のレコードレイアウト (335行〜)
 *   - migrations/_if_careplan_v4_spec.txt   … 本文 (命名規約/文字コード/出力単位)
 *
 * 重要な仕様:
 *   - 文字コード: Shift-JIS (MS932)。範囲外文字不可。SJIS 変換は呼出側 (UI) で行う。
 *   - CSV (カンマ区切り)。フリーテキストは "" で囲い、内部の " は "" にエスケープ。
 *   - 出力単位: 利用者ごと・単月 (1ファイル = 単月のサービス提供年月のみ)。
 *   - ファイル名 (実績):
 *       UPJSK_対象年月(YYYYMM)_送信元事業所番号(10桁)_送信元サービス種類コード(2桁)_
 *       送信先事業所番号(10桁)_送信先サービス種類コード(2桁)_YYYYMMDDHHMMSS(14桁).CSV
 *
 * 第6表/実績 レコードレイアウト (layout.txt 335-484行。No / 名称 / 項目長 / 必須):
 *    1 CSVバージョン            6  ○  YYYYMM (制度改版年月)
 *    2 保険者番号              6  ○
 *    3 被保険者番号            10 ○  (生保単独は H+9桁)
 *    4 作成年月日              8  ○  YYYYMMDD (ファイル作成日)
 *    5 対象年月                6  ○  YYYYMM (サービス提供年月)
 *    6 プラン担当業者コード      10     居宅支援事業者番号 (担当ケアマネ事業所)
 *    7 プラン担当者名           ―     フリーテキスト
 *    8 単位数                  6     整数 (割引後・1回あたりのサービス単位数)。計算不可は 0
 *    9 前月までの短期入所利用日数  5
 *   10 サービス利用日           8  ○  YYYYMMDD (実績日)
 *   11 日割対象日              31     日割以外は Null (空)
 *   12 サービス開始時刻          4  ○  HHMM / 時間表示無しは 9999
 *   13 サービス終了時刻          4  ○  HHMM / 9999
 *   14 サービス回数             2  ○  1日に複数回算定可能なサービスの回数
 *   15 サービスコード           6  ○  介護給付費単位数等サービスコード (種類2+項目4)
 *   16 TAISコード             12     福祉用具のみ
 *   17 福祉用具届出コード        12     福祉用具のみ
 *   18 用具名称 (機種名)        ―     フリーテキスト (福祉用具のみ)
 *   19 明細判別コード           2     福祉用具のみ
 *   20 サービス事業者コード      10  ○  実績 = サービス事業者番号 (自事業所番号)
 *   21 サービス事業所名         ―     フリーテキスト (実績 = 実績の事業者名)
 *   22 サテライト枝番           2     サテライト以外は Null (空)
 *   23 ３０日超区分             1  ○  1:該当 / 0:非該当
 *   24 更新業者コード           10     実績 = サービス事業者番号
 *   25 識別子                  1     ※使用しない (空)
 *
 * ※ 本ビルダーが未対応 / 仮置きの項目は関数末尾コメントおよび呼出側 report を参照。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { NAME_IN_CHUNK } from "@/lib/chunk-parallel";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { validInMonth } from "@/lib/service-code-valid";

// CSVバージョン (YYYYMM)。仕様が制度改正で改版された際に更新する。
// 令和6年10月版 (4.1) を採用。
export const CAREPLAN_V4_CSV_VERSION = "202410";

// 第6表/実績 の項目数 (No.1〜25)。列数の自己検証に使う。
const JISSEKI_FIELD_COUNT = 25;

// ─── 入力 (集計済みの実績源) ────────────────────────────────────────────────

/** 1 実績レコード (client × サービス利用日 × サービスコード × 回数) の素材 */
export interface JissekiVisit {
  /** 実績日 (YYYY-MM-DD) */
  date: string;
  /** サービス名 (身体介護3 等)。マスタ解決に使う */
  serviceType: string;
  /** サービス開始時刻 (HH:MM or HH:MM:SS)。null = 時間表示なし */
  startTime: string | null;
  /** サービス終了時刻 (HH:MM or HH:MM:SS)。null = 時間表示なし */
  endTime: string | null;
}

/** 利用者 1 名分の実績出力素材 */
export interface JissekiUser {
  clientId: string;
  /** 氏名 (エラー表示用) */
  name: string;
  /** 保険者番号 (証記載。6桁) */
  insurerNumber: string | null;
  /** 被保険者番号 (10桁。生保単独は H+9桁) */
  insuredNumber: string | null;
  /** 担当居宅介護支援事業所番号 (10桁)。No.6 プラン担当業者コード */
  careOfficeNumber: string | null;
  /** 担当ケアマネ事業所名。No.7 プラン担当者名 (事業所名で代替) */
  careOfficeName: string | null;
  /** 当月の実績 (日別・サービス別に展開する前の生シフト) */
  visits: JissekiVisit[];
}

export interface JissekiBuildOptions {
  year: number;
  month: number; // 1-12
  /** 送信元 (自) 事業所番号 (10桁)。offices.business_number */
  senderOfficeNumber: string;
  /** 送信元サービス種類コード (2桁)。訪問介護 = 11 等 */
  senderServiceKind: string;
  /** 送信先 (ケアマネ) 事業所番号 (10桁)。未入力可 (空欄) */
  receiverOfficeNumber?: string | null;
  /** 送信先サービス種類コード (2桁)。居宅介護支援 = 43。未入力可 */
  receiverServiceKind?: string | null;
  /** 送信元事業所名 (No.21 サービス事業所名)。実績の事業者名 */
  senderOfficeName?: string | null;
}

export interface JissekiBuildResult {
  /** CSV 本体 (CRLF 区切り。Shift-JIS 変換前の文字列)。空実績なら null */
  content: string | null;
  /** 推奨ファイル名 (UPJSK_...CSV) */
  fileName: string;
  /** データレコード件数 */
  recordCount: number;
  /** 取込前に確認が必要な事項 (UI で警告表示) */
  warnings: string[];
}

// ─── 書式ヘルパ ─────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' → 'YYYYMMDD' */
const dateNum = (iso: string): string => iso.replaceAll("-", "");

/** 'HH:MM' / 'HH:MM:SS' → 'HHMM'。null は時間表示なし = '9999' */
function timeToHHMM(t: string | null): string {
  if (!t) return "9999";
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return "9999";
  return `${m[1].padStart(2, "0")}${m[2]}`;
}

/**
 * CSV フィールドのエスケープ。
 * 仕様: フリーテキストは "" で囲い、改行・半角カンマは削除しない。
 *       内部の " は "" にエスケープする。
 * 数値・コード等は素の値でよいが、カンマ/改行/" を含む可能性がある値は
 * 常にクォートして安全側に倒す。
 */
function csvField(v: string): string {
  if (v === "") return "";
  if (/[",\r\n]/.test(v)) {
    return `"${v.replaceAll('"', '""')}"`;
  }
  return v;
}

/** YYYYMMDDHHMMSS (14桁) — ファイル名連番用のローカル現在時刻 */
function timestamp14(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 実績ファイル名 (第6表/実績)。spec.txt / layout.txt 348行の命名規約:
 *   UPJSK_対象年月_送信元事業所番号_送信元サービス種類_送信先事業所番号_送信先サービス種類_YYYYMMDDHHMMSS.CSV
 * 送信先が未入力の場合は空文字 (アンダースコアは維持)。
 */
export function buildJissekiFileName(opts: {
  year: number;
  month: number;
  senderOfficeNumber: string;
  senderServiceKind: string;
  receiverOfficeNumber?: string | null;
  receiverServiceKind?: string | null;
  now?: Date;
}): string {
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  return [
    "UPJSK",
    ym,
    (opts.senderOfficeNumber ?? "").trim(),
    (opts.senderServiceKind ?? "").trim(),
    (opts.receiverOfficeNumber ?? "").trim(),
    (opts.receiverServiceKind ?? "").trim(),
    timestamp14(opts.now),
  ].join("_") + ".CSV";
}

// ─── 内部: サービスコード / 単位数マスタ解決 ─────────────────────────────────

interface ServiceMaster {
  /** サービスコード 6 桁 */
  code: string | null;
  /** 1回あたり単位数 (割引後の素の所定単位) */
  units: number;
  /** 制度 (介護 / 総合事業 / 障害 / 独自) */
  system: string;
}

/**
 * service_type (サービス名) → マスタ (コード / 単位数 / 制度) を解決する。
 * visit-seikyu/aggregate.ts と同じ流儀:
 *   - serviceNameVariantsAll で全角/半角ゆらぎを吸収して検索
 *   - validInMonth で対象月に有効な世代のみ採用
 *   - 正規化キー (toHankakuDigits) で引く
 *   - 同名が複数制度にある場合は 介護 > 総合事業 > 独自 > 障害 の優先
 */
async function resolveServiceMasters(
  supabase: SupabaseClient,
  year: number,
  month: number,
  serviceTypes: string[],
): Promise<Map<string, ServiceMaster>> {
  const SYSTEM_PRIORITY: Record<string, number> = {
    介護: 0,
    総合事業: 1,
    独自: 2,
    障害: 3,
  };
  const byNorm = new Map<string, ServiceMaster>();
  const variants = serviceNameVariantsAll(serviceTypes);
  for (let i = 0; i < variants.length; i += NAME_IN_CHUNK) {
    const chunk = variants.slice(i, i + NAME_IN_CHUNK);
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_name, units, service_code, system")
        .in("service_name", chunk)
        .eq("calculation_type", "基本"),
      year,
      month,
    );
    if (error) throw new Error(`サービスコード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      service_name: string;
      units: number;
      service_code: string | null;
      system: string;
    }[]) {
      const key = toHankakuDigits(r.service_name);
      const prev = byNorm.get(key);
      if (
        !prev ||
        (SYSTEM_PRIORITY[r.system] ?? 9) < (SYSTEM_PRIORITY[prev.system] ?? 9)
      ) {
        byNorm.set(key, {
          code: r.service_code,
          units: r.units,
          system: r.system,
        });
      }
    }
  }
  return byNorm;
}

// ─── メイン: 第6表/実績 CSV を組み立てる ────────────────────────────────────

/**
 * 第6表/実績 CSV を生成する。
 *
 * 実績源: JissekiUser[] (呼出側で kaigo_visit_schedule status='completed' を
 *         利用者ごとに集約したもの)。介護保険サービス (system=介護) のみ出力対象。
 *
 * レコード単位: (利用者 × サービス利用日 × サービスコード) を 1 レコードとし、
 *   同日・同サービスの複数回訪問は No.14 サービス回数に集約する。
 *   No.12/13 の時刻は当日・当サービスの最初/最後の訪問時刻を採用する。
 */
export async function buildJissekiCsv(
  supabase: SupabaseClient,
  users: JissekiUser[],
  opts: JissekiBuildOptions,
): Promise<JissekiBuildResult> {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const createdDate = dateNum(
    (() => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    })(),
  );

  const sender = (opts.senderOfficeNumber ?? "").trim();
  if (!/^\d{10}$/.test(sender)) {
    warnings.push(
      `送信元事業所番号が 10 桁の数字ではありません ("${sender}") — 事業所管理で正しい事業所番号を設定してください`,
    );
  }

  // 全利用者の全サービス名を一括でマスタ解決 (対象月世代)
  const allServiceTypes = Array.from(
    new Set(users.flatMap((u) => u.visits.map((v) => v.serviceType))),
  );
  const masters =
    allServiceTypes.length > 0
      ? await resolveServiceMasters(
          supabase,
          opts.year,
          opts.month,
          allServiceTypes,
        )
      : new Map<string, ServiceMaster>();
  const masterOf = (name: string): ServiceMaster | undefined =>
    masters.get(toHankakuDigits(name));

  const lines: string[] = [];

  for (const u of users) {
    const insurer = (u.insurerNumber ?? "").trim();
    const insured = (u.insuredNumber ?? "").trim();
    if (!insurer) warnings.push(`${u.name}: 保険者番号が未登録です`);
    if (!insured) warnings.push(`${u.name}: 被保険者番号が未登録です`);
    if (!u.careOfficeNumber) {
      warnings.push(
        `${u.name}: 担当居宅介護支援事業所 (プラン担当業者コード) が未登録です`,
      );
    }

    // (サービスコード × サービス利用日) で集約: 回数 + 最初/最後の時刻
    interface DayAgg {
      code: string | null;
      serviceType: string;
      units: number;
      count: number;
      startTime: string | null; // 最も早い開始
      endTime: string | null; // 最も遅い終了
    }
    // key = `${serviceCodeOrName}|${date}`
    const agg = new Map<string, DayAgg>();
    for (const v of u.visits) {
      const m = masterOf(v.serviceType);
      // 介護保険サービス (system=介護) のみ連携対象。障害/総合/独自は除外。
      if (!m || m.system !== "介護") {
        if (m && m.system !== "介護") {
          // 連携対象外サービスが実績に混在 — レコードは生成しない (spec 2.6)
          continue;
        }
        // マスタ未一致 — コード不明で出力できないため警告して除外
        warnings.push(
          `${u.name}: 「${v.serviceType}」(${v.date}) のサービスコードがマスタから引けません — このレコードは出力されません`,
        );
        continue;
      }
      const key = `${m.code ?? v.serviceType}|${v.date}`;
      const cur = agg.get(key);
      if (!cur) {
        agg.set(key, {
          code: m.code,
          serviceType: v.serviceType,
          units: m.units,
          count: 1,
          startTime: v.startTime,
          endTime: v.endTime,
        });
      } else {
        cur.count += 1;
        // 最も早い開始 / 最も遅い終了に更新 (HHMM 文字列比較で足りる)
        if (v.startTime && (!cur.startTime || v.startTime < cur.startTime)) {
          cur.startTime = v.startTime;
        }
        if (v.endTime && (!cur.endTime || v.endTime > cur.endTime)) {
          cur.endTime = v.endTime;
        }
      }
    }

    // 日付順 → コード順 に並べて安定出力
    const records = Array.from(agg.entries())
      .map(([key, a]) => ({ date: key.split("|")[1], ...a }))
      .sort((x, y) =>
        x.date !== y.date
          ? x.date.localeCompare(y.date)
          : (x.code ?? "").localeCompare(y.code ?? ""),
      );

    for (const rec of records) {
      // 第6表/実績 No.1〜25 を項目順どおりに生成する。
      const fields: string[] = [
        CAREPLAN_V4_CSV_VERSION, // 1 CSVバージョン
        insurer, // 2 保険者番号
        insured, // 3 被保険者番号
        createdDate, // 4 作成年月日 (ファイル作成日)
        ym, // 5 対象年月 (サービス提供年月)
        (u.careOfficeNumber ?? "").trim(), // 6 プラン担当業者コード (居宅支援事業者番号)
        csvField(u.careOfficeName ?? ""), // 7 プラン担当者名 (事業所名で代替)
        String(rec.units), // 8 単位数 (割引後・1回あたり)
        "", // 9 前月までの短期入所利用日数 (訪問介護は対象外)
        dateNum(rec.date), // 10 サービス利用日
        "", // 11 日割対象日 (日割以外は Null)
        timeToHHMM(rec.startTime), // 12 サービス開始時刻
        timeToHHMM(rec.endTime), // 13 サービス終了時刻
        String(rec.count), // 14 サービス回数
        rec.code ?? "", // 15 サービスコード
        "", // 16 TAISコード (福祉用具のみ)
        "", // 17 福祉用具届出コード (福祉用具のみ)
        "", // 18 用具名称 (福祉用具のみ)
        "", // 19 明細判別コード (福祉用具のみ)
        sender, // 20 サービス事業者コード (実績 = 自事業所番号)
        csvField(opts.senderOfficeName ?? ""), // 21 サービス事業所名
        "", // 22 サテライト枝番 (サテライト以外は Null)
        "0", // 23 ３０日超区分 (訪問介護は非該当 = 0)
        sender, // 24 更新業者コード (実績 = サービス事業者番号)
        "", // 25 識別子 (※使用しない)
      ];
      if (fields.length !== JISSEKI_FIELD_COUNT) {
        // 実装ミスの早期検出 (レイアウト逸脱を絶対に出さない)
        throw new Error(
          `第6表/実績 の項目数が不正です (期待 ${JISSEKI_FIELD_COUNT} / 実際 ${fields.length})`,
        );
      }
      lines.push(fields.join(","));
    }
  }

  const fileName = buildJissekiFileName(opts);

  if (lines.length === 0) {
    return { content: null, fileName, recordCount: 0, warnings };
  }

  return {
    content: lines.join("\r\n") + "\r\n",
    fileName,
    recordCount: lines.length,
    warnings,
  };
}
