//! Explicit subjective grading through the independently managed Python backend.
use crate::{
    contract::{self, Result},
    AppError, Shared,
};
use reqwest::blocking::{Client, Response};
#[cfg(test)]
use reqwest::Method;
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
    pub(crate) fn configure(&self) -> Result<Lease<'_>> {
        self.exclusive("LOCAL_CONFIGURE_BUSY")
    }
}

struct Endpoint {
    client: Client,
    origin: String,
}
impl Endpoint {
    fn new(origin: String) -> Result<Self> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(900))
            .build()
            .map_err(|_| crate::language::error("LOCAL_SERVICE_UNAVAILABLE", json!({})))?;
        Ok(Self { client, origin })
    }
    fn grade(&self, payload: &Value) -> Result<Value> {
        let request = self
            .client
            .post(format!("{}/api/subjective-grades", self.origin));
        let response = request
            .json(payload)
            .send()
            .map_err(|_| crate::language::error("LOCAL_SERVICE_UNAVAILABLE", json!({})))?;
        let status = response.status();
        let value = read_json(response, contract::MAX_JSON)?;
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
        crate::exams::validate_grade_details(&value)?;
        if value.get("result").is_some_and(|r| !r.is_null()) {
            let input: Value = serde_json::from_str(
                payload["payload"]
                    .as_str()
                    .ok_or("Missing grading payload")?,
            )
            .map_err(|_| crate::language::error("LOCAL_RESPONSE_INVALID", json!({})))?;
            crate::contract::grade_evidence(&value["result"], &input)?;
        }
        Ok(value)
    }
}
pub(crate) fn read_json(response: Response, limit: usize) -> Result<Value> {
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| crate::language::error("LOCAL_RESPONSE_READ_FAILED", json!({})))?;
    if bytes.len() > limit {
        return Err(crate::language::error(
            "LOCAL_RESPONSE_TOO_LARGE",
            json!({}),
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| crate::language::error("LOCAL_RESPONSE_INVALID", json!({})))
}

#[cfg(test)]
pub fn test_connection(origin: &str) -> Result<Value> {
    let endpoint = Endpoint::new(origin.to_owned())?;
    let request = endpoint
        .client
        .request(Method::GET, format!("{origin}/api/maintenance"))
        .timeout(Duration::from_secs(15));
    let response = request
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

fn grade(
    shared: &Shared,
    endpoint: &Endpoint,
    id: &str,
    ordinal: usize,
    retry: bool,
    snapshot_key: Option<&str>,
    locale: crate::language::Locale,
) -> Result<Value> {
    let target = json!({"kind":"service","serviceUrl":endpoint.origin});
    let payload = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
        .prepare_grade_target(id, ordinal, retry, locale, Some(&target))?;
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
    let AiRequest::Grade {
        id,
        ordinal,
        retry,
        snapshot_key,
    } = request;
    let origin = app
        .state::<crate::cloud::State>()
        .context()?
        .ok_or_else(|| crate::language::error("LOCAL_SERVICE_URL_REQUIRED", json!({})))?
        .origin;
    let endpoint = Endpoint::new(crate::cloud::origin(&origin)?)?;
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
        server_response(status, body, path, "test-service-token", None)
    }
    fn server_response(
        status: &'static str,
        body: String,
        path: &'static str,
        token: &'static str,
        declared_length: Option<usize>,
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
            assert_eq!(headers.lines().next(), Some(path));
            if token.is_empty() || path.contains("/api/") {
                assert!(!headers.to_lowercase().contains("authorization:"));
            } else {
                assert!(headers
                    .to_lowercase()
                    .contains(&format!("authorization: bearer {token}")));
            }
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
            let _ = write!(stream, "HTTP/1.1 {status}\r\n{redirect}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", declared_length.unwrap_or(body.len()));
            request
        });
        (origin, handle)
    }
    fn submitted() -> (tempfile::TempDir, Shared, String) {
        submitted_kind("self_test")
    }
    fn submitted_kind(kind: &str) -> (tempfile::TempDir, Shared, String) {
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
                kind: kind.into(),
                minutes: None,
                scores: vec![1000],
                total_cents: 1000,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let id = contract::text(&session, "id").to_owned();
        store
            .save_attempt(
                (&id, 0),
                json!({"text":"Student answer"}),
                0,
                kind == "practice",
                false,
            )
            .unwrap();
        if kind != "practice" {
            store.submit_paper(&id, true).unwrap();
        }
        assert!(!bank["bankId"].is_null());
        (dir, Arc::new(Mutex::new(store)), id)
    }

    #[test]
    fn practice_grading_preserves_self_assessment_and_survives_reopen_and_backup() {
        let (dir, shared, id) = submitted_kind("practice");
        let mut result = scored(6000);
        result["maxCents"] = json!(10000);
        result["criteria"][0]["maxCents"] = json!(10000);
        let body = json!({"status":"graded","result":result}).to_string();
        let (origin, handle) = server("200 OK", body, "POST /api/subjective-grades HTTP/1.1");
        let endpoint = Endpoint::new(origin).unwrap();
        let session = grade(
            &shared,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::English,
        )
        .unwrap();
        handle.join().unwrap();
        assert!(session["submittedAt"].is_null());
        assert!(session["finishedAt"].is_null());
        assert_eq!(session["attempts"][0]["maxCents"], 10000);
        assert_eq!(session["attempts"][0]["earnedCents"], 6000);
        let response = session["attempts"][0]["grading"]["ai"].clone();
        let rid: String = shared
            .lock()
            .unwrap()
            .connect()
            .unwrap()
            .query_row(
                "SELECT id FROM grade_requests WHERE session_id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        assert_eq!(
            store.session(&id).unwrap()["attempts"][0]["earnedCents"],
            6000
        );
        store.self_assess(&id, 0, true).unwrap();
        let late = store.record_grade(&id, 0, &rid, &response).unwrap();
        assert_eq!(late["attempts"][0]["gradeKind"], "self");
        assert_eq!(late["attempts"][0]["result"], true);
        assert!(late["attempts"][0]["earnedCents"].is_null());
        assert!(late["attempts"][0]["maxCents"].is_null());
        assert_eq!(
            store
                .prepare_grade(&id, 0, true, store.locale)
                .unwrap_err()
                .code,
            "LOCAL_GRADING_INELIGIBLE"
        );
        let backup = dir.path().join("grading.zip");
        store.backup(&backup).unwrap();
        store.restore(&backup).unwrap();
        assert_eq!(
            store.session(&id).unwrap()["attempts"][0]["grading"]["ai"],
            response
        );
    }

    #[test]
    fn connects_to_personal_service_without_credentials_model_calls_or_redirects() {
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
            let result = test_connection(&origin);
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
    fn scored(score: i64) -> Value {
        json!({"scoreCents":score,"maxCents":1000,"reason":"Partial","evidence":["Student answer"],"reviewReasons":[],"criteria":[{"criterion":"Reference match","scoreCents":score,"maxCents":1000,"referenceQuote":"制定可执行的小目标","answerQuote":"Student answer","reason":"Partial match"}]})
    }

    #[test]
    fn service_target_changes_require_explicit_regrading_without_reusing_the_old_request() {
        let (_dir, shared, id) = submitted();
        let (origin, first) = server(
            "503 Service Unavailable",
            "{}".into(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin).unwrap();
        let unknown = grade(
            &shared,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::Chinese,
        )
        .unwrap();
        assert_eq!(
            unknown["attempts"][0]["grading"]["lastRequest"]["status"],
            "unknown"
        );
        let old_request = first.join().unwrap();
        let (origin, second) = server(
            "200 OK",
            json!({"status":"graded","result":scored(500)}).to_string(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin).unwrap();
        assert_eq!(
            grade(
                &shared,
                &endpoint,
                &id,
                0,
                false,
                None,
                crate::language::Locale::Chinese
            )
            .unwrap_err()
            .code,
            "LOCAL_GRADING_TARGET_CHANGED"
        );
        assert_eq!(
            shared.lock().unwrap().session(&id).unwrap()["attempts"][0]["grading"]["lastRequest"],
            unknown["attempts"][0]["grading"]["lastRequest"]
        );
        let graded = grade(
            &shared,
            &endpoint,
            &id,
            0,
            true,
            None,
            crate::language::Locale::Chinese,
        )
        .unwrap();
        let new_request = second.join().unwrap();
        assert_ne!(old_request["requestId"], new_request["requestId"]);
        assert_eq!(graded["attempts"][0]["earnedCents"], 500);
    }

    #[test]
    fn legacy_service_and_direct_receipts_require_explicit_regrading_before_network_work() {
        for target in [
            None,
            Some(
                json!({"kind":"direct","baseUrl":"https://provider.example/v1","modelId":"old-model","promptVersion":2}),
            ),
        ] {
            let (_dir, shared, id) = submitted();
            let legacy = shared
                .lock()
                .unwrap()
                .prepare_grade_target(
                    &id,
                    0,
                    false,
                    crate::language::Locale::Chinese,
                    target.as_ref(),
                )
                .unwrap();
            if target.is_some() {
                shared
                    .lock()
                    .unwrap()
                    .claim_model_grade(legacy["requestId"].as_str().unwrap())
                    .unwrap();
            }
            let (origin, handle) = server(
                "200 OK",
                r#"{"status":"ungraded","error":"Synthetic"}"#.into(),
                "POST /api/subjective-grades HTTP/1.1",
            );
            let endpoint = Endpoint::new(origin).unwrap();
            assert_eq!(
                grade(
                    &shared,
                    &endpoint,
                    &id,
                    0,
                    false,
                    None,
                    crate::language::Locale::Chinese
                )
                .unwrap_err()
                .code,
                "LOCAL_GRADING_TARGET_CHANGED"
            );
            grade(
                &shared,
                &endpoint,
                &id,
                0,
                true,
                None,
                crate::language::Locale::Chinese,
            )
            .unwrap();
            assert_ne!(handle.join().unwrap()["requestId"], legacy["requestId"]);
        }
    }

    #[test]
    fn issue_411_service_grade_without_explanation_arrays_is_not_persisted_as_usable() {
        let (_dir, shared, id) = submitted();
        let (origin, handle) = server(
            "200 OK",
            r#"{"status":"graded","result":{"scoreCents":500,"maxCents":1000,"reason":"ok"}}"#
                .into(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin).unwrap();
        let _outcome = grade(
            &shared,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::Chinese,
        );
        let wire = handle.join().unwrap();
        assert!(!wire["requestId"].is_null());
        let session = shared.lock().unwrap().session(&id).unwrap();
        let attempt = &session["attempts"][0];
        assert_eq!(
            attempt["earnedCents"],
            Value::Null,
            "malformed service response must not become a usable score: {attempt}"
        );
        assert_eq!(attempt["gradeKind"], "ungraded");
        assert!(attempt["grading"]["ai"].is_null());
        assert_eq!(attempt["grading"]["lastRequest"]["status"], "unknown");
        assert_eq!(
            attempt["grading"]["lastRequest"]["appError"]["code"],
            "LOCAL_RESPONSE_INVALID"
        );
    }

    #[test]
    fn invalid_grade_details_cannot_replace_a_saved_score() {
        let (_dir, shared, id) = submitted();
        let store = shared.lock().unwrap();
        let request = store.prepare_grade(&id, 0, false, store.locale).unwrap();
        let rid = contract::text(&request, "requestId");
        let valid = json!({"status":"graded","result":{"scoreCents":500,"maxCents":1000,"reason":"Reference credit","evidence":[],"reviewReasons":[]}});
        store.record_grade(&id, 0, rid, &valid).unwrap();
        for (field, value) in [
            ("reason", Value::Null),
            ("reason", json!(" ")),
            ("reason", json!("x".repeat(20_001))),
            ("evidence", Value::Null),
            ("evidence", json!({})),
            ("evidence", json!([1])),
            ("evidence", json!(vec!["x"; 101])),
            ("reviewReasons", Value::Null),
            ("reviewReasons", json!([{}])),
            ("reviewReasons", json!(["x".repeat(20_001)])),
        ] {
            let mut response = valid.clone();
            response["result"][field] = value;
            assert_eq!(
                store.record_grade(&id, 0, rid, &response).unwrap_err().code,
                "LOCAL_RESPONSE_INVALID",
                "{field}"
            );
            let session = store.session(&id).unwrap();
            assert_eq!(session["attempts"][0]["earnedCents"], 500);
            assert_eq!(session["attempts"][0]["grading"]["ai"], valid);
        }
    }

    #[test]
    fn explicit_grade_sends_frozen_payload_and_preserves_local_manual_override() {
        let (_dir, shared, id) = submitted();
        let (origin, handle) = server(
            "200 OK",
            json!({"status":"graded","result":scored(600)}).to_string(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin).unwrap();
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
        let stored: String = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT input FROM grade_requests WHERE id=?1",
                [contract::text(&wire, "requestId")],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("test-service-token"));
        assert_eq!(
            serde_json::from_str::<Value>(&stored).unwrap()["target"],
            json!({"kind":"service","serviceUrl":endpoint.origin})
        );
        assert!(wire.get("target").is_none());
        assert_eq!(
            store
                .prepare_grade_target(
                    &id,
                    0,
                    false,
                    store.locale,
                    Some(&json!({"kind":"service","serviceUrl":endpoint.origin}))
                )
                .unwrap(),
            wire
        );
        store.manual_score(&id, 0, 800, "Review").unwrap();
        let late = store
            .record_grade_with_key(
                &id,
                0,
                contract::text(&wire, "requestId"),
                &json!({"status":"graded","result":{"scoreCents":600,"maxCents":1000,"reason":"Partial credit","evidence":[],"reviewReasons":[]}}),
                None,
            )
            .unwrap();
        assert_eq!(late["attempts"][0]["earnedCents"], 800);
        assert_eq!(late["attempts"][0]["gradeKind"], "manual");
    }
    #[test]
    fn network_failure_stays_unknown_and_resume_reuses_only_the_same_request() {
        let (dir, shared, id) = submitted();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let endpoint = Endpoint::new(origin).unwrap();
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
        let target = json!({"kind":"service","serviceUrl":endpoint.origin});
        let wire = shared
            .lock()
            .unwrap()
            .prepare_grade_target(
                &id,
                0,
                false,
                crate::language::Locale::default(),
                Some(&target),
            )
            .unwrap();
        let reopened = Store::new(dir.path().to_owned()).unwrap();
        assert_eq!(
            reopened
                .prepare_grade_target(
                    &id,
                    0,
                    false,
                    crate::language::Locale::English,
                    Some(&target)
                )
                .unwrap(),
            wire
        );
        let (origin, handle) = server(
            "200 OK",
            r#"{"status":"ungraded","error":"Missing evidence"}"#.into(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin).unwrap();
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
            let endpoint = Endpoint::new(origin).unwrap();
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
    #[test]
    fn personal_service_checks_and_grading_need_no_account_token() {
        let (origin, server) = server_response(
            "200 OK",
            json!({"enabled": false}).to_string(),
            "GET /api/maintenance HTTP/1.1",
            "",
            None,
        );
        test_connection(&origin).unwrap();
        server.join().unwrap();
        let (_dir, shared, id) = submitted();
        let (origin, server) = server_response(
            "200 OK",
            json!({"status":"graded","result":scored(600)}).to_string(),
            "POST /api/subjective-grades HTTP/1.1",
            "",
            None,
        );
        let endpoint = Endpoint::new(origin).unwrap();
        let session = grade(
            &shared,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::Chinese,
        )
        .unwrap();
        assert_eq!(session["attempts"][0]["earnedCents"], 600);
        assert!(server.join().unwrap()["requestId"].is_string());
    }
}
