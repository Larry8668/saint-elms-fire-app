//! Headless harness for the seat commands: calls the very functions the webview invokes
//! (`seat::commands`), key from the OS keychain included, and prints the JSON a webview
//! `invoke` would receive. Used to drive the provisioning flow on a real box without a UI.
//!
//!   cargo run --example seat_cli -- <command> [args...]
//!   printf '%s' "$KEY" | cargo run --example seat_cli -- key-save   (key on stdin, never argv)

use std::io::Read;

use saint_elms_fire_lib::seat::commands::*;
use saint_elms_fire_lib::seat::{BootstrapParams, SeatError};
use serde::Serialize;

fn print<T: Serialize>(result: Result<T, SeatError>) -> i32 {
    match result {
        Ok(value) => {
            println!("{}", serde_json::json!({ "ok": value }));
            0
        }
        Err(error) => {
            println!("{}", serde_json::json!({ "error": error }));
            1
        }
    }
}

fn arg(args: &[String], i: usize) -> String {
    args.get(i).cloned().unwrap_or_default()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match arg(&args, 0).as_str() {
        "key-save" => {
            let mut key = String::new();
            std::io::stdin().read_to_string(&mut key).expect("stdin");
            print(seat_key_save(key))
        }
        "key-present" => print(seat_key_present()),
        "key-forget" => print(seat_key_forget()),
        "account" => print(seat_account().await),
        "list" => print(seat_list().await),
        "create" => print(seat_create(arg(&args, 1), arg(&args, 2)).await),
        "operation" => print(seat_operation(arg(&args, 1)).await),
        "machine" => print(seat_machine(arg(&args, 1)).await),
        "power" => print(seat_power(arg(&args, 1), arg(&args, 2), arg(&args, 3)).await),
        "publish" => print(seat_publish(arg(&args, 1)).await),
        "bootstrap-start" => match serde_json::from_str::<BootstrapParams>(&arg(&args, 2)) {
            Ok(params) => print(seat_bootstrap_start(arg(&args, 1), params).await),
            Err(e) => print::<()>(Err(SeatError::invalid(e.to_string()))),
        },
        "bootstrap-status" => print(seat_bootstrap_status(arg(&args, 1)).await),
        "health" => print(seat_health(arg(&args, 1)).await),
        other => {
            eprintln!("unknown command {other:?}");
            2
        }
    };
    std::process::exit(code);
}
