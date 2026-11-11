//! Origin-bound personal import transport; native file paths stay outside the WebView.
use crate::{contract::Result, AppError};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{blocking::Client, header, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, io::Read, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager};

const CONFIG: &str = "import-service-v1.json";
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
pub(crate) struct Cloud {
    pub(crate) origin: Option<String>,
    pub(crate) epoch: u64,
    invalid: bool,
    pub(crate) sources: HashMap<String, super::cloud_files::Source>,
}
pub(crate) struct State {
    pub(crate) inner: Mutex<Cloud>,
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
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Context {
    pub(crate) origin: String,
    pub(crate) generation: u64,
}

fn validate_context(state: &Cloud, context: &Context) -> Result<()> {
    if state.origin.as_deref() != Some(&context.origin) || context.generation != state.epoch {
        return Err(error("CLOUD_SERVICE_CHANGED"));
    }
    Ok(())
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
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok("http://127.0.0.1:8090".into())
            }
            _ => Err(()),
        };
        Self {
            dir,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok(),
            inner: Mutex::new(Cloud {
                origin: config.as_ref().ok().filter(|v| !v.is_empty()).cloned(),
                invalid: config.is_err(),
                epoch: 0,
                sources: HashMap::new(),
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
    pub(crate) fn snapshot(&self, context: &Context) -> Result<Snapshot> {
        let state = self.lock()?;
        if state.invalid {
            return Err(error("CLOUD_CONFIG_INVALID"));
        }
        validate_context(&state, context)?;
        Ok(Snapshot {
            origin: state
                .origin
                .clone()
                .ok_or_else(|| error("CLOUD_ORIGIN_REQUIRED"))?,
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
        if state.epoch != snapshot.epoch || state.origin.as_deref() != Some(&snapshot.origin) {
            return Err(error("CLOUD_SERVICE_CHANGED"));
        }
        Ok(state)
    }
}
pub(crate) struct Snapshot {
    pub(crate) origin: String,
    pub(crate) epoch: u64,
    client: Client,
}
impl Snapshot {
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
        "/api/import-capabilities" => method == Method::GET,
        "/api/import-settings" => method == Method::GET || method == Method::PUT,
        "/api/uploads" | "/api/artifacts/read" | "/api/subjective-grades" => method == Method::POST,
        "/api/uploads/content" => method == Method::PUT,
        "/api/document-tasks" => method == Method::GET || method == Method::POST,
        _ => {
            let parts: Vec<_> = p.split('/').collect();
            if parts.len() >= 4
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
}

pub(crate) fn fetch(
    state: &State,
    context: &Context,
    path: &str,
    method: Method,
    body: Option<Value>,
) -> Result<Value> {
    if body
        .as_ref()
        .is_some_and(|v| v.to_string().len() > MAX_RESPONSE)
    {
        return Err(error("CLOUD_REQUEST_TOO_LARGE"));
    }
    let snapshot = state.snapshot(context)?;
    let response = snapshot.send(method, path, body, None)?;
    let status = response.status().as_u16();
    let media_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let bytes = read_response(response)?;
    state.current(&snapshot)?;
    Ok(json!({"status": status, "mediaType": media_type, "bytes": STANDARD.encode(bytes)}))
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
            .ok_or_else(|| error("CLOUD_SERVICE_CHANGED"))
    };
    match value {
        Request::Status => {
            let context = state.context()?;
            let generation = state.lock()?.epoch;
            Ok(json!({"origin": context.map(|value| value.origin), "generation": generation}))
        }
        Request::Configure { origin } => state.configure(origin),
        Request::Fetch { path, method, body } => {
            let method =
                Method::from_bytes(method.as_bytes()).map_err(|_| error("CLOUD_PATH_INVALID"))?;
            if path.starts_with("/api/uploads") || path.contains("/export?") {
                return Err(error("CLOUD_PATH_INVALID"));
            }
            fetch(&state, bound()?, &path, method, body)
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener};

    #[test]
    fn personal_configuration_preserves_legacy_accounts_and_fences_stale_actions() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("account-service-v1.json");
        let bytes = br#"{"version":1,"origin":"https://old.test"}"#;
        std::fs::write(&legacy, bytes).unwrap();
        let state = State::new(dir.path().into());
        assert_eq!(
            state.context().unwrap().unwrap().origin,
            "http://127.0.0.1:8090"
        );
        assert!(!dir.path().join(CONFIG).exists());
        state.configure("http://127.0.0.1:8090".into()).unwrap();
        let context = state.context().unwrap().unwrap();
        let snapshot = state.snapshot(&context).unwrap();
        state.configure("https://second.test".into()).unwrap();
        assert_eq!(
            state.current(&snapshot).unwrap_err().code,
            "CLOUD_SERVICE_CHANGED"
        );
        assert!(state.snapshot(&context).is_err());
        assert_eq!(std::fs::read(legacy).unwrap(), bytes);
        assert!(State::new(dir.path().into()).context().unwrap().is_some());
    }

    #[test]
    fn unknown_personal_configuration_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG);
        std::fs::write(&path, br#"{"version":99}"#).unwrap();
        let state = State::new(dir.path().into());
        assert!(state.context().is_err());
        assert!(state.configure("https://example.test".into()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), br#"{"version":99}"#);
    }

    #[test]
    fn personal_paths_reject_account_admin_and_arbitrary_destinations() {
        for path in [
            "https://evil.test/api/document-tasks",
            "//evil.test/api/document-tasks",
            "/api/admin/users",
            "/api/auth/session",
            "/api/me/payments",
            "/api/../api/import-settings",
            "/api/document-tasks/invalid/head",
            "/api/import-settings#secret",
        ] {
            assert!(validate_path(path, &Method::GET).is_err(), "{path}");
        }
        let mut path =
            "/api/document-tasks/11111111-1111-4111-8111-111111111111/export?scope=full".to_owned();
        for index in 0..2000 {
            path.push_str(&format!("&question_index={index}"));
        }
        assert!(validate_path(&path, &Method::GET).is_ok());
        path.push_str(&"x".repeat(64 * 1024));
        assert!(validate_path(&path, &Method::GET).is_err());
        assert!(validate_path("/api/import-settings", &Method::PUT).is_ok());
    }

    #[test]
    fn native_requests_revalidate_the_origin_before_sending() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state.configure("https://example.test".into()).unwrap();
        for (origin, code) in [
            ("http://example.test", "LOCAL_URL_HTTPS_REQUIRED"),
            ("http://127.0.0.1:9/private", "CLOUD_ORIGIN_INVALID"),
            (
                "http://user:password@127.0.0.1:9",
                "LOCAL_URL_CREDENTIALS_FORBIDDEN",
            ),
        ] {
            let mut snapshot = state.snapshot(&state.context().unwrap().unwrap()).unwrap();
            snapshot.origin = origin.into();
            assert_eq!(
                snapshot
                    .send(Method::GET, "/api/import-capabilities", None, None)
                    .unwrap_err()
                    .code,
                code
            );
        }
    }

    #[test]
    fn native_http_has_no_credentials_redirects_or_automatic_replay() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            while !data.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                data.push(byte[0]);
            }
            let data = String::from_utf8(data).unwrap().to_ascii_lowercase();
            assert!(
                !data.contains("cookie:")
                    && !data.contains("authorization:")
                    && !data.contains("x-csrf-token:")
            );
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://untrusted.invalid/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            listener.set_nonblocking(true).unwrap();
            assert!(listener.accept().is_err());
        });
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().into());
        state.configure(format!("http://{address}")).unwrap();
        let snapshot = state.snapshot(&state.context().unwrap().unwrap()).unwrap();
        assert_eq!(
            snapshot
                .send(Method::GET, "/api/import-capabilities", None, None)
                .unwrap()
                .status()
                .as_u16(),
            302
        );
        server.join().unwrap();
    }
}
