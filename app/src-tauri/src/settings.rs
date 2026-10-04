use crate::{
    contract::Result,
    store::{hash, Store},
};
use keyring::Entry;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SERVICE_MARKER: &str = "urn:practiq:ai-service:v1";
const SERVICE_SETTINGS_FILE: &str = "service-settings-v1.sqlite";
const SERVICE_SETTINGS_SCHEMA: &str = "CREATE TABLE service_settings(id INTEGER PRIMARY KEY CHECK(id=1),active TEXT NOT NULL,pending TEXT)";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServiceSettingsBackup {
    pub version: u8,
    pub config: ServiceSettings,
}
impl ServiceSettingsBackup {
    pub(crate) fn validate(self) -> Result<ServiceSettings> {
        if self.version != 1 {
            return Err("Unsupported service settings backup version".into());
        }
        self.config.validate()
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PendingServiceRestore {
    candidate_sha256: String,
    previous: Option<ServiceSettings>,
    next: Option<ServiceSettings>,
}
#[derive(Default)]
struct ServiceSettingsState {
    active: Option<ServiceSettings>,
    pending: Option<PendingServiceRestore>,
}
fn settings_error(error: impl std::fmt::Display) -> crate::AppError {
    error.to_string().into()
}
fn empty_sidecar(db: &Connection) -> Result<bool> {
    db.execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(settings_error)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(settings_error)?;
    let objects: i64 = db
        .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
        .map_err(settings_error)?;
    Ok(version == 0 && objects == 0)
}
fn validate_sidecar(db: &Connection) -> Result<()> {
    db.execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(settings_error)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(settings_error)?;
    let objects: Vec<(String, String, String)> = db
        .prepare("SELECT type,name,COALESCE(sql,'') FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
        .map_err(settings_error)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(settings_error)?
        .collect::<std::result::Result<_, _>>()
        .map_err(settings_error)?;
    if version != 1
        || objects
            != [(
                "table".into(),
                "service_settings".into(),
                SERVICE_SETTINGS_SCHEMA.into(),
            )]
    {
        return Err("Unsupported service settings database".into());
    }
    Ok(())
}
fn read_sidecar(db: &Connection) -> Result<ServiceSettingsState> {
    let (active, pending): (String, Option<String>) = db
        .query_row(
            "SELECT active,pending FROM service_settings WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(settings_error)?;
    if active.len() > 4096 || pending.as_ref().is_some_and(|s| s.len() > 16384) {
        return Err("Service settings exceed their size limit".into());
    }
    let active: Option<ServiceSettings> = serde_json::from_str(&active).map_err(settings_error)?;
    let active = active.map(ServiceSettings::validate).transpose()?;
    let pending: Option<PendingServiceRestore> = pending
        .map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(settings_error)?;
    let pending = pending
        .map(|p| -> Result<_> {
            if p.candidate_sha256.len() != 64
                || !p
                    .candidate_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("Invalid service settings restore digest".into());
            }
            Ok(PendingServiceRestore {
                candidate_sha256: p.candidate_sha256,
                previous: p.previous.map(ServiceSettings::validate).transpose()?,
                next: p.next.map(ServiceSettings::validate).transpose()?,
            })
        })
        .transpose()?;
    Ok(ServiceSettingsState { active, pending })
}
fn write_sidecar(db: &Connection, state: ServiceSettingsState) -> Result<()> {
    db.execute(
        "UPDATE service_settings SET active=?1,pending=?2 WHERE id=1",
        params![
            serde_json::to_string(&state.active).map_err(settings_error)?,
            state
                .pending
                .map(|p| serde_json::to_string(&p))
                .transpose()
                .map_err(settings_error)?,
        ],
    )
    .map_err(settings_error)?;
    Ok(())
}
#[cfg(test)]
pub(crate) fn rollback_sync_checkpoint() {
    tests::ROLLBACK_SYNC_ERROR.with(|flag| {
        if flag.replace(false) {
            crate::filesystem::FAILURE
                .with(|failure| failure.set(Some(("sync", std::io::ErrorKind::StorageFull))));
        }
    });
}

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
    pub(crate) fn service_settings_path(&self) -> std::path::PathBuf {
        self.dir.join(SERVICE_SETTINGS_FILE)
    }
    fn sidecar_exists(&self) -> Result<bool> {
        match std::fs::symlink_metadata(self.service_settings_path()) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
            Ok(_) => Err("Service settings database must be a regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(settings_error(error)),
        }
    }
    fn sidecar_state(&self) -> Result<Option<ServiceSettingsState>> {
        if !self.sidecar_exists()? {
            return Ok(None);
        }
        let db = Connection::open_with_flags(
            self.service_settings_path(),
            // Existing SQLite rollback journals must recover after a killed write.
            // Never CREATE or initialize a database from this passive read path.
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(settings_error)?;
        // A killed first initialization can leave only an empty SQLite file.
        // Passive reads treat that state as absent, without writing its bytes.
        if empty_sidecar(&db)? {
            return Ok(None);
        }
        validate_sidecar(&db)?;
        read_sidecar(&db).map(Some)
    }
    fn update_sidecar(
        &self,
        update: impl FnOnce(ServiceSettingsState) -> Result<ServiceSettingsState>,
    ) -> Result<()> {
        self.sidecar_exists()?;
        let mut db = Connection::open(self.service_settings_path()).map_err(settings_error)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(settings_error)?;
        let transaction = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(settings_error)?;
        let initializing = empty_sidecar(&transaction)?;
        if initializing {
            transaction
                .execute_batch(SERVICE_SETTINGS_SCHEMA)
                .map_err(settings_error)?;
            transaction
                .execute_batch(
                    "INSERT INTO service_settings VALUES(1,'null',NULL); PRAGMA user_version=1;",
                )
                .map_err(settings_error)?;
        }
        validate_sidecar(&transaction)?;
        let state = update(read_sidecar(&transaction)?)?;
        write_sidecar(&transaction, state)?;
        #[cfg(test)]
        if initializing {
            tests::initialization_checkpoint();
        }
        transaction.commit().map_err(settings_error)
    }
    pub(crate) fn service_settings_override(&self) -> Result<Option<ServiceSettings>> {
        let Some(state) = self.sidecar_state()? else {
            return Ok(None);
        };
        if state.pending.is_some() {
            return Err("Service settings restoration is pending".into());
        }
        Ok(state.active)
    }
    pub(crate) fn prepare_service_settings_restore(
        &self,
        next: Option<ServiceSettings>,
        candidate_sha256: String,
    ) -> Result<()> {
        self.update_sidecar(|mut state| {
            if state.pending.is_some() {
                return Err("Service settings restoration is pending".into());
            }
            state.pending = Some(PendingServiceRestore {
                candidate_sha256,
                previous: state.active.clone(),
                next,
            });
            Ok(state)
        })?;
        self.service_settings_recovery_required.set(true);
        Ok(())
    }
    pub(crate) fn finish_service_settings_restore(&self, success: bool) -> Result<()> {
        self.update_sidecar(|mut state| {
            let pending = state
                .pending
                .take()
                .ok_or("Service settings restoration is not pending")?;
            state.active = if success {
                pending.next
            } else {
                pending.previous
            };
            Ok(state)
        })?;
        self.service_settings_recovery_required.set(false);
        Ok(())
    }
    /// Resolve a killed restore before opening the study database for any writes.
    pub(crate) fn recover_service_settings(&self) -> Result<()> {
        let Some(state) = self.sidecar_state()? else {
            return Ok(());
        };
        let Some(pending) = state.pending else {
            return Ok(());
        };
        // Let SQLite roll back an interrupted existing transaction before hashing
        // committed bytes. This handle cannot CREATE, initialize or alter schema.
        let db = Connection::open_with_flags(self.db_path(), OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(settings_error)?;
        db.execute_batch("PRAGMA trusted_schema=OFF;")
            .map_err(settings_error)?;
        db.query_row("PRAGMA schema_version", [], |r| r.get::<_, i64>(0))
            .map_err(settings_error)?;
        drop(db);
        crate::backup::validate_database_schema(&self.db_path())?;
        let published = crate::backup::file_digest(&self.db_path())?.1 == pending.candidate_sha256;
        self.finish_service_settings_restore(published)
    }
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
        if let Some(config) = self.service_settings_override()? {
            return Ok(config);
        }
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
            self.update_sidecar(|mut state| {
                if state.pending.is_some() {
                    return Err("Service settings restoration is pending".into());
                }
                state.active = Some(config.clone());
                Ok(state)
            })
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
    thread_local! {
        pub(super) static ROLLBACK_SYNC_ERROR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    pub(super) fn initialization_checkpoint() {
        if std::env::var("PRACTIQ_SERVICE_INITIALIZE_KILL").is_ok() {
            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "service initialization checkpoint").unwrap();
            stdout.flush().unwrap();
            drop(stdout);
            loop {
                std::thread::park();
            }
        }
    }

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

    fn seed_legacy(store: &Store) {
        store.connect().unwrap().execute(
            "UPDATE settings SET base_url='https://provider.example.com/v1',model_id='legacy-model',locale='en' WHERE id=1", [],
        ).unwrap();
    }
    #[test]
    fn repeated_service_url_changes_preserve_legacy_database_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        seed_legacy(&store);
        let before = std::fs::read(store.db_path()).unwrap();
        for url in [
            "https://first.example.com",
            "https://second.example.com",
            "https://second.example.com",
        ] {
            let cfg = config(url);
            store
                .save_settings_with(cfg.clone(), None, fail_credential)
                .unwrap();
            assert_eq!(store.service_settings().unwrap(), cfg);
            assert!(std::fs::read(store.db_path()).unwrap() == before);
        }
        assert_eq!(
            crate::backup::validate_database_schema(&store.db_path()).unwrap(),
            11
        );
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
    fn legacy_provider_settings_remain_unchanged_after_explicit_service_saves() {
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
        assert!(std::fs::read(store.db_path()).unwrap() == before);
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
            Some("legacy-model")
        );
        assert!(std::fs::read(store.db_path()).unwrap() == before);
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
        seed_legacy(&store);
        let before = std::fs::read(store.db_path()).unwrap();
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
        assert_eq!(
            raw.base_url.as_deref(),
            Some("https://provider.example.com/v1")
        );
        assert_eq!(raw.model_id.as_deref(), Some("legacy-model"));
        assert_eq!(
            store.service_settings().unwrap(),
            ServiceSettings::default()
        );
        assert!(std::fs::read(store.db_path()).unwrap() == before);
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
        assert!(std::fs::read(store.db_path()).unwrap() == before);
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
        seed_legacy(&store);
        let before = std::fs::read(store.db_path()).unwrap();
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
            Some("legacy-model")
        );
        assert!(std::fs::read(store.db_path()).unwrap() == before);
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
    struct SharedMockCredential(Arc<keyring::mock::MockCredential>);
    impl keyring::credential::CredentialApi for SharedMockCredential {
        fn set_secret(&self, value: &[u8]) -> keyring::Result<()> {
            self.0.set_secret(value)
        }
        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            self.0.get_secret()
        }
        fn delete_credential(&self) -> keyring::Result<()> {
            self.0.delete_credential()
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }
    #[test]
    fn failed_service_sidecar_save_rolls_back_mock_token_and_preserves_legacy_bytes() {
        use keyring::credential::CredentialApi;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        seed_legacy(&store);
        let before = std::fs::read(store.db_path()).unwrap();
        let blocked = store.dir.join("service-settings-v1.sqlite");
        std::fs::create_dir(&blocked).unwrap();
        let credential = Arc::new(keyring::mock::MockCredential::default());
        credential.set_password("dummy-old-token").unwrap();
        let result = store.save_settings_with(
            config("https://service.example.com"),
            Some("dummy-new-token".into()),
            |_| {
                Ok(Entry::new_with_credential(Box::new(SharedMockCredential(
                    credential.clone(),
                ))))
            },
        );
        assert!(result.is_err());
        assert_eq!(credential.get_password().unwrap(), "dummy-old-token");
        assert!(std::fs::read(store.db_path()).unwrap() == before);
        assert_eq!(
            store.connection_settings().unwrap().model_id.as_deref(),
            Some("legacy-model")
        );
    }
    #[test]
    fn pending_restore_rejects_service_save_and_rolls_back_mock_token() {
        use keyring::credential::CredentialApi;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        seed_legacy(&store);
        store
            .save_settings_with(config("https://old.example.com"), None, fail_credential)
            .unwrap();
        let before = std::fs::read(store.db_path()).unwrap();
        store
            .prepare_service_settings_restore(
                Some(config("https://new.example.com")),
                hash(&before),
            )
            .unwrap();
        let credential = Arc::new(keyring::mock::MockCredential::default());
        credential.set_password("dummy-old-token").unwrap();
        assert!(store
            .save_settings_with(
                config("https://other.example.com"),
                Some("dummy-new-token".into()),
                |_| {
                    Ok(Entry::new_with_credential(Box::new(SharedMockCredential(
                        credential.clone(),
                    ))))
                }
            )
            .is_err());
        assert_eq!(credential.get_password().unwrap(), "dummy-old-token");
        assert!(std::fs::read(store.db_path()).unwrap() == before);
        store.finish_service_settings_restore(false).unwrap();
        assert_eq!(
            store.service_settings().unwrap(),
            config("https://old.example.com")
        );
    }
    #[test]
    fn recovery_boundary_blocks_active_store_writes_until_restore_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        store
            .prepare_service_settings_restore(None, hash(&std::fs::read(store.db_path()).unwrap()))
            .unwrap();
        let before = std::fs::read(store.db_path()).unwrap();
        assert!(store.save_bank(None, "Blocked", "").is_err());
        assert!(std::fs::read(store.db_path()).unwrap() == before);
        store.finish_service_settings_restore(false).unwrap();
        store.save_bank(None, "Allowed", "").unwrap();
    }
    #[test]
    fn recovery_boundary_failed_rollback_sync_keeps_pending_and_blocks_offline_writes() {
        let dir = tempfile::tempdir().unwrap();
        let (mut target, archive) = service_restore_fixture(dir.path(), false);
        crate::filesystem::FAILURE
            .with(|f| f.set(Some(("restore-sync", std::io::ErrorKind::StorageFull))));
        ROLLBACK_SYNC_ERROR.with(|flag| flag.set(true));
        let error = target.restore(&archive).unwrap_err();
        crate::filesystem::FAILURE.with(|f| f.set(None));
        assert_eq!(error.code, "LOCAL_RESTORE_ROLLBACK_FAILED");
        assert!(target.sidecar_state().unwrap().unwrap().pending.is_some());
        let before = std::fs::read(target.db_path()).unwrap();
        assert!(target.save_bank(None, "Blocked", "").is_err());
        assert!(std::fs::read(target.db_path()).unwrap() == before);
        let reopened = Store::new(target.dir.clone()).unwrap();
        assert_eq!(
            reopened.service_settings().unwrap(),
            config("https://old.example.com")
        );
        assert_eq!(reopened.banks().unwrap()[0]["title"], "Previous");
        reopened.save_bank(None, "Allowed", "").unwrap();
    }
    #[test]
    fn unknown_or_corrupt_service_sidecars_are_not_reinitialized() {
        {
            let bytes = b"not-a-database".as_slice();
            let dir = tempfile::tempdir().unwrap();
            let store = Store::new(dir.path().to_owned()).unwrap();
            seed_legacy(&store);
            std::fs::write(store.service_settings_path(), bytes).unwrap();
            let before = std::fs::read(store.db_path()).unwrap();
            assert!(store.service_settings().is_err());
            assert!(store
                .save_settings_with(config("https://service.example.com"), None, fail_credential)
                .is_err());
            assert_eq!(std::fs::read(store.service_settings_path()).unwrap(), bytes);
            assert!(std::fs::read(store.db_path()).unwrap() == before);
        }
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        Connection::open(store.service_settings_path())
            .unwrap()
            .execute_batch("CREATE TABLE unknown(value TEXT); PRAGMA user_version=2;")
            .unwrap();
        let before = std::fs::read(store.service_settings_path()).unwrap();
        assert!(store.service_settings().is_err());
        assert!(store
            .save_settings_with(ServiceSettings::default(), None, fail_credential)
            .is_err());
        assert!(std::fs::read(store.service_settings_path()).unwrap() == before);
    }
    #[test]
    fn service_settings_backup_artifact_is_strict_and_versioned() {
        for value in [
            json!({"version":2,"config":{"service_url":null}}),
            json!({"version":1,"config":{"service_url":"http://example.com"}}),
            json!({"version":1,"config":{"service_url":null,"service_token":"dummy-token"}}),
            json!({"version":1,"config":{"service_url":null},"service_token":"dummy-token"}),
        ] {
            let result = serde_json::from_value::<ServiceSettingsBackup>(value)
                .map_err(settings_error)
                .and_then(ServiceSettingsBackup::validate);
            assert!(result.is_err());
        }
    }
    fn service_restore_fixture(
        root: &std::path::Path,
        identical_databases: bool,
    ) -> (Store, std::path::PathBuf) {
        let source = Store::new(root.join("source")).unwrap();
        let target = Store::new(root.join("target")).unwrap();
        seed_legacy(&source);
        seed_legacy(&target);
        if !identical_databases {
            source.save_bank(None, "Incoming", "").unwrap();
            target.save_bank(None, "Previous", "").unwrap();
        }
        source
            .save_settings_with(config("https://new.example.com"), None, fail_credential)
            .unwrap();
        target
            .save_settings_with(config("https://old.example.com"), None, fail_credential)
            .unwrap();
        let archive = root.join("incoming.zip");
        source.backup(&archive).unwrap();
        if identical_databases {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
            std::io::copy(
                &mut zip.by_name("practiq.sqlite").unwrap(),
                &mut std::fs::File::create(target.db_path()).unwrap(),
            )
            .unwrap();
        }
        (target, archive)
    }
    #[test]
    fn restore_sync_error_keeps_previous_service_url_even_for_identical_database_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (mut target, archive) = service_restore_fixture(dir.path(), true);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        let mut incoming = Vec::new();
        std::io::Read::read_to_end(&mut zip.by_name("practiq.sqlite").unwrap(), &mut incoming)
            .unwrap();
        assert!(std::fs::read(target.db_path()).unwrap() == incoming);
        crate::filesystem::FAILURE
            .with(|f| f.set(Some(("restore-sync", std::io::ErrorKind::StorageFull))));
        assert!(target.restore(&archive).is_err());
        assert_eq!(
            target.service_settings().unwrap(),
            config("https://old.example.com")
        );
        assert_eq!(
            Store::new(target.dir.clone())
                .unwrap()
                .service_settings()
                .unwrap(),
            config("https://old.example.com")
        );
        target.restore(&archive).unwrap();
        assert_eq!(
            target.service_settings().unwrap(),
            config("https://new.example.com")
        );
        assert_eq!(
            target.connection_settings().unwrap().model_id.as_deref(),
            Some("legacy-model")
        );
    }
    #[test]
    #[ignore = "subprocess entry point; invoked only by the disposable killed restore test"]
    fn service_restore_child() {
        let root = std::env::var("PRACTIQ_SERVICE_RESTORE_TEST_ROOT").unwrap();
        if std::env::var("PRACTIQ_SERVICE_INITIALIZE_KILL").is_ok() {
            let store = Store::new(std::path::Path::new(&root).join("target")).unwrap();
            store
                .save_settings_with(config("https://new.example.com"), None, fail_credential)
                .unwrap();
        }
        if let Ok(mode) = std::env::var("PRACTIQ_SERVICE_SIDECAR_JOURNAL") {
            use std::io::Write;
            let store = Store::new(std::path::Path::new(&root).join("target")).unwrap();
            let (path, sql) = if mode == "main" {
                store
                    .prepare_service_settings_restore(
                        Some(config("https://new.example.com")),
                        "f".repeat(64),
                    )
                    .unwrap();
                (store.db_path(), "PRAGMA cache_size=1; BEGIN IMMEDIATE; CREATE TABLE uncommitted_payload(value BLOB); INSERT INTO uncommitted_payload VALUES(zeroblob(100000));")
            } else {
                (store.service_settings_path(), "PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE service_settings SET active=lower(hex(zeroblob(100000)));")
            };
            let db = Connection::open(path).unwrap();
            db.execute_batch(sql).unwrap();
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "service sidecar checkpoint").unwrap();
            stdout.flush().unwrap();
            drop(stdout);
            loop {
                std::thread::park();
            }
        }
        Store::new(std::path::Path::new(&root).join("target"))
            .unwrap()
            .restore(&std::path::Path::new(&root).join("incoming.zip"))
            .unwrap();
    }
    #[test]
    fn recovery_boundary_killed_first_sidecar_initialization_preserves_offline_startup() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
            time::Duration,
        };
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("target")).unwrap();
        seed_legacy(&store);
        let before = std::fs::read(store.db_path()).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "settings::tests::service_restore_child",
                "--nocapture",
                "--ignored",
            ])
            .env("PRACTIQ_SERVICE_RESTORE_TEST_ROOT", dir.path())
            .env("PRACTIQ_SERVICE_INITIALIZE_KILL", "1")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (ready, result) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let reached = BufReader::new(stdout).lines().any(|line| {
                line.is_ok_and(|line| line.ends_with("service initialization checkpoint"))
            });
            let _ = ready.send(reached);
        });
        let reached = result
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or(false);
        let _ = child.kill();
        child.wait().unwrap();
        reader.join().unwrap();
        assert!(reached);
        let empty = std::fs::read(store.service_settings_path()).unwrap();
        let reopened = Store::new(store.dir.clone()).unwrap();
        assert_eq!(
            reopened.service_settings().unwrap(),
            ServiceSettings::default()
        );
        assert!(std::fs::read(store.db_path()).unwrap() == before);
        assert!(std::fs::read(store.service_settings_path()).unwrap() == empty);
        reopened
            .save_settings_with(config("https://saved.example.com"), None, fail_credential)
            .unwrap();
        assert_eq!(
            reopened.service_settings().unwrap(),
            config("https://saved.example.com")
        );
        assert!(std::fs::read(store.db_path()).unwrap() == before);
    }
    #[test]
    fn killed_sqlite_writes_recover_journals_before_resolving_service_settings() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
            time::Duration,
        };
        for mode in ["sidecar", "main"] {
            let dir = tempfile::tempdir().unwrap();
            let store = Store::new(dir.path().join("target")).unwrap();
            seed_legacy(&store);
            store
                .save_settings_with(config("https://old.example.com"), None, fail_credential)
                .unwrap();
            let before = std::fs::read(store.db_path()).unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "settings::tests::service_restore_child",
                    "--nocapture",
                    "--ignored",
                ])
                .env("PRACTIQ_SERVICE_RESTORE_TEST_ROOT", dir.path())
                .env("PRACTIQ_SERVICE_SIDECAR_JOURNAL", mode)
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let (ready, result) = mpsc::channel();
            let reader = std::thread::spawn(move || {
                let reached = BufReader::new(stdout).lines().any(|line| {
                    line.is_ok_and(|line| line.ends_with("service sidecar checkpoint"))
                });
                let _ = ready.send(reached);
            });
            let reached = result
                .recv_timeout(Duration::from_secs(20))
                .unwrap_or(false);
            let _ = child.kill();
            child.wait().unwrap();
            reader.join().unwrap();
            assert!(reached);
            let journal = if mode == "main" {
                store.db_path()
            } else {
                store.service_settings_path()
            }
            .with_extension("sqlite-journal");
            assert!(journal.exists());
            let reopened = Store::new(store.dir.clone()).unwrap();
            assert_eq!(
                reopened.service_settings().unwrap(),
                config("https://old.example.com")
            );
            assert!(std::fs::read(store.db_path()).unwrap() == before);
        }
    }
    #[test]
    fn killed_restore_recovers_service_url_before_first_offline_database_write() {
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            sync::mpsc,
            time::Duration,
        };
        for phase in ["before-publish", "after-publish"] {
            let dir = tempfile::tempdir().unwrap();
            service_restore_fixture(dir.path(), false);
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "settings::tests::service_restore_child",
                    "--nocapture",
                    "--ignored",
                ])
                .env("PRACTIQ_SERVICE_RESTORE_TEST_ROOT", dir.path())
                .env("PRACTIQ_RESTORE_KILL_PHASE", phase)
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let checkpoint = format!("restore checkpoint: {phase}");
            let (ready, result) = mpsc::channel();
            let reader = std::thread::spawn(move || {
                let reached = BufReader::new(stdout)
                    .lines()
                    .any(|line| line.is_ok_and(|line| line.ends_with(&checkpoint)));
                let _ = ready.send(reached);
            });
            let reached = result
                .recv_timeout(Duration::from_secs(20))
                .unwrap_or(false);
            let _ = child.kill();
            child.wait().unwrap();
            reader.join().unwrap();
            assert!(reached, "restore did not reach {phase}");
            let store = Store::new(dir.path().join("target")).unwrap();
            let incoming = phase == "after-publish";
            assert_eq!(
                store.banks().unwrap()[0]["title"],
                if incoming { "Incoming" } else { "Previous" }
            );
            store.save_bank(None, "Offline first", "").unwrap();
            assert_eq!(
                store.service_settings().unwrap(),
                config(if incoming {
                    "https://new.example.com"
                } else {
                    "https://old.example.com"
                })
            );
            assert_eq!(
                store.connection_settings().unwrap().model_id.as_deref(),
                Some("legacy-model")
            );
        }
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
        assert!(std::fs::read(store.db_path()).unwrap() == before);
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
            target.connection_settings().unwrap().model_id.as_deref(),
            Some("old-model")
        );
        assert_eq!(
            target.connection_settings().unwrap().base_url.as_deref(),
            Some("https://provider.example.com/v1")
        );
        target.restore(&legacy).unwrap();
        assert_eq!(
            target.service_settings().unwrap(),
            ServiceSettings::default()
        );
        assert_eq!(
            target.connection_settings().unwrap().model_id.as_deref(),
            Some("old-model")
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
    fn old_service_marker_backup_and_explicit_clear_overlay_restore_independently() {
        let dir = tempfile::tempdir().unwrap();
        let source = Store::new(dir.path().join("source")).unwrap();
        source.connect().unwrap().execute(
            "UPDATE settings SET base_url='https://old-service.example.com',model_id=?1 WHERE id=1", [SERVICE_MARKER],
        ).unwrap();
        let mut target = Store::new(dir.path().join("target")).unwrap();
        target
            .save_settings_with(config("https://other.example.com"), None, fail_credential)
            .unwrap();
        let old_backup = dir.path().join("old-marker.zip");
        source.backup(&old_backup).unwrap();
        assert!(!source.service_settings_path().exists());
        target.restore(&old_backup).unwrap();
        assert_eq!(
            target.service_settings().unwrap(),
            config("https://old-service.example.com")
        );
        let before = std::fs::read(target.db_path()).unwrap();
        target
            .save_settings_with(ServiceSettings::default(), None, fail_credential)
            .unwrap();
        assert!(std::fs::read(target.db_path()).unwrap() == before);
        assert_eq!(
            target.service_settings().unwrap(),
            ServiceSettings::default()
        );
        let cleared_backup = dir.path().join("cleared.zip");
        target.backup(&cleared_backup).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&cleared_backup).unwrap()).unwrap();
        assert_eq!(zip.len(), 2);
        let manifest: Value =
            serde_json::from_reader(zip.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(
            manifest["serviceSettings"],
            json!({"version":1,"config":{"service_url":null}})
        );
        assert_eq!(
            target
                .backup(&target.service_settings_path())
                .unwrap_err()
                .code,
            "LOCAL_BACKUP_OVERWRITE"
        );
        target
            .save_settings_with(
                config("https://replacement.example.com"),
                None,
                fail_credential,
            )
            .unwrap();
        target.restore(&cleared_backup).unwrap();
        assert_eq!(
            target.service_settings().unwrap(),
            ServiceSettings::default()
        );
        assert_eq!(
            target.connection_settings().unwrap().model_id.as_deref(),
            Some(SERVICE_MARKER)
        );
        assert_eq!(
            target.connection_settings().unwrap().base_url.as_deref(),
            Some("https://old-service.example.com")
        );
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
