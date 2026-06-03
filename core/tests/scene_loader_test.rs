//! SceneManager の読み込みテスト。
//! 実際のデフォルトscene.jsonをパースできることを検証する。

use std::path::Path;

mod state {
    pub mod scene {
        #![allow(dead_code)]
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/state/scene.rs"));
    }
}

/// デフォルトのscene.json（game.json）をパースできることを確認
#[test]
fn parse_default_game_scene() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("electron/defaults/scenes/game.json");

    assert!(path.exists(), "game.json not found at {:?}", path);

    let content = std::fs::read_to_string(&path).unwrap();
    let scene: state::scene::Scene =
        serde_json::from_str(&content).expect("Failed to parse game.json");

    assert_eq!(scene.name, "ゲーム配信");
    assert!(scene.enabled);
    assert!(!scene.performances.is_empty());

    // 演出構成は scene 設定 (= ユーザーが UI で編集 + デフォルトへ昇格) で変わるため、
    // 特定の演出 id や配列順序には依存しない。フラットなエフェクトパラメータ
    // (count / scale 等) が serde flatten で extra に取り込まれる動作だけを検証する。
    let has_flat_param = scene
        .performances
        .iter()
        .any(|p| p.extra.contains_key("count") || p.extra.contains_key("scale"));
    assert!(
        has_flat_param,
        "some performance should expose flat effect params (count/scale) in extra"
    );
}

/// 全デフォルトシーンをパースできることを確認
#[test]
fn parse_all_default_scenes() {
    let scenes_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("electron/defaults/scenes");

    for name in &["game.json", "singing.json", "chat.json"] {
        let path = scenes_dir.join(name);
        assert!(path.exists(), "{} not found", name);

        let content = std::fs::read_to_string(&path).unwrap();
        let scene: state::scene::Scene =
            serde_json::from_str(&content)
                .unwrap_or_else(|e| panic!("Failed to parse {}: {}", name, e));

        assert!(!scene.name.is_empty(), "{} should have a name", name);
        assert!(!scene.performances.is_empty(), "{} should have performances", name);

        println!("{}: {} performances", name, scene.performances.len());
    }
}

/// 雑談シーンには、初見コメントだけに反応する歓迎演出が入っている。
#[test]
fn chat_scene_has_first_time_welcome_performance() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("electron/defaults/scenes/chat.json");

    let content = std::fs::read_to_string(&path).unwrap();
    let scene: state::scene::Scene =
        serde_json::from_str(&content).expect("Failed to parse chat.json");

    let welcome = scene
        .performances
        .iter()
        .find(|p| p.id == "first-time-welcome")
        .expect("first-time welcome performance should exist");

    assert_eq!(welcome.effect, "com.comment-hub.fixed");
    assert_eq!(welcome.trigger.trigger_type, "keyword");
    assert!(welcome.trigger.keywords.is_empty());
    assert_eq!(welcome.trigger.listener_status, "first-time");
    // 歓迎メッセージ文言は scene 設定で変更可能なため、存在と非空のみ検証する (= 固定文言にしない)。
    let message = welcome
        .extra
        .get("displayMessage")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert!(!message.is_empty(), "welcome should have a non-empty displayMessage");
}
