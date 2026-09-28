#!/usr/bin/env python3
"""Build the public PDF, GitHub PNG previews and editable Excalidraw board.

Usage: python scripts/build_documentation.py
Requires reportlab, DejaVu Sans and Poppler (pdftoppm).
Outputs are deterministic for the same source, fonts and rendering tools.
The Markdown and the diagram definitions below are the authoring sources.
"""

from __future__ import annotations

import hashlib
import argparse
import html
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile
from urllib.parse import quote

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Flowable, Paragraph, Preformatted, Table, TableStyle

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
OUT = ROOT / "output/pdf/LabelScan_Documentation_Technique.pdf"
NAVY, TEAL, INK, MUTED = "#102D3B", "#078B7D", "#223F4B", "#647985"
PALE, BLUE, PAPER = "#EAF7F3", "#EAF1FB", "#FBFCFB"
THEMES = {
    "usages": ("USAGES", "#137C72", "#E7F5F0"),
    "architecture": ("ARCHITECTURE", "#2461A5", "#EAF0FB"),
    "donnees": ("DONNÉES", "#7159A7", "#F0ECF9"),
    "api": ("CONTRAT API", "#A86718", "#FFF2DE"),
    "plateforme": ("PLATEFORME", "#486273", "#EDF2F5"),
}
PUBLIC_FILES = (
    'README.md','docs/README.md','docs/TECHNICAL-DOCUMENTATION-FR.md',
    'docs/GUIDE-DU-DEPOT.md','server/README.md','server/demo/README.md','deploy/README.md',
    'docs/diagrams/01-composants.png','docs/diagrams/02-sequence.png',
    'docs/diagrams/03-etats.png','docs/diagrams/04-modele.png',
    'docs/diagrams/labelscan.excalidraw','docs/backend/openapi.v1.yaml',
    'output/pdf/LabelScan_Documentation_Technique.pdf','scripts/build_documentation.py',
)


def page_theme(index):
    if 3 <= index <= 8 or index == 27:
        return THEMES['usages']
    if 9 <= index <= 14 or index in (28,29,31):
        return THEMES['architecture']
    if 15 <= index <= 17 or index in (30,33):
        return THEMES['donnees']
    if 18 <= index <= 20:
        return THEMES['api']
    return THEMES['plateforme']


class EditorialGrid(Flowable):
    """Render source table cells as cards or unframed two-column definitions."""
    def __init__(self, rows, theme, mode='cards'):
        super().__init__()
        self.rows,self.theme,self.mode = rows,theme,mode
        self.spaceAfter=18

    def wrap(self, available_width, available_height):
        self.width=available_width
        self.columns=3 if self.mode=='metrics' else 2
        self.gap=12
        self.cell_width=(self.width-(self.columns-1)*self.gap)/self.columns
        self.padding=0 if self.mode=='definitions' else 12
        self.parts=[]
        title_style=ParagraphStyle('tile-title',fontName='Doc-Bold',fontSize=10.4,leading=14,textColor=colors.HexColor(self.theme[1]))
        detail_style=ParagraphStyle('tile-detail',fontName='Doc',fontSize=9.3,leading=13.5,textColor=colors.HexColor(INK))
        number_style=ParagraphStyle('tile-number',fontName='Doc-Bold',fontSize=30,leading=37,textColor=colors.HexColor(NAVY))
        for row in self.rows[1:]:
            blocks=[Paragraph(inline(row[0]),title_style)]
            if self.mode=='metrics':
                blocks += [Paragraph(inline(row[1])+f' <font size="9">{self.rows[0][1].lower()}</font>',number_style),Paragraph(inline(row[2]),detail_style)]
            else:
                blocks += [Paragraph((f'<b>{inline(self.rows[0][i])}</b><br/>' if len(row)>2 else '')+inline(v),detail_style) for i,v in enumerate(row[1:],1)]
            measurements=[(b,b.wrap(self.cell_width-2*self.padding,10000)[1]) for b in blocks]
            height=sum(h for _,h in measurements)+6*(len(blocks)-1)+2*self.padding+8
            self.parts.append((measurements,height))
        self.row_heights=[max(h for _,h in self.parts[i:i+self.columns]) for i in range(0,len(self.parts),self.columns)]
        self.height=sum(self.row_heights)+self.gap*(len(self.row_heights)-1)
        return self.width,self.height

    def draw(self):
        c=self.canv;top=self.height
        for row_index,height in enumerate(self.row_heights):
            for col,(blocks,_) in enumerate(self.parts[row_index*self.columns:(row_index+1)*self.columns]):
                x=col*(self.cell_width+self.gap)
                if self.mode!='definitions':
                    c.setFillColor(colors.HexColor(self.theme[2]));c.roundRect(x,top-height,self.cell_width,height,7,fill=1,stroke=0)
                    c.setFillColor(colors.HexColor(self.theme[1]));c.rect(x+12,top-6,25,2,fill=1,stroke=0)
                else:
                    c.setStrokeColor(colors.HexColor('#DDE5E9'));c.setLineWidth(.5);c.line(x,top-height+5,x+self.cell_width,top-height+5)
                y=top-self.padding-3
                for paragraph,ph in blocks:
                    paragraph.drawOn(c,x+self.padding,y-ph);y-=ph+6
            top-=height+self.gap


class ProcessRail(Flowable):
    """Numbered timeline retaining both action and result from each source row."""
    def __init__(self, rows, theme):
        super().__init__();self.rows,self.theme=rows,theme;self.spaceAfter=18

    def wrap(self,width,height):
        self.width=width;self.parts=[]
        title_style=ParagraphStyle('step-title',fontName='Doc-Bold',fontSize=10.2,leading=14,textColor=colors.HexColor(NAVY))
        detail_style=ParagraphStyle('step-detail',fontName='Doc',fontSize=9.1,leading=13,textColor=colors.HexColor(INK))
        self.action_width=(width-62)*.44;self.result_width=(width-62)*.56
        for row in self.rows[1:]:
            title=Paragraph(inline(re.sub(r'^\d+\s*[·.]\s*','',row[0])),title_style)
            action=Paragraph(inline(row[1]),detail_style)
            result=Paragraph(inline(row[2]),detail_style)
            th=title.wrap(width-42,10000)[1]
            ah=action.wrap(self.action_width,10000)[1];rh=result.wrap(self.result_width,10000)[1]
            self.parts.append((title,action,result,th,ah,rh,th+max(ah,rh)+19))
        self.height=sum(p[-1] for p in self.parts)+20
        return width,self.height

    def draw(self):
        c=self.canv;top=self.height
        c.setFont('Doc-Bold',7.5);c.setFillColor(colors.HexColor(self.theme[1]))
        c.drawString(40,top-7,self.rows[0][1].upper());c.drawString(56+self.action_width,top-7,self.rows[0][2].upper())
        top-=20
        for i,(title,action,result,th,ah,rh,height) in enumerate(self.parts):
            c.setStrokeColor(colors.HexColor('#D6E2E5'));c.setLineWidth(1)
            if i<len(self.parts)-1:c.line(12,top-14,12,top-height-4)
            c.setFillColor(colors.HexColor(self.theme[1]));c.circle(12,top-9,11,fill=1,stroke=0)
            c.setFillColor(colors.white);c.setFont('Doc-Bold',9);c.drawCentredString(12,top-12,str(i+1))
            title.drawOn(c,40,top-th)
            action.drawOn(c,40,top-th-5-ah);result.drawOn(c,56+self.action_width,top-th-5-rh)
            top-=height


def editorial_table(rows,theme,cell,width):
    first=rows[0][0]
    if first=='Surface':return EditorialGrid(rows,theme)
    if first=='Profil':return EditorialGrid(rows,theme,'metrics')
    if first=='Terme':return EditorialGrid(rows,theme,'definitions')
    if first=='Étape' and rows[0][1]=='Action':return ProcessRail(rows,theme)
    cols=len(rows[0]);ratios=[.29,.71] if cols==2 else [.24,.38,.38]
    if first=='Réf.':ratios=[.09,.43,.48]
    if first=='Étape':ratios=[.18,.37,.45]
    if first=='Adresse locale':ratios=[.49,.51]
    if first=='Opération' and rows[0][1]=='Échange principal':ratios=[.47,.53]
    quiet=first in ('Réf.','Partie','Donnée conservée')
    technical=first in ('Opération','Famille','Adresse locale')
    header=ParagraphStyle('table-header',parent=cell,fontName='Doc-Bold',textColor=colors.HexColor(theme[1]) if quiet else colors.white)
    label=ParagraphStyle('table-label',parent=cell,fontName='Doc-Bold',textColor=colors.HexColor(theme[1]))
    data=[]
    for r,row in enumerate(rows):
        data.append([Paragraph(inline(v),header if r==0 else (label if col==0 and not technical else cell)) for col,v in enumerate(row)])
    flow=Table(data,colWidths=[width*r for r in ratios],hAlign='LEFT')
    commands=[('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),('LINEBELOW',(0,1),(-1,-1),.35,colors.HexColor('#DDE5E9'))]
    commands += [('BACKGROUND',(0,0),(-1,0),colors.HexColor(theme[2] if quiet else theme[1]))]
    if quiet:
        commands += [('LINEBELOW',(0,0),(-1,0),1,colors.HexColor(theme[1]))]
    elif technical:
        commands += [('BACKGROUND',(0,1),(0,-1),colors.HexColor(theme[2]))]
    else:
        commands += [('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor(theme[2])])]
    flow.setStyle(TableStyle(commands));flow.spaceAfter=16
    return flow


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
    pdfmetrics.registerFont(TTFont("Doc-Mono", str(directory / "DejaVuSansMono.ttf")))
    return directory


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

    def validate_text_bounds(self):
        """Check the shared canvas, including the editable text box padding."""
        for item in self.items:
            if item['type'] != 'text':
                continue
            lines = item['text'].split('\n')
            font = 'Doc-Bold' if item['bold'] else 'Doc'
            width = max(pdfmetrics.stringWidth(line, font, item['size']) for line in lines) + 6
            left = item['x'] - (width / 2 if item['anchor'] == 'middle' else 0)
            bottom = item['y'] + len(lines) * item['size'] * 1.3
            if left < 0 or left + width > self.width or item['y'] < 0 or bottom > self.height:
                raise RuntimeError(f"Diagram text overflow in {self.slug}: {item['text']}")

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
    d.text(755, 16, "DONNÉES / FOURNISSEURS", 15, color=TEAL, bold=True)
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
    s.text(710,508,"Appels fournisseurs par le worker",16,color=MUTED)
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
    # Stable semantic palette across the editable board, PNGs and print views.
    for diagram in (d,s,st,m):
        for item in diagram.items:
            if item['type']=='rect':
                item['fill']={PALE:THEMES['usages'][2],BLUE:THEMES['architecture'][2],'#FFF4E4':THEMES['api'][2]}.get(item['fill'],item['fill'])
    for item in d.items:
        if item['type']=='rect' and item['x']==750 and item['y'] in (80,300):item['fill']=THEMES['donnees'][2]
    for item in s.items:
        if item['type']=='rect' and item['x'] in (415,622.5):item['fill']=THEMES['donnees'][2]
    for item in m.items:
        if item['type']=='rect':item['fill']=THEMES['donnees'][2] if item['y']>=300 else THEMES['architecture'][2]
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
    chunks += (DOCS / "GUIDE-DU-DEPOT.md").read_text().split("<!-- page -->")[1:]
    total = len(chunks)
    if total > 50:
        raise RuntimeError(f"Documentation exceeds the 50-page budget: {total}")
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
    subhead = ParagraphStyle("subhead",parent=body,fontName="Doc-Bold",fontSize=12,leading=17,textColor=colors.HexColor(TEAL),spaceAfter=9)
    code = ParagraphStyle("code",fontName="Doc-Mono",fontSize=9,leading=13,textColor=colors.HexColor(INK),spaceAfter=19)
    layouts=[]
    # Cover uses the same palette as the UML set.
    c.setFillColor(colors.HexColor(NAVY)); c.rect(0,0,w,h,fill=1,stroke=0)
    for i,theme in enumerate(THEMES.values()):
        c.setFillColor(colors.HexColor(theme[1]));c.rect(i*w/5,h-13,w/5,13,fill=1,stroke=0)
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
    for x,label,theme in zip((48,133,255,347,419),('Usages','Architecture','Données','API','Plateforme'),THEMES.values()):
        c.setFillColor(colors.HexColor(theme[2]));c.circle(x+3,107,3,fill=1,stroke=0)
        c.setFont('Doc',8);c.drawString(x+12,104,label)
    c.setFillColor(colors.HexColor("#ADC3C9"));c.setFont("Doc",9);c.drawString(48,62,"Édition septembre 2026 · Architecture, usages & guide du dépôt")
    c.showPage()
    for index,chunk in enumerate(chunks[1:],start=2):
        theme=page_theme(index)
        subhead.textColor=colors.HexColor(theme[1])
        c.setFillColor(colors.HexColor(PAPER));c.rect(0,0,w,h,fill=1,stroke=0)
        c.setFillColor(colors.HexColor(theme[1]));c.rect(left,h-51,28,3,fill=1,stroke=0)
        c.setFont("Doc-Bold",8);c.drawString(left+39,h-51,'LABELSCAN  /  '+('GUIDE DU DÉPÔT' if index>=25 else theme[0]))
        c.setFillColor(colors.HexColor(theme[1]));c.rect(w-5,h-110,5,55,fill=1,stroke=0)
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
            elif line.startswith('### '):
                flow=Paragraph(inline(line[4:]),subhead);pos+=1
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
                flow=editorial_table(rows,theme,cell,content_width)
            elif re.match(r'^(?:- |\d+\. )', line):
                label, text = re.match(r'^(-|\d+\.) (.*)', line).groups()
                flow=Paragraph(inline(text),body,bulletText='•' if label=='-' else label)
                flow.style=ParagraphStyle('list-item',parent=body,leftIndent=14,bulletIndent=0,spaceAfter=7)
                pos+=1
            else:
                paragraph=[line];pos+=1
                while pos<len(lines) and lines[pos].strip() and not lines[pos].startswith(('|','##','```','![','<a ','- ')) and not re.match(r'^\d+\. ',lines[pos]):
                    paragraph.append(lines[pos].strip());pos+=1
                text=' '.join(paragraph)
                flow=Paragraph(inline(text),small if text.startswith('Références :') else body)
            fw,fh=flow.wrap(content_width,y-60)
            if y-fh<60:raise RuntimeError(f"Text overflow page {index}: {line[:80]} (y={y}, height={fh})")
            if isinstance(flow,Preformatted):
                if any(pdfmetrics.stringWidth(t,'Doc-Mono',9)>content_width-20 for t in flow.lines):
                    raise RuntimeError(f"Code line overflow page {index}")
                c.setFillColor(colors.HexColor(theme[2]))
                c.roundRect(left,y-fh-7,content_width,fh+14,5,fill=1,stroke=0)
                flow.drawOn(c,left+10,y-fh)
            else:
                flow.drawOn(c,left,y-fh)
            y-=fh+getattr(flow,'spaceAfter',10)
        layouts.append({"page":index,"remaining_pt":round(y-60,1)})
        c.showPage()
    c.save()
    return {"pdf":str(OUT.relative_to(ROOT)),"pages":total,"layout":layouts}


def export_previews(ds, destination, font_dir):
    """Rasterize our vector drawings, including embedded fonts, for GitHub."""
    bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm'
    executable = os.environ.get('LABELSCAN_DOC_PDFTOPPM') or shutil.which('pdftoppm')
    executable = executable or (str(bundled) if bundled.is_file() else None)
    if not executable:
        raise RuntimeError('Install Poppler or set LABELSCAN_DOC_PDFTOPPM')
    with tempfile.TemporaryDirectory(prefix='labelscan-diagrams-') as tmp:
        folder = Path(tmp)
        config = folder / 'fonts.conf'
        config.write_text('<fontconfig><dir>' + html.escape(str(font_dir)) + '</dir><cachedir>' + html.escape(str(folder / 'font-cache')) + '</cachedir></fontconfig>')
        env = dict(os.environ, FONTCONFIG_FILE=str(config))
        for d in ds:
            vector = folder / f'{d.slug}.pdf'
            c = canvas.Canvas(str(vector), pagesize=(d.width,d.height), invariant=1)
            c.setFillColor(colors.white);c.rect(0,0,d.width,d.height,fill=1,stroke=0)
            d.pdf(c,0,d.height,d.width);c.showPage();c.save()
            subprocess.run([executable,'-png','-singlefile','-r','144',str(vector),str(destination / d.slug)],check=True,env=env)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package',action='store_true',help='Also create the 15-file documentation ZIP under output/')
    args=parser.parse_args()
    font_dir = register_fonts()
    ds=diagrams()
    for diagram in ds:
        diagram.validate_text_bounds()
    destination=DOCS/'diagrams';destination.mkdir(parents=True,exist_ok=True)
    elements=[]
    for i,d in enumerate(ds):
        elements.extend(d.excalidraw((i%2)*1150,(i//2)*1030))
    board={"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":elements,"appState":{"gridSize":None,"viewBackgroundColor":"#ffffff"},"files":{}}
    (destination/'labelscan.excalidraw').write_text(json.dumps(board,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    export_previews(ds,destination,font_dir)
    result=render_document(ds)
    if args.package:
        package=ROOT/'output/LabelScan_Documentation_Proposition.zip'
        with zipfile.ZipFile(package,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
            for relative in PUBLIC_FILES:
                info=zipfile.ZipInfo(relative,date_time=(2026,9,13,0,0,0))
                info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644 << 16
                archive.writestr(info,(ROOT/relative).read_bytes())
        result.update(package=str(package.relative_to(ROOT)),package_files=len(PUBLIC_FILES))
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
