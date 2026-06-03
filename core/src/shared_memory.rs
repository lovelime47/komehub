#![cfg_attr(not(test), allow(dead_code))]

use napi::bindgen_prelude::Buffer;
use serde::Serialize;
use std::sync::{Condvar, Mutex, OnceLock};

use crate::state::comment::{CommentTimeline, CommentTimelineEntry, ReactionCounts};
use crate::state::connection::ConnectionState;
use crate::state::engine_status::EngineState;
use crate::state::performance_log::{PerformanceLog, PerformanceLogEntry};

pub const REACTION_COUNT_KEYS: [&str; 5] = ["heart", "smile", "celebration", "surprise", "hundred"];

const SHARED_MEMORY_MAGIC: u32 = 0x4B53484D; // "KSHM"
const SHARED_MEMORY_ABI_VERSION: u32 = 1;
const HEADER_BYTES: usize = 64;
const WRITER_STATE_IDLE: u32 = 0;
const WRITER_STATE_WRITING: u32 = 1;

const REACTION_COUNTS_NAME: &str = "reactionCounts";
const REACTION_COUNTS_LAYOUT_ID: u32 = 1;
const REACTION_SLOT_STRIDE_BYTES: usize = 8;
const REACTION_SLOT_COUNT: usize = REACTION_COUNT_KEYS.len();
const REACTION_BUFFER_STRIDE_BYTES: usize = REACTION_SLOT_COUNT * REACTION_SLOT_STRIDE_BYTES;
const REACTION_BUFFER0_OFFSET: usize = HEADER_BYTES;
const REACTION_BUFFER1_OFFSET: usize = REACTION_BUFFER0_OFFSET + REACTION_BUFFER_STRIDE_BYTES;
const REACTION_TOTAL_BYTES: usize = HEADER_BYTES + (REACTION_BUFFER_STRIDE_BYTES * 2);
const REACTION_OFFSET_ACTIVE_BUFFER_INDEX: usize = 32;
const REACTION_OFFSET_REVISION: usize = 36;
const REACTION_OFFSET_WRITER_STATE: usize = 40;
const REACTION_OFFSET_BUFFER0: usize = 48;
const REACTION_OFFSET_BUFFER1: usize = 52;

const DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX: usize = 20;
const DOUBLE_BUFFER_OFFSET_REVISION: usize = 24;
const DOUBLE_BUFFER_OFFSET_WRITER_STATE: usize = 28;
const DOUBLE_BUFFER_OFFSET_BUFFER_STRIDE_BYTES: usize = 32;
const DOUBLE_BUFFER_OFFSET_BUFFER0: usize = 36;
const DOUBLE_BUFFER_OFFSET_BUFFER1: usize = 40;

const PERFORMANCE_LOG_NAME: &str = "performanceLog";
const PERFORMANCE_LOG_LAYOUT_ID: u32 = 2;
const PERFORMANCE_LOG_CAPACITY: usize = 64;
const PERFORMANCE_LOG_ARENA_BYTES: usize = 1024 * 1024;
const PERFORMANCE_LOG_BANK_HEADER_BYTES: usize = 24;
const PERFORMANCE_LOG_SCENE_ID_BYTES: usize = 64;
const PERFORMANCE_LOG_PERFORMANCE_ID_BYTES: usize = 64;
const PERFORMANCE_LOG_EFFECT_ID_BYTES: usize = 64;
const PERFORMANCE_LOG_EFFECT_TYPE_BYTES: usize = 32;
const PERFORMANCE_LOG_RECORD_CURSOR_OFFSET: usize = 0;
const PERFORMANCE_LOG_RECORD_FLAGS_OFFSET: usize = 4;
const PERFORMANCE_LOG_RECORD_SCENE_ID_OFFSET: usize = 8;
const PERFORMANCE_LOG_RECORD_PERFORMANCE_ID_OFFSET: usize =
    PERFORMANCE_LOG_RECORD_SCENE_ID_OFFSET + PERFORMANCE_LOG_SCENE_ID_BYTES;
const PERFORMANCE_LOG_RECORD_EFFECT_ID_OFFSET: usize =
    PERFORMANCE_LOG_RECORD_PERFORMANCE_ID_OFFSET + PERFORMANCE_LOG_PERFORMANCE_ID_BYTES;
const PERFORMANCE_LOG_RECORD_EFFECT_TYPE_OFFSET: usize =
    PERFORMANCE_LOG_RECORD_EFFECT_ID_OFFSET + PERFORMANCE_LOG_EFFECT_ID_BYTES;
const PERFORMANCE_LOG_RECORD_PAYLOAD_OFFSET: usize =
    PERFORMANCE_LOG_RECORD_EFFECT_TYPE_OFFSET + PERFORMANCE_LOG_EFFECT_TYPE_BYTES;
const PERFORMANCE_LOG_RECORD_STRIDE_BYTES: usize =
    PERFORMANCE_LOG_RECORD_PAYLOAD_OFFSET + 8;
const PERFORMANCE_LOG_OFFSET_HEAD: usize = 0;
const PERFORMANCE_LOG_OFFSET_TAIL: usize = 4;
const PERFORMANCE_LOG_OFFSET_ENTRY_COUNT: usize = 8;
const PERFORMANCE_LOG_OFFSET_NEXT_CURSOR: usize = 12;
const PERFORMANCE_LOG_OFFSET_DROPPED_COUNT: usize = 16;
const PERFORMANCE_LOG_OFFSET_ARENA_USED_BYTES: usize = 20;
const PERFORMANCE_LOG_RECORDS_OFFSET: usize = PERFORMANCE_LOG_BANK_HEADER_BYTES;
const PERFORMANCE_LOG_ARENA_OFFSET: usize =
    PERFORMANCE_LOG_RECORDS_OFFSET + (PERFORMANCE_LOG_RECORD_STRIDE_BYTES * PERFORMANCE_LOG_CAPACITY);
const PERFORMANCE_LOG_BUFFER_STRIDE_BYTES: usize = PERFORMANCE_LOG_ARENA_OFFSET + PERFORMANCE_LOG_ARENA_BYTES;
const PERFORMANCE_LOG_BUFFER0_OFFSET: usize = HEADER_BYTES;
const PERFORMANCE_LOG_BUFFER1_OFFSET: usize = PERFORMANCE_LOG_BUFFER0_OFFSET + PERFORMANCE_LOG_BUFFER_STRIDE_BYTES;
const PERFORMANCE_LOG_TOTAL_BYTES: usize = HEADER_BYTES + (PERFORMANCE_LOG_BUFFER_STRIDE_BYTES * 2);
const PERFORMANCE_LOG_FLAG_HAS_CONTEXT: u32 = 1;

const COMMENT_TIMELINE_NAME: &str = "commentTimeline";
const COMMENT_TIMELINE_LAYOUT_ID: u32 = 3;
const COMMENT_TIMELINE_CAPACITY: usize = 1000;
const COMMENT_TIMELINE_ARENA_BYTES: usize = 1024 * 1024;
const COMMENT_TIMELINE_BANK_HEADER_BYTES: usize = 24;
const COMMENT_TIMELINE_RECORD_CURSOR_OFFSET: usize = 0;
const COMMENT_TIMELINE_RECORD_FLAGS_OFFSET: usize = 4;
const COMMENT_TIMELINE_RECORD_MEMBER_MONTHS_OFFSET: usize = 8;
const COMMENT_TIMELINE_RECORD_GIFT_COUNT_OFFSET: usize = 12;
const COMMENT_TIMELINE_RECORD_AMOUNT_OFFSET: usize = 16;
const COMMENT_TIMELINE_RECORD_ID_OFFSET: usize = 24;
const COMMENT_TIMELINE_RECORD_NAME_OFFSET: usize = 32;
const COMMENT_TIMELINE_RECORD_COMMENT_OFFSET: usize = 40;
const COMMENT_TIMELINE_RECORD_COMMENT_HTML_OFFSET: usize = 48;
const COMMENT_TIMELINE_RECORD_PROFILE_IMAGE_OFFSET: usize = 56;
const COMMENT_TIMELINE_RECORD_TIMESTAMP_OFFSET: usize = 64;
const COMMENT_TIMELINE_RECORD_CURRENCY_OFFSET: usize = 72;
const COMMENT_TIMELINE_RECORD_STICKER_IMAGE_OFFSET: usize = 80;
const COMMENT_TIMELINE_RECORD_MEMBERSHIP_HEADER_OFFSET: usize = 88;
const COMMENT_TIMELINE_RECORD_STRIDE_BYTES: usize = 96;
const COMMENT_TIMELINE_OFFSET_HEAD: usize = 0;
const COMMENT_TIMELINE_OFFSET_TAIL: usize = 4;
const COMMENT_TIMELINE_OFFSET_ENTRY_COUNT: usize = 8;
const COMMENT_TIMELINE_OFFSET_NEXT_CURSOR: usize = 12;
const COMMENT_TIMELINE_OFFSET_DROPPED_COUNT: usize = 16;
const COMMENT_TIMELINE_OFFSET_ARENA_USED_BYTES: usize = 20;
const COMMENT_TIMELINE_RECORDS_OFFSET: usize = COMMENT_TIMELINE_BANK_HEADER_BYTES;
const COMMENT_TIMELINE_ARENA_OFFSET: usize =
    COMMENT_TIMELINE_RECORDS_OFFSET + (COMMENT_TIMELINE_RECORD_STRIDE_BYTES * COMMENT_TIMELINE_CAPACITY);
const COMMENT_TIMELINE_BUFFER_STRIDE_BYTES: usize =
    COMMENT_TIMELINE_ARENA_OFFSET + COMMENT_TIMELINE_ARENA_BYTES;
const COMMENT_TIMELINE_BUFFER0_OFFSET: usize = HEADER_BYTES;
const COMMENT_TIMELINE_BUFFER1_OFFSET: usize = COMMENT_TIMELINE_BUFFER0_OFFSET + COMMENT_TIMELINE_BUFFER_STRIDE_BYTES;
const COMMENT_TIMELINE_TOTAL_BYTES: usize = HEADER_BYTES + (COMMENT_TIMELINE_BUFFER_STRIDE_BYTES * 2);
const COMMENT_TIMELINE_FLAG_HAS_GIFT: u32 = 1 << 0;
const COMMENT_TIMELINE_FLAG_IS_MEMBER: u32 = 1 << 1;
const COMMENT_TIMELINE_FLAG_IS_MEMBERSHIP: u32 = 1 << 2;
const COMMENT_TIMELINE_FLAG_IS_MEMBERSHIP_GIFT: u32 = 1 << 3;

// === ConnectionState shared-memory layout ===
// 設計原則: ConnectionState struct の **全フィールド** をこの layout に同期する。
// struct と layout の不一致は、SSE message data に inject した派生値が napi 経路で
// 剥がれるバグを生む (= remote-viewing redesign 中 isOwnStream が剥がれた事例、
// 2026-05-09 修正)。新規フィールド追加時は本ファイル + state/connection.rs を
// 同時に更新すること。詳細は docs/architecture/shared-memory.md。
const CONNECTION_STATE_NAME: &str = "connection";
const CONNECTION_STATE_LAYOUT_ID: u32 = 5;
const CONNECTION_VIDEO_ID_BYTES: usize = 256;
const CONNECTION_OWNER_CHANNEL_ID_BYTES: usize = 256;
const CONNECTION_OFFSET_CONNECTED: usize = 0;
const CONNECTION_OFFSET_IS_OWN_STREAM: usize = 4;
const CONNECTION_VIDEO_ID_OFFSET: usize = 8;
const CONNECTION_OWNER_CHANNEL_ID_OFFSET: usize =
    CONNECTION_VIDEO_ID_OFFSET + CONNECTION_VIDEO_ID_BYTES;
const CONNECTION_BUFFER_STRIDE_BYTES: usize =
    CONNECTION_OWNER_CHANNEL_ID_OFFSET + CONNECTION_OWNER_CHANNEL_ID_BYTES;
const CONNECTION_BUFFER0_OFFSET: usize = HEADER_BYTES;
const CONNECTION_BUFFER1_OFFSET: usize = CONNECTION_BUFFER0_OFFSET + CONNECTION_BUFFER_STRIDE_BYTES;
const CONNECTION_TOTAL_BYTES: usize = HEADER_BYTES + (CONNECTION_BUFFER_STRIDE_BYTES * 2);

const PERFORMANCE_ENGINE_STATE_NAME: &str = "performanceEngineState";
const PERFORMANCE_ENGINE_STATE_LAYOUT_ID: u32 = 5;
const PERFORMANCE_ENGINE_STATE_OFFSET_STATE: usize = 0;
const PERFORMANCE_ENGINE_STATE_BUFFER_STRIDE_BYTES: usize = 4;
const PERFORMANCE_ENGINE_STATE_BUFFER0_OFFSET: usize = HEADER_BYTES;
const PERFORMANCE_ENGINE_STATE_BUFFER1_OFFSET: usize =
    PERFORMANCE_ENGINE_STATE_BUFFER0_OFFSET + PERFORMANCE_ENGINE_STATE_BUFFER_STRIDE_BYTES;
const PERFORMANCE_ENGINE_STATE_TOTAL_BYTES: usize =
    HEADER_BYTES + (PERFORMANCE_ENGINE_STATE_BUFFER_STRIDE_BYTES * 2);

const HEADER_OFFSET_MAGIC: usize = 0;
const HEADER_OFFSET_ABI_VERSION: usize = 4;
const HEADER_OFFSET_LAYOUT_ID: usize = 8;
const HEADER_OFFSET_TOTAL_BYTES: usize = 12;
const HEADER_OFFSET_HEADER_BYTES: usize = 16;

struct SharedAccessGate {
    state: Mutex<bool>,
    cvar: Condvar,
}

impl SharedAccessGate {
    fn new() -> Self {
        Self {
            state: Mutex::new(false),
            cvar: Condvar::new(),
        }
    }

    fn acquire(&self) -> Result<(), String> {
        let mut locked = self
            .state
            .lock()
            .map_err(|_| "shared access gate lock poisoned".to_string())?;
        while *locked {
            locked = self
                .cvar
                .wait(locked)
                .map_err(|_| "shared access gate wait poisoned".to_string())?;
        }
        *locked = true;
        Ok(())
    }

    fn release(&self) -> Result<(), String> {
        let mut locked = self
            .state
            .lock()
            .map_err(|_| "shared access gate lock poisoned".to_string())?;
        if !*locked {
            return Err("shared access gate is not locked".to_string());
        }
        *locked = false;
        self.cvar.notify_one();
        Ok(())
    }
}

struct SharedAccessRegistry {
    reaction_counts: SharedAccessGate,
    performance_log: SharedAccessGate,
    comment_timeline: SharedAccessGate,
    connection: SharedAccessGate,
    performance_engine_state: SharedAccessGate,
}

impl SharedAccessRegistry {
    fn new() -> Self {
        Self {
            reaction_counts: SharedAccessGate::new(),
            performance_log: SharedAccessGate::new(),
            comment_timeline: SharedAccessGate::new(),
            connection: SharedAccessGate::new(),
            performance_engine_state: SharedAccessGate::new(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedBufferLayout {
    pub name: String,
    pub kind: String,
    pub magic: u32,
    pub abi_version: u32,
    pub layout_id: u32,
    pub total_bytes: u32,
    pub header_bytes: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_stride_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer_stride_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_buffer_index_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_offset: Option<u32>,
    pub writer_state_offset: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer_offsets: Option<[u32; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reaction_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_stride_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub records_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tail_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_count_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_count_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_id_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_id_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub performance_id_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub performance_id_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_id_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_id_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_type_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_type_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arena_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arena_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arena_used_bytes_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_html_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_image_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker_image_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub membership_header_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_months_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gift_count_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_id_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_id_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_offset: Option<u32>,
}

impl SharedBufferLayout {
    fn reaction_counts() -> Self {
        Self {
            name: REACTION_COUNTS_NAME.to_string(),
            kind: "doubleBufferU64".to_string(),
            magic: SHARED_MEMORY_MAGIC,
            abi_version: SHARED_MEMORY_ABI_VERSION,
            layout_id: REACTION_COUNTS_LAYOUT_ID,
            total_bytes: REACTION_TOTAL_BYTES as u32,
            header_bytes: HEADER_BYTES as u32,
            slot_count: Some(REACTION_SLOT_COUNT as u32),
            slot_stride_bytes: Some(REACTION_SLOT_STRIDE_BYTES as u32),
            buffer_stride_bytes: Some(REACTION_BUFFER_STRIDE_BYTES as u32),
            active_buffer_index_offset: Some(REACTION_OFFSET_ACTIVE_BUFFER_INDEX as u32),
            revision_offset: Some(REACTION_OFFSET_REVISION as u32),
            writer_state_offset: REACTION_OFFSET_WRITER_STATE as u32,
            buffer_offsets: Some([REACTION_BUFFER0_OFFSET as u32, REACTION_BUFFER1_OFFSET as u32]),
            reaction_keys: Some(REACTION_COUNT_KEYS.iter().map(|key| key.to_string()).collect()),
            capacity: None,
            record_stride_bytes: None,
            records_offset: None,
            head_offset: None,
            tail_offset: None,
            entry_count_offset: None,
            next_cursor_offset: None,
            dropped_count_offset: None,
            cursor_offset: None,
            flags_offset: None,
            scene_id_offset: None,
            scene_id_bytes: None,
            performance_id_offset: None,
            performance_id_bytes: None,
            effect_id_offset: None,
            effect_id_bytes: None,
            effect_type_offset: None,
            effect_type_bytes: None,
            arena_offset: None,
            arena_bytes: None,
            arena_used_bytes_offset: None,
            id_offset: None,
            name_offset: None,
            comment_offset: None,
            comment_html_offset: None,
            profile_image_offset: None,
            timestamp_offset: None,
            currency_offset: None,
            sticker_image_offset: None,
            membership_header_offset: None,
            member_months_offset: None,
            gift_count_offset: None,
            amount_offset: None,
            connected_offset: None,
            video_id_offset: None,
            video_id_bytes: None,
            state_offset: None,
            payload_offset: None,
        }
    }

    fn performance_log() -> Self {
        Self {
            name: PERFORMANCE_LOG_NAME.to_string(),
            kind: "doubleBufferRingArenaRecords".to_string(),
            magic: SHARED_MEMORY_MAGIC,
            abi_version: SHARED_MEMORY_ABI_VERSION,
            layout_id: PERFORMANCE_LOG_LAYOUT_ID,
            total_bytes: PERFORMANCE_LOG_TOTAL_BYTES as u32,
            header_bytes: HEADER_BYTES as u32,
            slot_count: None,
            slot_stride_bytes: None,
            buffer_stride_bytes: Some(PERFORMANCE_LOG_BUFFER_STRIDE_BYTES as u32),
            active_buffer_index_offset: Some(DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX as u32),
            revision_offset: Some(DOUBLE_BUFFER_OFFSET_REVISION as u32),
            writer_state_offset: DOUBLE_BUFFER_OFFSET_WRITER_STATE as u32,
            buffer_offsets: Some([
                PERFORMANCE_LOG_BUFFER0_OFFSET as u32,
                PERFORMANCE_LOG_BUFFER1_OFFSET as u32,
            ]),
            reaction_keys: None,
            capacity: Some(PERFORMANCE_LOG_CAPACITY as u32),
            record_stride_bytes: Some(PERFORMANCE_LOG_RECORD_STRIDE_BYTES as u32),
            records_offset: Some(PERFORMANCE_LOG_RECORDS_OFFSET as u32),
            head_offset: Some(PERFORMANCE_LOG_OFFSET_HEAD as u32),
            tail_offset: Some(PERFORMANCE_LOG_OFFSET_TAIL as u32),
            entry_count_offset: Some(PERFORMANCE_LOG_OFFSET_ENTRY_COUNT as u32),
            next_cursor_offset: Some(PERFORMANCE_LOG_OFFSET_NEXT_CURSOR as u32),
            dropped_count_offset: Some(PERFORMANCE_LOG_OFFSET_DROPPED_COUNT as u32),
            cursor_offset: Some(PERFORMANCE_LOG_RECORD_CURSOR_OFFSET as u32),
            flags_offset: Some(PERFORMANCE_LOG_RECORD_FLAGS_OFFSET as u32),
            scene_id_offset: Some(PERFORMANCE_LOG_RECORD_SCENE_ID_OFFSET as u32),
            scene_id_bytes: Some(PERFORMANCE_LOG_SCENE_ID_BYTES as u32),
            performance_id_offset: Some(PERFORMANCE_LOG_RECORD_PERFORMANCE_ID_OFFSET as u32),
            performance_id_bytes: Some(PERFORMANCE_LOG_PERFORMANCE_ID_BYTES as u32),
            effect_id_offset: Some(PERFORMANCE_LOG_RECORD_EFFECT_ID_OFFSET as u32),
            effect_id_bytes: Some(PERFORMANCE_LOG_EFFECT_ID_BYTES as u32),
            effect_type_offset: Some(PERFORMANCE_LOG_RECORD_EFFECT_TYPE_OFFSET as u32),
            effect_type_bytes: Some(PERFORMANCE_LOG_EFFECT_TYPE_BYTES as u32),
            arena_offset: Some(PERFORMANCE_LOG_ARENA_OFFSET as u32),
            arena_bytes: Some(PERFORMANCE_LOG_ARENA_BYTES as u32),
            arena_used_bytes_offset: Some(PERFORMANCE_LOG_OFFSET_ARENA_USED_BYTES as u32),
            id_offset: None,
            name_offset: None,
            comment_offset: None,
            comment_html_offset: None,
            profile_image_offset: None,
            timestamp_offset: None,
            currency_offset: None,
            sticker_image_offset: None,
            membership_header_offset: None,
            member_months_offset: None,
            gift_count_offset: None,
            amount_offset: None,
            connected_offset: None,
            video_id_offset: None,
            video_id_bytes: None,
            state_offset: None,
            payload_offset: Some(PERFORMANCE_LOG_RECORD_PAYLOAD_OFFSET as u32),
        }
    }

    fn comment_timeline() -> Self {
        Self {
            name: COMMENT_TIMELINE_NAME.to_string(),
            kind: "doubleBufferRingArenaRecords".to_string(),
            magic: SHARED_MEMORY_MAGIC,
            abi_version: SHARED_MEMORY_ABI_VERSION,
            layout_id: COMMENT_TIMELINE_LAYOUT_ID,
            total_bytes: COMMENT_TIMELINE_TOTAL_BYTES as u32,
            header_bytes: HEADER_BYTES as u32,
            slot_count: None,
            slot_stride_bytes: None,
            buffer_stride_bytes: Some(COMMENT_TIMELINE_BUFFER_STRIDE_BYTES as u32),
            active_buffer_index_offset: Some(DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX as u32),
            revision_offset: Some(DOUBLE_BUFFER_OFFSET_REVISION as u32),
            writer_state_offset: DOUBLE_BUFFER_OFFSET_WRITER_STATE as u32,
            buffer_offsets: Some([
                COMMENT_TIMELINE_BUFFER0_OFFSET as u32,
                COMMENT_TIMELINE_BUFFER1_OFFSET as u32,
            ]),
            reaction_keys: None,
            capacity: Some(COMMENT_TIMELINE_CAPACITY as u32),
            record_stride_bytes: Some(COMMENT_TIMELINE_RECORD_STRIDE_BYTES as u32),
            records_offset: Some(COMMENT_TIMELINE_RECORDS_OFFSET as u32),
            head_offset: Some(COMMENT_TIMELINE_OFFSET_HEAD as u32),
            tail_offset: Some(COMMENT_TIMELINE_OFFSET_TAIL as u32),
            entry_count_offset: Some(COMMENT_TIMELINE_OFFSET_ENTRY_COUNT as u32),
            next_cursor_offset: Some(COMMENT_TIMELINE_OFFSET_NEXT_CURSOR as u32),
            dropped_count_offset: Some(COMMENT_TIMELINE_OFFSET_DROPPED_COUNT as u32),
            cursor_offset: Some(COMMENT_TIMELINE_RECORD_CURSOR_OFFSET as u32),
            flags_offset: Some(COMMENT_TIMELINE_RECORD_FLAGS_OFFSET as u32),
            scene_id_offset: None,
            scene_id_bytes: None,
            performance_id_offset: None,
            performance_id_bytes: None,
            effect_id_offset: None,
            effect_id_bytes: None,
            effect_type_offset: None,
            effect_type_bytes: None,
            arena_offset: Some(COMMENT_TIMELINE_ARENA_OFFSET as u32),
            arena_bytes: Some(COMMENT_TIMELINE_ARENA_BYTES as u32),
            arena_used_bytes_offset: Some(COMMENT_TIMELINE_OFFSET_ARENA_USED_BYTES as u32),
            id_offset: Some(COMMENT_TIMELINE_RECORD_ID_OFFSET as u32),
            name_offset: Some(COMMENT_TIMELINE_RECORD_NAME_OFFSET as u32),
            comment_offset: Some(COMMENT_TIMELINE_RECORD_COMMENT_OFFSET as u32),
            comment_html_offset: Some(COMMENT_TIMELINE_RECORD_COMMENT_HTML_OFFSET as u32),
            profile_image_offset: Some(COMMENT_TIMELINE_RECORD_PROFILE_IMAGE_OFFSET as u32),
            timestamp_offset: Some(COMMENT_TIMELINE_RECORD_TIMESTAMP_OFFSET as u32),
            currency_offset: Some(COMMENT_TIMELINE_RECORD_CURRENCY_OFFSET as u32),
            sticker_image_offset: Some(COMMENT_TIMELINE_RECORD_STICKER_IMAGE_OFFSET as u32),
            membership_header_offset: Some(COMMENT_TIMELINE_RECORD_MEMBERSHIP_HEADER_OFFSET as u32),
            member_months_offset: Some(COMMENT_TIMELINE_RECORD_MEMBER_MONTHS_OFFSET as u32),
            gift_count_offset: Some(COMMENT_TIMELINE_RECORD_GIFT_COUNT_OFFSET as u32),
            amount_offset: Some(COMMENT_TIMELINE_RECORD_AMOUNT_OFFSET as u32),
            connected_offset: None,
            video_id_offset: None,
            video_id_bytes: None,
            state_offset: None,
            payload_offset: None,
        }
    }

    fn connection_state() -> Self {
        Self {
            name: CONNECTION_STATE_NAME.to_string(),
            kind: "doubleBufferFixedSnapshot".to_string(),
            magic: SHARED_MEMORY_MAGIC,
            abi_version: SHARED_MEMORY_ABI_VERSION,
            layout_id: CONNECTION_STATE_LAYOUT_ID,
            total_bytes: CONNECTION_TOTAL_BYTES as u32,
            header_bytes: HEADER_BYTES as u32,
            slot_count: None,
            slot_stride_bytes: None,
            buffer_stride_bytes: Some(CONNECTION_BUFFER_STRIDE_BYTES as u32),
            active_buffer_index_offset: Some(DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX as u32),
            revision_offset: Some(DOUBLE_BUFFER_OFFSET_REVISION as u32),
            writer_state_offset: DOUBLE_BUFFER_OFFSET_WRITER_STATE as u32,
            buffer_offsets: Some([CONNECTION_BUFFER0_OFFSET as u32, CONNECTION_BUFFER1_OFFSET as u32]),
            reaction_keys: None,
            capacity: None,
            record_stride_bytes: None,
            records_offset: None,
            head_offset: None,
            tail_offset: None,
            entry_count_offset: None,
            next_cursor_offset: None,
            dropped_count_offset: None,
            cursor_offset: None,
            flags_offset: None,
            scene_id_offset: None,
            scene_id_bytes: None,
            performance_id_offset: None,
            performance_id_bytes: None,
            effect_id_offset: None,
            effect_id_bytes: None,
            effect_type_offset: None,
            effect_type_bytes: None,
            arena_offset: None,
            arena_bytes: None,
            arena_used_bytes_offset: None,
            id_offset: None,
            name_offset: None,
            comment_offset: None,
            comment_html_offset: None,
            profile_image_offset: None,
            timestamp_offset: None,
            currency_offset: None,
            sticker_image_offset: None,
            membership_header_offset: None,
            member_months_offset: None,
            gift_count_offset: None,
            amount_offset: None,
            connected_offset: Some(CONNECTION_OFFSET_CONNECTED as u32),
            video_id_offset: Some(CONNECTION_VIDEO_ID_OFFSET as u32),
            video_id_bytes: Some(CONNECTION_VIDEO_ID_BYTES as u32),
            state_offset: None,
            payload_offset: None,
        }
    }

    fn performance_engine_state() -> Self {
        Self {
            name: PERFORMANCE_ENGINE_STATE_NAME.to_string(),
            kind: "doubleBufferFixedEnumState".to_string(),
            magic: SHARED_MEMORY_MAGIC,
            abi_version: SHARED_MEMORY_ABI_VERSION,
            layout_id: PERFORMANCE_ENGINE_STATE_LAYOUT_ID,
            total_bytes: PERFORMANCE_ENGINE_STATE_TOTAL_BYTES as u32,
            header_bytes: HEADER_BYTES as u32,
            slot_count: None,
            slot_stride_bytes: None,
            buffer_stride_bytes: Some(PERFORMANCE_ENGINE_STATE_BUFFER_STRIDE_BYTES as u32),
            active_buffer_index_offset: Some(DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX as u32),
            revision_offset: Some(DOUBLE_BUFFER_OFFSET_REVISION as u32),
            writer_state_offset: DOUBLE_BUFFER_OFFSET_WRITER_STATE as u32,
            buffer_offsets: Some([
                PERFORMANCE_ENGINE_STATE_BUFFER0_OFFSET as u32,
                PERFORMANCE_ENGINE_STATE_BUFFER1_OFFSET as u32,
            ]),
            reaction_keys: None,
            capacity: None,
            record_stride_bytes: None,
            records_offset: None,
            head_offset: None,
            tail_offset: None,
            entry_count_offset: None,
            next_cursor_offset: None,
            dropped_count_offset: None,
            cursor_offset: None,
            flags_offset: None,
            scene_id_offset: None,
            scene_id_bytes: None,
            performance_id_offset: None,
            performance_id_bytes: None,
            effect_id_offset: None,
            effect_id_bytes: None,
            effect_type_offset: None,
            effect_type_bytes: None,
            arena_offset: None,
            arena_bytes: None,
            arena_used_bytes_offset: None,
            id_offset: None,
            name_offset: None,
            comment_offset: None,
            comment_html_offset: None,
            profile_image_offset: None,
            timestamp_offset: None,
            currency_offset: None,
            sticker_image_offset: None,
            membership_header_offset: None,
            member_months_offset: None,
            gift_count_offset: None,
            amount_offset: None,
            connected_offset: None,
            video_id_offset: None,
            video_id_bytes: None,
            state_offset: Some(PERFORMANCE_ENGINE_STATE_OFFSET_STATE as u32),
            payload_offset: None,
        }
    }
}

struct ReactionCountsSharedBuffer {
    layout: SharedBufferLayout,
    owned_bytes: Vec<u8>,
    buffer: Option<Buffer>,
    active_buffer_index: u32,
    revision: u32,
}

impl ReactionCountsSharedBuffer {
    fn new() -> Self {
        let mut shared = Self {
            layout: SharedBufferLayout::reaction_counts(),
            owned_bytes: vec![0u8; REACTION_TOTAL_BYTES],
            buffer: None,
            active_buffer_index: 0,
            revision: 0,
        };
        shared.reset_owned_bytes();
        shared
    }

    fn reset_owned_bytes(&mut self) {
        self.active_buffer_index = 0;
        self.revision = 0;
        let bytes = self.owned_bytes.as_mut_slice();
        bytes.fill(0);
        write_common_header(bytes, &self.layout);
        write_u32(bytes, REACTION_OFFSET_ACTIVE_BUFFER_INDEX, self.active_buffer_index);
        write_u32(bytes, REACTION_OFFSET_REVISION, self.revision);
        write_u32(bytes, REACTION_OFFSET_WRITER_STATE, WRITER_STATE_IDLE);
        write_u32(bytes, REACTION_OFFSET_BUFFER0, REACTION_BUFFER0_OFFSET as u32);
        write_u32(bytes, REACTION_OFFSET_BUFFER1, REACTION_BUFFER1_OFFSET as u32);
    }

    fn register_buffer(&mut self, buffer: Buffer) -> Result<(), String> {
        ensure_buffer_size(&buffer, REACTION_TOTAL_BYTES)?;
        self.reset_owned_bytes();
        self.buffer = Some(buffer);
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
        Ok(())
    }

    fn publish(&mut self, counts: &ReactionCounts) {
        let inactive_buffer_index = if self.active_buffer_index == 0 { 1 } else { 0 };
        let next_revision = self.revision.wrapping_add(1);
        let target_offset = if inactive_buffer_index == 0 {
            REACTION_BUFFER0_OFFSET
        } else {
            REACTION_BUFFER1_OFFSET
        };

        let bytes = self.owned_bytes.as_mut_slice();
        write_u32(bytes, REACTION_OFFSET_WRITER_STATE, WRITER_STATE_WRITING);

        for (slot_index, reaction_key) in REACTION_COUNT_KEYS.iter().enumerate() {
            let slot_offset = target_offset + (slot_index * REACTION_SLOT_STRIDE_BYTES);
            write_u64(bytes, slot_offset, counts.get(reaction_key));
        }

        write_u32(bytes, REACTION_OFFSET_ACTIVE_BUFFER_INDEX, inactive_buffer_index);
        write_u32(bytes, REACTION_OFFSET_REVISION, next_revision);
        write_u32(bytes, REACTION_OFFSET_WRITER_STATE, WRITER_STATE_IDLE);

        self.active_buffer_index = inactive_buffer_index;
        self.revision = next_revision;
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
    }
}

struct PerformanceLogSharedBuffer {
    layout: SharedBufferLayout,
    owned_bytes: Vec<u8>,
    buffer: Option<Buffer>,
    active_buffer_index: u32,
    revision: u32,
}

impl PerformanceLogSharedBuffer {
    fn new() -> Self {
        let mut shared = Self {
            layout: SharedBufferLayout::performance_log(),
            owned_bytes: vec![0u8; PERFORMANCE_LOG_TOTAL_BYTES],
            buffer: None,
            active_buffer_index: 0,
            revision: 0,
        };
        shared.reset_owned_bytes();
        shared
    }

    fn reset_owned_bytes(&mut self) {
        self.active_buffer_index = 0;
        self.revision = 0;

        let bytes = self.owned_bytes.as_mut_slice();
        bytes.fill(0);
        write_common_header(bytes, &self.layout);
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX,
            self.active_buffer_index,
        );
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_REVISION,
            self.revision,
        );
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_IDLE);
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_BUFFER_STRIDE_BYTES,
            PERFORMANCE_LOG_BUFFER_STRIDE_BYTES as u32,
        );
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_BUFFER0, PERFORMANCE_LOG_BUFFER0_OFFSET as u32);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_BUFFER1, PERFORMANCE_LOG_BUFFER1_OFFSET as u32);
        write_performance_log_bank_empty(bytes, PERFORMANCE_LOG_BUFFER0_OFFSET);
        write_performance_log_bank_empty(bytes, PERFORMANCE_LOG_BUFFER1_OFFSET);
    }

    fn register_buffer(&mut self, buffer: Buffer) -> Result<(), String> {
        ensure_buffer_size(&buffer, PERFORMANCE_LOG_TOTAL_BYTES)?;
        self.reset_owned_bytes();
        self.buffer = Some(buffer);
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
        Ok(())
    }

    fn publish_entry(&mut self, entry: &PerformanceLogEntry, log: &PerformanceLog) {
        let _ = entry;
        let inactive_buffer_index = if self.active_buffer_index == 0 { 1 } else { 0 };
        let target_offset = if inactive_buffer_index == 0 {
            PERFORMANCE_LOG_BUFFER0_OFFSET
        } else {
            PERFORMANCE_LOG_BUFFER1_OFFSET
        };
        let next_revision = self.revision.wrapping_add(1);
        let bytes = self.owned_bytes.as_mut_slice();
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_WRITING);
        write_performance_log_bank(bytes, target_offset, log);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX, inactive_buffer_index);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_REVISION, next_revision);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_IDLE);

        self.active_buffer_index = inactive_buffer_index;
        self.revision = next_revision;
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
    }
}

struct CommentTimelineSharedBuffer {
    layout: SharedBufferLayout,
    owned_bytes: Vec<u8>,
    buffer: Option<Buffer>,
    active_buffer_index: u32,
    revision: u32,
}

impl CommentTimelineSharedBuffer {
    fn new() -> Self {
        let mut shared = Self {
            layout: SharedBufferLayout::comment_timeline(),
            owned_bytes: vec![0u8; COMMENT_TIMELINE_TOTAL_BYTES],
            buffer: None,
            active_buffer_index: 0,
            revision: 0,
        };
        shared.reset_owned_bytes();
        shared
    }

    fn reset_owned_bytes(&mut self) {
        self.active_buffer_index = 0;
        self.revision = 0;

        let bytes = self.owned_bytes.as_mut_slice();
        bytes.fill(0);
        write_common_header(bytes, &self.layout);
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX,
            self.active_buffer_index,
        );
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_REVISION,
            self.revision,
        );
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_IDLE);
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_BUFFER_STRIDE_BYTES,
            COMMENT_TIMELINE_BUFFER_STRIDE_BYTES as u32,
        );
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_BUFFER0, COMMENT_TIMELINE_BUFFER0_OFFSET as u32);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_BUFFER1, COMMENT_TIMELINE_BUFFER1_OFFSET as u32);
        write_comment_timeline_bank_empty(bytes, COMMENT_TIMELINE_BUFFER0_OFFSET);
        write_comment_timeline_bank_empty(bytes, COMMENT_TIMELINE_BUFFER1_OFFSET);
    }

    fn register_buffer(&mut self, buffer: Buffer) -> Result<(), String> {
        ensure_buffer_size(&buffer, COMMENT_TIMELINE_TOTAL_BYTES)?;
        self.reset_owned_bytes();
        self.buffer = Some(buffer);
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
        Ok(())
    }

    fn publish_entry(&mut self, entry: &CommentTimelineEntry, timeline: &CommentTimeline) {
        let _ = entry;
        let inactive_buffer_index = if self.active_buffer_index == 0 { 1 } else { 0 };
        let target_offset = if inactive_buffer_index == 0 {
            COMMENT_TIMELINE_BUFFER0_OFFSET
        } else {
            COMMENT_TIMELINE_BUFFER1_OFFSET
        };
        let next_revision = self.revision.wrapping_add(1);
        let bytes = self.owned_bytes.as_mut_slice();
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_WRITING);
        write_comment_timeline_bank(bytes, target_offset, timeline);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX, inactive_buffer_index);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_REVISION, next_revision);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_IDLE);

        self.active_buffer_index = inactive_buffer_index;
        self.revision = next_revision;
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
    }
}

struct ConnectionSharedBuffer {
    layout: SharedBufferLayout,
    owned_bytes: Vec<u8>,
    buffer: Option<Buffer>,
    active_buffer_index: u32,
    revision: u32,
}

impl ConnectionSharedBuffer {
    fn new() -> Self {
        let mut shared = Self {
            layout: SharedBufferLayout::connection_state(),
            owned_bytes: vec![0u8; CONNECTION_TOTAL_BYTES],
            buffer: None,
            active_buffer_index: 0,
            revision: 0,
        };
        shared.reset_owned_bytes();
        shared
    }

    fn reset_owned_bytes(&mut self) {
        self.active_buffer_index = 0;
        self.revision = 0;

        let bytes = self.owned_bytes.as_mut_slice();
        bytes.fill(0);
        write_common_header(bytes, &self.layout);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX, self.active_buffer_index);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_REVISION, self.revision);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_IDLE);
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_BUFFER_STRIDE_BYTES,
            CONNECTION_BUFFER_STRIDE_BYTES as u32,
        );
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_BUFFER0, CONNECTION_BUFFER0_OFFSET as u32);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_BUFFER1, CONNECTION_BUFFER1_OFFSET as u32);
    }

    fn register_buffer(&mut self, buffer: Buffer) -> Result<(), String> {
        ensure_buffer_size(&buffer, CONNECTION_TOTAL_BYTES)?;
        self.reset_owned_bytes();
        self.buffer = Some(buffer);
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
        Ok(())
    }

    // ConnectionState の **全フィールド** を shared_memory layout に同期する。
    // struct と layout を一致させることで、SSE message data に inject した派生値が
    // napi 経路で剥がれる類のバグを構造的に防ぐ (= 2026-05-09 isOwnStream 事例)。
    // フィールド追加時は state/connection.rs と layout 定数 (上部) を同時更新すること。
    fn publish(&mut self, connection: &ConnectionState) {
        let inactive_buffer_index = if self.active_buffer_index == 0 { 1 } else { 0 };
        let next_revision = self.revision.wrapping_add(1);
        let target_offset = if inactive_buffer_index == 0 {
            CONNECTION_BUFFER0_OFFSET
        } else {
            CONNECTION_BUFFER1_OFFSET
        };

        let bytes = self.owned_bytes.as_mut_slice();
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_WRITING);
        write_u32(
            bytes,
            target_offset + CONNECTION_OFFSET_CONNECTED,
            if connection.connected { 1 } else { 0 },
        );
        write_u32(
            bytes,
            target_offset + CONNECTION_OFFSET_IS_OWN_STREAM,
            if connection.is_own_stream { 1 } else { 0 },
        );
        write_fixed_string(
            bytes,
            target_offset + CONNECTION_VIDEO_ID_OFFSET,
            CONNECTION_VIDEO_ID_BYTES,
            connection.video_id.as_deref().unwrap_or(""),
        );
        write_fixed_string(
            bytes,
            target_offset + CONNECTION_OWNER_CHANNEL_ID_OFFSET,
            CONNECTION_OWNER_CHANNEL_ID_BYTES,
            connection
                .current_stream_owner_channel_id
                .as_deref()
                .unwrap_or(""),
        );
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX, inactive_buffer_index);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_REVISION, next_revision);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_WRITER_STATE, WRITER_STATE_IDLE);

        self.active_buffer_index = inactive_buffer_index;
        self.revision = next_revision;
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
    }
}

struct PerformanceEngineStateSharedBuffer {
    layout: SharedBufferLayout,
    owned_bytes: Vec<u8>,
    buffer: Option<Buffer>,
    active_buffer_index: u32,
    revision: u32,
}

impl PerformanceEngineStateSharedBuffer {
    fn new() -> Self {
        let mut shared = Self {
            layout: SharedBufferLayout::performance_engine_state(),
            owned_bytes: vec![0u8; PERFORMANCE_ENGINE_STATE_TOTAL_BYTES],
            buffer: None,
            active_buffer_index: 0,
            revision: 0,
        };
        shared.reset_owned_bytes();
        shared
    }

    fn reset_owned_bytes(&mut self) {
        self.active_buffer_index = 0;
        self.revision = 0;

        let bytes = self.owned_bytes.as_mut_slice();
        bytes.fill(0);
        write_common_header(bytes, &self.layout);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX, self.active_buffer_index);
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_REVISION, self.revision);
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_WRITER_STATE,
            WRITER_STATE_IDLE,
        );
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_BUFFER_STRIDE_BYTES,
            PERFORMANCE_ENGINE_STATE_BUFFER_STRIDE_BYTES as u32,
        );
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_BUFFER0,
            PERFORMANCE_ENGINE_STATE_BUFFER0_OFFSET as u32,
        );
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_BUFFER1,
            PERFORMANCE_ENGINE_STATE_BUFFER1_OFFSET as u32,
        );
        write_u32(
            bytes,
            PERFORMANCE_ENGINE_STATE_BUFFER0_OFFSET + PERFORMANCE_ENGINE_STATE_OFFSET_STATE,
            engine_state_to_u32(EngineState::Initializing),
        );
        write_u32(
            bytes,
            PERFORMANCE_ENGINE_STATE_BUFFER1_OFFSET + PERFORMANCE_ENGINE_STATE_OFFSET_STATE,
            engine_state_to_u32(EngineState::Initializing),
        );
    }

    fn register_buffer(&mut self, buffer: Buffer) -> Result<(), String> {
        ensure_buffer_size(&buffer, PERFORMANCE_ENGINE_STATE_TOTAL_BYTES)?;
        self.reset_owned_bytes();
        self.buffer = Some(buffer);
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
        Ok(())
    }

    fn publish(&mut self, state: EngineState) {
        let inactive_buffer_index = if self.active_buffer_index == 0 { 1 } else { 0 };
        let next_revision = self.revision.wrapping_add(1);
        let target_offset = if inactive_buffer_index == 0 {
            PERFORMANCE_ENGINE_STATE_BUFFER0_OFFSET
        } else {
            PERFORMANCE_ENGINE_STATE_BUFFER1_OFFSET
        };

        let bytes = self.owned_bytes.as_mut_slice();
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_WRITER_STATE,
            WRITER_STATE_WRITING,
        );
        write_u32(
            bytes,
            target_offset + PERFORMANCE_ENGINE_STATE_OFFSET_STATE,
            engine_state_to_u32(state),
        );
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX,
            inactive_buffer_index,
        );
        write_u32(bytes, DOUBLE_BUFFER_OFFSET_REVISION, next_revision);
        write_u32(
            bytes,
            DOUBLE_BUFFER_OFFSET_WRITER_STATE,
            WRITER_STATE_IDLE,
        );

        self.active_buffer_index = inactive_buffer_index;
        self.revision = next_revision;
        sync_registered_buffer(&mut self.buffer, &self.owned_bytes);
    }
}

struct SharedBufferRegistry {
    reaction_counts: ReactionCountsSharedBuffer,
    performance_log: PerformanceLogSharedBuffer,
    comment_timeline: CommentTimelineSharedBuffer,
    connection: ConnectionSharedBuffer,
    performance_engine_state: PerformanceEngineStateSharedBuffer,
}

impl SharedBufferRegistry {
    fn new() -> Self {
        Self {
            reaction_counts: ReactionCountsSharedBuffer::new(),
            performance_log: PerformanceLogSharedBuffer::new(),
            comment_timeline: CommentTimelineSharedBuffer::new(),
            connection: ConnectionSharedBuffer::new(),
            performance_engine_state: PerformanceEngineStateSharedBuffer::new(),
        }
    }
}

fn shared_registry() -> &'static Mutex<SharedBufferRegistry> {
    static REGISTRY: OnceLock<Mutex<SharedBufferRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(SharedBufferRegistry::new()))
}

fn shared_access_registry() -> &'static SharedAccessRegistry {
    static REGISTRY: OnceLock<SharedAccessRegistry> = OnceLock::new();
    REGISTRY.get_or_init(SharedAccessRegistry::new)
}

fn shared_access_gate(name: &str) -> Option<&'static SharedAccessGate> {
    let registry = shared_access_registry();
    match name {
        REACTION_COUNTS_NAME => Some(&registry.reaction_counts),
        PERFORMANCE_LOG_NAME => Some(&registry.performance_log),
        COMMENT_TIMELINE_NAME => Some(&registry.comment_timeline),
        CONNECTION_STATE_NAME => Some(&registry.connection),
        PERFORMANCE_ENGINE_STATE_NAME => Some(&registry.performance_engine_state),
        _ => None,
    }
}

pub fn get_layout(name: &str) -> Option<SharedBufferLayout> {
    match name {
        REACTION_COUNTS_NAME => Some(SharedBufferLayout::reaction_counts()),
        PERFORMANCE_LOG_NAME => Some(SharedBufferLayout::performance_log()),
        COMMENT_TIMELINE_NAME => Some(SharedBufferLayout::comment_timeline()),
        CONNECTION_STATE_NAME => Some(SharedBufferLayout::connection_state()),
        PERFORMANCE_ENGINE_STATE_NAME => Some(SharedBufferLayout::performance_engine_state()),
        _ => None,
    }
}

pub fn register_buffer(name: &str, buffer: Buffer) -> Result<(), String> {
    let mut registry = shared_registry()
        .lock()
        .map_err(|_| "shared buffer registry lock poisoned".to_string())?;

    match name {
        REACTION_COUNTS_NAME => registry.reaction_counts.register_buffer(buffer),
        PERFORMANCE_LOG_NAME => registry.performance_log.register_buffer(buffer),
        COMMENT_TIMELINE_NAME => registry.comment_timeline.register_buffer(buffer),
        CONNECTION_STATE_NAME => registry.connection.register_buffer(buffer),
        PERFORMANCE_ENGINE_STATE_NAME => registry.performance_engine_state.register_buffer(buffer),
        _ => Err(format!("unknown shared buffer: {}", name)),
    }
}

fn with_registered_shared_buffer<T>(
    name: &str,
    reader: impl FnOnce(&SharedBufferRegistry) -> Result<T, String>,
) -> Result<T, String> {
    let gate = shared_access_gate(name).ok_or_else(|| format!("unknown shared buffer: {}", name))?;
    gate.acquire()?;
    let result = {
        let registry = shared_registry()
            .lock()
            .map_err(|_| "shared buffer registry lock poisoned".to_string())?;
        reader(&registry)
    };
    let release_result = gate.release();
    match (result, release_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(_)) => Err(primary),
    }
}

pub fn read_reaction_counts_snapshot() -> Result<serde_json::Value, String> {
    with_registered_shared_buffer(REACTION_COUNTS_NAME, |registry| {
        decode_reaction_counts_snapshot(registry.reaction_counts.owned_bytes.as_slice())
    })
}

pub fn read_performance_log_snapshot(cursor: u32) -> Result<serde_json::Value, String> {
    with_registered_shared_buffer(PERFORMANCE_LOG_NAME, |registry| {
        decode_performance_log_snapshot(registry.performance_log.owned_bytes.as_slice(), cursor)
    })
}

pub fn read_comment_timeline_snapshot(cursor: u32) -> Result<serde_json::Value, String> {
    with_registered_shared_buffer(COMMENT_TIMELINE_NAME, |registry| {
        decode_comment_timeline_snapshot(registry.comment_timeline.owned_bytes.as_slice(), cursor)
    })
}

pub fn read_connection_state_snapshot() -> Result<serde_json::Value, String> {
    with_registered_shared_buffer(CONNECTION_STATE_NAME, |registry| {
        decode_connection_state_snapshot(registry.connection.owned_bytes.as_slice())
    })
}

pub fn read_performance_engine_state_snapshot() -> Result<serde_json::Value, String> {
    with_registered_shared_buffer(PERFORMANCE_ENGINE_STATE_NAME, |registry| {
        decode_performance_engine_state_snapshot(registry.performance_engine_state.owned_bytes.as_slice())
    })
}

fn fail_fast_shared_memory(operation: &str, error: &str) -> ! {
    tracing::error!("shared-memory fail-fast: {}: {}", operation, error);
    panic!("shared-memory fail-fast: {}: {}", operation, error);
}

pub fn publish_reaction_counts(counts: &ReactionCounts) {
    let gate = shared_access_gate(REACTION_COUNTS_NAME)
        .unwrap_or_else(|| fail_fast_shared_memory("publish reactionCounts gate lookup", REACTION_COUNTS_NAME));
    gate.acquire()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish reactionCounts acquire", &error));
    let mut registry = shared_registry()
        .lock()
        .unwrap_or_else(|_| fail_fast_shared_memory("publish reactionCounts registry lock", "shared buffer registry lock poisoned"));
    registry.reaction_counts.publish(counts);
    drop(registry);
    gate.release()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish reactionCounts release", &error));
}

pub fn publish_performance_log_entry(entry: &PerformanceLogEntry, log: &PerformanceLog) {
    let gate = shared_access_gate(PERFORMANCE_LOG_NAME)
        .unwrap_or_else(|| fail_fast_shared_memory("publish performanceLog gate lookup", PERFORMANCE_LOG_NAME));
    gate.acquire()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish performanceLog acquire", &error));
    let mut registry = shared_registry()
        .lock()
        .unwrap_or_else(|_| fail_fast_shared_memory("publish performanceLog registry lock", "shared buffer registry lock poisoned"));
    registry.performance_log.publish_entry(entry, log);
    drop(registry);
    gate.release()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish performanceLog release", &error));
}

pub fn publish_comment_timeline_entry(entry: &CommentTimelineEntry, timeline: &CommentTimeline) {
    let gate = shared_access_gate(COMMENT_TIMELINE_NAME)
        .unwrap_or_else(|| fail_fast_shared_memory("publish commentTimeline gate lookup", COMMENT_TIMELINE_NAME));
    gate.acquire()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish commentTimeline acquire", &error));
    let mut registry = shared_registry()
        .lock()
        .unwrap_or_else(|_| fail_fast_shared_memory("publish commentTimeline registry lock", "shared buffer registry lock poisoned"));
    registry.comment_timeline.publish_entry(entry, timeline);
    drop(registry);
    gate.release()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish commentTimeline release", &error));
}

pub fn publish_connection_state(connection: &ConnectionState) {
    let gate = shared_access_gate(CONNECTION_STATE_NAME)
        .unwrap_or_else(|| fail_fast_shared_memory("publish connection gate lookup", CONNECTION_STATE_NAME));
    gate.acquire()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish connection acquire", &error));
    let mut registry = shared_registry()
        .lock()
        .unwrap_or_else(|_| fail_fast_shared_memory("publish connection registry lock", "shared buffer registry lock poisoned"));
    registry.connection.publish(connection);
    drop(registry);
    gate.release()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish connection release", &error));
}

pub fn publish_performance_engine_state(state: EngineState) {
    let gate = shared_access_gate(PERFORMANCE_ENGINE_STATE_NAME)
        .unwrap_or_else(|| fail_fast_shared_memory("publish performanceEngineState gate lookup", PERFORMANCE_ENGINE_STATE_NAME));
    gate.acquire()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish performanceEngineState acquire", &error));
    let mut registry = shared_registry()
        .lock()
        .unwrap_or_else(|_| fail_fast_shared_memory("publish performanceEngineState registry lock", "shared buffer registry lock poisoned"));
    registry.performance_engine_state.publish(state);
    drop(registry);
    gate.release()
        .unwrap_or_else(|error| fail_fast_shared_memory("publish performanceEngineState release", &error));
}

fn ensure_buffer_size(buffer: &Buffer, required_size: usize) -> Result<(), String> {
    if buffer.len() < required_size {
        return Err(format!(
            "shared buffer too small: expected at least {} bytes, got {}",
            required_size,
            buffer.len()
        ));
    }
    Ok(())
}

fn sync_registered_buffer(buffer: &mut Option<Buffer>, bytes: &[u8]) {
    if let Some(buffer) = buffer.as_mut() {
        buffer.as_mut()[..bytes.len()].copy_from_slice(bytes);
    }
}

fn read_u32_at(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| format!("shared buffer read out of bounds at offset {}", offset))?;
    let mut raw = [0u8; 4];
    raw.copy_from_slice(slice);
    Ok(u32::from_le_bytes(raw))
}

fn read_u64_at(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| format!("shared buffer read out of bounds at offset {}", offset))?;
    let mut raw = [0u8; 8];
    raw.copy_from_slice(slice);
    Ok(u64::from_le_bytes(raw))
}

fn read_f64_at(bytes: &[u8], offset: usize) -> Result<f64, String> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| format!("shared buffer read out of bounds at offset {}", offset))?;
    let mut raw = [0u8; 8];
    raw.copy_from_slice(slice);
    Ok(f64::from_le_bytes(raw))
}

fn read_fixed_string_at(bytes: &[u8], offset: usize, byte_length: usize) -> Result<String, String> {
    let slice = bytes
        .get(offset..offset + byte_length)
        .ok_or_else(|| format!("shared buffer read out of bounds at offset {}", offset))?;
    let zero_index = slice.iter().position(|byte| *byte == 0).unwrap_or(slice.len());
    Ok(String::from_utf8_lossy(&slice[..zero_index]).to_string())
}

fn read_arena_string_at(bytes: &[u8], arena_base_offset: usize, offset: usize, byte_length: usize) -> Result<String, String> {
    if byte_length == 0 {
        return Ok(String::new());
    }
    let start = arena_base_offset + offset;
    let end = start + byte_length;
    let slice = bytes
        .get(start..end)
        .ok_or_else(|| format!("shared arena read out of bounds at offset {}", start))?;
    Ok(String::from_utf8_lossy(slice).to_string())
}

fn read_arena_ref_at(bytes: &[u8], record_offset: usize, field_offset: usize, arena_base_offset: usize) -> Result<String, String> {
    let text_offset = read_u32_at(bytes, record_offset + field_offset)? as usize;
    let text_length = read_u32_at(bytes, record_offset + field_offset + 4)? as usize;
    read_arena_string_at(bytes, arena_base_offset, text_offset, text_length)
}

fn decode_reaction_counts_snapshot(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let revision_before = read_u32_at(bytes, REACTION_OFFSET_REVISION)?;
    let active_buffer_index = read_u32_at(bytes, REACTION_OFFSET_ACTIVE_BUFFER_INDEX)?;
    let buffer_offset = match active_buffer_index {
        0 => REACTION_BUFFER0_OFFSET,
        1 => REACTION_BUFFER1_OFFSET,
        _ => return Err(format!("invalid active buffer index: {}", active_buffer_index)),
    };

    let mut counts = serde_json::Map::new();
    let mut total = 0u64;
    for (index, key) in REACTION_COUNT_KEYS.iter().enumerate() {
        let slot_offset = buffer_offset + (index * REACTION_SLOT_STRIDE_BYTES);
        let count = read_u64_at(bytes, slot_offset)?;
        total += count;
        counts.insert((*key).to_string(), serde_json::Value::Number(serde_json::Number::from(count)));
    }

    let revision_after = read_u32_at(bytes, REACTION_OFFSET_REVISION)?;
    if revision_before != revision_after {
        return Err("reactionCounts revision changed during read".to_string());
    }

    Ok(serde_json::json!({
        "counts": counts,
        "total": total,
        "source": "sharedMemory",
        "revision": revision_after
    }))
}

fn decode_performance_log_snapshot(bytes: &[u8], cursor: u32) -> Result<serde_json::Value, String> {
    let revision_before = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_REVISION)?;
    let active_buffer_index = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX)?;
    let base_offset = match active_buffer_index {
        0 => PERFORMANCE_LOG_BUFFER0_OFFSET,
        1 => PERFORMANCE_LOG_BUFFER1_OFFSET,
        _ => return Err(format!("invalid active buffer index: {}", active_buffer_index)),
    };

    let head = read_u32_at(bytes, base_offset + PERFORMANCE_LOG_OFFSET_HEAD)? as usize;
    let entry_count = read_u32_at(bytes, base_offset + PERFORMANCE_LOG_OFFSET_ENTRY_COUNT)? as usize;
    let next_cursor = read_u32_at(bytes, base_offset + PERFORMANCE_LOG_OFFSET_NEXT_CURSOR)?;
    let dropped_count = read_u32_at(bytes, base_offset + PERFORMANCE_LOG_OFFSET_DROPPED_COUNT)?;
    let arena_used_bytes = read_u32_at(bytes, base_offset + PERFORMANCE_LOG_OFFSET_ARENA_USED_BYTES)? as usize;
    if entry_count > PERFORMANCE_LOG_CAPACITY {
        return Err(format!("invalid performanceLog entry_count: {}", entry_count));
    }
    if arena_used_bytes > PERFORMANCE_LOG_ARENA_BYTES {
        return Err(format!("invalid performanceLog arena_used_bytes: {}", arena_used_bytes));
    }

    let mut entries = Vec::new();
    for index in 0..entry_count {
        let physical_index = (head + index) % PERFORMANCE_LOG_CAPACITY;
        let record_offset = base_offset + PERFORMANCE_LOG_RECORDS_OFFSET + (physical_index * PERFORMANCE_LOG_RECORD_STRIDE_BYTES);
        let entry_cursor = read_u32_at(bytes, record_offset + PERFORMANCE_LOG_RECORD_CURSOR_OFFSET)?;
        if entry_cursor == 0 || entry_cursor <= cursor {
            continue;
        }

        let flags = read_u32_at(bytes, record_offset + PERFORMANCE_LOG_RECORD_FLAGS_OFFSET)?;
        let payload_json = read_arena_ref_at(bytes, record_offset, PERFORMANCE_LOG_RECORD_PAYLOAD_OFFSET, base_offset + PERFORMANCE_LOG_ARENA_OFFSET)?;
        let payload_value: serde_json::Value = serde_json::from_str(&payload_json)
            .map_err(|error| format!("failed to parse performance payload JSON: {}", error))?;
        let mut entry = payload_value
            .as_object()
            .cloned()
            .ok_or_else(|| "performance payload is not an object".to_string())?;

        let scene_id = entry
            .get("sceneId")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or(read_fixed_string_at(bytes, record_offset + PERFORMANCE_LOG_RECORD_SCENE_ID_OFFSET, PERFORMANCE_LOG_SCENE_ID_BYTES)?);
        let performance_id = entry
            .get("performanceId")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or(read_fixed_string_at(bytes, record_offset + PERFORMANCE_LOG_RECORD_PERFORMANCE_ID_OFFSET, PERFORMANCE_LOG_PERFORMANCE_ID_BYTES)?);
        let effect_id = entry
            .get("effect")
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or(read_fixed_string_at(bytes, record_offset + PERFORMANCE_LOG_RECORD_EFFECT_ID_OFFSET, PERFORMANCE_LOG_EFFECT_ID_BYTES)?);
        let effect_type = entry
            .get("effect")
            .and_then(|value| value.get("type"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or(read_fixed_string_at(bytes, record_offset + PERFORMANCE_LOG_RECORD_EFFECT_TYPE_OFFSET, PERFORMANCE_LOG_EFFECT_TYPE_BYTES)?);

        entry.insert("cursor".to_string(), serde_json::Value::Number(serde_json::Number::from(entry_cursor)));
        entry.insert("sceneId".to_string(), serde_json::Value::String(scene_id));
        entry.insert("performanceId".to_string(), serde_json::Value::String(performance_id));
        entry.insert("effectId".to_string(), serde_json::Value::String(effect_id));
        entry.insert("effectType".to_string(), serde_json::Value::String(effect_type));
        entry.insert("hasContext".to_string(), serde_json::Value::Bool((flags & 1) == 1));
        entries.push(serde_json::Value::Object(entry));
    }

    let revision_after = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_REVISION)?;
    if revision_before != revision_after {
        return Err("performanceLog revision changed during read".to_string());
    }

    Ok(serde_json::json!({
        "entries": entries,
        "nextCursor": next_cursor,
        "droppedCount": dropped_count,
        "source": "sharedMemory",
        "revision": revision_after
    }))
}

fn decode_comment_timeline_snapshot(bytes: &[u8], cursor: u32) -> Result<serde_json::Value, String> {
    let revision_before = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_REVISION)?;
    let active_buffer_index = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX)?;
    let base_offset = match active_buffer_index {
        0 => COMMENT_TIMELINE_BUFFER0_OFFSET,
        1 => COMMENT_TIMELINE_BUFFER1_OFFSET,
        _ => return Err(format!("invalid active buffer index: {}", active_buffer_index)),
    };

    let head = read_u32_at(bytes, base_offset + COMMENT_TIMELINE_OFFSET_HEAD)? as usize;
    let entry_count = read_u32_at(bytes, base_offset + COMMENT_TIMELINE_OFFSET_ENTRY_COUNT)? as usize;
    let next_cursor = read_u32_at(bytes, base_offset + COMMENT_TIMELINE_OFFSET_NEXT_CURSOR)?;
    let dropped_count = read_u32_at(bytes, base_offset + COMMENT_TIMELINE_OFFSET_DROPPED_COUNT)?;
    let arena_used_bytes = read_u32_at(bytes, base_offset + COMMENT_TIMELINE_OFFSET_ARENA_USED_BYTES)? as usize;
    if entry_count > COMMENT_TIMELINE_CAPACITY {
        return Err(format!("invalid commentTimeline entry_count: {}", entry_count));
    }
    if arena_used_bytes > COMMENT_TIMELINE_ARENA_BYTES {
        return Err(format!("invalid commentTimeline arena_used_bytes: {}", arena_used_bytes));
    }

    let mut entries = Vec::new();
    for index in 0..entry_count {
        let physical_index = (head + index) % COMMENT_TIMELINE_CAPACITY;
        let record_offset = base_offset + COMMENT_TIMELINE_RECORDS_OFFSET + (physical_index * COMMENT_TIMELINE_RECORD_STRIDE_BYTES);
        let entry_cursor = read_u32_at(bytes, record_offset + COMMENT_TIMELINE_RECORD_CURSOR_OFFSET)?;
        if entry_cursor == 0 || entry_cursor <= cursor {
            continue;
        }

        let flags = read_u32_at(bytes, record_offset + COMMENT_TIMELINE_RECORD_FLAGS_OFFSET)?;
        entries.push(serde_json::json!({
            "cursor": entry_cursor,
            "id": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_ID_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "name": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_NAME_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "comment": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_COMMENT_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "commentHtml": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_COMMENT_HTML_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "profileImage": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_PROFILE_IMAGE_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "timestamp": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_TIMESTAMP_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "hasGift": (flags & 1) == 1,
            "amount": read_f64_at(bytes, record_offset + COMMENT_TIMELINE_RECORD_AMOUNT_OFFSET)?,
            "currency": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_CURRENCY_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "stickerImage": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_STICKER_IMAGE_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "isMember": (flags & 2) == 2,
            "memberMonths": read_u32_at(bytes, record_offset + COMMENT_TIMELINE_RECORD_MEMBER_MONTHS_OFFSET)?,
            "isMembership": (flags & 4) == 4,
            "membershipHeader": read_arena_ref_at(bytes, record_offset, COMMENT_TIMELINE_RECORD_MEMBERSHIP_HEADER_OFFSET, base_offset + COMMENT_TIMELINE_ARENA_OFFSET)?,
            "isMembershipGift": (flags & 8) == 8,
            "giftCount": read_u32_at(bytes, record_offset + COMMENT_TIMELINE_RECORD_GIFT_COUNT_OFFSET)?
        }));
    }

    let revision_after = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_REVISION)?;
    if revision_before != revision_after {
        return Err("commentTimeline revision changed during read".to_string());
    }

    Ok(serde_json::json!({
        "entries": entries,
        "nextCursor": next_cursor,
        "droppedCount": dropped_count,
        "source": "sharedMemory",
        "revision": revision_after
    }))
}

fn decode_connection_state_snapshot(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let revision_before = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_REVISION)?;
    let active_buffer_index = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX)?;
    let base_offset = match active_buffer_index {
        0 => CONNECTION_BUFFER0_OFFSET,
        1 => CONNECTION_BUFFER1_OFFSET,
        _ => return Err(format!("invalid active buffer index: {}", active_buffer_index)),
    };

    let connected = read_u32_at(bytes, base_offset + CONNECTION_OFFSET_CONNECTED)? == 1;
    let is_own_stream = read_u32_at(bytes, base_offset + CONNECTION_OFFSET_IS_OWN_STREAM)? == 1;
    let video_id = read_fixed_string_at(bytes, base_offset + CONNECTION_VIDEO_ID_OFFSET, CONNECTION_VIDEO_ID_BYTES)?;
    let owner_channel_id = read_fixed_string_at(
        bytes,
        base_offset + CONNECTION_OWNER_CHANNEL_ID_OFFSET,
        CONNECTION_OWNER_CHANNEL_ID_BYTES,
    )?;
    let revision_after = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_REVISION)?;
    if revision_before != revision_after {
        return Err("connection revision changed during read".to_string());
    }

    let mut data = serde_json::Map::new();
    data.insert("connected".into(), serde_json::Value::Bool(connected));
    data.insert("isOwnStream".into(), serde_json::Value::Bool(is_own_stream));
    data.insert(
        "videoId".into(),
        if video_id.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(video_id)
        },
    );
    data.insert(
        "currentStreamOwnerChannelId".into(),
        if owner_channel_id.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(owner_channel_id)
        },
    );
    Ok(serde_json::json!({
        "data": serde_json::Value::Object(data),
        "source": "sharedMemory",
        "revision": revision_after
    }))
}

fn decode_performance_engine_state_snapshot(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let revision_before = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_REVISION)?;
    let active_buffer_index = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX)?;
    let base_offset = match active_buffer_index {
        0 => PERFORMANCE_ENGINE_STATE_BUFFER0_OFFSET,
        1 => PERFORMANCE_ENGINE_STATE_BUFFER1_OFFSET,
        _ => return Err(format!("invalid active buffer index: {}", active_buffer_index)),
    };

    let state_code = read_u32_at(bytes, base_offset + PERFORMANCE_ENGINE_STATE_OFFSET_STATE)? as usize;
    let state = match state_code {
        0 => "initializing",
        1 => "running",
        2 => "paused",
        3 => "error",
        4 => "stopped",
        _ => return Err(format!("invalid performance engine state code: {}", state_code)),
    };
    let revision_after = read_u32_at(bytes, DOUBLE_BUFFER_OFFSET_REVISION)?;
    if revision_before != revision_after {
        return Err("performanceEngineState revision changed during read".to_string());
    }

    Ok(serde_json::json!({
        "data": state,
        "source": "sharedMemory",
        "revision": revision_after
    }))
}

fn write_common_header(bytes: &mut [u8], layout: &SharedBufferLayout) {
    write_u32(bytes, HEADER_OFFSET_MAGIC, layout.magic);
    write_u32(bytes, HEADER_OFFSET_ABI_VERSION, layout.abi_version);
    write_u32(bytes, HEADER_OFFSET_LAYOUT_ID, layout.layout_id);
    write_u32(bytes, HEADER_OFFSET_TOTAL_BYTES, layout.total_bytes);
    write_u32(bytes, HEADER_OFFSET_HEADER_BYTES, layout.header_bytes);
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
    let end = offset + 4;
    bytes[offset..end].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
    let end = offset + 8;
    bytes[offset..end].copy_from_slice(&value.to_le_bytes());
}

fn write_f64(bytes: &mut [u8], offset: usize, value: f64) {
    let end = offset + 8;
    bytes[offset..end].copy_from_slice(&value.to_le_bytes());
}

fn write_fixed_string(bytes: &mut [u8], offset: usize, width: usize, value: &str) {
    let end = offset + width;
    bytes[offset..end].fill(0);
    let encoded = value.as_bytes();
    let copy_len = encoded.len().min(width.saturating_sub(1));
    bytes[offset..offset + copy_len].copy_from_slice(&encoded[..copy_len]);
}

fn engine_state_to_u32(state: EngineState) -> u32 {
    match state {
        EngineState::Initializing => 0,
        EngineState::Running => 1,
        EngineState::Paused => 2,
        EngineState::Error => 3,
        EngineState::Stopped => 4,
    }
}

fn zero_range(bytes: &mut [u8], offset: usize, len: usize) {
    bytes[offset..offset + len].fill(0);
}

struct EncodedPerformanceLogEntry {
    bytes: Vec<u8>,
}

fn encode_performance_log_entry(instruction: &crate::state::scene::Instruction) -> EncodedPerformanceLogEntry {
    let encoded = serde_json::to_vec(instruction).unwrap_or_else(|_| Vec::new());
    EncodedPerformanceLogEntry { bytes: encoded }
}

fn write_performance_log_record(
    bytes: &mut [u8],
    bank_base: usize,
    index: usize,
    entry: &PerformanceLogEntry,
    encoded: &EncodedPerformanceLogEntry,
    arena_cursor: usize,
) {
    let record_offset = bank_base + PERFORMANCE_LOG_RECORDS_OFFSET + (index * PERFORMANCE_LOG_RECORD_STRIDE_BYTES);
    write_u32(bytes, record_offset + PERFORMANCE_LOG_RECORD_CURSOR_OFFSET, entry.cursor);
    write_u32(
        bytes,
        record_offset + PERFORMANCE_LOG_RECORD_FLAGS_OFFSET,
        if entry.has_context {
            PERFORMANCE_LOG_FLAG_HAS_CONTEXT
        } else {
            0
        },
    );
    write_fixed_string(
        bytes,
        record_offset + PERFORMANCE_LOG_RECORD_SCENE_ID_OFFSET,
        PERFORMANCE_LOG_SCENE_ID_BYTES,
        &entry.scene_id,
    );
    write_fixed_string(
        bytes,
        record_offset + PERFORMANCE_LOG_RECORD_PERFORMANCE_ID_OFFSET,
        PERFORMANCE_LOG_PERFORMANCE_ID_BYTES,
        &entry.performance_id,
    );
    write_fixed_string(
        bytes,
        record_offset + PERFORMANCE_LOG_RECORD_EFFECT_ID_OFFSET,
        PERFORMANCE_LOG_EFFECT_ID_BYTES,
        &entry.effect_id,
    );
    write_fixed_string(
        bytes,
        record_offset + PERFORMANCE_LOG_RECORD_EFFECT_TYPE_OFFSET,
        PERFORMANCE_LOG_EFFECT_TYPE_BYTES,
        &entry.effect_type,
    );

    let arena_offset = bank_base + PERFORMANCE_LOG_ARENA_OFFSET + arena_cursor;
    if !encoded.bytes.is_empty() {
        bytes[arena_offset..arena_offset + encoded.bytes.len()].copy_from_slice(&encoded.bytes);
    }
    write_u32(
        bytes,
        record_offset + PERFORMANCE_LOG_RECORD_PAYLOAD_OFFSET,
        arena_cursor as u32,
    );
    write_u32(
        bytes,
        record_offset + PERFORMANCE_LOG_RECORD_PAYLOAD_OFFSET + 4,
        encoded.bytes.len() as u32,
    );
}

#[allow(clippy::too_many_arguments)] // 固定レイアウトの metadata fields を offset 書き込み順に明示する。
fn write_performance_log_metadata(
    bytes: &mut [u8],
    bank_base: usize,
    head: u32,
    tail: u32,
    entry_count: u32,
    next_cursor: u32,
    dropped_count: u32,
    arena_cursor: usize,
) {
    write_u32(bytes, bank_base + PERFORMANCE_LOG_OFFSET_HEAD, head);
    write_u32(bytes, bank_base + PERFORMANCE_LOG_OFFSET_TAIL, tail);
    write_u32(bytes, bank_base + PERFORMANCE_LOG_OFFSET_ENTRY_COUNT, entry_count);
    write_u32(bytes, bank_base + PERFORMANCE_LOG_OFFSET_NEXT_CURSOR, next_cursor);
    write_u32(bytes, bank_base + PERFORMANCE_LOG_OFFSET_DROPPED_COUNT, dropped_count);
    write_u32(bytes, bank_base + PERFORMANCE_LOG_OFFSET_ARENA_USED_BYTES, arena_cursor as u32);
}

fn write_performance_log_bank_empty(bytes: &mut [u8], bank_base: usize) {
    zero_range(bytes, bank_base, PERFORMANCE_LOG_BUFFER_STRIDE_BYTES);
    write_performance_log_metadata(bytes, bank_base, 0, 0, 0, 1, 0, 0);
}

fn write_performance_log_bank(bytes: &mut [u8], bank_base: usize, log: &PerformanceLog) {
    let mut selected: Vec<(&PerformanceLogEntry, EncodedPerformanceLogEntry)> = Vec::new();
    let mut arena_bytes = 0usize;

    for entry in log.entries().iter().rev() {
        let encoded = encode_performance_log_entry(&entry.instruction);
        if encoded.bytes.len() > PERFORMANCE_LOG_ARENA_BYTES
            || arena_bytes + encoded.bytes.len() > PERFORMANCE_LOG_ARENA_BYTES
        {
            break;
        }
        selected.push((entry, encoded));
        arena_bytes += selected.last().expect("just pushed").1.bytes.len();
    }

    selected.reverse();
    zero_range(bytes, bank_base, PERFORMANCE_LOG_BUFFER_STRIDE_BYTES);

    let mut arena_cursor = 0usize;
    for (index, (entry, encoded)) in selected.iter().enumerate() {
        write_performance_log_record(bytes, bank_base, index, entry, encoded, arena_cursor);
        arena_cursor += encoded.bytes.len();
    }

    let entry_count = selected.len() as u32;
    let tail = if entry_count == PERFORMANCE_LOG_CAPACITY as u32 {
        0
    } else {
        entry_count
    };
    let omitted = log.entries().len().saturating_sub(selected.len()) as u32;
    write_performance_log_metadata(
        bytes,
        bank_base,
        0,
        tail,
        entry_count,
        log.next_cursor(),
        log.dropped_count().wrapping_add(omitted),
        arena_cursor,
    );
}

struct EncodedArenaField {
    offset: usize,
    len: usize,
}

struct EncodedCommentEntry {
    flags: u32,
    member_months: u32,
    gift_count: u32,
    amount: f64,
    id: EncodedArenaField,
    name: EncodedArenaField,
    comment: EncodedArenaField,
    comment_html: EncodedArenaField,
    profile_image: EncodedArenaField,
    timestamp: EncodedArenaField,
    currency: EncodedArenaField,
    sticker_image: EncodedArenaField,
    membership_header: EncodedArenaField,
    bytes: Vec<u8>,
}

fn push_arena_field(bytes: &mut Vec<u8>, value: &str) -> EncodedArenaField {
    let offset = bytes.len();
    bytes.extend_from_slice(value.as_bytes());
    EncodedArenaField {
        offset,
        len: bytes.len() - offset,
    }
}

fn encode_comment_entry(comment: &crate::state::comment::RawComment) -> EncodedCommentEntry {
    let mut arena_bytes = Vec::new();
    let mut flags = 0u32;
    if comment.has_gift {
        flags |= COMMENT_TIMELINE_FLAG_HAS_GIFT;
    }
    if comment.is_member {
        flags |= COMMENT_TIMELINE_FLAG_IS_MEMBER;
    }
    if comment.is_membership {
        flags |= COMMENT_TIMELINE_FLAG_IS_MEMBERSHIP;
    }
    if comment.is_membership_gift {
        flags |= COMMENT_TIMELINE_FLAG_IS_MEMBERSHIP_GIFT;
    }

    let id = push_arena_field(&mut arena_bytes, &comment.id);
    let name = push_arena_field(&mut arena_bytes, &comment.name);
    let text = push_arena_field(&mut arena_bytes, &comment.comment);
    let comment_html = push_arena_field(&mut arena_bytes, &comment.comment_html);
    let profile_image = push_arena_field(&mut arena_bytes, &comment.profile_image);
    let timestamp = push_arena_field(&mut arena_bytes, &comment.timestamp);
    let currency = push_arena_field(&mut arena_bytes, &comment.currency);
    let sticker_image = push_arena_field(&mut arena_bytes, &comment.sticker_image);
    let membership_header = push_arena_field(&mut arena_bytes, &comment.membership_header);

    EncodedCommentEntry {
        flags,
        member_months: comment.member_months,
        gift_count: comment.gift_count,
        amount: comment.amount,
        id,
        name,
        comment: text,
        comment_html,
        profile_image,
        timestamp,
        currency,
        sticker_image,
        membership_header,
        bytes: arena_bytes,
    }
}

fn write_comment_timeline_record(
    bytes: &mut [u8],
    bank_base: usize,
    index: usize,
    entry: &CommentTimelineEntry,
    encoded: &EncodedCommentEntry,
    arena_cursor: usize,
) {
    let record_offset = bank_base + COMMENT_TIMELINE_RECORDS_OFFSET + (index * COMMENT_TIMELINE_RECORD_STRIDE_BYTES);
    write_u32(bytes, record_offset + COMMENT_TIMELINE_RECORD_CURSOR_OFFSET, entry.cursor);
    write_u32(bytes, record_offset + COMMENT_TIMELINE_RECORD_FLAGS_OFFSET, encoded.flags);
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_MEMBER_MONTHS_OFFSET,
        encoded.member_months,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_GIFT_COUNT_OFFSET,
        encoded.gift_count,
    );
    write_f64(bytes, record_offset + COMMENT_TIMELINE_RECORD_AMOUNT_OFFSET, encoded.amount);

    let arena_offset = bank_base + COMMENT_TIMELINE_ARENA_OFFSET + arena_cursor;
    if !encoded.bytes.is_empty() {
        bytes[arena_offset..arena_offset + encoded.bytes.len()].copy_from_slice(&encoded.bytes);
    }

    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_ID_OFFSET,
        (arena_cursor + encoded.id.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_ID_OFFSET + 4,
        encoded.id.len as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_NAME_OFFSET,
        (arena_cursor + encoded.name.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_NAME_OFFSET + 4,
        encoded.name.len as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_COMMENT_OFFSET,
        (arena_cursor + encoded.comment.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_COMMENT_OFFSET + 4,
        encoded.comment.len as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_COMMENT_HTML_OFFSET,
        (arena_cursor + encoded.comment_html.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_COMMENT_HTML_OFFSET + 4,
        encoded.comment_html.len as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_PROFILE_IMAGE_OFFSET,
        (arena_cursor + encoded.profile_image.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_PROFILE_IMAGE_OFFSET + 4,
        encoded.profile_image.len as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_TIMESTAMP_OFFSET,
        (arena_cursor + encoded.timestamp.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_TIMESTAMP_OFFSET + 4,
        encoded.timestamp.len as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_CURRENCY_OFFSET,
        (arena_cursor + encoded.currency.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_CURRENCY_OFFSET + 4,
        encoded.currency.len as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_STICKER_IMAGE_OFFSET,
        (arena_cursor + encoded.sticker_image.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_STICKER_IMAGE_OFFSET + 4,
        encoded.sticker_image.len as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_MEMBERSHIP_HEADER_OFFSET,
        (arena_cursor + encoded.membership_header.offset) as u32,
    );
    write_u32(
        bytes,
        record_offset + COMMENT_TIMELINE_RECORD_MEMBERSHIP_HEADER_OFFSET + 4,
        encoded.membership_header.len as u32,
    );
}

#[allow(clippy::too_many_arguments)] // 固定レイアウトの metadata fields を offset 書き込み順に明示する。
fn write_comment_timeline_metadata(
    bytes: &mut [u8],
    bank_base: usize,
    head: u32,
    tail: u32,
    entry_count: u32,
    next_cursor: u32,
    dropped_count: u32,
    arena_cursor: usize,
) {
    write_u32(bytes, bank_base + COMMENT_TIMELINE_OFFSET_HEAD, head);
    write_u32(bytes, bank_base + COMMENT_TIMELINE_OFFSET_TAIL, tail);
    write_u32(bytes, bank_base + COMMENT_TIMELINE_OFFSET_ENTRY_COUNT, entry_count);
    write_u32(bytes, bank_base + COMMENT_TIMELINE_OFFSET_NEXT_CURSOR, next_cursor);
    write_u32(bytes, bank_base + COMMENT_TIMELINE_OFFSET_DROPPED_COUNT, dropped_count);
    write_u32(bytes, bank_base + COMMENT_TIMELINE_OFFSET_ARENA_USED_BYTES, arena_cursor as u32);
}

fn write_comment_timeline_bank_empty(bytes: &mut [u8], bank_base: usize) {
    zero_range(bytes, bank_base, COMMENT_TIMELINE_BUFFER_STRIDE_BYTES);
    write_comment_timeline_metadata(bytes, bank_base, 0, 0, 0, 1, 0, 0);
}

fn write_comment_timeline_bank(bytes: &mut [u8], bank_base: usize, timeline: &CommentTimeline) {
    let mut selected: Vec<(&CommentTimelineEntry, EncodedCommentEntry)> = Vec::new();
    let mut arena_bytes = 0usize;

    for entry in timeline.entries().iter().rev() {
        let encoded = encode_comment_entry(&entry.comment);
        if encoded.bytes.len() > COMMENT_TIMELINE_ARENA_BYTES
            || arena_bytes + encoded.bytes.len() > COMMENT_TIMELINE_ARENA_BYTES
        {
            break;
        }
        selected.push((entry, encoded));
        arena_bytes += selected.last().expect("just pushed").1.bytes.len();
    }

    selected.reverse();
    zero_range(bytes, bank_base, COMMENT_TIMELINE_BUFFER_STRIDE_BYTES);

    let mut arena_cursor = 0usize;
    for (index, (entry, encoded)) in selected.iter().enumerate() {
        write_comment_timeline_record(bytes, bank_base, index, entry, encoded, arena_cursor);
        arena_cursor += encoded.bytes.len();
    }

    let entry_count = selected.len() as u32;
    let tail = if entry_count == COMMENT_TIMELINE_CAPACITY as u32 {
        0
    } else {
        entry_count
    };
    let omitted = timeline.entries().len().saturating_sub(selected.len()) as u32;
    write_comment_timeline_metadata(
        bytes,
        bank_base,
        0,
        tail,
        entry_count,
        timeline.next_cursor(),
        timeline.dropped_count().wrapping_add(omitted),
        arena_cursor,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::comment::{CommentTimeline, RawComment};
    use crate::state::connection::ConnectionState;
    use crate::state::performance_log::PerformanceLog;
    use crate::state::scene::{Instruction, InstructionEffect};
    use std::collections::HashMap;

    fn make_instruction(scene_id: &str, performance_id: &str, effect_id: &str) -> Instruction {
        Instruction {
            scene_id: scene_id.to_string(),
            performance_id: performance_id.to_string(),
            effect: InstructionEffect {
                id: effect_id.to_string(),
                effect_type: "firework".to_string(),
                params: None,
            },
            assets: Vec::new(),
            sounds: Vec::new(),
            context: None,
            extra: HashMap::new(),
        }
    }

    fn make_comment(id: &str, name: &str, text: &str) -> RawComment {
        RawComment {
            id: id.to_string(),
            user_id: String::new(),
            live_id: String::new(),
            name: name.to_string(),
            display_name: String::new(),
            screen_name: String::new(),
            nickname: String::new(),
            comment: text.to_string(),
            comment_html: format!("<b>{}</b>", text),
            speech_text: String::new(),
            profile_image: "https://example.com/avatar.png".to_string(),
            original_profile_image: "https://example.com/avatar.png".to_string(),
            timestamp: "12:34".to_string(),
            has_gift: true,
            amount: 1200.5,
            currency: "JPY".to_string(),
            amount_display: "¥1,201".to_string(),
            sticker_image: "https://example.com/sticker.png".to_string(),
            tier_color: "#ffb300".to_string(),
            superchat_tier: "yellow".to_string(),
            is_member: true,
            member_months: 6,
            is_membership: true,
            membership_header: "Welcome".to_string(),
            is_membership_gift: false,
            is_membership_gift_redemption: false,
            is_membership_milestone: false,
            gift_count: 3,
            member_badge_url: "https://example.com/badge.png".to_string(),
            is_moderator: false,
            is_owner: false,
            is_verified: false,
            is_first_time: false,
            is_repeater: false,
            listener_status: String::new(),
            listener_tag: String::new(),
            has_prior_listener_comment: false,
            is_first_comment_in_stream: false,
            listener_previous_stream_last_seen_at: String::new(),
            listener_previous_stream_last_seen_at_ms: 0,
            listener_previous_comment_at: String::new(),
            listener_previous_comment_at_ms: 0,
            listener_current_stream_comment_count: 0,
            listener_current_stream_superchat_amount_jpy: 0,
            listener_current_stream_superchat_amount_display: String::new(),
            listener_previous_stream_id: String::new(),
            listener_previous_stream_title: String::new(),
            listener_previous_stream_started_at: String::new(),
            listener_previous_stream_started_at_ms: 0,
            listener_regular_stream_count: 0,
            listener_regular_window_streams: 0,
            listener_regular_min_streams: 0,
            is_first_time_listener: false,
            is_returning_listener: false,
            is_regular_listener: false,
            is_regular_arrival: false,
            comment_visible: true,
            auto_moderated: false,
            is_template_test: false,
            is_backfill: false,
            komehub_trace: serde_json::Value::Null,
        }
    }

    #[test]
    fn publishes_reaction_counts_into_inactive_buffer() {
        let mut shared = ReactionCountsSharedBuffer::new();
        shared
            .register_buffer(Buffer::from(vec![0u8; REACTION_TOTAL_BYTES]))
            .expect("buffer registration should succeed");

        let mut counts = ReactionCounts::new();
        counts.increment_by("heart", 3);
        counts.increment_by("surprise", 5);

        shared.publish(&counts);

        let bytes = shared.buffer.as_ref().expect("buffer should exist").as_ref();
        assert_eq!(
            u32::from_le_bytes(
                bytes[REACTION_OFFSET_ACTIVE_BUFFER_INDEX..REACTION_OFFSET_ACTIVE_BUFFER_INDEX + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[REACTION_OFFSET_REVISION..REACTION_OFFSET_REVISION + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u64::from_le_bytes(bytes[REACTION_BUFFER1_OFFSET..REACTION_BUFFER1_OFFSET + 8].try_into().unwrap()),
            3
        );
        assert_eq!(
            u64::from_le_bytes(
                bytes[REACTION_BUFFER1_OFFSET + (3 * REACTION_SLOT_STRIDE_BYTES)
                    ..REACTION_BUFFER1_OFFSET + (4 * REACTION_SLOT_STRIDE_BYTES)]
                    .try_into()
                    .unwrap()
            ),
            5
        );
    }

    #[test]
    fn publishes_performance_log_as_fixed_records() {
        let mut shared = PerformanceLogSharedBuffer::new();
        shared
            .register_buffer(Buffer::from(vec![0u8; PERFORMANCE_LOG_TOTAL_BYTES]))
            .expect("buffer registration should succeed");

        let mut log = PerformanceLog::new(4);
        log.push_instruction(&make_instruction("scene-a", "perf-1", "fx-1"));
        log.push_instruction(&make_instruction("scene-b", "perf-2", "fx-2"));

        let last = log.entries().back().expect("log entry");
        shared.publish_entry(last, &log);

        let bytes = shared.buffer.as_ref().expect("buffer should exist").as_ref();
        assert_eq!(
            u32::from_le_bytes(
                bytes[DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX..DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[DOUBLE_BUFFER_OFFSET_REVISION..DOUBLE_BUFFER_OFFSET_REVISION + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[PERFORMANCE_LOG_BUFFER1_OFFSET + PERFORMANCE_LOG_OFFSET_ENTRY_COUNT
                    ..PERFORMANCE_LOG_BUFFER1_OFFSET + PERFORMANCE_LOG_OFFSET_ENTRY_COUNT + 4]
                    .try_into()
                    .unwrap()
            ),
            2
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[PERFORMANCE_LOG_BUFFER1_OFFSET + PERFORMANCE_LOG_OFFSET_NEXT_CURSOR
                    ..PERFORMANCE_LOG_BUFFER1_OFFSET + PERFORMANCE_LOG_OFFSET_NEXT_CURSOR + 4]
                    .try_into()
                    .unwrap()
            ),
            3
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[PERFORMANCE_LOG_BUFFER1_OFFSET + PERFORMANCE_LOG_RECORDS_OFFSET
                    ..PERFORMANCE_LOG_BUFFER1_OFFSET + PERFORMANCE_LOG_RECORDS_OFFSET + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        let scene_slice = &bytes[PERFORMANCE_LOG_BUFFER1_OFFSET
            + PERFORMANCE_LOG_RECORDS_OFFSET
            + PERFORMANCE_LOG_RECORD_SCENE_ID_OFFSET
            ..PERFORMANCE_LOG_BUFFER1_OFFSET
                + PERFORMANCE_LOG_RECORDS_OFFSET
                + PERFORMANCE_LOG_RECORD_SCENE_ID_OFFSET
                + 7];
        assert_eq!(scene_slice, b"scene-a");
    }

    #[test]
    fn publishes_comment_timeline_with_arena_backed_strings() {
        let mut shared = CommentTimelineSharedBuffer::new();
        shared
            .register_buffer(Buffer::from(vec![0u8; COMMENT_TIMELINE_TOTAL_BYTES]))
            .expect("buffer registration should succeed");

        let mut timeline = CommentTimeline::new(4);
        timeline.push(make_comment("comment-1", "alice", "hello"));

        let last = timeline.entries().back().expect("timeline entry");
        shared.publish_entry(last, &timeline);

        let bytes = shared.buffer.as_ref().expect("buffer should exist").as_ref();
        assert_eq!(
            u32::from_le_bytes(
                bytes[DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX..DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[COMMENT_TIMELINE_BUFFER1_OFFSET + COMMENT_TIMELINE_OFFSET_ENTRY_COUNT
                    ..COMMENT_TIMELINE_BUFFER1_OFFSET + COMMENT_TIMELINE_OFFSET_ENTRY_COUNT + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[COMMENT_TIMELINE_BUFFER1_OFFSET + COMMENT_TIMELINE_RECORDS_OFFSET
                    ..COMMENT_TIMELINE_BUFFER1_OFFSET + COMMENT_TIMELINE_RECORDS_OFFSET + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        let id_offset = u32::from_le_bytes(
            bytes[COMMENT_TIMELINE_BUFFER1_OFFSET
                + COMMENT_TIMELINE_RECORDS_OFFSET
                + COMMENT_TIMELINE_RECORD_ID_OFFSET
                ..COMMENT_TIMELINE_BUFFER1_OFFSET
                    + COMMENT_TIMELINE_RECORDS_OFFSET
                    + COMMENT_TIMELINE_RECORD_ID_OFFSET
                    + 4]
                .try_into()
                .unwrap(),
        ) as usize;
        let id_length = u32::from_le_bytes(
            bytes[COMMENT_TIMELINE_BUFFER1_OFFSET
                + COMMENT_TIMELINE_RECORDS_OFFSET
                + COMMENT_TIMELINE_RECORD_ID_OFFSET
                + 4
                ..COMMENT_TIMELINE_BUFFER1_OFFSET
                    + COMMENT_TIMELINE_RECORDS_OFFSET
                    + COMMENT_TIMELINE_RECORD_ID_OFFSET
                    + 8]
                .try_into()
                .unwrap(),
        ) as usize;
        assert_eq!(
            &bytes[COMMENT_TIMELINE_BUFFER1_OFFSET + COMMENT_TIMELINE_ARENA_OFFSET + id_offset
                ..COMMENT_TIMELINE_BUFFER1_OFFSET
                    + COMMENT_TIMELINE_ARENA_OFFSET
                    + id_offset
                    + id_length],
            b"comment-1"
        );
    }

    #[test]
    fn publishes_connection_state_as_fixed_snapshot() {
        let mut shared = ConnectionSharedBuffer::new();
        shared
            .register_buffer(Buffer::from(vec![0u8; CONNECTION_TOTAL_BYTES]))
            .expect("buffer registration should succeed");

        shared.publish(&ConnectionState {
            connected: true,
            video_id: Some("video-123".to_string()),
            current_stream_owner_channel_id: Some("UCabc".to_string()),
            is_own_stream: true,
        });

        let bytes = shared.buffer.as_ref().expect("buffer should exist").as_ref();
        assert_eq!(
            u32::from_le_bytes(
                bytes[DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX..DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[CONNECTION_BUFFER1_OFFSET + CONNECTION_OFFSET_CONNECTED
                    ..CONNECTION_BUFFER1_OFFSET + CONNECTION_OFFSET_CONNECTED + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[CONNECTION_BUFFER1_OFFSET + CONNECTION_OFFSET_IS_OWN_STREAM
                    ..CONNECTION_BUFFER1_OFFSET + CONNECTION_OFFSET_IS_OWN_STREAM + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[DOUBLE_BUFFER_OFFSET_REVISION..DOUBLE_BUFFER_OFFSET_REVISION + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            &bytes[CONNECTION_BUFFER1_OFFSET + CONNECTION_VIDEO_ID_OFFSET
                ..CONNECTION_BUFFER1_OFFSET + CONNECTION_VIDEO_ID_OFFSET + 9],
            b"video-123"
        );
        assert_eq!(
            &bytes[CONNECTION_BUFFER1_OFFSET + CONNECTION_OWNER_CHANNEL_ID_OFFSET
                ..CONNECTION_BUFFER1_OFFSET + CONNECTION_OWNER_CHANNEL_ID_OFFSET + 5],
            b"UCabc"
        );
    }

    #[test]
    fn publishes_performance_engine_state_as_fixed_snapshot() {
        let mut shared = PerformanceEngineStateSharedBuffer::new();
        shared
            .register_buffer(Buffer::from(vec![0u8; PERFORMANCE_ENGINE_STATE_TOTAL_BYTES]))
            .expect("buffer registration should succeed");

        shared.publish(EngineState::Paused);

        let bytes = shared.buffer.as_ref().expect("buffer should exist").as_ref();
        assert_eq!(
            u32::from_le_bytes(
                bytes[DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX..DOUBLE_BUFFER_OFFSET_ACTIVE_BUFFER_INDEX + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[PERFORMANCE_ENGINE_STATE_BUFFER1_OFFSET + PERFORMANCE_ENGINE_STATE_OFFSET_STATE
                    ..PERFORMANCE_ENGINE_STATE_BUFFER1_OFFSET + PERFORMANCE_ENGINE_STATE_OFFSET_STATE + 4]
                    .try_into()
                    .unwrap()
            ),
            2
        );
        assert_eq!(
            u32::from_le_bytes(
                bytes[DOUBLE_BUFFER_OFFSET_REVISION..DOUBLE_BUFFER_OFFSET_REVISION + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
    }
}
