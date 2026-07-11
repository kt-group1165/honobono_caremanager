/**
 * 国保連伝送ファイル: 居宅介護支援事業所分 (給付管理票 + 居宅介護支援費請求)
 *
 * インタフェース仕様書 (居宅介護支援事業所編) 準拠。抜粋は
 * apps/kaigo-app/migrations/_if_kyotaku.txt に保存済み。
 *
 * ファイル 1: 給付管理票 (データ種別 821)
 *   8211 給付管理票総括票情報 (17 項目) × 1
 *   8221 給付管理票情報 (24 項目) — 利用者ごとに 明細行 01〜98 + 終端行 99
 * ファイル 2: 居宅介護支援費請求 (データ種別 711)
 *   7111 介護給付費請求書情報 (18 項目) × 1
 *   8121 介護給付費請求明細書 (居宅サービス計画費) 情報 (18 項目) × 利用者
 *
 * コントロール/データ/エンドレコードの枠組み・Shift_JIS 出力は
 * build.ts (サービス事業所分) と共通。
 *
 * 短期入所 (サービス種類 21/22/23/2A) の扱い (_if_kyotaku.txt ※6):
 *   対象年月が平成14年1月以降は「3:居宅サービス給付管理票」1 本に
 *   短期入所も給付計画「単位数」で記載する (種別 1/2 の分離・日数管理・
 *   8211 項15-17 の短期入所票件数は 対象年月が平成13年12月以前のみ)。
 */

// 要介護状態区分コード (被保険者証記載の標準コード)
export const CARE_LEVEL_CODE: Record<string, string> = {
  事業対象者: "06",
  要支援1: "12",
  要支援2: "13",
  要介護1: "21",
  要介護2: "22",
  要介護3: "23",
  要介護4: "24",
  要介護5: "25",
};

// サービス種類コード (名称 → 2 桁)
export const SERVICE_KIND_CODE: Record<string, string> = {
  訪問介護: "11",
  訪問入浴介護: "12",
  訪問看護: "13",
  訪問リハビリテーション: "14",
  訪問リハ: "14",
  通所介護: "15",
  通所リハビリテーション: "16",
  通所リハ: "16",
  福祉用具貸与: "17",
  短期入所生活介護: "21",
  短期入所: "21", // 施設区分の無い略称は生活介護 (21) 扱い (create 画面等の語彙)
  短期入所療養介護: "22", // 施設区分の無い名称は老健 (22) を既定 (billing-content.tsx と同じ)
  "短期入所療養介護(老健)": "22",
  "短期入所療養介護(病院療養型)": "23",
  "短期入所療養介護(医療院)": "2A", // kaigo_service_codes 実データも 2A 系 (例: 2A1201)
  居宅療養管理指導: "31",
  "定期巡回・随時対応型訪問介護看護": "32",
  夜間対応型訪問介護: "33",
  認知症対応型通所介護: "36",
  小規模多機能型居宅介護: "37",
};

/**
 * 短期入所系サービス種類コード (21/22/23/2A)。
 * _if_kyotaku.txt ※6 (8221 レイアウト備考): 対象年月が平成14年1月以降は
 * 短期入所も含めて「3:居宅サービス給付管理票」1 本に単位数で記載するため、
 * この区別は 対象年月が平成13年12月以前 (種別 1/2 の分離・日数管理) でのみ必要。
 */
const SHORT_STAY_KIND_CODES = new Set(["21", "22", "23", "2A"]);

/** 平成14年1月 (200201) = 給付管理票が種別3 (居宅サービス) に一本化された対象年月 */
const UNIFIED_KYUFU_KANRI_YM = 200201;

const genderCode = (g: string | null | undefined) =>
  g == null ? "" : g.includes("女") ? "2" : g.includes("男") ? "1" : "";
const dateNum = (iso: string | null | undefined) => (iso ? iso.replaceAll("-", "") : "");
const ymNum = (iso: string | null | undefined) => (iso ? iso.replaceAll("-", "").slice(0, 6) : "");

/**
 * 月途中の保険者変更 (転居) 情報 — 呼出側が detectMidMonthChange (cert-for-month.ts)
 * で検出した内容を渡す (MidMonthCertChange["insurerChange"] と構造互換)。
 *
 * 採用ルール (2026-07-11 保険者別分割対応):
 *   仕様書 (_if_kyotaku.txt) に「月途中の保険者変更時の取扱い」の明文は無いが、
 *   給付管理票の点検事項 (L4559-4568)「同一の保険者・被保険者で、当該年月において
 *   同一の給付管理票が2件以上（複数）ないか」より、給付管理票のキーは
 *   保険者×被保険者×対象年月 — 転居月は新旧保険者それぞれで限度額満額・
 *   明細書も保険者別 (制度根拠確認済) のため、保険者別に別票を作成する。
 *
 *   給付管理票 (8221):
 *     - splitSegments (期間別の認定セグメント。resolveCertSegmentsForMonth 由来)
 *       が 2 件以上ある場合、保険者別に票を分割して出力する。
 *       各票の被保険者番号・保険者番号・限度額 (項15 = 満額) はセグメントの認定から。
 *     - 明細行の単位数配分は dailyActuals (自事業所の訪問介護実績 = 日別) を
 *       按分根拠として、給付管理データの月合計をセグメント別実績の比で配分する
 *       (実績合計 = 月合計なら実集計値そのまま。合計は必ず月合計と一致)。
 *     - 日別根拠の無い行 (外部サービス等) は月末側 (新保険者側) に全量計上し warning。
 *     - splitSegments が無い (境界日不明等で分割できない) 場合は従来どおり
 *       月末時点の保険者番号・被保険者番号で 1 票出力し warning。
 *   居宅介護支援費 (月額・計画費 8121) は「月末時点の保険者に 1 本」が一般実務のため
 *   月末時点の保険者で出力する (分割しない)。
 *   ⚠要外部確認: 計画費の請求先は仕様書に明文なし — 国保連合会/保険者に確認すること。
 */
export interface MidMonthInsurerChange {
  fromInsurer: string | null;
  toInsurer: string | null;
  fromInsured: string | null;
  toInsured: string | null;
  /** 変更後認定の適用開始日 (判定できない場合 null) */
  boundaryDate: string | null;
}

/** 保険者変更 warning の共通文言 ("保険者 1234→5678" / "被保険者番号 …→…") */
function insurerChangeDesc(mc: MidMonthInsurerChange): string {
  const insurerDiff =
    !!mc.fromInsurer && !!mc.toInsurer && mc.fromInsurer.trim() !== mc.toInsurer.trim();
  return insurerDiff
    ? `保険者 ${mc.fromInsurer}→${mc.toInsurer}`
    : `被保険者番号 ${mc.fromInsured ?? "?"}→${mc.toInsured ?? "?"}`;
}

export interface KyufuKanriLine {
  /** サービス事業所番号 (10 桁) */
  officeNumber: string;
  /** サービス種類コード (2 桁) */
  serviceKindCode: string;
  /** 給付計画単位数 */
  plannedUnits: number;
  /** warning 表示用ラベル (例: "訪問介護(○○事業所)")。伝送内容には使わない */
  label?: string;
}

/**
 * 月内の認定セグメント (保険者別分割の 1 票分)。
 * resolveCertSegmentsForMonth (cert-for-month.ts) の CertSegment から呼出側が変換する。
 */
export interface KyufuKanriSegment {
  /** セグメント期間 (両端含む 'YYYY-MM-DD') */
  from: string;
  to: string;
  insurerNumber: string;
  insuredNumber: string;
  careLevel: string | null;
  /** 限度額適用期間 (このセグメントの認定の有効期間で代用) */
  limitStart: string | null;
  limitEnd: string | null;
  /** 区分支給限度基準額 (単位) — 各セグメントの認定の限度額を満額設定 */
  limitUnits: number;
}

/**
 * 自事業所の訪問介護実績 (日別) — 保険者別分割の按分根拠。
 * kaigo_visit_schedule (status=completed) 由来。
 */
export interface KyufuKanriDailyActual {
  /** 実績日 ('YYYY-MM-DD') */
  date: string;
  /** サービス種類コード (2 桁。kaigo_service_codes.service_category) */
  serviceKindCode: string;
  /** サービス事業所番号 (10 桁)。office_id 未設定の移行期データは null */
  officeNumber: string | null;
  /** 1 回あたり単位数 (基本サービスコードの単位数) */
  units: number;
}

/** 給付管理票情報作成区分コード (8221 項5): 1=新規 / 2=修正 / 3=取消 */
export type KyufuKanriSakuseiKubun = "1" | "2" | "3";

export interface KyufuKanriUser {
  userName: string;
  insurerNumber: string;
  insuredNumber: string;
  birthDate: string | null;
  gender: string | null;
  careLevel: string | null;
  /** 限度額適用期間 (認定有効期間で代用可) */
  limitStart: string | null;
  limitEnd: string | null;
  /** 区分支給限度基準額 (単位) */
  limitUnits: number;
  lines: KyufuKanriLine[];
  /**
   * 給付管理票情報作成区分 (1=新規 / 2=修正 / 3=取消)。
   * 省略時は "1" (新規)。月遅れ・返戻の再請求分は通常 "2" (修正)。
   */
  sakuseiKubun?: KyufuKanriSakuseiKubun;
  /**
   * 月途中の保険者変更 (転居)。splitSegments が 2 件以上あれば保険者別に票を
   * 分割して出力し、無ければ従来どおり月末時点の保険者で 1 票 + warning。
   */
  midMonthInsurerChange?: MidMonthInsurerChange | null;
  /**
   * 保険者別分割用の認定セグメント (start 昇順・2 件以上で分割)。
   * 境界日が判定できない場合は渡さない (= 従来 warning)。
   */
  splitSegments?: KyufuKanriSegment[] | null;
  /** 自事業所の訪問介護実績 (日別) — 分割時の按分根拠。分割なしは不要 */
  dailyActuals?: KyufuKanriDailyActual[];
}

export interface KyotakuDensouOptions {
  /** 居宅介護支援事業所番号 (10 桁) */
  officeNumber: string;
  /** サービス提供 (対象) 年月 */
  year: number;
  month: number;
  /** 地域区分単価 (円) — 計画費の請求金額計算用 */
  unitPrice: number;
  /**
   * コントロールレコードの処理対象年月 (国保連が電算処理=審査を実行する年月)。
   * 省略時はサービス提供月の翌月。
   * 月遅れ再請求 (元提供月ファイル) を今月提出する場合は「今月+1」を明示指定する。
   */
  shoriYear?: number;
  shoriMonth?: number;
}

interface BuildResult {
  content: string;
  fileName: string;
  dataRecordCount: number;
  warnings: string[];
}

/**
 * コントロール/データ/エンドレコードを組み立てる。
 * ⚠ shoriYm (項11 処理対象年月) は「国保連合会での電算処理 (審査) を実行する年月」
 *   (_if_kyotaku.txt 注1)。サービス提供月ではない。
 *   通常 = サービス提供月の翌月 (= 提出月と同月)。
 *   例: 2000年4月サービス提供分を 5月に審査 → "200005"。
 *   月遅れ再請求では元提供月に関わらず「今回提出分の審査月」を設定する。
 */
function assemble(dataParts: string[][], dataKind: string, office: string, shoriYm: string, fileName: string): Omit<BuildResult, "warnings"> {
  const lines: string[] = [];
  let recNo = 1;
  lines.push(
    ["1", String(recNo++), "0", String(dataParts.length), dataKind, "0", "0", office, "0", "1", shoriYm, "1"].join(","),
  );
  for (const parts of dataParts) lines.push(["2", String(recNo++), ...parts].join(","));
  lines.push(["3", String(recNo++)].join(","));
  return { content: lines.join("\r\n") + "\r\n", fileName, dataRecordCount: dataParts.length };
}

/** 処理対象年月 (YYYYMM)。opts.shoriYear/Month 優先、既定はサービス提供月の翌月 */
function shoriYmOf(opts: KyotakuDensouOptions): string {
  if (opts.shoriYear && opts.shoriMonth) {
    return `${opts.shoriYear}${String(opts.shoriMonth).padStart(2, "0")}`;
  }
  const d = new Date(opts.year, opts.month, 1); // 提供月の翌月 1 日
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ─── 保険者別分割 (月途中の保険者変更 = 転居) ────────────────────────────────

/** 1 票分の出力内容 (通常 = 利用者情報そのまま 1 票 / 保険者変更時 = セグメント別) */
interface KyufuKanriTicket {
  insurerNumber: string;
  insuredNumber: string;
  careLevel: string | null;
  limitStart: string | null;
  limitEnd: string | null;
  /** 区分支給限度基準額 (項15)。分割票も各セグメントの認定の限度額を満額設定 */
  limitUnits: number;
  lines: KyufuKanriLine[];
  /** 分割票のセグメント期間 (warning 表示用)。通常票 (分割なし) は null */
  period: { from: string; to: string } | null;
}

/** 通常 (分割なし) の 1 票 — 従来出力と同一内容 */
function singleTicket(u: KyufuKanriUser): KyufuKanriTicket {
  return {
    insurerNumber: u.insurerNumber,
    insuredNumber: u.insuredNumber,
    careLevel: u.careLevel,
    limitStart: u.limitStart,
    limitEnd: u.limitEnd,
    limitUnits: u.limitUnits,
    lines: u.lines,
    period: null,
  };
}

/** warning 表示用の行ラベル */
function lineLabel(l: KyufuKanriLine): string {
  return (
    l.label ??
    `サービス種類${l.serviceKindCode || "?"}${l.officeNumber ? ` (事業所 ${l.officeNumber})` : ""}`
  );
}

/**
 * 保険者別分割の票を組み立てる。
 *
 * 配分ルール:
 *   - 各明細行 (サービス種類×事業所) に対応する日別実績 (dailyActuals) を
 *     セグメント別に実集計し、給付管理データの月合計単位数をその比で配分する。
 *     累積 round 方式のため配分合計は必ず月合計と一致し、実績合計 = 月合計の
 *     場合は各セグメントの実集計値がそのまま載る。
 *   - 日別実績が無い行 (外部サービス等) は按分根拠が無いため月末側
 *     (新保険者側) に全量計上し warning (給付管理データの期間別手修正を案内)。
 *   - 単位数が 0 になったセグメントの票は出力しない (票 1 枚に縮退することもある)。
 */
function buildSplitTickets(u: KyufuKanriUser, warnings: string[]): KyufuKanriTicket[] {
  const segs = u.splitSegments!;
  const daily = u.dailyActuals ?? [];
  const n = segs.length;
  const linesPerSeg: KyufuKanriLine[][] = segs.map(() => []);
  const unallocated: string[] = [];

  // 同一サービス種類コードの行数 (事業所番号不明の日別実績のフォールバック照合用)
  const kindLineCount = new Map<string, number>();
  for (const l of u.lines) {
    kindLineCount.set(l.serviceKindCode, (kindLineCount.get(l.serviceKindCode) ?? 0) + 1);
  }

  for (const l of u.lines) {
    // 行に対応する日別実績: サービス種類コード + 事業所番号 の一致で対応づける。
    // 事業所番号を引けない実績 (office_id 未設定の移行期データ) は、その種類の行が
    // 1 行だけの場合に限り対応づける (複数事業所の行への二重計上を防ぐ)。
    const soleKindLine = (kindLineCount.get(l.serviceKindCode) ?? 0) === 1;
    const matched = daily.filter(
      (d) =>
        d.serviceKindCode === l.serviceKindCode &&
        ((!!d.officeNumber && d.officeNumber === l.officeNumber) ||
          (!d.officeNumber && soleKindLine)),
    );
    const perSegActual = segs.map((s) =>
      matched.reduce((sum, d) => (d.date >= s.from && d.date <= s.to ? sum + d.units : sum), 0),
    );
    const actualTotal = perSegActual.reduce((s, a) => s + a, 0);

    if (l.plannedUnits <= 0 || actualTotal <= 0) {
      // 日別の按分根拠が無い (外部サービス等) → 月末側 (新保険者側) に全量計上
      linesPerSeg[n - 1].push(l);
      if (l.plannedUnits > 0) unallocated.push(lineLabel(l));
      continue;
    }

    // 月合計をセグメント別実績の比で配分 (累積 round — 合計は必ず月合計と一致)
    let cumActual = 0;
    let allocated = 0;
    segs.forEach((_, i) => {
      let alloc: number;
      if (i === n - 1) {
        alloc = l.plannedUnits - allocated;
      } else {
        cumActual += perSegActual[i];
        const upto = Math.round((l.plannedUnits * cumActual) / actualTotal);
        alloc = upto - allocated;
        allocated = upto;
      }
      if (alloc !== 0) linesPerSeg[i].push({ ...l, plannedUnits: alloc });
    });
  }

  const tickets: KyufuKanriTicket[] = [];
  segs.forEach((s, i) => {
    if (linesPerSeg[i].length === 0) return; // 単位の無いセグメントの票は作らない
    tickets.push({
      insurerNumber: s.insurerNumber,
      insuredNumber: s.insuredNumber,
      careLevel: s.careLevel,
      limitStart: s.limitStart,
      limitEnd: s.limitEnd,
      limitUnits: s.limitUnits,
      lines: linesPerSeg[i],
      period: { from: s.from, to: s.to },
    });
  });

  if (tickets.length >= 2) {
    const desc = tickets
      .map(
        (t) =>
          `保険者${t.insurerNumber || "?"} (${t.period!.from}〜${t.period!.to}): ${t.lines.reduce((s2, l) => s2 + l.plannedUnits, 0)}単位`,
      )
      .join(" / ");
    warnings.push(
      `${u.userName}: 保険者が月内で変わっているため、給付管理票を保険者別 ${tickets.length} 票に分割して出力します (${desc})`,
    );
  }
  if (unallocated.length > 0) {
    warnings.push(
      `${u.userName}: 外部サービス ${[...new Set(unallocated)].join("、")} の単位はデータ上按分できない (日別実績なし) ため新保険者側 (月末時点の保険者) に全量計上しました — 実態と違う場合は「給付管理」画面で給付管理データを期間別に手修正してください`,
    );
  }
  return tickets;
}

/** 利用者 → 票 (通常 1 票 / 保険者変更 + 分割材料ありは保険者別 N 票) */
function ticketsOf(u: KyufuKanriUser, warnings: string[]): KyufuKanriTicket[] {
  if ((u.splitSegments?.length ?? 0) >= 2) {
    const split = buildSplitTickets(u, warnings);
    if (split.length > 0) return split;
    // 明細行なし等で分割票が組めない場合は従来どおり 1 票 (月末時点の保険者)
  } else if (u.midMonthInsurerChange) {
    const mc = u.midMonthInsurerChange;
    warnings.push(
      `${u.userName}: ${insurerChangeDesc(mc)} が月内で変わっています (境界日 ${mc.boundaryDate ?? "不明"})。境界日が判定できないため保険者別の票に分割できません — 月末時点の保険者番号・被保険者番号で 1 票のみ出力します (⚠要取込チェック: 給付管理票は保険者×被保険者×対象年月の単位のため旧保険者分の票が別途必要になる可能性があります。認定情報の適用開始日を確認するか、給付管理データを期間別に手修正してください)`,
    );
  }
  return [singleTicket(u)];
}

/** ファイル 1: 給付管理票 (8211 + 8221) */
export function buildKyufuKanriFile(
  users: KyufuKanriUser[],
  opts: KyotakuDensouOptions,
): BuildResult {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const office = (opts.officeNumber ?? "").trim();
  if (!/^\d{10}$/.test(office)) warnings.push(`居宅介護支援事業所番号が 10 桁ではありません ("${office}")`);
  const today = new Date();
  const todayNum = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  // 提出年月 = 処理対象年月 (通常サービス対象月の翌月。再請求時は opts.shoriYear/Month)
  const submitYm = shoriYmOf(opts);

  const dataParts: string[][] = [];

  // ── 給付管理票種別区分 (_if_kyotaku.txt ※6 / コード一覧 89) ──
  // 対象年月が平成14年1月 (200201) 以降: 短期入所を含む全サービスを
  // 「3:居宅サービス給付管理票」1 本に給付計画「単位数」で記載する
  // (項15=居宅サービス区分支給限度基準額、項21=設定不要)。
  // 種別 1 (訪問通所)/2 (短期入所=日数管理・項21必須) の分離は
  // 対象年月が平成13年12月以前のみ → 本システムのデータでは発生しないため未対応。
  const isUnifiedYm = Number(ym) >= UNIFIED_KYUFU_KANRI_YM;
  if (!isUnifiedYm) {
    const affected = users
      .filter((u) => u.lines.some((l) => SHORT_STAY_KIND_CODES.has(l.serviceKindCode)))
      .map((u) => u.userName);
    warnings.push(
      `対象年月 ${ym} は平成14年1月より前のため、本来は種別1 (訪問通所) / 種別2 (短期入所=日数管理) に分離した給付管理票が必要ですが未対応です — 現行様式 (種別3: 居宅サービス給付管理票・単位数) で出力します` +
        (affected.length > 0 ? ` (短期入所を含む利用者: ${affected.join("、")})` : ""),
    );
  }

  // ── 利用者 → 票 (ticket) 展開 ──
  // 通常は 1 利用者 = 1 票。月途中の保険者変更 (転居) で分割材料 (splitSegments)
  // が揃っている利用者は保険者別に複数票へ分割する。
  const userTickets = users.map((u) => ({ u, tickets: ticketsOf(u, warnings) }));

  // 8211 総括票 — 作成区分 (新規/修正/取消) ごとの件数を「票数」で集計
  // (保険者別に分割した利用者は票数分カウント = 8221 の票数と整合)。
  // 項12-14 の欄名は「自県分 訪問通所サービス・居宅サービス給付管理票」
  // (_if_kyotaku.txt 8211 レイアウト 項12-17)。種別3 (居宅サービス給付管理票) は
  // ここに計上し、項15-17 (短期入所サービス給付管理票の件数) は種別2 の票
  // (平成13年12月以前の対象年月のみ) 専用のため、平成14年1月以降は 0 が正。
  const kubunCount: Record<KyufuKanriSakuseiKubun, number> = { "1": 0, "2": 0, "3": 0 };
  for (const { u, tickets } of userTickets) kubunCount[u.sakuseiKubun ?? "1"] += tickets.length;
  dataParts.push([
    "8211", // 1 交換情報識別番号
    submitYm, // 2 提出年月
    "0", // 3 保険者番号 ("0" 固定)
    office, // 4 事業所番号 (居宅介護支援事業所)
    "1", // 5 居宅サービス計画作成区分コード (1=居宅介護支援事業所作成)
    "0", "0", "0", "0", "0", "0", // 6-11 他県分 (訪問通所・居宅/短期入所 × 新規/修正/取消)
    String(kubunCount["1"]), String(kubunCount["2"]), String(kubunCount["3"]), // 12-14 自県分 訪問通所・居宅サービス給付管理票 新規/修正/取消 (種別3 はここ)
    "0", "0", "0", // 15-17 自県分 短期入所サービス給付管理票 新規/修正/取消 (種別2 = H13.12 以前のみ → 0)
  ]);

  for (const { u, tickets } of userTickets) {
    const kubun: KyufuKanriSakuseiKubun = u.sakuseiKubun ?? "1";
    if (!u.birthDate) warnings.push(`${u.userName}: 生年月日が未登録です`);
    // 明細行の共通項目チェック (分割しても行内容は同じなので利用者単位で 1 回)
    for (const l of u.lines) {
      if (!l.officeNumber) warnings.push(`${u.userName}: サービス事業所番号が未設定の行があります`);
      if (!l.serviceKindCode) warnings.push(`${u.userName}: サービス種類コード未設定の行があります (SERVICE_KIND_CODE 未登録のサービス種別の可能性)`);
    }

    // 票ごと (通常 1 票 / 保険者別分割時は N 票) に 8221 明細 01〜98 + 終端 99 を出力
    for (const t of tickets) {
      const careCode = CARE_LEVEL_CODE[(t.careLevel ?? "").trim()] ?? "";
      const seg = t.period ? ` (${t.period.from}〜${t.period.to} の分割票)` : "";
      if (!t.insurerNumber) warnings.push(`${u.userName}: 保険者番号が未登録です${seg}`);
      if (!t.insuredNumber) warnings.push(`${u.userName}: 被保険者番号が未登録です${seg}`);
      if (!careCode) warnings.push(`${u.userName}: 要介護度 ("${t.careLevel ?? "未設定"}") をコードに変換できません${seg}`);
      if (t.limitUnits <= 0) warnings.push(`${u.userName}: 区分支給限度基準額が未登録です${seg}`);

      const head = (lineNo: string) => [
        "8221", // 1
        ym, // 2 対象年月 (分割票も同一の対象年月 — 票の別は項3/9 の保険者×被保険者)
        t.insurerNumber ? t.insurerNumber.trim().padStart(8, "0") : "", // 3 証記載保険者番号 (数字8桁・前0埋め)
        office, // 4 事業所番号 (居宅介護支援事業所)
        kubun, // 5 給付管理票情報作成区分コード (1=新規 / 2=修正 / 3=取消)
        todayNum, // 6 給付管理票作成年月日
        // 7 給付管理票種別区分コード。H14.01 以降の対象年月は短期入所も含め
        //   常に 3 (居宅サービス給付管理票) — ※6 (1/2 は H13.12 以前のみ)
        "3",
        lineNo, // 8 給付管理票明細行番号
        t.insuredNumber, // 9 被保険者番号
        dateNum(u.birthDate), // 10 被保険者生年月日
        genderCode(u.gender), // 11 性別コード
        careCode, // 12 要介護状態区分コード
        ymNum(t.limitStart), // 13 限度額適用期間 (開始)
        ymNum(t.limitEnd), // 14 限度額適用期間 (終了)
      ];

      // 明細行 (01〜98)。99 行目は終端行のため明細は最大 98 行
      let ticketLines = t.lines;
      if (ticketLines.length > 98) {
        warnings.push(
          `${u.userName}: 給付管理票の明細が ${ticketLines.length} 行あり上限 98 行を超えるため 99 行目以降を出力できません (行番号 99 は終端行のため)`,
        );
        ticketLines = ticketLines.slice(0, 98);
      }
      let total = 0;
      ticketLines.forEach((l, i) => {
        total += l.plannedUnits;
        dataParts.push([
          ...head(String(i + 1).padStart(2, "0")),
          "", // 15 訪問通所/短期入所支給限度額 (明細行は未設定 — ※4)
          "1", // 16 居宅サービス計画作成区分コード
          l.officeNumber, // 17 事業所番号 (サービス事業所)
          "1", // 18 指定/基準該当等事業所区分コード (1=指定)
          l.serviceKindCode, // 19 サービス種類コード (短期入所 21/22/23/2A も同一票に記載)
          String(l.plannedUnits), // 20 給付計画単位数 (種別3 は短期入所も単位数 — ※6。日数記載は種別2=H13.12以前のみ)
          "", // 21 限度額管理期間における前月までの給付計画日数 (種別3 は設定不要 — ※6。種別2=短期入所票のみ必須)
          "", "", "", // 22-24 (明細行は未設定 — ※4)
        ]);
      });

      // 終端行 (99)
      dataParts.push([
        ...head("99"),
        String(t.limitUnits), // 15 居宅サービス区分支給限度基準額 (単位数 — ※6。分割票は各セグメントの認定の限度額を満額)
        "1", // 16 居宅サービス計画作成区分コード
        "", // 17 事業所番号 (終端行は未設定)
        "", // 18
        "", // 19
        "", // 20
        "", // 21 (種別3 は設定不要 — ※6)
        String(total), // 22 指定サービス分小計 (単位数)
        "0", // 23 基準該当サービス分小計
        String(total), // 24 給付計画合計単位数
      ]);
    }
  }

  // ⚠ コントロールレコード項11 (処理対象年月) は「審査を実行する年月」=提出月
  //   (_if_kyotaku.txt 注1)。サービス提供月 (ym) ではない。
  return { ...assemble(dataParts, "821", office, submitYm, `K${ym}.CSV`), warnings };
}

export interface KeikakuhiUser {
  userName: string;
  insurerNumber: string;
  insuredNumber: string;
  birthDate: string | null;
  gender: string | null;
  careLevel: string | null;
  certStart: string | null; // 認定有効期間 (YYYY-MM-DD)
  certEnd: string | null;
  /** 居宅サービス計画作成依頼届出年月日 (無ければ認定開始日で代用) */
  requestDate: string | null;
  /** 居宅介護支援費のサービスコード (6 桁) と単位数 (年度別マスタから) */
  serviceCode: string;
  units: number;
  // ── 公費 (生活保護等)。省略時は公費なし (既存呼出互換) ──
  /**
   * 公費単独 (10割公費)。被保険者番号が 'H' 始まり (= 介護保険未加入の
   * 生保受給者 = みなし2号)。保険請求分の 7111 に含めず、公費請求分の
   * 7111 (区分2・法別12) へ全額 (10割) を計上する (build.ts の訪問介護と同じ扱い)。
   */
  kohiTandoku?: boolean;
  /** 公費 法別番号 (12=生活保護 等) */
  kohiHobetsu?: string | null;
  /** 公費負担者番号 (8桁) — 8121 項8。生活保護単独の場合必須 */
  kohiFutanshaNumber?: string | null;
  /** 公費受給者番号 (7桁) — 8121 項9。生活保護単独の場合必須 */
  kohiJukyushaNumber?: string | null;
  /** 月途中の保険者変更 (転居)。渡すと warning を出す (出力は月末時点の保険者に 1 本) */
  midMonthInsurerChange?: MidMonthInsurerChange | null;
}

/** ファイル 2: 居宅介護支援費請求 (7111 + 8121) */
export function buildKeikakuhiFile(
  users: KeikakuhiUser[],
  opts: KyotakuDensouOptions,
): BuildResult {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const office = (opts.officeNumber ?? "").trim();
  if (!/^\d{10}$/.test(office)) warnings.push(`居宅介護支援事業所番号が 10 桁ではありません ("${office}")`);
  const unitPrice100 = Math.round(opts.unitPrice * 100); // 単位数単価 (10.84円 → 1084)

  const dataParts: string[][] = [];

  const amountOf = (u: KeikakuhiUser) => Math.floor((u.units * unitPrice100) / 100);

  // ── 公費単独 (被保険者番号 H = 生保 10割公費) は保険請求分レコードに含めない ──
  // (build.ts 訪問介護と同じ扱い。様式第一では保険請求欄に記載せず公費請求欄の生保行へ)
  const hokenUsers = users.filter((u) => !u.kohiTandoku);
  const tandokuUsers = users.filter((u) => !!u.kohiTandoku);

  const totalUnits = hokenUsers.reduce((s, u) => s + u.units, 0);
  // 計画費は 10 割給付 (利用者負担なし)
  const totalAmount = hokenUsers.reduce((s, u) => s + amountOf(u), 0);

  // 7111 請求書情報 (保険請求分)
  dataParts.push([
    "7111",
    ym,
    office,
    "1", // 保険・公費等区分コード (1:保険請求。共通編1.4 項番79)
    "0", // 法別番号 (保険請求分は0)
    "02", // 請求情報区分コード (02:居宅介護支援・介護予防支援。共通編1.4 項番80)
    String(hokenUsers.length), // 件数
    String(totalUnits), // 単位数
    String(totalAmount), // 費用合計
    String(totalAmount), // 保険請求額 (10 割)
    "0", // 公費請求額 (公費併用でも本人負担 0 円のため振替 0)
    "0", // 利用者負担
    "", "", "", "", "", "", // 特定入所者 (対象外)
  ]);

  // 7111 請求書情報 (公費請求分 — 法別番号ごと)
  // 居宅介護支援費は 10 割給付のため、公費併用 (被保険者 + 法別12) の公費請求額は
  // 0 円 → 公費請求分レコードは公費単独 (H番号) 者のみから生成する。
  // ⚠ 要取込チェック: 公費併用で公費請求額 0 円の利用者を公費請求分 7111 の
  //    件数に計上する必要があるか (ここでは build.ts 同様、請求額 0 は計上しない)。
  // 公費単独は法別未登録でも生保 (12) として合算する (未登録は warning)
  const byHobetsu = new Map<string, KeikakuhiUser[]>();
  for (const u of tandokuUsers) {
    const h = u.kohiHobetsu?.trim() || "12";
    if (!byHobetsu.has(h)) byHobetsu.set(h, []);
    byHobetsu.get(h)!.push(u);
  }
  for (const [hobetsu, hUsers] of byHobetsu) {
    dataParts.push([
      "7111",
      ym,
      office,
      "2", // 保険・公費等区分コード (2:公費請求。共通編1.4 項番79)
      hobetsu, // 法別番号 (12=生活保護 等)
      "02", // 請求情報区分コード (02:居宅介護支援・介護予防支援)
      String(hUsers.length), // 件数
      String(hUsers.reduce((s, u) => s + u.units, 0)), // 単位数
      String(hUsers.reduce((s, u) => s + amountOf(u), 0)), // 費用合計
      "0", // 保険請求額 (公費単独は保険給付なし)
      String(hUsers.reduce((s, u) => s + amountOf(u), 0)), // 公費請求額 (10 割)
      "0", // 利用者負担
      "", "", "", "", "", "",
    ]);
  }

  for (const u of users) {
    const careCode = CARE_LEVEL_CODE[(u.careLevel ?? "").trim()] ?? "";
    if (!careCode) warnings.push(`${u.userName}: 要介護度 ("${u.careLevel ?? "未設定"}") をコードに変換できません`);
    if (!u.serviceCode) warnings.push(`${u.userName}: 居宅介護支援費のサービスコードが年度別単位数マスタにありません`);
    if (!u.requestDate) warnings.push(`${u.userName}: 計画作成依頼届出年月日が無いため認定開始日で代用しました`);
    if (u.midMonthInsurerChange) {
      const mc = u.midMonthInsurerChange;
      warnings.push(
        `${u.userName}: ${insurerChangeDesc(mc)} が月内で変わっています (境界日 ${mc.boundaryDate ?? "不明"})。居宅介護支援費 (月額) は月末時点の保険者に 1 本で請求する扱いで出力します (⚠要外部確認: 月途中の保険者変更時の請求先は仕様書 (_if_kyotaku.txt) に明文なし — 提出先を国保連合会/保険者に確認)`,
      );
    }

    // 公費 (生活保護等): 併用 (振替 0 円) でも 8121 の項8/9 (負担者番号/受給者番号) は設定する
    const hasKohi = !!u.kohiTandoku || !!u.kohiHobetsu?.trim();
    if (u.kohiTandoku && !u.kohiHobetsu?.trim()) {
      warnings.push(
        `${u.userName}: 公費単独 (被保険者番号 H) なのに公費情報 (法別番号) が未登録です — 保険情報に法別12 (生活保護) を登録してください`,
      );
    }
    if (hasKohi && !u.kohiFutanshaNumber?.trim()) {
      warnings.push(`${u.userName}: 公費 (法別${u.kohiHobetsu?.trim() || "12"}) の負担者番号が未登録です${u.kohiTandoku ? " (生活保護単独は必須)" : ""}`);
    }
    if (u.kohiTandoku && !u.kohiJukyushaNumber?.trim()) {
      warnings.push(`${u.userName}: 公費受給者番号が未登録です (生活保護単独は必須)`);
    }

    dataParts.push([
      "8121", // 1
      office, // 2 事業所番号
      "1", // 3 指定/基準該当等事業所区分コード
      ym, // 4 サービス提供年月
      u.insurerNumber ? u.insurerNumber.trim().padStart(8, "0") : "", // 5 証記載保険者番号 (数字8桁・前0埋め)
      String(unitPrice100), // 6 単位数単価
      u.insuredNumber, // 7 被保険者番号 (英数10 — H番号可)
      // 8-9 公費負担者番号/受給者番号 — 仕様書: 生活保護単独の場合必須。
      //   併用 (振替 0 円) 時も記載する (様式第七の記載例準拠)。
      //   ※ 8121 には 7131 のような公費分単位数の独立項目は無い (全18項目、仕様書確認済)。
      hasKohi ? u.kohiFutanshaNumber?.trim() ?? "" : "", // 8 公費負担者番号
      hasKohi ? u.kohiJukyushaNumber?.trim() ?? "" : "", // 9 公費受給者番号
      dateNum(u.birthDate), // 10 被保険者生年月日
      genderCode(u.gender), // 11 性別コード
      // ⚠ 要取込チェック: 仕様書の ※5「被保険者でない生活保護受給者の場合は設定不要」が
      //    どの項目 (要介護状態区分/認定有効期間) に掛かるかレイアウト上不明確。
      //    ここでは H番号者も福祉事務所の要介護認定情報をそのまま設定する。
      careCode, // 12 要介護状態区分コード
      dateNum(u.certStart), // 13 認定有効期間 (開始)
      dateNum(u.certEnd), // 14 認定有効期間 (終了)
      dateNum(u.requestDate ?? u.certStart), // 15 計画作成依頼届出年月日
      u.serviceCode, // 16 サービスコード
      String(u.units), // 17 単位数
      // 18 請求金額 — 公費単独は全額が公費請求となるが、金額自体は同じ 10 割額。
      //    (保険/公費の別は 7111 側の区分コードで表現される)
      String(amountOf(u)), // 18 請求金額
    ]);
  }

  // ⚠ コントロールレコード項11 (処理対象年月) は「審査を実行する年月」=提出月
  //   (_if_kyotaku.txt 注1: 2000年4月提供分を5月審査なら "200005")。
  return { ...assemble(dataParts, "711", office, shoriYmOf(opts), `S${ym}.CSV`), warnings };
}
