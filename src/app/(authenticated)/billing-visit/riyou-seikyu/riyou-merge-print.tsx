"use client";

/**
 * 利用者請求書の「合算」印刷レイヤー (制度合算 / 事業所合算)。
 *
 * ★ money-safety の前提 (超重要):
 *   このモジュールは各制度・各事業所の集計値 (aggregate) を一切再計算しない。
 *   呼び出し側が渡す「利用者負担額 (subtotal)」を利用者単位で足し合わせて
 *   1 枚の請求書として描画するだけの純表示レイヤーである。
 *   合算金額 = Σ(各制度・各事業所の subtotal) を整数加算で持ち回るため、
 *   制度合算 OFF で個別に出した請求書の金額を単純合計したものと 1 円も違わない。
 *
 * 制度合算 (system merge):
 *   1 利用者 = 1 枚。介護 / 総合事業 / 障害 の利用者負担額を制度別セクションで
 *   並べて合計する。RiyouSeikyuPrintSheet と同じ体裁 (p-10 / 罫線 / 今回御請求額欄)。
 *
 * 事業所合算 (company / 法人単位):
 *   セクションの label に事業所名を含めることで、同一利用者の複数事業所分を
 *   1 枚に横断集計できる汎用構造にしてある (呼び出し側が section を事業所単位で渡す)。
 *
 * 名寄せ (世帯合算) は別軸: clients を 2 名以上渡せば世帯合算の 1 枚になる
 *   (制度合算・事業所合算と独立に効く)。
 */

import type { ReactNode } from "react";

export type MergeSystem = "介護" | "総合事業" | "障害";

// 制度バッジ配色 (一覧の SYSTEM_BADGE_CLS と揃える)
const SYSTEM_BADGE: Record<MergeSystem, string> = {
  介護: "bg-indigo-100 text-indigo-700",
  総合事業: "bg-teal-100 text-teal-700",
  障害: "bg-violet-100 text-violet-700",
};

/**
 * サービス明細行 (表示専用)。集計 (aggregate) の details / addons をそのまま詰める。
 * ★ money-safety: units は表示だけ。円は行ごとに割らず、セクション subtotal を正とする。
 */
export interface MergedLine {
  serviceName: string;
  /** 小計単位数 (details.units / addon.units)。減算行は負値になり得る */
  units: number;
  /** 実績回数 (加算行は 1) */
  count: number;
}

/**
 * 合算前の 1 明細 (= 1 利用者 × 1 制度 × 1 事業所 の利用者負担)。
 * 呼び出し側 (riyou-seikyu-content) が既存の billed 計算結果をそのまま詰める。
 */
export interface MergeInput {
  system: MergeSystem;
  userId: string;
  userName: string;
  userNameKana: string | null;
  /** 並び順用 (clients.user_number)。null は末尾 */
  userNumber: string | null;
  /** 負担割合 (0.1 等)。障害は null */
  copayRate: number | null;
  /** セクション見出しに添える事業所名 (事業所合算のときだけ意味を持つ。単一事業所は null) */
  officeLabel: string | null;
  /** サービス明細行 (表示専用。空なら「明細なし・小計のみ」にフォールバック) */
  lines: MergedLine[];
  /** 費用側の表示額。介護/総合 = 法定負担 + 超過自費 (userPlusSelf) / 障害 = userAmount */
  base: number;
  /** 軽減額 (介護/総合のみ。障害は 0) */
  keigen: number;
  /** 実費合計 (介護/総合のみ。障害は 0) */
  jippi: number;
  /** この明細の当月請求額 = billed (= base − keigen + jippi、障害は userAmount)。合算はこれを足す */
  subtotal: number;
  /** 医療費控除対象額 (介護/総合の対象者のみ。非対象・障害は 0) */
  iryohi: number;
  /** 前月繰越の算出用: 前月請求額 (この制度の payments 由来。無ければ 0) */
  prevBilled: number;
  /** 前月入金額 (同上) */
  prevPaid: number;
}

/** 合算後の 1 利用者 (制度別セクションを内包) */
export interface MergedSection {
  system: MergeSystem;
  officeLabel: string | null;
  base: number;
  keigen: number;
  jippi: number;
  subtotal: number;
  /** サービス明細行 (表示専用) */
  lines: MergedLine[];
}
export interface MergedClient {
  userId: string;
  userName: string;
  userNameKana: string | null;
  userNumber: string | null;
  copayRate: number | null;
  sections: MergedSection[];
  /** 当月請求額 = Σ sections.subtotal */
  clientTotal: number;
  /** 医療費控除対象額 合計 (制度横断) */
  iryohi: number;
  /** 前月請求合計 / 前月入金合計 (制度横断で合算) */
  prevBilled: number;
  prevPaid: number;
}

const SYSTEM_ORDER: Record<MergeSystem, number> = { 介護: 0, 総合事業: 1, 障害: 2 };

/**
 * 明細 (MergeInput[]) を利用者単位に畳み込む。
 * 制度合算 ON の呼び出しでは同一 userId の複数制度が 1 MergedClient にまとまる。
 * 制度合算 OFF の呼び出しでは呼び出し側が制度ごとに別 build を掛ける想定 (各 1 制度)。
 */
export function buildMergedClients(inputs: MergeInput[]): MergedClient[] {
  const byUser = new Map<string, MergeInput[]>();
  for (const it of inputs) {
    if (!byUser.has(it.userId)) byUser.set(it.userId, []);
    byUser.get(it.userId)!.push(it);
  }
  const clients: MergedClient[] = [];
  for (const [userId, items] of byUser) {
    const sorted = [...items].sort(
      (a, b) => SYSTEM_ORDER[a.system] - SYSTEM_ORDER[b.system],
    );
    const head = sorted[0];
    clients.push({
      userId,
      userName: head.userName,
      userNameKana: head.userNameKana,
      userNumber: head.userNumber,
      // 負担割合は介護/総合の行を優先 (障害は null)
      copayRate:
        sorted.find((s) => s.copayRate != null)?.copayRate ?? head.copayRate,
      sections: sorted.map((s) => ({
        system: s.system,
        officeLabel: s.officeLabel,
        base: s.base,
        keigen: s.keigen,
        jippi: s.jippi,
        subtotal: s.subtotal,
        lines: s.lines,
      })),
      clientTotal: sorted.reduce((sum, s) => sum + s.subtotal, 0),
      iryohi: sorted.reduce((sum, s) => sum + s.iryohi, 0),
      prevBilled: sorted.reduce((sum, s) => sum + s.prevBilled, 0),
      prevPaid: sorted.reduce((sum, s) => sum + s.prevPaid, 0),
    });
  }
  // 利用者番号順 (番号なしは末尾・カナ順) — 一括印刷と同じ並び
  clients.sort((a, b) => {
    const na = a.userNumber;
    const nb = b.userNumber;
    if (na != null && nb != null) {
      const c = na.localeCompare(nb, "ja", { numeric: true });
      if (c !== 0) return c;
    } else if (na != null) {
      return -1;
    } else if (nb != null) {
      return 1;
    }
    return (a.userNameKana ?? a.userName).localeCompare(
      b.userNameKana ?? b.userName,
      "ja",
    );
  });
  return clients;
}

const yen = (n: number) => `¥${n.toLocaleString()}`;

/**
 * 合算 利用料請求書 (1 枚)。
 * - clients 1 名 = 個別 (制度別セクション + 利用者合計)
 * - clients 2 名以上 = 世帯合算 (利用者ごとにセクション + 世帯合計)
 *
 * 金額はすべて呼び出し側が計算済みの subtotal を足すだけ (このコンポーネントは計算しない)。
 */
export function RiyouSeikyuMergedPrintSheet({
  clients,
  officeName,
  reiwa,
  month,
  isCopy = false,
  /** 事業所合算 (法人横断) の請求書か (見出し表記の切替) */
  companyMerged = false,
}: {
  clients: MergedClient[];
  officeName: string | null;
  reiwa: number;
  month: number;
  isCopy?: boolean;
  companyMerged?: boolean;
}) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const isHousehold = clients.length >= 2;
  const rep = clients[0];

  const monthTotal = clients.reduce((s, c) => s + c.clientTotal, 0);
  const prevBilled = clients.reduce((s, c) => s + c.prevBilled, 0);
  const prevPaid = clients.reduce((s, c) => s + c.prevPaid, 0);
  const carry = prevBilled - prevPaid;
  const grandTotal = monthTotal + carry;
  const hasPrev = clients.some((c) => c.prevBilled !== 0 || c.prevPaid !== 0);

  // 制度の顔ぶれ (見出し補足用)
  const systems = Array.from(
    new Set(clients.flatMap((c) => c.sections.map((s) => s.system))),
  );
  const multiSystem = systems.length >= 2;

  // このシートが実際に複数事業所を横断しているか (section の officeLabel が 2 種類以上)。
  // prop companyMerged はフォールバック (呼び出し側が明示 ON にした場合)。
  const officeLabels = Array.from(
    new Set(
      clients
        .flatMap((c) => c.sections.map((s) => s.officeLabel))
        .filter((l): l is string => !!l),
    ),
  );
  const isCompanyMerged = companyMerged && officeLabels.length >= 2;

  const titleSuffix = isHousehold
    ? " (世帯合算)"
    : isCompanyMerged
      ? " (事業所合算)"
      : multiSystem
        ? " (制度合算)"
        : "";

  // ── サービス明細レイアウト ──────────────────────────────────────────────
  //   [事業所] → 制度 → サービス明細行 (サービス名 / 単位数 / 回数) → セクション小計 (円)
  //   → 利用者合計 (単位数合計 + 当月請求額 円)。
  //   表示専用: 単位数は details/addons をそのまま並べるだけで、円は行に割らない。
  //   事業所見出しは 2 事業所以上のときだけ (単独は省略 = 従来の見た目に近づける)。
  //   制度見出しは 2 制度以上のときだけ。
  const showOffice = officeLabels.length >= 2;
  const showSystem = multiSystem;
  const COLS = 4; // サービス名 / 単位数 / 回数 / 金額

  const sectionUnits = (s: MergedSection) =>
    s.lines.reduce((u, l) => u + l.units, 0);
  // 負担 − 軽減 + 実費 の内訳注記 (軽減/実費がある行のみ。従来の列表示を凝縮)
  const breakdownText = (base: number, keigen: number, jippi: number) => {
    if (keigen <= 0 && jippi <= 0) return null;
    const parts = [`負担 ${yen(base)}`];
    if (keigen > 0) parts.push(`− 軽減 ${yen(keigen)}`);
    if (jippi > 0) parts.push(`+ 実費 ${yen(jippi)}`);
    return parts.join(" ");
  };

  const bodyRows: ReactNode[] = [];
  for (const c of clients) {
    const cUnits = c.sections.reduce((u, s) => u + sectionUnits(s), 0);
    const cBase = c.sections.reduce((s, x) => s + x.base, 0);
    const cKeigen = c.sections.reduce((s, x) => s + x.keigen, 0);
    const cJippi = c.sections.reduce((s, x) => s + x.jippi, 0);
    const multiSection = c.sections.length >= 2;

    // 世帯合算のときは利用者名を見出し行に (単独請求書では上部の宛名で足りる)
    if (isHousehold) {
      bodyRows.push(
        <tr key={`${c.userId}-name`} className="bg-gray-100 font-semibold">
          <td className="border border-black px-2 py-1" colSpan={COLS}>
            {c.userName} 様
            {c.copayRate != null && (
              <span className="ml-1 text-xs text-gray-500">
                ({Math.round(c.copayRate * 10)}割)
              </span>
            )}
          </td>
        </tr>,
      );
    }

    // 事業所単位でグループ化 (挿入順を維持)
    const byOffice = new Map<string, MergedSection[]>();
    for (const s of c.sections) {
      const key = s.officeLabel ?? "";
      if (!byOffice.has(key)) byOffice.set(key, []);
      byOffice.get(key)!.push(s);
    }

    for (const [officeKey, secs] of byOffice) {
      if (showOffice && officeKey) {
        bodyRows.push(
          <tr key={`${c.userId}-off-${officeKey}`} className="bg-gray-50">
            <td
              className="border border-black px-2 py-1 text-sm font-medium"
              colSpan={COLS}
            >
              【{officeKey}】
            </td>
          </tr>,
        );
      }
      for (const s of secs) {
        const sKey = `${c.userId}-${officeKey}-${s.system}`;
        if (showSystem) {
          bodyRows.push(
            <tr key={`${sKey}-hd`}>
              <td className="border border-black px-2 py-1" colSpan={COLS}>
                <span
                  className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${SYSTEM_BADGE[s.system]}`}
                >
                  {s.system}
                </span>
              </td>
            </tr>,
          );
        }
        // サービス明細行 (details / addons)。空 = フォールバック (小計のみ)
        s.lines.forEach((ln, li) => {
          bodyRows.push(
            <tr key={`${sKey}-l${li}`}>
              <td className="border border-black px-2 py-1 pl-4">
                {ln.serviceName}
              </td>
              <td className="border border-black px-2 py-1 text-right tabular-nums">
                {ln.units.toLocaleString()}
              </td>
              <td className="border border-black px-2 py-1 text-right tabular-nums">
                {ln.count}
              </td>
              <td className="border border-black px-2 py-1" />
            </tr>,
          );
        });
        // セクション小計 (円) — 制度/事業所が複数あるときのみ (単独は利用者合計で足りる)
        if (multiSection) {
          const bd = breakdownText(s.base, s.keigen, s.jippi);
          bodyRows.push(
            <tr key={`${sKey}-st`} className="bg-gray-50">
              <td className="border border-black px-2 py-1" colSpan={2}>
                <span className="font-medium">小計</span>
                <span className="ml-1 text-xs text-gray-500">
                  {s.system}
                  {showOffice && s.officeLabel ? ` / ${s.officeLabel}` : ""}
                  {bd ? ` (${bd})` : ""}
                </span>
              </td>
              <td className="border border-black px-2 py-1 text-right tabular-nums">
                {sectionUnits(s).toLocaleString()} 単位
              </td>
              <td className="border border-black px-2 py-1 text-right tabular-nums font-semibold">
                {yen(s.subtotal)}
              </td>
            </tr>,
          );
        }
      }
    }

    // 利用者合計 (単位数合計 + 当月請求額)。単独セクションの内訳注記もここに凝縮
    const cbd = !multiSection ? breakdownText(cBase, cKeigen, cJippi) : null;
    bodyRows.push(
      <tr key={`${c.userId}-total`} className="font-bold">
        <td className="border border-black px-2 py-1.5">
          {isHousehold ? `${c.userName} 様 合計` : "合計"}
          {cbd && (
            <span className="ml-1 text-xs font-normal text-gray-500">
              ({cbd})
            </span>
          )}
        </td>
        <td className="border border-black px-2 py-1.5 text-right tabular-nums">
          {cUnits.toLocaleString()} 単位
        </td>
        <td className="border border-black px-2 py-1.5" />
        <td className="border border-black px-2 py-1.5 text-right tabular-nums">
          {yen(c.clientTotal)}
        </td>
      </tr>,
    );
  }

  return (
    <div className="p-10 text-black relative" style={{ pageBreakAfter: "always" }}>
      {isCopy && (
        <span className="absolute right-10 top-8 border border-black px-2 py-1 text-sm font-bold">
          控
        </span>
      )}
      <h1 className="mb-8 text-center text-2xl font-bold tracking-[0.5em]">
        利用料請求書{titleSuffix}
        {isCopy ? " (控)" : ""}
      </h1>

      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="inline-block border-b border-black pb-1 pr-12 text-lg">
            {rep.userName} 様{" "}
            {isHousehold ? `他 ${clients.length - 1} 名` : ""}
          </p>
          <p className="mt-3 text-sm">
            令和{reiwa}年{month}月分のサービス利用料を下記のとおり
            {isHousehold ? " (世帯合算) " : ""}ご請求申し上げます。
          </p>
        </div>
        <div className="text-right text-sm leading-6">
          <p>発行日: {issueDate}</p>
          <p className="mt-3 font-medium">{officeName ?? ""}</p>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <span className="border border-black px-4 py-2 text-lg font-bold">
          今回御請求額 {yen(grandTotal)} －
        </span>
        <span className="text-xs">
          (消費税: 非課税
          {isHousehold ? ` / 世帯 ${clients.length} 名分` : ""}
          {multiSystem ? ` / ${systems.join("・")}` : ""})
        </span>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1.5 text-left">サービス名</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">単位数</th>
            <th className="border border-black px-2 py-1.5 text-right w-20">回数</th>
            <th className="border border-black px-2 py-1.5 text-right w-28">金額</th>
          </tr>
        </thead>
        <tbody>
          {bodyRows}
          {isHousehold && (
            <tr className="font-bold bg-gray-100">
              <td className="border border-black px-2 py-1.5" colSpan={3}>
                当月請求額 (世帯 {clients.length} 名分)
              </td>
              <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                {yen(monthTotal)}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* 前回領収欄 (制度横断で合算した前月請求/入金) */}
      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-2 py-1 text-right">前回請求額</th>
            <th className="border border-black px-2 py-1 text-right">前回入金額</th>
            <th className="border border-black px-2 py-1 text-right">
              繰越額 (未収は+、過入金は▲)
            </th>
            <th className="border border-black px-2 py-1 text-right">今回御請求額</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {hasPrev ? yen(prevBilled) : "—"}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {hasPrev ? yen(prevPaid) : "—"}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums">
              {carry === 0
                ? "¥0"
                : carry > 0
                  ? yen(carry)
                  : `▲${yen(-carry)}`}
            </td>
            <td className="border border-black px-2 py-1.5 text-right tabular-nums font-bold">
              {yen(grandTotal)}
            </td>
          </tr>
        </tbody>
      </table>

      {clients.some((c) => c.iryohi > 0) && (
        <p className="mt-3 text-sm">
          うち医療費控除対象額 {yen(clients.reduce((s, c) => s + c.iryohi, 0))}
          {isHousehold
            ? ` (${clients
                .filter((c) => c.iryohi > 0)
                .map((c) => c.userName)
                .join("、")})`
            : ""}
        </p>
      )}

      <p className="mt-6 text-xs text-gray-700">
        ※ 本請求は
        {systems.includes("障害")
          ? "介護保険・障害福祉サービス"
          : "介護保険サービス"}
        利用に伴う利用者負担分です
        {multiSystem ? ` (${systems.join("・")} を合算)` : ""}
        {isHousehold
          ? `。世帯内 ${clients.length} 名分を代表者 (${rep.userName} 様) 宛に 1 枚で発行しています`
          : ""}
        {isCompanyMerged
          ? `。法人内の複数事業所分 (${officeLabels.join("・")}) を合算しています`
          : ""}
        。
      </p>
    </div>
  );
}
