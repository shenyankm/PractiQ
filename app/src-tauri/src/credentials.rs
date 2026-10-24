use crate::contract::Result;
use serde_json::json;
use tauri::AppHandle;

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
    let digest = account
        .strip_prefix("ai-service-token-")
        .or_else(|| account.strip_prefix("ai-model-key-v1-"));
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

pub(crate) fn desktop_entry(service: &str, account: &str) -> Result<keyring::Entry> {
    validate_account(account)?;
    keyring::Entry::new(service, account).map_err(|_| error("LOCAL_KEYCHAIN_INIT"))
}

pub(crate) fn entry(app: &AppHandle, account: &str) -> Result<Box<dyn Credential>> {
    Ok(Box::new(desktop_entry(&app.config().identifier, account)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_accounts_keep_separate_versioned_namespaces() {
        for prefix in ["ai-service-token-", "ai-model-key-v1-"] {
            assert!(validate_account(&format!("{prefix}{}", "a".repeat(64))).is_ok());
            assert!(validate_account(&format!("{prefix}{}", "A".repeat(64))).is_err());
        }
        for account in ["ai-api-key-old", "../credentials", "ai-service-token-"] {
            assert_eq!(
                validate_account(account).unwrap_err().code,
                "LOCAL_KEYCHAIN_INIT"
            );
        }
    }

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
