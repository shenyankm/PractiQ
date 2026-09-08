package com.practiq.service;

import com.practiq.common.ApiException;
import org.springframework.jdbc.core.JdbcTemplate;

/** Current content permissions. SQL arguments below are server-owned expressions, never request text. */
public final class ContentAccess {
  private final JdbcTemplate db;
  public ContentAccess(JdbcTemplate db) { this.db = db; }

  public static String bankVisible(String bank, long user) {
    return bank + ".deleted_at is null and " + bank + ".status<>'banned' and (" + bank + ".owner_user_id=" + user + " or " + bank + ".status='public' or exists(select 1 from study_group_banks asb join study_group_members am on am.group_id=asb.group_id where asb.bank_id=" + bank + ".id and am.user_id=" + user + " and am.status='accepted'))";
  }
  public static String answerVisible(String answer, long user) {
    return "exists(select 1 from practice_sessions aps where aps.id=" + answer + ".session_id and (aps.mode<>'exam' or aps.status='completed')) and " + questionInBank(answer + ".bank_id", answer + ".question_id", user, true);
  }
  public static String questionInBank(String bank, String question, long user, boolean activeOnly) {
    String owner = activeOnly ? "false" : "ab.owner_user_id=" + user;
    return "exists(select 1 from question_banks ab join questions aq on aq.id=" + question + " where ab.id=" + bank + " and " + bankVisible("ab", user) + " and (" + owner + " or aq.status='active') and (exists(select 1 from bank_question_links al where al.bank_id=ab.id and al.question_id=aq.id and (" + owner + " or al.status='active')) or exists(select 1 from bank_group_links al join question_groups ag on ag.id=al.group_id join group_question_links aqg on aqg.group_id=ag.id where al.bank_id=ab.id and aqg.question_id=aq.id and (" + owner + " or (al.status='active' and ag.status='active')))))";
  }
  public static String questionVisible(String question, long user) {
    return "exists(select 1 from question_banks avb where " + questionInBank("avb.id", question, user, false) + ")";
  }
  public static String questionReadable(String question, long user) {
    return "(" + questionVisible(question, user) + " or exists(select 1 from questions orphan where orphan.id=" + question + " and orphan.owner_user_id=" + user + " and orphan.status='draft' and " + questionUnlinked("orphan.id") + "))";
  }
  public static String groupReadable(String group, long user) {
    return "(" + groupVisible(group, user) + " or exists(select 1 from question_groups orphan where orphan.id=" + group + " and orphan.owner_user_id=" + user + " and orphan.status='draft' and " + groupUnlinked("orphan.id") + "))";
  }
  public static String groupVisible(String group, long user) {
    return "exists(select 1 from bank_group_links al join question_banks ab on ab.id=al.bank_id join question_groups ag on ag.id=al.group_id where al.group_id=" + group + " and " + bankVisible("ab", user) + " and (ab.owner_user_id=" + user + " or (al.status='active' and ag.status='active')))";
  }
  public static String questionUnlinked(String question) {
    return "not exists(select 1 from bank_question_links where question_id=" + question + ") and not exists(select 1 from group_question_links g join bank_group_links b on b.group_id=g.group_id where g.question_id=" + question + ")";
  }
  public static String groupUnlinked(String group) { return "not exists(select 1 from bank_group_links where group_id=" + group + ")"; }
  public void bank(long user, long bank) { require("select exists(select 1 from question_banks b where b.id=? and " + bankVisible("b", user) + ")", bank); }
  public void question(long user, long question) {
    require("select exists(select 1 from questions q where q.id=? and (" + questionVisible("q.id", user) + " or (q.owner_user_id=" + user + " and q.status='draft' and " + questionUnlinked("q.id") + ")))", question);
  }
  public void group(long user, long group) {
    require("select exists(select 1 from question_groups g where g.id=? and (" + groupVisible("g.id", user) + " or (g.owner_user_id=" + user + " and g.status='draft' and " + groupUnlinked("g.id") + ")))", group);
  }
  public void editQuestion(long user, long question) { question(user, question); require("select exists(select 1 from questions where id=? and owner_user_id=?)", question, user); }
  public void editGroup(long user, long group) { group(user, group); require("select exists(select 1 from question_groups where id=? and owner_user_id=?)", group, user); }
  public void session(long user, long session) {
    require("select exists(select 1 from practice_sessions s join question_banks b on b.id=s.bank_id where s.id=? and s.user_id=? and " + bankVisible("b", user) + " and not exists(select 1 from practice_session_questions sq where sq.session_id=s.id and not (" + questionInBank("s.bank_id", "sq.question_id", user, true) + ")))", session, user);
  }
  public void task(long user, long id) {
    var tasks = db.queryForList("select kind,source_question_id from ai_tasks where id=? and user_id=?", id, user);
    if (tasks.isEmpty()) throw inaccessibleTask();
    var task = tasks.getFirst();
    switch (String.valueOf(task.get("kind"))) {
      case "answer_generation" -> {
        if (!(task.get("source_question_id") instanceof Number question)) throw inaccessibleTask();
        editQuestion(user, question.longValue());
      }
      case "learning_report" -> {
        require("select exists(select 1 from ai_report_sources where task_id=?) and not exists(select 1 from ai_report_sources src where src.task_id=? and not (" + questionInBank("src.bank_id", "src.question_id", user, true) + "))", id, id);
      }
      case "import" -> {
        var banks = db.queryForList("select bank_id from question_import_jobs where ai_task_id=? and created_by=?", Long.class, id, user);
        if (banks.isEmpty()) throw inaccessibleTask();
        bank(user, banks.getFirst());
      }
      default -> throw inaccessibleTask();
    }
  }
  private ApiException inaccessibleTask() { return ApiException.of(404, "NOT_FOUND", "AI task sources are no longer accessible"); }
  private void require(String sql, Object... args) { if (!Boolean.TRUE.equals(db.queryForObject(sql, Boolean.class, args))) throw ApiException.of(404, "NOT_FOUND", "Content is no longer accessible"); }
}
