#![cfg_attr(not(test), allow(dead_code))]

use std::collections::VecDeque;

use serde::Serialize;

use crate::state::scene::Instruction;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceLogEntry {
    pub cursor: u32,
    pub scene_id: String,
    pub performance_id: String,
    pub effect_id: String,
    pub effect_type: String,
    pub has_context: bool,
    #[serde(skip_serializing)]
    pub instruction: Instruction,
}

impl PerformanceLogEntry {
    pub fn from_instruction(cursor: u32, instruction: &Instruction) -> Self {
        Self {
            cursor,
            scene_id: instruction.scene_id.clone(),
            performance_id: instruction.performance_id.clone(),
            effect_id: instruction.effect.id.clone(),
            effect_type: instruction.effect.effect_type.clone(),
            has_context: instruction.context.is_some(),
            instruction: instruction.clone(),
        }
    }
}

pub struct PerformanceLog {
    entries: VecDeque<PerformanceLogEntry>,
    capacity: usize,
    next_cursor: u32,
    dropped_count: u32,
}

impl PerformanceLog {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(capacity),
            capacity,
            next_cursor: 1,
            dropped_count: 0,
        }
    }

    pub fn push_instruction(&mut self, instruction: &Instruction) -> PerformanceLogEntry {
        if self.entries.len() >= self.capacity {
            self.entries.pop_front();
            self.dropped_count = self.dropped_count.wrapping_add(1);
        }

        let entry = PerformanceLogEntry::from_instruction(self.next_cursor, instruction);
        self.next_cursor = self.next_cursor.wrapping_add(1);
        self.entries.push_back(entry.clone());
        entry
    }

    pub fn entries(&self) -> &VecDeque<PerformanceLogEntry> {
        &self.entries
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn next_cursor(&self) -> u32 {
        self.next_cursor
    }

    pub fn dropped_count(&self) -> u32 {
        self.dropped_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::scene::{Instruction, InstructionEffect};
    use std::collections::HashMap;

    fn make_instruction(scene_id: &str, performance_id: &str) -> Instruction {
        Instruction {
            scene_id: scene_id.to_string(),
            performance_id: performance_id.to_string(),
            effect: InstructionEffect {
                id: "fx1".to_string(),
                effect_type: "firework".to_string(),
                params: None,
            },
            assets: Vec::new(),
            sounds: Vec::new(),
            context: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn drops_oldest_entries_when_capacity_is_reached() {
        let mut log = PerformanceLog::new(2);
        log.push_instruction(&make_instruction("scene-a", "perf-1"));
        log.push_instruction(&make_instruction("scene-a", "perf-2"));
        log.push_instruction(&make_instruction("scene-a", "perf-3"));

        assert_eq!(log.len(), 2);
        assert_eq!(log.dropped_count(), 1);
        assert_eq!(log.next_cursor(), 4);
        assert_eq!(log.entries().front().expect("front entry").performance_id, "perf-2");
        assert_eq!(log.entries().back().expect("back entry").performance_id, "perf-3");
    }
}
