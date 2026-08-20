// ============================================================================
// 居宅の「月遅れ」利用者を利用票から起こす計画を立てる (READ ONLY)。
//
//   居宅介護支援費は **要介護度で決まる基本単位 + 特定事業所加算 + 処遇改善** で、
//   サービスの実績には依らない。したがって利用票から
//     ・氏名 / 保険者 / 被保険者番号
//     ・要介護度 (区分支給限度基準額から引く)
//     ・実績の有無 (月遅れ か 入院等の利用なし か)
//   を読めば金額が出る。別表は要らない。
//
//   金額は推測せず、**同じ事業所・同じ月・同じ要介護度の既存レセプト**から採る。
//   合計が事業所報告の「月遅れ 総額」と一致するかで、起票前に検証できる。
//     四街道: 20,387 × 2 = 40,774 = 報告の月遅れ総額 (2026-08-20 実証)
//
// ── ⚠ このスクリプトだけでは金額は出せない (2026-08-20 判明) ────────────
//   居宅介護支援費には 初回加算 (434001 / 300単位)・入院時情報連携・退院退所
//   などの **利用者ごとの加算**が乗る。利用票には加算が印字されないので、
//   要介護度から出した基本額は当たらない。
//     大網 6月の月遅れ 18,837円 = 1086 + 初回300 + 特定421 + 処遇38 = 1845単位
//     → 要介護度だけで出した 19,092円 (要介護3・加算なし) は別人の金額だった
//
//   正確な月遅れは **翌月送信の伝送** に入っている。7月10日送信を見ると
//   提供年月ごとに KK ファイルが分かれており、過去月ぶんが月遅れ請求:
//     大網 KK260701 = 提供年月202605 / 1名 1807単位 18,449円
//        = 報告書の 5月 月遅れ 1件 18,449円 と 1 円一致 (実証済み)
//   よって **6 月提供の月遅れは 8月10日送信の居宅伝送**から取るのが正しい。
//
//   このスクリプトは「誰が居ないか」の当たりを付ける用途に留める。
//
//   MONTH=2026-06 node migrations/plan_kyotaku_tsukiokure.mjs
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRiyouhyouPages, findRiyouhyouPdfs, normRiyouName, normOfficeName } from "./_riyouhyou_pdf.mjs";

const MONTH = process.env.MONTH || "2026-06";
const YM = MONTH.replace("-", "");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function extractPages(pdfPath) {
  const py = `
import fitz, json, sys
d = fitz.open(sys.argv[1])
texts, words = [], []
for i in range(d.page_count):
    p = d[i]
    texts.append(p.get_text())
    words.append([{"x": w[0], "y": w[1], "t": w[4]} for w in p.get_text("words")])
print(json.dumps({"texts": texts, "words": words}, ensure_ascii=False))
`;
  const raw = execFileSync("python", ["-c", py, pdfPath], {
    encoding: "utf8", maxBuffer: 1 << 26,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

/** 事業所報告 (売上報告.xls) の 月遅れ 件数・総額 */
function readReports() {
  const dir = path.join(KAIGO, "売上（事業所から）", YM, "売上");
  if (!existsSync(dir)) return [];
  const py = `
import xlrd, json, os, sys
base, col = sys.argv[1], int(sys.argv[2])
out = []
for d in sorted(os.listdir(base)):
    f = os.path.join(base, d, '売上報告.xls')
    if not os.path.exists(f): continue
    b = xlrd.open_workbook(f, encoding_override='cp932')
    s = b.sheet_by_index(len(b.sheet_names()) - 1)
    rows = [r for r in range(s.nrows)
            if str(s.cell_value(r, 0)).replace(' ', '').replace('　', '') == '月遅れ件数']
    cnt = amt = 0
    if rows:
        v = s.cell_value(rows[0], col);      cnt = int(v) if isinstance(v, (int, float)) and v != '' else 0
        v = s.cell_value(rows[0] + 1, col);  amt = int(v) if isinstance(v, (int, float)) and v != '' else 0
    out.append({'dir': d.split(' ')[-1], 'lateCount': cnt, 'lateAmount': amt})
print(json.dumps(out, ensure_ascii=False))
`;
  const raw = execFileSync("python", ["-c", py, dir, String(Number(MONTH.slice(5, 7)))], {
    encoding: "utf8", maxBuffer: 1 << 24,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

/** 報告書のフォルダ通称 → offices.name (uriage-kyotaku-diff.mts と同じ対応) */
const OFFICE_BY_DIR = {
  船橋: "ケアプランＨａｎａ船橋", 八千代: "ケアプランＨａｎａ八千代", 花見川: "ケアプランＨａｎａ",
  四街道: "Ｈａｎａ居宅支援センター四街道", 高品: "Ｈａｎａ居宅支援センター高品",
  おゆみ野: "Ｈａｎａ居宅支援センターおゆみ野",
  ちはら台: "ケイ・ティ・グループ居宅支援センターちはら台",
  五井: "ケイ・ティ・サービス居宅介護支援事業所", ＫＴ姉崎: "ＫＴ在宅サポートセンター",
  姉ム: "ムツミ居宅介護支援事業所", 袖ム: "袖ヶ浦ムツミ居宅支援センター",
  木更津: "木更津ムツミ居宅支援センター", 大網: "リンクス居宅介護支援事業所大網白里",
  茂原: "リンクス居宅介護支援事業所", いすみ: "リンクス居宅介護支援事業所いすみ",
};

async function main() {
  console.log(`=== 居宅 月遅れ 起票計画 (${MONTH}) ===\n`);

  const { data: offices, error } = await sb.from("offices").select("id, name, service_type");
  if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
  const kyotaku = (offices ?? []).filter((o) => o.service_type === "居宅介護支援");
  const findOffice = (printed) => {
    const key = normOfficeName(printed);
    return kyotaku.find((o) => normOfficeName(o.name) === key)
      ?? kyotaku.filter((o) => key.endsWith(normOfficeName(o.name)))
           .sort((a, b) => b.name.length - a.name.length)[0]
      ?? null;
  };
  const lateByOffice = new Map();
  for (const r of readReports()) {
    const name = OFFICE_BY_DIR[r.dir];
    if (name) lateByOffice.set(normOfficeName(name), r);
  }

  // 利用票をすべて読む
  const base = path.join(KAIGO, "利用者データ");
  const groups = new Map();
  for (const area of readdirSync(base)) {
    const areaDir = path.join(base, area);
    if (!existsSync(areaDir)) continue;
    const dirs = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const p2 = path.join(d, e.name);
        if (e.name.includes("居宅")) dirs.push(p2); else walk(p2, depth + 1);
      }
    };
    walk(areaDir, 0);
    for (const d of dirs) {
      for (const f of findRiyouhyouPdfs(d).files) {
        const ex = extractPages(f);
        const rows = parseRiyouhyouPages(ex.texts, ex.words).filter((r) => r.month === MONTH);
        if (!rows.length) continue;
        const key = normOfficeName(rows[0].officeName ?? "");
        if (!groups.has(key)) groups.set(key, { label: rows[0].officeName, rows: [] });
        groups.get(key).rows.push(...rows);
      }
    }
  }

  let grand = 0;
  for (const [key, g] of groups) {
    const off = findOffice(g.label);
    if (!off) { console.log(`── ${g.label}: offices に無い — skip\n`); continue; }

    // 当方の当月レセプト (要介護度ごとの構成を採るため)
    const asg = await sb.from("client_office_assignments").select("client_id").eq("office_id", off.id);
    const ids = [...new Set((asg.data ?? []).map((a) => a.client_id))];
    const mine = new Map();
    for (let i = 0; i < ids.length; i += 80) {
      const { data } = await sb.from("clients").select("id, name, care_level").in("id", ids.slice(i, i + 80));
      for (const c of data ?? []) mine.set(normRiyouName(c.name), c);
    }
    const claims = [];
    for (let i = 0; i < ids.length; i += 80) {
      const { data, error: e2 } = await sb
        .from("kaigo_care_support_claims")
        .select("user_id, care_support_code, care_support_name, units, unit_price, tokutei_kassan_type, tokutei_kassan_units, shoguu_kaizen_code, shoguu_kaizen_units, total_amount, insurance_amount")
        .in("user_id", ids.slice(i, i + 80)).eq("billing_month", MONTH);
      if (e2) { console.error(`✗ ${e2.message}`); process.exit(1); }
      claims.push(...(data ?? []));
    }
    // 要介護度 → 同構成の既存レセプト (最頻)
    const levelOf = new Map([...mine.values()].map((c) => [c.id, c.care_level]));
    const byLevel = new Map();
    for (const c of claims) {
      const lv = levelOf.get(c.user_id);
      if (!lv) continue;
      const k = `${lv}|${c.care_support_code}|${c.units}|${c.tokutei_kassan_units}|${c.shoguu_kaizen_units}|${c.total_amount}`;
      if (!byLevel.has(lv)) byLevel.set(lv, new Map());
      const m = byLevel.get(lv);
      m.set(k, { n: (m.get(k)?.n ?? 0) + 1, c });
    }
    const templateFor = (lv) => {
      const m = byLevel.get(lv);
      if (!m) return null;
      return [...m.values()].sort((a, b) => b.n - a.n)[0].c;
    };

    // 月遅れ = 利用票に **実績があり**、かつ **当方に居ない** 人。
    //
    // ⚠「当方に居るがレセプトが無い人」まで広げてはいけない。当方の居宅データは
    //   ほのぼのの請求データ由来なので、居る = レセプトがある。広げても 1 名も
    //   増えず、6 月が未取込の事業所 (茂原) で全員が引っかかるだけだった。
    const byKey = new Map(g.rows.map((r) => [r.nameKey, r]));
    const late = [...byKey.values()].filter((r) => r.actualCount > 0 && !mine.has(r.nameKey));

    const rep = lateByOffice.get(normOfficeName(off.name));
    console.log(`── ${off.name} ──`);
    let sum = 0;
    const noTpl = [];
    for (const m of late) {
      const tpl = templateFor(m.careLevel);
      if (!tpl) { noTpl.push(m); continue; }
      sum += tpl.total_amount;
      console.log(`   ${m.name.padEnd(12)} ${m.careLevel}  ${tpl.care_support_name} ` +
        `${tpl.units}+特定${tpl.tokutei_kassan_units ?? 0}+処遇${tpl.shoguu_kaizen_units ?? 0} = ${tpl.total_amount.toLocaleString()}円`);
    }
    for (const m of noTpl) {
      console.log(`   ${m.name.padEnd(12)} ${m.careLevel ?? "?"}  ⚠ 同事業所に同じ要介護度の既存レセプトが無く金額を決められない`);
    }
    if (rep) {
      const d = sum - rep.lateAmount;
      console.log(`   計 ${late.length}名 ${sum.toLocaleString()}円   報告 ${rep.lateCount}名 ${rep.lateAmount.toLocaleString()}円   ` +
        (d === 0 && late.length === rep.lateCount ? "✅ 一致" : `差 ${d >= 0 ? "+" : ""}${d.toLocaleString()}円 / 人数差 ${late.length - rep.lateCount}`));
    } else {
      console.log(`   計 ${late.length}名 ${sum.toLocaleString()}円   (報告書が無く検証できず)`);
    }
    grand += sum;
    console.log("");
  }
  console.log(`=== 起票候補の合計 ${grand.toLocaleString()}円 ===`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
