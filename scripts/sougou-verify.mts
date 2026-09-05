/**
 * 総合事業 (71R1 / 7113) 請求ロジックの検証ハーネス
 *
 * ⚠ **DB には一切書き込まない。** 合成データを純関数に流して期待値と突合する。
 *   本番 DB に marker 付きテストデータを入れる案もあったが、
 *     - 他セッションが同じ DB で突合ハーネス (check:densou 等) を回している
 *     - 取込 script は「対象月ぶんを消して入れ直す」ので競合しうる
 *   ため、副作用ゼロで同じ検証ができる純関数テストにした。
 *   最後の §6 だけ本番 DB を **READ ONLY** で参照する (単価マップの網羅性確認)。
 *
 * 重点: memory `project_sougou_insurer_scoped_master.md`
 *   「総合事業は保険者ごとに番号・単価が決まる。事業所単位で持つと誤請求」
 *
 * 使い方: npx tsx scripts/sougou-verify.mts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  splitSougouCode,
  groupSougouRowsByOfficeNumber,
  buildSougouDensou,
  type SougouDensouRow,
} from "../src/lib/kokuho-densou/build-sougou";

let pass = 0;
let fail = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  OK   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n         期待: ${e}\n         実際: ${a}`);
  }
};
const checkTrue = (label: string, cond: boolean) => check(label, cond, true);

// ── 合成行のひな型 ───────────────────────────────────────────────────────────
// UserSeikyuRow は項目が多いので、検証に効く項目だけ明示し残りは既定値で埋める。
const mkRow = (o: Partial<SougouDensouRow> & { user_name: string }): SougouDensouRow =>
  ({
    system: "総合事業",
    user_id: o.user_name,
    user_name_kana: null,
    user_number: null,
    insurer_name: null,
    care_level: "要支援1",
    copay_rate: 0.1,
    details: [],
    grossBaseUnits: 0,
    limitUnits: null,
    planUnits: null,
    overUnits: 0,
    overSource: "auto",
    overAmount: 0,
    selfPayAmount: 0,
    baseUnits: 0,
    addonUnits: 0,
    kanriTaishougaiUnits: 0,
    addonLabel: null,
    totalUnits: 0,
    unitPrice: 10,
    totalAmount: 0,
    insuranceAmount: 0,
    userAmount: 0,
    publicExpense: null,
    insurer_number: "122101",
    insured_number: "0000000001",
    // ⚠ 下の 4 つは build-sougou が必ず読む必須項目。省くと String(undefined) で
    //   伝送本文に文字列 "undefined" が出る (型では必須なので実コードでは起きない。
    //   合成データ側の作り込み漏れを踏んだ 2026-09-03)。
    serviceDays: 1,
    kohiTandoku: false,
    kohiAmount: null,
    careOfficeNumber: null,
    birth_date: null,
    ...o,
  }) as unknown as SougouDensouRow;

console.log("\n=== §1 splitSougouCode (自治体 prefix の除去) ===");
check("MB_A21111 → kind A2 / item 1111", splitSougouCode("MB_A21111"), { kind: "A2", item: "1111" });
check("IC_A31031 → kind A3 / item 1031", splitSougouCode("IC_A31031"), { kind: "A3", item: "1031" });
check("prefix 無し A26184", splitSougouCode("A26184"), { kind: "A2", item: "6184" });
check("介護コード 116274 は総合事業ではない", splitSougouCode("116274"), null);
check("桁数違いは null", splitSougouCode("MB_A2111"), null);

console.log("\n=== §2 保険者ごとの事業所番号切替 (誤請求の本命) ===");
// いすみ: 122184/124412 → 介護と同じ 1278600398 / 122382 のみ 12A8600011
const FALLBACK = "1278600398";
const byInsurer = { "122382": "12A8600011" };
const rows2 = [
  mkRow({ user_name: "A(122184)", insurer_number: "122184" }),
  mkRow({ user_name: "B(122382)", insurer_number: "122382" }),
  mkRow({ user_name: "C(124412)", insurer_number: "124412" }),
  mkRow({ user_name: "D(122382)", insurer_number: "122382" }),
];
const grouped = groupSougouRowsByOfficeNumber(rows2, FALLBACK, byInsurer);
check("ファイルは 2 本に分かれる", grouped.size, 2);
check("12A8600011 は 2 名", grouped.get("12A8600011")?.map((r) => r.user_name), ["B(122382)", "D(122382)"]);
check("fallback 1278600398 は 2 名", grouped.get(FALLBACK)?.map((r) => r.user_name), ["A(122184)", "C(124412)"]);
// Map でも Record でも同じ結果になること (呼出側の型ゆれ)
const groupedMap = groupSougouRowsByOfficeNumber(rows2, FALLBACK, new Map(Object.entries(byInsurer)));
check("Map 渡しでも同結果", [...groupedMap.keys()].sort(), [...grouped.keys()].sort());
// 保険者番号が空の行は fallback に寄る (番号なしで別ファイルを作らない)
const grouped3 = groupSougouRowsByOfficeNumber(
  [mkRow({ user_name: "E(空)", insurer_number: "" })], FALLBACK, byInsurer);
check("保険者番号 空 → fallback", [...grouped3.keys()], [FALLBACK]);

console.log("\n=== §3 71R1 明細書: 住所地特例は 種別14 ===");
const optsBase = { officeNumber: "1278600398", year: 2026, month: 6, unitPrice: 10.0 };
const resTokurei = buildSougouDensou(
  [
    mkRow({
      user_name: "住所地特例あり", insured_number: "0000000010", insurer_number: "122184",
      totalUnits: 100, baseUnits: 100, totalAmount: 1000, insuranceAmount: 900, userAmount: 100,
      details: [{ service_type: "訪問型サービス", short_name: null, service_code: "MB_A21111",
        unit_per: 100, count: 1, units: 100 }] as never,
      jushoTokurei: true, jushoTokureiInsurerNumber: "122192",
    }),
  ],
  optsBase,
);
const unq = (v: string | undefined) => (v ?? "").replace(/"/g, "");
const recs = resTokurei.content.split("\r\n").filter(Boolean).map((l) => l.split(","));
// レコード種別コードは index 3
// (0:レコード種別 1:連番 2:交換情報識別番号 3:種別コード 01=基本/02=明細/14=住所地特例/10=集計)
const kinds = recs.map((c) => unq(c[3]));
checkTrue("種別14 (住所地特例) が出力される", kinds.includes("14"));
checkTrue("種別02 (通常明細) は出力されない", !kinds.includes("02"));
const rec14 = recs.find((c) => unq(c[3]) === "14");
checkTrue("種別14 に施設所在保険者番号 122192 が入る", (rec14 ?? []).some((v) => v.replace(/"/g, "") === "122192"));

// 施設所在保険者番号が不正なら 安全側 (種別02) + warning
const resBadTokurei = buildSougouDensou(
  [
    mkRow({
      user_name: "住所地特例だが番号不正", insured_number: "0000000011", insurer_number: "122184",
      totalUnits: 100, baseUnits: 100, totalAmount: 1000, insuranceAmount: 900, userAmount: 100,
      details: [{ service_type: "訪問型サービス", short_name: null, service_code: "MB_A21111",
        unit_per: 100, count: 1, units: 100 }] as never,
      jushoTokurei: true, jushoTokureiInsurerNumber: "12219", // 5 桁 = 不正
    }),
  ],
  optsBase,
);
const kindsBad = resBadTokurei.content.split("\r\n").filter(Boolean).map((l) => unq(l.split(",")[3]));
checkTrue("番号不正なら種別02 に落とす (安全側)", kindsBad.includes("02") && !kindsBad.includes("14"));
checkTrue("番号不正は warning が出る", resBadTokurei.warnings.some((w) => w.includes("住所地特例")));

console.log("\n=== §4 保険者/被保険者番号が無い行は伝送に載せない ===");
const resMissing = buildSougouDensou(
  [
    mkRow({ user_name: "正常", insured_number: "0000000020", insurer_number: "122184",
      totalUnits: 50, baseUnits: 50, totalAmount: 500, insuranceAmount: 450, userAmount: 50,
      details: [{ service_type: "訪問型サービス", short_name: null, service_code: "MB_A21111",
        unit_per: 50, count: 1, units: 50 }] as never }),
    mkRow({ user_name: "保険者なし", insurer_number: "", insured_number: "0000000021",
      totalUnits: 999, totalAmount: 9990 }),
    mkRow({ user_name: "被保番なし", insurer_number: "122184", insured_number: "",
      totalUnits: 888, totalAmount: 8880 }),
  ],
  optsBase,
);
check("除外 warning が 2 件", resMissing.warnings.filter((w) => w.includes("伝送から除外")).length, 2);
// 伝送本文に氏名は出ないので被保険者番号で判定する
checkTrue("除外された利用者の被保番は本文に出ない", !resMissing.content.includes("0000000021"));
checkTrue("正常な利用者の被保番は本文に出る", resMissing.content.includes("0000000020"));
checkTrue('本文に "undefined" が混入しない', !resMissing.content.includes("undefined"));

console.log("\n=== §5 7113 請求書の金額 (手計算と突合) ===");
// 2 名: 単位 1,000 / 2,000。単価 10.00 → 費用 10,000 / 20,000。1 割負担。
const mkBilled = (name: string, insured: string, units: number) =>
  mkRow({
    user_name: name, insured_number: insured, insurer_number: "122184",
    totalUnits: units, baseUnits: units, totalAmount: units * 10,
    insuranceAmount: units * 10 * 0.9, userAmount: units * 10 * 0.1,
    details: [{ service_type: "訪問型サービス", short_name: null, service_code: "MB_A21111",
      unit_per: units, count: 1, units }] as never,
  });
const res5 = buildSougouDensou([mkBilled("甲", "0000000030", 1000), mkBilled("乙", "0000000031", 2000)], optsBase);
const lines5 = res5.content.split("\r\n").filter(Boolean).map((l) => l.split(",").map((v) => v.replace(/"/g, "")));
const rec7113 = lines5.find((c) => c[2] === "7113");
checkTrue("7113 請求書レコードが 1 本ある", !!rec7113);
// ⚠ includes() で値を探してはいけない (2026-09-03 に J の指摘で是正)。
//   データレコードは index0 が必ず "2" (レコード種別) なので
//   includes("2") は **件数が幾つでも通る**。同様に "3000" は単位数と
//   利用者負担の両方に一致しうる。**項番の位置**で見る。
//   レイアウト: [0]種別 [1]連番 [2]交換情報識別番号 … [8]件数 [9]単位数 [10]費用 [11]請求額
const F = (i: number) => (rec7113 ?? [])[i];
check("項: 件数 = 2", F(8), "2");
check("項: 総単位数 = 3000", F(9), "3000");
check("項: 費用合計 = 30000", F(10), "30000");
check("項: 事業費請求額 = 27000 (9割)", F(11), "27000");
// 位置で見ていることの担保: 値を変えたら落ちること (assertion が形骸化していない)
check("恒等式: 費用 = 単位数 × 単価10.00", Number(F(10)), Number(F(9)) * 10);

console.log("\n=== §6 単価マップの網羅性 (本番 DB を READ ONLY 参照) ===");
// SOUGOU_UNITPRICE_BY_INSURER は非 export のため、ソースからキーを読む。
const srcPath = fileURLToPath(new URL("../src/lib/visit-seikyu/aggregate-sougou.ts", import.meta.url));
const src = readFileSync(srcPath, "utf8");
const mapBody = src.slice(
  src.indexOf("const SOUGOU_UNITPRICE_BY_INSURER"),
  src.indexOf("};", src.indexOf("const SOUGOU_UNITPRICE_BY_INSURER")),
);
const mapped = new Set([...mapBody.matchAll(/"(\d{6})":/g)].map((m) => m[1]));
console.log(`  単価マップ登録: ${mapped.size} 保険者`);

const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m![1], m![2].replace(/^["']|["']$/g, "")]),
);
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const rest = async (p: string) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`REST 失敗 (${p.slice(0, 60)}): ${JSON.stringify(j).slice(0, 200)}`);
  return j as Record<string, unknown>[];
};

// 総合事業の実績がある利用者 → その保険者番号が単価マップにあるか。
// 未登録だと office.unit_price にフォールバックし、他市の単価で誤請求になる
// (2026-08-07 に袖ケ浦で 4 名の過大請求が実際に発生した型)。
// ⚠ PostgREST は 1000 行で頭打ちになる。order を付けて offset で全件めくる
//   (order 無しページングは行が抜ける: memory feedback_postgrest_paging_needs_order)。
const sched: Record<string, unknown>[] = [];
for (let off = 0; ; off += 1000) {
  const page = await rest(
    "kaigo_visit_schedule?select=user_id,visit_date&system=eq.%E7%B7%8F%E5%90%88%E4%BA%8B%E6%A5%AD" +
      `&status=eq.completed&order=id&offset=${off}&limit=1000`,
  );
  sched.push(...page);
  if (page.length < 1000) break;
}
const clientIds = [...new Set(sched.map((s) => String(s.user_id)))];
console.log(`  総合事業の実績 (status=completed): ${sched.length} 件 / 実人数 ${clientIds.length} 名`);

// ⚠ 「総合事業の利用者が持つ認定すべての保険者」を数えると誤検出する。
//   利用者は転居・更新で複数の認定を持ち、**総合事業とは無関係な過去の保険者**が混ざる
//   (最初この作りで 船橋市 122044 を「未登録」と誤検出した。実際は総合事業の実績 0 件)。
//   実際に単価解決に使われるのは「提供日に有効な認定」なので、そこまで絞って数える。
const certsByClient = new Map<string, Record<string, unknown>[]>();
for (let i = 0; i < clientIds.length; i += 80) {
  const recs = await rest(
    "client_insurance_records?select=client_id,insurer_number,certification_start_date," +
      `certification_end_date&client_id=in.(${clientIds.slice(i, i + 80).join(",")})`,
  );
  for (const r of recs) {
    const k = String(r.client_id);
    if (!certsByClient.has(k)) certsByClient.set(k, []);
    certsByClient.get(k)!.push(r);
  }
}
const insurers = new Map<string, number>();
const overlapping = new Map<string, string>();
let noCert = 0;
for (const s of sched) {
  const day = String(s.visit_date ?? "");
  const certs = (certsByClient.get(String(s.user_id)) ?? []).filter((c) => {
    const st = String(c.certification_start_date ?? "");
    const en = String(c.certification_end_date ?? "");
    return (!st || st <= day) && (!en || en >= day);
  });
  if (certs.length === 0) {
    noCert++;
    continue;
  }
  // ⚠ 重なる認定が複数あるとき、実装 (resolveCertForMonth) は **start が最新の行**を採る。
  //   「重なる認定すべて」で数えると、転居前の古い認定 (未終了のまま残っているもの) を
  //   拾って誤検出する (船橋市 122044 でこれを踏んだ。実際に採用されるのは千葉市美浜区)。
  certs.sort((a, b) =>
    String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")),
  );
  const n = String(certs[0].insurer_number ?? "").trim();
  if (n) insurers.set(n, (insurers.get(n) ?? 0) + 1);
  // 重複認定 (保険者が違う行が重なっている) はデータ品質の問題として別集計
  const others = new Set(certs.slice(1).map((c) => String(c.insurer_number ?? "").trim()).filter(Boolean));
  others.delete(n);
  if (others.size) overlapping.set(String(s.user_id), [n, ...others].join(" / "));
}
console.log(`  提供日に有効な認定が無い実績: ${noCert} 件 (単価判定の対象外)`);
const used = [...insurers.keys()].sort();
const missing = used.filter((n) => !mapped.has(n));
console.log(`  実績利用者が属する保険者: ${used.length} 種 (分母)`);
console.log(`  うち単価マップ未登録: ${missing.length} 種${missing.length ? " → " + missing.join(", ") : ""}`);
console.log(`  ⚠ 保険者の異なる認定が重なっている利用者: ${overlapping.size} 名 (分母 ${clientIds.length} 名)`);
for (const [uid, v] of overlapping) console.log(`     ${uid}: ${v} (先頭=採用される保険者)`);
check("総合事業の実績がある保険者はすべて単価マップに登録されている", missing.length, 0);

console.log("\n=== §7 単価は「保険者」で決まる — 事業所単位で持つと誤請求になることの実証 ===");
// memory project_sougou_insurer_scoped_master の「事業所単位で持つと誤請求」を
// 実データで裏付ける。**保険者の単価 ≠ 事業所の単価** の行が何行あるかを数える。
{
  const priceMap = Object.fromEntries(
    [...mapBody.matchAll(/"(\d{6})":\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]),
  ) as Record<string, number>;
  const offices = await rest("offices?select=id,name,unit_price&limit=200");
  const officeById = new Map(offices.map((o) => [String(o.id), o]));
  const schedFull: Record<string, unknown>[] = [];
  for (let off = 0; ; off += 1000) {
    const p = await rest(
      "kaigo_visit_schedule?select=user_id,office_id,visit_date&system=eq.%E7%B7%8F%E5%90%88%E4%BA%8B%E6%A5%AD" +
        `&status=eq.completed&order=id&offset=${off}&limit=1000`,
    );
    schedFull.push(...p);
    if (p.length < 1000) break;
  }
  let diffRows = 0, mapped = 0, fellBack = 0;
  const pricesByOffice = new Map<string, Set<number>>();
  for (const s of schedFull) {
    const day = String(s.visit_date);
    const cs = (certsByClient.get(String(s.user_id)) ?? [])
      .filter((c) => {
        const st = String(c.certification_start_date ?? ""), en = String(c.certification_end_date ?? "");
        return (!st || st <= day) && (!en || en >= day);
      })
      .sort((a, b) =>
        String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")));
    const ins = String(cs[0]?.insurer_number ?? "").trim();
    const off = officeById.get(String(s.office_id));
    if (!ins || !off) continue;
    const officePrice = Number(off.unit_price);
    const insPrice = priceMap[ins];
    if (insPrice === undefined) { fellBack++; continue; }
    mapped++;
    if (insPrice !== officePrice) diffRows++;
    const k = String(off.name);
    if (!pricesByOffice.has(k)) pricesByOffice.set(k, new Set());
    pricesByOffice.get(k)!.add(insPrice);
  }
  console.log(`  総合事業の実績 (保険者・事業所が引けたもの): ${mapped + fellBack} 件 (分母)`);
  console.log(`  単価マップ未登録 → office.unit_price にフォールバック: ${fellBack} 件`);
  console.log(`  ★ 保険者の単価 ≠ 事業所の単価 (事業所単位で持つと誤請求になる行): ${diffRows} 件`);
  const multi = [...pricesByOffice.entries()].filter(([, v]) => v.size > 1);
  console.log(`  ★ 同一事業所で単価が複数種になる事業所: ${multi.length} / ${pricesByOffice.size} (分母)`);
  for (const [name, set] of multi) console.log(`      ${name}: ${[...set].sort((a, b) => a - b).join(" / ")} 円`);
  // 保険者スコープが必要であることの確認。0 になったら「事業所単位でも足りる」に変わったということ
  check("保険者スコープが必要 (事業所単位では表現できない事業所がある)", multi.length > 0, true);
  check("単価マップ未登録へのフォールバックは発生していない", fellBack, 0);
}

console.log("\n=== §8 君津市(122259)の登録前提を見張る (2026-09-05 追加) ===");
// 材料が加藤紀久代1名・202606の1か月ぶんの実伝送のみで登録した (aggregate-sougou.ts
// 参照)。前提: ①明細コードに市町村prefixが付いていない(MB_グループと同じ全国共通A2系)
// ②単価10.21円(7級地)。将来この保険者の実績が増えたときに前提と違う形
// (prefix付きコードが必要/単価が10.21でない)で出てきたら検知する。
{
  const insurerNum122259Count = insurers.get("122259") ?? 0;
  console.log(`  現在の総合事業実績 (insurer=122259, 提供日に有効な認定で解決): ${insurerNum122259Count} 件`);
  if (insurerNum122259Count === 0) {
    console.log("  ★ 現時点の影響は0件 — 登録したが該当実績が無いため、現在の請求額は1円も変わらない");
    check("君津市(122259)の実績件数 = 0 (現状の影響ゼロを明示)", insurerNum122259Count, 0);
  } else {
    // 実績が付き始めたら、実際に使われる単価とマスタ解決の成否を検証する
    const priceMap122259 = Object.fromEntries(
      [...mapBody.matchAll(/"(\d{6})":\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]),
    ) as Record<string, number>;
    check("君津市(122259)の単価マップは10.21のまま (未確認の値に変わっていないか)", priceMap122259["122259"], 10.21);
    console.log("  ⚠ 実績が付き始めました。マスタ解決 (MB_バケットで名前が引けるか) は本番の警告ログ (aggregateSougouSeikyu の warnings) を別途確認してください — このスクリプトは件数と単価定数のみ見ています");
  }
}

console.log(`\n=== 結果: PASS ${pass} / FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
