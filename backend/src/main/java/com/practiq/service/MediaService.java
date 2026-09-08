package com.practiq.service;

import com.practiq.common.ApiException;
import java.io.IOException;
import java.nio.file.*;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

@Service
public class MediaService {
  private final JdbcTemplate db; private final String mount;
  public MediaService(JdbcTemplate db, @Value("${practiq.object-storage-mount-dir}") String mount) { this.db = db; this.mount = mount; }
  private Map<String, Object> row(ResultSet result, int number) throws java.sql.SQLException { var value = new LinkedHashMap<String, Object>(); for (int i = 1; i <= result.getMetaData().getColumnCount(); i++) value.put(result.getMetaData().getColumnLabel(i), result.getObject(i)); return value; }
  private void editableQuestion(long user, long question) { new ContentAccess(db).editQuestion(user, question); }
  private void editableGroup(long user, long group) { new ContentAccess(db).editGroup(user, group); }
  private void owned(long user, long media) { if (db.queryForObject("select count(*) from media_assets where id=? and created_by=? and deleted_at is null", Integer.class, media, user) == 0) throw ApiException.of(403, "FORBIDDEN", "Media owner access required"); }
  @Transactional public Map<String, Object> upload(long user, MultipartFile file) {
    if (file == null) throw ApiException.of(400, "FILE_REQUIRED", "Upload file is required"); byte[] bytes;
    try { bytes = file.getBytes(); } catch (IOException error) { throw ApiException.of(400, "INVALID_FILE_CONTENT", "Could not read upload"); }
    if (bytes.length == 0) throw ApiException.of(400, "EMPTY_FILE", "Upload file is empty"); if (bytes.length > UploadSupport.MEDIA_MAX) throw ApiException.of(413, "FILE_TOO_LARGE", "Media file exceeds 10 MiB");
    String name = Optional.ofNullable(file.getOriginalFilename()).orElse("").replace('\\', '/'); name = name.substring(name.lastIndexOf('/') + 1);
    if (name.isBlank() || name.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 255) throw ApiException.of(400, "INVALID_FILE_NAME", "Media file name must be 1-255 bytes");
    String mime = UploadSupport.imageMime(bytes); String extension = switch (mime) { case "image/png" -> ".png"; case "image/jpeg" -> ".jpg"; case "image/gif" -> ".gif"; case "image/webp" -> ".webp"; default -> throw ApiException.of(400, "UNSUPPORTED_FILE_TYPE", "Only PNG, JPEG, GIF, and WebP images are supported"); };
    String relative = "media/" + user + "/" + UploadSupport.token() + extension; Path path = UploadSupport.path(mount, relative);
    try { Files.createDirectories(path.getParent()); Files.write(path, bytes, StandardOpenOption.CREATE_NEW); } catch (IOException error) { throw ApiException.of(500, "MEDIA_STORAGE_FAILED", "Could not store media"); }
    try { return db.query("insert into media_assets(created_by,storage_path,original_name,media_type,mime_type,size_bytes,checksum_sha256) values(?,?,?,'image',?,?,?) returning id,created_by,original_name,media_type,mime_type,width,height,size_bytes,duration_ms,created_at", this::row, user, relative, name, mime, bytes.length, sha256(bytes)).getFirst(); } catch (RuntimeException error) { try { Files.deleteIfExists(path); } catch (IOException ignored) {} throw error; }
  }
  public Map<String, Object> asset(long user, String role, long id) {
    var rows = db.query("select id,created_by,storage_path,original_name,media_type,mime_type,width,height,size_bytes,duration_ms,created_at from media_assets m where id=? and deleted_at is null and (" +
        "(created_by=? and not exists(select 1 from question_media_links where media_id=m.id) and not exists(select 1 from question_option_media_links where media_id=m.id) and not exists(select 1 from question_group_media_links where media_id=m.id)) or " +
        "exists(select 1 from question_media_links l where l.media_id=m.id and " + ContentAccess.questionReadable("l.question_id", user) + ") or " +
        "exists(select 1 from question_option_media_links l join question_options o on o.id=l.option_id where l.media_id=m.id and " + ContentAccess.questionReadable("o.question_id", user) + ") or " +
        "exists(select 1 from question_group_media_links l where l.media_id=m.id and " + ContentAccess.groupReadable("l.group_id", user) + "))", this::row, id, user);
    if (rows.isEmpty()) throw ApiException.of(404, "NOT_FOUND", "Media asset not found"); var value = rows.getFirst(); value.put("content_url", "/api/v1/media/" + id + "/content"); value.remove("storage_path"); return value;
  }
  public byte[] content(long user, String role, long id) { asset(user, role, id); String relative = db.queryForObject("select storage_path from media_assets where id=? and deleted_at is null", String.class, id); try { return Files.readAllBytes(UploadSupport.path(mount, relative)); } catch (NoSuchFileException error) { throw ApiException.of(404, "MEDIA_CONTENT_NOT_FOUND", "Media content not found"); } catch (IOException error) { throw ApiException.of(500, "MEDIA_STORAGE_FAILED", "Could not read media"); } }
  @Transactional public void delete(long user, String role, long id) { if (!"admin".equals(role)) throw ApiException.of(403, "ADMIN_REQUIRED", "Administrator privileges required"); var rows = db.query("update media_assets set deleted_at=now() where id=? and deleted_at is null returning storage_path", this::row, id); if (rows.isEmpty()) throw ApiException.of(404, "NOT_FOUND", "Media asset not found"); try { Files.deleteIfExists(UploadSupport.path(mount, (String) rows.getFirst().get("storage_path"))); } catch (IOException ignored) {} }
  @Transactional public Map<String, Object> link(long user, String type, long owner, long media, String ignoredKind, Integer order) { if (type.equals("question")) editableQuestion(user, owner); else if (type.equals("group")) editableGroup(user, owner); else { Long question = db.queryForObject("select question_id from question_options where id=?", Long.class, owner); if (question == null) throw ApiException.of(404, "NOT_FOUND", "Option not found"); editableQuestion(user, question); } owned(user, media); asset(user, "user", media); int position = order == null ? 1 : order; if (position < 1 || position > 32767) throw ApiException.of(422, "VALIDATION_ERROR", "Invalid request"); String table = type.equals("question") ? "question_media_links" : type.equals("group") ? "question_group_media_links" : "question_option_media_links"; String column = type.equals("question") ? "question_id" : type.equals("group") ? "group_id" : "option_id"; return db.query("insert into " + table + "(" + column + ",media_id,sort_order) values(?,?,?) returning *", this::row, owner, media, position).getFirst(); }
  @Transactional public void unlink(long user, String type, long owner, long media) { if (type.equals("question")) editableQuestion(user, owner); else if (type.equals("group")) editableGroup(user, owner); else { Long question = db.queryForObject("select question_id from question_options where id=?", Long.class, owner); if (question == null) throw ApiException.of(404, "NOT_FOUND", "Option not found"); editableQuestion(user, question); } String table = type.equals("question") ? "question_media_links" : type.equals("group") ? "question_group_media_links" : "question_option_media_links"; String column = type.equals("question") ? "question_id" : type.equals("group") ? "group_id" : "option_id"; if (db.update("delete from " + table + " where " + column + "=? and media_id=?", owner, media) == 0) throw ApiException.of(404, "NOT_FOUND", "Media link not found"); }
  private static String sha256(byte[] bytes) { try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); } catch (Exception error) { throw new IllegalStateException(error); } }
}
