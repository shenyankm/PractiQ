use crate::{
    contract::Result,
    store::{hash, Store},
};
use keyring::Entry;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionSettings {
    pub base_url: Option<String>,
    pub model_id: Option<String>,
}
impl ConnectionSettings {
    pub fn validate(mut self) -> Result<Self> {
        let (name, value) = ("Base URL", &mut self.base_url);
        *value = value
            .take()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        if let Some(raw) = value {
            if raw.len() > 2048 {
                return Err(crate::language::error(
                    "LOCAL_URL_TOO_LONG",
                    serde_json::json!({"name": name}),
                ));
            }
            let url = url::Url::parse(raw).map_err(|_| {
                crate::language::error("LOCAL_URL_INVALID", serde_json::json!({"name": name}))
            })?;
            let loopback = url.host_str().is_some_and(|h| {
                h == "localhost"
                    || h == "[::1]"
                    || h.parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
            if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                return Err(crate::language::error(
                    "LOCAL_URL_HTTPS_REQUIRED",
                    serde_json::json!({"name": name}),
                ));
            }
            if url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(crate::language::error(
                    "LOCAL_URL_CREDENTIALS_FORBIDDEN",
                    serde_json::json!({"name": name}),
                ));
            }
            *raw = url.to_string().trim_end_matches('/').to_owned();
        }
        self.model_id = self
            .model_id
            .take()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        if self
            .model_id
            .as_ref()
            .is_some_and(|s| s.chars().count() > 255 || s.chars().any(char::is_control))
        {
            return Err(crate::language::error(
                "LOCAL_MODEL_ID_INVALID",
                serde_json::json!({}),
            ));
        }
        Ok(self)
    }
}
fn validate_api_key(key: &str) -> Result<()> {
    // keyring stores Windows passwords as UTF-16 in a 2,560-byte credential blob.
    if key.len() > 8192
        || key.chars().any(char::is_control)
        || (cfg!(target_os = "windows") && key.encode_utf16().count() * 2 > 2560)
    {
        return Err(crate::language::error("LOCAL_API_KEY_INVALID", json!({})));
    }
    Ok(())
}
fn secret(entry: &Entry) -> Result<Option<String>> {
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(crate::language::error(
            "LOCAL_KEYCHAIN_READ",
            serde_json::json!({}),
        )),
    }
}
fn write_secret(entry: &Entry, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        entry
            .set_password(value)
            .map_err(|_| crate::language::error("LOCAL_KEYCHAIN_WRITE", serde_json::json!({})))
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(crate::language::error(
                "LOCAL_KEYCHAIN_DELETE",
                serde_json::json!({}),
            )),
        }
    }
}
fn entry(service: &str, base_url: &str) -> Result<Entry> {
    Entry::new(
        service,
        &format!("ai-api-key-{}", hash(base_url.as_bytes())),
    )
    .map_err(|_| crate::language::error("LOCAL_KEYCHAIN_INIT", serde_json::json!({})))
}
pub fn test_connection(config: ConnectionSettings, key: String) -> Result<Value> {
    use std::io::Read;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| crate::language::error("LOCAL_CONNECTION_FAILED", json!({})))?;
    let response = client
        .get(format!(
            "{}/models",
            config.base_url.as_deref().unwrap_or_default()
        ))
        .bearer_auth(key)
        .send()
        .map_err(|_| crate::language::error("LOCAL_CONNECTION_FAILED", json!({})))?;
    if !response.status().is_success() {
        return Err(crate::language::error(
            "LOCAL_CONNECTION_HTTP",
            json!({"status": response.status().as_u16()}),
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|_| crate::language::error("LOCAL_CONNECTION_FAILED", json!({})))?;
    let body: Value = if bytes.len() <= 1_048_576 {
        serde_json::from_slice(&bytes).ok()
    } else {
        None
    }
    .ok_or(crate::language::error(
        "LOCAL_CONNECTION_RESPONSE",
        json!({}),
    ))?;
    let models = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or(crate::language::error(
            "LOCAL_CONNECTION_RESPONSE",
            json!({}),
        ))?;
    if !models
        .iter()
        .any(|model| model.get("id").and_then(Value::as_str) == config.model_id.as_deref())
    {
        return Err(crate::language::error("LOCAL_CONNECTION_MODEL", json!({})));
    }
    Ok(Value::Null)
}
/// Copy only the store location while holding the UI database mutex. Keychain
/// calls below can wait for macOS authorization without blocking offline work.
pub fn snapshot(shared: &crate::Shared) -> Result<Store> {
    let store = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?;
    Ok(Store {
        locale: store.locale,
        dir: store.dir.clone(),
        pending: None,
        staged_audio: Default::default(),
    })
}
/// Display configuration without opening the credential store. A null key status
/// means it will be checked by an explicit model action or connection test.
pub fn settings(shared: &crate::Shared) -> Result<Value> {
    let config = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
        .connection_settings()?;
    let configured = config.base_url.is_none().then_some(false);
    Ok(json!({"config":config,"hasApiKey":configured}))
}
impl Store {
    pub fn connection_test_input(
        &self,
        service: &str,
        config: ConnectionSettings,
        api_key: Option<String>,
    ) -> Result<(ConnectionSettings, String)> {
        let config = config.validate()?;
        if config.base_url.is_none() || config.model_id.is_none() {
            return Err(crate::language::error("LOCAL_CONNECTION_FIELDS", json!({})));
        }
        let key = match api_key {
            Some(key) if !key.trim().is_empty() => key.trim().to_owned(),
            _ => self.model_secret(service, config.base_url.as_deref().unwrap_or_default())?,
        };
        validate_api_key(&key)?;
        Ok((config, key))
    }
    pub fn model_secret(&self, service: &str, base: &str) -> Result<String> {
        secret(&entry(service, base)?)?
            .filter(|s| !s.is_empty())
            .ok_or(crate::language::error(
                "LOCAL_API_KEY_REQUIRED",
                serde_json::json!({}),
            ))
    }
    pub fn connection_settings(&self) -> Result<ConnectionSettings> {
        self.connect()?
            .query_row(
                "SELECT base_url,model_id FROM settings WHERE id=1",
                [],
                |r| {
                    Ok(ConnectionSettings {
                        base_url: r.get(0)?,
                        model_id: r.get(1)?,
                    })
                },
            )
            .map_err(|e| crate::AppError::from(e.to_string()))
    }
    pub fn save_settings(
        &self,
        service: &str,
        config: ConnectionSettings,
        api_key: Option<String>,
    ) -> Result<Value> {
        let config = config.validate()?;
        if let Some(key) = &api_key {
            validate_api_key(key)?;
        }
        if api_key.as_ref().is_some_and(|s| !s.trim().is_empty()) && config.base_url.is_none() {
            return Err(crate::language::error(
                "LOCAL_API_KEY_URL_REQUIRED",
                serde_json::json!({}),
            ));
        }
        let configured = match (&config.base_url, &api_key) {
            (Some(_), Some(key)) => Some(!key.trim().is_empty()),
            (Some(_), None) => None,
            (None, _) => Some(false),
        };
        let previous = if let (Some(base), Some(key)) = (&config.base_url, &api_key) {
            let entry = entry(service, base)?;
            let previous = secret(&entry)?;
            let key = key.trim();
            write_secret(&entry, if key.is_empty() { None } else { Some(key) })?;
            Some((entry, previous))
        } else {
            None
        };
        // Do not hold a SQLite write transaction while the OS credential UI waits.
        let persist = self.connect().and_then(|db| {
            db.execute(
                "UPDATE settings SET base_url=?1,model_id=?2 WHERE id=1",
                params![config.base_url, config.model_id],
            )
            .map(|_| ())
            .map_err(|error| crate::AppError::from(error.to_string()))
        });
        if let Err(error) = persist {
            if let Some((entry, previous)) = previous {
                write_secret(&entry, previous.as_deref()).map_err(|_| {
                    crate::language::error("LOCAL_KEYCHAIN_ROLLBACK", serde_json::json!({}))
                })?;
            }
            return Err(error);
        }
        Ok(json!({"config":config,"hasApiKey":configured}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn api_key_validation_matches_native_storage_limits() {
        for key in ["x".repeat(8193), "key\nvalue".into()] {
            assert_eq!(
                validate_api_key(&key).unwrap_err().code,
                "LOCAL_API_KEY_INVALID"
            );
        }
        for character in ["x", "中", "😀"] {
            let boundary = character.repeat(1280 / character.encode_utf16().count());
            assert!(validate_api_key(&boundary).is_ok());
            assert_eq!(
                validate_api_key(&(boundary + character)).is_err(),
                cfg!(target_os = "windows")
            );
        }
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn oversized_windows_keys_are_rejected_before_saving_or_testing() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        let config = ConnectionSettings {
            base_url: Some("https://example.com/v1".into()),
            model_id: Some("test".into()),
        };
        let key = Some("x".repeat(1281));
        assert_eq!(
            store
                .save_settings("test", config.clone(), key.clone())
                .unwrap_err()
                .code,
            "LOCAL_API_KEY_INVALID"
        );
        assert_eq!(
            store
                .connection_test_input("test", config, key)
                .err()
                .unwrap()
                .code,
            "LOCAL_API_KEY_INVALID"
        );
        assert!(store.connection_settings().unwrap().base_url.is_none());
    }
    #[test]
    fn settings_read_waits_for_restore_to_release_the_store() {
        use std::sync::{mpsc, Arc, Mutex};
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let source = Store::new(dir.path().join("source")).unwrap();
        source
            .connect()
            .unwrap()
            .execute("UPDATE settings SET model_id='restored'", [])
            .unwrap();
        let archive = dir.path().join("backup.zip");
        source.backup(&archive).unwrap();
        let shared = Arc::new(Mutex::new(Store::new(dir.path().join("live")).unwrap()));
        let mut store = shared.lock().unwrap();
        let reader = shared.clone();
        let (started, ready) = mpsc::channel();
        let (finished, result) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            finished.send(settings(&reader)).unwrap();
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            result.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        store.restore(&archive).unwrap();
        drop(store);
        let value = result
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(value["config"]["model_id"], "restored");
        assert_eq!(value["hasApiKey"], false);
        worker.join().unwrap();
    }
    #[test]
    fn displaying_and_saving_nonsecret_settings_leave_credentials_unchecked() {
        use std::sync::{Arc, Mutex};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        let config = ConnectionSettings {
            base_url: Some("https://example.com/v1".into()),
            model_id: Some("demo".into()),
        };
        let saved = store.save_settings("test", config, None).unwrap();
        assert!(saved["hasApiKey"].is_null());
        let shared = Arc::new(Mutex::new(store));
        let displayed = settings(&shared).unwrap();
        assert_eq!(displayed, saved);
        assert_eq!(displayed["config"]["model_id"], "demo");
    }

    #[test]
    fn tests_connections_without_saving_and_rejects_bad_responses() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        for (status, body, expected) in [
            ("200 OK", r#"{"data":[{"id":"demo"}]}"#, None),
            (
                "401 Unauthorized",
                "secret-key",
                Some("LOCAL_CONNECTION_HTTP"),
            ),
            ("302 Found", "", Some("LOCAL_CONNECTION_HTTP")),
            ("200 OK", "not json", Some("LOCAL_CONNECTION_RESPONSE")),
            (
                "200 OK",
                r#"{"data":[{"id":"other"}]}"#,
                Some("LOCAL_CONNECTION_MODEL"),
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with("GET /v1/models HTTP/1.1"));
                assert!(request
                    .to_lowercase()
                    .contains("authorization: bearer secret-key"));
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            let dir = tempfile::tempdir().unwrap();
            let store = Store::new(dir.path().to_owned()).unwrap();
            let (config, key) = store
                .connection_test_input(
                    "test",
                    ConnectionSettings {
                        base_url: Some(base),
                        model_id: Some("demo".into()),
                    },
                    Some("secret-key".into()),
                )
                .unwrap();
            let result = test_connection(config, key);
            if let Some(code) = expected {
                let error = result.unwrap_err();
                assert_eq!(error.code, code);
                assert!(!error.message.contains("secret-key"));
            } else {
                assert!(result.is_ok());
            }
            assert!(store.connection_settings().unwrap().base_url.is_none());
            server.join().unwrap();
        }
    }
    #[test]
    fn validates_urls_and_persists_nonsecret_settings() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::new(dir.path().to_owned()).unwrap();
        let config = ConnectionSettings {
            base_url: Some(" http://127.0.0.1:8317/v1/ ".into()),
            model_id: Some(" demo-model ".into()),
        }
        .validate()
        .unwrap();
        assert_eq!(config.base_url.as_deref(), Some("http://127.0.0.1:8317/v1"));
        // No API key means this check can use an offline mock store and never touches user secrets.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        s.save_settings("practiq-test", config, None).unwrap();
        assert_eq!(
            s.connection_settings().unwrap().model_id.as_deref(),
            Some("demo-model")
        );
        for url in [
            "http://example.com/v1",
            "https://user:password@example.com",
            "https://example.com?apikey=secret",
            "file:///tmp/key",
        ] {
            assert!(ConnectionSettings {
                base_url: Some(url.into()),
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        let fields = s
            .connect()
            .unwrap()
            .prepare("PRAGMA table_info(settings)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(!fields.iter().any(|s| s.contains("key")));
    }
    #[test]
    fn removes_oss_settings_from_existing_databases_and_backups() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("source")).unwrap();
        let has_oss = |db: &rusqlite::Connection| {
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('settings') WHERE name='oss_url')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
        };
        assert!(!has_oss(&store.connect().unwrap()));
        // Recreate the historical schema, including its original column order.
        let db = rusqlite::Connection::open(store.db_path()).unwrap();
        db.execute_batch(
            "DROP TABLE settings;
             CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),base_url TEXT,model_id TEXT,oss_url TEXT,locale TEXT CHECK(locale IS NULL OR locale IN('zh-CN','en')), libreoffice_path TEXT);
             INSERT INTO settings VALUES(1,NULL,'demo','https://bucket.example.com','en',NULL);",
        )
        .unwrap();
        drop(db);
        assert!(!has_oss(&store.connect().unwrap()));
        assert_eq!(
            store.connection_settings().unwrap().model_id.as_deref(),
            Some("demo")
        );
        let archive = dir.path().join("backup.zip");
        store.backup(&archive).unwrap();
        let mut restored = Store::new(dir.path().join("restored")).unwrap();
        restored.restore(&archive).unwrap();
        assert!(!has_oss(&restored.connect().unwrap()));
        assert_eq!(
            restored.connection_settings().unwrap().model_id.as_deref(),
            Some("demo")
        );
    }
    #[test]
    #[ignore = "uses an isolated native credential entry; run explicitly on the target OS"]
    fn native_keychain_roundtrip() {
        #[cfg(target_os = "macos")]
        keyring::set_default_credential_builder(keyring::macos::default_credential_builder());
        #[cfg(target_os = "windows")]
        keyring::set_default_credential_builder(keyring::windows::default_credential_builder());
        #[cfg(target_os = "linux")]
        keyring::set_default_credential_builder(
            keyring::secret_service::default_credential_builder(),
        );
        let entry = entry(
            &format!("com.practiq.test.{}", crate::store::id()),
            "https://example.com/v1",
        )
        .unwrap();
        write_secret(&entry, Some("practiq-dummy-test-value")).unwrap();
        let read = secret(&entry).unwrap();
        write_secret(&entry, None).unwrap();
        assert_eq!(read.as_deref(), Some("practiq-dummy-test-value"));
        assert!(secret(&entry).unwrap().is_none());
    }
}
