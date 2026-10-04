use crate::contract::Result;
use serde_json::json;
#[cfg(any(target_os = "android", test))]
use serde_json::Value;
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::{plugin::TauriPlugin, Runtime};

pub(crate) trait Credential {
    fn read(&self) -> Result<Option<String>>;
    fn write(&self, value: Option<&str>) -> Result<()>;
}

impl<T: Credential + ?Sized> Credential for Box<T> {
    fn read(&self) -> Result<Option<String>> {
        (**self).read()
    }
    fn write(&self, value: Option<&str>) -> Result<()> {
        (**self).write(value)
    }
}

fn error(code: &str) -> crate::AppError {
    crate::language::error(code, json!({}))
}

fn validate_account(account: &str) -> Result<()> {
    let digest = account.strip_prefix("ai-service-token-");
    if !digest.is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        return Err(error("LOCAL_KEYCHAIN_INIT"));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Credential for keyring::Entry {
    fn read(&self) -> Result<Option<String>> {
        match self.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(error("LOCAL_KEYCHAIN_READ")),
        }
    }
    fn write(&self, value: Option<&str>) -> Result<()> {
        if let Some(value) = value {
            self.set_password(value)
                .map_err(|_| error("LOCAL_KEYCHAIN_WRITE"))
        } else {
            match self.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(error("LOCAL_KEYCHAIN_DELETE")),
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn desktop_entry(service: &str, account: &str) -> Result<keyring::Entry> {
    validate_account(account)?;
    keyring::Entry::new(service, account).map_err(|_| error("LOCAL_KEYCHAIN_INIT"))
}

#[cfg(any(target_os = "android", test))]
trait NativeInvoker {
    fn invoke(&self, command: &str, payload: Value) -> std::result::Result<Value, ()>;
}

#[cfg(any(target_os = "android", test))]
struct MobileCredential<I> {
    invoker: I,
    account: String,
}

#[cfg(any(target_os = "android", test))]
impl<I: NativeInvoker> Credential for MobileCredential<I> {
    fn read(&self) -> Result<Option<String>> {
        validate_account(&self.account)?;
        let value = self
            .invoker
            .invoke("readToken", json!({"account":self.account}))
            .map_err(|_| error("LOCAL_KEYCHAIN_READ"))?;
        let fields = value
            .as_object()
            .filter(|fields| fields.len() == 1)
            .ok_or_else(|| error("LOCAL_KEYCHAIN_READ"))?;
        match fields.get("token") {
            Some(Value::Null) => Ok(None),
            Some(Value::String(token)) => {
                crate::settings::validate_service_token(token)?;
                Ok(Some(token.clone()))
            }
            _ => Err(error("LOCAL_KEYCHAIN_READ")),
        }
    }
    fn write(&self, value: Option<&str>) -> Result<()> {
        validate_account(&self.account)?;
        if let Some(token) = value {
            crate::settings::validate_service_token(token)?;
        }
        let code = if value.is_some() {
            "LOCAL_KEYCHAIN_WRITE"
        } else {
            "LOCAL_KEYCHAIN_DELETE"
        };
        let result = self
            .invoker
            .invoke("writeToken", json!({"account":self.account,"token":value}))
            .map_err(|_| error(code))?;
        if result.as_object().is_some_and(|object| object.is_empty()) {
            Ok(())
        } else {
            Err(error(code))
        }
    }
}

#[cfg(target_os = "android")]
struct AndroidBridge<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> Clone for AndroidBridge<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

#[cfg(target_os = "android")]
impl<R: Runtime> NativeInvoker for AndroidBridge<R> {
    fn invoke(&self, command: &str, payload: Value) -> std::result::Result<Value, ()> {
        self.0.run_mobile_plugin(command, payload).map_err(|_| ())
    }
}

#[cfg(target_os = "android")]
pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("secure-storage")
        // Native Rust calls bypass this handler. JavaScript must never read tokens.
        .invoke_handler(|invoke| {
            invoke
                .resolver
                .reject("Secure storage is available only to native commands");
            true
        })
        .setup(|app, api| {
            use tauri::Manager;
            let handle =
                api.register_android_plugin("com.practiq.android", "SecureStoragePlugin")?;
            app.manage(AndroidBridge(handle));
            Ok(())
        })
        .build()
}

pub(crate) fn entry(app: &AppHandle, account: &str) -> Result<Box<dyn Credential>> {
    validate_account(account)?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        Ok(Box::new(desktop_entry(&app.config().identifier, account)?))
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app
            .try_state::<AndroidBridge<tauri::Wry>>()
            .ok_or_else(|| error("LOCAL_KEYCHAIN_INIT"))?;
        Ok(Box::new(MobileCredential {
            invoker: bridge.inner().clone(),
            account: account.into(),
        }))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
    {
        let _ = app;
        Err(error("LOCAL_KEYCHAIN_INIT"))
    }
}

#[cfg(target_os = "android")]
pub(crate) fn open_document(app: &AppHandle, uri: &str, write: bool) -> Result<i32> {
    use tauri::Manager;
    let bridge = app
        .try_state::<AndroidBridge<tauri::Wry>>()
        .ok_or_else(|| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
    open_document_with(bridge.inner(), uri, write)
}

#[cfg(any(target_os = "android", test))]
fn open_document_with(bridge: &impl NativeInvoker, uri: &str, write: bool) -> Result<i32> {
    if !uri.starts_with("content://") || uri.len() > 8192 || uri.chars().any(char::is_control) {
        return Err(error("LOCAL_DOCUMENT_UNAVAILABLE"));
    }
    let value = bridge
        .invoke("openDocument", json!({"uri":uri,"write":write}))
        .map_err(|_| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
    let fd = value
        .as_object()
        .filter(|fields| fields.len() == 1)
        .and_then(|fields| fields.get("fd"))
        .and_then(Value::as_i64)
        .and_then(|fd| i32::try_from(fd).ok())
        .filter(|fd| *fd >= 0)
        .ok_or_else(|| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
    Ok(fd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeNative {
        calls: RefCell<Vec<(String, Value)>>,
        reply: std::result::Result<Value, ()>,
    }
    impl NativeInvoker for FakeNative {
        fn invoke(&self, command: &str, payload: Value) -> std::result::Result<Value, ()> {
            self.calls.borrow_mut().push((command.into(), payload));
            self.reply.clone()
        }
    }
    fn credential(reply: std::result::Result<Value, ()>) -> MobileCredential<FakeNative> {
        MobileCredential {
            invoker: FakeNative {
                calls: RefCell::new(Vec::new()),
                reply,
            },
            account: format!("ai-service-token-{}", "a".repeat(64)),
        }
    }
    #[test]
    fn mobile_token_reads_use_the_fixed_private_protocol_and_validate_returned_values() {
        let entry = credential(Ok(json!({"token":"dummy-token"})));
        assert_eq!(entry.read().unwrap().as_deref(), Some("dummy-token"));
        assert_eq!(
            &*entry.invoker.calls.borrow(),
            &[("readToken".into(), json!({"account":entry.account}))]
        );
        assert!(credential(Ok(json!({"token":null})))
            .read()
            .unwrap()
            .is_none());
        for value in [
            json!({}),
            json!({"token":12}),
            json!({"token":"dummy-secret-detail","extra":true}),
        ] {
            let error = credential(Ok(value)).read().unwrap_err();
            assert_eq!(error.code, "LOCAL_KEYCHAIN_READ");
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("dummy-secret"));
        }
        for token in ["invalid\nvalue".into(), "密钥".into(), "x".repeat(8193)] {
            assert_eq!(
                credential(Ok(json!({"token":token})))
                    .read()
                    .unwrap_err()
                    .code,
                "LOCAL_SERVICE_TOKEN_INVALID"
            );
        }
    }
    #[test]
    fn mobile_writes_and_deletions_do_not_read_and_fail_closed_on_native_errors() {
        let entry = credential(Ok(json!({})));
        entry.write(Some("dummy-token")).unwrap();
        entry.write(None).unwrap();
        assert_eq!(
            &*entry.invoker.calls.borrow(),
            &[
                (
                    "writeToken".into(),
                    json!({"account":entry.account,"token":"dummy-token"})
                ),
                (
                    "writeToken".into(),
                    json!({"account":entry.account,"token":null})
                ),
            ]
        );
        assert_eq!(
            credential(Err(())).read().unwrap_err().code,
            "LOCAL_KEYCHAIN_READ"
        );
        assert_eq!(
            credential(Err(()))
                .write(Some("dummy-token"))
                .unwrap_err()
                .code,
            "LOCAL_KEYCHAIN_WRITE"
        );
        assert_eq!(
            credential(Err(())).write(None).unwrap_err().code,
            "LOCAL_KEYCHAIN_DELETE"
        );
        assert_eq!(
            credential(Ok(Value::Null)).write(None).unwrap_err().code,
            "LOCAL_KEYCHAIN_DELETE"
        );
    }
    #[test]
    fn legacy_or_unsafe_accounts_and_invalid_tokens_never_reach_android() {
        for account in [
            "ai-api-key-old".into(),
            "../credentials".into(),
            format!("ai-service-token-{}", "A".repeat(64)),
        ] {
            let mut entry = credential(Ok(json!({})));
            entry.account = account;
            assert!(entry.read().is_err() && entry.write(None).is_err());
            assert!(entry.invoker.calls.borrow().is_empty());
        }
        let entry = credential(Ok(json!({})));
        assert_eq!(
            entry.write(Some("invalid\nvalue")).unwrap_err().code,
            "LOCAL_SERVICE_TOKEN_INVALID"
        );
        assert!(entry.invoker.calls.borrow().is_empty());
    }
    #[test]
    fn document_bridge_binds_selected_uri_and_rejects_invalid_descriptors_without_details() {
        let native = credential(Ok(json!({"fd":12}))).invoker;
        assert_eq!(
            open_document_with(&native, "content://provider/document/123", true).unwrap(),
            12
        );
        assert_eq!(
            &*native.calls.borrow(),
            &[(
                "openDocument".into(),
                json!({"uri":"content://provider/document/123","write":true})
            )]
        );
        for reply in [
            json!({"fd":-1}),
            json!({"fd":2147483648_u64}),
            json!({"fd":"dummy-secret-detail"}),
            json!({"fd":12,"extra":true}),
            json!({}),
        ] {
            let native = credential(Ok(reply)).invoker;
            let error =
                open_document_with(&native, "content://provider/document/123", false).unwrap_err();
            assert_eq!(error.code, "LOCAL_DOCUMENT_UNAVAILABLE");
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("dummy-secret"));
        }
        let native = credential(Err(())).invoker;
        assert_eq!(
            open_document_with(&native, "content://provider/document/123", false)
                .unwrap_err()
                .code,
            "LOCAL_DOCUMENT_UNAVAILABLE"
        );
        let native = credential(Ok(json!({"fd":12}))).invoker;
        for uri in [
            "/private/file".into(),
            "file:///private/file".into(),
            "content://provider/\nsecret".into(),
            format!("content://{}", "x".repeat(8192)),
        ] {
            assert_eq!(
                open_document_with(&native, &uri, false).unwrap_err().code,
                "LOCAL_DOCUMENT_UNAVAILABLE"
            );
        }
        assert!(native.calls.borrow().is_empty());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn desktop_mock_credentials_follow_the_same_read_write_and_safe_error_contract() {
        let entry =
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        assert!(entry.read().unwrap().is_none());
        entry.write(Some("dummy-token")).unwrap();
        assert_eq!(entry.read().unwrap().as_deref(), Some("dummy-token"));
        entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap()
            .set_error(keyring::Error::Invalid(
                "dummy-secret-detail".into(),
                "failure".into(),
            ));
        let error = entry.read().unwrap_err();
        assert_eq!(error.code, "LOCAL_KEYCHAIN_READ");
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("dummy-secret"));
        entry.write(None).unwrap();
        entry.write(None).unwrap();
        assert!(entry.read().unwrap().is_none());
    }
}
