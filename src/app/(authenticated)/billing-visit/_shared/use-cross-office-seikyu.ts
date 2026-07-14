"use client";

/**
 * 事業所合算 (法人横断) 用の他事業所 利用者負担 集計 hook。
 *
 * ★ money-safety の前提 (超重要):
 *   この hook は use-seikyu-data.ts と "同じ" 集計関数 (aggregateMonthlyVisitSeikyu /
 *   aggregateBathVisitSeikyu / aggregateMonthlyShogaiSeikyu) を officeId だけ差し替えて
 *   呼ぶ。金額計算式には一切手を入れない。したがって、ある事業所の利用者負担額を
 *   この hook 経由で得た値は、その事業所を単独で開いた利用請求タブの集計値と 1 円も違わない。
 *   合算 (法人横断) は呼び出し側で「各事業所・各制度の userAmount を整数加算」するだけ。
 *
 * スコープ:
 *   - 同一 company_id の 他 kaigo-app 事業所のうち、利用者負担が発生する
 *     service_type (訪問介護 / 訪問看護 / 訪問入浴) のみ集計対象。
 *     居宅介護支援・福祉用具・通所介護 等は利用請求 (利用者負担) の対象外なので除外。
 *   - company_id が null (単独事業所) の場合は siblings 無し = 従来どおり自事業所のみ。
 *   - 自事業所分は呼び出し側が既存の集計結果 (context) を再利用するため、ここでは取得しない
 *     (= 二重取得を避ける)。
 *
 * 性能:
 *   - siblings 分の集計を Promise.all で並列実行。
 *   - モジュールレベルの簡易キャッシュ (companyId|year|month) でタブ再訪・トグル往復の
 *     再集計を避ける。月切替は generation counter で古い応答を破棄。
 */

import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateMonthlyVisitSeikyu,
  type UserSeikyuRow,
} from "@/lib/visit-seikyu/aggregate";
import { aggregateBathVisitSeikyu } from "@/lib/bath-seikyu/aggregate";
import {
  aggregateMonthlyShogaiSeikyu,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";

// 利用者負担が発生する service_type のみ集計対象 (居宅・福祉用具・通所 は対象外)
const BILLABLE_SERVICE_TYPES = ["訪問介護", "訪問看護", "訪問入浴"] as const;

/** 1 事業所分の集計結果 (制度別 rows)。金額は集計関数そのままの値 */
export interface CrossOfficeAgg {
  officeId: string;
  officeName: string;
  serviceType: string;
  /** 介護給付 (訪問介護/看護) or 入浴給付 の利用者負担行 */
  kaigoRows: UserSeikyuRow[];
  /** 総合事業 (訪問型サービス) の利用者負担行 */
  sougouRows: UserSeikyuRow[];
  /** 障害福祉サービス の利用者負担行 */
  shogaiRows: ShogaiSeikyuRow[];
}

export interface CrossOfficeData {
  /** 自事業所の法人 (null = company 未設定 = 単独扱い) */
  companyId: string | null;
  /** 集計対象になった同一法人の他事業所 */
  offices: { id: string; name: string; serviceType: string }[];
  /** 事業所別の集計結果 */
  byOffice: CrossOfficeAgg[];
  /** siblings 全制度の client_id union (軽減設定 fetch 用) */
  clientIds: string[];
}

interface HookState {
  loading: boolean;
  /** 事業所単位の集計失敗メッセージ (money を握り潰さず可視化する) */
  errors: string[];
  data: CrossOfficeData | null;
}

const EMPTY_DATA: CrossOfficeData = {
  companyId: null,
  offices: [],
  byOffice: [],
  clientIds: [],
};

// モジュールレベル キャッシュ (session 内で company×月 の再集計を避ける)
const cache = new Map<string, CrossOfficeData>();
const cacheKey = (companyId: string, year: number, month: number) =>
  `${companyId}|${year}|${String(month).padStart(2, "0")}`;

async function fetchSiblingOffice(
  supabase: SupabaseClient,
  office: {
    id: string;
    name: string;
    service_type: string;
    tenant_id: string;
    unit_price: number | null;
    applied_formula_codes: string[] | null;
  },
  year: number,
  month: number,
): Promise<CrossOfficeAgg> {
  const unitPrice = office.unit_price ?? undefined;
  const appliedFormulaCodes = office.applied_formula_codes ?? [];
  const isBath = office.service_type === "訪問入浴";

  if (isBath) {
    // 訪問入浴: 入浴給付のみ (総合・障害は無し)。集計式は自事業所と共通
    const res = await aggregateBathVisitSeikyu(supabase, {
      officeId: office.id,
      tenantId: office.tenant_id,
      year,
      month,
      unitPrice,
      appliedFormulaCodes,
    });
    return {
      officeId: office.id,
      officeName: office.name,
      serviceType: office.service_type,
      kaigoRows: res.rows,
      sougouRows: [],
      shogaiRows: [],
    };
  }

  // 訪問介護 / 訪問看護: 介護給付 + 総合事業 (visit) と 障害 を並列集計。
  // use-seikyu-data と同じく、障害の失敗は介護/総合を壊さないよう空で続行する。
  const [visit, shogai] = await Promise.all([
    aggregateMonthlyVisitSeikyu(supabase, {
      officeId: office.id,
      tenantId: office.tenant_id,
      year,
      month,
      unitPrice,
      appliedFormulaCodes,
    }),
    aggregateMonthlyShogaiSeikyu(supabase, {
      officeId: office.id,
      year,
      month,
      unitPrice,
    }).catch((e) => {
      console.warn(
        `[cross-office] 障害集計に失敗 (${office.name} は介護/総合のみで続行):`,
        e,
      );
      return { rows: [] as ShogaiSeikyuRow[], month: "", recordCount: 0 };
    }),
  ]);
  return {
    officeId: office.id,
    officeName: office.name,
    serviceType: office.service_type,
    kaigoRows: visit.rows,
    sougouRows: visit.sougouRows ?? [],
    shogaiRows: shogai.rows,
  };
}

/**
 * 事業所合算のための他事業所集計。
 * enabled=false / selfOfficeId=null のときは何もしない (idle)。
 */
export function useCrossOfficeSeikyu(opts: {
  enabled: boolean;
  supabase: SupabaseClient;
  selfOfficeId: string | null;
  year: number;
  month: number;
}): HookState {
  const { enabled, supabase, selfOfficeId, year, month } = opts;
  const [state, setState] = useState<HookState>({
    loading: false,
    errors: [],
    data: null,
  });
  // 月/事業所切替の競合対策 (古い応答の破棄)
  const genRef = useRef(0);

  useEffect(() => {
    if (!enabled || !selfOfficeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- トグル OFF 時のリセット
      setState({ loading: false, errors: [], data: null });
      return;
    }
    let cancelled = false;
    const gen = ++genRef.current;
    const errors: string[] = [];

    const run = async () => {
      setState((s) => ({ ...s, loading: true, errors: [] }));

      // 1) 自事業所の法人 (company_id) を解決
      const { data: selfOffice, error: e1 } = await supabase
        .from("offices")
        .select("company_id")
        .eq("id", selfOfficeId)
        .maybeSingle();
      if (cancelled || gen !== genRef.current) return;
      if (e1) {
        setState({
          loading: false,
          errors: [`法人情報の取得に失敗: ${e1.message}`],
          data: null,
        });
        return;
      }
      const companyId =
        (selfOffice as { company_id?: string | null } | null)?.company_id ??
        null;

      // company 未設定 = 単独事業所 → siblings 無し (従来どおり自事業所のみ)
      if (!companyId) {
        setState({ loading: false, errors: [], data: { ...EMPTY_DATA } });
        return;
      }

      // キャッシュ命中なら即返す
      const key = cacheKey(companyId, year, month);
      const cached = cache.get(key);
      if (cached) {
        setState({ loading: false, errors: [], data: cached });
        return;
      }

      // 2) 同一法人の他 kaigo 事業所 (利用者負担が発生する service_type のみ)
      const { data: sibs, error: e2 } = await supabase
        .from("offices")
        .select(
          "id, name, service_type, tenant_id, unit_price, applied_formula_codes",
        )
        .eq("company_id", companyId)
        .eq("app_type", "kaigo-app")
        .neq("id", selfOfficeId)
        .in("service_type", BILLABLE_SERVICE_TYPES as unknown as string[])
        .order("name");
      if (cancelled || gen !== genRef.current) return;
      if (e2) {
        setState({
          loading: false,
          errors: [`他事業所の取得に失敗: ${e2.message}`],
          data: { companyId, offices: [], byOffice: [], clientIds: [] },
        });
        return;
      }
      const siblings = (sibs ?? []) as {
        id: string;
        name: string;
        service_type: string;
        tenant_id: string;
        unit_price: number | null;
        applied_formula_codes: string[] | null;
      }[];
      if (siblings.length === 0) {
        const data: CrossOfficeData = {
          companyId,
          offices: [],
          byOffice: [],
          clientIds: [],
        };
        cache.set(key, data);
        setState({ loading: false, errors: [], data });
        return;
      }

      // 3) siblings 分を並列集計 (各事業所の失敗は握らず errors に集約)
      const settled = await Promise.allSettled(
        siblings.map((o) => fetchSiblingOffice(supabase, o, year, month)),
      );
      if (cancelled || gen !== genRef.current) return;

      const byOffice: CrossOfficeAgg[] = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") byOffice.push(r.value);
        else
          errors.push(
            `${siblings[i].name} の集計に失敗: ${
              r.reason instanceof Error ? r.reason.message : String(r.reason)
            }`,
          );
      });

      const clientIdSet = new Set<string>();
      for (const o of byOffice) {
        for (const r of o.kaigoRows) clientIdSet.add(r.user_id);
        for (const r of o.sougouRows) clientIdSet.add(r.user_id);
        for (const r of o.shogaiRows) clientIdSet.add(r.user_id);
      }
      const data: CrossOfficeData = {
        companyId,
        offices: byOffice.map((o) => ({
          id: o.officeId,
          name: o.officeName,
          serviceType: o.serviceType,
        })),
        byOffice,
        clientIds: Array.from(clientIdSet),
      };
      // 集計成功分のみキャッシュ (一部失敗時は次回リトライさせる)
      if (errors.length === 0) cache.set(key, data);
      setState({ loading: false, errors, data });
    };

    run().catch((e) => {
      if (cancelled || gen !== genRef.current) return;
      setState({
        loading: false,
        errors: [e instanceof Error ? e.message : String(e)],
        data: null,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, supabase, selfOfficeId, year, month]);

  return state;
}
