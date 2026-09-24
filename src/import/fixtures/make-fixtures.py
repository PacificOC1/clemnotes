"""
Regenerates the two Anki fixtures the import tests read, with real Anki:

    pip install anki zstandard
    cd src/import/fixtures && python make-fixtures.py
    mv modern.apkg biology-modern.apkg && mv legacy.apkg biology-legacy.apkg

A "Biology" deck with a "Cells" sub-deck: a Basic note (tagged), a Basic-and-
reversed note with an image, a Cloze note with two blanks and a hint, and a
suspended Basic note with MathJax. Six cards are answered so the packages
carry review history and real schedules. `modern.apkg` is the current format
(zstd collection, protobuf media index); `legacy.apkg` is "support older Anki
versions".
"""
import os, time, base64
from anki.collection import Collection, ExportAnkiPackageOptions
from anki.decks import DeckId

col = Collection(os.path.abspath("col.anki2"))
# media
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAwMDAwMDAAAANBAEBAAAANUlEQVQ=")
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")
fname = col.media.write_data("cell.png", png)

biology = col.decks.id("Biology")
cells = col.decks.id("Biology::Cells")

basic = col.models.by_name("Basic")
rev = col.models.by_name("Basic (and reversed card)")
cloze = col.models.by_name("Cloze")

def add(model, deck, fields, tags=()):
    n = col.new_note(model)
    for i, f in enumerate(fields):
        n.fields[i] = f
    n.tags = list(tags)
    col.add_note(n, DeckId(deck))
    return n

n1 = add(basic, biology, ["What is the <b>powerhouse</b> of the cell?", "The mitochondria"], ["exam"])
n2 = add(rev, cells, ["Ribosome", f"Makes proteins<br><img src=\"{fname}\">"])
n3 = add(cloze, cells, ["The {{c1::nucleus}} holds {{c2::DNA::genetic material}}.", "Extra info"], ["exam", "cells"])
n4 = add(basic, biology, ["Water formula", "\\(H_2O\\)"])

# Review some cards to produce revlog + scheduling
col.sched.set_current_deck(biology) if hasattr(col.sched, "set_current_deck") else None
col.decks.select(biology)
answered = 0
for _ in range(6):
    q = col.sched.get_queued_cards()
    if not q.cards:
        break
    c = col.get_card(q.cards[0].card.id)
    c.start_timer()
    states = q.cards[0].states
    from anki.scheduler.v3 import CardAnswer
    ans = col.sched.build_answer(card=c, states=states, rating=CardAnswer.GOOD if answered % 3 else CardAnswer.EASY)
    col.sched.answer_card(ans)
    answered += 1
print("answered", answered)
print("revlog", col.db.scalar("select count() from revlog"))
# suspend one card
cid = col.db.scalar("select id from cards where nid=?", n4.id)
col.sched.suspend_cards([cid])

col.export_anki_package(out_path=os.path.abspath("modern.apkg"),
    options=ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=True, with_media=True, legacy=False), limit=None)
col.export_anki_package(out_path=os.path.abspath("legacy.apkg"),
    options=ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=True, with_media=True, legacy=True), limit=None)
col.close()
