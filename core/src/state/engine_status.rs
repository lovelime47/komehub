#![cfg_attr(not(test), allow(dead_code))]

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineState {
    Initializing,
    Running,
    Paused,
    Error,
    Stopped,
}
