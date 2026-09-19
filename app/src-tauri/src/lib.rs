mod ai;
mod assets;
mod backup;
mod contract;
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
        bank_id: Option<String>,
        search: String,
        mode: String,
        filter: String,
    },
    SaveQuestion {
        id: Option<String>,
        bank_id: String,
        question: Value,
    },
    DeleteQuestion {
        id: String,
    },
    Favorite {
        id: String,
        value: bool,
    },
    Start {
        bank_id: Option<String>,
        search: String,
        mode: String,
        filter: String,
        random: bool,
        count: usize,
    },
    Session {
        id: String,
    },
    Sessions,
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
    Settings,
    SaveSettings {
        config: settings::ConnectionSettings,
        api_key: Option<String>,
    },
}
#[derive(Serialize)]
struct AppError {
    code: &'static str,
    message: String,
}
impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self {
            code: "OPERATION_FAILED",
            message,
        }
    }
}
// ponytail: serialize a single desktop database; split reads only if measured contention warrants it.
type Shared = Arc<Mutex<Store>>;
#[tauri::command]
async fn request(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    request: Request,
) -> std::result::Result<Value, AppError> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||->contract::Result<Value>{
        // Native file dialogs select the only external paths accessible to business commands.
        let selected=match &request {
            Request::PickImport=>app.dialog().file().add_filter("AI 解析结果",&["json"]).blocking_pick_file(),
            Request::PickResources=>app.dialog().file().blocking_pick_folder(),
            Request::Backup=>app.dialog().file().set_file_name("PractiQ-backup.zip").add_filter("PractiQ 备份",&["zip"]).blocking_save_file(),
            Request::Restore=>app.dialog().file().add_filter("PractiQ 备份",&["zip"]).blocking_pick_file(),
            _=>None,
        };
        let selected=selected.map(|p|p.into_path().map_err(|e|e.to_string())).transpose()?;
        if matches!(&request,Request::PickImport|Request::PickResources|Request::Backup|Request::Restore)&&selected.is_none(){return Ok(Value::Null);}
        if matches!(&request, Request::SaveSettings{..}|Request::Restore) {ai::stop(&app)?;}
        let mut store=shared.lock().map_err(|_|"数据库暂不可用，请重启应用")?;
        match request {
            Request::PickImport=>{let path=selected.ok_or("未选择文件")?;let title=path.file_stem().and_then(|s|s.to_str()).unwrap_or("导入题库").to_owned();store.preview(store::read_bounded(&path,contract::MAX_JSON)?,title)},
            Request::PickResources=>store.resources(&selected.ok_or("未选择目录")?),
            Request::Import{ticket,bank_id,title}=>store.import(&ticket,bank_id,&title),
            Request::Banks=>store.banks(),
            Request::SaveBank{id,title,description}=>store.save_bank(id,&title,&description),
            Request::DeleteBank{id}=>store.delete_bank(&id),
            Request::Questions{bank_id,search,mode,filter}=>store.questions(bank_id.as_deref(),&search,&mode,&filter),
            Request::SaveQuestion{id,bank_id,question}=>store.save_question(id,&bank_id,question),
            Request::DeleteQuestion{id}=>store.delete_question(&id),
            Request::Favorite{id,value}=>store.favorite(&id,value),
            Request::Start{bank_id,search,mode,filter,random,count}=>store.start(bank_id.as_deref(),&search,&mode,&filter,random,count),
            Request::Session{id}=>store.session(&id),
            Request::Sessions=>store.sessions(),
            Request::SaveAttempt{id,ordinal,answer,elapsed_ms,submit,skip,self_result}=>store.save_attempt((&id, ordinal),answer,elapsed_ms,submit,skip,self_result),
            Request::Position{id,position}=>store.position(&id,position),
            Request::Finish{id}=>store.finish(&id),
            Request::Asset{hash}=>store.asset(&hash),
            Request::Backup=>store.backup(&selected.ok_or("未选择保存位置")?),
            Request::Restore=>store.restore(&selected.ok_or("未选择备份")?),
            Request::Settings=>store.settings(&app.config().identifier),
            Request::SaveSettings{config,api_key}=>store.save_settings(&app.config().identifier,config,api_key),
            Request::Info=>Ok(json!({"dataDirectory":store.dir.display().to_string(),"version":env!("CARGO_PKG_VERSION")})),
        }
    }).await.map_err(|e|AppError::from(e.to_string()))?.map_err(AppError::from)
}
#[tauri::command]
async fn ai_request(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    request: ai::AiRequest,
) -> std::result::Result<Value, AppError> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ai::request(app, shared, request))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
        .map_err(AppError::from)
}
pub fn run() {
    tauri::Builder::default()
        .manage(ai::AiState::new(None))
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
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
