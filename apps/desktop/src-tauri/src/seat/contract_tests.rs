//! Contract tests against a fake Instabox: a local HTTP server that keeps machines, replays
//! idempotent creates, enforces the 5-machine quota and can be told to run out of capacity.
//! They pin the wire behaviour the provisioning flow relies on.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::client::{InstaboxClient, Power};
use super::{bootstrap_status, start_bootstrap, BootstrapParams};

const KEY: &str = "ibk_contract_test_key_000";

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}

#[derive(Default)]
struct Fake {
    seen: Vec<Seen>,
    machines: Vec<Value>,
    /// Idempotency-Key -> the response first sent for it.
    replays: HashMap<String, (u16, Value)>,
    /// Operation id -> polls left before it succeeds.
    pending: HashMap<String, u32>,
    no_capacity: bool,
    polls_to_finish: u32,
    exec_stdout: String,
}

type Shared = Arc<Mutex<Fake>>;

fn error(code: &str, retryable: bool) -> Value {
    json!({ "error": { "code": code, "message": format!("fake {code}"), "requestId": "req_1", "retryable": retryable, "operationId": null } })
}

fn machine(n: usize, name: &str, metadata: &Value) -> Value {
    json!({ "id": format!("m_{:0>26}", n), "name": name, "state": "running", "runtime": { "ready": true }, "metadata": metadata })
}

fn route(fake: &mut Fake, req: &Seen) -> (u16, Value) {
    if req.headers.get("x-api-key").map(String::as_str) != Some(KEY) {
        return (401, error("unauthenticated", false));
    }
    let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
    match (req.method.as_str(), path) {
        ("GET", "/v1/me") => (200, json!({ "login": "student", "activated": true, "inviteRequired": true })),
        ("GET", "/v1/machines") => {
            let wanted = query.split('&').find_map(|p| p.strip_prefix("metadata=")).map(|v| v.replace("%3A", ":"));
            let list: Vec<Value> = fake
                .machines
                .iter()
                .filter(|m| match &wanted {
                    Some(label) => {
                        let (k, v) = label.split_once(':').unwrap();
                        m["metadata"][k] == v
                    }
                    None => true,
                })
                .cloned()
                .collect();
            (200, json!({ "machines": list, "nextCursor": null }))
        }
        ("POST", "/v1/machines") => {
            let Some(key) = req.headers.get("idempotency-key").cloned() else { return (400, error("bad_request", false)) };
            if let Some(replay) = fake.replays.get(&key) {
                return replay.clone();
            }
            let response = if fake.no_capacity {
                (503, error("no_capacity", true))
            } else if fake.machines.len() >= 5 {
                (429, error("quota_exceeded", false))
            } else {
                let m = machine(fake.machines.len() + 1, req.body["name"].as_str().unwrap_or(""), &req.body["metadata"]);
                let op = format!("op_{:0>26}", fake.machines.len() + 1);
                fake.pending.insert(op.clone(), fake.polls_to_finish);
                let body = json!({ "id": op, "machineId": m["id"], "type": "create", "state": "queued", "error": null });
                fake.machines.push(m);
                (202, body)
            };
            fake.replays.insert(key, response.clone());
            response
        }
        ("GET", p) if p.starts_with("/v1/operations/") => {
            let id = p.trim_start_matches("/v1/operations/").to_string();
            let Some(left) = fake.pending.get_mut(&id) else { return (404, error("not_found", false)) };
            let state = if *left == 0 { "succeeded" } else { "running" };
            *left = left.saturating_sub(1);
            (200, json!({ "id": id, "type": "create", "state": state, "error": null }))
        }
        ("POST", p) if p.ends_with("/start") || p.ends_with("/resume") => {
            if !req.headers.contains_key("idempotency-key") {
                return (400, error("bad_request", false));
            }
            (202, json!({ "id": "op_00000000000000000000000099", "type": "start", "state": "queued", "error": null }))
        }
        ("POST", p) if p.ends_with("/ports") => {
            let id = p.trim_start_matches("/v1/machines/").trim_end_matches("/ports");
            (200, json!({ "id": "pv-1", "machineId": id, "port": 4100, "name": "engine", "url": format!("https://4100-{}.instabox.tech", &id[2..]), "createdAt": "now", "expiresAt": null }))
        }
        ("POST", p) if p.ends_with("/exec") => {
            if fake.machines.iter().all(|m| m["state"] != "running") {
                return (409, error("machine_not_running", false));
            }
            (200, json!({ "stdout": fake.exec_stdout, "stderr": "", "exitCode": 0, "timedOut": false, "truncated": false }))
        }
        _ => (404, error("not_found", false)),
    }
}

async fn serve(shared: Shared) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let shared = shared.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                // Read headers, then exactly content-length bytes of body.
                let (head_end, length) = loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                        let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                        break (pos + 4, len);
                    }
                };
                while buf.len() < head_end + length {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end - 4]).to_string();
                let mut lines = head.lines();
                let mut start = lines.next().unwrap_or_default().split_whitespace();
                let (method, path) = (start.next().unwrap_or_default().to_string(), start.next().unwrap_or_default().to_string());
                let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string())).collect();
                let body = serde_json::from_slice(&buf[head_end..]).unwrap_or(Value::Null);
                let seen = Seen { method, path, headers, body };
                let (status, response) = {
                    let mut fake = shared.lock().unwrap();
                    fake.seen.push(seen.clone());
                    route(&mut fake, &seen)
                };
                let text = response.to_string();
                let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    base
}

async fn fake() -> (Shared, InstaboxClient) {
    let shared: Shared = Arc::new(Mutex::new(Fake { polls_to_finish: 2, ..Fake::default() }));
    let base = serve(shared.clone()).await;
    (shared, InstaboxClient::with_base(base, KEY.into()).unwrap())
}

fn seen(shared: &Shared) -> Vec<Seen> {
    shared.lock().unwrap().seen.clone()
}

#[tokio::test]
async fn create_carries_the_fixed_seat_body_and_an_idempotency_key() {
    let (shared, client) = fake().await;
    let op = client.create_seat("sef-seat-1", "key-1").await.unwrap();
    assert_eq!(op.state, "queued");
    let create = seen(&shared).pop().unwrap();
    assert_eq!(create.headers.get("idempotency-key").map(String::as_str), Some("key-1"));
    assert_eq!(create.body, json!({ "name": "sef-seat-1", "templateId": "universal", "vault": false, "metadata": { "app": "sef-seat" }, "autoSuspendAfterSeconds": 1800 }));
}

#[tokio::test]
async fn a_retried_create_with_the_same_key_replays_instead_of_duplicating() {
    let (shared, client) = fake().await;
    let first = client.create_seat("sef-seat-1", "same-key").await.unwrap();
    let again = client.create_seat("sef-seat-1", "same-key").await.unwrap();
    assert_eq!(first, again);
    assert_eq!(shared.lock().unwrap().machines.len(), 1);
}

#[tokio::test]
async fn the_list_precheck_filters_on_the_seat_label_and_finds_an_existing_seat() {
    let (shared, client) = fake().await;
    shared.lock().unwrap().machines.push(machine(9, "someone-elses-box", &json!({})));
    assert!(client.list_seats().await.unwrap().is_empty(), "an unlabelled machine is not a seat");
    client.create_seat("sef-seat-1", "k").await.unwrap();
    let seats = client.list_seats().await.unwrap();
    assert_eq!(seats.len(), 1);
    assert_eq!(seats[0].name, "sef-seat-1");
    let list = seen(&shared).into_iter().find(|s| s.path.starts_with("/v1/machines?")).unwrap();
    assert!(list.path.contains("metadata=app%3Asef-seat"), "{}", list.path);
}

#[tokio::test]
async fn operations_are_long_polled_until_terminal() {
    let (shared, client) = fake().await;
    let op = client.create_seat("sef-seat-1", "k").await.unwrap();
    let mut states = Vec::new();
    loop {
        let polled = client.operation(&op.id).await.unwrap();
        states.push(polled.state.clone());
        if polled.state == "succeeded" || polled.state == "failed" {
            break;
        }
    }
    assert_eq!(states, ["running", "running", "succeeded"]);
    assert!(seen(&shared).iter().filter(|s| s.path.starts_with("/v1/operations/")).all(|s| s.path.ends_with("?wait=25s")));
}

#[tokio::test]
async fn quota_and_capacity_errors_keep_their_codes() {
    let (shared, client) = fake().await;
    for n in 0..5 {
        shared.lock().unwrap().machines.push(machine(20 + n, &format!("other-{n}"), &json!({})));
    }
    let quota = client.create_seat("sef-seat-1", "k1").await.unwrap_err();
    assert_eq!((quota.code.as_str(), quota.status, quota.retryable), ("quota_exceeded", 429, false));

    shared.lock().unwrap().machines.clear();
    shared.lock().unwrap().no_capacity = true;
    let full = client.create_seat("sef-seat-1", "k2").await.unwrap_err();
    assert_eq!((full.code.as_str(), full.status, full.retryable), ("no_capacity", 503, true));
}

#[tokio::test]
async fn only_lifecycle_calls_carry_an_idempotency_key() {
    let (shared, client) = fake().await;
    client.create_seat("sef-seat-1", "create-key").await.unwrap();
    let id = shared.lock().unwrap().machines[0]["id"].as_str().unwrap().to_string();
    client.power(&id, Power::Start, "start-key").await.unwrap();
    client.machine(&id).await.ok();
    client.list_seats().await.unwrap();
    client.publish_engine_port(&id).await.unwrap();
    shared.lock().unwrap().exec_stdout = "state=done\nrunning=0\n".into();
    bootstrap_status(&client, &id).await.unwrap();
    client.account().await.unwrap();
    for s in seen(&shared) {
        let lifecycle = s.method == "POST" && (s.path == "/v1/machines" || s.path.ends_with("/start"));
        assert_eq!(s.headers.contains_key("idempotency-key"), lifecycle, "{} {}", s.method, s.path);
        assert_eq!(s.headers.get("x-api-key").map(String::as_str), Some(KEY));
    }
}

#[tokio::test]
async fn publishing_returns_the_seat_url_and_bootstrap_launches_over_exec() {
    let (shared, client) = fake().await;
    client.create_seat("sef-seat-1", "k").await.unwrap();
    let id = shared.lock().unwrap().machines[0]["id"].as_str().unwrap().to_string();
    let port = client.publish_engine_port(&id).await.unwrap();
    assert_eq!(port.url, format!("https://4100-{}.instabox.tech", &id[2..]));

    shared.lock().unwrap().exec_stdout = "started\n".into();
    let params = BootstrapParams {
        git_ref: "main".into(),
        public_host: port.url.trim_start_matches("https://").into(),
        uni_url: "https://uni.example.test".into(),
        chat_model: None,
        embed_model: None,
    };
    assert_eq!(start_bootstrap(&client, &id, &params).await.unwrap(), "started");
    let exec = seen(&shared).pop().unwrap();
    assert_eq!(exec.body["stdin"], super::bootstrap::SCRIPT);
    assert_eq!(exec.body["envs"]["SEAT_UNI_URL"], "https://uni.example.test");
}

#[tokio::test]
async fn exec_on_a_stopped_box_surfaces_machine_not_running() {
    let (shared, client) = fake().await;
    client.create_seat("sef-seat-1", "k").await.unwrap();
    let id = {
        let mut fake = shared.lock().unwrap();
        fake.machines[0]["state"] = json!("stopped");
        fake.machines[0]["id"].as_str().unwrap().to_string()
    };
    let error = bootstrap_status(&client, &id).await.unwrap_err();
    assert_eq!((error.code.as_str(), error.status), ("machine_not_running", 409));
}

#[tokio::test]
async fn a_wrong_key_is_unauthenticated_and_never_echoed() {
    let shared: Shared = Arc::new(Mutex::new(Fake::default()));
    let base = serve(shared.clone()).await;
    let client = InstaboxClient::with_base(base, "ibk_wrong_key_123456".into()).unwrap();
    let error = client.account().await.unwrap_err();
    assert_eq!(error.code, "unauthenticated");
    assert!(!error.message.contains("ibk_"));
}
