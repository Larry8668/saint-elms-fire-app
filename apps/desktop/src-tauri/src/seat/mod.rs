//! Hosted-seat provisioning against the student's own Instabox account.
//!
//! api.instabox.sh sends no CORS headers, so the webview cannot call it; and the student's
//! key must not live where page scripts can read it. Both point here: the key goes into the
//! OS keychain once, and the webview drives provisioning through the narrow commands below.
//! No command runs an arbitrary command on the box or fetches an arbitrary URL: the create
//! body, the published port, the bootstrap script and the status probe are all fixed here.

pub mod bootstrap;
pub mod client;
pub mod error;
pub mod keychain;

#[cfg(test)]
mod contract_tests;

use std::time::Duration;

use serde::Serialize;

pub use bootstrap::{BootstrapParams, BootstrapStatus};
pub use client::{Account, InstaboxClient, Machine, Operation, Power, PublishedPort};
pub use error::{SeatError, SeatResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatHealth {
    /// The engine answered `/api/health` with 200.
    pub ok: bool,
    /// HTTP status from the edge or the engine; 0 when nothing answered. 502 means the box is
    /// up but nothing listens on the port yet; 503 means the box is offline.
    pub status: u16,
}

/// Bootstrap actions that need the key, written once against a client so the Tauri commands
/// and the headless harness run exactly the same code.
pub async fn start_bootstrap(client: &InstaboxClient, machine_id: &str, params: &BootstrapParams) -> SeatResult<&'static str> {
    let result = client.exec(machine_id, &bootstrap::launch_body(params)?).await?;
    bootstrap::parse_launch(&result.stdout).ok_or_else(|| {
        let detail: String = result.stderr.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
        SeatError::new("bootstrap_launch_failed", format!("The box could not start the setup script (exit {}): {}", result.exit_code, detail.trim()))
    })
}

pub async fn bootstrap_status(client: &InstaboxClient, machine_id: &str) -> SeatResult<BootstrapStatus> {
    let result = client.exec(machine_id, &bootstrap::status_body()).await?;
    if result.exit_code != 0 {
        return Err(SeatError::new("bootstrap_status_failed", format!("Reading the setup status failed (exit {}).", result.exit_code)));
    }
    Ok(bootstrap::parse_status(&result.stdout))
}

/// The seat's engine URL: HTTPS to a named host (an Instabox published port today; a private
/// address such as a tailnet name later). Only `/api/health` is fetched, without redirects, and
/// only the status comes back, so this is not a general-purpose fetch for the webview.
pub fn seat_health_url(url: &str) -> SeatResult<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).map_err(|_| SeatError::invalid("That is not a seat URL."))?;
    let host = parsed.host_str().unwrap_or_default();
    let named = bootstrap::valid_host(host) && host.parse::<std::net::Ipv4Addr>().is_err();
    if parsed.scheme() != "https" || !named || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(SeatError::invalid("A seat URL is https:// with a host name."));
    }
    parsed.join("/api/health").map_err(|_| SeatError::invalid("That is not a seat URL."))
}

pub async fn probe_health(url: &str) -> SeatResult<SeatHealth> {
    let target = seat_health_url(url)?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| SeatError::new("internal", format!("Could not start the HTTP client: {e}")))?;
    match http.get(target).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let ok = status == 200 && response.json::<serde_json::Value>().await.is_ok_and(|body| body["ok"] == true);
            Ok(SeatHealth { ok, status })
        }
        Err(error) if error.is_timeout() || error.is_connect() => Ok(SeatHealth { ok: false, status: 0 }),
        Err(error) => Err(SeatError::network(&error)),
    }
}

fn client() -> SeatResult<InstaboxClient> {
    InstaboxClient::new(keychain::load()?)
}

pub mod commands {
    //! The Tauri surface. Each command reads the key from the keychain itself; none takes it
    //! as an argument except `seat_key_save`, and none returns it.
    use super::*;

    #[tauri::command]
    pub fn seat_key_save(key: String) -> SeatResult<()> {
        keychain::save(&key)
    }

    #[tauri::command]
    pub fn seat_key_present() -> SeatResult<bool> {
        keychain::present()
    }

    #[tauri::command]
    pub fn seat_key_forget() -> SeatResult<()> {
        keychain::forget()
    }

    #[tauri::command]
    pub async fn seat_account() -> SeatResult<Account> {
        client()?.account().await
    }

    #[tauri::command]
    pub async fn seat_list() -> SeatResult<Vec<Machine>> {
        client()?.list_seats().await
    }

    #[tauri::command]
    pub async fn seat_create(name: String, idempotency_key: String) -> SeatResult<Operation> {
        client()?.create_seat(&name, &idempotency_key).await
    }

    #[tauri::command]
    pub async fn seat_operation(operation_id: String) -> SeatResult<Operation> {
        client()?.operation(&operation_id).await
    }

    #[tauri::command]
    pub async fn seat_machine(machine_id: String) -> SeatResult<Machine> {
        client()?.machine(&machine_id).await
    }

    #[tauri::command]
    pub async fn seat_power(machine_id: String, action: String, idempotency_key: String) -> SeatResult<Operation> {
        let power = match action.as_str() {
            "start" => Power::Start,
            "resume" => Power::Resume,
            _ => return Err(SeatError::invalid("A seat can only be started or resumed here.")),
        };
        client()?.power(&machine_id, power, &idempotency_key).await
    }

    #[tauri::command]
    pub async fn seat_publish(machine_id: String) -> SeatResult<PublishedPort> {
        client()?.publish_engine_port(&machine_id).await
    }

    #[tauri::command]
    pub async fn seat_bootstrap_start(machine_id: String, params: BootstrapParams) -> SeatResult<&'static str> {
        start_bootstrap(&client()?, &machine_id, &params).await
    }

    #[tauri::command]
    pub async fn seat_bootstrap_status(machine_id: String) -> SeatResult<BootstrapStatus> {
        bootstrap_status(&client()?, &machine_id).await
    }

    #[tauri::command]
    pub async fn seat_health(url: String) -> SeatResult<SeatHealth> {
        probe_health(&url).await
    }
}

#[cfg(test)]
mod tests {
    use super::seat_health_url;

    #[test]
    fn health_probes_only_named_https_seat_urls() {
        assert_eq!(seat_health_url("https://4100-agquudskm6tjef4hlnbtbki6by.instabox.tech").unwrap().as_str(), "https://4100-agquudskm6tjef4hlnbtbki6by.instabox.tech/api/health");
        assert_eq!(seat_health_url("https://seat.tail1234.ts.net:4100/").unwrap().as_str(), "https://seat.tail1234.ts.net:4100/api/health");
        for bad in ["http://4100-x.instabox.tech", "https://u@4100-x.instabox.tech", "https://169.254.169.254", "https://[::1]", "https://localhost", "file:///etc/passwd"] {
            assert!(seat_health_url(bad).is_err(), "{bad}");
        }
    }
}
