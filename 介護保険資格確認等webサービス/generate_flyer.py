"""居宅介護支援事業所向け 介護保険資格確認等WEBサービス紹介チラシ PDF 生成"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5'))
pdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3'))
JP_SANS = 'HeiseiKakuGo-W5'
JP_SERIF = 'HeiseiMin-W3'

import os
OUT = os.path.join(os.path.dirname(__file__), 'flyer_kaigo_web_service.pdf')
doc = SimpleDocTemplate(OUT, pagesize=A4, topMargin=15*mm, bottomMargin=15*mm, leftMargin=15*mm, rightMargin=15*mm)

styles = getSampleStyleSheet()
title_style = ParagraphStyle('title', parent=styles['Title'], fontName=JP_SANS, fontSize=20, leading=26, alignment=1, textColor=colors.HexColor('#1e40af'), spaceAfter=4)
sub_style = ParagraphStyle('sub', parent=styles['Normal'], fontName=JP_SERIF, fontSize=11, leading=16, alignment=1, textColor=colors.HexColor('#475569'), spaceAfter=10)
h2_style = ParagraphStyle('h2', parent=styles['Heading2'], fontName=JP_SANS, fontSize=13, leading=20, textColor=colors.white, backColor=colors.HexColor('#2563eb'), borderPadding=(4,6,4,6), spaceBefore=8, spaceAfter=4)
body_style = ParagraphStyle('body', parent=styles['Normal'], fontName=JP_SERIF, fontSize=10, leading=15, spaceAfter=3)
bul_style = ParagraphStyle('bul', parent=styles['Normal'], fontName=JP_SERIF, fontSize=10, leading=15, leftIndent=14, bulletIndent=2, spaceAfter=2)
note_style = ParagraphStyle('note', parent=styles['Normal'], fontName=JP_SERIF, fontSize=9, leading=13, textColor=colors.HexColor('#64748b'))
highlight_style = ParagraphStyle('hi', parent=styles['Normal'], fontName=JP_SANS, fontSize=11, leading=17, textColor=colors.HexColor('#1e40af'), backColor=colors.HexColor('#dbeafe'), borderPadding=(6,8,6,8), spaceAfter=6)

story = []

story.append(Paragraph('介護保険資格確認等WEBサービス のご案内', title_style))
story.append(Paragraph('〜 居宅介護支援事業所さま向け 〜', sub_style))
story.append(Paragraph('国保中央会が運営する <b>「介護保険資格確認等WEBサービス」</b> が令和8年(2026年)4月より段階的に開始されます。本制度を活用することで、被保険者証のコピー受領や FAX による計画書配布など、従来の紙ベース業務を大幅に効率化できます。', highlight_style))

story.append(Paragraph('1. 制度の概要', h2_style))
story.append(Paragraph('国保中央会が提供する Web API システムを通じて、介護事業所が利用者の介護保険情報を電子的に取得・連携できる仕組みです。利用者の認定情報や負担割合、住宅改修費の利用状況等を、自社の介護ソフトから直接照会可能になります。', body_style))
story.append(Paragraph('●  介護保険資格確認 (認定情報・有効期限・負担割合 等の取得)', bul_style))
story.append(Paragraph('●  ケアプランデータ連携 (事業所間でのケアプラン電子送受信)', bul_style))
story.append(Paragraph('●  交付用ケアプラン情報の保管 (国保連の介護情報基盤で履歴管理)', bul_style))

story.append(Paragraph('2. いつから始まる?', h2_style))
data = [
    ['時期', '機能'],
    ['令和8年(2026年) 4月〜', '暫定版 運用開始 (介護情報・資格確認 API)'],
    ['令和8年度 下期 (2026年10月〜)', 'ケアプランデータ連携機能 稼働'],
    ['', '  ・ 事業所間連携機能'],
    ['', '  ・ 交付用登録機能'],
    ['', '  ・ 同意・確認用登録機能'],
]
tbl = Table(data, colWidths=[55*mm, 110*mm])
tbl.setStyle(TableStyle([
    ('FONTNAME', (0,0), (-1,-1), JP_SANS),
    ('FONTSIZE', (0,0), (-1,-1), 10),
    ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#e0e7ff')),
    ('TEXTCOLOR', (0,0), (-1,0), colors.HexColor('#1e3a8a')),
    ('GRID', (0,0), (-1,-1), 0.3, colors.HexColor('#94a3b8')),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('LEFTPADDING', (0,0), (-1,-1), 6),
    ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ('TOPPADDING', (0,0), (-1,-1), 5),
    ('BOTTOMPADDING', (0,0), (-1,-1), 5),
]))
story.append(tbl)

story.append(Paragraph('3. 居宅介護支援事業所のメリット', h2_style))
story.append(Paragraph('<b>(1) 計画書配布業務の電子化 ⭐ 最大効果</b>', body_style))
story.append(Paragraph('ケアプラン (居宅サービス計画書) や 月次の利用票・提供票 を、サービス事業所 (訪問介護・福祉用具貸与 等) へ <b>電子的に送信</b> できるようになります。月末・月初の FAX や手渡しによる配布業務を大幅に削減できます。', bul_style))

story.append(Paragraph('<b>(2) 認定情報のリアルタイム取得</b>', body_style))
story.append(Paragraph('利用者の被保険者番号で API 照会するだけで、最新の認定区分・有効期限・負担割合を自動取得。被保険者証のコピー受領や手入力作業が不要になります。', bul_style))

story.append(Paragraph('<b>(3) 過去のケアプラン履歴参照</b>', body_style))
story.append(Paragraph('交付用登録機能により、利用者の過去のケアプラン情報を介護情報基盤から参照可能。利用者が居宅事業所を変更された際の引継ぎがスムーズになります。', bul_style))

story.append(Paragraph('<b>(4) 福祉用具購入費・住宅改修費の利用状況確認</b>', body_style))
story.append(Paragraph('利用者の購入費・住宅改修費の累計支給額や残額をその場で確認可能。計画立案の精度向上・利用者へのご案内に活用できます。', bul_style))

story.append(Paragraph('<b>(5) 認定更新タイミングのチェック漏れ防止</b>', body_style))
story.append(Paragraph('有効期限を介護ソフトが自動でアラート → 期限切れによる請求エラーを未然に防止。', bul_style))

story.append(Paragraph('4. ご利用までに必要な準備', h2_style))
story.append(Paragraph('●  <b>クライアント証明書の取得</b> — 介護DX証明書 (令和7年10月から発行開始) または既存の介護保険証明書を使用', bul_style))
story.append(Paragraph('●  <b>ユーザアカウントの払い出し</b> — 事業所ユーザ → 管理者ユーザ → 一般ユーザ の階層で発行', bul_style))
story.append(Paragraph('●  <b>マイナ資格確認アプリの設定</b> — PCカードリーダー または スマートフォン (NFC) で利用者のマイナンバーカード読み取り', bul_style))
story.append(Paragraph('●  <b>対応介護ソフトの準備</b> — 各介護ソフトベンダーが対応 API 実装を進行中', bul_style))
story.append(Spacer(1, 4))
story.append(Paragraph('※ 申請・お問い合わせ窓口: 国民健康保険中央会 介護情報基盤等コンタクトセンター', note_style))

story.append(Paragraph('5. ご相談・お問い合わせ', h2_style))
story.append(Paragraph('本制度の活用や対応介護ソフトのご導入については、お気軽にご相談ください。KTグループでは、ケアプラン連携を活用した <b>居宅 ⇄ 福祉用具/訪問介護 の電子連携体制</b> を構築中で、貴事業所との連携もスムーズに進められます。', body_style))
story.append(Spacer(1, 8))

contact = Paragraph('<b>株式会社ケイ・ティ・サービス / KTグループ</b><br/>連絡先: TEL 043-XXX-XXXX / kt-group.co.jp', ParagraphStyle('contact', parent=body_style, fontName=JP_SANS, fontSize=11, leading=17, alignment=1, backColor=colors.HexColor('#fef3c7'), borderColor=colors.HexColor('#f59e0b'), borderWidth=1, borderPadding=8))
story.append(contact)
story.append(Spacer(1, 4))
story.append(Paragraph('※ 本資料は令和8年4月時点の暫定版仕様 (国保中央会公表) に基づき作成しています。正式版では項目が変更される可能性があります。', note_style))

doc.build(story)
print('生成完了:', OUT)
