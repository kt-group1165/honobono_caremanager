/**
 * 総合事業 (介護予防・日常生活支援総合事業) 訪問型サービス (A2) の請求集計
 *
 * 介護給付 (aggregate.ts) とは別様式 (国保連 明細書 71R1 / 様式第二の三、請求書 7113) で
 * 請求するため、介護保険分と混ぜず 独立ストリームとして集計する。呼出は aggregate.ts から。
 * (7112/様式(予) は「経過措置」= みなし用の別様式であり、独自サービス A2 では使わない)
 *
 * 集計仕様 (ほのぼの相当):
 *   - 基本コード (system='総合事業', service_category='A2') の units を対象月世代 (validInMonth) で解決
 *   - unit_type='1月につき' (月額包括) は「実績が 1 件でもあれば月 1 回」= 回数を掛けない
 *     unit_type='1回につき'                = 実績回数 × units
 *   - 単価 = opts.unitPrice (事業所の地域区分単価。介護と同じ値。総合事業専用単価ではない)
 *   - 処遇改善 = 総合事業の処遇改善コード (CB_A26184 等) の formula (monthly_aggregate) で率計算。
 *     事業所の適用処遇改善 (kaigo_office_addon_periods / offices.applied_formula_codes) が
 *     介護コード (116274 等) の場合、同率の総合事業 A2 処遇改善コードにマッピングして採用する。
 *   - 給付率 = 9割/1割 (要支援・事業対象者の総合事業も原則 1 割。負担割合は認定に従う)
 *   - 限度額管理 = 認定の限度額 (service_limit_amount) 優先、無ければ 要介護度から
 *     標準の区分支給限度基準額を補完 (SOUGOU_CARE_LEVEL_LIMITS 参照)。
 *     超過分は介護給付 (aggregate.ts) と同じく保険請求から外して全額自費 (selfPayAmount) に分離。
 *     処遇改善等の%加算は限度額管理対象外 (kanriTaishougaiUnits)。
 *
 * 戻り値は UserSeikyuRow (system='総合事業')。伝送 (build-sougou.ts) / 表示で共用する。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { validInMonth } from "@/lib/service-code-valid";
import { resolveKohiForMonth, kohiHobetsuLabel } from "@/lib/kohi";
import {
  resolveCertForMonth,
  resolveCertsInMonth,
  resolveCertSegmentsForMonth,
  detectMidMonthChange,
  monthRange,
  type CertForMonth,
} from "@/lib/cert-for-month";
import type { UserSeikyuRow, SeikyuDetailLine } from "@/lib/visit-seikyu/aggregate";

interface SougouScheduleRow {
  user_id: string;
  service_type: string;
  visit_date: string;
}

/**
 * 総合事業の請求行 = UserSeikyuRow + 住所地特例 (種別14 レコード用) の optional 拡張。
 * 71R1 明細書では住所地特例対象者の明細行を種別02 ではなく
 * 種別14 (明細情報(住所地特例)。項番18 = 施設所在保険者番号) で出力する (build-sougou.ts)。
 */
export type SougouSeikyuRow = UserSeikyuRow & {
  /** 住所地特例対象者 (clients.jusho_tokurei)。列未適用 (migration 前) は false */
  jushoTokurei?: boolean;
  /**
   * 施設所在保険者番号 (数字6桁。clients.jusho_tokurei_insurer_number)。
   * 住所地特例対象者が入所(居)する施設の所在する市町村の証記載保険者番号。
   */
  jushoTokureiInsurerNumber?: string | null;
};

/**
 * 総合事業の限度額管理に使う「認定に限度額が未設定のとき」の標準補完値 (単位/月)。
 *
 * 制度根拠 (2026-07-12 一次資料確認):
 *   - 要支援1/2: 要支援者が総合事業 (サービス事業) を利用する場合は、予防給付の
 *     区分支給限度基準額 (要支援1=5,032 / 要支援2=10,531 単位。平成12年厚生省告示第33号、
 *     令和元年10月改定後の額) の範囲内で「予防給付と総合事業を一体的に給付管理」する
 *     (厚労省 介護予防・日常生活支援総合事業ガイドライン)。
 *   - 事業対象者: 市町村が給付管理の上限額を定める。国ガイドラインの標準は
 *     要支援1と同額 (5,032 単位)。保険者独自の上限は認定情報の限度額
 *     (client_insurance_records.service_limit_amount) に登録すればそちらが優先される。
 *   - 要介護1〜5: 総合事業は本来 要支援・事業対象者向けだが、区分変更月 (要支援→要介護) や
 *     継続利用要介護者 (令和3年度弾力化) の実績が紛れ得るため、介護給付の
 *     区分支給限度基準額で防御的に判定する (該当時は warning で確認を促す)。
 *
 * 合算管理の注意: 要支援の限度額は「予防給付 + 総合事業」の合算で管理される (正は
 * 給付管理票 = 地域包括/国保連側)。本集計は自事業所の総合事業実績のみを機械判定する
 * (介護給付側 aggregate.ts が自事業所実績のみで機械判定するのと同じ姿勢)。
 * 予防給付や他事業所分を含む厳密な合算はケアマネの給付管理票に委ねる。
 *
 * ※ 単位数は reports-content.tsx の CARE_LEVEL_LIMITS と同値 (令和6年度改定でも据置)。
 */
const SOUGOU_CARE_LEVEL_LIMITS: Record<string, number> = {
  事業対象者: 5032,
  要支援1: 5032,
  要支援2: 10531,
  要介護1: 16765,
  要介護2: 19705,
  要介護3: 27048,
  要介護4: 30938,
  要介護5: 36217,
};

/**
 * 保険者番号 (証記載保険者番号6桁) → 総合事業サービスコードの自治体prefix。
 *
 * 総合事業はサービスコード・単位数が保険者(市町村)ごとに独自のため、利用者の保険者番号で
 * その市町村版コードを選ぶ必要がある (1 事業所が千葉市と市原市の両方の総合事業をやり得る)。
 * prefix 固定 (旧実装は CB_ 千葉市固定) だと、他市の利用者が千葉市の単位数で誤請求になる。
 * 未登録の保険者番号は warning を出し、基本コードが引けず請求から漏れる (fail-loud で誤請求防止)。
 */
const SOUGOU_PREFIX_BY_INSURER: Record<string, string> = {
  // 千葉市 6区 (中央/花見川/稲毛/若葉/緑/美浜。コード内容は 6 区共通・保険者番号のみ差)
  "121012": "CB_",
  "121020": "CB_",
  "121038": "CB_",
  "121046": "CB_",
  "121053": "CB_",
  "121061": "CB_",
  // 木更津市
  "122069": "K_",
  // 市原市
  "122192": "IH_",
  // 茂原市
  "122101": "MB_",
  // 一宮町 (長生郡)
  "124214": "IC_",
  // 長生村 (長生郡)
  "124230": "CS_",
};

/** service_code から自治体prefix (CB_/K_/IH_) を取り出す。prefix 無し (旧共通コード) は ""。 */
function sougouPrefixFromCode(code: string | null): string {
  if (!code) return "";
  const i = code.indexOf("_");
  return i > 0 ? code.slice(0, i + 1) : "";
}

/**
 * 総合事業ストリームの集計。既に aggregate.ts で取得済みの
 * 「総合事業に該当する実績シフト」を渡してもらい、それを集計する。
 *
 * @param sougouSchedules system='総合事業' に該当する completed シフト行
 */
export async function aggregateSougouSeikyu(
  supabase: SupabaseClient,
  sougouSchedules: SougouScheduleRow[],
  opts: {
    officeId: string | null;
    year: number;
    month: number;
    unitPrice: number;
    /** 事業所の適用処遇改善コード (介護 116274 等 or 総合事業 CB_A26184 等) — 対象月世代解決済でなくてよい */
    effectiveFormulaCodes: string[];
  },
): Promise<{ rows: SougouSeikyuRow[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (sougouSchedules.length === 0) return { rows: [], warnings };

  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;

  // 1) 基本コード (A2) の units / unit_type / short_name / service_code をマスタ解決
  //    service_type (= service_name) → 総合事業マスタ (対象月世代)。
  //    ※ 同名が介護と総合事業の双方にある場合でも、ここでは system='総合事業' に限定して引く
  //      (総合事業ストリームなので総合事業コードを使う)。
  const serviceTypes = Array.from(new Set(sougouSchedules.map((s) => s.service_type)));
  const variants = serviceNameVariantsAll(serviceTypes);
  type MasterEntry = {
    units: number;
    unitType: string;
    short: string | null;
    code: string | null;
    category: string; // A2(独自/月額) or A3(訪問型サービスA/定率)。処遇改善はA2のみ対象
  };
  // 自治体prefix (CB_/K_/IH_/"") ごとに (正規化サービス名 → マスタ) を保持し、
  // 利用者の保険者番号 → prefix で正しい市町村版コードを引く (先勝ちの保険者混在を防ぐ)。
  const masterByPrefixNorm = new Map<string, Map<string, MasterEntry>>();
  for (let i = 0; i < variants.length; i += 50) {
    const chunk = variants.slice(i, i + 50);
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_name, short_name, units, unit_type, service_code, service_category")
        .eq("system", "総合事業")
        .in("service_category", ["A2", "A3"]) // A2=独自(月額) / A3=訪問型サービスA(定率/回)
        .eq("calculation_type", "基本")
        .in("service_name", chunk),
      opts.year,
      opts.month,
    );
    if (error) throw new Error(`総合事業サービスコード取得失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      service_name: string;
      short_name: string | null;
      units: number;
      unit_type: string | null;
      service_code: string | null;
      service_category: string;
    }[]) {
      const cp = sougouPrefixFromCode(r.service_code);
      const key = toHankakuDigits(r.service_name);
      let bucket = masterByPrefixNorm.get(cp);
      if (!bucket) {
        bucket = new Map();
        masterByPrefixNorm.set(cp, bucket);
      }
      // 同名の複数世代が validInMonth 後もヒットしうる。先勝ち (先頭 = 若い service_code)。
      if (!bucket.has(key)) {
        bucket.set(key, {
          units: r.units,
          unitType: r.unit_type ?? "1回につき",
          short: r.short_name,
          code: r.service_code,
          category: r.service_category,
        });
      }
    }
  }
  /** 利用者の自治体prefixで基本コードを引く。prefix 違いにはフォールバックしない (誤請求防止)。 */
  const masterOf = (name: string, prefix: string): MasterEntry | undefined =>
    masterByPrefixNorm.get(prefix)?.get(toHankakuDigits(name));

  // 2) 利用者情報 (clients + 対象月に有効な認定)
  //    住所地特例列 (jusho_tokurei / jusho_tokurei_insurer_number) は
  //    migrations/jusho_tokurei.sql 未適用の環境でも動くよう 42703 フォールバック付きで引く。
  const userIds = Array.from(new Set(sougouSchedules.map((s) => s.user_id)));
  const clientById = new Map<
    string,
    {
      name: string;
      furigana: string | null;
      birth: string | null;
      gender: string | null;
      userNumber: string | null;
      jushoTokurei: boolean;
      jushoTokureiInsurerNumber: string | null;
    }
  >();
  const CLIENT_COLS_BASE = "id, name, furigana, birth_date, gender, user_number";
  const CLIENT_COLS_JUSHO = `${CLIENT_COLS_BASE}, jusho_tokurei, jusho_tokurei_insurer_number`;
  let jushoColsAvailable = true;
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    type ClientRow = {
      id: string;
      name: string;
      furigana: string | null;
      birth_date: string | null;
      gender: string | null;
      user_number: string | null;
      jusho_tokurei?: boolean | null;
      jusho_tokurei_insurer_number?: string | null;
    };
    let rowsData: ClientRow[] | null = null;
    if (jushoColsAvailable) {
      const { data, error } = await supabase
        .from("clients")
        .select(CLIENT_COLS_JUSHO)
        .in("id", chunk);
      if (error) {
        if (error.code === "42703") {
          // 住所地特例列が未適用 — 住所地特例なし (種別02) として続行
          jushoColsAvailable = false;
        } else {
          throw new Error(`利用者取得失敗 (総合事業): ${error.message}`);
        }
      } else {
        rowsData = (data ?? []) as unknown as ClientRow[];
      }
    }
    if (rowsData == null) {
      const { data, error } = await supabase
        .from("clients")
        .select(CLIENT_COLS_BASE)
        .in("id", chunk);
      if (error) throw new Error(`利用者取得失敗 (総合事業): ${error.message}`);
      rowsData = (data ?? []) as unknown as ClientRow[];
    }
    for (const c of rowsData) {
      clientById.set(c.id, {
        name: c.name,
        furigana: c.furigana,
        birth: c.birth_date,
        gender: c.gender,
        userNumber: c.user_number,
        jushoTokurei: c.jusho_tokurei === true,
        jushoTokureiInsurerNumber: c.jusho_tokurei_insurer_number ?? null,
      });
    }
  }

  const certByClient = await resolveCertForMonth(supabase, userIds, opts.year, opts.month);
  // 月途中の保険者変更 (転居) 検出・分割用に、対象月に有効な全認定を時系列で取得
  const certsInMonthByClient = await resolveCertsInMonth(supabase, userIds, opts.year, opts.month);
  const kohiRes = await resolveKohiForMonth(supabase, userIds, opts.year, opts.month);

  // 3) 担当居宅介護支援事業所番号 (伝送の基本情報レコード用)
  const careOfficeIds = Array.from(
    new Set(
      Array.from(certByClient.values())
        .map((v) => v.care_office_id)
        .filter(Boolean) as string[],
    ),
  );
  const officeNumberById = new Map<string, string | null>();
  const officeNameById = new Map<string, string | null>();
  if (careOfficeIds.length > 0) {
    const { data, error } = await supabase
      .from("care_offices")
      .select("id, office_number, name")
      .in("id", careOfficeIds);
    if (error) throw new Error(`居宅事業所取得失敗 (総合事業): ${error.message}`);
    for (const o of (data ?? []) as { id: string; office_number: string | null; name: string | null }[]) {
      officeNumberById.set(o.id, o.office_number);
      officeNameById.set(o.id, o.name);
    }
  }

  // 4) 処遇改善: 事業所の適用処遇改善 (率) を総合事業 A2 の処遇改善コードにマッピングして採用。
  //    a. 事業所の applied formula codes (介護 116274 等 or 総合事業 CB_A26184 等) を対象月世代で解決し、
  //       monthly_aggregate の率 (numerator/denominator) と「コード下4桁 (suffix)」を得る。
  //    b. 自治体prefix ごとに次の順で採用する (2026-07-15 hybrid 化 — user 確定):
  //       1. コード番号対応 (suffix 一致。例: 介護 116184 ↔ 総合 CB_A26184/IH_A26184):
  //          - マスタに率があれば照合し、食い違えばマスタの率で算定 + 警告 (自治体独自率の検出)
  //          - マスタに率が無ければ事業所設定の率で算定 + 警告 (取込漏れでもゼロにしない)
  //       2. suffix 不一致時の fallback: 率一致で探す (旧方式。旧世代の付番違いを救済)
  //    c. どちらでも引けなければ処遇改善 0 (warning)。
  //    ※ 旧実装 (率一致のみ) は市原市 import の formula 抜けで加算が silent に消えた。
  // 率(%) は事業所共通、コードは市町村版 (CB_/K_/IH_) 別。実際の採用は per-user に
  // 利用者の保険者番号→prefix で行う (addonCandByPrefix)。
  let appliedNum = 0;
  let appliedDen = 1000;
  let appliedSuffix = ""; // 事業所処遇改善コードの下4桁 (数字のみ)。例 116184 → "6184"
  const addonCandByPrefix = new Map<
    string,
    { num: number; den: number; label: string; code: string }
  >();

  if (opts.effectiveFormulaCodes.length > 0) {
    // a. 事業所適用コードの率を解決 (介護/総合事業どちらでも formula から率を取る)。
    //    障害の処遇改善コード (115175/125175 等) は率が別体系のため除外する。
    {
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_code, formula, units, system")
          .in("service_code", opts.effectiveFormulaCodes)
          .not("formula", "is", null),
        opts.year,
        opts.month,
      );
      if (error) throw new Error(`総合事業 処遇改善率の解決に失敗: ${error.message}`);
      for (const r of (data ?? []) as {
        service_code: string;
        formula: { type?: string; numerator?: number; denominator?: number } | null;
        units: number;
        system: string;
      }[]) {
        if (r.system === "障害") continue; // 障害の率 (44.1% 等) で総合を算定しない
        const f = r.formula;
        if (f?.type === "monthly_aggregate" && f.numerator && f.denominator) {
          appliedNum = f.numerator;
          appliedDen = f.denominator;
          appliedSuffix = r.service_code.replace(/[^0-9]/g, "").slice(-4);
          break; // 処遇改善Ⅰ〜Ⅳ は排他 (最初の 1 件)
        }
      }
    }

    // b. 総合事業 A2 処遇改善コードを prefix (自治体) ごとに引き当てる。
    if (appliedNum > 0) {
      const { data, error } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_code, service_name, units, formula")
          .eq("system", "総合事業")
          .eq("service_category", "A2")
          .ilike("service_name", "%処遇改善%"),
        opts.year,
        opts.month,
      );
      if (error) throw new Error(`総合事業 処遇改善コード取得失敗: ${error.message}`);
      const cands = (data ?? []) as {
        service_code: string;
        service_name: string;
        units: number;
        formula: { type?: string; numerator?: number; denominator?: number } | null;
      }[];
      // マスタの率 = formula (あれば) → units (‰ とみなす。0 は率情報なし = null)
      const rateOf = (c: (typeof cands)[number]) =>
        c.formula?.numerator && c.formula?.denominator
          ? { num: c.formula.numerator, den: c.formula.denominator }
          : c.units > 0
            ? { num: c.units, den: 1000 }
            : null;
      // 自治体 prefix ごとに候補を束ねる
      const candsByPrefix = new Map<string, typeof cands>();
      for (const c of cands) {
        const cp = sougouPrefixFromCode(c.service_code);
        if (!candsByPrefix.has(cp)) candsByPrefix.set(cp, []);
        candsByPrefix.get(cp)!.push(c);
      }
      const pctLabel = (num: number, den: number) => `${(num * 100) / den}%`;
      for (const [cp, list] of candsByPrefix) {
        // 1) コード番号対応 (suffix): 事業所の処遇改善コード下4桁と一致する自治体版コード
        const suffixHit = appliedSuffix
          ? list.find(
              (c) => c.service_code.replace(/[^0-9]/g, "").slice(-4) === appliedSuffix,
            )
          : undefined;
        if (suffixHit) {
          const r = rateOf(suffixHit);
          if (r && r.num * appliedDen !== appliedNum * r.den) {
            // 照合不一致 = 自治体独自率の可能性。告示が正 = マスタの率で算定して知らせる
            warnings.push(
              `総合事業 処遇改善 (${cp}${suffixHit.service_code}): マスタの率 ${pctLabel(r.num, r.den)} が事業所設定 ${pctLabel(appliedNum, appliedDen)} と異なります — 自治体独自率の可能性があるためマスタの率で算定します (要確認)`,
            );
            addonCandByPrefix.set(cp, {
              num: r.num,
              den: r.den,
              label: suffixHit.service_name,
              code: suffixHit.service_code,
            });
          } else if (r) {
            // 照合一致 (通常)
            addonCandByPrefix.set(cp, {
              num: r.num,
              den: r.den,
              label: suffixHit.service_name,
              code: suffixHit.service_code,
            });
          } else {
            // マスタに率なし (取込漏れ等) → 事業所設定の率で算定 (ゼロにはしない)
            warnings.push(
              `総合事業 処遇改善 (${suffixHit.service_code}): マスタに率 (formula/単位数) が無いため、事業所設定の率 ${pctLabel(appliedNum, appliedDen)} で算定します — サービスコードの取込データを確認してください`,
            );
            addonCandByPrefix.set(cp, {
              num: appliedNum,
              den: appliedDen,
              label: suffixHit.service_name,
              code: suffixHit.service_code,
            });
          }
          continue;
        }
        // 2) fallback: 率一致 (旧方式。旧世代のコード付番が suffix 対応でない場合の救済)
        const rateHit = list.find((c) => {
          const r = rateOf(c);
          return r != null && r.num * appliedDen === appliedNum * r.den;
        });
        if (rateHit) {
          addonCandByPrefix.set(cp, {
            num: appliedNum,
            den: appliedDen,
            label: rateHit.service_name,
            code: rateHit.service_code,
          });
        }
      }
    }
  }

  // 5) 利用者ごとに集計 (service_type → 訪問日配列。保険者変更の分割で日付フィルタするため
  //    回数ではなく日付で保持する)
  const byUser = new Map<string, Map<string, string[]>>();
  for (const s of sougouSchedules) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, new Map());
    const m = byUser.get(s.user_id)!;
    if (!m.has(s.service_type)) m.set(s.service_type, []);
    m.get(s.service_type)!.push(s.visit_date);
  }

  const unitPrice = opts.unitPrice > 0 ? opts.unitPrice : 10.0;
  const unitPrice100 = Math.round(unitPrice * 100);
  const { from: monthStartIso, to: monthEndIso } = monthRange(opts.year, opts.month);

  /**
   * 1 セグメント (= 1 明細書) 分の行を組む。cert / 限度額 / 期間はセグメント単位で受け取る。
   * 月途中の保険者変更 (転居) 月は境界日で複数明細書に分割され、それ以外は月全体で 1 明細書。
   */
  const buildSougouRow = (
    userId: string,
    typeDates: Map<string, string[]>,
    seg: {
      cert: CertForMonth | null;
      segIndex: number;
      segCount: number;
      segFrom: string;
      segTo: string;
      /** このセグメントの区分支給限度基準額 (認定由来)。null = 要介護度から標準補完 */
      limitOverride: number | null;
    },
  ): SougouSeikyuRow => {
    const client = clientById.get(userId);
    const cert = seg.cert;
    const userLabel = client?.name ?? userId;
    if (cert?.isFallback) {
      warnings.push(
        `${userLabel}: 対象月 (${monthStr}) に有効な認定が見つからないため最新の認定情報で総合事業を集計しています`,
      );
    }
    // 負担率正規化 (aggregate.ts と同じ。1 以上は /10)
    const copayRaw = cert?.copay_rate != null ? Number(cert.copay_rate) : null;
    const copay =
      copayRaw == null || !Number.isFinite(copayRaw) || copayRaw <= 0 ? 0.1
      : copayRaw >= 1 ? Math.min(copayRaw / 10, 1)
      : copayRaw;

    // 利用者の保険者番号 → 自治体prefix (CB_/K_/IH_) で市町村版コードを引く。
    const insurerNum = (cert?.insurer_number ?? "").trim();
    const prefix = SOUGOU_PREFIX_BY_INSURER[insurerNum] ?? "";
    if (insurerNum && !prefix) {
      warnings.push(
        `${userLabel}: 保険者番号 ${insurerNum} の総合事業サービスコード (自治体版) が未登録です — この市町村のコードを取込むまで総合事業は請求できません (他市の単価で誤請求しないよう保留)`,
      );
    }

    // 処遇改善: 利用者の自治体版コードを採用 (率は事業所共通・コードは市町村別)
    const addon = prefix ? addonCandByPrefix.get(prefix) ?? null : null;
    const addonNum = addon?.num ?? 0;
    const addonDen = addon?.den ?? 1;
    const addonLabel = addon?.label ?? null;
    const addonCode = addon?.code ?? null;
    if (appliedNum > 0 && prefix && !addon) {
      warnings.push(
        `${userLabel}: 事業所の処遇改善率に一致する ${prefix} (保険者 ${insurerNum}) の総合事業処遇改善コードが見つかりません — 処遇改善なしで集計しています (サービスコードマスタを確認してください)`,
      );
    }

    // 基本コードの単位を積む。月額包括 (1月につき) は回数を掛けない (月1)。
    const details: SeikyuDetailLine[] = [];
    let grossBaseUnits = 0;
    let grossA3Units = 0; // 訪問型サービスA(定率)分。処遇改善の基礎からは除外する
    for (const [svcType, dates] of typeDates) {
      const count = dates.length;
      const master = masterOf(svcType, prefix);
      if (!master) {
        warnings.push(
          `${userLabel}: 総合事業「${svcType}」がマスタ (system=総合事業/A2・A3/${prefix || "自治体prefix無し"}/対象月世代) から引けません — サービス名/有効期間/保険者番号(${insurerNum || "未設定"})を確認してください`,
        );
        continue;
      }
      const isMonthly = master.unitType.includes("月"); // '1月につき' = 月額包括
      const billCount = isMonthly ? 1 : count;
      const units = master.units * billCount;
      grossBaseUnits += units;
      if (master.category === "A3") grossA3Units += units;
      details.push({
        service_type: svcType,
        short_name: master.short ?? null,
        service_code: master.code,
        unit_per: master.units,
        count: billCount,
        units,
      });
    }
    details.sort((a, b) => b.units - a.units);

    // ── 限度額管理 (aggregate.ts の区分支給限度基準と同方式) ──
    // 基準値 = 認定の限度額 (service_limit_amount) 優先、無ければ要介護度から標準額を補完
    // (SOUGOU_CARE_LEVEL_LIMITS。事業対象者=要支援1相当 5,032単位)。どちらも無ければ管理なし。
    // ※ 計画単位数 (kaigo_monthly_plan_units) とケアマネ手割振り (kaigo_gendo_allocation) は
    //   介護給付ストリームが消費する利用者×月の 1 値のため、総合事業側では使わない
    //   (両ストリームに同一値を適用すると併用時に二重計上/二重控除になる)。
    const careLevelNorm = toHankakuDigits((cert?.care_level ?? "").trim());
    // 限度額 = セグメントの認定由来値 (分割時=期間に重なる全認定の max、非分割時=当月認定)
    // を優先。無ければ要介護度から標準補完 (SOUGOU_CARE_LEVEL_LIMITS)。
    const limitUnits = seg.limitOverride ?? SOUGOU_CARE_LEVEL_LIMITS[careLevelNorm] ?? null;
    if (limitUnits == null && grossBaseUnits > 0) {
      warnings.push(
        `${userLabel}: 総合事業の限度額を解決できません (要介護度「${cert?.care_level ?? "未設定"}」・認定の限度額なし) — 限度額管理なしで集計します。認定情報を確認してください`,
      );
    }
    if (/^要介護/.test(careLevelNorm)) {
      warnings.push(
        `${userLabel}: 要介護度「${cert?.care_level}」で総合事業の実績があります — 区分変更月または継続利用要介護者の可能性があります。要介護者の限度額は介護給付と合算管理のため、機械判定 (総合事業分のみ) の超過を請求前に確認してください`,
      );
    }
    // 管理対象 = 基本コードの全量 (総合事業ストリームは基本コードのみ積む。
    // 初回加算等の実績単位加算は現状 集計経路なし)。処遇改善%加算は限度額管理対象外
    // (介護給付と同じ扱い。サービスコード表の支給限度額管理「対象外」区分) のため
    // 超過判定は %加算前の単位数で行う。
    const managedUnits = grossBaseUnits;
    const overUnits =
      limitUnits != null ? Math.min(Math.max(0, managedUnits - limitUnits), managedUnits) : 0;
    // 基準内単位数 = 保険給付対象。超過分は保険請求から外し 10割自費 (selfPayAmount) へ振替
    const baseUnits = grossBaseUnits - overUnits;
    // 処遇改善 (%加算) は保険給付対象の基準内単位に対して計算 (介護と同方式。
    // 超過自費分には掛けない = 自費請求は素の単位×単価×10割)。
    // A3(訪問型サービスA/定率)は処遇改善対象外のため基礎から除外する (ほのぼの準拠)。
    const addonBaseUnits = Math.max(0, baseUnits - grossA3Units);
    const addonUnits = addonNum > 0 ? Math.round((addonBaseUnits * addonNum) / addonDen) : 0;
    const totalUnits = baseUnits + addonUnits;
    const totalAmount = Math.floor((totalUnits * unitPrice100) / 100);
    // 超過分の全額自費額 (円) = floor(超過単位 × 単価 × 10割)。介護給付と同じ整数演算
    const overAmount = Math.floor((overUnits * unitPrice100) / 100);

    // 公費単独 (H番号) — 介護と同じ扱い
    const kohiTandoku = /^[Hh]/.test((cert?.insured_number ?? "").trim());
    const kohi = kohiRes.byClient.get(userId) ?? null;
    // ── 部分公費の検出 (総合事業の公費按分は未対応 — 2026-07-14) ──
    // 介護給付 (aggregate.ts) の期間按分・本人負担上限月額・複数公費カスケードは
    // 総合事業ストリームには実装していない。以下の公費は「全量振替
    // (kohiUnits=totalUnits / kohiAmount=費用−保険)」のまま出力されるため、
    // 該当利用者を検出したら warning で手動確認を促す:
    //   1. 法別12 (生活保護) 以外 — 給付率・負担の扱いが生保 10割振替と異なりうる
    //   2. 本人負担上限月額 (honnin_futan) > 0 — 上限適用の按分計算が必要
    //   3. 公費適用期間が対象月の一部 — 期間内実績のみ公費対象とする按分が必要
    if (kohi) {
      const partialPeriod =
        (kohi.start != null && kohi.start > monthStartIso) ||
        (kohi.end != null && kohi.end < monthEndIso);
      const partialReasons: string[] = [];
      if (kohi.hobetsu !== "12") partialReasons.push(`法別${kohi.hobetsu} (生活保護以外)`);
      if ((kohi.honninFutan ?? 0) > 0)
        partialReasons.push(`本人負担上限月額 ${kohi.honninFutan.toLocaleString()}円`);
      if (partialPeriod)
        partialReasons.push(`公費適用期間が月の一部 (${kohi.start ?? "制限なし"}〜${kohi.end ?? "制限なし"})`);
      if (partialReasons.length > 0) {
        warnings.push(
          `${userLabel}: 総合事業の公費按分 (期間按分・本人負担上限・法別12以外の給付率) は未対応です (${partialReasons.join("、")}) — 公費対象分を全量振替で集計するため、請求前に手動確認してください`,
        );
      }
    }
    const copayX10 = Math.min(10, Math.max(0, Math.round(copay * 10)));
    const insuranceAmount = kohiTandoku ? 0 : Math.floor((totalAmount * (10 - copayX10)) / 10);
    const publicExpense =
      (kohi ? kohiHobetsuLabel(kohi.hobetsu) : null) ??
      (kohiTandoku ? "公費単独 (生活保護 10割)" : null);
    const kohiUnits = publicExpense ? totalUnits : null;
    const kohiAmount = kohiTandoku
      ? totalAmount
      : publicExpense
      ? totalAmount - insuranceAmount
      : null;
    const userAmount = publicExpense ? 0 : totalAmount - insuranceAmount;

    const segDays = new Set<string>();
    for (const dates of typeDates.values()) for (const d of dates) segDays.add(d);

    const row: SougouSeikyuRow = {
      system: "総合事業",
      user_id: userId,
      user_name: client?.name ?? "(利用者不明)",
      user_name_kana: client?.furigana ?? null,
      user_number: client?.userNumber ?? null,
      insurer_number: cert?.insurer_number ?? null,
      insurer_name: cert?.insurer_name?.trim() || null,
      insured_number: cert?.insured_number ?? null,
      care_level: cert?.care_level ?? null,
      copay_rate: copay,
      details,
      grossBaseUnits,
      limitUnits,
      // 計画単位数は介護給付側の運用 (月次情報タブ / 別表取込) のみ — 総合事業は未使用
      planUnits: null,
      overUnits,
      // ケアマネ手割振り (kaigo_gendo_allocation) は総合事業側では使わない (上記コメント参照)
      overSource: "auto",
      overAmount,
      selfPayAmount: overAmount,
      baseUnits,
      addonUnits,
      // 限度額管理対象外単位数 = 処遇改善等%加算 (総合事業は初回・緊急時系の経路なし)
      kanriTaishougaiUnits: addonUnits,
      addonLabel,
      totalUnits,
      unitPrice,
      totalAmount,
      insuranceAmount,
      userAmount,
      publicExpense,
      kohiTandoku,
      kohiUnits,
      kohiAmount,
      kohiHobetsu: kohi?.hobetsu ?? null,
      kohiFutanshaNumber: kohi?.futansha ?? null,
      kohiJukyushaNumber: kohi?.jukyusha ?? null,
      addonCode,
      birthDate: client?.birth ?? null,
      gender: client?.gender ?? null,
      certStart: cert?.certification_start_date ?? null,
      certEnd: cert?.certification_end_date ?? null,
      careOfficeNumber:
        cert?.care_office_number?.trim() ||
        (cert?.care_office_id ? officeNumberById.get(cert.care_office_id) ?? null : null),
      careOfficeName:
        cert?.care_office_name?.trim() ||
        (cert?.care_office_id ? officeNameById.get(cert.care_office_id) ?? null : null),
      serviceDays: segDays.size,
      // 住所地特例 (種別14 レコード用)。列未適用 (42703 フォールバック) 時は false/null
      jushoTokurei: client?.jushoTokurei ?? false,
      jushoTokureiInsurerNumber: client?.jushoTokureiInsurerNumber ?? null,
    };
    // 分割時 (保険者変更) のみセグメント情報を付ける。build-sougou は行ごとに明細書を出すため
    // 保険者ごとに別明細書になる。利用者請求書は mergeSegmentRows で利用者=1行に再合算される。
    if (seg.segCount > 1) {
      row.segmentIndex = seg.segIndex;
      row.segmentCount = seg.segCount;
      row.periodFrom = seg.segFrom;
      row.periodTo = seg.segTo;
    }
    return row;
  };

  const rows: SougouSeikyuRow[] = [];
  for (const [userId, typeDates] of byUser) {
    const client = clientById.get(userId);
    const userLabel = client?.name ?? userId;
    const certsInMonth = certsInMonthByClient.get(userId) ?? [];
    const midChange = detectMidMonthChange(certsInMonth);

    // ── 月途中の保険者変更 (転居) → 境界日でセグメント分割し 1 明細書/セグメント ──
    //    (介護給付 aggregate.ts Phase 2 と同方式。総合事業は基本コードのみなので簡素版)
    let handled = false;
    if (midChange?.insurerChange) {
      const ic = midChange.insurerChange;
      const insurerDiff =
        (ic.fromInsurer ?? "").trim() !== (ic.toInsurer ?? "").trim() &&
        !!ic.fromInsurer &&
        !!ic.toInsurer;
      const label = insurerDiff ? "保険者" : "被保険者番号";
      const desc = insurerDiff
        ? `${ic.fromInsurer}→${ic.toInsurer}`
        : `${ic.fromInsured ?? "?"}→${ic.toInsured ?? "?"}`;
      const segRes = resolveCertSegmentsForMonth(certsInMonth, opts.year, opts.month);
      if (segRes.segments.length >= 2) {
        // セグメントごとに訪問日をフィルタ。実績の無いセグメントは明細書を出さない
        const perSeg = segRes.segments
          .map((s) => {
            const filtered = new Map<string, string[]>();
            for (const [svcType, dates] of typeDates) {
              const inSeg = dates.filter((d) => d >= s.from && d <= s.to);
              if (inSeg.length > 0) filtered.set(svcType, inSeg);
            }
            return { s, filtered };
          })
          .filter((p) => p.filtered.size > 0);
        if (perSeg.length >= 2) {
          perSeg.forEach((p, i) => {
            rows.push(
              buildSougouRow(userId, p.filtered, {
                cert: p.s.cert,
                segIndex: i,
                segCount: perSeg.length,
                segFrom: p.s.from,
                segTo: p.s.to,
                limitOverride: p.s.limitAmount,
              }),
            );
          });
          const segDesc = perSeg
            .map((p, i) => {
              const part = perSeg.length === 2 ? (i === 0 ? "前半" : "後半") : `第${i + 1}区分`;
              const num = (insurerDiff ? p.s.cert.insurer_number : p.s.cert.insured_number) ?? "?";
              return `${part}: ${num}`;
            })
            .join(" / ");
          warnings.push(
            `${userLabel}さん: ${label}が月内で変わっています (${desc})。境界日 (${perSeg[1].s.from}) で総合事業の明細書を分割して出力しました (${segDesc})`,
          );
          handled = true;
        } else if (perSeg.length === 1) {
          // 実績が転居前後の片側期間のみ → 分割不要。その期間の認定 (旧/新保険者) で 1 行
          const p = perSeg[0];
          rows.push(
            buildSougouRow(userId, p.filtered, {
              cert: p.s.cert,
              segIndex: 0,
              segCount: 1,
              segFrom: p.s.from,
              segTo: p.s.to,
              limitOverride: p.s.limitAmount,
            }),
          );
          warnings.push(
            `${userLabel}さん: ${label}が月内で変わっています (${desc}) が、総合事業の実績が ${p.s.from}〜${p.s.to} のみのため分割せず、その期間の資格情報 (${(insurerDiff ? p.s.cert.insurer_number : p.s.cert.insured_number) ?? "?"}) で出力します`,
          );
          handled = true;
        }
      } else {
        warnings.push(
          `${userLabel}さん: ${label}が月内で変わっています (${desc}) が、変更後認定の開始日から境界日を判定できないため総合事業の明細書を分割できません — 認定有効期間 (開始日) を確認するか手動対応してください`,
        );
      }
    }

    if (!handled) {
      // 従来コードパス (分割なし = 全利用者の通常ケース)。当月認定 1 件で月全体を 1 明細書
      const cert = certByClient.get(userId) ?? null;
      const certLimit =
        cert?.service_limit_amount != null && Number(cert.service_limit_amount) > 0
          ? Number(cert.service_limit_amount)
          : null;
      rows.push(
        buildSougouRow(userId, typeDates, {
          cert,
          segIndex: 0,
          segCount: 1,
          segFrom: monthStartIso,
          segTo: monthEndIso,
          limitOverride: certLimit,
        }),
      );
    }
  }

  rows.sort((a, b) =>
    (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    ),
  );

  return { rows, warnings };
}
