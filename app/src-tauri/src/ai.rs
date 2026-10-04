//! Explicit subjective grading through an independently managed AI service.
use crate::{
    contract::{self, Result},
    settings, AppError, Shared,
};
use reqwest::{
    blocking::{Client, Response},
    Method,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io::Read, sync::Mutex, time::Duration};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AiRequest {
    Grade {
        id: String,
        ordinal: usize,
        retry: bool,
        #[serde(default)]
        snapshot_key: Option<String>,
    },
}

#[derive(Default)]
struct Activity {
    active: usize,
    exclusive: bool,
}
#[derive(Default)]
pub struct GradingState(Mutex<Activity>);
pub(crate) struct Lease<'a> {
    state: &'a GradingState,
    exclusive: bool,
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut activity) = self.state.0.lock() {
            if self.exclusive {
                activity.exclusive = false;
            } else {
                activity.active -= 1;
            }
        }
    }
}
impl GradingState {
    fn enter(&self) -> Result<Lease<'_>> {
        let mut activity = self
            .0
            .lock()
            .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", json!({})))?;
        if activity.exclusive {
            return Err(crate::language::error("OPERATION_BUSY", json!({})));
        }
        activity.active += 1;
        Ok(Lease {
            state: self,
            exclusive: false,
        })
    }
    fn exclusive(&self, code: &str) -> Result<Lease<'_>> {
        let mut activity = self
            .0
            .lock()
            .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", json!({})))?;
        if activity.active != 0 || activity.exclusive {
            return Err(crate::language::error(code, json!({})));
        }
        activity.exclusive = true;
        Ok(Lease {
            state: self,
            exclusive: true,
        })
    }
    pub(crate) fn restore(&self) -> Result<Lease<'_>> {
        self.exclusive("LOCAL_RESTORE_BUSY")
    }
    fn configure(&self) -> Result<Lease<'_>> {
        self.exclusive("LOCAL_CONFIGURE_BUSY")
    }
}

struct Endpoint {
    client: Client,
    origin: String,
    token: String,
}
impl Endpoint {
    fn new(origin: String, token: String) -> Result<Self> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(900))
            .build()
            .map_err(|_| crate::language::error("LOCAL_SERVICE_UNAVAILABLE", json!({})))?;
        Ok(Self {
            client,
            origin,
            token,
        })
    }
    fn grade(&self, payload: &Value) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}/api/subjective-grades", self.origin))
            .bearer_auth(&self.token)
            .json(payload)
            .send()
            .map_err(|_| crate::language::error("LOCAL_SERVICE_UNAVAILABLE", json!({})))?;
        let status = response.status();
        let value = redact(read_json(response, contract::MAX_JSON)?, &self.token);
        if !status.is_success() {
            let detail = &value["detail"];
            let code = detail["code"]
                .as_str()
                .filter(|code| {
                    !code.is_empty()
                        && code.len() <= 64
                        && code
                            .chars()
                            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                })
                .unwrap_or("SERVICE_ERROR");
            let message: String = detail["message"]
                .as_str()
                .or_else(|| detail.as_str())
                .unwrap_or("AI service returned an error")
                .chars()
                .take(4096)
                .collect();
            let mut error = AppError::new(code, message.clone());
            if detail["params"].to_string().len() <= 16 * 1024 {
                error.params = Box::new(detail["params"].clone());
            }
            error.diagnostic = Some(message.into_boxed_str());
            error.http_status = Some(status.as_u16());
            return Err(error);
        }
        Ok(value)
    }
}
fn redact(value: Value, token: &str) -> Value {
    if token.is_empty() {
        return value;
    }
    match value {
        Value::String(text) => Value::String(text.replace(token, "[redacted]")),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|item| redact(item, token)).collect())
        }
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .map(|(key, item)| (key.replace(token, "[redacted]"), redact(item, token)))
                .collect(),
        ),
        other => other,
    }
}
fn read_json(response: Response, limit: usize) -> Result<Value> {
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| crate::language::error("LOCAL_RESPONSE_INVALID", json!({})))?;
    if bytes.len() > limit {
        return Err(crate::language::error(
            "LOCAL_RESPONSE_TOO_LARGE",
            json!({}),
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| crate::language::error("LOCAL_RESPONSE_INVALID", json!({})))
}

pub fn test_connection(origin: &str, token: String) -> Result<Value> {
    let endpoint = Endpoint::new(origin.to_owned(), token)?;
    let response = endpoint
        .client
        .request(Method::GET, format!("{origin}/api/maintenance"))
        .timeout(Duration::from_secs(15))
        .bearer_auth(&endpoint.token)
        .send()
        .map_err(|_| crate::language::error("LOCAL_CONNECTION_FAILED", json!({})))?;
    if !response.status().is_success() {
        return Err(crate::language::error(
            "LOCAL_CONNECTION_HTTP",
            json!({"status":response.status().as_u16()}),
        ));
    }
    let value = read_json(response, 1024 * 1024)
        .map_err(|_| crate::language::error("LOCAL_CONNECTION_RESPONSE", json!({})))?;
    if !value["enabled"].is_boolean() {
        return Err(crate::language::error(
            "LOCAL_CONNECTION_RESPONSE",
            json!({}),
        ));
    }
    Ok(Value::Null)
}

pub fn save_settings(
    app: &tauri::AppHandle,
    shared: &Shared,
    config: settings::ServiceSettings,
    service_token: Option<String>,
) -> Result<Value> {
    let state = app.state::<GradingState>();
    let _configuration = state.configure()?;
    settings::snapshot(shared)?.save_settings(&app.config().identifier, config, service_token)
}

fn grade(
    shared: &Shared,
    endpoint: &Endpoint,
    id: &str,
    ordinal: usize,
    retry: bool,
    snapshot_key: Option<&str>,
    locale: crate::language::Locale,
) -> Result<Value> {
    let payload = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
        .prepare_grade(id, ordinal, retry, locale)?;
    let response = endpoint.grade(&payload).unwrap_or_else(|error| json!({"status":"unknown","error":error.message,"appError":error,"usageStatus":"unknown"}));
    shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
        .record_grade_with_key(
            id,
            ordinal,
            contract::text(&payload, "requestId"),
            &response,
            snapshot_key,
        )
}

pub fn request(
    app: tauri::AppHandle,
    shared: Shared,
    request: AiRequest,
    locale: crate::language::Locale,
) -> Result<Value> {
    let state = app.state::<GradingState>();
    let _grading = state.enter()?;
    let (origin, token) = settings::snapshot(&shared)?.grading_input(&app.config().identifier)?;
    let endpoint = Endpoint::new(origin, token)?;
    let AiRequest::Grade {
        id,
        ordinal,
        retry,
        snapshot_key,
    } = request;
    grade(
        &shared,
        &endpoint,
        &id,
        ordinal,
        retry,
        snapshot_key.as_deref(),
        locale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Pending, Store};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
    };

    fn server(
        status: &'static str,
        body: String,
        path: &'static str,
    ) -> (String, std::thread::JoinHandle<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            let headers = String::from_utf8(headers).unwrap();
            assert!(headers.starts_with(path), "{headers}");
            assert!(headers
                .to_lowercase()
                .contains("authorization: bearer test-service-token"));
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|n| n.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            let mut request_body = vec![0; length];
            stream.read_exact(&mut request_body).unwrap();
            let request = if request_body.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&request_body).unwrap()
            };
            let redirect = if status.starts_with("30") {
                "Location: http://127.0.0.1:9/credential-redirect\r\n"
            } else {
                ""
            };
            let _ = write!(stream, "HTTP/1.1 {status}\r\n{redirect}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            request
        });
        (origin, handle)
    }
    fn submitted() -> (tempfile::TempDir, Shared, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        let mut result: Value =
            serde_json::from_slice(include_bytes!("../../fixtures/sample.json")).unwrap();
        result["visualElements"] = json!([]);
        let pending =
            Pending::new(serde_json::to_vec(&result).unwrap(), "Subjective".into()).unwrap();
        let bank = store.import_pending(&pending, None, "Subjective").unwrap();
        let rows = store.question_rows().unwrap();
        let question_ids = vec![contract::text(&rows[4], "id").to_owned()];
        let selected = crate::paper::selected_rows(&rows, &question_ids).unwrap();
        let session = store
            .start_paper(crate::exams::Paper {
                question_ids,
                kind: "self_test".into(),
                minutes: None,
                scores: vec![1000],
                total_cents: 1000,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let id = contract::text(&session, "id").to_owned();
        store
            .save_attempt((&id, 0), json!({"text":"Student answer"}), 0, false, false)
            .unwrap();
        store.submit_paper(&id, true).unwrap();
        assert!(!bank["bankId"].is_null());
        (dir, Arc::new(Mutex::new(store)), id)
    }

    #[test]
    fn connects_with_service_auth_without_model_calls_or_redirects() {
        for (status, body, code) in [
            ("200 OK", r#"{"enabled":false}"#, None),
            (
                "401 Unauthorized",
                "test-service-token",
                Some("LOCAL_CONNECTION_HTTP"),
            ),
            ("302 Found", "", Some("LOCAL_CONNECTION_HTTP")),
            (
                "200 OK",
                r#"{"enabled":"false"}"#,
                Some("LOCAL_CONNECTION_RESPONSE"),
            ),
            ("200 OK", "not json", Some("LOCAL_CONNECTION_RESPONSE")),
        ] {
            let (origin, handle) = server(status, body.into(), "GET /api/maintenance HTTP/1.1");
            let result = test_connection(&origin, "test-service-token".into());
            if let Some(code) = code {
                let error = result.unwrap_err();
                assert_eq!(error.code, code);
                assert!(!error.message.contains("test-service-token"));
            } else {
                assert_eq!(result.unwrap(), Value::Null);
            }
            assert!(handle.join().unwrap().is_null());
        }
    }
    #[test]
    fn explicit_grade_sends_frozen_payload_and_preserves_local_manual_override() {
        let (_dir, shared, id) = submitted();
        let (origin, handle) = server("200 OK", r#"{"status":"graded","result":{"scoreCents":600,"maxCents":1000,"reason":"Partial","evidence":[],"reviewReasons":[]}}"#.into(), "POST /api/subjective-grades HTTP/1.1");
        let endpoint = Endpoint::new(origin, "test-service-token".into()).unwrap();
        let result = grade(
            &shared,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::default(),
        )
        .unwrap();
        assert_eq!(result["attempts"][0]["earnedCents"], 600);
        assert_eq!(result["attempts"][0]["gradeKind"], "ai");
        let wire = handle.join().unwrap();
        let payload: Value = serde_json::from_str(contract::text(&wire, "payload")).unwrap();
        assert_eq!(payload["answer"], "Student answer");
        assert_eq!(payload["maxCents"], 1000);
        assert_eq!(
            wire["inputDigest"],
            crate::store::hash(contract::text(&wire, "payload").as_bytes())
        );
        let store = shared.lock().unwrap();
        assert_eq!(
            store.prepare_grade(&id, 0, false, store.locale).unwrap(),
            wire
        );
        store.manual_score(&id, 0, 800, "Review").unwrap();
        let late = store
            .record_grade_with_key(
                &id,
                0,
                contract::text(&wire, "requestId"),
                &json!({"status":"graded","result":{"scoreCents":600,"maxCents":1000}}),
                None,
            )
            .unwrap();
        assert_eq!(late["attempts"][0]["earnedCents"], 800);
        assert_eq!(late["attempts"][0]["gradeKind"], "manual");
    }
    #[test]
    fn network_failure_stays_unknown_and_resume_reuses_only_the_same_request() {
        let (_dir, shared, id) = submitted();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let endpoint = Endpoint::new(origin, "test-service-token".into()).unwrap();
        let result = grade(
            &shared,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::default(),
        )
        .unwrap();
        assert!(result["attempts"][0]["earnedCents"].is_null());
        assert_eq!(result["attempts"][0]["gradeKind"], "ungraded");
        assert_eq!(
            result["attempts"][0]["grading"]["lastRequest"]["status"],
            "unknown"
        );
        let wire = shared
            .lock()
            .unwrap()
            .prepare_grade(&id, 0, false, crate::language::Locale::default())
            .unwrap();
        let (origin, handle) = server(
            "200 OK",
            r#"{"status":"ungraded","error":"Missing evidence"}"#.into(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin, "test-service-token".into()).unwrap();
        grade(
            &shared,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::default(),
        )
        .unwrap();
        assert_eq!(handle.join().unwrap()["requestId"], wire["requestId"]);
        let (origin, handle) = server(
            "200 OK",
            r#"{"status":"ungraded","error":"Missing evidence"}"#.into(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin, "test-service-token".into()).unwrap();
        grade(
            &shared,
            &endpoint,
            &id,
            0,
            true,
            None,
            crate::language::Locale::default(),
        )
        .unwrap();
        assert_ne!(handle.join().unwrap()["requestId"], wire["requestId"]);
    }
    #[test]
    fn responses_are_bounded_and_cannot_redirect_grade_credentials() {
        for (status, body, expected) in [
            ("200 OK", "{".into(), "LOCAL_RESPONSE_INVALID"),
            (
                "200 OK",
                " ".repeat(contract::MAX_JSON + 1),
                "LOCAL_RESPONSE_TOO_LARGE",
            ),
            (
                "307 Temporary Redirect",
                r#"{"detail":{"code":"NO_REDIRECT","message":"Stay here"}}"#.into(),
                "NO_REDIRECT",
            ),
        ] {
            let (origin, handle) = server(status, body, "POST /api/subjective-grades HTTP/1.1");
            let endpoint = Endpoint::new(origin, "test-service-token".into()).unwrap();
            assert_eq!(
                endpoint
                    .grade(&json!({"requestId":"test"}))
                    .unwrap_err()
                    .code,
                expected
            );
            handle.join().unwrap();
        }
    }
    #[test]
    fn reflected_service_tokens_never_reach_local_grade_history_or_diagnostics() {
        let token = "test-service-token";
        for (status, body) in [
            (
                "401 Unauthorized",
                json!({"detail":{"code":"INVALID_SERVICE_TOKEN","message":format!("Authorization: Bearer {token}"),"params":{token:[{"nested":token}]}}}),
            ),
            (
                "200 OK",
                json!({"status":"ungraded","error":format!("Echo {token}")}),
            ),
        ] {
            let (_dir, shared, id) = submitted();
            let (origin, handle) = server(
                status,
                body.to_string(),
                "POST /api/subjective-grades HTTP/1.1",
            );
            let endpoint = Endpoint::new(origin, token.into()).unwrap();
            let result = grade(
                &shared,
                &endpoint,
                &id,
                0,
                false,
                None,
                crate::language::Locale::default(),
            )
            .unwrap();
            assert!(!result.to_string().contains(token));
            let store = shared.lock().unwrap();
            let response: String = store
                .connect()
                .unwrap()
                .query_row(
                    "SELECT response FROM grade_requests WHERE session_id=?1",
                    [&id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(!response.contains(token));
            assert!(response.contains("[redacted]"));
            if status.starts_with("401") {
                let error = &result["attempts"][0]["grading"]["lastRequest"]["appError"];
                assert_eq!(error["code"], "INVALID_SERVICE_TOKEN");
                assert_eq!(error["httpStatus"], 401);
            }
            handle.join().unwrap();
        }
    }
    #[test]
    fn grading_blocks_restore_and_settings_only_while_a_request_is_active() {
        let state = GradingState::default();
        let first = state.enter().unwrap();
        let second = state.enter().unwrap();
        assert!(state.restore().is_err());
        assert!(state.configure().is_err());
        drop(first);
        assert!(state.restore().is_err());
        drop(second);
        let restore = state.restore().unwrap();
        assert!(state.enter().is_err());
        drop(restore);
        let configure = state.configure().unwrap();
        assert!(state.enter().is_err());
        drop(configure);
        assert!(state.enter().is_ok());
    }
}
