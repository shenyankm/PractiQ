export const PRACTICE_SNAPSHOT_IMMUTABILITY_TRIGGER_SQL = `
CREATE TRIGGER practice_session_question_snapshot_is_immutable
BEFORE UPDATE OF snapshot_json ON practice_session_questions
WHEN old.snapshot_json IS NOT new.snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'practice session question snapshot is immutable');
END;
`;

export const PRACTICE_SNAPSHOT_MEDIA_URIS_SQL = `
-- ponytail: scan immutable snapshots during rare file maintenance; re-index only after measured latency.
SELECT DISTINCT CAST(snapshot_node.value AS TEXT) AS uri
FROM practice_session_questions psq, json_tree(psq.snapshot_json) snapshot_node
WHERE snapshot_node.key IN ('uri', 'media_uri') AND snapshot_node.type = 'text'
`;

export const PRACTICE_SNAPSHOT_MEDIA_REFS_MIGRATION_SQL = `
CREATE TABLE practice_snapshot_media_refs (
  session_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  uri TEXT NOT NULL,
  PRIMARY KEY (session_id, question_id, uri),
  FOREIGN KEY (session_id, question_id)
    REFERENCES practice_session_questions(session_id, question_id) ON DELETE CASCADE
);
CREATE INDEX idx_snapshot_media_refs_uri ON practice_snapshot_media_refs(uri);
INSERT OR IGNORE INTO practice_snapshot_media_refs(session_id, question_id, uri)
SELECT psq.session_id, psq.question_id, CAST(snapshot_node.value AS TEXT)
FROM practice_session_questions psq, json_tree(psq.snapshot_json) snapshot_node
WHERE snapshot_node.key IN ('uri', 'media_uri') AND snapshot_node.type = 'text';
`;

export function remapPracticeSnapshotMediaUris(
  snapshotJson: string,
  destinations: ReadonlyMap<string, string>,
) {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(snapshotJson);
  } catch {
    throw new Error('练习快照 JSON 无法读取');
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('练习快照格式无效');
  }

  return JSON.stringify(snapshot, (key, value) => (
    (key === 'uri' || key === 'media_uri') && typeof value === 'string'
      ? destinations.get(value) ?? value
      : value
  ));
}

export const PRACTICE_SNAPSHOT_VIEW_SQL = `
CREATE VIEW practice_question_snapshot_source AS
SELECT
  bql.bank_id,
  q.id AS question_id,
  ak.id AS answer_key_id,
  json_object(
    'version', 1,
    'questionTypeCode', q.question_type_code,
    'typeName', qt.name,
    'stem', q.stem,
    'explanation', q.explanation,
    'answerJson', ak.answer_json,
    'options', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', option_row.id,
        'label', option_row.label,
        'content', option_row.content,
        'sort_order', option_row.sort_order,
        'media_json', json(COALESCE((
          SELECT json_group_array(json_object(
            'id', option_media.id,
            'file_name', option_media.file_name,
            'uri', option_media.uri,
            'mime_type', option_media.mime_type,
            'size', option_media.size,
            'width', option_media.width,
            'height', option_media.height,
            'duration', option_media.duration,
            'metadata_json', option_media.metadata_json,
            'sort_order', option_media.sort_order
          ))
          FROM (
            SELECT ma.id, ma.file_name, ma.uri, ma.mime_type, ma.size, ma.width, ma.height,
              ma.duration, ma.metadata_json, ml.sort_order
            FROM media_links ml
            JOIN media_assets ma ON ma.id = ml.media_asset_id
            WHERE ml.option_id = option_row.id
            ORDER BY ml.sort_order, ml.id
          ) option_media
        ), '[]'))
      ))
      FROM (
        SELECT id, label, content, sort_order
        FROM question_options
        WHERE question_id = q.id
        ORDER BY sort_order, id
      ) option_row
    ), '[]')),
    'blocks', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', question_block.id,
        'kind', question_block.kind,
        'content', question_block.content,
        'metadata_json', question_block.metadata_json,
        'media_asset_id', question_block.media_asset_id,
        'media_uri', question_block.media_uri,
        'media_mime_type', question_block.media_mime_type,
        'media_file_name', question_block.media_file_name,
        'sort_order', question_block.sort_order
      ))
      FROM (
        SELECT qcb.id, qcb.kind, qcb.content, qcb.metadata_json, qcb.media_asset_id,
          ma.uri AS media_uri, ma.mime_type AS media_mime_type, ma.file_name AS media_file_name,
          qcb.sort_order
        FROM question_content_blocks qcb
        LEFT JOIN media_assets ma ON ma.id = qcb.media_asset_id
        WHERE qcb.question_id = q.id
        ORDER BY qcb.sort_order, qcb.id
      ) question_block
    ), '[]')),
    'media', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', question_media.id,
        'file_name', question_media.file_name,
        'uri', question_media.uri,
        'mime_type', question_media.mime_type,
        'size', question_media.size,
        'width', question_media.width,
        'height', question_media.height,
        'duration', question_media.duration,
        'metadata_json', question_media.metadata_json,
        'sort_order', question_media.sort_order
      ))
      FROM (
        SELECT ma.id, ma.file_name, ma.uri, ma.mime_type, ma.size, ma.width, ma.height,
          ma.duration, ma.metadata_json, ml.sort_order
        FROM media_links ml
        JOIN media_assets ma ON ma.id = ml.media_asset_id
        WHERE ml.question_id = q.id
        ORDER BY ml.sort_order, ml.id
      ) question_media
    ), '[]')),
    'group', json((
      SELECT json_object(
        'id', qg.id,
        'stem', qg.stem,
        'explanation', qg.explanation,
        'blocks', json(COALESCE((
          SELECT json_group_array(json_object(
            'id', group_block.id,
            'kind', group_block.kind,
            'content', group_block.content,
            'metadata_json', group_block.metadata_json,
            'media_asset_id', group_block.media_asset_id,
            'media_uri', group_block.media_uri,
            'media_mime_type', group_block.media_mime_type,
            'media_file_name', group_block.media_file_name,
            'sort_order', group_block.sort_order
          ))
          FROM (
            SELECT qcb.id, qcb.kind, qcb.content, qcb.metadata_json, qcb.media_asset_id,
              ma.uri AS media_uri, ma.mime_type AS media_mime_type, ma.file_name AS media_file_name,
              qcb.sort_order
            FROM question_content_blocks qcb
            LEFT JOIN media_assets ma ON ma.id = qcb.media_asset_id
            WHERE qcb.group_id = qg.id
            ORDER BY qcb.sort_order, qcb.id
          ) group_block
        ), '[]')),
        'media', json(COALESCE((
          SELECT json_group_array(json_object(
            'id', group_media.id,
            'file_name', group_media.file_name,
            'uri', group_media.uri,
            'mime_type', group_media.mime_type,
            'size', group_media.size,
            'width', group_media.width,
            'height', group_media.height,
            'duration', group_media.duration,
            'metadata_json', group_media.metadata_json,
            'sort_order', group_media.sort_order
          ))
          FROM (
            SELECT ma.id, ma.file_name, ma.uri, ma.mime_type, ma.size, ma.width, ma.height,
              ma.duration, ma.metadata_json, ml.sort_order
            FROM media_links ml
            JOIN media_assets ma ON ma.id = ml.media_asset_id
            WHERE ml.group_id = qg.id
            ORDER BY ml.sort_order, ml.id
          ) group_media
        ), '[]'))
      )
      FROM group_question_links gql
      JOIN question_groups qg ON qg.id = gql.group_id AND qg.status = 'active'
      JOIN bank_group_links bgl ON bgl.group_id = qg.id AND bgl.bank_id = bql.bank_id
      WHERE gql.question_id = q.id
      ORDER BY bgl.sort_order, gql.sort_order, qg.id
      LIMIT 1
    ))
  ) AS snapshot_json
FROM questions q
JOIN question_types qt ON qt.code = q.question_type_code
JOIN question_answer_keys ak ON ak.question_id = q.id
JOIN bank_question_links bql ON bql.question_id = q.id;
`;

const PRACTICE_SNAPSHOT_VIEW_V6_SQL = PRACTICE_SNAPSHOT_VIEW_SQL.replace(
  'ORDER BY bgl.sort_order, gql.sort_order, qg.id',
  'ORDER BY gql.sort_order, qg.id',
);

export const PRACTICE_SNAPSHOT_MIGRATION_SQL = `
ALTER TABLE practice_session_questions
ADD COLUMN snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json));

${PRACTICE_SNAPSHOT_VIEW_V6_SQL}

UPDATE practice_session_questions AS psq
SET snapshot_json = (
  SELECT source.snapshot_json
  FROM practice_question_snapshot_source source
  WHERE source.question_id = psq.question_id
    AND source.answer_key_id = psq.answer_key_id
    AND source.bank_id = (SELECT bank_id FROM practice_sessions WHERE id = psq.session_id)
)
WHERE snapshot_json IS NULL;

CREATE TRIGGER practice_session_question_requires_snapshot
BEFORE INSERT ON practice_session_questions
WHEN new.snapshot_json IS NULL OR json_type(new.snapshot_json) <> 'object'
BEGIN
  SELECT RAISE(ABORT, 'practice session question requires a snapshot');
END;

${PRACTICE_SNAPSHOT_IMMUTABILITY_TRIGGER_SQL}
`;

export const PRACTICE_SESSION_QUESTIONS_SQL = `
SELECT
  psq.question_id AS id,
  psq.position,
  json_extract(psq.snapshot_json, '$.questionTypeCode') AS question_type_code,
  json_extract(psq.snapshot_json, '$.typeName') AS type_name,
  json_extract(psq.snapshot_json, '$.stem') AS stem,
  json_extract(psq.snapshot_json, '$.explanation') AS explanation,
  psq.max_score,
  json_extract(psq.snapshot_json, '$.answerJson') AS answer_json,
  COALESCE(json_extract(psq.snapshot_json, '$.options'), '[]') AS options_json,
  qa.answer_json AS submitted_answer_json,
  qa.is_correct,
  qa.score AS earned_score,
  qa.feedback,
  json_extract(psq.snapshot_json, '$.group.stem') AS group_stem,
  COALESCE(json_extract(psq.snapshot_json, '$.blocks'), '[]') AS blocks_json,
  COALESCE(json_extract(psq.snapshot_json, '$.media'), '[]') AS media_json,
  COALESCE(json_extract(psq.snapshot_json, '$.group.blocks'), '[]') AS group_blocks_json,
  COALESCE(json_extract(psq.snapshot_json, '$.group.media'), '[]') AS group_media_json
FROM practice_session_questions psq
LEFT JOIN question_answers qa
  ON qa.session_id = psq.session_id AND qa.question_id = psq.question_id
WHERE psq.session_id = ?
ORDER BY psq.position`;
