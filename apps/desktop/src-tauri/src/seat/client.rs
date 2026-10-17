use std::time::Duration;

use reqwest::{Method, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::error::{SeatError, SeatResult};

/// The only API host the seat commands talk to.
pub const API_BASE: &str = "https://api.instabox.sh";
/// The label that marks a machine as this app's seat; the list precheck filters on it.
pub const SEAT_METADATA: (&str, &str) = ("app", "sef-seat");
/// The port the engine listens on inside the box, published through the edge.
pub const ENGINE_PORT: u16 = 4100;
const AUTO_SUSPEND_SECONDS: u32 = 1800;
/// The operation long poll is capped at 30 s server side.
const OPERATION_WAIT: &str = "25s";
const LIST_PAGE_LIMIT: usize = 10;

/// A thin, typed Instabox client. The key is held only here, sent only as `X-API-Key` to
/// `base`, and never logged or returned.
pub struct InstaboxClient {
    http: reqwest::Client,
    base: String,
    key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    #[serde(default)]
    pub activated: bool,
    #[serde(default)]
    pub invite_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    #[serde(default)]
    pub ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub state: String,
    #[serde(default)]
    pub runtime: Option<Runtime>,
    #[serde(default)]
    pub auto_suspended_at: Option<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    #[serde(default)]
    pub machine_id: Option<String>,
    #[serde(rename = "type", default)]
    pub kind: String,
    pub state: String,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub error: Option<OperationError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPort {
    pub port: u16,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    #[serde(default)]
    pub timed_out: bool,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: OperationError,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineList {
    machines: Vec<Machine>,
    next_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Power {
    Start,
    Resume,
}

/// `m_` plus 26 lowercase base32 characters; checked before an id reaches a URL path.
pub fn valid_machine_id(id: &str) -> bool {
    id.len() == 28 && id.starts_with("m_") && id[2..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn valid_operation_id(id: &str) -> bool {
    id.len() == 29 && id.starts_with("op_") && id[3..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Instabox accepts 1-200 printable ASCII characters; the app sends UUIDs.
fn valid_idempotency_key(key: &str) -> bool {
    (1..=200).contains(&key.len()) && key.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn valid_machine_name(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn machine_id(id: &str) -> SeatResult<&str> {
    if valid_machine_id(id) {
        Ok(id)
    } else {
        Err(SeatError::invalid("That is not an Instabox machine id."))
    }
}

impl InstaboxClient {
    pub fn new(key: String) -> SeatResult<Self> {
        Self::with_base(API_BASE.to_string(), key)
    }

    /// Tests point this at a local fake server; the app always uses [`API_BASE`].
    pub fn with_base(base: String, key: String) -> SeatResult<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // Long enough for a 25 s operation poll and a short exec.
            .timeout(Duration::from_secs(90))
            .user_agent(concat!("saint-elms-fire/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| SeatError::new("internal", format!("Could not start the HTTP client: {e}")))?;
        Ok(Self { http, base: base.trim_end_matches('/').to_string(), key })
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.http.request(method, format!("{}{}", self.base, path)).header("X-API-Key", &self.key)
    }

    async fn send<T: DeserializeOwned>(&self, builder: RequestBuilder) -> SeatResult<T> {
        let response = builder.send().await.map_err(|e| SeatError::network(&e))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|e| SeatError::network(&e))?;
        if status.is_success() {
            return serde_json::from_slice(&bytes).map_err(|e| SeatError {
                code: "unexpected_response".into(),
                message: format!("Instabox sent a response this app does not understand: {e}"),
                status: status.as_u16(),
                retryable: false,
            });
        }
        Err(api_error(status, &bytes))
    }

    pub async fn account(&self) -> SeatResult<Account> {
        self.send(self.request(Method::GET, "/v1/me")).await
    }

    /// Every machine labelled as this app's seat, across pages.
    pub async fn list_seats(&self) -> SeatResult<Vec<Machine>> {
        let label = format!("{}:{}", SEAT_METADATA.0, SEAT_METADATA.1);
        let mut machines = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..LIST_PAGE_LIMIT {
            let mut query = vec![("metadata", label.clone())];
            if let Some(c) = &cursor {
                query.push(("cursor", c.clone()));
            }
            let page: MachineList = self.send(self.request(Method::GET, "/v1/machines").query(&query)).await?;
            machines.extend(page.machines);
            match page.next_cursor {
                Some(next) if !next.is_empty() => cursor = Some(next),
                _ => break,
            }
        }
        Ok(machines)
    }

    /// The seat's create call. Everything except the name is fixed here: the `universal`
    /// template, no Vault, the seat label and a 30-minute idle suspend.
    pub async fn create_seat(&self, name: &str, idempotency_key: &str) -> SeatResult<Operation> {
        if !valid_machine_name(name) {
            return Err(SeatError::invalid("A machine name is lowercase letters, digits and dashes."));
        }
        if !valid_idempotency_key(idempotency_key) {
            return Err(SeatError::invalid("Bad idempotency key."));
        }
        let body = json!({
            "name": name,
            "templateId": "universal",
            "vault": false,
            "metadata": { SEAT_METADATA.0: SEAT_METADATA.1 },
            "autoSuspendAfterSeconds": AUTO_SUSPEND_SECONDS,
        });
        self.send(self.request(Method::POST, "/v1/machines").header("Idempotency-Key", idempotency_key).json(&body)).await
    }

    pub async fn operation(&self, id: &str) -> SeatResult<Operation> {
        if !valid_operation_id(id) {
            return Err(SeatError::invalid("That is not an Instabox operation id."));
        }
        self.send(self.request(Method::GET, &format!("/v1/operations/{id}")).query(&[("wait", OPERATION_WAIT)])).await
    }

    pub async fn machine(&self, id: &str) -> SeatResult<Machine> {
        let id = machine_id(id)?;
        self.send(self.request(Method::GET, &format!("/v1/machines/{id}"))).await
    }

    pub async fn power(&self, id: &str, power: Power, idempotency_key: &str) -> SeatResult<Operation> {
        let id = machine_id(id)?;
        if !valid_idempotency_key(idempotency_key) {
            return Err(SeatError::invalid("Bad idempotency key."));
        }
        let verb = match power {
            Power::Start => "start",
            Power::Resume => "resume",
        };
        let builder = self.request(Method::POST, &format!("/v1/machines/{id}/{verb}")).header("Idempotency-Key", idempotency_key).json(&json!({}));
        self.send(builder).await
    }

    /// Publishing is idempotent server side (200 with the same URL when it exists) and takes
    /// no Idempotency-Key.
    pub async fn publish_engine_port(&self, id: &str) -> SeatResult<PublishedPort> {
        let id = machine_id(id)?;
        let builder = self.request(Method::POST, &format!("/v1/machines/{id}/ports")).json(&json!({ "port": ENGINE_PORT, "name": "engine" }));
        let port: PublishedPort = self.send(builder).await?;
        if port.url.is_empty() {
            return Err(SeatError::new("ports_unavailable", "Instabox has public ports switched off, so the seat cannot get a URL."));
        }
        Ok(port)
    }

    /// Exec is blocking and NOT idempotent: a retry runs the command again. Callers only send
    /// commands that are safe to repeat.
    pub(crate) async fn exec(&self, id: &str, body: &Value) -> SeatResult<ExecResult> {
        let id = machine_id(id)?;
        self.send(self.request(Method::POST, &format!("/v1/machines/{id}/exec")).json(body)).await
    }
}

fn api_error(status: StatusCode, bytes: &[u8]) -> SeatError {
    match serde_json::from_slice::<ErrorBody>(bytes) {
        Ok(body) => SeatError { code: body.error.code, message: body.error.message, status: status.as_u16(), retryable: body.error.retryable },
        Err(_) => SeatError {
            code: if status.is_server_error() { "host_unavailable".into() } else { "unexpected_response".into() },
            message: format!("Instabox answered {status} without an error body."),
            status: status.as_u16(),
            retryable: status.is_server_error(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_ids_are_checked_before_they_reach_a_path() {
        assert!(valid_machine_id("m_agquudskm6tjef4hlnbtbki6by"));
        assert!(!valid_machine_id("m_agquudskm6tjef4hlnbtbki6b"));
        assert!(!valid_machine_id("m_agquudskm6tjef4hlnbtbki6b/"));
        assert!(!valid_machine_id("m_../../v1/keys/xxxxxxxxxxxxx"));
        assert!(!valid_machine_id("box-c0ab84"));
    }

    #[test]
    fn machine_names_stay_simple() {
        assert!(valid_machine_name("sef-seat-e2e-2"));
        assert!(!valid_machine_name("Sef"));
        assert!(!valid_machine_name("-x"));
        assert!(!valid_machine_name("a/b"));
    }

    #[test]
    fn error_bodies_keep_the_instabox_code() {
        let e = api_error(StatusCode::SERVICE_UNAVAILABLE, br#"{"error":{"code":"no_capacity","message":"full","requestId":"r","retryable":true,"operationId":null}}"#);
        assert_eq!((e.code.as_str(), e.status, e.retryable), ("no_capacity", 503, true));
        let e = api_error(StatusCode::BAD_GATEWAY, b"<html>");
        assert_eq!((e.code.as_str(), e.retryable), ("host_unavailable", true));
    }
}
