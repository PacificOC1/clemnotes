# Writing study notes for Clemnotes courses

This is the guide for anyone — person or agent — adding to or editing the study-notes packs in
`src/courses/packs/`. Read it all before writing. The Chemistry pack (`vce-chemistry/`) is the
reference: when in doubt, match it.

## 1. What a pack is

A pack is plain text that the Courses tab files under each learning point (dot point) of a
course when the student presses **Add study notes**. Each learning point then opens as a lesson:
section headings, readable paragraphs, flip-card flashcards, and practice questions with hidden
answers. Nothing is a special node type — every line becomes an ordinary rem the student can edit.

- One file per area of study: `u1-aos1.txt` … plus `skills.txt` for study-wide skills.
- Files are listed in `src/courses/packs/index.ts` (`PACKS`). A new file does nothing until it's added there.
- The notes are **our own writing**. The study design's wording is VCAA's copyright and this repo is
  public: **never paste a dot point's wording (or any study-design text) into a pack.** Entries are
  matched to dot points by a hash (see §3), so the wording never needs to be here.

## 2. The format

Parsed by `parsePack` in `src/courses/notesPack.ts`.

```
@ 66b4287b U1.1.1.1 | Elements, isotopes and ions      ← header: key, position, short title
**In a sentence**                                       ← a section (a bold-only line with children)
  An element is defined by its number of protons.       ← two spaces deeper = a child rem
Card front :: card back                                 ← a flashcard (as typed in the app)
Isotopes differ in their number of {{neutrons}}.        ← a cloze card
Amount $n = \frac{m}{M}$                                ← maths, rendered by KaTeX
`code`                                                  ← inline code (rarely needed)
% a comment                                             ← only with % in the FIRST column
```

- Indent with exactly **two spaces** per level. No tabs. A line can only be one level deeper than the line above.
- A line that is only `**bold text**` and has children is drawn as a **section heading** in the lesson.
- `%` starts a comment only in column one. An indented `%(m/v)` is ordinary text. Never start an
  unindented content line with `% `.
- Markup characters are reserved: `**`, `{{ }}`, `$`, and a backtick. Don't use them as literal characters.
  The one escape: write a dollar sign as `\$` ("costs \$4.50"). The parser rejects a line with an
  unmatched `$`, so a forgotten backslash fails loudly instead of swallowing text into maths.
- `::` makes a flashcard. Use it **only** in flashcard lines (never in prose — "ratio 1::2" would become a card).
- A rem with a cloze **and** `::` is broken (the cloze wins and `::` shows on the card). Never mix them.

## 3. Headers and keys

`@ <key> <position> | <short title>`

- **position**: `U<unit>.<area>.<group>.<point>` counting from 1 in study-design order (group = the
  bold sub-heading under Key knowledge), or `S.<group>.<point>` for key science skills.
- **key**: a hash of the dot point's wording. Don't compute it by hand. Write eight underscores and
  run the script, which reads the study design `.docx` (not in the repo — the user has it):

  ```
  @ ________ U3.1.2.4 | Galvanic cells
  npx tsx scripts/course-pack-keys.ts <study-design.docx> src/courses/packs/vce-chemistry 3,4
  ```

  It fills every key, refuses unknown or duplicate positions, and lists positions with no notes yet.
- **Same wording, same key.** Some study designs repeat a dot point word for word in several areas
  (Economics repeats "define key economic concepts and terms…" four times). Those entries share a key;
  `planPack` places each by key *and* position, so write one entry per position as usual — but give
  them **the same short title**, because the lesson title is looked up by key (the pack test checks).
- **short title**: our own name for the learning point, shown as the lesson title. Capitalised, at
  most ~45 characters, no full stop. Name the idea, not the verb: "Titrations and standard
  solutions", not "Using titrations to find concentration".

## 4. The shape of every entry

Use these sections, in this order, with exactly these headings (the lesson view recognises
"Flashcards" and "Practice questions" by name):

| # | Section | Required | What goes in it |
|---|---|---|---|
| 1 | **In a sentence** | yes | One or two lines: the whole point, as you'd say it to a friend. |
| 2 | **Key terms** | yes (key knowledge) | Each term in bold, then a precise definition: `**Isotope**: atoms of the same element with different numbers of neutrons.` |
| 3 | Topic sections | yes | The teaching. Name them for their content ("How the table is organised", "Why water is anomalous") or use **Key ideas**. |
| 4 | **Going deeper** | where it helps | The "why" behind the rule, the model underneath, a subtlety that separates a good answer from an adequate one. |
| 5 | **Worked example** | for anything calculable or explainable | Question as the parent line; each step a child; units and significant figures at every step. Add **Worked example 2** for a different kind of question. |
| 6 | **Common mistakes** | yes | What students actually get wrong, stated as the wrong thing and why it's wrong. |
| 7 | **Exam tips** | optional | How marks are awarded: the words an answer must contain, the structure of a good explanation. |
| 8 | **Connections** | yes | 2–4 lines naming other learning points this one builds on or feeds into (use their short titles). |
| 9 | **Practice questions** | yes (key knowledge) | 3–5 exam-style questions. Each question is a line; its model answer is the child line(s). Shown with a "Show answer" button; **not** scheduled as cards. Mix recall, explain, calculate and apply. |
| 10 | **Flashcards** | yes, always last | 5–8 cards for key knowledge, 2–4 for a skill. |

Key science skills (`skills.txt`) are lighter: In a sentence, Key ideas, one worked example or
scenario where it fits, Practice questions (2–3), Flashcards (2–4).

## 5. Depth — what "detailed" means here

- **Explain, don't list.** Every rule gets its reason: not "atomic radius decreases across a period" but
  "…because core charge increases while the number of shells stays the same, so valence electrons are
  pulled closer."
- **Cover everything the dot point names.** Read the dot point (in the study design, not in the pack)
  and tick off every noun in it: if it says "including polyprotic acids and amphiprotic species", both
  must be taught with examples.
- **Level: VCE Units 1–2 (Year 11).** Go as far as the study design asks and one step further only
  in "Going deeper". Don't teach Unit 3–4 content as if it were examinable.
- **Worked examples are complete**: formula → substitution with units → answer with correct significant
  figures and units → a one-line sense check.
- **Examples are concrete**: name the actual substance, number, equation or product.
- **Australian spelling and context**: colour, ionise, analyse, sulfur, aluminium; Australian examples
  where natural (dryland salinity, E10 petrol).
- **Plain, direct sentences.** Second person is fine. No filler ("It is important to note that…").

## 6. Chemistry conventions

- Formulas with Unicode sub/superscripts: H₂O, CO₃²⁻, SO₄²⁻, Fe³⁺, 6.02 × 10²³, mol L⁻¹, J g⁻¹ K⁻¹.
  Use the real minus sign in charges (⁻, U+207B), not a hyphen.
- Arrows: → for complete reactions, ⇌ for reversible/partial ones (weak acids and bases).
- **Every equation balanced, with states** (s), (l), (g), (aq). Check atoms **and** charge.
- Ionic equations leave out spectator ions; strong acids written as H₃O⁺ (or H⁺).
- Units with a space: 25 °C, 100 kPa, 24.8 L mol⁻¹. Kelvin has no degree sign (298 K).
- Maths that needs layout (fractions, logs) goes in `$…$` KaTeX; simple arithmetic stays as text
  with × and ÷. KaTeX is checked by the tests — `\text{}`, `\frac{}{}`, `^{}`, `_{}` all work.
- Data values used by VCE (from the VCE data book): NA = 6.02 × 10²³ mol⁻¹, R = 8.31 J K⁻¹ mol⁻¹,
  Vm = 24.8 L mol⁻¹ at SLC (25 °C, 100 kPa), Kw = 1.00 × 10⁻¹⁴ at 25 °C, c(water) = 4.18 J g⁻¹ K⁻¹,
  1 atm = 101.3 kPa. Use these, not STP values.

## 6b. Biology conventions

- **Species names** in plain text (the pack has no italics): capital genus, lower-case species —
  Homo sapiens, Anguilla australis. Give the common name first where one exists.
- **Genotypes**: one letter per gene, capital = dominant, lower case = recessive; pick letters whose
  cases look different (T/t, not S/s or O/o). Codominant or incompletely dominant alleles take a
  superscript on a base letter (Cᴿ Cᵂ, Iᴬ Iᴮ i); X-linked alleles ride the X (Xᴴ Xʰ, Xᴴ Y). Use Unicode
  superscripts (ᴬ ᴮ ᴴ ʰ ᴿ ᵂ); there is no KaTeX needed for these.
- **Ratios** with spaces around the colon: 3 : 1, 9 : 3 : 3 : 1, 1 : 2 : 1. Never `::` (that makes a card).
- **Punnett squares**: there are no tables in a pack, so write each square as a parent line with one
  child per offspring row ("Bb × Bb → BB, Bb, Bb, bb") and the ratios after it.
- **Chromosome notation**: 46,XY; 47,XX,+21; haploid n = 23, diploid 2n = 46.
- **Units and values**: µm for cells, mmol/L for blood glucose (normal about 4–8), °C for temperature.
- **Processes as sequences**: when a process has steps (mitosis, SCNT, a feedback loop), give them as
  numbered child lines in order — students are asked to sequence them.
- **Stimulus–response**: always name all five parts (stimulus → receptor → control centre → effector →
  response) and say whether the feedback is negative or positive.
- **Australian examples first**: dingo, Tasmanian devil, mountain pygmy possum, Budj Bim, eucalypts,
  kangaroos. Name the Aboriginal or Torres Strait Islander people and Country an example comes from,
  and don't present cultural knowledge as a curiosity.
- **Correct language examiners look for**: "net movement" (osmosis/diffusion), "down/against the
  concentration gradient", "genetically identical", "reduces the probability", "population" (not
  individual) when talking about adaptation and diversity.

## 6c. English Language conventions

- **Structure differs from the sciences.** There are no study-wide key science skills: each area of study
  has key knowledge (group 1, headed "Key knowledge") and its own key skills (group 2, headed "Key skills"),
  so positions are `U1.1.1.n` for knowledge and `U1.1.2.n` for skills. Key-knowledge entries use the full
  shape; key-skills entries are lighter (In a sentence → Key terms → a how-to section → Going deeper →
  Worked example → Connections → Practice questions → Flashcards, 4+ cards).
- **Words being discussed go in quotation marks** ("mouse" shifted…) — packs have no italics.
- **IPA uses the Harrington, Cox & Evans (1997) symbols for Australian English**, as VCE does: /iː ɪ e æ ɐː ɐ
  ɔ oː ʊ ʉː ɜː ə eː/, diphthongs /æɪ ɑe oɪ əʉ æɔ ɪə ʊə/, and /ɹ/ for r. Phonemic in /slashes/, phonetic
  (what a child actually said) in [brackets]. Always show target → child form.
- **Describe consonants in the order voicing–place–manner** ("/v/ is a voiced labiodental fricative").
- **Descriptive, not prescriptive, language** in the notes themselves: "non-standard", "informal",
  "developing form" — never "wrong", "lazy" or "broken".
- **Dates and periods are approximate** ("about 1100", "c. 1400–1700"); give a source year for statistics
  (NILS3 2019, NILS4 2026, Ethnologue 2025, Census 2021).
- **Name the people, language and place** for Aboriginal and Torres Strait Islander examples (Kaurna,
  Guugu Yimithirr, Gunditjmara), and write about the languages as living.
- **Worked examples are analyses**: quote the text, then one child line per subsystem or feature.

## 6d. Economics conventions

- **Structure like English Language**: no study-wide skills; each area has key knowledge then its own key
  skills. U1 AoS 1's key knowledge has two sub-headings ("Introductory concepts", "The economic agents"),
  so its key skills are **group 3** (`U1.1.3.n`); everywhere else key skills are group 2. Key-skills entries
  use the lighter shape.
- **Money is `\$`**: \$26.44, \$1 004.90, \$2.7 trillion. Thousands take a thin space-style gap ("\$1 004.90",
  "14 520"), as in the other packs' numbers. Say "billion"/"trillion" in words.
- **Every statistic is dated and sourced**: "unemployment 4.6% (August 2026, ABS)". Figures age fast — when
  you update a pack, re-check the cash rate, CPI, unemployment, WPI, GDP growth, the minimum wage and tax
  rates, and search the pack for the old value.
- **Percentages vs percentage points**: a rate moving from 4.35% to 4.60% rose 0.25 percentage points.
- **Precise pairs**: demand vs quantity demanded; increase vs extension; supply vs quantity supplied; shortage
  vs scarcity; nominal vs real; income (flow) vs wealth (stock); balance of trade vs terms of trade;
  unemployment vs underemployment; positive vs normative. Notes must model the exact terms examiners want.
- **Diagrams in words**: packs have no images, so describe a graph by its axes, curves, shift and labelled
  points ("D1 shifts right to D2; price rises from P1 to P2"). Worked examples use schedules and numbers.
- **Chains of reasoning**: cause → effect on costs, spending or incentives → agents' response → outcome →
  effect on living standards (material and non-material). Use this shape in worked examples and answers.
- **Australian examples first** (ACCC cases, RBA decisions, Victorian policies), and U2 AoS 2 entries cover
  all four issues (labour market, trade, income and wealth, environment) because students choose two.

## 7. Flashcards

- **One fact per card.** If the back has "and", consider two cards.
- Fronts are questions that make sense out of context ("Shape of NH₃?" not "What shape?").
- Backs are short: a phrase or one sentence. Put long explanations in the notes, not on cards.
- Cloze cards: at most **two** blanks per line (each blank is its own card; siblings are buried until
  the next day, so a line with many blanks slows the student down).
- Include at least one card that asks **why** and one that asks the student to **do** something
  (write an equation, calculate a value).
- Don't duplicate a practice question as a card.

## 8. Accuracy

- Check every number: redo every calculation in the worked examples and answers (a calculator, or
  a quick script). Match significant figures to the data.
- Balance every equation twice — atoms, then charge.
- Don't state anything you aren't sure of. If a value is approximate, say "about".
- Prefer the explanation VCE examiners expect (e.g. core charge for trends; "overcoming intermolecular
  forces", never "breaking bonds", for boiling a molecular substance).

## 9. Before you finish

1. `npx tsx scripts/course-pack-keys.ts <docx> src/courses/packs/<subject> <units>` — keys filled, nothing missing.
2. `npx vitest run src/courses` — the pack test checks: every position present once, card counts,
   no stray markup, no cloze + `::` in one rem, every `$…$` renders in KaTeX.
3. Read two or three lessons in the app (Courses → the subject → a learning point) to see them as a student will.
4. Update `claude/courses.md` in the Clemnotes project with what changed.

## 10. Adding a new subject

1. Add a catalogue entry in `src/courses/catalogue.ts` (id, title, units, accredited, source URL,
   short names for units `U1` and areas `U1.1`).
2. Import the study design once in the app to check the parser reads it (preview counts).
3. Create `src/courses/packs/<id>/` with one file per area plus `skills.txt` if the study has them,
   using `@ ________ <position> | title` headers, and register the files in `packs/index.ts`.
4. Fill keys with the script, then follow §9.
