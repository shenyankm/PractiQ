use crate::{contract::Result, store::Store, AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub enum Locale {
    #[serde(rename = "zh-CN")]
    #[default]
    Chinese,
    #[serde(rename = "zh-TW")]
    TraditionalChinese,
    #[serde(rename = "en")]
    English,
}
impl Locale {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chinese => "zh-CN",
            Self::TraditionalChinese => "zh-TW",
            Self::English => "en",
        }
    }
    pub fn text<'a>(self, simplified: &'a str, traditional: &'a str, english: &'a str) -> &'a str {
        match self {
            Self::Chinese => simplified,
            Self::TraditionalChinese => traditional,
            Self::English => english,
        }
    }
}
static ERRORS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/locales/native.json"))
        .expect("native translations")
});
pub fn message(code: &str, params: &Value, locale: Locale) -> String {
    let template = ERRORS[code][locale.as_str()]
        .as_str()
        .expect("known error code");
    let mut message = template.to_owned();
    if let Some(values) = params.as_object() {
        for (key, value) in values {
            message = message.replace(
                &format!("{{{key}}}"),
                &value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string()),
            );
        }
    }
    message
}
pub fn error(code: &str, params: Value) -> AppError {
    let mut result = AppError::new(code, message(code, &params, Locale::Chinese));
    result.params = Box::new(params);
    result
}
impl Store {
    pub fn language(&self) -> Result<Option<Locale>> {
        let value: Option<String> = self
            .connect()?
            .query_row("SELECT locale FROM settings WHERE id=1", [], |r| r.get(0))
            .map_err(|e| AppError::from(e.to_string()))?;
        value
            .map(|value| {
                serde_json::from_value(json!(value))
                    .map_err(|_| error("LOCAL_LANGUAGE_INVALID", json!({})))
            })
            .transpose()
    }
    pub fn save_language(&mut self, locale: Locale) -> Result<Value> {
        self.connect()?
            .execute(
                "UPDATE settings SET locale=?1 WHERE id=1",
                [locale.as_str()],
            )
            .map_err(|e| AppError::from(e.to_string()))?;
        self.locale = locale;
        Ok(json!(locale))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preference_round_trip_backup_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(store.language().unwrap(), None);
        store.save_language(Locale::English).unwrap();
        assert_eq!(
            Store::new(dir.path().to_path_buf())
                .unwrap()
                .language()
                .unwrap(),
            Some(Locale::English)
        );
        let backup = dir.path().join("backup.zip");
        store.backup(&backup).unwrap();
        store.save_language(Locale::TraditionalChinese).unwrap();
        assert_eq!(
            Store::new(dir.path().to_path_buf())
                .unwrap()
                .language()
                .unwrap(),
            Some(Locale::TraditionalChinese)
        );
        store.restore(&backup).unwrap();
        assert_eq!(store.language().unwrap(), Some(Locale::English));
        assert!(serde_json::from_value::<Locale>(json!("fr")).is_err());
        assert!(serde_json::from_value::<crate::Request>(
            json!({"type":"save_language","locale":"fr"})
        )
        .is_err());
        assert!(store
            .connect()
            .unwrap()
            .execute("UPDATE settings SET locale='fr'", [])
            .is_err());
        let error = error("LOCAL_RESOURCE_PATH_UNSAFE", json!({"key":"../file"}));
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["code"], "LOCAL_RESOURCE_PATH_UNSAFE");
        assert_eq!(serialized["params"]["key"], "../file");
        assert!(serialized.get("diagnostic").is_none());
        let diagnostic = serde_json::to_value(AppError::from("system detail".to_owned())).unwrap();
        assert_eq!(diagnostic["diagnostic"], "system detail");
        for code in ["OFFICE_EMPTY_OUTPUT", "OFFICE_IMPORT_PENDING"] {
            let translated = message(code, &json!({}), Locale::English);
            assert!(translated.starts_with("This file"));
            assert_ne!(translated, message(code, &json!({}), Locale::Chinese));
            assert_ne!(
                translated,
                message(code, &json!({}), Locale::TraditionalChinese)
            );
        }
    }
    #[test]
    fn old_locale_constraint_upgrades_without_losing_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("practiq.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            &include_str!("schema.sql").replace("'zh-CN','zh-TW','en'", "'zh-CN','en'"),
        )
        .unwrap();
        db.execute_batch(
            "UPDATE settings SET model_id='keep-model', base_url='http://127.0.0.1:8000'; \
             INSERT INTO banks VALUES('keep-bank','Keep','',1);",
        )
        .unwrap();
        drop(db);
        let mut store = Store::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(store.banks().unwrap()[0]["id"], "keep-bank");
        assert_eq!(
            store.connection_settings().unwrap().model_id.as_deref(),
            Some("keep-model")
        );
        store.save_language(Locale::TraditionalChinese).unwrap();
        assert_eq!(
            Store::new(dir.path().to_path_buf())
                .unwrap()
                .language()
                .unwrap(),
            Some(Locale::TraditionalChinese)
        );
    }
    #[test]
    fn failed_locale_upgrade_rolls_back_the_settings_table_and_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("practiq.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            &include_str!("schema.sql").replace("'zh-CN','zh-TW','en'", "'zh-CN','en'"),
        )
        .unwrap();
        db.execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE settings SET locale='fr',model_id='keep-model'; INSERT INTO banks VALUES('keep-bank','Keep','',1);")
            .unwrap();
        drop(db);
        let original = std::fs::read(&path).unwrap();
        assert!(Store::new(dir.path().to_path_buf()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
    #[test]
    fn failed_language_write_preserves_preference_and_model_settings() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().to_path_buf()).unwrap();
        store.save_language(Locale::English).unwrap();
        store.connect().unwrap().execute_batch("UPDATE settings SET model_id='keep-model'; CREATE TRIGGER deny_language BEFORE UPDATE OF locale ON settings BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END;").unwrap();
        assert!(store.save_language(Locale::Chinese).is_err());
        assert_eq!(store.language().unwrap(), Some(Locale::English));
        assert_eq!(store.locale, Locale::English);
        assert_eq!(
            store.connection_settings().unwrap().model_id.as_deref(),
            Some("keep-model")
        );
        store
            .connect()
            .unwrap()
            .execute_batch("DROP TRIGGER deny_language")
            .unwrap();
        store.save_language(Locale::Chinese).unwrap();
        assert_eq!(store.language().unwrap(), Some(Locale::Chinese));
    }
    #[test]
    fn invalid_backup_language_does_not_replace_current_data() {
        let source = tempfile::tempdir().unwrap();
        let invalid = Store::new(source.path().to_path_buf()).unwrap();
        invalid
            .connect()
            .unwrap()
            .execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE settings SET locale='fr';")
            .unwrap();
        let archive = source.path().join("invalid.zip");
        invalid.backup(&archive).unwrap();
        let target = tempfile::tempdir().unwrap();
        let mut store = Store::new(target.path().to_path_buf()).unwrap();
        store.save_language(Locale::English).unwrap();
        let bank = store.save_bank(None, "Original bank", "").unwrap();
        assert!(store.restore(&archive).is_err());
        assert_eq!(store.language().unwrap(), Some(Locale::English));
        assert_eq!(store.banks().unwrap()[0]["id"], bank);
    }
    #[test]
    fn version_seven_is_not_modified() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf()).unwrap();
        store
            .connect()
            .unwrap()
            .execute_batch("PRAGMA user_version=7;")
            .unwrap();
        let before = std::fs::read(store.db_path()).unwrap();
        assert!(Store::new(dir.path().to_path_buf()).is_err());
        assert_eq!(before, std::fs::read(store.db_path()).unwrap());
    }
}
