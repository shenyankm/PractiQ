use crate::{
    contract::Result,
    store::{hash, Store},
};
use keyring::Entry;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionSettings {
    pub base_url: Option<String>,
    pub model_id: Option<String>,
    pub oss_url: Option<String>,
    pub text_model: Option<String>,
    pub vision_model: Option<String>,
}
impl ConnectionSettings {
    pub fn validate(mut self) -> Result<Self> {
        for (name, value) in [
            ("Base URL", &mut self.base_url),
            ("OSS 地址", &mut self.oss_url),
        ] {
            *value = value
                .take()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty());
            if let Some(raw) = value {
                if raw.len() > 2048 {
                    return Err(format!("{name} 过长"));
                }
                let url = url::Url::parse(raw)
                    .map_err(|_| format!("{name} 必须为完整的 http(s) 地址"))?;
                let loopback = url.host_str().is_some_and(|h| {
                    h == "localhost"
                        || h == "[::1]"
                        || h.parse::<std::net::IpAddr>()
                            .is_ok_and(|ip| ip.is_loopback())
                });
                if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                    return Err(format!("{name} 需要 HTTPS，本机回环地址可使用 HTTP"));
                }
                if url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(format!("{name} 不能包含用户名、密码、查询参数或片段"));
                }
                *raw = url.to_string().trim_end_matches('/').to_owned();
            }
        }
        for value in [
            &mut self.model_id,
            &mut self.text_model,
            &mut self.vision_model,
        ] {
            *value = value
                .take()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty());
            if value
                .as_ref()
                .is_some_and(|s| s.chars().count() > 255 || s.chars().any(char::is_control))
            {
                return Err("Model ID 不合法".into());
            }
        }
        Ok(self)
    }
}
fn secret(entry: &Entry) -> Result<Option<String>> {
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取 macOS 钥匙串，请检查钥匙串是否已解锁".into()),
    }
}
fn write_secret(entry: &Entry, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        entry
            .set_password(value)
            .map_err(|_| "无法写入 macOS 钥匙串；API Key 未保存".to_owned())
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法移除钥匙串中的 API Key".into()),
        }
    }
}
fn entry(service: &str, base_url: &str) -> Result<Entry> {
    Entry::new(
        service,
        &format!("ai-api-key-{}", hash(base_url.as_bytes())),
    )
    .map_err(|_| "无法初始化 macOS 钥匙串".into())
}
impl Store {
    pub fn model_secret(&self, service: &str, base: &str) -> Result<String> {
        secret(&entry(service, base)?)?
            .filter(|s| !s.is_empty())
            .ok_or("请先在设置中保存 API Key".into())
    }
    pub fn connection_settings(&self) -> Result<ConnectionSettings> {
        self.connect()?
            .query_row(
                "SELECT base_url,model_id,oss_url,text_model,vision_model FROM settings WHERE id=1",
                [],
                |r| {
                    Ok(ConnectionSettings {
                        base_url: r.get(0)?,
                        model_id: r.get(1)?,
                        oss_url: r.get(2)?,
                        text_model: r.get(3)?,
                        vision_model: r.get(4)?,
                    })
                },
            )
            .map_err(|e| e.to_string())
    }
    pub fn settings(&self, service: &str) -> Result<Value> {
        let config = self.connection_settings()?;
        let configured = if let Some(base) = &config.base_url {
            secret(&entry(service, base)?)?.is_some()
        } else {
            false
        };
        Ok(json!({"config":config,"hasApiKey":configured}))
    }
    pub fn save_settings(
        &self,
        service: &str,
        config: ConnectionSettings,
        api_key: Option<String>,
    ) -> Result<Value> {
        let config = config.validate()?;
        if api_key
            .as_ref()
            .is_some_and(|s| s.len() > 8192 || s.chars().any(char::is_control))
        {
            return Err("API Key 不合法".into());
        }
        if api_key.as_ref().is_some_and(|s| !s.trim().is_empty()) && config.base_url.is_none() {
            return Err("保存 API Key 前请填写 Base URL".into());
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE settings SET base_url=?1,model_id=?2,oss_url=?3,text_model=?4,vision_model=?5 WHERE id=1",
            params![config.base_url, config.model_id, config.oss_url, config.text_model, config.vision_model],
        )
        .map_err(|e| e.to_string())?;
        let previous = if let (Some(base), Some(key)) = (&config.base_url, &api_key) {
            let entry = entry(service, base)?;
            let previous = secret(&entry)?;
            let key = key.trim();
            write_secret(&entry, if key.is_empty() { None } else { Some(key) })?;
            Some((entry, previous))
        } else {
            None
        };
        if let Err(error) = tx.commit() {
            if let Some((entry, previous)) = previous {
                write_secret(&entry, previous.as_deref())
                    .map_err(|_| "设置保存失败，钥匙串回滚失败；请重新设置 API Key")?;
            }
            return Err(error.to_string());
        }
        self.settings(service)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_urls_and_persists_nonsecret_settings() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::new(dir.path().to_owned()).unwrap();
        let config = ConnectionSettings {
            base_url: Some(" http://127.0.0.1:8317/v1/ ".into()),
            model_id: Some(" demo-model ".into()),
            oss_url: Some("https://bucket.oss-cn-hangzhou.aliyuncs.com".into()),
            ..Default::default()
        }
        .validate()
        .unwrap();
        assert_eq!(config.base_url.as_deref(), Some("http://127.0.0.1:8317/v1"));
        // No API key means this check can use an offline mock store and never touches user secrets.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        s.save_settings("practiq-test", config, None).unwrap();
        assert_eq!(
            s.connection_settings().unwrap().model_id.as_deref(),
            Some("demo-model")
        );
        for url in [
            "http://example.com/v1",
            "https://user:password@example.com",
            "https://example.com?apikey=secret",
            "file:///tmp/key",
        ] {
            assert!(ConnectionSettings {
                base_url: Some(url.into()),
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        let fields = s
            .connect()
            .unwrap()
            .prepare("PRAGMA table_info(settings)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(!fields.iter().any(|s| s.contains("key")));
    }
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "uses an isolated native macOS Keychain entry; run explicitly on macOS"]
    fn native_keychain_roundtrip() {
        keyring::set_default_credential_builder(keyring::macos::default_credential_builder());
        let entry = entry(
            &format!("com.practiq.test.{}", crate::store::id()),
            "https://example.com/v1",
        )
        .unwrap();
        write_secret(&entry, Some("practiq-dummy-test-value")).unwrap();
        let read = secret(&entry).unwrap();
        write_secret(&entry, None).unwrap();
        assert_eq!(read.as_deref(), Some("practiq-dummy-test-value"));
        assert!(secret(&entry).unwrap().is_none());
    }
}
