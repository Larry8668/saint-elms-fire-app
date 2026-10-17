use super::error::{SeatError, SeatResult};

/// The student's Instabox key lives in the OS credential store (macOS Keychain, Windows
/// Credential Manager, the Secret Service on Linux) under the app's identifier. The webview
/// hands it over once; nothing reads it back out to JavaScript.
const SERVICE: &str = "app.saintelmsfire.desktop";
const ACCOUNT: &str = "instabox-api-key";

/// `ibk_` plus a URL-safe secret. Checked before storing so a pasted typo fails at once.
pub fn valid_key(key: &str) -> bool {
    key.len() >= 12
        && key.len() <= 256
        && key.starts_with("ibk_")
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn entry() -> SeatResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(keychain_error)
}

fn keychain_error(error: keyring::Error) -> SeatError {
    // keyring errors describe the store, never the secret.
    SeatError::new("keychain", format!("The system keychain refused the request: {error}"))
}

pub fn save(key: &str) -> SeatResult<()> {
    let key = key.trim();
    if !valid_key(key) {
        return Err(SeatError::invalid("That does not look like an Instabox API key (they start with ibk_)."));
    }
    entry()?.set_password(key).map_err(keychain_error)
}

pub fn load() -> SeatResult<String> {
    match entry()?.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Err(SeatError::new("key_missing", "Add your Instabox API key first.")),
        Err(error) => Err(keychain_error(error)),
    }
}

pub fn present() -> SeatResult<bool> {
    match entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(keychain_error(error)),
    }
}

pub fn forget() -> SeatResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(keychain_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::valid_key;

    #[test]
    fn only_instabox_shaped_keys_are_accepted() {
        assert!(valid_key("ibk_abcdefgh1234"));
        assert!(valid_key("ibk_AbC-dEf_123456"));
        assert!(!valid_key("sk-ant-abcdefgh"));
        assert!(!valid_key("ibk_short"));
        assert!(!valid_key("ibk_has space123"));
        assert!(!valid_key("ibk_newline\n12345"));
    }
}
