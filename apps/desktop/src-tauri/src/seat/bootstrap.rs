use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::error::{SeatError, SeatResult};

/// The script the box runs, compiled into the app so the app and the script always match.
pub const SCRIPT: &str = include_str!("../../../../../infra/seat/bootstrap.sh");
const SEAT_HOME: &str = "/data/home/sef-seat";

/// Writes the script and starts it detached. Exec blocks for at most 600 s and a retry re-runs
/// the command, so the long work runs under `setsid nohup` and this call returns at once. The
/// lock check keeps a retry from overwriting the script under a run that is still going.
const LAUNCH: &str = r#"set -eu
mkdir -p /data/home/sef-seat
cd /data/home/sef-seat
if ! flock -n lock true; then echo already_running; exit 0; fi
printf 'starting\n' > state
cat > bootstrap.sh
chmod 700 bootstrap.sh
setsid nohup bash bootstrap.sh >> bootstrap.log 2>&1 < /dev/null &
echo started"#;

/// Read-only: the run's state, whether a run holds the lock, its step markers and a log tail.
const STATUS: &str = r#"cd /data/home/sef-seat 2>/dev/null || { echo state=absent; echo running=0; exit 0; }
printf 'state=%s\n' "$(cat state 2>/dev/null || echo absent)"
if flock -n lock true 2>/dev/null; then echo running=0; else echo running=1; fi
echo --status--
cat status 2>/dev/null || true
echo --log--
tail -n 200 bootstrap.log 2>/dev/null | grep -Ev 'Extracting|Downloading|Download complete|Pull complete|Pulling fs layer|Verifying|Waiting|Progress: resolved' | tail -n 30 | cut -c1-300 || true"#;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapParams {
    /// Git ref or commit of the app repo the box runs.
    pub git_ref: String,
    pub public_host: String,
    pub uni_url: String,
    #[serde(default)]
    pub chat_model: Option<String>,
    #[serde(default)]
    pub embed_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepMark {
    pub name: String,
    /// `running`, `done` or `failed`.
    pub state: String,
    pub seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
    /// `absent` (never ran), `starting` (launched, not yet locked), `running`, `done` or `failed:<step>`.
    pub state: String,
    /// A run holds the lock right now.
    pub running: bool,
    pub steps: Vec<StepMark>,
    pub log_tail: String,
}

fn valid_ref(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        && !value.contains("..")
}

pub fn valid_host(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    value.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn valid_uni_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else { return false };
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b".:/_~-".contains(&b))
}

fn valid_model(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._:/-".contains(&b))
}

/// The exec body that starts a run. Inputs travel as environment variables, never spliced
/// into the command; the script validates them again on the box.
pub fn launch_body(params: &BootstrapParams) -> SeatResult<Value> {
    if !valid_ref(&params.git_ref) {
        return Err(SeatError::invalid("The engine version must be a plain git ref or commit."));
    }
    if !valid_host(&params.public_host) {
        return Err(SeatError::invalid("The seat's public host is not a hostname."));
    }
    if !valid_uni_url(&params.uni_url) {
        return Err(SeatError::invalid("The university server must be a plain http(s) URL."));
    }
    let mut envs = serde_json::Map::new();
    envs.insert("SEAT_HOME".into(), SEAT_HOME.into());
    envs.insert("SEAT_REF".into(), params.git_ref.clone().into());
    envs.insert("SEAT_PUBLIC_HOST".into(), params.public_host.clone().into());
    envs.insert("SEAT_UNI_URL".into(), params.uni_url.clone().into());
    for (name, value) in [("SEAT_CHAT_MODEL", &params.chat_model), ("SEAT_EMBED_MODEL", &params.embed_model)] {
        if let Some(model) = value {
            if !valid_model(model) {
                return Err(SeatError::invalid("A model name is lowercase letters, digits and . _ : / -."));
            }
            envs.insert(name.into(), model.clone().into());
        }
    }
    Ok(json!({ "cmd": LAUNCH, "stdin": SCRIPT, "envs": envs, "timeoutSeconds": 60 }))
}

pub fn status_body() -> Value {
    json!({ "cmd": STATUS, "timeoutSeconds": 30 })
}

/// `started` or `already_running`; anything else is a launch failure.
pub fn parse_launch(stdout: &str) -> Option<&'static str> {
    match stdout.trim().lines().last() {
        Some("started") => Some("started"),
        Some("already_running") => Some("already_running"),
        _ => None,
    }
}

pub fn parse_status(stdout: &str) -> BootstrapStatus {
    let mut state = "absent".to_string();
    let mut running = false;
    let mut steps: Vec<StepMark> = Vec::new();
    let mut log = Vec::new();
    let mut section = "head";
    for line in stdout.lines() {
        match line {
            "--status--" => section = "status",
            "--log--" => section = "log",
            _ if section == "head" => {
                if let Some(value) = line.strip_prefix("state=") {
                    state = value.trim().to_string();
                } else if let Some(value) = line.strip_prefix("running=") {
                    running = value.trim() == "1";
                }
            }
            _ if section == "status" => {
                // `<epoch> <step> <start|done|fail> [seconds=N|exit=N]`
                let parts: Vec<&str> = line.split_whitespace().collect();
                let (Some(name), Some(event)) = (parts.get(1), parts.get(2)) else { continue };
                if *name == "bootstrap" {
                    continue;
                }
                let seconds = parts.get(3).and_then(|p| p.strip_prefix("seconds=")).and_then(|s| s.parse().ok());
                let mark = match *event {
                    "start" => "running",
                    "done" => "done",
                    "fail" => "failed",
                    _ => continue,
                };
                match steps.iter_mut().find(|s| s.name == *name) {
                    Some(step) => {
                        step.state = mark.to_string();
                        step.seconds = seconds.or(step.seconds);
                    }
                    None => steps.push(StepMark { name: name.to_string(), state: mark.to_string(), seconds }),
                }
            }
            _ => log.push(line),
        }
    }
    // A step left "running" with no run holding the lock was cut short (a reboot, a kill).
    if !running {
        for step in steps.iter_mut().filter(|s| s.state == "running") {
            step.state = "failed".into();
        }
        if state == "running" {
            state = "failed:interrupted".into();
        }
    }
    BootstrapStatus { state, running, steps, log_tail: log.join("\n") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> BootstrapParams {
        BootstrapParams {
            git_ref: "feat/38a-seat-bootstrap".into(),
            public_host: "4100-agquudskm6tjef4hlnbtbki6by.instabox.tech".into(),
            uni_url: "https://uni.example.test".into(),
            chat_model: None,
            embed_model: None,
        }
    }

    #[test]
    fn launch_sends_the_script_on_stdin_and_inputs_as_env() {
        let body = launch_body(&params()).unwrap();
        assert_eq!(body["stdin"], SCRIPT);
        assert_eq!(body["cmd"], LAUNCH);
        assert_eq!(body["envs"]["SEAT_PUBLIC_HOST"], "4100-agquudskm6tjef4hlnbtbki6by.instabox.tech");
        assert_eq!(body["envs"]["SEAT_UNI_URL"], "https://uni.example.test");
        assert!(body["envs"].get("SEAT_CHAT_MODEL").is_none());
        assert!(SCRIPT.starts_with("#!/usr/bin/env bash"));
        assert!(LAUNCH.contains("setsid nohup bash bootstrap.sh"));
    }

    #[test]
    fn launch_refuses_inputs_the_script_would_refuse() {
        let bad = [
            BootstrapParams { git_ref: "main/../x".into(), ..params() },
            BootstrapParams { git_ref: "-x".into(), ..params() },
            BootstrapParams { public_host: "4100-x.instabox.tech;id".into(), ..params() },
            BootstrapParams { public_host: "localhost".into(), ..params() },
            BootstrapParams { uni_url: "ftp://uni.example.test".into(), ..params() },
            BootstrapParams { uni_url: "https://u:p@uni.example.test".into(), ..params() },
            BootstrapParams { uni_url: "https://uni.example.test/?a=1".into(), ..params() },
            BootstrapParams { uni_url: "https://uni.example.test/'x".into(), ..params() },
            BootstrapParams { chat_model: Some("Gemma 4".into()), ..params() },
        ];
        for p in bad {
            assert_eq!(launch_body(&p).unwrap_err().code, "invalid_input", "{p:?}");
        }
    }

    #[test]
    fn launch_outcome_is_read_from_the_last_line() {
        assert_eq!(parse_launch("started\n"), Some("started"));
        assert_eq!(parse_launch("already_running\n"), Some("already_running"));
        assert_eq!(parse_launch("mkdir: cannot create\n"), None);
    }

    #[test]
    fn status_is_parsed_into_ordered_steps_with_timings() {
        let out = "state=running\nrunning=1\n--status--\n1 bootstrap start\n1 inputs start\n1 inputs done seconds=0\n2 checkout start\n5 checkout done seconds=3\n5 build start\n5 models start\n--log--\nline one\nline two\n";
        let s = parse_status(out);
        assert_eq!(s.state, "running");
        assert!(s.running);
        let names: Vec<_> = s.steps.iter().map(|m| (m.name.as_str(), m.state.as_str(), m.seconds)).collect();
        assert_eq!(names, vec![("inputs", "done", Some(0)), ("checkout", "done", Some(3)), ("build", "running", None), ("models", "running", None)]);
        assert_eq!(s.log_tail, "line one\nline two");
    }

    #[test]
    fn a_failed_step_and_a_cut_short_run_both_read_as_failed() {
        let failed = parse_status("state=failed:build\nrunning=0\n--status--\n1 build start\n2 build fail exit=1\n--log--\n");
        assert_eq!(failed.state, "failed:build");
        assert_eq!(failed.steps[0].state, "failed");

        let cut = parse_status("state=running\nrunning=0\n--status--\n1 engine start\n--log--\n");
        assert_eq!(cut.state, "failed:interrupted");
        assert_eq!(cut.steps[0].state, "failed");
    }

    #[test]
    fn a_box_that_never_ran_bootstrap_is_absent() {
        let s = parse_status("state=absent\nrunning=0\n");
        assert_eq!((s.state.as_str(), s.running, s.steps.len()), ("absent", false, 0));
    }
}
