#!/usr/bin/env python3
"""Build the public PDF, vector UML illustrations and editable Excalidraw board.

Usage: python scripts/build_documentation.py
Requires reportlab. Outputs are deterministic for the same source and fonts.
The Markdown and the diagram definitions below are the authoring sources.
"""

from __future__ import annotations

import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
from urllib.parse import quote

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Preformatted, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
OUT = ROOT / "output/pdf/LabelScan_Documentation_Technique.pdf"
NAVY, TEAL, INK, MUTED = "#102D3B", "#078B7D", "#223F4B", "#647985"
PALE, BLUE, PAPER = "#EAF7F3", "#EAF1FB", "#FBFCFB"


def register_fonts():
    candidates = [
        Path(os.environ.get("LABELSCAN_DOC_FONT_DIR", "/nonexistent")),
        Path("/usr/share/fonts/truetype/dejavu"),
        Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fonts/truetype",
    ]
    directory = next((p for p in candidates if (p / "DejaVuSans-Bold.ttf").exists()), None)
    if directory is None:
        raise RuntimeError("Set LABELSCAN_DOC_FONT_DIR to a directory with DejaVuSans fonts")
    for suffix, name in [("", "Doc"), ("-Bold", "Doc-Bold"), ("-Oblique", "Doc-Italic")]:
        pdfmetrics.registerFont(TTFont(name, str(directory / f"DejaVuSans{suffix}.ttf")))
    pdfmetrics.registerFontFamily("Doc", normal="Doc", bold="Doc-Bold", italic="Doc-Italic", boldItalic="Doc-Bold")


class Diagram:
    def __init__(self, slug, title, height=720):
        self.slug, self.title, self.width, self.height = slug, title, 1000, height
        self.items = []

    def box(self, x, y, w, h, title, subtitle=None, fill=PALE):
        self.items.append(dict(type="rect", x=x, y=y, w=w, h=h, fill=fill))
        if subtitle:
            self.text(x + w / 2, y + 30, title, 23, anchor="middle", bold=True)
            self.text(x + w / 2, y + 66, subtitle, 19, anchor="middle", color=MUTED)
        else:
            self.text(x + w / 2, y + h / 2 - 10, title, 23, anchor="middle", bold=True)

    def klass(self, x, y, w, title, attrs, fill=PALE):
        h = 64 + 29 * len(attrs)
        self.items.append(dict(type="rect", x=x, y=y, w=w, h=h, fill=fill))
        self.text(x + 18, y + 17, title, 23, bold=True)
        self.line([(x, y + 53), (x + w, y + 53)], arrow=False)
        for i, attr in enumerate(attrs):
            self.text(x + 18, y + 67 + i * 29, attr, 19)

    def text(self, x, y, text, size=20, anchor="start", color=INK, bold=False):
        self.items.append(dict(type="text", x=x, y=y, text=text, size=size, anchor=anchor, color=color, bold=bold))

    def line(self, points, label=None, lx=0, ly=0, arrow=True, dashed=False, color=INK):
        self.items.append(dict(type="line", points=points, arrow=arrow, dashed=dashed, color=color))
        if label:
            self.text(lx, ly, label, 18, color=MUTED)

    def dot(self, x, y):
        self.items.append(dict(type="dot", x=x, y=y))

    def svg(self):
        out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} {self.height}" role="img" aria-labelledby="title">', f'<title id="title">{html.escape(self.title)}</title>', '<rect width="100%" height="100%" fill="#ffffff"/>']
        for a in self.items:
            if a["type"] == "rect":
                out.append(f'<rect x="{a["x"]}" y="{a["y"]}" width="{a["w"]}" height="{a["h"]}" rx="10" fill="{a["fill"]}" stroke="{INK}" stroke-width="1.7"/>')
                # A subtle second contour echoes the editable Excalidraw strokes.
                out.append(f'<rect x="{a["x"]+1.3}" y="{a["y"]-0.7}" width="{a["w"]-1.9}" height="{a["h"]+1.4}" rx="10" fill="none" stroke="{INK}" stroke-width="0.55" opacity="0.22"/>')
            elif a["type"] == "text":
                for i, line in enumerate(a["text"].split("\n")):
                    out.append(f'<text x="{a["x"]}" y="{a["y"] + a["size"] * .85 + i * a["size"] * 1.3}" text-anchor="{a["anchor"]}" font-family="DejaVu Sans,Arial,sans-serif" font-size="{a["size"]}" font-weight="{700 if a["bold"] else 400}" fill="{a["color"]}">{html.escape(line)}</text>')
            elif a["type"] == "dot":
                out.append(f'<circle cx="{a["x"]}" cy="{a["y"]}" r="7" fill="{INK}"/>')
            else:
                points = " ".join(f"{x},{y}" for x, y in a["points"])
                dash = ' stroke-dasharray="7 6"' if a["dashed"] else ""
                out.append(f'<polyline points="{points}" fill="none" stroke="{a["color"]}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"{dash}/>')
                if a["arrow"]:
                    p = arrow_points(a["points"])
                    out.append(f'<polyline points="{p[0][0]},{p[0][1]} {p[1][0]},{p[1][1]} {p[2][0]},{p[2][1]}" fill="none" stroke="{a["color"]}" stroke-width="1.7"/>')
        out.append("</svg>")
        return "\n".join(out) + "\n"

    def pdf(self, c, left, top, width):
        scale = width / self.width
        c.saveState()
        c.translate(left, top - self.height * scale)
        c.scale(scale, scale)
        for a in self.items:
            typ = a["type"]
            if typ == "rect":
                c.setFillColor(colors.HexColor(a["fill"]))
                c.setStrokeColor(colors.HexColor(INK))
                c.setLineWidth(1.7)
                c.roundRect(a["x"], self.height-a["y"]-a["h"], a["w"], a["h"], 10, stroke=1, fill=1)
                c.setLineWidth(.45)
                c.setStrokeColor(colors.HexColor("#AEC2C3"))
                c.roundRect(a["x"]+1.3, self.height-a["y"]-a["h"]-.7, a["w"]-1.9, a["h"]+1.4, 10, stroke=1, fill=0)
            elif typ == "text":
                c.setFont("Doc-Bold" if a["bold"] else "Doc", a["size"])
                c.setFillColor(colors.HexColor(a["color"]))
                draw = c.drawCentredString if a["anchor"] == "middle" else c.drawString
                for i, line in enumerate(a["text"].split("\n")):
                    draw(a["x"], self.height-a["y"]-a["size"]*.85-i*a["size"]*1.3, line)
            elif typ == "dot":
                c.setFillColor(colors.HexColor(INK))
                c.circle(a["x"], self.height-a["y"], 7, stroke=0, fill=1)
            else:
                c.setStrokeColor(colors.HexColor(a["color"]))
                c.setLineWidth(1.7)
                c.setDash([7, 6] if a["dashed"] else [])
                p = c.beginPath()
                for i, (x, y) in enumerate(a["points"]):
                    (p.moveTo if i == 0 else p.lineTo)(x, self.height-y)
                c.drawPath(p)
                c.setDash([])
                if a["arrow"]:
                    p = c.beginPath()
                    for i, (x, y) in enumerate(arrow_points(a["points"])):
                        (p.moveTo if i == 0 else p.lineTo)(x, self.height-y)
                    c.drawPath(p)
        c.restoreState()

    def excalidraw(self, ox, oy):
        elems = []
        for i, a in enumerate(self.items):
            seed = int(hashlib.sha256(f"{self.slug}-{i}".encode()).hexdigest()[:7], 16)
            e = dict(id=f"{self.slug}-{i}", angle=0, strokeColor=INK, backgroundColor="transparent", fillStyle="solid", strokeWidth=1.5, strokeStyle="solid", roughness=.7, opacity=100, groupIds=[self.slug], frameId=None, roundness=None, seed=seed, version=1, versionNonce=seed, isDeleted=False, boundElements=None, updated=1, link=None, locked=False)
            typ = a["type"]
            if typ == "rect":
                e.update(type="rectangle", x=ox+a["x"], y=oy+a["y"], width=a["w"], height=a["h"], backgroundColor=a["fill"], roundness={"type": 3})
            elif typ == "text":
                width = max(pdfmetrics.stringWidth(t, "Doc-Bold" if a["bold"] else "Doc", a["size"]) for t in a["text"].split("\n")) + 6
                e.update(type="text", x=ox+a["x"]-(width/2 if a["anchor"] == "middle" else 0), y=oy+a["y"], width=width, height=len(a["text"].split("\n"))*a["size"]*1.3, text=a["text"], originalText=a["text"], fontSize=a["size"], fontFamily=2, textAlign="center" if a["anchor"] == "middle" else "left", verticalAlign="top", containerId=None, autoResize=True, lineHeight=1.3, strokeColor=a["color"], roughness=0)
            elif typ == "dot":
                e.update(type="ellipse", x=ox+a["x"]-7, y=oy+a["y"]-7, width=14, height=14, backgroundColor=INK)
            else:
                px, py = a["points"][0]
                e.update(type="arrow" if a["arrow"] else "line", x=ox+px, y=oy+py, width=max(x for x,y in a["points"])-min(x for x,y in a["points"]), height=max(y for x,y in a["points"])-min(y for x,y in a["points"]), points=[[x-px,y-py] for x,y in a["points"]], startBinding=None, endBinding=None, startArrowhead=None, endArrowhead="arrow" if a["arrow"] else None, lastCommittedPoint=None, strokeStyle="dashed" if a["dashed"] else "solid", strokeColor=a["color"])
            elems.append(e)
        return elems


def arrow_points(points):
    x0, y0 = points[-2]
    x, y = points[-1]
    angle = math.atan2(y-y0, x-x0)
    return [(x-11*math.cos(angle-.45), y-11*math.sin(angle-.45)), (x,y), (x-11*math.cos(angle+.45), y-11*math.sin(angle+.45))]


def diagrams():
    d = Diagram("01-composants", "UML - composants et connexions LabelScan", 720)
    d.text(28, 16, "CLIENTS", 17, color=TEAL, bold=True)
    d.text(354, 16, "SERVICES LABELSCAN", 17, color=TEAL, bold=True)
    d.text(770, 16, "DONNÉES / FOURNISSEURS", 15, color=TEAL, bold=True)
    d.box(25,80,230,112,"Mobile Expo","Capture et revue")
    d.box(25,300,230,112,"Back-office","Catalogue et comptes")
    d.box(350,185,245,112,"API FastAPI","Routes / services",BLUE)
    d.box(350,460,245,112,"Worker","Événements / extraction",BLUE)
    d.box(750,80,225,112,"PostgreSQL","Métier et outbox")
    d.box(750,300,225,112,"Stockage privé","Images / artefacts")
    d.box(750,520,225,112,"Vision + Claude","OCR puis extraction", "#FFF4E4")
    d.line([(255,136),(300,136),(300,224),(350,224)],"HTTPS",260,99)
    d.line([(255,356),(320,356),(320,270),(350,270)],"HTTPS",260,368)
    d.line([(595,219),(675,219),(675,136),(750,136)],"SQL",626,105)
    d.line([(595,270),(680,270),(680,338),(750,338)],"Objets",603,293)
    d.line([(450,460),(450,382),(713,382),(713,176),(750,176)],"SQL / outbox",482,390)
    d.line([(595,492),(705,492),(705,382),(750,382)],"Objets",610,462)
    d.line([(595,545),(680,545),(680,576),(750,576)],"API",617,565)
    d.text(28,679,"Traits pleins : connexions d'exécution. L'outbox réside dans PostgreSQL.",19,color=MUTED)

    s = Diagram("02-sequence", "UML - capture, extraction et revue humaine", 860)
    centers = [85,280,490,710,915]
    for x, title in zip(centers,["Mobile","API","Stockage","PostgreSQL","Worker"]):
        box_width = 175 if title == "PostgreSQL" else 150
        s.box(x-box_width/2,20,box_width,62,title,fill=BLUE)
        s.line([(x,83),(x,812)],arrow=False,dashed=True,color="#B5C7CC")
    def msg(a,b,y,label,dashed=False):
        s.line([(centers[a],y),(centers[b],y)],dashed=dashed)
        s.text((centers[a]+centers[b])/2,y-27,label,18,anchor="middle")
    s.text(10,103,"01  ACCEPTATION",16,color=TEAL,bold=True)
    msg(0,1,166,"POST /v1/ingestions")
    msg(1,2,215,"Original + JPEG assaini")
    msg(1,3,270,"Capture + artefacts + événement (transaction)")
    msg(1,0,316,"202 · ingestion_id",True)
    s.text(10,345,"02  EXTRACTION ASYNCHRONE",16,color=TEAL,bold=True)
    msg(4,3,405,"Réserver l'événement")
    s.box(760,425,225,75,"OCR / LLM",fill="#FFF4E4")
    s.text(740,508,"Appels fournisseurs par le worker",16,color=MUTED)
    msg(4,3,563,"Run + champs + état")
    s.text(10,590,"03  REVUE HUMAINE",16,color=TEAL,bold=True)
    msg(0,1,648,"POST /{id}/reviews")
    msg(1,3,703,"Run humaine + confirmed + review.finalized")
    msg(4,3,770,"Lot + projection catalogue")
    s.text(10,830,"La revue utilise /v1/ingestions/{id}/reviews. Pointillés : retour.",18,color=MUTED)

    st = Diagram("03-etats", "UML - principaux états de l'ingestion", 770)
    st.dot(500,20)
    st.line([(500,28),(500,70)])
    st.box(365,70,270,75,"raw_stored",fill=BLUE)
    st.line([(500,145),(500,235)])
    st.text(370,166,"Étape OCR\nenregistrée",17,color=MUTED)
    st.box(365,235,270,75,"ocr_done",fill=BLUE)
    st.box(20,410,310,85,"ocr_skipped_garbage",fill="#FFF4E4")
    st.box(365,410,270,85,"extracted")
    st.box(705,410,270,85,"needs_review",fill="#FFF4E4")
    st.line([(365,109),(176,109),(176,410)],"OCR inutilisable",20,262)
    st.line([(500,310),(500,410)])
    st.text(515,332,"Gate +\nréconciliation",17,color=MUTED)
    st.line([(635,273),(840,273),(840,410)])
    st.text(850,298,"Gate +\nréconciliation",17,color=MUTED)
    st.line([(635,109),(955,109),(955,205)],"Échec fournisseur",777,124)
    st.box(695,205,280,60,"extraction_failed",fill="#F7ECEC")
    st.line([(635,250),(670,250),(670,235),(695,235)])
    st.line([(750,205),(750,166),(620,166),(620,145)],"/retry",648,176)
    st.box(365,640,270,85,"confirmed")
    st.line([(500,495),(500,640)],"Revue complète",519,550)
    st.line([(175,495),(175,682),(365,682)])
    st.line([(840,495),(840,682),(635,682)])
    st.text(15,739,"Les états extracted / needs_review sont aussi accessibles sans étape ocr_done.",17,color=MUTED)

    m = Diagram("04-modele", "UML - modèle de données de la capture", 850)
    m.klass(25,20,285,"Store",["id : UUID","organization_id : UUID"],BLUE)
    m.klass(645,20,330,"BusinessPortal",["id : UUID","store_id : UUID","profession_code : text"],BLUE)
    m.line([(310,91),(645,91)],arrow=False)
    m.text(326,58,"1",19)
    m.text(590,58,"0..*",19)
    m.text(387,101,"regroupe",18,color=MUTED)
    m.klass(645,300,330,"Ingestion",["id : UUID","business_portal_id : UUID?","trade_profile_version : text","checksum_sha256 : text"])
    m.line([(810,171),(810,300)],arrow=False)
    m.text(824,192,"0..1",19)
    m.text(824,265,"0..*",19)
    m.klass(25,300,300,"RawArtifact",["id : UUID","ingestion_id : UUID","artifact_kind : text","checksum_sha256 : text"])
    m.line([(645,387),(325,387)],label="ingestion_id",lx=405,ly=398,arrow=False,dashed=True)
    m.text(609,352,"1",19)
    m.text(340,352,"0..*",19)
    m.klass(645,625,330,"ExtractionRun",["id : UUID","ingestion_id : UUID","attempt_no : integer","outcome : text"])
    m.line([(810,480),(810,625)],arrow=False,dashed=True)
    m.text(824,501,"1",19)
    m.text(824,589,"0..*",19)
    m.klass(25,625,300,"ExtractedField",["extraction_run_id : UUID","field_name : text","value / evidence : JSONB?","source : llm | gs1 | human"])
    m.line([(645,712),(325,712)],arrow=False)
    m.text(609,677,"1",19)
    m.text(340,677,"0..*",19)
    m.text(381,725,"contient",18,color=MUTED)
    m.text(20,817,"Plein : clé étrangère. Pointillé : lien par identifiant. ? : valeur nullable.",18,color=MUTED)
    return [d,s,st,m]


def inline(text):
    text = html.escape(text)
    def link(match):
        target = html.unescape(match[2])
        if not target.startswith(("https://", "http://")):
            path, sep, anchor = target.partition("#")
            resolved = (DOCS / path).resolve()
            kind = "tree" if resolved.is_dir() else "blob"
            target = f"https://github.com/jidivici/Labelscan/{kind}/main/" + quote(str(resolved.relative_to(ROOT)))
            if sep:
                target += "#" + quote(anchor)
        return f'<link href="{html.escape(target, quote=True)}" color="{TEAL}">{match[1]}</link>'
    text = re.sub(r"\[([^]]+)\]\(([^)]+)\)", link, text)
    text = re.sub(r"`([^`]+)`", r'<font name="Doc">\1</font>', text)
    return re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)


def render_document(ds):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    chunks = (DOCS / "TECHNICAL-DOCUMENTATION-FR.md").read_text().split("<!-- page -->")
    total = len(chunks)
    c = canvas.Canvas(str(OUT), pagesize=A4, invariant=1, pageCompression=1)
    c.setTitle("LabelScan | Documentation technique")
    c.setAuthor("LabelScan")
    c.setSubject("Produit, architecture UML, extraction et interfaces")
    w,h=A4
    left, content_width = 44, w-88
    body = ParagraphStyle("body",fontName="Doc",fontSize=10.3,leading=15.8,textColor=colors.HexColor(INK),spaceAfter=11,splitLongWords=True)
    small = ParagraphStyle("small",parent=body,fontSize=8.7,leading=12.5,textColor=colors.HexColor(MUTED))
    cell = ParagraphStyle("cell",parent=body,fontSize=8.8,leading=12.6,spaceAfter=0)
    head = ParagraphStyle("head",parent=body,fontName="Doc-Bold",fontSize=22,leading=28,textColor=colors.HexColor(NAVY),spaceAfter=20)
    code = ParagraphStyle("code",fontName="Courier",fontSize=9,leading=12,textColor=colors.HexColor(INK),backColor=colors.HexColor(PALE),borderPadding=10,spaceAfter=14)
    layouts=[]
    # Cover uses the same palette as the UML set.
    c.setFillColor(colors.HexColor(NAVY)); c.rect(0,0,w,h,fill=1,stroke=0)
    c.setFillColor(colors.HexColor(TEAL)); c.rect(0,h-13,w,13,fill=1,stroke=0)
    c.setFillColor(colors.HexColor("#A9DCCE")); c.setFont("Doc-Bold",10)
    c.drawString(48,h-78,"DOCUMENTATION TECHNIQUE")
    c.setFillColor(colors.white); c.setFont("Doc-Bold",48); c.drawString(44,h-205,"LabelScan")
    c.setFont("Doc",22); c.drawString(48,h-259,"De l'étiquette à la fiche")
    c.drawString(48,h-291,"de traçabilité.")
    c.setStrokeColor(colors.HexColor(TEAL)); c.setLineWidth(2)
    for x,y,dx,dy in [(48,355,1,1),(w-48,355,-1,1),(48,245,1,-1),(w-48,245,-1,-1)]:
        c.lines([(x,y,x+24*dx,y),(x,y,x,y+24*dy)])
    c.setFont("Doc",13); c.setFillColor(colors.HexColor("#D5EAE8"))
    c.drawString(73,314,"Capturer"); c.drawString(221,314,"Structurer"); c.drawString(381,314,"Confirmer")
    c.setFont("Doc",9); c.drawString(73,290,"Photo et code-barres"); c.drawString(221,290,"OCR et extraction"); c.drawString(381,290,"Revue humaine")
    for x,n,label in [(48,"3","métiers"),(221,"2","interfaces"),(394,"1","parcours partagé")]:
        c.setFillColor(colors.HexColor("#92D6C7"));c.setFont("Doc-Bold",28);c.drawString(x,177,n)
        c.setFillColor(colors.white);c.setFont("Doc",10);c.drawString(x,153,label)
    c.setFillColor(colors.HexColor("#ADC3C9"));c.setFont("Doc",9);c.drawString(48,62,"Édition septembre 2026 · Architecture & expérience produit")
    c.showPage()
    for index,chunk in enumerate(chunks[1:],start=2):
        c.setFillColor(colors.HexColor(PAPER));c.rect(0,0,w,h,fill=1,stroke=0)
        c.setFillColor(colors.HexColor(TEAL));c.rect(left,h-51,28,3,fill=1,stroke=0)
        c.setFont("Doc-Bold",8);c.setFillColor(colors.HexColor(MUTED));c.drawString(left+39,h-51,"LABELSCAN  /  DOCUMENTATION TECHNIQUE")
        c.setStrokeColor(colors.HexColor("#D7E4E6"));c.setLineWidth(.6);c.line(left,47,w-left,47)
        c.setFont("Doc",8);c.setFillColor(colors.HexColor(MUTED));c.drawString(left,31,"LabelScan · Septembre 2026");c.drawRightString(w-left,31,f"{index:02d} / {total:02d}")
        y=h-85
        lines=chunk.strip().splitlines();pos=0
        while pos<len(lines):
            line=lines[pos].strip()
            if not line or line.startswith('<a '):pos+=1;continue
            if line.startswith('!['):
                slug=Path(re.search(r'\((.*?)\)',line)[1]).stem
                diagram=next(d for d in ds if d.slug==slug)
                dh=content_width/diagram.width*diagram.height
                if y-dh<60:raise RuntimeError(f"Diagram overflow page {index}")
                diagram.pdf(c,left,y,content_width);y-=dh+18;pos+=1;continue
            if line.startswith('## '):
                title=line[3:]
                anchor=f"section-{index}"
                c.bookmarkPage(anchor);c.addOutlineEntry(title,anchor,0)
                flow=Paragraph(inline(title),head);pos+=1
            elif line.startswith('```'):
                block=[];pos+=1
                while pos<len(lines) and not lines[pos].startswith('```'):block.append(lines[pos]);pos+=1
                pos+=1;flow=Preformatted('\n'.join(block),code)
            elif line.startswith('|'):
                rows=[]
                while pos<len(lines) and lines[pos].strip().startswith('|'):
                    row=[v.strip() for v in lines[pos].strip().strip('|').split('|')]
                    if not all(re.fullmatch(r'[:\- ]+',v or '-') for v in row):rows.append(row)
                    pos+=1
                cols=len(rows[0]);ratios=[.29,.71] if cols==2 else [.24,.38,.38]
                if rows[0][0]=='Réf.':ratios=[.09,.43,.48]
                if rows[0][0]=='Profil':ratios=[.22,.14,.64]
                if rows[0][0]=='Étape':ratios=[.18,.37,.45]
                flow=Table([[Paragraph(inline(v),cell) for v in row] for row in rows],colWidths=[content_width*r for r in ratios],hAlign='LEFT')
                flow.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor(PALE)),('LINEBELOW',(0,0),(-1,0),1,colors.HexColor(TEAL)),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F4F7F8')]),('LINEBELOW',(0,1),(-1,-1),.3,colors.HexColor('#DEE8E9')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8)]))
                flow.spaceAfter=16
            else:
                paragraph=[line];pos+=1
                while pos<len(lines) and lines[pos].strip() and not lines[pos].startswith(('|','##','```','![','<a ')):
                    paragraph.append(lines[pos].strip());pos+=1
                text=' '.join(paragraph)
                flow=Paragraph(inline(text),small if text.startswith('Références :') else body)
            fw,fh=flow.wrap(content_width,y-60)
            if y-fh<60:raise RuntimeError(f"Text overflow page {index}: {line[:80]} (y={y}, height={fh})")
            flow.drawOn(c,left,y-fh);y-=fh+getattr(flow,'spaceAfter',10)
        layouts.append({"page":index,"remaining_pt":round(y-60,1)})
        c.showPage()
    c.save()
    return {"pdf":str(OUT.relative_to(ROOT)),"pages":total,"layout":layouts}


def main():
    register_fonts()
    ds=diagrams()
    destination=DOCS/'diagrams';destination.mkdir(parents=True,exist_ok=True)
    elements=[]
    for i,d in enumerate(ds):
        (destination/f'{d.slug}.svg').write_text(d.svg(),encoding='utf-8')
        elements.extend(d.excalidraw((i%2)*1150,(i//2)*1030))
    board={"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":elements,"appState":{"gridSize":None,"viewBackgroundColor":"#ffffff"},"files":{}}
    (destination/'labelscan.excalidraw').write_text(json.dumps(board,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(render_document(ds),ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
