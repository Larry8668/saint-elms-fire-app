use serde::Serialize;

/// What every seat command returns on failure. `code` is Instabox's own error code when the
/// API sent one (`quota_exceeded`, `no_capacity`, `insufficient_scope`, `invite_required`,
/// `machine_not_running`, ...), otherwise one of ours (`key_missing`, `invalid_input`,
/// `network`, `keychain`, `unexpected_response`). Messages never contain the API key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatError {
    pub code: String,
    pub message: String,
    /// HTTP status from Instabox, 0 when no response arrived.
    pub status: u16,
    /// True when the same request may succeed later (Instabox's `retryable`, or a network error).
    pub retryable: bool,
}

impl SeatError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), status: 0, retryable: false }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message)
    }

    pub fn network(error: &reqwest::Error) -> Self {
        // reqwest's Display can include the URL; it never includes headers, so the key stays out.
        let message = if error.is_timeout() { "Instabox did not answer in time.".to_string() } else { format!("Could not reach Instabox: {error}") };
        Self { code: "network".into(), message, status: 0, retryable: true }
    }
}

impl std::fmt::Display for SeatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for SeatError {}

pub type SeatResult<T> = Result<T, SeatError>;
