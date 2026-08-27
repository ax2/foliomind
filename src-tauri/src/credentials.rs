use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "app.foliomind.desktop";
pub const ACCOUNT: &str = "qveris-api-key";

pub trait CredentialStore: Send + Sync {
    fn read_qveris_key(&self) -> Result<Option<String>, String>;
    fn write_qveris_key(&self, value: &str) -> Result<(), String>;
    fn delete_qveris_key(&self) -> Result<(), String>;
}

pub struct OsCredentialStore;

impl OsCredentialStore {
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|error| format!("credential store unavailable: {error}"))
    }
}

impl CredentialStore for OsCredentialStore {
    fn read_qveris_key(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("cannot read QVeris credential: {error}")),
        }
    }

    fn write_qveris_key(&self, value: &str) -> Result<(), String> {
        let value = value.trim();
        if value.is_empty() || value.len() > 4096 {
            return Err("invalid QVeris credential".into());
        }
        self.entry()?
            .set_password(value)
            .map_err(|error| format!("cannot save QVeris credential: {error}"))
    }

    fn delete_qveris_key(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("cannot delete QVeris credential: {error}")),
        }
    }
}

#[cfg(test)]
pub struct InMemoryCredentialStore(Mutex<HashMap<&'static str, String>>);

#[cfg(test)]
impl InMemoryCredentialStore {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

#[cfg(test)]
impl CredentialStore for InMemoryCredentialStore {
    fn read_qveris_key(&self) -> Result<Option<String>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "credential lock poisoned")?
            .get(ACCOUNT)
            .cloned())
    }
    fn write_qveris_key(&self, value: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "credential lock poisoned")?
            .insert(ACCOUNT, value.to_owned());
        Ok(())
    }
    fn delete_qveris_key(&self) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "credential lock poisoned")?
            .remove(ACCOUNT);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn in_memory_store_round_trips_without_environment_variables() {
        let store = InMemoryCredentialStore::new();
        assert_eq!(store.read_qveris_key().unwrap(), None);
        store.write_qveris_key("test-key").unwrap();
        assert_eq!(
            store.read_qveris_key().unwrap().as_deref(),
            Some("test-key")
        );
        store.delete_qveris_key().unwrap();
        assert_eq!(store.read_qveris_key().unwrap(), None);
    }
}
