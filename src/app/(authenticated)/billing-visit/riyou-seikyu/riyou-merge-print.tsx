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

export type MergeSystem = "介護" | "総合事業" | "障害";

// ── ひな形 (ほのぼの MORE 型) の固定文言・固定値 (Phase 1) ────────────────────
//   Phase 2 でマスタ化予定の項目はここに集約しておく (拝啓文 / 押印省略 / 登録番号
//   プレースホルダ / 振替日プレースホルダ)。編集は 1 箇所で済むようにする。
export const HINAGATA_FIXED = {
  /** 帳票タイトル (左上の枠) */
  title: "ご利用料金のご案内",
  /** 封筒表記 */
  zaichu: "ご請求書・領収書在中",
  /** 拝啓文 (口座振替の案内。Phase 2 でマスタ化予定) */
  haikei:
    "拝啓　毎々格別のお引立に預かり厚く御礼申し上げます。さて、ご利用分の請求書をお送りさせていただきましたので、ご査収の程よろしくお願いいたします。また、下記振替日にご指定口座より自動振替となりますので、お手数ですが前日までにお口座にご入金をお願いいたします。",
  keigu: "敬具",
  /** 押印省略の注記 */
  ouinShoryaku: "※押印は省略させていただきます。",
  /** インボイス登録番号: companies に列が無いため固定プレースホルダ (Phase 2 でマスタ化) */
  invoiceNumberPrefix: "登録番号：T",
  /** 振替日: 保存先が無いため空欄プレースホルダ (Phase 2 でマスタ化) */
  transferDatePlaceholder: "　　年　月　日",
} as const;

// 制度ラベル (モノクロ体裁: 制度色は使わず、黒枠の文字バッジで区別する)。
//   介護給付 = 介護 / 介護予防・日常生活支援総合事業 = 総合 / 障害福祉サービス = 障害。
const systemLabel = (s: MergedSection): string =>
  s.system === "障害" ? "障害" : s.system === "総合事業" ? "総合" : "介護";

/** 口座情報 (clients.bank_*)。表示専用 */
export interface MergeBank {
  bankName: string | null;
  bankBranch: string | null;
  bankAccountType: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
}

/** シート単位の自社情報 (companies / offices 由来 + 固定プレースホルダ) */
export interface SheetCompany {
  /** 法人名 (companies.name。無ければ officeName) */
  name: string | null;
  postalCode: string | null;
  address: string | null;
  phone: string | null;
  /** 登録番号 (Phase 1 は null → プレースホルダ表示) */
  invoiceNumber: string | null;
}

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
  // ── ひな形 (Phase 1) 表示専用の追加項目 (任意。無ければ空欄で崩れない) ──
  /** 宛先 郵便番号 (clients.postal_code)。client 単位なので自事業所分にだけ入れれば足りる */
  postalCode?: string | null;
  /** 宛先 住所 (clients.address) */
  address?: string | null;
  /** 口座情報 (clients.bank_*) */
  bank?: MergeBank | null;
  /**
   * 居宅介護支援事業者名 (client_insurance_records.care_office_id → care_offices.name)。
   * client 単位のため自事業所分にだけ入れれば足りる (表示専用)。
   */
  careOfficeName?: string | null;
  /** この事業所の問い合わせ先電話 (offices.phone)。他事業所分は Phase 1 では null */
  officePhone?: string | null;
  /**
   * ご利用日 (提供実績の day-of-month。表示専用。空なら暦のみ)。
   * ★ money-safety: 金額計算には一切使わない (カレンダー描画のみ)。
   */
  serviceDays?: number[];
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
  /** 医療費控除対象額 (この制度分。ひな形の事業所別小箱に表示) */
  iryohi: number;
  /** この事業所の問い合わせ先電話 (ひな形の「お問い合わせ先」)。無ければ null */
  officePhone: string | null;
  /** ご利用日 (提供実績の day-of-month。表示専用) */
  serviceDays: number[];
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
  // ── ひな形 (Phase 1) 表示専用 ──
  /** 宛先 郵便番号 */
  postalCode: string | null;
  /** 宛先 住所 */
  address: string | null;
  /** 口座情報 (clients.bank_*) */
  bank: MergeBank | null;
  /** 居宅介護支援事業者名 (care_offices.name)。無ければ null */
  careOfficeName: string | null;
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
        iryohi: s.iryohi,
        officePhone: s.officePhone ?? null,
        serviceDays: s.serviceDays ?? [],
      })),
      clientTotal: sorted.reduce((sum, s) => sum + s.subtotal, 0),
      iryohi: sorted.reduce((sum, s) => sum + s.iryohi, 0),
      prevBilled: sorted.reduce((sum, s) => sum + s.prevBilled, 0),
      prevPaid: sorted.reduce((sum, s) => sum + s.prevPaid, 0),
      // 宛先・口座は client 単位。制度/事業所をまたいで最初に得られた非 null を採用
      // (自事業所セクションが持ち、他事業所セクションは null で渡す想定)。
      postalCode: sorted.find((s) => s.postalCode != null)?.postalCode ?? null,
      address: sorted.find((s) => s.address != null)?.address ?? null,
      bank: sorted.find((s) => s.bank != null)?.bank ?? null,
      careOfficeName:
        sorted.find((s) => s.careOfficeName != null)?.careOfficeName ?? null,
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

const yen = (n: number) => `¥${(n ?? 0).toLocaleString()}`;
// 月末日 (期間表記用)
const lastDayOf = (gYear: number, month: number) =>
  new Date(gYear, month, 0).getDate();

// ── フォント 4 段階 (ひな形 pt 比を A4 印刷 px に落とす) ──────────────────────
//   タイトル ≈18pt→17px / 見出し ≈13pt→12px / 本文 ≈9pt→9px / 小 ≈7pt→8px。
const FONT = {
  title: "text-[17px] font-bold leading-tight",
  heading: "text-[12px] font-semibold leading-snug",
  body: "text-[9px] leading-snug",
  small: "text-[8px] leading-tight",
} as const;

// ── 罫線 2 種 (細 0.5px = テーブル格子 / 太 1.5px = マスタ設定可能な強調枠) ──
const BOX_THICK = "border-[1.5px] border-black";
// テーブルのセル (border-collapse 前提で細罫 0.5px。余白は詰めめ px2)
const CELL = "border-[0.5px] border-black px-1 py-[2px] align-top";
const CELL_R = `${CELL} text-right tabular-nums`;
const CELL_C = `${CELL} text-center`;
const TH = `${CELL} text-center font-normal`;

// ── ひな形 小部品 (module 直下に置いて nested-component 警告を避ける) ──────────
//   制度チェックの □/☑ は色分けが本物の意匠 (介護=橙 / 障害=紫 / 自費=緑)。ラベルは黒。
function HinaCheck({ on, color }: { on: boolean; color: string }) {
  return (
    <span className={`mr-1 inline-block text-[12px] font-bold ${color}`}>
      {on ? "☑" : "□"}
    </span>
  );
}
// 下部小箱 (ラベル上・¥値下。細罫)
function HinaBox({
  label,
  value,
  valueClass = "",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="w-[92px] border-[0.5px] border-black text-center">
      <div className="border-b-[0.5px] border-black bg-gray-50 px-1 py-[1px] text-[8px] leading-tight">
        {label}
      </div>
      <div
        className={`px-1 py-[2px] text-right text-[9px] tabular-nums ${valueClass}`}
      >
        {value}
      </div>
    </div>
  );
}
// 明細テーブルの空セル (備考 / 控除 / 単価 / 時間 など Phase 1 は未使用)
const emptyCell = (key: string) => <td key={key} className={CELL} />;

// ご利用日カレンダー (幅 52mm ≒ 200px の小型月次暦。提供実績日を○囲みで示す)。
//   ★ 背景塗り (bg-black+白文字) は印刷時にブラウザが背景色を落として
//     白文字だけ残り読めなくなるため使わない。枠線の○は印刷でも確実に出る。
//   日=赤 / 土=青 の曜日色はひな形どおり維持 (制度枠のモノクロ化とは別)。
const CAL_WD = ["日", "月", "火", "水", "木", "金", "土"];
const calWdColor = (i: number) =>
  i === 0 ? "text-red-600" : i === 6 ? "text-blue-600" : "";
function UseDaysCalendar({
  gYear,
  month,
  days,
}: {
  gYear: number;
  month: number;
  days: number[];
}) {
  const daysInMonth = new Date(gYear, month, 0).getDate();
  const firstDow = new Date(gYear, month - 1, 1).getDay(); // 0=日
  const used = new Set(days);
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return (
    <table className="w-full table-fixed border-collapse">
      <thead>
        <tr>
          {CAL_WD.map((w, i) => (
            <th
              key={w}
              className={`border-[0.4px] border-black bg-gray-50 text-center text-[7px] font-semibold leading-[13px] ${calWdColor(i)}`}
            >
              {w}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((wk, wi) => (
          <tr key={wi}>
            {wk.map((d, di) => (
              <td
                key={di}
                className={`h-[14px] border-[0.4px] border-black p-0 text-center align-middle text-[7px] tabular-nums ${
                  d == null ? "bg-gray-50" : ""
                }`}
              >
                {d != null &&
                  (used.has(d) ? (
                    <span className="inline-block min-w-[12px] rounded-full border-[0.8px] border-black px-[1px] font-bold leading-[11px]">
                      {d}
                    </span>
                  ) : (
                    <span className={calWdColor(di)}>{d}</span>
                  ))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 合算 利用料請求書 (1 枚) — ほのぼの MORE 型ひな形レイアウト (Phase 1)。
 *
 * 構成 (ひな形準拠):
 *   ヘッダー (タイトル枠 / 宛先 / 発行日 / 自社情報 / 制度チェック)
 *   → 拝啓文ブロック → 口座振替テーブル → 引落金額内訳
 *   → 事業所別ご利用内訳 (事業所×制度ごとに繰り返し・制度色で枠色分け)
 *   → 【備考】自由記述枠。
 *
 * ★ money-safety: 金額は呼び出し側が計算済みの subtotal / clientTotal を
 *   足すだけ (このコンポーネントは一切再計算しない)。お引落予定金額 = Σ clientTotal。
 *   過誤相殺・繰越は Phase 3 スコープのためここでは扱わない。
 */
export function RiyouSeikyuMergedPrintSheet({
  clients,
  officeName,
  reiwa,
  month,
  isCopy = false,
  /** 自社情報 (companies / offices 由来。null = officeName + 空欄にフォールバック) */
  company = null,
}: {
  clients: MergedClient[];
  officeName: string | null;
  reiwa: number;
  month: number;
  isCopy?: boolean;
  /** 事業所合算 (法人横断) 判定は section.officeLabel で行うため companyMerged prop は受けるだけ */
  companyMerged?: boolean;
  company?: SheetCompany | null;
}) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const isHousehold = clients.length >= 2;
  const rep = clients[0];
  const gYear = reiwa + 2018;
  const monthEnd = lastDayOf(gYear, month);

  // お引落予定金額 = Σ clientTotal (= Σ subtotal)。再計算せず加算のみ。
  const monthTotal = clients.reduce((s, c) => s + c.clientTotal, 0);

  // 制度チェック (□介護(橙) / □障害(紫) / □事業所書式(自費)(緑))
  const hasKaigo = clients.some((c) =>
    c.sections.some((s) => s.system !== "障害"),
  );
  const hasShogai = clients.some((c) =>
    c.sections.some((s) => s.system === "障害"),
  );
  const hasJihi = clients.some((c) => c.sections.some((s) => s.jippi > 0));

  // 自社情報 (companies 優先 → 無ければ officeName / 空欄)
  const compName = company?.name ?? officeName ?? "";
  const compPostal = company?.postalCode ?? "";
  const compAddress = company?.address ?? "";
  const compPhone = company?.phone ?? "";
  const invoiceNo = `${HINAGATA_FIXED.invoiceNumberPrefix}${company?.invoiceNumber ?? ""}`;

  const sectionUnits = (s: MergedSection) =>
    s.lines.reduce((u, l) => u + l.units, 0);

  // 引落金額内訳: (利用者 × 事業所) 単位に subtotal を集約 (再計算せず加算のみ)
  const breakdownItems: { name: string; office: string; amount: number }[] = [];
  for (const c of clients) {
    const byOffice = new Map<string, number>();
    for (const s of c.sections) {
      const key = s.officeLabel ?? officeName ?? "";
      byOffice.set(key, (byOffice.get(key) ?? 0) + s.subtotal);
    }
    for (const [office, amount] of byOffice)
      breakdownItems.push({ name: c.userName, office, amount });
  }

  const bankRep = rep.bank;

  return (
    <div
      className={`relative mx-auto bg-white p-5 text-black ${FONT.body}`}
      style={{ pageBreakAfter: "always", maxWidth: "760px" }}
    >
      {/* ── ヘッダー: [タイトル+宛先] [封筒表記] [発行日+自社情報] [制度チェック] ── */}
      <div className="mb-2 flex items-start justify-between gap-3">
        {/* 左: タイトル枠 + 宛先 */}
        <div className="min-w-0 flex-1">
          <div className={`inline-block ${BOX_THICK} px-2 py-[2px] ${FONT.title}`}>
            {HINAGATA_FIXED.title}
            {isCopy ? "（控）" : ""}
          </div>
          <div className={`mt-3 ${FONT.body} leading-5`}>
            <div>〒{rep.postalCode ?? ""}</div>
            <div>{rep.address ?? ""}</div>
            <div className="mt-1 text-[13px] font-semibold">
              {rep.userName}　様
              {isHousehold ? `　他 ${clients.length - 1} 名` : ""}
              {rep.userNumber ? (
                <span className="ml-2 text-[9px] font-normal text-gray-600">
                  （{rep.userNumber}）
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {/* 中: 封筒表記 (ご請求書・領収書在中) */}
        <div className={`w-24 shrink-0 pt-8 text-center ${FONT.body}`}>
          {HINAGATA_FIXED.zaichu}
        </div>
        {/* 右: 発行日 + 自社情報 */}
        <div className={`w-52 shrink-0 ${FONT.body} leading-[15px]`}>
          <div className="mb-1 text-right">{issueDate}</div>
          <div>〒{compPostal}</div>
          <div>{compAddress}</div>
          <div className="font-semibold">{compName}</div>
          <div>{invoiceNo}</div>
          <div>TEL：{compPhone}</div>
        </div>
        {/* 最右: 制度チェック (□介護=橙 / □障害=紫 / □自費=緑。色分けは本物の意匠) */}
        <div
          className={`w-32 shrink-0 self-start border-[0.5px] border-black px-2 py-2 ${FONT.body} leading-6`}
        >
          <div>
            <HinaCheck on={hasKaigo} color="text-black" />：介護
          </div>
          <div>
            <HinaCheck on={hasShogai} color="text-black" />：障害
          </div>
          <div>
            <HinaCheck on={hasJihi} color="text-black" />
            ：事業所書式(自費)
          </div>
        </div>
      </div>

      {/* ── 拝啓文ブロック (太枠。左=本文 / 右=押印省略・印影欄) ── */}
      <div className={`mb-2 flex ${BOX_THICK}`}>
        <div className={`flex-1 p-2 ${FONT.body} leading-[15px]`}>
          <div>{HINAGATA_FIXED.haikei}</div>
          <div className="text-right">{HINAGATA_FIXED.keigu}</div>
        </div>
        <div className={`w-52 shrink-0 border-l-[0.5px] border-black p-2 ${FONT.body}`}>
          {HINAGATA_FIXED.ouinShoryaku}
        </div>
      </div>

      {/* ── 口座振替テーブル (細罫 6 列) ── */}
      <table className={`mb-2 w-full border-collapse ${FONT.body}`}>
        <colgroup>
          <col style={{ width: "15%" }} />
          <col style={{ width: "15%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "24%" }} />
          <col style={{ width: "18%" }} />
          <col style={{ width: "16%" }} />
        </colgroup>
        <thead>
          <tr>
            <th className={TH}>振替日</th>
            <th className={TH}>金融機関</th>
            <th className={TH}>支店名</th>
            <th className={TH}>種目・口座番号</th>
            <th className={TH}>口座名義人</th>
            <th className={TH}>お引落予定金額</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={CELL_C}>{HINAGATA_FIXED.transferDatePlaceholder}</td>
            <td className={CELL_C}>{bankRep?.bankName ?? ""}</td>
            <td className={CELL_C}>{bankRep?.bankBranch ?? ""}</td>
            <td className={CELL_C}>
              {[bankRep?.bankAccountType, bankRep?.bankAccountNumber]
                .filter(Boolean)
                .join(" ")}
            </td>
            <td className={CELL_C}>{bankRep?.bankAccountHolder ?? ""}</td>
            <td className={`${CELL_R} font-semibold`}>{yen(monthTotal)}</td>
          </tr>
        </tbody>
      </table>

      {/* ── 引落金額内訳 (太枠。左=内訳行 / 右=過誤・相殺文言 [Phase1 空]) ── */}
      <div className={`mb-3 flex ${BOX_THICK} ${FONT.body}`}>
        <div className="flex-1 p-2 leading-5">
          <div className="mb-1 font-semibold">引落金額内訳</div>
          {breakdownItems.length === 0 ? (
            <div className="text-gray-400">（内訳なし）</div>
          ) : (
            breakdownItems.map((it, i) => (
              <div key={`${it.name}-${it.office}-${i}`}>
                {it.name}　様　{it.office}　{month}月利用　{yen(it.amount)}
              </div>
            ))
          )}
        </div>
        {/* 過誤(過大/過小請求)・相殺残額の文言欄 (Phase1 は固定テンプレ非表示のため空) */}
        <div className="w-[42%] shrink-0 border-l border-dashed border-black p-2 leading-5" />
      </div>

      {/* ── 事業所別ご利用内訳 (事業所×制度ごとに繰り返し・制度色で枠色分け) ── */}
      {clients.map((c) =>
        c.sections.map((s, si) => {
          const unitsTotal = sectionUnits(s);
          const officeDisp = s.officeLabel ?? officeName ?? "";
          return (
            <div
              key={`${c.userId}-${si}`}
              className="mb-3 border-[0.5px] border-black"
            >
              {/* 事業所名 + 制度バッジ (モノクロ: 黒枠の文字ラベルで制度を区別) */}
              <div className="flex items-center gap-2 border-b-[0.5px] border-black bg-gray-50 px-2 py-1">
                <span
                  className={`inline-block rounded-[2px] border border-black px-[6px] py-[1px] font-bold tracking-wide ${FONT.small}`}
                >
                  {systemLabel(s)}
                </span>
                <span className={`font-semibold ${FONT.body}`}>{officeDisp}</span>
                <span className={`ml-auto ${FONT.small} text-gray-600`}>
                  お問い合わせ先　{s.officePhone ?? ""}
                </span>
              </div>
              {/* ご利用内訳見出し */}
              <div className={`px-2 pb-1 pt-1 ${FONT.body} leading-4`}>
                【ご利用内訳　{c.userName}様　期間：{month}月1日〜{month}月
                {monthEnd}日】　居宅介護支援事業者名：{c.careOfficeName ?? ""}
              </div>

              {/* 明細① 単位数テーブル (細罫 6 列) */}
              <table className={`w-full border-collapse ${FONT.body}`}>
                <colgroup>
                  <col style={{ width: "27%" }} />
                  <col style={{ width: "25%" }} />
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "19%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>内訳</th>
                    <th className={TH}>備考</th>
                    <th className={TH}>控除</th>
                    <th className={TH}>単位数</th>
                    <th className={TH}>回数</th>
                    <th className={TH}>単位</th>
                  </tr>
                </thead>
                <tbody>
                  {s.lines.length === 0 && (
                    <tr>
                      <td colSpan={6} className={`${CELL_C} text-gray-400`}>
                        （明細なし）
                      </td>
                    </tr>
                  )}
                  {s.lines.map((ln, li) => {
                    // 単位数 (1 回あたり) = 小計単位数 ÷ 回数 (表示専用の按分)
                    const perOnce =
                      ln.count > 0 ? Math.round(ln.units / ln.count) : ln.units;
                    return (
                      <tr key={`l${li}`}>
                        <td className={CELL}>{ln.serviceName}</td>
                        {emptyCell("b")}
                        {emptyCell("k")}
                        <td className={CELL_R}>{perOnce.toLocaleString()}</td>
                        <td className={CELL_R}>{ln.count}</td>
                        <td className={CELL_R}>
                          {ln.units.toLocaleString()}単位
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    {emptyCell("e1")}
                    {emptyCell("e2")}
                    {emptyCell("e3")}
                    <td colSpan={2} className={`${CELL_C} font-semibold`}>
                      合計単位数
                    </td>
                    <td className={`${CELL_R} font-semibold`}>
                      {unitsTotal.toLocaleString()}単位
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* 明細② 金額テーブル (細罫 7 列。上テーブルと連結のため border-t-0) */}
              <table
                className={`w-full border-collapse border-t-0 ${FONT.body}`}
              >
                <colgroup>
                  <col style={{ width: "24%" }} />
                  <col style={{ width: "21%" }} />
                  <col style={{ width: "6%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "18%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>内訳</th>
                    <th className={TH}>備考</th>
                    <th className={TH}>控除</th>
                    <th className={TH}>単価</th>
                    <th className={TH}>時間</th>
                    <th className={TH}>回数</th>
                    <th className={TH}>金額</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={CELL}>利用者負担額</td>
                    {emptyCell("b")}
                    {emptyCell("k")}
                    {emptyCell("t")}
                    {emptyCell("j")}
                    {emptyCell("c")}
                    <td className={CELL_R}>{yen(s.base)}</td>
                  </tr>
                  {s.jippi > 0 && (
                    <tr>
                      <td className={CELL}>自費請求額</td>
                      {emptyCell("b")}
                      {emptyCell("k")}
                      {emptyCell("t")}
                      {emptyCell("j")}
                      {emptyCell("c")}
                      <td className={CELL_R}>{yen(s.jippi)}</td>
                    </tr>
                  )}
                  {s.keigen > 0 && (
                    <tr>
                      <td className={CELL}>軽減額</td>
                      {emptyCell("b")}
                      {emptyCell("k")}
                      {emptyCell("t")}
                      {emptyCell("j")}
                      {emptyCell("c")}
                      <td className={CELL_R}>▲{yen(s.keigen)}</td>
                    </tr>
                  )}
                  {/* 利用者負担額 計 (ひな形: 左 4 列は空・時間/回数域に見出し・金額に計) */}
                  <tr>
                    {emptyCell("f1")}
                    {emptyCell("f2")}
                    {emptyCell("f3")}
                    {emptyCell("f4")}
                    <td colSpan={2} className={`${CELL_C} font-semibold`}>
                      利用者負担額
                    </td>
                    <td className={`${CELL_R} font-semibold`}>
                      {yen(s.subtotal)}
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* 下部 小箱 (障害=負担上限月額/上限管理後負担 / それ以外=医療費控除対象額) */}
              <div className="flex flex-wrap gap-2 p-2">
                {s.system === "障害" ? (
                  <>
                    {/* 負担上限月額は受給者証の値。Phase 1 は未取得のため「−」プレースホルダ */}
                    <HinaBox label="負担上限月額" value="−" />
                    {/* 上限管理後負担 = 集計済みの利用者負担額 (subtotal)。再計算しない */}
                    <HinaBox label="上限管理後負担" value={yen(s.subtotal)} />
                    <HinaBox label="減免額" value={yen(0)} />
                    <HinaBox label="消費税（内消費税）" value={yen(0)} />
                  </>
                ) : (
                  <>
                    <HinaBox label="医療費控除対象額" value={yen(s.iryohi)} />
                    <HinaBox label="減免額" value={yen(0)} />
                    <HinaBox label="軽減額" value={yen(s.keigen)} />
                    <HinaBox label="消費税（内消費税）" value={yen(0)} />
                  </>
                )}
              </div>
            </div>
          );
        }),
      )}

      {/* ── ご利用日カレンダー (事業所ブロック外。事業所ごとに小型暦を横並び) ── */}
      {clients.some((c) => c.sections.some((s) => s.serviceDays.length > 0)) && (
        <div className={`mb-3 border-[0.5px] border-black p-2 ${FONT.body}`}>
          <div className="mb-1 font-semibold">ご利用日（{month}月）</div>
          <div className="flex flex-wrap gap-3">
            {clients.flatMap((c) => {
              // 同一事業所の複数制度は 1 暦に畳む (提供日は事業所単位で共有のため)
              const byOffice = new Map<
                string,
                { systems: Set<string>; days: Set<number> }
              >();
              for (const s of c.sections) {
                if (s.serviceDays.length === 0) continue;
                const key = s.officeLabel ?? officeName ?? "";
                if (!byOffice.has(key))
                  byOffice.set(key, { systems: new Set(), days: new Set() });
                const g = byOffice.get(key)!;
                g.systems.add(systemLabel(s));
                for (const d of s.serviceDays) g.days.add(d);
              }
              return Array.from(byOffice, ([office, g], oi) => {
                const days = Array.from(g.days).sort((a, b) => a - b);
                return (
                  <div key={`${c.userId}-${oi}`} className="w-[200px]">
                    <div className="mb-0.5 text-[8px] font-semibold leading-tight">
                      {isHousehold ? `${c.userName}様　` : ""}
                      {office}（{Array.from(g.systems).join("・")}）
                    </div>
                    <UseDaysCalendar gYear={gYear} month={month} days={days} />
                    <div className={`mt-0.5 ${FONT.small} text-gray-600`}>
                      提供日　計{days.length}日
                    </div>
                  </div>
                );
              });
            })}
          </div>
        </div>
      )}

      {/* ── 【備考】自由記述枠 (太枠。Phase 1 は空欄) ── */}
      <div className={`mt-2 ${BOX_THICK} p-2 ${FONT.body}`}>
        <span className="font-semibold">【備考】</span>
      </div>
    </div>
  );
}
