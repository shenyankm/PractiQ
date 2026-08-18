package com.practiq.service;

import com.practiq.common.ApiException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.Locale;

/** File validation and mount-bound storage shared by media and import endpoints. */
public final class UploadSupport {
  public static final long MEDIA_MAX = 10L * 1024 * 1024, IMPORT_MAX = 25L * 1024 * 1024;
  private static final SecureRandom RANDOM = new SecureRandom();
  private UploadSupport() {}
  public static String imageMime(byte[] bytes) {
    if (starts(bytes, new byte[]{(byte)137,80,78,71,13,10,26,10})) return "image/png";
    if (starts(bytes, new byte[]{(byte)255,(byte)216,(byte)255})) return "image/jpeg";
    if (starts(bytes, "GIF87a".getBytes()) || starts(bytes, "GIF89a".getBytes())) return "image/gif";
    if (bytes.length >= 12 && starts(bytes, "RIFF".getBytes()) && bytes[8]=='W' && bytes[9]=='E' && bytes[10]=='B' && bytes[11]=='P') return "image/webp";
    return "";
  }
  public static String extension(String name, String contentType) {
    String n = name == null ? "" : name.trim().toLowerCase(Locale.ROOT);
    int dot = n.lastIndexOf('.'); String ext = dot >= 0 ? n.substring(dot) : "";
    if (switch (ext) { case ".txt", ".md", ".csv", ".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".gif", ".webp" -> true; default -> false; }) return ext;
    return switch (contentType == null ? "" : contentType.toLowerCase(Locale.ROOT)) {
      case "text/plain" -> ".txt"; case "text/markdown", "text/x-markdown" -> ".md"; case "text/csv" -> ".csv";
      case "application/pdf" -> ".pdf";
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document" -> ".docx";
      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" -> ".xlsx";
      case "image/png" -> ".png"; case "image/jpeg" -> ".jpg"; case "image/gif" -> ".gif"; case "image/webp" -> ".webp";
      default -> throw ApiException.of(400,"UNSUPPORTED_FILE_TYPE","Unsupported file type: " + name);
    };
  }
  public static String sourceType(String ext) { return switch(ext) { case ".txt" -> "txt"; case ".md" -> "md"; case ".csv" -> "csv"; case ".pdf" -> "pdf"; case ".docx" -> "docx"; case ".xlsx" -> "xlsx"; case ".png", ".jpg", ".jpeg", ".gif", ".webp" -> "image"; default -> throw ApiException.of(400,"UNSUPPORTED_SOURCE_TYPE","Only txt, md, csv, docx, pdf, xlsx, and image imports are supported");}; }
  public static void validateImport(String ext, String contentType, byte[] b, String name) {
    if (b == null || b.length == 0) throw ApiException.of(400,"EMPTY_FILE","Uploaded file is empty");
    if (b.length > IMPORT_MAX) throw ApiException.of(413,"FILE_TOO_LARGE","Import content exceeds the 25 MiB limit");
    String actual = imageMime(b);
    switch(ext) {
      case ".txt", ".md", ".csv" -> { try { String s = StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(b)).toString(); if (bContains(b,(byte)0) || s.strip().isEmpty()) throw ApiException.of(400,"EMPTY_FILE",ext.substring(1).toUpperCase()+" files must contain non-whitespace text"); } catch (java.nio.charset.CharacterCodingException e) { throw ApiException.of(400,"INVALID_FILE_CONTENT",ext.substring(1).toUpperCase()+" files must use UTF-8 encoding"); } }
      case ".pdf" -> { if (!starts(b,"%PDF-".getBytes())) throw ApiException.of(400,"UNSUPPORTED_FILE_TYPE","PDF files must be valid PDF documents"); }
      case ".docx", ".xlsx" -> { if (!starts(b,new byte[]{'P','K'})) throw ApiException.of(400,"UNSUPPORTED_FILE_TYPE",ext.substring(1).toUpperCase()+" files must be valid Office Open XML documents"); }
      default -> { String expected = switch(ext) { case ".png"->"image/png"; case ".jpg", ".jpeg"->"image/jpeg"; case ".gif"->"image/gif"; default->"image/webp";}; if (!expected.equals(actual)) throw ApiException.of(400,"UNSUPPORTED_FILE_TYPE","Image content does not match its file type"); }
    }
  }
  public static Path path(String mount, String relative) {
    String clean = relative == null ? "" : relative.replace('\\','/');
    if (clean.isBlank() || clean.startsWith("/") || clean.contains("..")) throw ApiException.of(400,"INVALID_STORAGE_PATH","Invalid object storage path");
    try { Path root=Path.of(mount).toRealPath(LinkOption.NOFOLLOW_LINKS); Path path=root.resolve(clean).normalize(); if (!path.startsWith(root)) throw ApiException.of(400,"INVALID_STORAGE_PATH","Invalid object storage path"); return path; }
    catch (IOException e) { Path root=Path.of(mount).toAbsolutePath().normalize(); Path path=root.resolve(clean).normalize(); if(!path.startsWith(root)) throw ApiException.of(400,"INVALID_STORAGE_PATH","Invalid object storage path"); return path; }
  }
  public static String token() { byte[] b=new byte[12]; RANDOM.nextBytes(b); StringBuilder s=new StringBuilder(); for(byte x:b)s.append(String.format("%02x",x)); return s.toString(); }
  private static boolean starts(byte[] a,byte[] b){if(a.length<b.length)return false;for(int i=0;i<b.length;i++)if(a[i]!=b[i])return false;return true;} private static boolean bContains(byte[] a,byte x){for(byte b:a)if(b==x)return true;return false;}
}
