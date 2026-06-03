use reqwest::Client;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static EXE_TEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn exe_test_lock() -> &'static tokio::sync::Mutex<()> {
    EXE_TEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

struct CoreProcess {
    child: Child,
    data_dir: PathBuf,
    port: u16,
    logs: Arc<Mutex<Vec<String>>>,
}

impl CoreProcess {
    fn spawn(test_name: &str) -> Self {
        let exe_path = std::env::var("CARGO_BIN_EXE_komehub-core-exe")
            .expect("CARGO_BIN_EXE_komehub-core-exe is not set");
        let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core workspace root");
        let data_dir = make_temp_dir(test_name);

        // 既定 11280 は本体稼働中や複数テストと衝突する。OS に空きポートを選ばせる。
        let mut child = Command::new(exe_path)
            .arg(&data_dir)
            .current_dir(project_root)
            .env("KOMEHUB_PUBLIC_HTTP_PORT", "0")
            .env("RUST_LOG", "info")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn komehub-core binary");

        let stdout = child.stdout.take().expect("stdout should be piped");
        let stderr = child.stderr.take().expect("stderr should be piped");
        let logs = Arc::new(Mutex::new(Vec::new()));
        let (line_tx, line_rx) = mpsc::channel();

        spawn_log_reader(stdout, logs.clone(), line_tx.clone());
        spawn_log_reader(stderr, logs.clone(), line_tx);

        let port = wait_for_port(&mut child, &line_rx, &logs);

        Self {
            child,
            data_dir,
            port,
            logs,
        }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn logs_snapshot(&self) -> String {
        self.logs
            .lock()
            .expect("logs mutex poisoned")
            .join("\n")
    }
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.data_dir);
    }
}

fn make_temp_dir(test_name: &str) -> PathBuf {
    let unique = format!(
        "komehub-core-exe-test-{}-{}-{}",
        test_name,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_millis()
    );
    let dir = std::env::temp_dir().join(unique);
    fs::create_dir_all(&dir).expect("failed to create temp data dir");
    dir
}

fn spawn_log_reader<R: Read + Send + 'static>(
    reader: R,
    logs: Arc<Mutex<Vec<String>>>,
    line_tx: mpsc::Sender<String>,
) {
    thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match buf.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let message = line.trim_end().to_string();
                    logs.lock().expect("logs mutex poisoned").push(message.clone());
                    let _ = line_tx.send(message);
                }
                Err(_) => break,
            }
        }
    });
}

fn wait_for_port(
    child: &mut Child,
    line_rx: &mpsc::Receiver<String>,
    logs: &Arc<Mutex<Vec<String>>>,
) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(20);

    loop {
        if let Some(status) = child.try_wait().expect("failed to poll child process") {
            panic!(
                "komehub-core exited before port was detected: {}\n{}",
                status,
                logs.lock().expect("logs mutex poisoned").join("\n")
            );
        }

        if Instant::now() >= deadline {
            panic!(
                "timed out waiting for komehub-core port\n{}",
                logs.lock().expect("logs mutex poisoned").join("\n")
            );
        }

        match line_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if let Some(port) = parse_port_from_line(&line) {
                    return port;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!(
                    "log reader disconnected before port was detected\n{}",
                    logs.lock().expect("logs mutex poisoned").join("\n")
                );
            }
        }
    }
}

fn parse_port_from_line(line: &str) -> Option<u16> {
    let marker = "komehub-core listening on port ";
    let port_text = line.split(marker).nth(1)?;
    port_text.trim().parse().ok()
}

async fn wait_for_health(base_url: &str) -> Value {
    let client = Client::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    let url = format!("{}/api/health", base_url);

    loop {
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                return response.json().await.expect("health response should be JSON");
            }
            _ if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(100)).await,
            Err(err) => panic!("health endpoint did not become ready: {}", err),
            Ok(response) => panic!("unexpected health status: {}", response.status()),
        }
    }
}

fn spawn_sse_reader(port: u16) -> (mpsc::Receiver<String>, mpsc::Receiver<()>) {
    let (data_tx, data_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();

    thread::spawn(move || {
        let mut stream =
            TcpStream::connect(("127.0.0.1", port)).expect("failed to connect to SSE endpoint");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("failed to set SSE read timeout");

        let request = format!(
            "GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n",
            port
        );
        stream
            .write_all(request.as_bytes())
            .expect("failed to write SSE request");

        let mut reader = BufReader::new(stream);
        let mut line = String::new();

        loop {
            line.clear();
            let bytes = reader
                .read_line(&mut line)
                .expect("failed to read SSE response headers");
            if bytes == 0 {
                panic!("SSE stream closed before headers completed");
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
        }

        ready_tx.send(()).expect("failed to signal SSE readiness");

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Some(data) = line.strip_prefix("data: ") {
                        let payload = data.trim().to_string();
                        data_tx.send(payload).expect("failed to forward SSE payload");
                    }
                }
                Err(err) => panic!("failed to read SSE payload: {}", err),
            }
        }
    });

    (data_rx, ready_rx)
}

fn wait_for_matching_sse_payload<F>(data_rx: &mpsc::Receiver<String>, predicate: F) -> Value
where
    F: Fn(&Value) -> bool,
{
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut last_event = None;

    loop {
        let now = Instant::now();
        if now >= deadline {
            panic!(
                "did not receive expected SSE payload before timeout; last event: {:?}",
                last_event
            );
        }

        let payload = data_rx
            .recv_timeout(deadline.saturating_duration_since(now))
            .expect("did not receive SSE payload before timeout");
        let event: Value = serde_json::from_str(&payload).expect("SSE payload should be valid JSON");

        if predicate(&event) {
            return event;
        }

        last_event = Some(event);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exe_serves_health_and_paused_api() {
    let _guard = exe_test_lock().lock().await;
    let core = CoreProcess::spawn("health-paused");
    let health = wait_for_health(&core.base_url()).await;

    assert_eq!(health["status"], "ok");
    assert_eq!(health["version"], env!("CARGO_PKG_VERSION"));

    let client = Client::new();
    let paused_url = format!("{}/api/paused", core.base_url());

    let initial_paused = client
        .get(&paused_url)
        .send()
        .await
        .expect("paused GET should succeed")
        .json::<bool>()
        .await
        .expect("paused GET should return bool");
    assert!(!initial_paused, "initial paused state should be false");

    let post_result = client
        .post(&paused_url)
        .json(&serde_json::json!({ "paused": true }))
        .send()
        .await
        .expect("paused POST should succeed")
        .json::<bool>()
        .await
        .expect("paused POST should return bool");
    assert!(post_result, "paused POST should acknowledge success");

    let paused = client
        .get(&paused_url)
        .send()
        .await
        .expect("paused GET after update should succeed")
        .json::<bool>()
        .await
        .expect("paused GET after update should return bool");
    assert!(paused, "paused state should become true");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exe_emits_connection_update_over_sse() {
    let _guard = exe_test_lock().lock().await;
    let core = CoreProcess::spawn("connection-sse");
    wait_for_health(&core.base_url()).await;

    let (data_rx, ready_rx) = spawn_sse_reader(core.port);
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("SSE reader did not become ready");

    let client = Client::new();
    let response = client
        .post(format!("{}/api/connection", core.base_url()))
        .json(&serde_json::json!({
            "connected": true,
            "videoId": "video-exe-test"
        }))
        .send()
        .await
        .expect("connection update POST should succeed");
    assert!(response.status().is_success());

    let event = wait_for_matching_sse_payload(&data_rx, |event| {
        event["type"] == "status"
            && event["data"]["connected"] == true
            && event["data"]["videoId"] == "video-exe-test"
    });

    assert_eq!(event["type"], "status");
    assert_eq!(event["data"]["connected"], true);
    assert_eq!(event["data"]["videoId"], "video-exe-test");

    let logs = core.logs_snapshot();
    assert!(
        !logs.contains("[ERROR]"),
        "core logs should not contain errors during exe smoke:\n{}",
        logs
    );
}
