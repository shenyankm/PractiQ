-- Purpose: Define group-member learning analytics views for group owners and admins.
-- PostgreSQL-only schema fragment. Apply after earlier numbered fragments in db/*/*.sql order.

-- Purpose: expose group-member learning analytics for group owners/admins.

CREATE VIEW study_group_member_bank_learning_stats AS
SELECT
    sgm.group_id,
    sgbl.bank_id,
    sgm.user_id AS member_user_id,
    u.username AS member_username,
    sgm.role AS member_role,
    COALESCE(ubs.completed_count, 0)::INTEGER AS completed_count,
    COALESCE(ubs.wrong_count, 0)::INTEGER AS wrong_count,
    ubs.last_practiced_at,
    COUNT(DISTINCT bql.question_id)::INTEGER AS active_question_count,
    COUNT(uqs.id)::INTEGER AS tracked_question_count,
    COALESCE(SUM(uqs.attempt_count), 0)::INTEGER AS attempt_count,
    COALESCE(SUM(uqs.correct_count), 0)::INTEGER AS correct_count,
    COALESCE(SUM(uqs.wrong_count), 0)::INTEGER AS question_wrong_count,
    AVG(uqs.mastery_score) FILTER (WHERE uqs.mastery_score IS NOT NULL) AS avg_mastery_score,
    MAX(uqs.last_answered_at) AS last_answered_at
FROM study_group_members sgm
JOIN users u ON u.id = sgm.user_id
JOIN study_group_bank_links sgbl ON sgbl.group_id = sgm.group_id
LEFT JOIN user_bank_stats ubs
  ON ubs.user_id = sgm.user_id
 AND ubs.bank_id = sgbl.bank_id
LEFT JOIN bank_question_links bql
  ON bql.bank_id = sgbl.bank_id
 AND bql.status = 'active'
LEFT JOIN user_question_stats uqs
  ON uqs.user_id = sgm.user_id
 AND uqs.question_id = bql.question_id
WHERE sgm.status = 'active'
GROUP BY
    sgm.group_id,
    sgbl.bank_id,
    sgm.user_id,
    u.username,
    sgm.role,
    ubs.completed_count,
    ubs.wrong_count,
    ubs.last_practiced_at;


CREATE OR REPLACE FUNCTION study_group_member_bank_learning_stats_for_bank(
    p_group_id BIGINT,
    p_bank_id BIGINT
)
RETURNS SETOF study_group_member_bank_learning_stats
LANGUAGE sql
STABLE
AS $$
    SELECT *
    FROM study_group_member_bank_learning_stats
    WHERE group_id = p_group_id
      AND bank_id = p_bank_id;
$$;