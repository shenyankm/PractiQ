# Ten-format synthetic corpus: offline source review draft

This 2026-10-04 source review is AI-assisted engineering preparation for [issue #90](https://github.com/shenyankm/PractiQ/issues/90). Two AI assistants independently read the original containers and supplied content; no teacher, new contributor or trial participant validated this draft. No model request or import task was started. The historical **0/10 live-model quality acceptance remains unchanged**.

The reviewers read all TXT/CSV content; viewed all four original PDF pages, all four scanned PDF pages and all four quadrants of each PNG/JPEG; checked original DOCX/XLSX XML, relationships, all 37 ZIP components and their embedded rich-page image; and read fresh authorized service derivatives of the original DOC/XLS. The source hashes stayed unchanged. Existing expected data was compared after source mapping. No confirmed supplied-content disagreement was found; limitations below remain open.

## Original source identity

All paths below are relative to `app/fixtures/ai-import/`. These hashes bind the original inputs, not an AI result or approval.

| Source | Bytes | SHA-256 |
| --- | ---: | --- |
| formats/all-types-scanned.pdf | 291925 | `c43131387eb3ef9bad8078c5b24f8ebf95ed2962d8deb4a6728adf40d69c5059` |
| formats/all-types.csv | 3628 | `24d1adc6707b576dd40530c8562a550dc8cae5ae2f7170d33aebba31ce1e35d5` |
| formats/all-types.doc | 102400 | `7ffa3dc99d73125d706e4b19679816774d9033a668a4ee6526246bb6007e87b0` |
| formats/all-types.docx | 81806 | `1100f11e173716d116ec140645f6bc9958738725875898461f1e18c933799fd5` |
| formats/all-types.jpg | 540024 | `0b4289ab911e2457ef07029627595d6214c1c82d3ff6a26aa30a2b75be6537a0` |
| formats/all-types.pdf | 153660 | `15f8a86a4399d9b5f53af0552f1c534f0d2d4bd5a23c4b35b70490a5871afae8` |
| formats/all-types.png | 435823 | `8d680f5c66490b066147d9b8c074caabeaad976e537bdfed197de50eef2fad13` |
| formats/all-types.txt | 3768 | `8c7a08b79de0e40c560a1d98048dc8e203a49f932edd2787cbfbac564d65e3e5` |
| formats/all-types.xls | 106496 | `3ceab6db85bc2ded17cfb94393764f8bab036f4688680d1105ad71c593759d14` |
| formats/all-types.xlsx | 98438 | `2607d65f5e7e2d2e214b4c146e4b5226b401686eed001f1577ac00c419945f02` |

Metadata: `formats-expected.json` SHA-256 `994a7fb033372f4f6795cf0d394370032efc2f0aa24b74d63fd1050c60a90478`; corpus `README.md` SHA-256 `876fd50695e2da17bd9f7e681f139fa461cc9aae310b214654c3a5c4b8f97008`. Supporting `formats/resources/chart.png` SHA-256 `d4423864a250e4940c4588ae7ade862cd5a3cead1f986d99fc4a7e3cbf529b45`; `formats/resources/preview.png` SHA-256 `0593ff49100b3045808ef40a2cac0d43d7022ccc89a677fccce252bf5abfb7d2`. The preview resource was hashed only, not treated as an independent input.

## Source-derived question and evidence map

Review anchors below are draft structural IDs, not native parser IDs. Six material parents plus 19 answerable leaves give 25 records and 16 source-grounded draft type labels. Only 17 leaves have a printed reference answer: two explicitly omit one. The word bank is a material parent with two single-choice children using its shared options. Paragraph matching is one standalone many-to-one matching record with two left statements and two right paragraphs. The grouping follows the [AI contract](../server/src/practiq_ai/contracts.py) and established [text-composites and text-paragraph-matching cases](../server/evals/cases.json), whose complete printed source text matches Sections 5 and 9. The earlier opposing grouping errors cancelled in the totals; counts alone do not verify structure. Subject-reviewer confirmation of supplied content and annotations remains pending.

Each Section number identifies the actual TXT section, corresponding CSV multiline field, original DOCX paragraph group, and XLSX worksheet `Section NN`. TXT and DOCX exact line/paragraph anchors appear below. Original PDF/scanned PDF and PNG/JPEG quadrants locate Sections 1–4 on page/quadrant 1, 5–8 on 2, 9–10 on 3 and rich content on 4.

| Anchor; section; TXT/DOCX anchor | Source prompt or material | Printed answer | Points; printed rubric | Association |
| --- | --- | --- | --- | --- |
| r01; S1; 5,6,7,8,9 | 1. Multiple choice: What is 2 + 3? | B | not supplied; not supplied | standalone |
| r02; S1; 11,12 | 2. True or false: Pure water freezes at 0 degrees Celsius under standard atmospheric pressure. | True | not supplied; not supplied | standalone |
| r03; S2; 16,17,18,19,20,21 | Multiple choice: Select all prime numbers below. | ["A","B"] | not supplied; not supplied | standalone |
| r04; S3; 25,26 | Fill in the blank: 12 + 8 = ____. | 20 | not supplied; not supplied | standalone |
| r05; S4; 30,31,32,33 | 1. 说明蒸发的含义。（5分） | 液体表面发生的汽化现象 | 5; 汽化3分，液体表面2分。 | standalone |
| r06; S4; 34,35 | 2. 写一句邀请朋友读书的英文句子。 | not supplied | not supplied; not supplied | standalone |
| r07; S5; 39,40 | Reading comprehension — Seasons: Snow is white. Grass is green. | material parent; no reference answer | not supplied; not supplied | parent of r08 |
| r08; S5; 41 | 1. True or false: Snow is white. | True | not supplied; not supplied | child of r07 |
| r09; S5; 43,44,45 | Word bank — Complete the sentence: Snow is [1]. Grass is [2]. | material parent; no reference answer | not supplied; not supplied | parent of r09-1,r09-2; owns options |
| r09-1; S5; 45 | Snow is [1]. | A | not supplied; not supplied | child of r09; shared options from r09 |
| r09-2; S5; 45 | Grass is [2]. | B | not supplied; not supplied | child of r09; shared options from r09 |
| r10; S5; 47,48 | Cloze — Complete the statement: Snow is [1]. | material parent; no reference answer | not supplied; not supplied | parent of r11 |
| r11; S5; 48 | 1: A. white B. green. | A | not supplied; not supplied | child of r10 |
| r12; S5; 50,51 | Ordering — Sort ascending | ["1","0"] | not supplied; not supplied | standalone |
| r13; S5; 53,54,55 | Matching — Match words and numbers (one-to-one) | [{"left":"0","right":"0"},{"left":"1","right":"1"}] | not supplied; not supplied | standalone |
| r14; S6; 59,60,61 | Listening: Train announcement | material parent; no reference answer | not supplied; not supplied | parent of r15 |
| r15; S6; 62,63,64,65 | 1. When does the train leave? | A | not supplied; not supplied | child of r14 |
| r16; S7; 69,70 | Grammar fill: Complete the sentence: She enjoys (1) ____ every day. | material parent; no reference answer | not supplied; not supplied | parent of r17 |
| r17; S7; 71,72 | Hint: read | reading | not supplied; not supplied | child of r16 |
| r18; S8; 76,77,78 | Sentence selection: Choose the missing sentence: The weather was warm. (1) ____ We returned before dinner. | material parent; no reference answer | not supplied; not supplied | parent of r19 |
| r19; S8; 79,80 | 1. Choose a sentence. | A | not supplied; not supplied | child of r18 |
| r20; S9; 84–90 | Paragraph matching: Match statements to paragraphs; left 1: This place opens early.; left 2: You can borrow books here.; right A/B: full supplied paragraphs | 1→A, 2→A | not supplied; not supplied | standalone many-to-one; four sided items, two matches |
| r23; S10; 94,95,96,97 | Translation: Translate the passage into English. (10 points) 阅读让我们了解不同的文化。 | Reading helps us understand different cultures. | 10; Preserve the meaning and use grammatical English. | standalone |
| r24; S10; 98,99,100,101,102 | Writing: Write an invitation to a reading club. (15 points) | not supplied | 15; Include the invitation, location and time. Assess clarity and grammatical accuracy. Do not invent extra requirements. | standalone |
| r25; S11; image104 / TXT106–116 | Using the supplied matrix A, what is its determinant? | The supplied determinant is -2. | not supplied; not supplied | standalone |

Supplied options and constraints remain part of the map: basic math A: 4 / B: 5 / C: 6; primes A: 2 / B: 3 / C: 4 / D: 9; word-bank parent options A: white / B: green with no reuse; child r09-1 supplies A and child r09-2 supplies B, both sharing the parent options; cloze child A: white / B: green; ordering IDs 0: Two / 1: One with printed order 1, 0; one-to-one matching One→1/Two→2 using printed IDs 0→0 / 1→1; listening A: Nine / B: Ten; sentence selection A: “We went for a walk.”, B: “The train was cancelled.”, C: “The shop was closed.” with each used once. Paragraph options are A: “The public library opens at seven. Members may borrow books for two weeks.” and B: “The sports centre opens at ten and closes at six.” Paragraph reuse is explicitly allowed (both statements→A), represented by many-to-one matching. Its `options` and `passage` are empty, with no parent or option-source reference; the contract’s word-bank-only `allowReuse` field remains false.

The listening parent says **listen twice** and supplies “The train leaves at nine.” as transcript, with **no audio file supplied**. Grammar child hint is “read”. Translation direction is Chinese→English. Writing asks for 80–120 English words, genre Invitation, friend Alex, the library, Saturday 10 a.m.; its supplied 15 point rubric covers invitation/location/time, clarity and grammar without extra requirements. No sample answer is supplied.

Only three leaves have supplied points/rubrics: evaporation 5, translation 10, writing 15. Evaporation has supplied analysis “蒸发发生在液体表面。” The rich question has supplied analysis “1 × 4 − 2 × 3 = −2” and explicitly printed answer “The supplied determinant is -2.” These were transcribed, not solved. Other absent analysis/points/rubrics remain absent; r06 has no answer, analysis, points or rubric.

## Rich content and figure association

The rich determinant question r25 owns the supplied matrix/inverse, integral and alternating sum, piecewise formula, four-column table and chart. DOCX paragraph 104 embeds the page image. XLSX Section 11 literal strings, `Data table!A1:D4`, and the `Rich source` image describe this same question, and must not become three questions. The embedded PNG in DOCX/XLSX shares SHA-256 `1ab39c378c580cd8b684bf8e9579fa071ee777218ee489662cb942fb648df391`.

The visually read matrix is A rows (1,2)/(3,4); the inverse has factor 1/−2 and rows (4,−2)/(−3,1). Supplied expressions include the integral from 0 to 1 of x²/√(1−x²), printed equality π/4, the alternating infinite sum, and the piecewise √(x+1)/(1+x²) for x≥0 and −x for x<0. The source provides these expressions; this review does not assess or derive their mathematical correctness.

The table has Sample/x_i/Error/Note columns and rows A:½/−0.002/“left | right”; B:10⁻⁶/0/“中文，空值用 —”; C:√2/+0.003/“final row”. The TXT/CSV linear A-row contains an unescaped internal pipe; native spreadsheet cells and the rendered table place “left | right” in one Note cell. Keep that ambiguity visible until a subject reviewer confirms the interpretation.

The actual chart has black axes, gray grid, blue curve, title y=x² on [0,5], x labels 0–5 and small caption. Numeric y-axis labels are absent. TXT/CSV/XLSX strings explicitly list (0,0),(1,1),(2,4),(3,9),(4,16),(5,25); the raster alone does not independently establish exact ordinates. Figure association is r25 at page/quadrant 4; dedicated chart-crop bounds are pending and whole-page/quadrant bounds must not be presented as an exact chart crop. Local resource names in source text do not grant importer filesystem authorization.

## Authorized legacy derivatives and limits

Fresh legacy conversion used current service source `095a33b0e55d613f0a934701cc2d2b2b3ef72416` with a read-only official archive SHA-256 `8858d8058da4f862f47559486814e65efc27294da67c5e4bb56b006b1ee59f89`, executable SHA-256 `820ce37c7f7f496f73516d932109b1254463b33a993ceae0cfbaabac62f164bf`, and observed identity `LibreOffice 26.8.0.3 bce0998afefdbc355585ca324285661a2170ba77`. Temporary child configuration only; no deployed-host Office configuration was added. Four direct service conversions produced 16 artifacts: DOC PDF/TXT, XLS PDF and 13 worksheet CSVs. No task or model call ran; the owned read-only mount was detached.

DOC PDF has four pages: Sections 1–4 and the first composite material on 1; ordering/matching and Sections 6–9 plus the start of Section 10 on 2; the rest of writing and the rich-page introduction on 3; full rich image on 4. DOC TXT retains Sections 1–10 and a rich-page placeholder but loses the rich image, formulas, table, chart, supplied answer and analysis. It is not a full 25 record text-fidelity pass.

XLS PDF has 16 pages: Sections 1–11 on 1–11, the native Data table on 12, the full rich image on 13; 14–16 have only headers/footers. Thirteen CSV outputs retain Sections 1–11 literal content and the four-column Data table; Rich source CSV has a placeholder only and omits its embedded picture. Repeated rich representations and blank pages add no questions. Conversion success does not establish full layout or figure fidelity.

The first two conversion-helper attempts failed before any conversion: one mount-alias assertion, then an omitted formats subdirectory. Both produced 0 conversions/tasks/models, preserved source hashes and detached the owned mount. They are retained engineering evidence, not conversion-product failures.

## Pending acceptance

DOCX rich formulas/table/chart are raster content: native OMML and Word table counts are 0. XLSX formula-cell and native-chart counts are 0; content cells are shared strings. Scanned PDF has 0 extracted text. Actual visual reading does not measure OCR accuracy or prove native equation/formula coverage. Existing fixture `confidence:1.0` and `needsReview:false` are not independently established quality claims.

A consenting subject reviewer still needs to verify every prompt, supplied answer, rubric, score, material relationship, formula/table/figure association and ambiguity. Live-model evaluation requires the separate explicit model/corpus/cost authorization, which remains denied. This draft changes no existing source, gold, quality worksheet, production deployment, user trial, physical-device, signing or release acceptance. See the [corpus instructions](../app/fixtures/ai-import/README.md) and [quality worksheet](import-quality-acceptance.md) for the existing gates.
