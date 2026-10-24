//! Explicit subjective grading through a model API or an independently managed service.
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
    model: Option<settings::ConnectionSettings>,
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
            model: None,
        })
    }
    fn grade(&self, payload: &Value) -> Result<Value> {
        if let Some(model) = &self.model {
            return crate::model_grading::grade(&self.client, model, &self.token, payload);
        }
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
pub(crate) fn redact(value: Value, token: &str) -> Value {
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
    api_key: Option<String>,
) -> Result<Value> {
    let state = app.state::<GradingState>();
    let _configuration = state.configure()?;
    if config.model.is_some() {
        return settings::model_settings(shared, config, api_key, app);
    }
    settings::snapshot(shared)?.save_settings(app, config, service_token)
}

pub fn test_model_connection(model: &settings::ConnectionSettings, key: String) -> Result<Value> {
    let endpoint = Endpoint::new(model.base_url.clone().ok_or("Missing model URL")?, key)?;
    let response = endpoint
        .client
        .get(format!("{}/models", endpoint.origin))
        .timeout(Duration::from_secs(15))
        .bearer_auth(&endpoint.token)
        .send()
        .map_err(|_| crate::language::error("LOCAL_MODEL_CONNECTION_FAILED", json!({})))?;
    if !response.status().is_success() {
        return Err(crate::language::error(
            "LOCAL_MODEL_HTTP",
            json!({"status":response.status().as_u16()}),
        ));
    }
    let value = read_json(response, 1024 * 1024)?;
    let models = value["data"]
        .as_array()
        .ok_or_else(|| crate::language::error("LOCAL_MODEL_RESPONSE_INVALID", json!({})))?;
    if !models
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .any(|id| Some(id) == model.model_id.as_deref())
    {
        return Err(crate::language::error("LOCAL_MODEL_UNAVAILABLE", json!({})));
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
    let target = endpoint.model.as_ref().map_or_else(
        || json!({"kind":"service","serviceUrl":endpoint.origin}),
        |model| json!({"kind":"direct","baseUrl":model.base_url,"model":model.model_id,"promptVersion":1}),
    );
    let payload = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
        .prepare_grade_target(id, ordinal, retry, locale, Some(&target))?;
    let previous = if endpoint.model.is_some() {
        shared
            .lock()
            .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
            .claim_model_grade(contract::text(&payload, "requestId"))?
    } else {
        None
    };
    if previous.is_some() {
        return shared
            .lock()
            .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
            .session_data(id, snapshot_key);
    }
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
    let store = settings::snapshot(&shared)?;
    let config = store.service_settings()?;
    let AiRequest::Grade {
        id,
        ordinal,
        retry,
        snapshot_key,
    } = request;
    let endpoint = if let Some(model) = config.model {
        if !retry {
            let model = model.clone().validate()?;
            let target = json!({"kind":"direct","baseUrl":model.base_url,"model":model.model_id,"promptVersion":1});
            if let Some(session) = shared
                .lock()
                .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
                .cached_model_grade(&id, ordinal, locale, &target, snapshot_key.as_deref())?
            {
                return Ok(session);
            }
        }
        let (model, key) = settings::model_input(&model, None, &app)?;
        let mut endpoint = Endpoint::new(model.base_url.clone().ok_or("Missing model URL")?, key)?;
        endpoint.model = Some(model);
        endpoint
    } else {
        let (origin, token) = store.grading_input(&app)?;
        Endpoint::new(origin, token)?
    };
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
            assert!(headers
                .to_lowercase()
                .contains(&format!("authorization: bearer {token}")));
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
    fn direct(origin: String) -> Endpoint {
        let mut endpoint = Endpoint::new(origin.clone(), "test-service-token".into()).unwrap();
        endpoint.model = Some(settings::ConnectionSettings {
            base_url: Some(origin),
            model_id: Some("fixture-model".into()),
        });
        endpoint
    }
    fn completion() -> String {
        json!({"id":"fixture-receipt","choices":[{"finish_reason":"stop","message":{"content":json!({"scoreCents":600,"maxCents":1000,"reason":"Partial","evidence":["Reference"],"reviewReasons":[]}).to_string()}}],"usage":{"prompt_tokens":50,"completion_tokens":20,"total_tokens":70}}).to_string()
    }
    #[test]
    fn direct_grading_uses_chat_completions_and_reuses_local_receipts_without_resending() {
        let (_dir, shared, id) = submitted();
        let (origin, handle) = server("200 OK", completion(), "POST /chat/completions HTTP/1.1");
        let endpoint = direct(origin);
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
        let sent = handle.join().unwrap();
        assert_eq!(sent["model"], "fixture-model");
        assert_eq!(sent["response_format"]["type"], "json_object");
        assert_eq!(session["attempts"][0]["earnedCents"], 600);
        let receipt = &session["attempts"][0]["grading"]["ai"];
        assert_eq!(receipt["usageStatus"], "known");
        assert_eq!(receipt["usage"][0]["inputTokens"], 50);
        assert_eq!(receipt["providerRequestId"], "fixture-receipt");
        // The server has exited; checking again must use the durable local result.
        let again = grade(
            &shared,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::Chinese,
        )
        .unwrap();
        assert_eq!(again["attempts"][0]["grading"]["ai"], *receipt);
    }
    #[test]
    fn interrupted_direct_requests_survive_reopening_without_another_paid_call() {
        let (dir, shared, id) = submitted();
        let endpoint = direct("http://127.0.0.1:9".into());
        let target = json!({"kind":"direct","baseUrl":endpoint.model.as_ref().unwrap().base_url,"model":"fixture-model","promptVersion":1});
        {
            let store = shared.lock().unwrap();
            let payload = store
                .prepare_grade_target(
                    &id,
                    0,
                    false,
                    crate::language::Locale::Chinese,
                    Some(&target),
                )
                .unwrap();
            assert!(store
                .claim_model_grade(contract::text(&payload, "requestId"))
                .unwrap()
                .is_none());
        }
        let reopened = Arc::new(Mutex::new(Store::new(dir.path().to_owned()).unwrap()));
        assert_eq!(
            reopened.lock().unwrap().session(&id).unwrap()["attempts"][0]["grading"]["lastRequest"]
                ["appError"]["code"],
            "LOCAL_MODEL_RESULT_UNKNOWN"
        );
        let result = grade(
            &reopened,
            &endpoint,
            &id,
            0,
            false,
            None,
            crate::language::Locale::Chinese,
        )
        .unwrap();
        assert_eq!(
            result["attempts"][0]["grading"]["lastRequest"]["appError"]["code"],
            "LOCAL_MODEL_RESULT_UNKNOWN"
        );
        assert!(result["attempts"][0]["earnedCents"].is_null());
    }
    #[test]
    fn model_changes_require_explicit_retry_and_bad_output_keeps_existing_scores() {
        let (_dir, shared, id) = submitted();
        let (origin, handle) = server("200 OK", completion(), "POST /chat/completions HTTP/1.1");
        grade(
            &shared,
            &direct(origin),
            &id,
            0,
            false,
            None,
            crate::language::Locale::Chinese,
        )
        .unwrap();
        handle.join().unwrap();
        let (origin, handle)=server("200 OK",r#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"scoreCents\":999999999}"}}]}"#.into(),"POST /chat/completions HTTP/1.1");
        let endpoint = direct(origin);
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
        let result = grade(
            &shared,
            &endpoint,
            &id,
            0,
            true,
            None,
            crate::language::Locale::Chinese,
        )
        .unwrap();
        handle.join().unwrap();
        assert_eq!(result["attempts"][0]["earnedCents"], 600);
        assert_eq!(
            result["attempts"][0]["grading"]["lastRequest"]["status"],
            "ungraded"
        );
    }
    #[test]
    fn model_http_failures_and_reflected_keys_are_safe_and_never_redirected() {
        for (status, body) in [
            ("302 Found", String::new()),
            ("401 Unauthorized", "test-service-token".into()),
            (
                "200 OK",
                completion().replace("Partial", "test-service-token"),
            ),
        ] {
            let (_dir, shared, id) = submitted();
            let (origin, handle) = server(status, body, "POST /chat/completions HTTP/1.1");
            let endpoint = direct(origin);
            let result = grade(
                &shared,
                &endpoint,
                &id,
                0,
                false,
                None,
                crate::language::Locale::Chinese,
            )
            .unwrap();
            handle.join().unwrap();
            assert!(!result.to_string().contains("test-service-token"));
            let replay = grade(
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
                replay["attempts"][0]["grading"],
                result["attempts"][0]["grading"]
            );
        }
    }
    #[test]
    fn direct_complete_invalid_responses_are_ungraded_but_interrupted_bodies_stay_unknown() {
        let (_dir, shared, id) = submitted();
        let (origin, handle) = server("200 OK", completion(), "POST /chat/completions HTTP/1.1");
        grade(
            &shared,
            &direct(origin),
            &id,
            0,
            false,
            None,
            crate::language::Locale::English,
        )
        .unwrap();
        handle.join().unwrap();
        for (body, length, status, code) in [
            ("{".into(), None, "ungraded", "LOCAL_RESPONSE_INVALID"),
            (
                " ".repeat(1024 * 1024 + 1),
                None,
                "ungraded",
                "LOCAL_RESPONSE_TOO_LARGE",
            ),
            (
                "{".into(),
                Some(100),
                "unknown",
                "LOCAL_RESPONSE_READ_FAILED",
            ),
        ] {
            let (origin, handle) = server_response(
                "200 OK",
                body,
                "POST /chat/completions HTTP/1.1",
                "test-service-token",
                length,
            );
            let endpoint = direct(origin);
            let session = grade(
                &shared,
                &endpoint,
                &id,
                0,
                true,
                None,
                crate::language::Locale::English,
            )
            .unwrap();
            handle.join().unwrap();
            let attempt = &session["attempts"][0];
            assert_eq!(attempt["earnedCents"], 600);
            assert_eq!(attempt["grading"]["lastRequest"]["status"], status);
            assert_eq!(attempt["grading"]["lastRequest"]["appError"]["code"], code);
            let cached = grade(
                &shared,
                &endpoint,
                &id,
                0,
                false,
                None,
                crate::language::Locale::English,
            )
            .unwrap();
            assert_eq!(cached["attempts"][0]["grading"], attempt["grading"]);
        }
    }
    #[test]
    fn direct_short_keys_redact_retained_text_without_changing_score_fields() {
        let (_dir, shared, id) = submitted();
        let body = completion()
            .replace("Partial", "score evidence")
            .replace("fixture-receipt", "score-receipt");
        let (origin, handle) = server_response(
            "200 OK",
            body,
            "POST /chat/completions HTTP/1.1",
            "score",
            None,
        );
        let mut endpoint = direct(origin);
        endpoint.token = "score".into();
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
        let attempt = &session["attempts"][0];
        assert_eq!(attempt["earnedCents"], 600);
        let receipt = &attempt["grading"]["ai"];
        assert_eq!(receipt["result"]["scoreCents"], 600);
        assert_eq!(receipt["result"]["reason"], "[redacted] evidence");
        assert_eq!(receipt["providerRequestId"], "[redacted]-receipt");
    }
    #[test]
    fn model_connection_checks_only_read_the_model_list() {
        let (origin, handle) = server(
            "200 OK",
            r#"{"data":[{"id":"other-model"},{"id":null},{"id":"fixture-model"}]}"#.into(),
            "GET /models HTTP/1.1",
        );
        let config = direct(origin).model.unwrap();
        assert_eq!(
            test_model_connection(&config, "test-service-token".into()).unwrap(),
            Value::Null
        );
        assert!(handle.join().unwrap().is_null());
    }
    #[test]
    fn model_connection_rejects_unavailable_ids_and_invalid_lists() {
        for (body, code) in [
            (r#"{"data":[]}"#, "LOCAL_MODEL_UNAVAILABLE"),
            (
                r#"{"data":[{"id":"other-model"},{"id":null},{}]}"#,
                "LOCAL_MODEL_UNAVAILABLE",
            ),
            (r#"{"data":{}}"#, "LOCAL_MODEL_RESPONSE_INVALID"),
        ] {
            let (origin, handle) = server("200 OK", body.into(), "GET /models HTTP/1.1");
            let config = direct(origin).model.unwrap();
            let result = test_model_connection(&config, "test-service-token".into());
            assert!(handle.join().unwrap().is_null());
            assert_eq!(result.unwrap_err().code, code);
        }
    }
    #[test]
    fn service_target_changes_require_explicit_regrading_without_reusing_the_old_request() {
        let (_dir, shared, id) = submitted();
        let (origin, first) = server(
            "503 Service Unavailable",
            "{}".into(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin, "test-service-token".into()).unwrap();
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
        let (origin, second) = server("200 OK", r#"{"status":"graded","result":{"scoreCents":500,"maxCents":1000,"reason":"Synthetic","evidence":[],"reviewReasons":[]}}"#.into(), "POST /api/subjective-grades HTTP/1.1");
        let endpoint = Endpoint::new(origin, "test-service-token".into()).unwrap();
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
    fn legacy_service_receipts_require_explicit_regrading_before_network_work() {
        let (_dir, shared, id) = submitted();
        let legacy = shared
            .lock()
            .unwrap()
            .prepare_grade(&id, 0, false, crate::language::Locale::Chinese)
            .unwrap();
        let (origin, handle) = server(
            "200 OK",
            r#"{"status":"ungraded","error":"Synthetic"}"#.into(),
            "POST /api/subjective-grades HTTP/1.1",
        );
        let endpoint = Endpoint::new(origin, "test-service-token".into()).unwrap();
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
                &json!({"status":"graded","result":{"scoreCents":600,"maxCents":1000}}),
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
