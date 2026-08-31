// ============================================================================
// 居宅サービス計画書 第1表 (care-plan-1) と 介護予防サービス・支援計画書
// (yobo-care-plan) の **表題部だけ**を埋める。
//
//   node migrations/backfill_careplan1_header.mjs            # DRY RUN
//   node migrations/backfill_careplan1_header.mjs --execute
//   --overwrite   既に値が入っている欄も上書きする
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   第1表は ほのぼのの CAREPLAN1.CSV から本文 (方針・意向) だけを取り込んでおり、
//   表題部を埋めていなかった。2026-08-31 実測: 2,960 件のうち
//     認定年月日 空 2,959 / 計画作成者 空 2,956 / 事業所名 空 2,956
//     要介護状態区分 空 2,943 / 認定の有効期間 空 2,943
//     生年月日 空 2,943 / 住所 空 2,943
//   様式には印字欄があるので、そのまま出すと空欄で刷られる。
//
// ── どこから取るか ──────────────────────────────────────────────────────
//   認定年月日・計画作成者 … その帳票の認定 (client_insurance_records) から。
//     値は backfill_cert_fields_from_honobono.mjs で ほのぼの CSV から入れてある。
//   居宅介護支援事業所名   … ほのぼの CSV の「支援事業所（正式名称）」。
//     認定の care_office_id が入っているのは 657/2,960 件しかないため、
//     CSV から直接引くほうが取れる。
//
//   ⚠ CSV の支援事業所は **他社も混ざる** (地域包括・他法人。1,089 種類あった)。
//     利用者が他社へ移ると ほのぼのの現在の担当事業所が他社になるので、
//     そのまま入れると **自社の第1表に他社名を刻む**ことになる。
//     自社の居宅事業所に一致するものだけ入れ、外れたものは一覧に出す。
//     表記が 自社=全角「Ｈａｎａ居宅支援センターおゆみ野」/
//     ほのぼの=半角カナ「Hana居宅支援ｾﾝﾀｰおゆみ野」と違うので **NFKC で正規化**して
//     突き合わせる (法人名や「予防」が前に付くので完全一致ではなく含有で見る)。
//
// ── 触る範囲 (ここを広げないこと) ──────────────────────────────────────
//   kaigo_report_documents.content の
//   **certification_date / creator_name / office_name / care_level / cert_period /
//     birth_date / address のみ**。
//   生年月日・住所は clients から。⚠ 生年月日は **ISO のまま**入れること
//   (印刷側が fmtReiwa で和暦に変換するので、和暦で入れると二重変換で壊れる)。
//   本文 (総合的な援助の方針・意向・課題分析) には一切触らない。
//
//   ⚠ 認定年月日は様式どおり和暦で入れる (画面・印刷とも和暦表示のため)。
//
//   ⚠ 認定年月日の **キー名が様式で違う**。第1表 = certification_date /
//     介護予防 = cert_date。片方だけ埋めると もう一方がずっと空のままになる。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHonobonoMaster, onlyValue, certKey } from "./_honobono_master_csv.mjs";

const EXECUTE = process.argv.includes("--execute");
const OVERWRITE = process.argv.includes("--overwrite");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * ISO 日付 → 和暦。**画面 (reports-content.tsx の fmtReiwa) と同じ書式にすること。**
 * 書式がずれると、取込で入れた値と画面が作る値が食い違って見える。
 * 認定年月日は 2019 年より前 (平成) のものが実在するので元号の分岐が要る。
 */
function fmtReiwa(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y >= 2019) return `令和${y - 2018}年${mo}月${d}日`;
  if (y >= 1989) return `平成${y - 1988}年${mo}月${d}日`;
  return `${y}年${mo}月${d}日`;
}

/** 表記ゆれを畳む: NFKC (全角→半角・半角カナ→全角カナ) + 空白と記号を落とす */
function normOfficeName(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .replace(/[()（）「」【】・･*＊]/g, "")
    .trim();
}

async function fetchAll(build) {
  const out = [];
  const STEP = 1000;
  for (let from = 0; ; from += STEP) {
    const { data, error } = await build().range(from, from + STEP - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < STEP) return out;
  }
}

async function main() {
  console.log("=== 計画書 (第1表 / 介護予防) の表題部 認定年月日・計画作成者・事業所名 を埋める ===");
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");
  if (OVERWRITE) console.log("*** --overwrite: 既存の値も上書きする ***");

  const { files, byCert } = readHonobonoMaster(KAIGO);
  console.log(`CSV ${files.length} 本 → 認定世代 ${byCert.size} 件`);

  // 自社の居宅介護支援事業所 (これに一致しない事業所名は入れない)
  const { data: officeRows, error: officeErr } = await sb
    .from("offices").select("name, service_type").eq("service_type", "居宅介護支援");
  if (officeErr) { console.error(`事業所マスタの取得に失敗: ${officeErr.message}`); process.exit(1); }
  const ourOffices = (officeRows ?? [])
    .map((o) => normOfficeName(o.name))
    .filter((n) => n.length >= 4);
  console.log(`自社の居宅介護支援事業所 ${ourOffices.length} 件`);
  const isOurs = (name) => {
    const n = normOfficeName(name);
    return !!n && ourOffices.some((o) => n.includes(o));
  };

  const certs = await fetchAll(() => sb
    .from("client_insurance_records")
    .select("id, client_id, insurer_number, insured_number, certification_start_date, certification_end_date, certification_date, care_manager, care_level")
    .order("id"));
  const certById = new Map(certs.map((c) => [c.id, c]));
  const certsByClient = new Map();
  for (const c of certs) {
    if (!certsByClient.has(c.client_id)) certsByClient.set(c.client_id, []);
    certsByClient.get(c.client_id).push(c);
  }

  // 生年月日・住所は利用者マスタから (第1表の表題部に印字欄がある)
  const clients = await fetchAll(() => sb
    .from("clients")
    .select("id, birth_date, postal_code, address")
    .order("id"));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // 対象の様式と「認定年月日」のキー名 (様式で違う)
  const TARGETS = [
    { type: "care-plan-1", label: "第1表", certDateField: "certification_date" },
    { type: "yobo-care-plan", label: "介護予防計画書", certDateField: "cert_date" },
  ];
  const docs = [];
  for (const t of TARGETS) {
    const rows = await fetchAll(() => sb
      .from("kaigo_report_documents")
      .select("id, user_id, certification_id, content")
      .eq("report_type", t.type)
      .order("id"));
    console.log(`${t.label} ${rows.length} 件`);
    docs.push(...rows.map((r) => ({ ...r, _target: t })));
  }
  console.log(`認定 ${certs.length} 件`);

  const plan = [];
  const stat = { 認定が引けない: 0, 変更なし: 0 };
  const noSource = { 認定年月日: 0, 計画作成者: 0, 事業所名: 0, 要介護状態区分: 0, 認定の有効期間: 0, 生年月日: 0, 住所: 0 };
  /** 自社事業所に一致しなかった支援事業所名 (他社へ移った利用者など) */
  const foreignOffice = new Map();
  for (const d of docs) {
    // 帳票が紐づく認定を優先。無ければその利用者の最新の認定
    const cert = (d.certification_id && certById.get(d.certification_id))
      || (certsByClient.get(d.user_id) ?? [])
        .slice()
        .sort((a, b) => String(b.certification_start_date).localeCompare(String(a.certification_start_date)))[0];
    if (!cert) { stat.認定が引けない++; continue; }

    const csv = byCert.get(certKey(cert.insurer_number, cert.insured_number, cert.certification_start_date));
    const officeRaw = csv ? onlyValue(csv.supportOffice) : null;
    // 他社の事業所名を自社の帳票に刻まない
    let officeName = null;
    if (officeRaw) {
      if (isOurs(officeRaw)) officeName = officeRaw;
      else foreignOffice.set(officeRaw, (foreignOffice.get(officeRaw) ?? 0) + 1);
    }

    const c = d.content || {};
    const next = { ...c };
    const changed = [];
    const put = (field, value, label) => {
      if (!value) { noSource[label]++; return; }
      const cur = String(c[field] ?? "").trim();
      if (cur && !OVERWRITE) return;
      if (cur === value) return;
      next[field] = value;
      changed.push(`${label}: ${cur ? `「${cur}」` : "空"} →「${value}」`);
    };
    put(d._target.certDateField, fmtReiwa(cert.certification_date), "認定年月日");
    put("creator_name", (cert.care_manager ?? "").trim(), "計画作成者");
    put("office_name", officeName ?? "", "事業所名");
    put("care_level", (cert.care_level ?? "").trim(), "要介護状態区分");
    // 有効期間は画面の既定値と同じ「令和○年○月○日　〜　令和○年○月○日」(全角スペース) 書式
    const period = cert.certification_start_date && cert.certification_end_date
      ? `${fmtReiwa(cert.certification_start_date)}　〜　${fmtReiwa(cert.certification_end_date)}`
      : "";
    put("cert_period", period, "認定の有効期間");

    // 生年月日は ISO のまま (印刷側が和暦に直す)。住所は画面の既定値と同じ組み立て
    const cl = clientById.get(d.user_id);
    put("birth_date", (cl?.birth_date ?? "").trim(), "生年月日");
    const addr = [cl?.postal_code ? `〒${cl.postal_code}` : "", cl?.address ?? ""]
      .filter(Boolean).join(" ").trim();
    put("address", addr, "住所");

    if (!changed.length) { stat.変更なし++; continue; }
    plan.push({ id: d.id, name: c.user_name ?? "?", next, changed });
  }

  console.log("");
  console.log(`更新 ${plan.length} 件 / 変更なし ${stat.変更なし} / 認定が引けない ${stat.認定が引けない}`);
  console.log("  出どころが無くて埋められなかった欄: "
    + Object.entries(noSource).map(([k, v]) => `${k} ${v}`).join(" / "));
  if (foreignOffice.size) {
    const total = [...foreignOffice.values()].reduce((a, b) => a + b, 0);
    console.log(`  ⚠ 自社の事業所に一致しないので事業所名を入れなかった ${total} 件 (${foreignOffice.size} 種類):`);
    [...foreignOffice].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`     ${v} 件  ${k}`));
  }
  plan.slice(0, 12).forEach((p) => console.log(`   ${p.name}  ${p.changed.join(" , ")}`));
  if (plan.length > 12) console.log(`   … 他 ${plan.length - 12} 件`);

  if (!EXECUTE) { console.log("\nDRY RUN。--execute で反映する。"); return; }

  let ok = 0, ng = 0;
  for (const p of plan) {
    const { error } = await sb.from("kaigo_report_documents").update({ content: p.next }).eq("id", p.id);
    if (error) { ng++; console.error(`  ✗ ${p.name}: ${error.message}`); continue; }
    ok++;
    if (ok % 500 === 0) console.log(`  … ${ok}/${plan.length}`);
  }
  console.log(`\n反映 ${ok} 件 / 失敗 ${ng} 件`);
  if (ng) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
