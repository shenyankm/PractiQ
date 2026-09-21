mod ai;
mod ai_work;
mod assets;
mod backup;
mod contract;
mod exams;
mod language;
mod paper;
mod questions;
mod settings;
mod store;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use store::Store;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    PickImport,
    PickResources,
    Import {
        ticket: String,
        bank_id: Option<String>,
        title: String,
    },
    Banks,
    SaveBank {
        id: Option<String>,
        title: String,
        description: String,
    },
    DeleteBank {
        id: String,
    },
    Questions {
        #[serde(default)]
        bank_ids: Vec<String>,
        bank_id: Option<String>,
        search: String,
        mode: String,
        filter: String,
    },
    SaveQuestionTree {
        bank_id: String,
        root_id: Option<String>,
        questions: Vec<Value>,
    },
    DeleteQuestion {
        id: String,
    },
    Favorite {
        id: String,
        value: bool,
    },
    Session {
        id: String,
    },
    Sessions,
    PreviewPaper {
        request: paper::Preview,
    },
    StartPaper {
        paper: exams::Paper,
    },
    SubmitPaper {
        id: String,
        submit_drafts: bool,
    },
    CompleteReview {
        id: String,
    },
    Flag {
        id: String,
        ordinal: usize,
        value: bool,
    },
    ManualScore {
        id: String,
        ordinal: usize,
        cents: i64,
        reason: String,
    },
    RetryWrong {
        id: String,
    },
    MergeBanks {
        bank_ids: Vec<String>,
        title: String,
    },
    SaveAttempt {
        id: String,
        ordinal: usize,
        answer: Value,
        elapsed_ms: i64,
        submit: bool,
        skip: bool,
        self_result: Option<bool>,
    },
    Position {
        id: String,
        position: usize,
    },
    Finish {
        id: String,
    },
    Asset {
        hash: String,
    },
    Backup,
    Restore,
    Info,
    Language,
    SaveLanguage {
        locale: language::Locale,
    },
    Settings,
    SaveSettings {
        config: settings::ConnectionSettings,
        api_key: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    code: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    params: Box<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<String>,
    message: String,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(rename = "httpStatus", skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
}
impl AppError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: Box::new(Value::Null),
            context: None,
            message: message.into(),
            request_id: None,
            http_status: None,
        }
    }
}
impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::new("OPERATION_FAILED", message)
    }
}
impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for AppError {}
// ponytail: serialize a single desktop database; split reads only if measured contention warrants it.
type Shared = Arc<Mutex<Store>>;
#[tauri::command]
async fn request(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    request: Request,
    locale: Option<language::Locale>,
) -> std::result::Result<Value, AppError> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||->contract::Result<Value>{
        let locale = locale.unwrap_or_default();
        // Native file dialogs select the only external paths accessible to business commands.
        let selected=match &request {
            Request::PickImport=>app.dialog().file().add_filter(locale.text("AI 解析结果", "AI parsing result"),&["json"]).blocking_pick_file(),
            Request::PickResources=>app.dialog().file().blocking_pick_folder(),
            Request::Backup=>app.dialog().file().set_file_name("PractiQ-backup.zip").add_filter(locale.text("PractiQ 备份", "PractiQ backup"),&["zip"]).blocking_save_file(),
            Request::Restore=>app.dialog().file().add_filter(locale.text("PractiQ 备份", "PractiQ backup"),&["zip"]).blocking_pick_file(),
            _=>None,
        };
        let selected=selected.map(|p|p.into_path().map_err(|e|e.to_string())).transpose()?;
        if matches!(&request,Request::PickImport|Request::PickResources|Request::Backup|Request::Restore)&&selected.is_none(){return Ok(Value::Null);}
        let work = app.state::<ai_work::WorkState>();
        let _restore = if matches!(&request, Request::Restore) { Some(work.restore()?) } else { None };
        if matches!(&request, Request::SaveSettings{..}|Request::Restore) {ai::stop(&app)?;}
        let mut store=shared.lock().map_err(|_|language::error("LOCAL_DATABASE_RESTART", json!({})))?;
        store.locale = locale;
        match request {
            Request::PickImport=>{let path=selected.ok_or(language::error("LOCAL_FILE_NOT_SELECTED", json!({})))?;let title=path.file_stem().and_then(|s|s.to_str()).unwrap_or(locale.text("导入题库", "Imported bank")).to_owned();store.preview(store::read_bounded(&path,contract::MAX_JSON)?,title)},
            Request::PickResources=>store.resources(&selected.ok_or(language::error("LOCAL_DIRECTORY_NOT_SELECTED", json!({})))?),
            Request::Import{ticket,bank_id,title}=>store.import(&ticket,bank_id,&title),
            Request::Banks=>store.banks(),
            Request::SaveBank{id,title,description}=>store.save_bank(id,&title,&description),
            Request::DeleteBank{id}=>store.delete_bank(&id),
            Request::Questions{bank_id,bank_ids,search,mode,filter}=>store.questions_multi(bank_id.as_deref(),&bank_ids,&search,&mode,&filter),
            Request::SaveQuestionTree{bank_id,root_id,questions}=>store.save_question_tree(&bank_id,root_id.as_deref(),questions),
            Request::DeleteQuestion{id}=>store.delete_question(&id),
            Request::Favorite{id,value}=>store.favorite(&id,value),
            Request::Session{id}=>store.session(&id),
            Request::Sessions=>store.sessions(),
            Request::StartPaper{paper}=>store.start_paper(paper),
            Request::PreviewPaper{request}=>store.preview_paper(request),
            Request::SubmitPaper{id,submit_drafts}=>store.submit_paper(&id,submit_drafts),
            Request::CompleteReview{id}=>store.complete_review(&id),
            Request::Flag{id,ordinal,value}=>store.flag(&id,ordinal,value),
            Request::ManualScore{id,ordinal,cents,reason}=>store.manual_score(&id,ordinal,cents,&reason),
            Request::RetryWrong{id}=>store.retry_wrong(&id),
            Request::MergeBanks{bank_ids,title}=>store.merge_banks(&bank_ids,&title),
            Request::SaveAttempt{id,ordinal,answer,elapsed_ms,submit,skip,self_result}=>store.save_attempt((&id, ordinal),answer,elapsed_ms,submit,skip,self_result),
            Request::Position{id,position}=>store.position(&id,position),
            Request::Finish{id}=>store.finish(&id),
            Request::Asset{hash}=>store.asset(&hash),
            Request::Backup=>store.backup(&selected.ok_or(language::error("LOCAL_SAVE_LOCATION_MISSING", json!({})))?),
            Request::Restore=>store.restore(&selected.ok_or(language::error("LOCAL_BACKUP_NOT_SELECTED", json!({})))?),
            Request::Language=>Ok(json!(store.language()?)),
            Request::SaveLanguage{locale}=>store.save_language(locale),
            Request::Settings=>store.settings(&app.config().identifier),
            Request::SaveSettings{config,api_key}=>store.save_settings(&app.config().identifier,config,api_key),
            Request::Info=>Ok(json!({"dataDirectory":store.dir.display().to_string(),"version":env!("CARGO_PKG_VERSION")})),
        }
    }).await.map_err(|e|AppError::from(e.to_string()))?
}
#[tauri::command]
async fn ai_request(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    request: ai::AiRequest,
    locale: Option<language::Locale>,
) -> std::result::Result<Value, AppError> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        shared
            .lock()
            .map_err(|_| language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
            .locale = locale.unwrap_or_default();
        ai::request(app, shared, request)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}
pub fn run() {
    tauri::Builder::default()
        .manage(ai::AiState::new(None))
        .manage(ai_work::WorkState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("v2");
            app.manage(Arc::new(Mutex::new(
                Store::new(dir).map_err(std::io::Error::other)?,
            )));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![request, ai_request])
        .build(tauri::generate_context!())
        .expect("Unable to start PractiQ")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = ai::stop(app);
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    api.prevent_exit();
                    let _ = window.close();
                }
            }
        });
}
