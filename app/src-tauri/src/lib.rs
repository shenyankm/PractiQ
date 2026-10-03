mod ai;
mod ai_work;
mod assets;
mod audio;
mod audio_import;
mod backup;
mod bank_zip;
mod contract;
mod exams;
mod filesystem;
mod language;
mod office;
mod paper;
#[cfg(test)]
mod performance;
mod question_metadata;
#[cfg(test)]
mod question_review_tests;
mod questions;
mod session_clock;
mod sessions;
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
    AddExampleBank,
    PickAudio,
    PickAudioQr,
    DecodeAudioQr {
        hash: String,
    },
    ImportAudioUrl {
        url: String,
    },
    ReleaseAudio {
        lease: String,
    },
    ListeningPlayback {
        id: String,
        question_id: String,
        action: audio::PlaybackAction,
        position: Option<f64>,
    },
    ExportBank {
        bank_id: String,
    },
    Import {
        ticket: String,
        bank_id: Option<String>,
        title: String,
    },
    Banks,
    BanksPage {
        limit: usize,
        offset: usize,
    },
    SaveBank {
        id: Option<String>,
        title: String,
        description: String,
    },
    DeleteBank {
        id: String,
    },
    QuestionsPage {
        #[serde(default)]
        bank_ids: Vec<String>,
        search: String,
        mode: String,
        filter: String,
        limit: usize,
        offset: usize,
    },
    QuestionStats {
        #[serde(default)]
        bank_ids: Vec<String>,
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
    ReviewQuestion {
        id: String,
        reviewed: bool,
    },
    Favorite {
        id: String,
        value: bool,
    },
    Session {
        id: String,
        #[serde(default)]
        snapshot_key: Option<String>,
    },
    SessionsPage {
        limit: usize,
        offset: usize,
        #[serde(default)]
        filter: String,
    },
    UnfinishedSession,
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
        #[serde(default)]
        snapshot_key: Option<String>,
        id: String,
        ordinal: usize,
        value: bool,
    },
    ManualScore {
        #[serde(default)]
        snapshot_key: Option<String>,
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
    SaveDraft {
        id: String,
        ordinal: usize,
        answer: Value,
        elapsed_ms: i64,
    },
    SelfAssess {
        #[serde(default)]
        snapshot_key: Option<String>,
        id: String,
        ordinal: usize,
        result: bool,
    },
    SaveAttempt {
        snapshot_key: Option<String>,
        id: String,
        ordinal: usize,
        answer: Value,
        elapsed_ms: i64,
        submit: bool,
        skip: bool,
        self_result: Option<bool>,
    },
    Position {
        snapshot_key: Option<String>,
        id: String,
        position: usize,
    },
    Finish {
        id: String,
    },
    Backup,
    Restore,
    Info,
    Language,
    SaveLanguage {
        locale: language::Locale,
    },
    Settings,
    TestSettings {
        config: settings::ConnectionSettings,
        api_key: Option<String>,
    },
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
    context: Option<Box<str>>,
    message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    diagnostic: Option<Box<str>>,
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
            diagnostic: None,
            request_id: None,
            http_status: None,
        }
    }
}
impl From<String> for AppError {
    fn from(message: String) -> Self {
        let mut error = Self::new("OPERATION_FAILED", message.clone());
        error.diagnostic = Some(message.into_boxed_str());
        error
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
            Request::PickAudio=>app.dialog().file().add_filter(locale.text("听力音频","Listening audio"),&["mp3","m4a","aac","wav"]).blocking_pick_file(),
            Request::PickAudioQr=>app.dialog().file().add_filter(locale.text("二维码图片","QR image"),&["png","jpg","jpeg"]).blocking_pick_file(),
            Request::PickImport=>app.dialog().file().add_filter(locale.text("PractiQ 题库 ZIP", "PractiQ bank ZIP"),&["zip"]).blocking_pick_file(),
            Request::ExportBank{bank_id}=>{
                let title = { let store=shared.lock().map_err(|_|language::error("LOCAL_DATABASE_UNAVAILABLE",json!({})))?;
                    store.connect()?.query_row("SELECT title FROM banks WHERE id=?1",[bank_id],|r|r.get::<_,String>(0)).map_err(|e|AppError::from(e.to_string()))? };
                app.dialog().file().set_file_name(bank_zip::filename(&title)).add_filter(locale.text("PractiQ 题库 ZIP","PractiQ bank ZIP"), &["zip"]).blocking_save_file()
            },
            Request::Backup=>app.dialog().file().set_file_name("PractiQ-backup.zip").add_filter(locale.text("PractiQ 备份", "PractiQ backup"),&["zip"]).blocking_save_file(),
            Request::Restore=>app.dialog().file().add_filter(locale.text("PractiQ 备份", "PractiQ backup"),&["zip"]).blocking_pick_file(),
            _=>None,
        };
        let selected=selected.map(|p|p.into_path().map_err(|e|e.to_string())).transpose()?;
        if matches!(&request,Request::PickImport|Request::PickAudio|Request::PickAudioQr|Request::ExportBank{..}|Request::Backup|Request::Restore)&&selected.is_none(){return Ok(Value::Null);}
        if let Request::ImportAudioUrl { ref url } = request {
            return match audio_import::download(url)? {
                audio_import::Download::Links(links) => Ok(json!({"links":links,"audio":null})),
                audio_import::Download::Audio(bytes) => {
                    let mut store = shared.lock().map_err(|_|language::error("LOCAL_DATABASE_UNAVAILABLE",json!({})))?;
                    let audio = store.stage_audio_bytes(bytes).map_err(|_|language::error("LOCAL_AUDIO_INVALID",json!({})))?;
                    Ok(json!({"links":[],"audio":audio}))
                }
            };
        }
        if matches!(&request, Request::PickAudioQr | Request::DecodeAudioQr { .. }) {
            let bytes = if let Request::DecodeAudioQr { ref hash } = request {
                shared.lock().map_err(|_|language::error("LOCAL_DATABASE_UNAVAILABLE",json!({})))?
                    .asset_bytes(hash)?.ok_or(language::error("LOCAL_AUDIO_QR_INVALID",json!({})))?.1
            } else {
                store::read_bounded(&selected.ok_or("No image selected")?, assets::LIMIT)?
            };
            return Ok(json!(audio_import::qr_links(&bytes)?));
        }
        if matches!(&request, Request::Settings) {
            return settings::settings(&shared);
        }
        if let Request::TestSettings { config, api_key } = request {
            let (config, key) = settings::snapshot(&shared)?
                .connection_test_input(&app.config().identifier, config, api_key)?;
            return settings::test_connection(config, key);
        }
        if let Request::SaveSettings { config, api_key } = request {
            return ai::save_settings(&app, &shared, config, api_key);
        }
        let work = app.state::<ai_work::WorkState>();
        let _restore = if matches!(&request, Request::Restore) { Some(work.restore()?) } else { None };
        if matches!(&request, Request::Restore) {ai::stop(&app)?;}
        let mut store=shared.lock().map_err(|_|language::error("LOCAL_DATABASE_RESTART", json!({})))?;
        store.locale = locale;
        match request {
            Request::ImportAudioUrl { .. } | Request::PickAudioQr | Request::DecodeAudioQr { .. } => unreachable!(),
            Request::PickAudio=>store.stage_audio(&selected.ok_or("No audio selected")?),
            Request::ReleaseAudio{lease}=>{store.release_audio(&lease);Ok(Value::Null)},
            Request::ListeningPlayback{id,question_id,action,position}=>store.listening_playback(&id,&question_id,action,position),
            Request::AddExampleBank=>store.add_example_bank(),
            Request::PickImport=>store.preview_bank_zip(&selected.ok_or(language::error("LOCAL_FILE_NOT_SELECTED",json!({})))?),
            Request::ExportBank{bank_id}=>store.export_bank(&bank_id,&selected.ok_or(language::error("LOCAL_SAVE_LOCATION_MISSING",json!({})))?),
            Request::Import{ticket,bank_id,title}=>store.import(&ticket,bank_id,&title),
            Request::Banks=>store.banks(),
            Request::BanksPage{limit,offset}=>store.banks_page(limit,offset),
            Request::SaveBank{id,title,description}=>store.save_bank(id,&title,&description),
            Request::DeleteBank{id}=>store.delete_bank(&id),
            Request::QuestionsPage{bank_ids,search,mode,filter,limit,offset}=>store.query_questions(&bank_ids,(&search,&mode,&filter),Some((limit,offset))),
            Request::QuestionStats{bank_ids,search,mode,filter}=>store.question_stats(&bank_ids,(&search,&mode,&filter)),
            Request::SaveQuestionTree{bank_id,root_id,questions}=>store.save_question_tree(&bank_id,root_id.as_deref(),questions),
            Request::DeleteQuestion{id}=>store.delete_question(&id),
            Request::ReviewQuestion{id,reviewed}=>store.review_question(&id,reviewed),
            Request::Favorite{id,value}=>store.favorite(&id,value),
            Request::Session{id,snapshot_key}=>store.session_data(&id,snapshot_key.as_deref()),
            Request::SessionsPage{limit,offset,filter}=>store.sessions_filtered(limit,offset,if filter.is_empty(){"all"}else{&filter}),
            Request::UnfinishedSession=>store.unfinished_session(),
            Request::StartPaper{paper}=>store.start_paper_data(paper),
            Request::PreviewPaper{request}=>store.preview_paper(request),
            Request::SubmitPaper{id,submit_drafts}=>store.submit_paper_data(&id,submit_drafts),
            Request::CompleteReview{id}=>store.complete_review_data(&id),
            Request::Flag{id,ordinal,value,snapshot_key}=>store.flag_with_key(&id,ordinal,value,snapshot_key.as_deref()),
            Request::ManualScore{id,ordinal,cents,reason,snapshot_key}=>store.manual_score_with_key(&id,ordinal,cents,&reason,snapshot_key.as_deref()),
            Request::RetryWrong{id}=>store.retry_wrong_data(&id),
            Request::MergeBanks{bank_ids,title}=>store.merge_banks(&bank_ids,&title),
            Request::SaveAttempt{id,ordinal,answer,elapsed_ms,submit,skip,self_result,snapshot_key}=>{
                store.write_attempt((&id, ordinal),answer,elapsed_ms,submit,skip,self_result)?;
                store.session_data(&id,snapshot_key.as_deref())
            },
            Request::SaveDraft{id,ordinal,answer,elapsed_ms}=>store.save_draft((&id,ordinal),answer,elapsed_ms),
            Request::SelfAssess{id,ordinal,result,snapshot_key}=>store.self_assess_with_key(&id,ordinal,result,snapshot_key.as_deref()),
            Request::Position{id,position,snapshot_key}=>store.position(&id,position,snapshot_key.as_deref()),
            Request::Finish{id}=>store.finish_data(&id),
            Request::Backup=>store.backup(&selected.ok_or(language::error("LOCAL_SAVE_LOCATION_MISSING", json!({})))?),
            Request::Restore=>store.restore(&selected.ok_or(language::error("LOCAL_BACKUP_NOT_SELECTED", json!({})))?),
            Request::Language=>Ok(json!(store.language()?)),
            Request::SaveLanguage{locale}=>store.save_language(locale),
            Request::TestSettings{..}|Request::Settings|Request::SaveSettings{..}=>unreachable!(),
            Request::Info=>Ok(json!({"dataDirectory":store.dir.display().to_string(),"version":env!("CARGO_PKG_VERSION")})),
        }
    }).await.map_err(|e|AppError::from(e.to_string()))?
}
#[tauri::command]
async fn read_asset(
    state: State<'_, Shared>,
    hash: String,
) -> std::result::Result<tauri::ipc::Response, AppError> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = shared
            .lock()
            .map_err(|_| language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?;
        let (_, bytes) = store
            .asset_bytes(&hash)?
            .ok_or(language::error("LOCAL_ASSET_MISSING", json!({})))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}
#[tauri::command]
async fn read_review_image(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    id: String,
    checkpoint_id: String,
    unit: usize,
    visual: Option<usize>,
) -> std::result::Result<tauri::ipc::Response, AppError> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ai::read_review_image(app, shared, id, checkpoint_id, unit, visual)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
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
        ai::request(app, shared, request, locale.unwrap_or_default())
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}
#[tauri::command]
async fn office_request(
    app: tauri::AppHandle,
    request: office::Request,
    locale: Option<language::Locale>,
) -> std::result::Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        office::request(app, request, locale.unwrap_or_default())
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}
pub(crate) const DATA_DIRECTORY: &str = "v4";

pub fn run() {
    tauri::Builder::default()
        .manage(ai::AiState::new(None))
        .manage(ai_work::WorkState::default())
        .manage(office::OfficeState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join(DATA_DIRECTORY);
            app.manage(Arc::new(Mutex::new(
                Store::new(dir).map_err(std::io::Error::other)?,
            )));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            request,
            ai_request,
            office_request,
            read_asset,
            read_review_image
        ])
        .build(tauri::generate_context!())
        .expect("Unable to start PractiQ")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<office::OfficeState>().shutdown();
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
