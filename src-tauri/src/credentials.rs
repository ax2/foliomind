#[cfg(test)]
use std::{collections::HashMap, sync::Mutex};

#[cfg(target_os = "linux")]
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

#[cfg(target_os = "linux")]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

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

    #[cfg(target_os = "linux")]
    fn fallback_path() -> Result<PathBuf, String> {
        let config_dir = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .ok_or("cannot resolve Linux credential fallback directory")?;
        Ok(config_dir.join("foliomind").join("qveris-api-key"))
    }

    #[cfg(target_os = "linux")]
    fn fallback_read() -> Result<Option<String>, String> {
        let path = Self::fallback_path()?;
        let mut value = String::new();
        match fs::File::open(&path) {
            Ok(mut file) => {
                file.read_to_string(&mut value)
                    .map_err(|error| format!("cannot read Linux credential fallback: {error}"))?;
                let value = value.trim().to_owned();
                Ok((!value.is_empty()).then_some(value))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("cannot open Linux credential fallback: {error}")),
        }
    }

    #[cfg(target_os = "linux")]
    fn fallback_write(value: &str) -> Result<(), String> {
        let path = Self::fallback_path()?;
        let parent = path
            .parent()
            .ok_or("Linux credential fallback directory is unavailable")?;
        fs::create_dir_all(parent).map_err(|error| {
            format!("cannot create Linux credential fallback directory: {error}")
        })?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| format!("cannot open Linux credential fallback: {error}"))?;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("cannot protect Linux credential fallback: {error}"))?;
        file.write_all(value.as_bytes())
            .map_err(|error| format!("cannot write Linux credential fallback: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync Linux credential fallback: {error}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn fallback_delete() -> Result<(), String> {
        match fs::remove_file(Self::fallback_path()?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("cannot delete Linux credential fallback: {error}")),
        }
    }
}

impl CredentialStore for OsCredentialStore {
    fn read_qveris_key(&self) -> Result<Option<String>, String> {
        let result = match self.entry() {
            Ok(entry) => match entry.get_password() {
                Ok(value) => Ok((!value.trim().is_empty()).then_some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(format!("cannot read QVeris credential: {error}")),
            },
            Err(error) => Err(error),
        };
        match result {
            Ok(value) => {
                #[cfg(target_os = "linux")]
                if value.is_none() {
                    return Self::fallback_read();
                }
                Ok(value)
            }
            #[cfg(target_os = "linux")]
            Err(_) => Self::fallback_read(),
            #[cfg(not(target_os = "linux"))]
            Err(error) => Err(format!("cannot read QVeris credential: {error}")),
        }
    }

    fn write_qveris_key(&self, value: &str) -> Result<(), String> {
        let value = value.trim();
        if value.is_empty() || value.len() > 4096 {
            return Err("invalid QVeris credential".into());
        }
        let result = self.entry().and_then(|entry| {
            entry
                .set_password(value)
                .map_err(|error| format!("cannot save QVeris credential: {error}"))
        });
        match result {
            Ok(()) => Ok(()),
            #[cfg(target_os = "linux")]
            Err(_) => Self::fallback_write(value),
            #[cfg(not(target_os = "linux"))]
            Err(error) => Err(format!("cannot save QVeris credential: {error}")),
        }
    }

    fn delete_qveris_key(&self) -> Result<(), String> {
        let result = self.entry().and_then(|entry| {
            entry
                .delete_credential()
                .map_err(|error| format!("cannot delete QVeris credential: {error}"))
        });
        match result {
            Ok(()) => {
                #[cfg(target_os = "linux")]
                Self::fallback_delete()?;
                Ok(())
            }
            #[cfg(target_os = "linux")]
            Err(_) => Self::fallback_delete(),
            #[cfg(not(target_os = "linux"))]
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
