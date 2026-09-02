// ============================================================================
// 重度訪問介護 (021003) の「段の積み上げ」共有ロジック。
//
//   2026-09-03 に切り出し。それまで import_meisai_shougai_records.mjs 本体と
//   verify_juho_step_and_hospitalization.mjs が**逐語コピー**で二重定義しており、
//   本体だけ直しても検証スクリプトは古い挙動をテストし続ける状態だった
//   (実際に juhoTierHoursForCumEnd の是正で発覚)。乖離源なのでここに一本化する。
//
//   ⚠ ここは **DB にも CSV にも触らない純関数だけ**を置く。マスタ (kaigo_service_codes)
//     の取得や client 解決は呼出側の責務。
// ============================================================================

/** 分 (0-1439) → 時間帯。早朝6-8 / 日中8-18 / 夜間18-22 / 深夜22-6 */
export function zoneOf(min) {
  if (min < 360 || min >= 1320) return "深";
  if (min < 480) return "早";
  if (min < 1080) return "日";
  return "夜";
}

/**
 * 累計(分)の終了位置に対応する段の hours を返す。段の境界に乗らなければ null。
 *
 * ⚠ 2026-09-03 是正: 4.0h 以下で完全一致が無いとき、旧実装は下の `t > 4` の行へ
 *   落ちて **8.0h の段を返していた**。マスタは全時間帯に 8.0h コードを持つので必ず
 *   誤発火する。時間帯をまたぐ訪問で、またぎ地点の累計が 30 分刻みに乗らないと発生。
 *   例) 07:30-08:30 (早30分+日30分) は 日中1.0(202単位) だけのはずが
 *       早朝8.0 が余計に立ち +115単位 になっていた。
 *
 *   段の境界に乗らない累計 = **まだ段を1つ登り切っていない**ので何も返さない (null)。
 *   累計は呼出側で継続し、境界に達した時点でその段が立つ。
 *
 * ⚠ 「1日の最後が段の途中で終わったとき端数を切り上げて課金するか」は未決だったが、
 *   2026-09-03 に伝送実データで決着: 202606 の全拠点 TJ (実績記録票) を走査したところ
 *   **重訪の1日の算定時間は 277 日すべてが 30 分境界 (.00 / .50) に乗っており**、
 *   段の途中で終わる日は 1 件も無かった。時間帯またぎ地点の累計も 274 日すべて
 *   30 分刻みに乗っていた (= このバグは実運用では発火しない)。
 *   よって切り上げ規則を作り込む必要はなく、現挙動 (境界外は段を立てない) を正とする。
 */
export function juhoTierHoursForCumEnd(cumEndMin, tierHours) {
  const h = cumEndMin / 60;
  // 4.0h までは段が刻みそのもの (1.0 / 1.5 / … / 4.0)。境界に乗らなければ段は立たない
  if (h <= 4 + 1e-9) {
    return tierHours.find((t) => Math.abs(t - h) < 1e-9) ?? null;
  }
  // 4.0h 超は「累計終了 以上 で最小の段」
  return tierHours.find((t) => t > 4 + 1e-9 && t >= h - 1e-9) ?? null;
}

/**
 * 1 日ぶんの重訪の訪問 (訪問順・時刻つき) から算定コード列を作る。
 * @param visits [{s,e,n}] 分。開始時刻昇順。n = その提供の人数 (TJ 由来、無ければ 1)
 * @param stepsByZone  zoneLabel -> [{hours, code, name, units}]   (1人)
 * @param stepsByZone2 同 (・2人)。無ければ 1人側を使う
 * @returns [{code,name,units,zone,two}] / 解決できなければ null
 */
export function juhoConvsForDay(visits, stepsByZone, stepsByZone2 = null) {
  // ① 訪問順に、時間帯の境界で細切れにする
  const segs = [];
  for (const v of visits) {
    let s = v.s;
    while (s < v.e) {
      const z = zoneOf(s);
      const zEnd = z === "深" ? (s < 360 ? 360 : 1440) : z === "早" ? 480 : z === "日" ? 1080 : 1320;
      const e = Math.min(v.e, zEnd);
      if (e > s) segs.push({ zone: z, minutes: e - s, two: (v.n ?? 1) >= 2 });
      s = e;
    }
  }
  if (!segs.length) return null;

  // ② 段の境界で切りながら累計する
  const anyZone = Object.values(stepsByZone).find(Boolean);
  if (!anyZone) return null;
  const tierHours = [...new Set(anyZone.map((st) => st.hours))].sort((a, b) => a - b);
  const tierEndsMin = tierHours.map((h) => h * 60);

  const out = [];
  let cum = 0;
  for (const seg of segs) {
    let left = seg.minutes;
    while (left > 1e-9) {
      // 次の段の終了累計。4h までは段そのもの、超えたら 30 分刻み
      const next = cum < 240
        ? tierEndsMin.find((m) => m > cum + 1e-9 && m <= 240)
        : cum + 30;
      const boundary = next ?? cum + 30;
      const take = Math.min(left, boundary - cum);
      const cumEnd = cum + take;
      // 端数は 30 分に切り上げ (告示どおり)
      const billedEnd = cumEnd < 240 ? cumEnd : Math.ceil(cumEnd / 30) * 30;
      const th = juhoTierHoursForCumEnd(billedEnd, tierHours);
      const steps = (seg.two && stepsByZone2) ? stepsByZone2[seg.zone] : stepsByZone[seg.zone];
      if (th != null && steps) {
        const st = steps.find((x) => Math.abs(x.hours - th) < 1e-9);
        if (st) out.push({ code: st.code, name: st.name, units: st.units, zone: seg.zone, two: !!seg.two });
      }
      cum = cumEnd;
      left -= take;
    }
  }
  return out.length ? out : null;
}
