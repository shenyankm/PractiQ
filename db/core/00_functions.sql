-- Purpose: Define shared PostgreSQL trigger functions used by later schema objects.
-- PostgreSQL-only schema fragment. Apply after earlier numbered fragments in db/*/*.sql order.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_bank_question_link_subjects()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    SELECT subject INTO NEW.bank_subject
    FROM question_banks
    WHERE id = NEW.bank_id;

    SELECT subject_id INTO NEW.question_subject_id
    FROM questions
    WHERE id = NEW.question_id;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_bank_group_link_subjects()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    SELECT subject INTO NEW.bank_subject
    FROM question_banks
    WHERE id = NEW.bank_id;

    SELECT subject_id INTO NEW.group_subject_id
    FROM question_groups
    WHERE id = NEW.group_id;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_question_knowledge_point_link_subjects()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    SELECT subject_id INTO NEW.question_subject_id
    FROM questions
    WHERE id = NEW.question_id;

    SELECT subject_id INTO NEW.knowledge_point_subject_id
    FROM knowledge_points
    WHERE id = NEW.knowledge_point_id;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_group_question_link_subjects()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    SELECT subject_id INTO NEW.group_subject_id
    FROM question_groups
    WHERE id = NEW.group_id;

    SELECT subject_id INTO NEW.question_subject_id
    FROM questions
    WHERE id = NEW.question_id;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION apply_user_question_answer_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO user_question_stats (
        user_id,
        question_id,
        attempt_count,
        correct_count,
        wrong_count,
        last_answer_id,
        last_answered_at,
        last_is_correct,
        mastery_score
    )
    VALUES (
        NEW.user_id,
        NEW.question_id,
        1,
        CASE WHEN NEW.is_correct IS TRUE THEN 1 ELSE 0 END,
        CASE WHEN NEW.is_correct IS FALSE THEN 1 ELSE 0 END,
        NEW.id,
        NEW.answered_at,
        NEW.is_correct,
        CASE
            WHEN NEW.is_correct IS TRUE THEN 1
            WHEN NEW.is_correct IS FALSE THEN 0
            ELSE NULL
        END
    )
    ON CONFLICT (user_id, question_id) DO UPDATE SET
        attempt_count = user_question_stats.attempt_count + 1,
        correct_count = user_question_stats.correct_count + CASE WHEN NEW.is_correct IS TRUE THEN 1 ELSE 0 END,
        wrong_count = user_question_stats.wrong_count + CASE WHEN NEW.is_correct IS FALSE THEN 1 ELSE 0 END,
        last_answer_id = NEW.id,
        last_answered_at = NEW.answered_at,
        last_is_correct = NEW.is_correct,
        mastery_score = CASE
            WHEN (user_question_stats.attempt_count + 1) > 0
            THEN (
                user_question_stats.correct_count + CASE WHEN NEW.is_correct IS TRUE THEN 1 ELSE 0 END
            )::DOUBLE PRECISION / (user_question_stats.attempt_count + 1)
            ELSE NULL
        END,
        updated_at = NOW();

    IF NEW.bank_id IS NOT NULL THEN
        INSERT INTO user_bank_stats (
            user_id,
            bank_id,
            completed_count,
            wrong_count,
            last_practiced_at
        )
        VALUES (
            NEW.user_id,
            NEW.bank_id,
            1,
            CASE WHEN NEW.is_correct IS FALSE THEN 1 ELSE 0 END,
            NEW.answered_at
        )
        ON CONFLICT (user_id, bank_id) DO UPDATE SET
            completed_count = user_bank_stats.completed_count + 1,
            wrong_count = user_bank_stats.wrong_count + CASE WHEN NEW.is_correct IS FALSE THEN 1 ELSE 0 END,
            last_practiced_at = NEW.answered_at,
            updated_at = NOW();
    END IF;

    IF NEW.session_id IS NOT NULL THEN
        UPDATE user_practice_sessions
        SET
            answered_count = answered_count + 1,
            correct_count = correct_count + CASE WHEN NEW.is_correct IS TRUE THEN 1 ELSE 0 END,
            wrong_count = wrong_count + CASE WHEN NEW.is_correct IS FALSE THEN 1 ELSE 0 END,
            updated_at = NOW()
        WHERE id = NEW.session_id
          AND user_id = NEW.user_id;
    END IF;

    RETURN NEW;
END;
$$;
