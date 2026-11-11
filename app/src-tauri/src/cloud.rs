//! Origin-bound customer sessions. Passwords/cookies never become WebView storage.
use crate::{contract::Result, credentials::Credential, AppError};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{blocking::Client, header, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, io::Read, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager};

const CONFIG: &str = "account-service-v1.json";
pub(crate) const MAX_RESPONSE: usize = 64 * 1024 * 1024;

fn request_timeout(path: &str) -> Duration {
    Duration::from_secs(if path == "/api/subjective-grades" {
        900
    } else if path.contains("/export?") {
        600
    } else {
        125
    })
}

pub(crate) fn error(code: &str) -> AppError {
    AppError::new(
        code,
        "云端操作未完成，请检查连接并查询原记录；请勿重复提交。",
    )
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Config {
    version: u8,
    origin: String,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Secret {
    cookie: String,
    csrf: String,
}

pub(crate) struct Cloud {
    pub(crate) origin: Option<String>,
    secret: Secret,
    authenticated: bool,
    loaded: bool,
    pub(crate) epoch: u64,
    invalid: bool,
    pub(crate) sources: HashMap<String, super::cloud_files::Source>,
    pub(crate) checkouts: Vec<tempfile::NamedTempFile>,
}
pub(crate) struct State {
    pub(crate) inner: Mutex<Cloud>,
    auth: Mutex<()>,
    dir: PathBuf,
    client: Option<Client>,
}

pub(crate) fn origin(raw: &str) -> Result<String> {
    let validated = crate::settings::ServiceSettings {
        service_url: Some(raw.into()),
        model: None,
    }
    .validate()?;
    let value = validated
        .service_url
        .ok_or_else(|| error("CLOUD_ORIGIN_REQUIRED"))?;
    let url = url::Url::parse(&value).map_err(|_| error("CLOUD_ORIGIN_INVALID"))?;
    if url.path() != "/" {
        return Err(error("CLOUD_ORIGIN_INVALID"));
    }
    Ok(value)
}
fn account(origin: &str) -> String {
    format!(
        "ai-account-session-v1-{}",
        crate::store::hash(origin.as_bytes())
    )
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Context {
    pub(crate) origin: String,
    pub(crate) generation: u64,
}

fn validate_context(state: &Cloud, context: &Context, refresh: bool) -> Result<()> {
    if state.origin.as_deref() != Some(&context.origin)
        || (!refresh && context.generation != state.epoch)
    {
        return Err(error("CLOUD_ACCOUNT_CHANGED"));
    }
    Ok(())
}

fn credential(app: &AppHandle, origin: &str) -> Result<Box<dyn Credential>> {
    crate::credentials::entry(app, &account(origin))
}

impl State {
    pub(crate) fn new(dir: PathBuf) -> Self {
        let config = match std::fs::File::open(dir.join(CONFIG)).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(4097).read_to_end(&mut bytes)?;
            Ok(bytes)
        }) {
            Ok(bytes) if bytes.len() <= 4096 => serde_json::from_slice::<Config>(&bytes)
                .ok()
                .filter(|value| value.version == 1)
                .and_then(|value| origin(&value.origin).ok())
                .ok_or(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            _ => Err(()),
        };
        Self {
            auth: Mutex::new(()),
            dir,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok(),
            inner: Mutex::new(Cloud {
                origin: config.as_ref().ok().filter(|v| !v.is_empty()).cloned(),
                invalid: config.is_err(),
                secret: Secret::default(),
                authenticated: false,
                loaded: false,
                epoch: 0,
                sources: HashMap::new(),
                checkouts: Vec::new(),
            }),
        }
    }
    pub(crate) fn lock(&self) -> Result<std::sync::MutexGuard<'_, Cloud>> {
        self.inner.lock().map_err(|_| error("CLOUD_UNAVAILABLE"))
    }
    fn configure(&self, value: String) -> Result<Value> {
        let value = origin(&value)?;
        let mut state = self.lock()?;
        if state.invalid {
            return Err(error("CLOUD_CONFIG_INVALID"));
        }
        let mut file =
            tempfile::NamedTempFile::new_in(&self.dir).map_err(|_| error("CLOUD_CONFIG_WRITE"))?;
        serde_json::to_writer(
            &mut file,
            &Config {
                version: 1,
                origin: value.clone(),
            },
        )
        .map_err(|_| error("CLOUD_CONFIG_WRITE"))?;
        crate::filesystem::persist(file, &self.dir.join(CONFIG), true)
            .map_err(|_| error("CLOUD_CONFIG_WRITE"))?;
        state.origin = Some(value.clone());
        state.secret = Secret::default();
        state.authenticated = false;
        state.loaded = false;
        state.sources.clear();
        state.epoch += 1;
        Ok(json!({"origin":value,"generation":state.epoch}))
    }
    pub(crate) fn context(&self) -> Result<Option<Context>> {
        let state = self.lock()?;
        if state.invalid {
            return Err(error("CLOUD_CONFIG_INVALID"));
        }
        Ok(state.origin.clone().map(|origin| Context {
            origin,
            generation: state.epoch,
        }))
    }
    pub(crate) fn snapshot(
        &self,
        app: &AppHandle,
        context: &Context,
        refresh: bool,
    ) -> Result<Snapshot> {
        let mut state = self.lock()?;
        if state.invalid {
            return Err(error("CLOUD_CONFIG_INVALID"));
        }
        let origin = state
            .origin
            .clone()
            .ok_or_else(|| error("CLOUD_ORIGIN_REQUIRED"))?;
        validate_context(&state, context, refresh)?;
        if !state.loaded {
            if let Some(value) = credential(app, &origin)?.read()? {
                if value.len() > 2048 {
                    return Err(error("CLOUD_CREDENTIAL_INVALID"));
                }
                let secret: Secret =
                    serde_json::from_str(&value).map_err(|_| error("CLOUD_CREDENTIAL_INVALID"))?;
                validate_secret(&secret)?;
                state.authenticated = !secret.cookie.is_empty();
                state.secret = secret;
            }
            state.loaded = true;
        }
        Ok(Snapshot {
            origin,
            secret: state.secret.clone(),
            authenticated: state.authenticated,
            epoch: state.epoch,
            client: self
                .client
                .clone()
                .ok_or_else(|| error("CLOUD_UNAVAILABLE"))?,
        })
    }
    pub(crate) fn current(&self, snapshot: &Snapshot) -> Result<()> {
        self.current_guard(snapshot).map(drop)
    }
    pub(crate) fn current_guard(
        &self,
        snapshot: &Snapshot,
    ) -> Result<std::sync::MutexGuard<'_, Cloud>> {
        let state = self.lock()?;
        if state.epoch != snapshot.epoch
            || state.origin.as_deref() != Some(&snapshot.origin)
            || state.secret.cookie != snapshot.secret.cookie
            || state.authenticated != snapshot.authenticated
        {
            return Err(error("CLOUD_ACCOUNT_CHANGED"));
        }
        Ok(state)
    }
    fn clear(&self, snapshot: &Snapshot, credential: &dyn Credential) -> Result<()> {
        let mut state = self.lock()?;
        if state.epoch != snapshot.epoch || state.origin.as_deref() != Some(&snapshot.origin) {
            return Err(error("CLOUD_ACCOUNT_CHANGED"));
        }
        credential.write(None)?;
        state.secret = Secret::default();
        state.authenticated = false;
        state.epoch += 1;
        state.sources.clear();
        Ok(())
    }
    fn accept(
        &self,
        snapshot: &Snapshot,
        cookie: Option<String>,
        mut value: Value,
        credential: &dyn Credential,
    ) -> Result<Value> {
        let secret = Secret {
            cookie: cookie.unwrap_or_else(|| snapshot.secret.cookie.clone()),
            csrf: value["csrf"]
                .as_str()
                .ok_or_else(|| error("CLOUD_RESPONSE_INVALID"))?
                .into(),
        };
        validate_secret(&secret)?;
        let encoded =
            serde_json::to_string(&secret).map_err(|_| error("CLOUD_CREDENTIAL_INVALID"))?;
        let mut state = self.lock()?;
        if state.epoch != snapshot.epoch || state.origin.as_deref() != Some(&snapshot.origin) {
            return Err(error("CLOUD_ACCOUNT_CHANGED"));
        }
        credential.write((!value["user"].is_null()).then_some(encoded.as_str()))?;
        let authenticated = !value["user"].is_null();
        if state.secret.cookie != secret.cookie || state.authenticated != authenticated {
            state.epoch += 1;
            state.sources.clear();
        }
        state.secret = secret;
        state.authenticated = authenticated;
        value["csrf"] = json!("");
        Ok(value)
    }
}
fn validate_secret(secret: &Secret) -> Result<()> {
    let cookie = secret
        .cookie
        .split_once('=')
        .filter(|(name, _)| matches!(*name, "practiq_session" | "__Host-practiq_session"));
    if !cookie.is_some_and(|(_, value)| {
        !value.is_empty()
            && value.len() <= 256
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }) || secret.csrf.len() != 64
        || !secret.csrf.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(error("CLOUD_CREDENTIAL_INVALID"));
    }
    Ok(())
}
pub(crate) struct Snapshot {
    pub(crate) origin: String,
    secret: Secret,
    authenticated: bool,
    epoch: u64,
    client: Client,
}
impl Snapshot {
    pub(crate) fn has_session(&self) -> bool {
        self.authenticated
    }
    pub(crate) fn redact(&self, value: Value) -> Value {
        let value = crate::ai::redact(value, &self.secret.cookie);
        let token = self
            .secret
            .cookie
            .split_once('=')
            .map_or("", |(_, token)| token);
        crate::ai::redact(crate::ai::redact(value, token), &self.secret.csrf)
    }
    pub(crate) fn identity(&self) -> String {
        crate::store::hash(self.secret.cookie.as_bytes())
    }
    pub(crate) fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        bytes: Option<(Vec<u8>, String)>,
    ) -> Result<reqwest::blocking::Response> {
        validate_path(path, &method)?;
        let url = url::Url::parse(&origin(&self.origin)?)
            .and_then(|base| base.join(path))
            .map_err(|_| error("CLOUD_PATH_INVALID"))?;
        let mut request = self
            .client
            .request(method, url)
            .timeout(request_timeout(path));
        if !self.secret.cookie.is_empty() {
            request = request
                .header(header::COOKIE, &self.secret.cookie)
                .header("X-CSRF-Token", &self.secret.csrf);
        }
        if let Some(value) = body {
            request = request.json(&value);
        }
        if let Some((value, media)) = bytes {
            request = request.header(header::CONTENT_TYPE, media).body(value);
        }
        request.send().map_err(|_| error("CLOUD_RESULT_UNKNOWN"))
    }
}

pub(crate) fn validate_path(path: &str, method: &Method) -> Result<()> {
    if path.len() > 64 * 1024
        || !path.starts_with("/api/")
        || path.contains(['#', '\\', '\r', '\n'])
    {
        return Err(error("CLOUD_PATH_INVALID"));
    }
    let url = url::Url::parse(&format!("https://cloud.invalid{path}"))
        .map_err(|_| error("CLOUD_PATH_INVALID"))?;
    if url.path() != path.split('?').next().unwrap_or("") || url.path().contains('%') {
        return Err(error("CLOUD_PATH_INVALID"));
    }
    let p = url.path();
    let allowed = match p {
        "/api/auth/session" => method == Method::GET,
        "/api/auth/login"
        | "/api/auth/register"
        | "/api/auth/logout"
        | "/api/auth/reset-password" => method == Method::POST,
        "/api/me/profile" => method == Method::PATCH,
        "/api/me/usage" | "/api/me/banks" | "/api/me/sessions" | "/api/import-capabilities" => {
            method == Method::GET
        }
        "/api/me/tokens" | "/api/me/payments" => method == Method::GET || method == Method::POST,
        "/api/me/payments/offer" | "/api/me/plans" => method == Method::GET,
        "/api/import-settings" => method == Method::GET || method == Method::PUT,
        "/api/uploads" | "/api/artifacts/read" | "/api/subjective-grades" => method == Method::POST,
        "/api/uploads/content" => method == Method::PUT,
        "/api/document-tasks" => method == Method::GET || method == Method::POST,
        _ => {
            let parts: Vec<_> = p.split('/').collect();
            if parts.len() == 5
                && parts[1..3] == ["api", "me"]
                && matches!(parts[3], "sessions" | "tokens")
            {
                method == Method::DELETE
                    && !parts[4].is_empty()
                    && parts[4].len() <= 128
                    && parts[4]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            } else if parts.len() >= 4
                && parts[1..3] == ["api", "document-tasks"]
                && uuid::Uuid::parse_str(parts[3]).is_ok()
            {
                (parts.len() == 4 && (method == Method::GET || method == Method::DELETE))
                    || (parts.len() == 5
                        && match parts[4] {
                            "head" | "preview" | "export" | "answer-matches"
                            | "answer-proposal" => method == Method::GET,
                            "control" | "reparse" => method == Method::POST,
                            "corrections" => method == Method::GET || method == Method::PUT,
                            _ => false,
                        })
            } else if parts.len() >= 5
                && parts[1..4] == ["api", "me", "payments"]
                && parts[4].len() == 32
                && parts[4].bytes().all(|b| b.is_ascii_hexdigit())
            {
                (parts.len() == 5 && method == Method::GET)
                    || (parts.len() == 6
                        && matches!(parts[5], "query" | "close" | "form")
                        && method == Method::POST)
            } else {
                false
            }
        }
    };
    if !allowed {
        return Err(error("CLOUD_PATH_INVALID"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Status,
    ForgetSession,
    Confirm {
        message: String,
    },
    Configure {
        origin: String,
    },
    Fetch {
        path: String,
        method: String,
        body: Option<Value>,
    },
    PickSources,
    Upload {
        ticket: String,
    },
    Download {
        path: String,
        name: String,
    },
    Save {
        bytes: String,
        name: String,
    },
    Checkout {
        request_id: String,
        order_id: Option<String>,
        product_id: Option<String>,
    },
}

pub(crate) fn fetch(
    app: &AppHandle,
    state: &State,
    context: &Context,
    path: &str,
    method: Method,
    body: Option<Value>,
) -> Result<Value> {
    // Session reads also rotate anonymous CSRF cookies; serialize auth exchanges.
    let _auth = if path.starts_with("/api/auth/") {
        Some(state.auth.lock().map_err(|_| error("CLOUD_UNAVAILABLE"))?)
    } else {
        None
    };
    if body
        .as_ref()
        .is_some_and(|v| v.to_string().len() > MAX_RESPONSE)
    {
        return Err(error("CLOUD_REQUEST_TOO_LARGE"));
    }
    let snapshot = state.snapshot(
        app,
        context,
        path == "/api/auth/session" && method == Method::GET,
    )?;
    let logout = path.split('?').next() == Some("/api/auth/logout");
    let result = (|| {
        let response = snapshot.send(method, path, body, None)?;
        let status = response.status().as_u16();
        let media_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let cookie_name = if snapshot.origin.starts_with("https://") {
            "__Host-practiq_session="
        } else {
            "practiq_session="
        };
        let cookie = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .find_map(|v| v.split(';').next().filter(|v| v.starts_with(cookie_name)))
            .map(str::to_owned);
        let mut bytes = read_response(response)?;
        state.current(&snapshot)?;
        if matches!(
            path.split('?').next().unwrap_or(""),
            "/api/auth/session" | "/api/auth/login" | "/api/auth/register"
        ) && (200..300).contains(&status)
        {
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| error("CLOUD_RESPONSE_INVALID"))?;
            let value = state.accept(
                &snapshot,
                cookie,
                value,
                &credential(app, &snapshot.origin)?,
            )?;
            bytes = serde_json::to_vec(&value).map_err(|_| error("CLOUD_RESPONSE_INVALID"))?;
        } else if (status == 401
            && !matches!(
                path.split('?').next(),
                Some("/api/auth/login" | "/api/auth/register")
            ))
            && !logout
        {
            state.clear(&snapshot, &credential(app, &snapshot.origin)?)?;
        }
        Ok(json!({"status":status,"mediaType":media_type,"bytes":STANDARD.encode(bytes)}))
    })();
    if logout {
        finish_logout(
            state,
            &snapshot,
            &credential(app, &snapshot.origin)?,
            result,
        )
    } else {
        result
    }
}

fn finish_logout<T>(
    state: &State,
    snapshot: &Snapshot,
    credential: &dyn Credential,
    result: Result<T>,
) -> Result<T> {
    state.clear(snapshot, credential)?;
    result
}

fn read_response(response: reqwest::blocking::Response) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("CLOUD_RESPONSE_INVALID"))?;
    if bytes.len() > MAX_RESPONSE {
        return Err(error("CLOUD_RESPONSE_TOO_LARGE"));
    }
    Ok(bytes)
}

pub(crate) fn request(app: AppHandle, value: Request, context: Option<Context>) -> Result<Value> {
    let state = app.state::<State>();
    let bound = || {
        context
            .as_ref()
            .ok_or_else(|| error("CLOUD_ACCOUNT_CHANGED"))
    };
    match value {
        Request::Status => {
            let state = state.lock()?;
            if state.invalid {
                return Err(error("CLOUD_CONFIG_INVALID"));
            }
            Ok(json!({"origin":state.origin,"generation":state.epoch}))
        }
        Request::Configure { origin } => state.configure(origin),
        Request::ForgetSession => {
            let context = bound()?;
            let snapshot = {
                let value = state.lock()?;
                let origin = value
                    .origin
                    .clone()
                    .ok_or_else(|| error("CLOUD_ORIGIN_REQUIRED"))?;
                if origin != context.origin || value.epoch != context.generation {
                    return Err(error("CLOUD_ACCOUNT_CHANGED"));
                }
                Snapshot {
                    origin,
                    secret: Secret::default(),
                    authenticated: value.authenticated,
                    epoch: value.epoch,
                    client: state
                        .client
                        .clone()
                        .ok_or_else(|| error("CLOUD_UNAVAILABLE"))?,
                }
            };
            state.clear(&snapshot, &credential(&app, &snapshot.origin)?)?;
            Ok(Value::Null)
        }
        Request::Fetch { path, method, body } => {
            let method =
                Method::from_bytes(method.as_bytes()).map_err(|_| error("CLOUD_PATH_INVALID"))?;
            if path.starts_with("/api/uploads") || path.contains("/export?") {
                return Err(error("CLOUD_PATH_INVALID"));
            }
            fetch(&app, &state, bound()?, &path, method, body)
        }
        Request::Confirm { message } => {
            super::cloud_files::confirm(&app, &state, bound()?, &message)
        }
        Request::PickSources => super::cloud_files::pick(&app, &state, bound()?),
        Request::Upload { ticket } => super::cloud_files::upload(&app, &state, bound()?, &ticket),
        Request::Download { path, name } => {
            super::cloud_files::download(&app, &state, bound()?, &path, &name)
        }
        Request::Save { bytes, name } => {
            super::cloud_files::save(&app, &state, bound()?, &name, &bytes)
        }
        Request::Checkout {
            request_id,
            order_id,
            product_id,
        } => super::cloud_files::checkout(
            &app,
            &state,
            bound()?,
            &request_id,
            order_id.as_deref(),
            product_id.as_deref(),
        ),
    }
}

#[cfg(test)]
pub(crate) fn test_account(dir: &std::path::Path, origin: &str, token: &str) -> (State, Snapshot) {
    let state = State::new(dir.to_path_buf());
    state.configure(origin.to_owned()).unwrap();
    let mut current = state.lock().unwrap();
    current.secret = Secret {
        cookie: format!("practiq_session={token}"),
        csrf: "a".repeat(64),
    };
    validate_secret(&current.secret).unwrap();
    current.loaded = true;
    current.authenticated = true;
    let snapshot = Snapshot {
        origin: origin.into(),
        secret: current.secret.clone(),
        authenticated: current.authenticated,
        epoch: current.epoch,
        client: state.client.clone().unwrap(),
    };
    drop(current);
    (state, snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn snapshot(state: &State) -> Snapshot {
        let current = state.lock().unwrap();
        Snapshot {
            origin: current.origin.clone().unwrap(),
            secret: current.secret.clone(),
            authenticated: current.authenticated,
            epoch: current.epoch,
            client: state.client.clone().unwrap(),
        }
    }
    fn test_credential() -> keyring::Entry {
        keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
    }
    #[test]
    fn export_paths_cover_the_supported_two_thousand_question_selection() {
        let mut path = "/api/document-tasks/11111111-1111-4111-8111-111111111111/export?checkpoint_id=checkpoint&scope=full".to_owned();
        for index in 0..2000 {
            path.push_str(&format!("&question_index={index}"));
        }
        assert!(path.len() > 16 * 1024 && path.len() < 64 * 1024);
        assert!(validate_path(&path, &Method::GET).is_ok());
        path.push_str(&"x".repeat(64 * 1024));
        assert!(validate_path(&path, &Method::GET).is_err());
    }
    #[test]
    fn logout_clears_credentials_when_a_response_body_is_truncated_or_oversized() {
        use std::net::TcpListener;
        for headers in [
            "Content-Length: 100",
            "Content-Length: 67108865",
            "Transfer-Encoding: chunked",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let headers = headers.to_owned();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).unwrap() > 0);
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 502 Bad Gateway\r\n{headers}\r\nConnection: close\r\n\r\nx"
                        )
                        .as_bytes(),
                    )
                    .unwrap();
            });
            let dir = tempfile::tempdir().unwrap();
            let state = State::new(dir.path().into());
            state.configure(format!("http://{address}")).unwrap();
            state.lock().unwrap().secret = Secret {
                cookie: "practiq_session=retained".into(),
                csrf: "a".repeat(64),
            };
            let before = snapshot(&state);
            let entry = test_credential();
            entry.write(Some("retained")).unwrap();
            let response = before
                .send(Method::POST, "/api/auth/logout", None, None)
                .unwrap();
            let result = read_response(response);
            assert!(result.is_err());
            assert!(finish_logout(&state, &before, &entry, result).is_err());
            assert!(entry.read().unwrap().is_none());
            assert!(state.lock().unwrap().secret.cookie.is_empty());
            server.join().unwrap();
        }
    }
    #[test]
    fn failed_logout_does_not_clear_a_newer_account_session() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state.configure("https://cloud.test".into()).unwrap();
        let before = snapshot(&state);
        let entry = test_credential();
        state
            .accept(
                &before,
                Some("__Host-practiq_session=new-login".into()),
                json!({"user":{"id":"new-user"},"csrf":"a".repeat(64)}),
                &entry,
            )
            .unwrap();
        let result: Result<Vec<u8>> = Err(error("CLOUD_RESPONSE_INVALID"));
        assert_eq!(
            finish_logout(&state, &before, &entry, result)
                .unwrap_err()
                .code,
            "CLOUD_ACCOUNT_CHANGED"
        );
        assert!(entry.read().unwrap().unwrap().contains("new-login"));
    }
    #[test]
    fn queued_actions_are_bound_to_the_origin_and_session_generation() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state.configure("https://first.test".into()).unwrap();
        let context = Context {
            origin: "https://first.test".into(),
            generation: state.lock().unwrap().epoch,
        };
        assert!(validate_context(&state.lock().unwrap(), &context, false).is_ok());
        state.lock().unwrap().epoch += 1;
        assert!(validate_context(&state.lock().unwrap(), &context, false).is_err());
        assert!(validate_context(&state.lock().unwrap(), &context, true).is_ok());
        state.configure("https://second.test".into()).unwrap();
        assert!(validate_context(&state.lock().unwrap(), &context, true).is_err());
    }
    #[test]
    fn anonymous_csrf_cookie_is_memory_only_and_can_be_replaced_by_login() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state.configure("https://cloud.test".into()).unwrap();
        let entry = test_credential();
        state
            .accept(
                &snapshot(&state),
                Some("__Host-practiq_session=anonymous".into()),
                json!({"user":null,"csrf":"a".repeat(64)}),
                &entry,
            )
            .unwrap();
        assert!(entry.read().unwrap().is_none());
        assert_eq!(
            snapshot(&state).secret.cookie,
            "__Host-practiq_session=anonymous"
        );
        state
            .accept(
                &snapshot(&state),
                Some("__Host-practiq_session=logged-in".into()),
                json!({"user":{"id":"user"},"csrf":"b".repeat(64)}),
                &entry,
            )
            .unwrap();
        assert!(entry.read().unwrap().unwrap().contains("logged-in"));
    }
    #[test]
    fn session_secrets_only_reach_the_credential_store_and_stale_replies_cannot_revoke_a_new_login()
    {
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state
            .configure("https://cloud.example.test".into())
            .unwrap();
        let before = snapshot(&state);
        let entry = test_credential();
        let cookie = format!(
            "__Host-practiq_session={}",
            "opaque-native-session".repeat(2)
        );
        let csrf = "a".repeat(64);
        let public = state
            .accept(
                &before,
                Some(cookie.clone()),
                json!({"user":{"id":"user"},"csrf":csrf,"registrationEnabled":true}),
                &entry,
            )
            .unwrap();
        assert_eq!(public["csrf"], "");
        assert!(!public.to_string().contains("opaque-native-session"));
        let stored = entry.read().unwrap().unwrap();
        assert!(stored.contains(&cookie));
        assert!(!std::fs::read_to_string(dir.path().join(CONFIG))
            .unwrap()
            .contains("opaque-native-session"));
        assert_eq!(
            state.clear(&before, &entry).unwrap_err().code,
            "CLOUD_ACCOUNT_CHANGED"
        );
        assert_eq!(entry.read().unwrap().unwrap(), stored);
        state.clear(&snapshot(&state), &entry).unwrap();
        assert!(entry.read().unwrap().is_none());
    }
    #[test]
    fn malformed_session_material_never_replaces_saved_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state
            .configure("https://cloud.example.test".into())
            .unwrap();
        let entry = test_credential();
        entry.write(Some("retained-original")).unwrap();
        for cookie in [
            "__Host-practiq_session=raw\r\ninjected=1",
            "other_cookie=value",
        ] {
            assert!(state
                .accept(
                    &snapshot(&state),
                    Some(cookie.into()),
                    json!({"user":{"id":"user"},"csrf":"a".repeat(64)}),
                    &entry
                )
                .is_err());
            assert_eq!(entry.read().unwrap().as_deref(), Some("retained-original"));
        }
    }
    #[test]
    fn native_requests_revalidate_origin_before_sending_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state.configure("https://example.test".into()).unwrap();
        for (origin, code) in [
            ("http://example.test", "LOCAL_URL_HTTPS_REQUIRED"),
            ("http://127.0.0.1:9/private", "CLOUD_ORIGIN_INVALID"),
            (
                "http://127.0.0.1:9?token=forbidden",
                "LOCAL_URL_CREDENTIALS_FORBIDDEN",
            ),
            (
                "http://user:password@127.0.0.1:9",
                "LOCAL_URL_CREDENTIALS_FORBIDDEN",
            ),
        ] {
            let mut account = snapshot(&state);
            account.origin = origin.into();
            account.client = Client::builder().https_only(true).build().unwrap();
            let error = account
                .send(Method::GET, "/api/me/usage", None, None)
                .unwrap_err();
            assert_eq!(error.code, code, "{origin}");
        }
    }
    #[test]
    fn native_http_sends_csrf_and_session_only_to_its_origin_without_redirect_or_post_replay() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut data = Vec::new();
            let mut buffer = [0; 4096];
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            loop {
                let n = socket.read(&mut buffer).unwrap();
                data.extend_from_slice(&buffer[..n]);
                if n == 0 || data.windows(4).any(|s| s == b"\r\n\r\n") {
                    break;
                }
            }
            let data = String::from_utf8_lossy(&data).to_ascii_lowercase();
            assert!(data.contains("cookie: practiq_session=native-session"));
            assert!(data.contains("x-csrf-token: aaaaaaaaaa"));
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://untrusted.invalid/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            listener.set_nonblocking(true).unwrap();
            assert!(listener.accept().is_err());
        });
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state.configure(format!("http://{address}")).unwrap();
        state.lock().unwrap().secret = Secret {
            cookie: "practiq_session=native-session".into(),
            csrf: "a".repeat(64),
        };
        let response = snapshot(&state)
            .send(
                Method::POST,
                "/api/document-tasks",
                Some(json!({"requestId":"retained"})),
                None,
            )
            .unwrap();
        assert_eq!(response.status().as_u16(), 302);
        server.join().unwrap();
    }
    #[test]
    fn customer_paths_never_allow_admin_redirects_or_arbitrary_urls() {
        for path in [
            "https://evil.test/api/me/usage",
            "//evil.test/api/me/usage",
            "/api/admin/users",
            "/api/../api/admin/users",
            "/api/me/%2e%2e/admin/users",
            "/api/document-tasks/invalid/head",
            "/api/me/usage#secret",
        ] {
            assert!(validate_path(path, &Method::GET).is_err(), "{path}");
        }
        for path in [
            "/api/me/usage",
            "/api/auth/session",
            "/api/document-tasks/11111111-1111-4111-8111-111111111111/preview",
        ] {
            assert!(validate_path(path, &Method::GET).is_ok());
        }
        assert!(validate_path("/api/me/profile", &Method::GET).is_err());
        assert!(validate_path("/api/me/profile", &Method::PATCH).is_ok());
    }
    #[test]
    fn account_origins_and_credential_namespaces_are_isolated() {
        assert_eq!(
            origin(" https://EXAMPLE.com:443/ ").unwrap(),
            "https://example.com"
        );
        for value in [
            "http://example.com",
            "https://example.com/path",
            "https://a:b@example.com",
            "https://example.com?token=x",
        ] {
            assert!(origin(value).is_err());
        }
        assert_ne!(account("https://one.test"), account("https://two.test"));
        assert!(account("https://one.test").starts_with("ai-account-session-v1-"));
    }
    #[test]
    fn unknown_account_config_does_not_block_offline_start_or_get_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG);
        std::fs::write(&path, b"{\"version\":99}").unwrap();
        let state = State::new(dir.path().into());
        assert!(state.configure("https://example.test".into()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"version\":99}");
    }
    #[test]
    fn anonymous_session_reads_do_not_select_managed_grading_or_leave_old_requests_current() {
        let dir = tempfile::tempdir().unwrap();
        let (state, signed_in) = test_account(dir.path(), "http://127.0.0.1:8090", &"A".repeat(43));
        assert!(signed_in.has_session());
        state
            .accept(
                &signed_in,
                None,
                json!({"user":null,"csrf":"a".repeat(64)}),
                &test_credential(),
            )
            .unwrap();
        assert!(!snapshot(&state).has_session());
        assert!(state.current(&signed_in).is_err());
        assert!(validate_path("/api/subjective-grades", &Method::POST).is_ok());
        assert!(validate_path("/api/subjective-grades", &Method::GET).is_err());
    }
    #[test]
    fn grading_preserves_the_service_timeout_without_extending_passive_reads() {
        assert_eq!(
            request_timeout("/api/subjective-grades"),
            Duration::from_secs(900)
        );
        assert_eq!(
            request_timeout("/api/document-tasks/id/export?partial=true"),
            Duration::from_secs(600)
        );
        assert_eq!(
            request_timeout("/api/auth/session"),
            Duration::from_secs(125)
        );
    }
}
