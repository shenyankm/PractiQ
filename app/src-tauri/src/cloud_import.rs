//! Import a checked backend snapshot and immutable resources directly into SQLite.
use crate::{
    cloud::{error, Context, State},
    contract::{self, text, Result},
    store::Pending,
    Shared,
};
use reqwest::Method;
use serde_json::{json, Value};
use std::io::Read;

pub(crate) fn pending(
    value: Value,
    mut resource: impl FnMut(&Value) -> Result<Vec<u8>>,
) -> Result<Pending> {
    contract::bank_import(&value)?;
    let title = text(&value, "title")
        .trim()
        .chars()
        .take(crate::store::BANK_TITLE_LIMIT)
        .collect::<String>()
        .trim_end()
        .to_owned();
    if title.trim().is_empty() {
        return Err(error("CLOUD_RESPONSE_INVALID"));
    }
    let mut pending = Pending::new(serde_json::to_vec(&json!({"status":value["status"],"result":value["result"],"processing":value["processing"]})).map_err(|_| error("CLOUD_RESPONSE_INVALID"))?, title)?;
    let refs = crate::bank_zip::references(&pending.root)?;
    let total: u64 = refs
        .values()
        .map(|r| r["sizeBytes"].as_u64().unwrap_or(u64::MAX))
        .try_fold(0u64, |sum, n| sum.checked_add(n))
        .ok_or_else(|| error("CLOUD_RESPONSE_TOO_LARGE"))?;
    if refs.len() > 2000 || total > 256 * 1024 * 1024 {
        return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
    }
    for reference in refs.values() {
        if reference["sizeBytes"]
            .as_u64()
            .is_none_or(|n| n > crate::assets::LIMIT as u64)
        {
            return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
        }
        let bytes = resource(reference)?;
        if let Some(duration) = crate::bank_zip::verify_resource(reference, &bytes)? {
            for q in contract::list(contract::result(&pending.root), "questions")
                .iter()
                .filter(|q| q["audioRef"]["sha256"] == reference["sha256"])
            {
                crate::audio::validate_segment(q, duration)?;
            }
        }
        pending.assets.insert(
            text(reference, "sha256").into(),
            (text(reference, "mediaType").into(), bytes),
        );
    }
    pending.missing.clear();
    Ok(pending)
}

pub(crate) fn import_bank(
    state: &State,
    shared: &Shared,
    context: &Context,
    path: &str,
) -> Result<Value> {
    crate::cloud::validate_path(path, &Method::GET)?;
    let url = url::Url::parse(&format!("https://cloud.invalid{path}"))
        .map_err(|_| error("CLOUD_PATH_INVALID"))?;
    if !url.path().ends_with("/bank")
        || !url
            .query_pairs()
            .any(|(k, v)| k == "checkpoint_id" && !v.is_empty())
    {
        return Err(error("CLOUD_PATH_INVALID"));
    }
    let task = url
        .path()
        .split('/')
        .nth(3)
        .ok_or_else(|| error("CLOUD_PATH_INVALID"))?;
    let snapshot = state.snapshot(context)?;
    let response = snapshot.send(Method::GET, path, None, None)?;
    if !response.status().is_success() {
        crate::cloud_files::response_json(response)?;
        return Err(error("CLOUD_RESPONSE_INVALID"));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        != Some("application/json")
    {
        return Err(error("CLOUD_RESPONSE_INVALID"));
    }
    let value = crate::ai::read_json(response, contract::MAX_JSON + 64 * 1024)?;
    let pending = pending(value, |reference| {
        let response = snapshot.send(
            Method::POST,
            &format!("/api/artifacts/read?thread_id={task}"),
            Some(reference.clone()),
            None,
        )?;
        if !response.status().is_success()
            || response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.split(';').next())
                != reference["mediaType"].as_str()
        {
            return Err(error("CLOUD_RESPONSE_INVALID"));
        }
        let mut bytes = Vec::new();
        response
            .take(crate::assets::LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error("CLOUD_RESPONSE_INVALID"))?;
        Ok(bytes)
    })?;
    let _current = state.current_guard(&snapshot)?;
    shared
        .lock()
        .map_err(|_| error("LOCAL_DATABASE_UNAVAILABLE"))?
        .import_pending(&pending, None, &pending.title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use std::{collections::HashMap, io::Cursor};

    fn fixture() -> (Value, HashMap<String, Vec<u8>>) {
        // Historical transport is fixture input only; the production path never opens an archive.
        let mut archive = zip::ZipArchive::new(Cursor::new(include_bytes!(
            "../../fixtures/service-export/partial-media-bank.zip"
        )))
        .unwrap();
        let mut root = String::new();
        archive
            .by_name("questions.json")
            .unwrap()
            .read_to_string(&mut root)
            .unwrap();
        let mut value: Value = serde_json::from_str(&root).unwrap();
        value["title"] = json!("Direct backend result");
        let mut resources = HashMap::new();
        for reference in crate::bank_zip::references(&value).unwrap().values() {
            let mut bytes = Vec::new();
            archive
                .by_name(&format!("resources/{}", text(reference, "objectKey")))
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            resources.insert(text(reference, "objectKey").into(), bytes);
        }
        (value, resources)
    }
    #[test]
    fn backend_result_imports_directly_with_checked_resources_and_partial_diagnostics() {
        let (value, resources) = fixture();
        let pending = pending(value.clone(), |r| {
            Ok(resources[text(r, "objectKey")].clone())
        })
        .unwrap();
        assert!(pending.missing.is_empty());
        assert_eq!(pending.title, "Direct backend");
        assert!(!pending.assets.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let imported = store
            .import_pending(&pending, None, &pending.title)
            .unwrap();
        assert_eq!(imported["count"], 2);
        let bank = text(&imported, "bankId");
        let rows = store.questions(Some(bank), "", "", "").unwrap();
        assert!(rows
            .as_array()
            .unwrap()
            .iter()
            .all(|q| q["missingAssets"] == false));
        assert_eq!(
            crate::import_diagnostics::read(&store.connect().unwrap(), bank).unwrap()[0]["status"],
            value["status"]
        );
        let reopened = Store::new(dir.path().into()).unwrap();
        assert_eq!(reopened.questions(Some(bank), "", "", "").unwrap(), rows);
    }
    #[test]
    fn invalid_snapshot_or_resource_cannot_reach_the_database() {
        let (mut value, resources) = fixture();
        assert!(pending(value.clone(), |_| Ok(b"corrupt image".to_vec())).is_err());
        value["result"]["questions"][0]["stem"] = json!(42);
        assert!(pending(value, |r| Ok(resources[text(r, "objectKey")].clone())).is_err());
    }
    #[test]
    fn native_import_fetches_json_and_artifacts_without_creating_zip_files() {
        use std::{
            io::Write,
            net::TcpListener,
            sync::{Arc, Mutex},
        };
        let (value, resources) = fixture();
        let refs = crate::bank_zip::references(&value).unwrap();
        let mut replies = vec![(
            "application/json".to_owned(),
            serde_json::to_vec(&value).unwrap(),
        )];
        for reference in refs.values() {
            replies.push((
                text(reference, "mediaType").into(),
                resources[text(reference, "objectKey")].clone(),
            ));
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut paths = Vec::new();
            for (media, body) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 8192];
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            paths.push(header.lines().next().unwrap().to_owned());
                            break;
                        }
                    }
                }
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: {media}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
            paths
        });
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("import-service-v1.json"),
            serde_json::to_vec(&json!({"version":1,"origin":origin})).unwrap(),
        )
        .unwrap();
        let state = State::new(dir.path().into());
        let shared = Arc::new(Mutex::new(Store::new(dir.path().into()).unwrap()));
        let result = import_bank(
            &state,
            &shared,
            &state.context().unwrap().unwrap(),
            "/api/document-tasks/11111111-1111-4111-8111-111111111111/bank?checkpoint_id=current",
        )
        .unwrap();
        assert_eq!(result["count"], 2);
        let paths = handle.join().unwrap();
        assert!(paths[0].contains("/bank?checkpoint_id=current"));
        assert!(paths
            .iter()
            .skip(1)
            .all(|path| path.starts_with("POST /api/artifacts/read?thread_id=")));
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_none_or(|v| v != "zip")));
    }
}
