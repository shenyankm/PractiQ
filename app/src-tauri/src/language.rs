use crate::{contract::Result, store::Store, AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub enum Locale {
    #[serde(rename = "zh-CN")]
    #[default]
    Chinese,
    #[serde(rename = "en")]
    English,
}
impl Locale {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chinese => "zh-CN",
            Self::English => "en",
        }
    }
    pub fn text<'a>(self, chinese: &'a str, english: &'a str) -> &'a str {
        if self == Self::Chinese {
            chinese
        } else {
            english
        }
    }
}
static ERRORS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/locales/native.json"))
        .expect("native translations")
});
pub fn error(code: &str, params: Value) -> AppError {
    let template = ERRORS[code]["zh-CN"].as_str().expect("known error code");
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
    let mut result = AppError::new(code, message);
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
        store.save_language(Locale::Chinese).unwrap();
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
