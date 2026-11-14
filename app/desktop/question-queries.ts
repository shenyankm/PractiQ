import { contractSource } from "./contract-source.js";
const COMPOSITE_SQL = contractSource.metadata.compositeModes.map(mode => `'${mode}'`).join(",");
// Keep schema-11 query ordering, eligibility, and search semantics consistent across runtimes.
const SEARCH_NODES = `
        WITH RECURSIVE tree(root,id) AS (
            SELECT q.id,q.id FROM questions q LEFT JOIN choice_questions c ON c.question_id=q.id
            WHERE q.id IN (SELECT value FROM json_each(?1)) AND (
                json_array_length(?4)=0 OR EXISTS(SELECT 1 FROM json_each(?4) m WHERE
                    COALESCE(CASE WHEN q.question_kind IS NOT NULL THEN q.question_kind WHEN q.mode='gap_fill' THEN 'grammar_fill' WHEN q.mode='choice' THEN c.variant ELSE q.mode END,'')=m.value OR
                    (m.value='choice' AND q.mode='choice') OR (q.mode='choice' AND c.variant=m.value))
            )
            UNION ALL SELECT t.root,q.id FROM questions q JOIN tree t ON q.parent_id=t.id
        ), eligible AS (
            SELECT t.root,q.id,q.bank_id,q.mode FROM tree t JOIN questions q ON q.id=t.id
            WHERE (?3='[]' OR q.bank_id IN (SELECT value FROM json_each(?3))) AND (
                ?2 IN ('','review') OR (?2='favorite' AND q.favorite=1) OR
                (?2='wrong' AND (SELECT result FROM attempts WHERE question_id=q.id AND result IS NOT NULL ORDER BY submitted_at DESC,rowid DESC LIMIT 1)=0) OR
                (?2='unattempted' AND (q.mode IS NULL OR q.mode NOT IN (${COMPOSITE_SQL})) AND NOT EXISTS(SELECT 1 FROM attempts WHERE question_id=q.id AND submitted_at IS NOT NULL AND skipped=0))
            )
        ), nodes(root,id,bank_id,mode) AS (
            SELECT root,id,bank_id,mode FROM eligible
            UNION SELECT n.root,q.id,q.bank_id,q.mode FROM nodes n
                JOIN questions child ON child.id=n.id JOIN questions q ON q.id=child.parent_id
                WHERE ?2 IN ('wrong','unattempted') AND (?3='[]' OR q.bank_id IN (SELECT value FROM json_each(?3)))
        )
    `;
export const SEARCH_BASE = SEARCH_NODES + ` SELECT n.root,q.stem,q.instructions,q.analysis,q.source_text,q.scoring_rubric,q.score_source_text,q.content_blocks FROM nodes n JOIN questions q ON q.id=n.id`;
export const SEARCH_DETAILS = SEARCH_NODES + `
            SELECT n.root,d.correct,2 FROM nodes n JOIN choice_questions d ON d.question_id=n.id WHERE n.mode='choice'
            UNION ALL SELECT n.root,d.value,2 FROM nodes n JOIN true_false_questions d ON d.question_id=n.id WHERE n.mode='true_false'
            UNION ALL SELECT n.root,d.answers,2 FROM nodes n JOIN fill_blank_questions d ON d.question_id=n.id WHERE n.mode='fill_blank'
            UNION ALL SELECT n.root,d.answer,2 FROM nodes n JOIN short_answer_questions d ON d.question_id=n.id WHERE n.mode='short_answer'
            UNION ALL SELECT n.root,d.answer_order,2 FROM nodes n JOIN ordering_questions d ON d.question_id=n.id WHERE n.mode='ordering'
            UNION ALL SELECT n.root,d.matches,2 FROM nodes n JOIN matching_questions d ON d.question_id=n.id WHERE n.mode='matching'
            UNION ALL SELECT n.root,d.passage,1 FROM nodes n JOIN reading_questions d ON d.question_id=n.id WHERE n.mode='reading'
            UNION ALL SELECT n.root,d.passage,1 FROM nodes n JOIN word_bank_questions d ON d.question_id=n.id WHERE n.mode='word_bank'
            UNION ALL SELECT n.root,d.passage,1 FROM nodes n JOIN cloze_questions d ON d.question_id=n.id WHERE n.mode='cloze'
            UNION ALL SELECT n.root,d.passage,1 FROM nodes n JOIN gap_fill_questions d ON d.question_id=n.id WHERE n.mode='gap_fill'
            UNION ALL SELECT n.root,d.passage,1 FROM nodes n JOIN listening_questions d ON d.question_id=n.id WHERE n.mode='listening'
            UNION ALL SELECT n.root,d.transcript,1 FROM nodes n JOIN listening_questions d ON d.question_id=n.id WHERE n.mode='listening'
            UNION ALL SELECT n.root,o.label,0 FROM nodes n JOIN question_options o ON o.owner_id=n.id LEFT JOIN choice_questions c ON c.question_id=n.id WHERE n.mode IS NOT 'choice' OR c.option_set_id=n.id
            UNION ALL SELECT n.root,o.content,0 FROM nodes n JOIN question_options o ON o.owner_id=n.id LEFT JOIN choice_questions c ON c.question_id=n.id WHERE n.mode IS NOT 'choice' OR c.option_set_id=n.id
            UNION ALL SELECT n.root,i.label,0 FROM nodes n JOIN question_items i ON i.question_id=n.id
            UNION ALL SELECT n.root,i.content,0 FROM nodes n JOIN question_items i ON i.question_id=n.id
            UNION ALL SELECT n.root,s.title,0 FROM nodes n JOIN section_questions r ON r.question_id=n.id JOIN sections s ON s.id=r.section_id
            UNION ALL SELECT n.root,s.instructions,0 FROM nodes n JOIN section_questions r ON r.question_id=n.id JOIN sections s ON s.id=r.section_id
        `;
export const SEARCH_VISUALS = SEARCH_NODES + `
            SELECT v.id,v.content FROM visuals v
            WHERE json_type(v.content,'$.documentOnly') IS NOT 'true'
            AND EXISTS(SELECT 1 FROM nodes n WHERE n.bank_id=v.bank_id AND
                (v.document_level=1 OR EXISTS(SELECT 1 FROM question_visuals r WHERE r.visual_id=v.id AND r.question_id=n.id)))
        `;
export const SEARCH_VISUAL_ROOTS = SEARCH_NODES + `
                SELECT DISTINCT n.root FROM nodes n JOIN visuals v ON v.bank_id=n.bank_id
                AND v.id IN (SELECT value FROM json_each(?5))
                AND (v.document_level=1 OR EXISTS(SELECT 1 FROM question_visuals r WHERE r.visual_id=v.id AND r.question_id=n.id))
            `;
export const ROOT_SUMMARIES = `
        WITH RECURSIVE tree(root,id) AS (
            SELECT value,value FROM json_each(?1)
            UNION ALL SELECT t.root,q.id FROM questions q JOIN tree t ON q.parent_id=t.id
        ), flags AS (
            SELECT t.root,SUM(n.mode IS NULL OR n.mode NOT IN (${COMPOSITE_SQL})) AS count,
                MAX(n.favorite) AS favorite,
                MAX(n.needs_review=1 AND review.question_id IS NULL) AS review,
                MAX(COALESCE(a.result=0,0)) AS wrong,
                MAX(COALESCE(a.result=0 AND a.earned_cents>0 AND a.earned_cents<a.max_cents,0)) AS partial
            FROM tree t CROSS JOIN questions n ON n.id=t.id
            LEFT JOIN question_reviews review ON review.question_id=n.id
            LEFT JOIN attempts a ON a.rowid=(SELECT rowid FROM attempts WHERE question_id=n.id AND result IS NOT NULL ORDER BY submitted_at DESC,rowid DESC LIMIT 1)
            GROUP BY t.root
        ) SELECT q.id,q.bank_id,b.title,substr(q.stem,1,200),substr(q.source_text,1,200),q.mode,q.question_kind,c.variant,
            f.count,f.favorite,f.review,f.wrong,f.partial,
            a.earned_cents,a.max_cents,a.grade_kind
        FROM questions q JOIN banks b ON b.id=q.bank_id JOIN flags f ON f.root=q.id
        LEFT JOIN choice_questions c ON c.question_id=q.id
        LEFT JOIN attempts a ON a.rowid=(SELECT rowid FROM attempts WHERE question_id=q.id AND result IS NOT NULL ORDER BY submitted_at DESC,rowid DESC LIMIT 1)
        ORDER BY b.created_at DESC,q.position,q.id
    `;
export const ROOT_METADATA = `
        WITH RECURSIVE tree(root,id) AS (
            SELECT value,value FROM json_each(?1)
            UNION ALL SELECT t.root,q.id FROM questions q JOIN tree t ON q.parent_id=t.id
        ) SELECT t.root,
            COALESCE(CASE WHEN r.question_kind IS NOT NULL THEN r.question_kind WHEN r.mode='gap_fill' THEN 'grammar_fill' WHEN r.mode='choice' THEN c.variant ELSE r.mode END,''),
            SUM(n.mode IS NULL OR n.mode NOT IN (${COMPOSITE_SQL}))
        FROM tree t CROSS JOIN questions r ON r.id=t.root CROSS JOIN questions n ON n.id=t.id
        LEFT JOIN choice_questions c ON c.question_id=r.id GROUP BY t.root
    `;
