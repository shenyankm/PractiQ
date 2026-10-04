use crate::{
    contract::Result,
    store::{hash, Store},
};
use keyring::Entry;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SERVICE_MARKER: &str = "urn:practiq:ai-service:v1";

/// Raw schema-11 configuration retained for validation of existing backups.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionSettings {
    pub base_url: Option<String>,
    pub model_id: Option<String>,
}
impl ConnectionSettings {
    pub fn validate(mut self) -> Result<Self> {
        self.base_url = validate_url(self.base_url, "Base URL")?;
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
            return Err(crate::language::error("LOCAL_MODEL_ID_INVALID", json!({})));
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceSettings {
    pub service_url: Option<String>,
}
impl ServiceSettings {
    pub fn validate(mut self) -> Result<Self> {
        self.service_url = validate_url(self.service_url, "Service URL")?;
        Ok(self)
    }
}
fn validate_url(value: Option<String>, name: &str) -> Result<Option<String>> {
    let Some(raw) = value.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if raw.len() > 2048 {
        return Err(crate::language::error(
            "LOCAL_URL_TOO_LONG",
            json!({"name": name}),
        ));
    }
    let url = url::Url::parse(&raw)
        .map_err(|_| crate::language::error("LOCAL_URL_INVALID", json!({"name": name})))?;
    let loopback = url.host_str().is_some_and(|h| {
        h == "localhost"
            || h == "[::1]"
            || h.parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(crate::language::error(
            "LOCAL_URL_HTTPS_REQUIRED",
            json!({"name": name}),
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
            json!({"name": name}),
        ));
    }
    Ok(Some(url.to_string().trim_end_matches('/').to_owned()))
}
fn validate_service_token(token: &str) -> Result<()> {
    // The HTTP service accepts ASCII Bearer tokens; Windows stores UTF-16 blobs.
    if !token.is_ascii()
        || token.len() > 8192
        || token.chars().any(char::is_control)
        || (cfg!(target_os = "windows") && token.encode_utf16().count() * 2 > 2560)
    {
        return Err(crate::language::error(
            "LOCAL_SERVICE_TOKEN_INVALID",
            json!({}),
        ));
    }
    Ok(())
}
fn secret(entry: &Entry) -> Result<Option<String>> {
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(crate::language::error("LOCAL_KEYCHAIN_READ", json!({}))),
    }
}
fn write_secret(entry: &Entry, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        entry
            .set_password(value)
            .map_err(|_| crate::language::error("LOCAL_KEYCHAIN_WRITE", json!({})))
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(crate::language::error("LOCAL_KEYCHAIN_DELETE", json!({}))),
        }
    }
}
fn credential_account(service_url: &str) -> Result<String> {
    let url = validate_url(Some(service_url.into()), "Service URL")?.ok_or(
        crate::language::error("LOCAL_SERVICE_URL_REQUIRED", json!({})),
    )?;
    Ok(format!("ai-service-token-{}", hash(url.as_bytes())))
}
fn entry(service: &str, service_url: &str) -> Result<Entry> {
    Entry::new(service, &credential_account(service_url)?)
        .map_err(|_| crate::language::error("LOCAL_KEYCHAIN_INIT", json!({})))
}
fn required_service_token(entry: &Entry) -> Result<String> {
    let token = secret(entry)?
        .filter(|s| !s.trim().is_empty())
        .ok_or(crate::language::error(
            "LOCAL_SERVICE_TOKEN_REQUIRED",
            json!({}),
        ))?;
    validate_service_token(&token)?;
    Ok(token.trim().to_owned())
}
fn persist_with_secret(
    entry: &Entry,
    value: Option<&str>,
    persist: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let previous = secret(entry)?;
    write_secret(entry, value)?;
    if let Err(error) = persist() {
        write_secret(entry, previous.as_deref())
            .map_err(|_| crate::language::error("LOCAL_KEYCHAIN_ROLLBACK", json!({})))?;
        return Err(error);
    }
    Ok(())
}
pub fn test_connection(config: ServiceSettings, token: String) -> Result<Value> {
    let url = config
        .validate()?
        .service_url
        .ok_or(crate::language::error(
            "LOCAL_SERVICE_URL_REQUIRED",
            json!({}),
        ))?;
    validate_service_token(&token)?;
    if token.trim().is_empty() {
        return Err(crate::language::error(
            "LOCAL_SERVICE_TOKEN_REQUIRED",
            json!({}),
        ));
    }
    crate::ai::test_connection(&url, token.trim().to_owned())
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
        ..Default::default()
    })
}
/// Display the service configuration without opening the credential store.
pub fn settings(shared: &crate::Shared) -> Result<Value> {
    let config = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
        .service_settings()?;
    let configured = config.service_url.is_none().then_some(false);
    Ok(json!({"config":config,"hasServiceToken":configured}))
}
impl Store {
    pub fn connection_test_input(
        &self,
        service: &str,
        config: ServiceSettings,
        service_token: Option<String>,
    ) -> Result<(ServiceSettings, String)> {
        let config = config.validate()?;
        let url = config.service_url.as_deref().ok_or(crate::language::error(
            "LOCAL_SERVICE_URL_REQUIRED",
            json!({}),
        ))?;
        if let Some(token) = &service_token {
            validate_service_token(token)?;
        }
        let token = match service_token {
            Some(token) if !token.trim().is_empty() => token.trim().to_owned(),
            _ => self.service_secret(service, url)?,
        };
        Ok((config, token))
    }
    pub fn service_secret(&self, service: &str, service_url: &str) -> Result<String> {
        required_service_token(&entry(service, service_url)?)
    }
    /// Called only by the explicit subjective-grading or grading-retry action.
    pub fn grading_input(&self, service: &str) -> Result<(String, String)> {
        let url =
            self.service_settings()?
                .validate()?
                .service_url
                .ok_or(crate::language::error(
                    "LOCAL_SERVICE_URL_REQUIRED",
                    json!({}),
                ))?;
        let token = self.service_secret(service, &url)?;
        Ok((url, token))
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
    pub fn service_settings(&self) -> Result<ServiceSettings> {
        let raw = self.connection_settings()?;
        // A URL from an old model-provider configuration is never a service endpoint.
        if raw.model_id.as_deref() != Some(SERVICE_MARKER) {
            return Ok(ServiceSettings::default());
        }
        ServiceSettings {
            service_url: raw.base_url,
        }
        .validate()
    }
    pub fn save_settings(
        &self,
        service: &str,
        config: ServiceSettings,
        service_token: Option<String>,
    ) -> Result<Value> {
        self.save_settings_with(config, service_token, |url| entry(service, url))
    }
    fn save_settings_with(
        &self,
        config: ServiceSettings,
        service_token: Option<String>,
        credential: impl FnOnce(&str) -> Result<Entry>,
    ) -> Result<Value> {
        let config = config.validate()?;
        if let Some(token) = &service_token {
            validate_service_token(token)?;
        }
        if service_token.as_ref().is_some_and(|s| !s.trim().is_empty())
            && config.service_url.is_none()
        {
            return Err(crate::language::error(
                "LOCAL_SERVICE_URL_REQUIRED",
                json!({}),
            ));
        }
        let configured = match (&config.service_url, &service_token) {
            (Some(_), Some(token)) => Some(!token.trim().is_empty()),
            (Some(_), None) => None,
            (None, _) => Some(false),
        };
        // Do not hold a SQLite write transaction while the OS credential UI waits.
        let persist = || {
            self.connect()?
                .execute(
                    "UPDATE settings SET base_url=?1,model_id=?2 WHERE id=1",
                    params![
                        config.service_url,
                        config.service_url.as_ref().map(|_| SERVICE_MARKER)
                    ],
                )
                .map(|_| ())
                .map_err(|error| crate::AppError::from(error.to_string()))
        };
        if let (Some(url), Some(token)) = (&config.service_url, &service_token) {
            let entry = credential(url)?;
            let token = token.trim();
            persist_with_secret(
                &entry,
                if token.is_empty() { None } else { Some(token) },
                persist,
            )?;
        } else {
            persist()?;
        }
        Ok(json!({"config":config,"hasServiceToken":configured}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn config(url: &str) -> ServiceSettings {
        ServiceSettings {
            service_url: Some(url.into()),
        }
    }
    fn mock_entry(value: Option<&str>) -> Entry {
        let entry = Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        write_secret(&entry, value).unwrap();
        entry
    }
    fn fail_credential(_: &str) -> Result<Entry> {
        panic!("passive configuration must not open the credential store")
    }

    #[test]
    fn service_settings_are_strict_and_do_not_accept_provider_fields_or_tokens() {
        let parsed: ServiceSettings =
            serde_json::from_value(json!({"service_url":"https://example.com"})).unwrap();
        assert_eq!(parsed, config("https://example.com"));
        for input in [
            json!({"base_url":"https://example.com","model_id":"demo"}),
            json!({"service_url":"https://example.com","model_id":"demo"}),
            json!({"service_url":"https://example.com","service_token":"dummy-token"}),
        ] {
            assert!(serde_json::from_value::<ServiceSettings>(input).is_err());
        }
        assert!(serde_json::from_value::<ConnectionSettings>(
            json!({"base_url":null,"model_id":null,"service_url":null})
        )
        .is_err());
    }
    #[test]
    fn service_urls_normalize_and_keep_legacy_url_and_model_validation() {
        assert_eq!(
            config(" http://127.0.0.1:8317/api/ ").validate().unwrap(),
            config("http://127.0.0.1:8317/api")
        );
        assert_eq!(config("  ").validate().unwrap(), ServiceSettings::default());
        for url in [
            "http://localhost:8000",
            "http://[::1]:8000",
            "https://example.com/service",
        ] {
            assert!(config(url).validate().is_ok());
        }
        for url in [
            "not-a-url",
            "http://example.com",
            "https://user:password@example.com",
            "https://example.com?token=dummy",
            "https://example.com#token",
            "file:///tmp/token",
        ] {
            assert!(config(url).validate().is_err(), "{url}");
            assert!(ConnectionSettings {
                base_url: Some(url.into()),
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        assert_eq!(
            config(&format!("https://example.com/{}", "a".repeat(2048)))
                .validate()
                .unwrap_err()
                .code,
            "LOCAL_URL_TOO_LONG"
        );
        let legacy = ConnectionSettings {
            base_url: Some(" https://example.com/v1/ ".into()),
            model_id: Some(" demo-model ".into()),
        }
        .validate()
        .unwrap();
        assert_eq!(legacy.base_url.as_deref(), Some("https://example.com/v1"));
        assert_eq!(legacy.model_id.as_deref(), Some("demo-model"));
        for model in ["x".repeat(256), "model\nvalue".into()] {
            assert_eq!(
                ConnectionSettings {
                    model_id: Some(model),
                    ..Default::default()
                }
                .validate()
                .err()
                .unwrap()
                .code,
                "LOCAL_MODEL_ID_INVALID"
            );
        }
    }
    #[test]
    fn legacy_provider_settings_remain_unchanged_and_unconfigured_until_explicit_save() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE settings SET base_url=?1,model_id=?2,locale='en' WHERE id=1",
                params!["https://provider.example.com/v1", "legacy-model"],
            )
            .unwrap();
        let before = std::fs::read(store.db_path()).unwrap();
        let shared = Arc::new(Mutex::new(store));
        assert_eq!(
            settings(&shared).unwrap(),
            json!({"config":{"service_url":null},"hasServiceToken":false})
        );
        let store = shared.lock().unwrap();
        assert_eq!(
            store.grading_input("test").unwrap_err().code,
            "LOCAL_SERVICE_URL_REQUIRED"
        );
        assert_eq!(std::fs::read(store.db_path()).unwrap(), before);
        let raw = store.connection_settings().unwrap();
        assert_eq!(
            raw.base_url.as_deref(),
            Some("https://provider.example.com/v1")
        );
        assert_eq!(raw.model_id.as_deref(), Some("legacy-model"));
        let saved = store
            .save_settings_with(config(" http://127.0.0.1:8000/ "), None, fail_credential)
            .unwrap();
        assert_eq!(
            saved,
            json!({"config":{"service_url":"http://127.0.0.1:8000"},"hasServiceToken":null})
        );
        assert_eq!(
            store.connection_settings().unwrap().model_id.as_deref(),
            Some(SERVICE_MARKER)
        );
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT locale FROM settings WHERE id=1", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "en"
        );
        assert_eq!(
            crate::backup::validate_database_schema(&store.db_path()).unwrap(),
            11
        );
    }
    #[test]
    fn only_the_exact_service_marker_exposes_the_stored_url() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        for marker in [
            "demo",
            "urn:practiq:ai-service:v0",
            "urn:practiq:ai-service:v1 ",
        ] {
            store
                .connect()
                .unwrap()
                .execute(
                    "UPDATE settings SET base_url='https://provider.example.com',model_id=?1",
                    [marker],
                )
                .unwrap();
            assert_eq!(
                store.service_settings().unwrap(),
                ServiceSettings::default()
            );
        }
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE settings SET base_url='https://service.example.com/',model_id=?1",
                [SERVICE_MARKER],
            )
            .unwrap();
        assert_eq!(
            store.service_settings().unwrap(),
            config("https://service.example.com")
        );
    }
    #[test]
    fn passive_reads_and_unchanged_saves_leave_token_status_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        let cfg = config("https://service.example.com");
        let saved = store
            .save_settings_with(cfg.clone(), None, fail_credential)
            .unwrap();
        assert_eq!(
            store
                .save_settings_with(cfg, None, fail_credential)
                .unwrap(),
            saved
        );
        let shared = Arc::new(Mutex::new(store));
        assert_eq!(settings(&shared).unwrap(), saved);
        assert!(saved["hasServiceToken"].is_null());
        assert!(saved.get("hasApiKey").is_none());
    }
    #[test]
    fn clearing_the_service_url_preserves_schema_eleven_without_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        store
            .save_settings_with(config("https://service.example.com"), None, fail_credential)
            .unwrap();
        assert_eq!(
            store
                .save_settings_with(ServiceSettings::default(), None, fail_credential)
                .unwrap(),
            json!({"config":{"service_url":null},"hasServiceToken":false})
        );
        let raw = store.connection_settings().unwrap();
        assert!(raw.base_url.is_none() && raw.model_id.is_none());
        assert_eq!(
            crate::backup::validate_database_schema(&store.db_path()).unwrap(),
            11
        );
    }
    #[test]
    fn service_tokens_obey_bearer_and_native_storage_limits_before_keychain_access() {
        for token in [
            "x".repeat(8193),
            "token\nvalue".into(),
            "token\tvalue".into(),
            "密钥".into(),
        ] {
            assert_eq!(
                validate_service_token(&token).unwrap_err().code,
                "LOCAL_SERVICE_TOKEN_INVALID"
            );
            let dir = tempfile::tempdir().unwrap();
            let store = Store::new(dir.path().to_owned()).unwrap();
            assert_eq!(
                store
                    .save_settings_with(
                        config("https://example.com"),
                        Some(token.clone()),
                        fail_credential
                    )
                    .unwrap_err()
                    .code,
                "LOCAL_SERVICE_TOKEN_INVALID"
            );
            assert_eq!(
                store
                    .connection_test_input("test", config("https://example.com"), Some(token))
                    .unwrap_err()
                    .code,
                "LOCAL_SERVICE_TOKEN_INVALID"
            );
            assert!(store.service_settings().unwrap().service_url.is_none());
        }
        assert!(validate_service_token(&"x".repeat(1280)).is_ok());
        assert_eq!(
            validate_service_token(&"x".repeat(1281)).is_err(),
            cfg!(target_os = "windows")
        );
    }
    #[test]
    fn connection_input_uses_explicit_service_token_without_saving_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        let before = std::fs::read(store.db_path()).unwrap();
        let (cfg, token) = store
            .connection_test_input(
                "test",
                config(" https://service.example.com/ "),
                Some(" dummy-token ".into()),
            )
            .unwrap();
        assert_eq!(cfg, config("https://service.example.com"));
        assert_eq!(token, "dummy-token");
        assert_eq!(std::fs::read(store.db_path()).unwrap(), before);
        assert_eq!(
            store
                .connection_test_input(
                    "test",
                    ServiceSettings::default(),
                    Some("dummy-token".into())
                )
                .unwrap_err()
                .code,
            "LOCAL_SERVICE_URL_REQUIRED"
        );
        assert_eq!(
            store
                .save_settings_with(
                    ServiceSettings::default(),
                    Some("dummy-token".into()),
                    fail_credential
                )
                .unwrap_err()
                .code,
            "LOCAL_SERVICE_URL_REQUIRED"
        );
    }
    #[test]
    fn service_token_accounts_are_canonical_and_separate_from_old_model_keys() {
        let account = credential_account(" https://EXAMPLE.com:443/ ").unwrap();
        assert_eq!(account, credential_account("https://example.com").unwrap());
        assert_eq!(
            account,
            format!("ai-service-token-{}", hash(b"https://example.com"))
        );
        assert_ne!(
            account,
            format!("ai-api-key-{}", hash(b"https://example.com"))
        );
        assert_ne!(
            account,
            credential_account("https://other.example.com").unwrap()
        );
        let old_model_key = mock_entry(Some("dummy-provider-key"));
        let service_token = mock_entry(None);
        assert_eq!(
            required_service_token(&service_token).unwrap_err().code,
            "LOCAL_SERVICE_TOKEN_REQUIRED"
        );
        assert_eq!(
            secret(&old_model_key).unwrap().as_deref(),
            Some("dummy-provider-key")
        );
    }
    #[test]
    fn explicit_token_save_and_empty_token_clear_return_only_configuration_and_status() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        let cfg = config("https://service.example.com");
        let saved = store
            .save_settings_with(cfg.clone(), Some(" dummy-token ".into()), |_| {
                Ok(mock_entry(None))
            })
            .unwrap();
        assert_eq!(
            saved,
            json!({"config":{"service_url":"https://service.example.com"},"hasServiceToken":true})
        );
        let cleared = store
            .save_settings_with(cfg, Some(String::new()), |_| {
                Ok(mock_entry(Some("dummy-token")))
            })
            .unwrap();
        assert_eq!(cleared["hasServiceToken"], false);
        assert_eq!(
            store.connection_settings().unwrap().model_id.as_deref(),
            Some(SERVICE_MARKER)
        );
        let entry = mock_entry(Some("dummy-token"));
        persist_with_secret(&entry, None, || Ok(())).unwrap();
        assert!(secret(&entry).unwrap().is_none());
        persist_with_secret(&entry, None, || Ok(())).unwrap();
        assert_eq!(
            required_service_token(&entry).unwrap_err().code,
            "LOCAL_SERVICE_TOKEN_REQUIRED"
        );
        let columns = store
            .connect()
            .unwrap()
            .prepare("PRAGMA table_info(settings)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(columns, ["id", "base_url", "model_id", "locale"]);
    }
    #[test]
    fn failed_database_persistence_restores_the_previous_token() {
        for previous in [None, Some("dummy-old-token")] {
            let entry = mock_entry(previous);
            let error = persist_with_secret(&entry, Some("dummy-new-token"), || {
                Err("database-write-failed".into())
            })
            .unwrap_err();
            assert_eq!(error.message, "database-write-failed");
            assert_eq!(secret(&entry).unwrap().as_deref(), previous);
        }
        let entry = mock_entry(Some("dummy-old-token"));
        let mock = entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap();
        mock.set_error(keyring::Error::NoEntry);
        assert!(persist_with_secret(&entry, Some("dummy-new-token"), || Ok(())).is_ok());
    }
    #[test]
    fn credential_errors_do_not_leak_values_or_persist_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        let before = std::fs::read(store.db_path()).unwrap();
        let result = store.save_settings_with(
            config("https://service.example.com"),
            Some("dummy-new-token".into()),
            |_| {
                let entry = mock_entry(Some("dummy-old-token"));
                entry
                    .get_credential()
                    .downcast_ref::<keyring::mock::MockCredential>()
                    .unwrap()
                    .set_error(keyring::Error::Invalid(
                        "dummy-secret-detail".into(),
                        "failure".into(),
                    ));
                Ok(entry)
            },
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, "LOCAL_KEYCHAIN_READ");
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("dummy-secret"));
        assert_eq!(std::fs::read(store.db_path()).unwrap(), before);
    }
    #[test]
    fn legacy_and_service_marker_backups_restore_without_schema_migration() {
        let dir = tempfile::tempdir().unwrap();
        let source = Store::new(dir.path().join("source")).unwrap();
        let mut target = Store::new(dir.path().join("target")).unwrap();
        source.connect().unwrap().execute("UPDATE settings SET base_url='https://provider.example.com/v1',model_id='old-model'", []).unwrap();
        let legacy = dir.path().join("legacy.zip");
        source.backup(&legacy).unwrap();
        target.restore(&legacy).unwrap();
        assert_eq!(
            target.connection_settings().unwrap().model_id.as_deref(),
            Some("old-model")
        );
        assert_eq!(
            target.service_settings().unwrap(),
            ServiceSettings::default()
        );
        source
            .save_settings_with(
                config("https://service.example.com"),
                Some("dummy-secret-token".into()),
                |_| Ok(mock_entry(None)),
            )
            .unwrap();
        let service = dir.path().join("service.zip");
        source.backup(&service).unwrap();
        target.restore(&service).unwrap();
        assert_eq!(
            target.service_settings().unwrap(),
            config("https://service.example.com")
        );
        assert_eq!(
            crate::backup::validate_database_schema(&target.db_path()).unwrap(),
            11
        );
        assert!(!std::fs::read(target.db_path())
            .unwrap()
            .windows(b"dummy-secret-token".len())
            .any(|part| part == b"dummy-secret-token"));
    }
    #[test]
    fn settings_read_waits_for_restore_to_release_the_store() {
        use std::sync::mpsc;
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let source = Store::new(dir.path().join("source")).unwrap();
        source
            .save_settings_with(
                config("https://restored.example.com"),
                None,
                fail_credential,
            )
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
        assert_eq!(
            value["config"]["service_url"],
            "https://restored.example.com"
        );
        assert!(value["hasServiceToken"].is_null());
        worker.join().unwrap();
    }
    #[test]
    #[ignore = "uses an isolated native credential entry; run explicitly on the target OS"]
    fn native_keychain_roundtrip() {
        let entry = entry(
            &format!("com.practiq.test.{}", crate::store::id()),
            "https://example.com",
        )
        .unwrap();
        write_secret(&entry, Some("practiq-dummy-test-value")).unwrap();
        let read = required_service_token(&entry).unwrap();
        write_secret(&entry, None).unwrap();
        assert_eq!(read, "practiq-dummy-test-value");
        assert!(secret(&entry).unwrap().is_none());
    }
}
