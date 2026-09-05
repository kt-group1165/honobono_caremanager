/**
 * 売上 (見込) 集計 (aggregate-uriage.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/aggregate-uriage-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   foldUriageRows / chiikiYenFromRecord は元々 aggregateMonthlyUriage /
 *   sumChiiki (どちらもDBを呼ぶ async 関数)のループの中に埋め込まれており
 *   ハーネスから呼べなかった (7-1bと同型)。切り出しは挙動不変
 *   (式は1文字も変えていない。tsc --noEmit 0エラーで確認済み)。
 *
 *   chiikiYenFromRecord は ★ 実際に事故が起きた箇所。ファイル冒頭コメント:
 *   茂原2026-06で移動支援の実績取込が0件のまま黙って売上が121,479円少なかった。
 *   単位建て(千葉市)/円建て(茂原市)の2系統があり、境界を間違えるとまた黙って
 *   0円になる懸念がある。
 *
 *   sumUriage は既にexport済みの純関数だが未検証だった。★ コメントに明記された
 *   実際の事故: chiiki/reportedを足し忘れると「totalにだけ乗って内訳が0になる」
 *   (2026-08-06 修正) — 恒等式 (内訳の合計 = 売上合計) が壊れる形。
 */
import {
  EMPTY_URIAGE,
  sumUriage,
  foldUriageRows,
  chiikiYenFromRecord,
  businessTypeOf,
  type UriageBreakdown,
} from "@/lib/uriage/aggregate-uriage";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import type { ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const visitRow = (o: Partial<UserSeikyuRow> & { user_id: string }): UserSeikyuRow => ({ ...o }) as UserSeikyuRow;
const shogaiRow = (o: Partial<ShogaiSeikyuRow> & { user_id: string }): ShogaiSeikyuRow => ({ ...o }) as ShogaiSeikyuRow;

// ── chiikiYenFromRecord ───────────────────────────────────────────────────
eq("★ 単位建て (千葉市等): units×10円", chiikiYenFromRecord(50, null), 500);
eq("★ 円建て (茂原市等): notesの「NNNN円」から読む", chiikiYenFromRecord(null, "3500円"), 3500);
eq("★ unitsがあれば notes より優先される (千葉市が優先経路)", chiikiYenFromRecord(10, "9999円"), 100);
eq("units も notes(円表記) も無ければ 0 (単価表未登録)", chiikiYenFromRecord(null, null), 0);
eq("units=null, notes に円が含まれない文字列なら 0", chiikiYenFromRecord(null, "備考のみ"), 0);
eq("units=0 (0件だが単位建て) は 0円として扱う (unitsはnullではないため)", chiikiYenFromRecord(0, "1234円"), 0);
eq("notes内の数字以外の文字は無視して円だけ拾う", chiikiYenFromRecord(null, "移動支援 1200円 (自己負担別)"), 1200);

// ── foldUriageRows ────────────────────────────────────────────────────────
{
  const visitRows = [
    visitRow({ user_id: "c1", totalAmount: 10000, selfPayAmount: 500, insuranceAmount: 7000, kohiAmount: 500, kohi2Amount: 300, userAmount: 1700 }),
  ];
  const sougouRows = [
    visitRow({ user_id: "c2", totalAmount: 3000, selfPayAmount: 0, insuranceAmount: 2100, kohiAmount: 0, kohi2Amount: 0, userAmount: 900 }),
  ];
  const shogaiRows = [
    shogaiRow({ user_id: "c3", totalAmount: 8000, benefitAmount: 7200, userAmount: 800 }),
  ];
  const r = foldUriageRows(visitRows, sougouRows, shogaiRows);
  eq("kaigo = visitRows の totalAmount 合計", r.kaigo, 10000);
  eq("sougou = sougouRows の totalAmount 合計", r.sougou, 3000);
  eq("shogai = shogaiRows の totalAmount 合計", r.shogai, 8000);
  eq("★ jihi は visit+sougou の selfPayAmount 合計のみ (障害は別枠)", r.jihi, 500);
  eq("★ kohi は kohiAmount+kohi2Amount の合算 (visit/sougou分のみ、障害は無し)", r.kohi, 800);
  eq("★ insurance は visit/sougou の insuranceAmount + 障害の benefitAmount", r.insurance, 7000 + 2100 + 7200);
  eq("userBurden は全区分の userAmount 合計", r.userBurden, 1700 + 900 + 800);
  eq("clientIds は全区分の user_id (重複除去はしない、Setは呼出側の責務)", r.clientIds, ["c1", "c2", "c3"]);

  const empty = foldUriageRows([], [], []);
  eq("空配列は全項目0・clientIdsも空", empty, { kaigo: 0, sougou: 0, shogai: 0, jihi: 0, insurance: 0, kohi: 0, userBurden: 0, clientIds: [] });
}

// ── businessTypeOf ────────────────────────────────────────────────────────
eq("訪問入浴 → 訪問入浴", businessTypeOf("訪問入浴"), "訪問入浴");
eq("訪問介護 → 訪問介護", businessTypeOf("訪問介護"), "訪問介護");
eq("★ 訪問看護 → 訪問介護に寄せる (同じ集計経路を使うため)", businessTypeOf("訪問看護"), "訪問介護");
eq("★ それ以外 (居宅介護支援等) は居宅介護支援に落ちる (デフォルト)", businessTypeOf("居宅介護支援"), "居宅介護支援");
eq("★ 未知のservice_typeも居宅介護支援にフォールバックする", businessTypeOf("福祉用具"), "居宅介護支援");

// ── sumUriage ─────────────────────────────────────────────────────────────
{
  const mk = (o: Partial<UriageBreakdown>): UriageBreakdown => ({ ...EMPTY_URIAGE, ...o });
  const list: UriageBreakdown[] = [
    mk({ total: 10000, kaigo: 6000, sougou: 1000, shogai: 2000, chiiki: 500, kyotaku: 0, jihi: 300, insurance: 8000, kohi: 500, userBurden: 1200, reported: 200, reportedBreakdown: { 予防: 200 } }),
    mk({ total: 5000, kaigo: 3000, sougou: 0, shogai: 1500, chiiki: 0, kyotaku: 0, jihi: 200, insurance: 4000, kohi: 100, userBurden: 700, reported: 300, reportedBreakdown: { その他: 300 } }),
  ];
  const summed = sumUriage("2026-06", list);
  eq("month は引数のまま", summed.month, "2026-06");
  eq("total は単純加算", summed.total, 15000);
  eq("★ chiiki を足し忘れない (2026-08-06 に実際に踏んだ抜け漏れ)", summed.chiiki, 500);
  eq("★ reported を足し忘れない (同上のバグと同じ形)", summed.reported, 500);
  eq("★ reportedBreakdown はカテゴリごとにマージされる", summed.reportedBreakdown, { 予防: 200, その他: 300 });
  eq("★ 恒等式: 制度別内訳(kaigo+sougou+shogai+chiiki+kyotaku+jihi+reported) = total", summed.kaigo + summed.sougou + summed.shogai + summed.chiiki + summed.kyotaku + summed.jihi + summed.reported, summed.total);
  eq("空リストは EMPTY_URIAGE 相当 (ただしmonthは引数)", sumUriage("2026-07", []), { ...EMPTY_URIAGE, month: "2026-07" });
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① chiiki/reported を足し忘れる壊れた実装 (2026-08-06 に実際に起きたバグの再現)
  const mk = (o: Partial<UriageBreakdown>): UriageBreakdown => ({ ...EMPTY_URIAGE, ...o });
  const list = [mk({ total: 1000, chiiki: 500, reported: 200 })];
  const correctSum = sumUriage("2026-06", list);
  const brokenSum = (() => {
    const out = { ...EMPTY_URIAGE, month: "2026-06", warnings: [] as string[], reportedBreakdown: {} };
    for (const u of list) {
      out.total += u.total;
      out.kaigo += u.kaigo;
      out.sougou += u.sougou;
      out.shogai += u.shogai;
      // ★ chiiki を足し忘れる
      out.kyotaku += u.kyotaku;
      out.jihi += u.jihi;
      out.insurance += u.insurance;
      out.kohi += u.kohi;
      out.userBurden += u.userBurden;
      // ★ reported も足し忘れる
    }
    return out;
  })();
  const detected1 = correctSum.chiiki !== brokenSum.chiiki || correctSum.reported !== brokenSum.reported;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: chiiki/reported足し忘れを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ chiiki/reportedを足し忘れる(2026-08-06の実バグと同型)のを検出できる (正のchiiki=${correctSum.chiiki}/reported=${correctSum.reported} / 壊れた版のchiiki=${brokenSum.chiiki}/reported=${brokenSum.reported})`);

  // ② chiikiYenFromRecord で units の優先順位を逆にする壊れた実装 (notesを優先してしまう)
  const correct2 = chiikiYenFromRecord(10, "9999円");
  const broken2 = (() => {
    const yenInNotes = /(\d+)円/.exec("9999円");
    return yenInNotes ? Number(yenInNotes[1]) : 10 * 10; // ★ notes優先にする (正はunits優先)
  })();
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: units/notesの優先順位の違いを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ units/notesの優先順位を逆にするバグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\n売上(見込)集計 (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
