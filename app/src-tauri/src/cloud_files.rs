//! Native file handoff only: document recognition and structuring stay in the cloud.
use crate::{
    cloud::{error, Context, State},
    contract::Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, Method};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const SOURCE_LIMIT: usize = 150 * 1024 * 1024;
#[derive(Clone)]
pub(crate) struct Source {
    path: PathBuf,
    metadata: Value,
    generation: u64,
    origin: String,
    selected_at: std::time::Instant,
}
impl Source {
    fn verified_bytes(&self) -> Result<Vec<u8>> {
        let bytes = crate::store::read_bounded(&self.path, SOURCE_LIMIT)?;
        if bytes.len() as u64 != self.metadata["sizeBytes"].as_u64().unwrap_or(0)
            || crate::store::hash(&bytes) != self.metadata["sha256"].as_str().unwrap_or("")
        {
            return Err(error("DOCUMENT_CHECKSUM_MISMATCH"));
        }
        Ok(bytes)
    }
}
fn format(name: &str) -> Result<(&'static str, &'static str, &'static str)> {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => Ok(("pdf", "application/pdf", "pdf")),
        "txt" => Ok(("text", "text/plain", "txt")),
        "md" => Ok(("markdown", "text/markdown", "md")),
        "png" => Ok(("image", "image/png", "image")),
        "jpg" | "jpeg" => Ok(("image", "image/jpeg", "image")),
        "doc" => Ok(("doc", "application/msword", "doc")),
        "docx" => Ok((
            "docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
        )),
        "ppt" => Ok(("ppt", "application/vnd.ms-powerpoint", "ppt")),
        "pptx" => Ok((
            "pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "pptx",
        )),
        "xls" => Ok(("xls", "application/vnd.ms-excel", "xls")),
        "xlsx" => Ok((
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "xlsx",
        )),
        _ => Err(error("UNSUPPORTED_FILE")),
    }
}
fn filename(name: &str) -> Result<()> {
    if name.is_empty()
        || name.chars().count() > 255
        || name.starts_with('.')
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err(error("CLOUD_FILENAME_INVALID"));
    }
    Ok(())
}
pub(crate) fn confirm(
    app: &AppHandle,
    state: &State,
    context: &Context,
    message: &str,
) -> Result<Value> {
    if message.len() > 4096 {
        return Err(error("CLOUD_REQUEST_TOO_LARGE"));
    }
    let snapshot = state.snapshot(context)?;
    let confirmed = app
        .dialog()
        .message(message)
        .title("PractiQ")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .blocking_show();
    state.current(&snapshot)?;
    Ok(json!(confirmed))
}

pub(crate) fn pick(app: &AppHandle, state: &State, context: &Context) -> Result<Value> {
    let snapshot = state.snapshot(context)?;
    let selected = app
        .dialog()
        .file()
        .add_filter(
            "上传到云端识别的文档",
            &[
                "pdf", "txt", "md", "png", "jpg", "jpeg", "doc", "docx", "ppt", "pptx", "xls",
                "xlsx",
            ],
        )
        .blocking_pick_files()
        .unwrap_or_default();
    if selected.len() > 10 {
        return Err(error("FILE_COUNT_LIMIT"));
    }
    let mut additions = Vec::new();
    for file in selected {
        let path = file.into_path().map_err(|_| error("CLOUD_FILE_INVALID"))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| error("CLOUD_FILENAME_INVALID"))?
            .trim()
            .to_owned();
        filename(&name)?;
        let (kind, media, _) = format(&name)?;
        let bytes = crate::store::read_bounded(&path, SOURCE_LIMIT)?;
        if bytes.is_empty() {
            return Err(error("DOCUMENT_TOO_LARGE"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let metadata = json!({"fileName":name,"sizeBytes":bytes.len(),"sourceType":kind,"mediaType":media,"sha256":crate::store::hash(&bytes)});
        additions.push((
            id,
            Source {
                path,
                metadata,
                generation: snapshot.epoch,
                origin: snapshot.origin.clone(),
                selected_at: std::time::Instant::now(),
            },
        ));
    }
    state.current(&snapshot)?;
    let mut current = state.lock()?;
    // Keep selection tickets bounded; evicted files require explicit reselection.
    while current.sources.len() + additions.len() > 50 {
        let oldest = current
            .sources
            .iter()
            .min_by_key(|(_, source)| source.selected_at)
            .map(|(id, _)| id.clone())
            .ok_or_else(|| error("FILE_COUNT_LIMIT"))?;
        current.sources.remove(&oldest);
    }
    let result: Vec<_> = additions.iter().map(|(id, source)| json!({"nativeTicket":id,"name":source.metadata["fileName"],"size":source.metadata["sizeBytes"]})).collect();
    current.sources.extend(additions);
    Ok(json!(result))
}
pub(crate) fn response_json(response: reqwest::blocking::Response) -> Result<Value> {
    let status = response.status();
    let value = crate::ai::read_json(response, 1024 * 1024)?;
    if !status.is_success() {
        let code = value["detail"]["code"]
            .as_str()
            .filter(|s| {
                s.len() <= 64
                    && s.bytes()
                        .all(|b| b.is_ascii_uppercase() || b == b'_' || b.is_ascii_digit())
            })
            .unwrap_or("CLOUD_RESULT_UNKNOWN");
        return Err(error(code));
    }
    Ok(value)
}
fn upload_path(origin: &str, metadata: &Value, upload: &Value) -> Result<String> {
    let raw = upload["url"].as_str().ok_or_else(|| error("INVALID_URL"))?;
    let url = url::Url::parse(&format!("{}/", origin))
        .and_then(|base| base.join(raw))
        .map_err(|_| error("INVALID_URL"))?;
    let query: std::collections::HashMap<_, _> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if upload["method"] != "PUT"
        || url.origin().ascii_serialization() != origin
        || url.path() != "/api/uploads/content"
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || query.len() != 5
        || url.query_pairs().count() != 5
        || !metadata
            .as_object()
            .ok_or_else(|| error("INVALID_REFERENCE"))?
            .iter()
            .all(|(k, v)| {
                query.get(k).is_some_and(|value| {
                    *value
                        == v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string())
                })
            })
    {
        return Err(error("INVALID_URL"));
    }
    Ok(format!("{}?{}", url.path(), url.query().unwrap_or("")))
}

pub(crate) fn upload(
    _app: &AppHandle,
    state: &State,
    context: &Context,
    ticket: &str,
) -> Result<Value> {
    let snapshot = state.snapshot(context)?;
    let source = state
        .lock()?
        .sources
        .get(ticket)
        .cloned()
        .ok_or_else(|| error("CLOUD_FILE_RESELECT"))?;
    if source.generation != snapshot.epoch || source.origin != snapshot.origin {
        return Err(error("CLOUD_SERVICE_CHANGED"));
    }
    let bytes = source.verified_bytes()?;
    state.current(&snapshot)?;
    let prepared = response_json(snapshot.send(
        Method::POST,
        "/api/uploads",
        Some(source.metadata.clone()),
        None,
    )?)?;
    let mut expected = source.metadata.clone();
    let suffix = format(source.metadata["fileName"].as_str().unwrap_or(""))?.2;
    expected["objectKey"] = json!(format!(
        "practiq-agent/sources/{}/source.{suffix}",
        source.metadata["sha256"].as_str().unwrap_or("")
    ));
    if prepared["document"] != expected {
        return Err(error("INVALID_REFERENCE"));
    }
    if !prepared["upload"].is_null() {
        let path = upload_path(&snapshot.origin, &source.metadata, &prepared["upload"])?;
        state.current(&snapshot)?;
        let uploaded = response_json(snapshot.send(
            Method::PUT,
            &path,
            None,
            Some((
                bytes,
                source.metadata["mediaType"].as_str().unwrap_or("").into(),
            )),
        )?)?;
        if uploaded != expected {
            return Err(error("INVALID_REFERENCE"));
        }
    }
    state.current(&snapshot)?;
    Ok(expected)
}

fn destination(app: &AppHandle, name: &str) -> Result<Option<PathBuf>> {
    filename(name)?;
    app.dialog()
        .file()
        .set_file_name(name)
        .blocking_save_file()
        .map(|v| v.into_path().map_err(|_| error("CLOUD_SAVE_FAILED")))
        .transpose()
}
pub(crate) fn download(
    app: &AppHandle,
    state: &State,
    context: &Context,
    path: &str,
    name: &str,
) -> Result<Value> {
    let url = url::Url::parse(&format!("https://cloud.invalid{path}"))
        .map_err(|_| error("CLOUD_PATH_INVALID"))?;
    if !url.path().ends_with("/export") || !name.ends_with(".zip") {
        return Err(error("CLOUD_PATH_INVALID"));
    }
    let Some(target) = destination(app, name)? else {
        return Ok(json!(false));
    };
    let snapshot = state.snapshot(context)?;
    let response = snapshot.send(Method::GET, path, None, None)?;
    if !response.status().is_success() {
        response_json(response)?;
        return Err(error("CLOUD_RESPONSE_INVALID"));
    }
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(""))
        != Some("application/zip")
    {
        return Err(error("CLOUD_RESPONSE_INVALID"));
    }
    let parent = target.parent().ok_or_else(|| error("CLOUD_SAVE_FAILED"))?;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| error("CLOUD_SAVE_FAILED"))?;
    let count = std::io::copy(
        &mut response.take(crate::bank_zip::ZIP_LIMIT + 1),
        &mut file,
    )
    .map_err(|_| error("CLOUD_SAVE_FAILED"))?;
    if count > crate::bank_zip::ZIP_LIMIT {
        return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
    }
    verify_zip(file.reopen().map_err(|_| error("CLOUD_SAVE_FAILED"))?)?;
    state.current(&snapshot)?;
    crate::filesystem::persist(file, &target, true).map_err(|_| error("CLOUD_SAVE_FAILED"))?;
    Ok(json!(true))
}
fn verify_zip(file: std::fs::File) -> Result<()> {
    let mut archive = zip::ZipArchive::new(file).map_err(|_| error("CLOUD_RESPONSE_INVALID"))?;
    if archive.is_empty() || archive.len() > 2002 {
        return Err(error("CLOUD_RESPONSE_INVALID"));
    }
    let mut names = std::collections::HashSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| error("CLOUD_RESPONSE_INVALID"))?;
        let name = entry
            .name()
            .map_err(|_| error("CLOUD_RESPONSE_INVALID"))?
            .into_owned();
        if entry.is_dir()
            || name.contains('\\')
            || name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || !names.insert(name)
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
        {
            return Err(error("CLOUD_RESPONSE_INVALID"));
        }
        let remaining = crate::bank_zip::ZIP_LIMIT.saturating_sub(total);
        if entry.size() > remaining {
            return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
        }
        let actual = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut std::io::sink())
            .map_err(|_| error("CLOUD_RESPONSE_INVALID"))?;
        if actual != entry.size() || actual > remaining {
            return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
        }
        total += actual;
    }
    Ok(())
}
pub(crate) fn save(
    app: &AppHandle,
    state: &State,
    context: &Context,
    name: &str,
    encoded: &str,
) -> Result<Value> {
    let snapshot = state.snapshot(context)?;
    if encoded.len() > crate::cloud::MAX_RESPONSE * 4 / 3 + 4 {
        return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| error("CLOUD_RESPONSE_INVALID"))?;
    if bytes.len() > crate::cloud::MAX_RESPONSE {
        return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
    }
    let Some(target) = destination(app, name)? else {
        return Ok(json!(false));
    };
    let mut file =
        tempfile::NamedTempFile::new_in(target.parent().ok_or_else(|| error("CLOUD_SAVE_FAILED"))?)
            .map_err(|_| error("CLOUD_SAVE_FAILED"))?;
    file.write_all(&bytes)
        .map_err(|_| error("CLOUD_SAVE_FAILED"))?;
    state.current(&snapshot)?;
    crate::filesystem::persist(file, &target, true).map_err(|_| error("CLOUD_SAVE_FAILED"))?;
    Ok(json!(true))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upload_targets_cannot_escape_the_origin_or_change_the_selected_metadata() {
        let metadata = json!({"fileName":"source.txt","sizeBytes":4,"sourceType":"text","mediaType":"text/plain","sha256":"a".repeat(64)});
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in metadata.as_object().unwrap() {
            query.append_pair(
                key,
                &value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string()),
            );
        }
        let path = format!("/api/uploads/content?{}", query.finish());
        assert_eq!(
            upload_path(
                "https://cloud.test",
                &metadata,
                &json!({"method":"PUT","url":path})
            )
            .unwrap(),
            path
        );
        for raw in [
            format!("https://evil.test{path}"),
            format!("{path}&fileName=other.txt"),
            path.replace("sizeBytes=4", "sizeBytes=5"),
            format!("{path}#fragment"),
        ] {
            assert!(upload_path(
                "https://cloud.test",
                &metadata,
                &json!({"method":"PUT","url":raw})
            )
            .is_err());
        }
        assert!(upload_path(
            "https://cloud.test",
            &metadata,
            &json!({"method":"POST","url":path})
        )
        .is_err());
    }
    #[test]
    fn downloaded_zip_is_bounded_and_checked_before_publication() {
        use zip::write::SimpleFileOptions;
        let mut file = tempfile::tempfile().unwrap();
        {
            let mut zip = zip::ZipWriter::new(&mut file);
            zip.start_file("questions.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }
        assert!(verify_zip(file.try_clone().unwrap()).is_ok());
        let mut unsafe_file = tempfile::tempfile().unwrap();
        {
            let mut zip = zip::ZipWriter::new(&mut unsafe_file);
            zip.start_file("../secret", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
        }
        assert!(verify_zip(unsafe_file).is_err());
        assert!(verify_zip(tempfile::tempfile().unwrap()).is_err());
    }
    #[test]
    fn source_formats_do_not_recognize_or_parse_documents() {
        assert_eq!(format("example.PDF").unwrap().0, "pdf");
        assert_eq!(format("example.jpeg").unwrap().2, "image");
        assert!(format("example.csv").is_err());
        for name in ["../secret", "/tmp/other", ".env", "x\ny"] {
            assert!(filename(name).is_err());
        }
    }
    #[test]
    fn changed_selected_sources_fail_before_any_upload_or_paid_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.txt");
        std::fs::write(&path, b"original").unwrap();
        let source = Source {
            path: path.clone(),
            metadata: json!({"sizeBytes":8,"sha256":crate::store::hash(b"original")}),
            generation: 1,
            origin: "https://example.test".into(),
            selected_at: std::time::Instant::now(),
        };
        assert_eq!(source.verified_bytes().unwrap(), b"original");
        std::fs::write(&path, b"modified").unwrap();
        assert_eq!(
            source.verified_bytes().unwrap_err().code,
            "DOCUMENT_CHECKSUM_MISMATCH"
        );
    }
}
