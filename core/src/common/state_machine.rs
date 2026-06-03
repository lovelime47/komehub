#![cfg_attr(not(test), allow(dead_code))]

//! StateMachine — EWM BaseBusinessState<StateType> の Rust 移植。
//!
//! スタックベースの一時状態管理と、クロージャによる遷移先評価を提供する。
//! Model Queue の単一スレッド上で動作する前提のため、ロックは不要。
//!
//! ## pop-then-call パターン
//!
//! C# では `Action` が `this.state` を直接変更できるが、Rust では
//! `&mut self` をキャプチャしたクロージャを `self` 内に格納できない。
//!
//! 解法: `pop_state()` で `Vec::pop()` → CallFrame がスタックから移動し
//! `self` から離れる。移動後のコールバックに `&mut self` を安全に渡せる。

use std::fmt;

/// コールバック型: pop 時に StateMachine を受け取って状態を操作する。
/// Send 境界は tokio::spawn で Model Queue を動かすために必要。
type StateCallback<S> = Box<dyn FnOnce(&mut StateMachine<S>) + Send>;

/// 一時状態からの復帰方法。
enum ReturnAction<S: Copy + PartialEq + fmt::Debug> {
    /// 固定の状態に戻る。
    State(S),
    /// コールバックで遷移先を決定する。
    Callback(StateCallback<S>),
}

/// 一時状態からのキャンセル復帰方法。
enum CancelAction<S: Copy + PartialEq + fmt::Debug> {
    /// キャンセル不可。
    None,
    /// 固定の状態に戻る。
    State(S),
    /// コールバックで遷移先を決定する。
    Callback(StateCallback<S>),
}

/// 一時状態コールスタックの1フレーム。
struct CallFrame<S: Copy + PartialEq + fmt::Debug> {
    /// PushState 呼び出し時点の状態。
    caller_state: S,
    /// PopState() 時の復帰方法。
    return_action: ReturnAction<S>,
    /// CancelPopState() 時の復帰方法。
    cancel_action: CancelAction<S>,
}

/// スタックベースの一時状態管理付きステートマシン。
///
/// EWM `BaseBusinessState<StateType>` の Rust 移植。
/// `S` は状態の列挙型（Copy + PartialEq + Debug）。
pub struct StateMachine<S: Copy + PartialEq + fmt::Debug> {
    state: S,
    call_stack: Vec<CallFrame<S>>,
    display_name: &'static str,
}

impl<S: Copy + PartialEq + fmt::Debug> StateMachine<S> {
    /// 初期状態とログ表示名を指定して生成する。
    pub fn new(initial: S, display_name: &'static str) -> Self {
        Self {
            state: initial,
            call_stack: Vec::new(),
            display_name,
        }
    }

    // ========== 状態アクセス ==========

    /// 現在の状態を返す。
    pub fn state(&self) -> S {
        self.state
    }

    /// 状態を変更する。同じ値への変更は無視される。
    ///
    /// Before/After フックは StateMachine 内部に持たず、
    /// エンジン側でラップメソッドとして実装する。
    pub fn set_state(&mut self, new_state: S) {
        if self.state != new_state {
            tracing::info!(
                "{}変更：{:?}→{:?}",
                self.display_name,
                self.state,
                new_state
            );
            self.state = new_state;
        }
    }

    // ========== PushState バリエーション ==========

    /// 一時状態へ遷移する（遷移先・復帰先ともに固定状態）。
    ///
    /// C#: `PushState(StateType nextState, StateType returnState)`
    pub fn push_state(&mut self, next: S, return_state: S) {
        self.call_stack.push(CallFrame {
            caller_state: self.state,
            return_action: ReturnAction::State(return_state),
            cancel_action: CancelAction::None,
        });
        self.set_state(next);
    }

    /// 一時状態へ遷移する（遷移先は固定状態、復帰はコールバック）。
    ///
    /// C#: `PushState(StateType nextState, Action returnFunction)`
    pub fn push_state_cb(
        &mut self,
        next: S,
        return_cb: impl FnOnce(&mut StateMachine<S>) + Send + 'static,
    ) {
        self.call_stack.push(CallFrame {
            caller_state: self.state,
            return_action: ReturnAction::Callback(Box::new(return_cb)),
            cancel_action: CancelAction::None,
        });
        self.set_state(next);
    }

    /// 一時状態へ遷移する（遷移はコールバック、復帰先は固定状態）。
    ///
    /// C#: `PushState(Action nextFunction, StateType returnState)`
    pub fn push_action(&mut self, next_cb: impl FnOnce(&mut StateMachine<S>), return_state: S) {
        self.call_stack.push(CallFrame {
            caller_state: self.state,
            return_action: ReturnAction::State(return_state),
            cancel_action: CancelAction::None,
        });
        next_cb(self);
    }

    /// 一時状態へ遷移する（遷移・復帰ともにコールバック）。
    ///
    /// C#: `PushState(Action nextFunction, Action returnFunction)`
    pub fn push_action_cb(
        &mut self,
        next_cb: impl FnOnce(&mut StateMachine<S>),
        return_cb: impl FnOnce(&mut StateMachine<S>) + Send + 'static,
    ) {
        self.call_stack.push(CallFrame {
            caller_state: self.state,
            return_action: ReturnAction::Callback(Box::new(return_cb)),
            cancel_action: CancelAction::None,
        });
        next_cb(self);
    }

    /// 一時状態へ遷移する（キャンセル復帰付き、全てコールバック）。
    ///
    /// C#: `PushState(Action nextFunction, Action returnFunction, Action cancelFunction)`
    pub fn push_action_cancelable(
        &mut self,
        next_cb: impl FnOnce(&mut StateMachine<S>),
        return_cb: impl FnOnce(&mut StateMachine<S>) + Send + 'static,
        cancel_cb: impl FnOnce(&mut StateMachine<S>) + Send + 'static,
    ) {
        self.call_stack.push(CallFrame {
            caller_state: self.state,
            return_action: ReturnAction::Callback(Box::new(return_cb)),
            cancel_action: CancelAction::Callback(Box::new(cancel_cb)),
        });
        next_cb(self);
    }

    /// 一時状態へ遷移する（キャンセル時は固定状態に戻る）。
    ///
    /// C#: `PushState(Action nextFunction, Action returnFunction, StateType cancelState)`
    pub fn push_action_cancel_state(
        &mut self,
        next_cb: impl FnOnce(&mut StateMachine<S>),
        return_cb: impl FnOnce(&mut StateMachine<S>) + Send + 'static,
        cancel_state: S,
    ) {
        self.call_stack.push(CallFrame {
            caller_state: self.state,
            return_action: ReturnAction::Callback(Box::new(return_cb)),
            cancel_action: CancelAction::State(cancel_state),
        });
        next_cb(self);
    }

    // ========== PopState バリエーション ==========

    /// 一時状態から正常に復帰する。
    ///
    /// C#: `PopState()`
    pub fn pop_state(&mut self) {
        let frame = self
            .call_stack
            .pop()
            .expect("pop_state called with empty call stack");

        // pop() で frame は self から移動済み → コールバックに &mut self を渡せる
        match frame.return_action {
            ReturnAction::State(s) => self.set_state(s),
            ReturnAction::Callback(cb) => cb(self),
        }
    }

    /// 一時状態からキャンセルして復帰する。
    ///
    /// C#: `CancelPopState()`
    pub fn cancel_pop_state(&mut self) {
        let frame = self
            .call_stack
            .pop()
            .expect("cancel_pop_state called with empty call stack");

        match frame.cancel_action {
            CancelAction::None => {
                panic!("cancel_pop_state called on non-cancelable frame");
            }
            CancelAction::State(s) => self.set_state(s),
            CancelAction::Callback(cb) => cb(self),
        }
    }

    /// 一時状態から、push 時の指定を無視して特定の状態に復帰する。
    ///
    /// C#: `PopStateTo(StateType returnState)`
    pub fn pop_state_to(&mut self, return_state: S) {
        self.call_stack
            .pop()
            .expect("pop_state_to called with empty call stack");
        self.set_state(return_state);
    }

    /// 一時状態から、push 時の指定を無視してコールバックで復帰する。
    ///
    /// C#: `PopStateTo(Action returnFunction)`
    pub fn pop_state_to_cb(&mut self, return_cb: impl FnOnce(&mut StateMachine<S>)) {
        self.call_stack
            .pop()
            .expect("pop_state_to_cb called with empty call stack");
        return_cb(self);
    }

    /// 全ての一時状態を破棄して特定の状態に遷移する。
    ///
    /// C#: `ExitTemporalyState(StateType nextState)`
    pub fn exit_temporary_state(&mut self, next: S) {
        self.call_stack.clear();
        self.set_state(next);
    }

    /// 全ての一時状態を破棄してコールバックで遷移する。
    ///
    /// C#: `ExitTemporalyState(Action nextFunction)`
    pub fn exit_temporary_state_cb(&mut self, next_cb: impl FnOnce(&mut StateMachine<S>)) {
        self.call_stack.clear();
        next_cb(self);
    }

    // ========== クエリメソッド ==========

    /// 一時状態にいるかどうか。
    pub fn is_in_temporary_state(&self) -> bool {
        !self.call_stack.is_empty()
    }

    /// コールスタック上の呼び出し元状態一覧（最深→最浅の順）。
    ///
    /// C#: `CallerStack`
    pub fn caller_stack(&self) -> Vec<S> {
        self.call_stack.iter().map(|f| f.caller_state).collect()
    }

    /// 直前の呼び出し元状態（スタック最上位）。
    ///
    /// C#: `PreviousState`
    pub fn previous_state(&self) -> Option<S> {
        self.call_stack.last().map(|f| f.caller_state)
    }

    /// スタック最上位の復帰先が特定の状態かどうか。
    /// 復帰先がコールバックの場合は false。
    ///
    /// C#: `ReturnStateIs(state)`
    pub fn return_state_is(&self, state: S) -> bool {
        match self.call_stack.last() {
            Some(frame) => matches!(&frame.return_action, ReturnAction::State(s) if *s == state),
            None => false,
        }
    }

    /// 現在の状態またはコールスタック上の呼び出し元に指定の状態が含まれるか。
    ///
    /// C#: `StateContains(state)`
    pub fn state_contains(&self, state: S) -> bool {
        self.state == state || self.call_stack.iter().any(|f| f.caller_state == state)
    }

    /// 現在の状態またはコールスタック上に、指定のいずれかの状態が含まれるか。
    ///
    /// C#: `StateContains(IEnumerable<StateType>)`
    pub fn state_contains_any(&self, states: &[S]) -> bool {
        states.iter().any(|s| self.state_contains(*s))
    }
}

// ========== テスト ==========

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TestState {
        Idle,
        Running,
        Paused,
        TempA,
        TempB,
        Error,
    }

    fn make_sm() -> StateMachine<TestState> {
        StateMachine::new(TestState::Idle, "テスト")
    }

    #[test]
    fn initial_state() {
        let sm = make_sm();
        assert_eq!(sm.state(), TestState::Idle);
        assert!(!sm.is_in_temporary_state());
    }

    #[test]
    fn set_state_changes() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);
        assert_eq!(sm.state(), TestState::Running);
    }

    #[test]
    fn set_state_same_is_noop() {
        let mut sm = make_sm();
        sm.set_state(TestState::Idle); // same as initial
        assert_eq!(sm.state(), TestState::Idle);
    }

    // --- PushState / PopState ---

    #[test]
    fn push_pop_state_values() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);
        sm.push_state(TestState::Paused, TestState::Running);

        assert_eq!(sm.state(), TestState::Paused);
        assert!(sm.is_in_temporary_state());
        assert_eq!(sm.previous_state(), Some(TestState::Running));

        sm.pop_state();
        assert_eq!(sm.state(), TestState::Running);
        assert!(!sm.is_in_temporary_state());
    }

    #[test]
    fn push_state_cb_returns_via_callback() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);

        let captured = TestState::Running;
        sm.push_state_cb(TestState::TempA, move |sm| {
            sm.set_state(captured);
        });

        assert_eq!(sm.state(), TestState::TempA);
        sm.pop_state();
        assert_eq!(sm.state(), TestState::Running);
    }

    #[test]
    fn push_action_executes_next_immediately() {
        let mut sm = make_sm();
        sm.push_action(
            |sm| sm.set_state(TestState::TempA),
            TestState::Idle,
        );

        assert_eq!(sm.state(), TestState::TempA);
        sm.pop_state();
        assert_eq!(sm.state(), TestState::Idle);
    }

    #[test]
    fn push_action_cb_both_closures() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);

        let return_to = TestState::Running;
        sm.push_action_cb(
            |sm| sm.set_state(TestState::TempA),
            move |sm| sm.set_state(return_to),
        );

        assert_eq!(sm.state(), TestState::TempA);
        sm.pop_state();
        assert_eq!(sm.state(), TestState::Running);
    }

    // --- Cancel ---

    #[test]
    fn push_cancelable_cancel_callback() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);

        sm.push_action_cancelable(
            |sm| sm.set_state(TestState::TempA),
            |sm| sm.set_state(TestState::Running),
            |sm| sm.set_state(TestState::Error),
        );

        assert_eq!(sm.state(), TestState::TempA);
        sm.cancel_pop_state();
        assert_eq!(sm.state(), TestState::Error);
    }

    #[test]
    fn push_cancel_state() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);

        sm.push_action_cancel_state(
            |sm| sm.set_state(TestState::TempA),
            |sm| sm.set_state(TestState::Running),
            TestState::Idle,
        );

        assert_eq!(sm.state(), TestState::TempA);
        sm.cancel_pop_state();
        assert_eq!(sm.state(), TestState::Idle);
    }

    #[test]
    #[should_panic(expected = "cancel_pop_state called on non-cancelable frame")]
    fn cancel_non_cancelable_panics() {
        let mut sm = make_sm();
        sm.push_state(TestState::TempA, TestState::Idle);
        sm.cancel_pop_state();
    }

    // --- PopStateTo ---

    #[test]
    fn pop_state_to_overrides_return() {
        let mut sm = make_sm();
        sm.push_state(TestState::TempA, TestState::Idle);
        sm.pop_state_to(TestState::Running); // override
        assert_eq!(sm.state(), TestState::Running);
    }

    #[test]
    fn pop_state_to_cb_overrides_return() {
        let mut sm = make_sm();
        sm.push_state(TestState::TempA, TestState::Idle);
        sm.pop_state_to_cb(|sm| sm.set_state(TestState::Error));
        assert_eq!(sm.state(), TestState::Error);
    }

    // --- ExitTemporaryState ---

    #[test]
    fn exit_temporary_state_clears_stack() {
        let mut sm = make_sm();
        sm.push_state(TestState::TempA, TestState::Idle);
        sm.push_state(TestState::TempB, TestState::TempA);

        assert_eq!(sm.call_stack.len(), 2);

        sm.exit_temporary_state(TestState::Running);
        assert_eq!(sm.state(), TestState::Running);
        assert!(!sm.is_in_temporary_state());
    }

    #[test]
    fn exit_temporary_state_cb_clears_stack() {
        let mut sm = make_sm();
        sm.push_state(TestState::TempA, TestState::Idle);
        sm.push_state(TestState::TempB, TestState::TempA);

        sm.exit_temporary_state_cb(|sm| sm.set_state(TestState::Error));
        assert_eq!(sm.state(), TestState::Error);
        assert!(!sm.is_in_temporary_state());
    }

    // --- ネスト ---

    #[test]
    fn nested_temporary_states() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);

        // 1段目: Running → TempA
        sm.push_state(TestState::TempA, TestState::Running);
        // 2段目: TempA → TempB
        sm.push_state(TestState::TempB, TestState::TempA);

        assert_eq!(sm.state(), TestState::TempB);
        assert_eq!(sm.caller_stack(), vec![TestState::Running, TestState::TempA]);
        assert_eq!(sm.previous_state(), Some(TestState::TempA));

        // 2段目復帰
        sm.pop_state();
        assert_eq!(sm.state(), TestState::TempA);

        // 1段目復帰
        sm.pop_state();
        assert_eq!(sm.state(), TestState::Running);
        assert!(!sm.is_in_temporary_state());
    }

    // --- クエリ ---

    #[test]
    fn return_state_is() {
        let mut sm = make_sm();
        sm.push_state(TestState::TempA, TestState::Running);

        assert!(sm.return_state_is(TestState::Running));
        assert!(!sm.return_state_is(TestState::Idle));
    }

    #[test]
    fn return_state_is_false_for_callback() {
        let mut sm = make_sm();
        sm.push_state_cb(TestState::TempA, |sm| sm.set_state(TestState::Running));

        assert!(!sm.return_state_is(TestState::Running));
    }

    #[test]
    fn state_contains() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);
        sm.push_state(TestState::TempA, TestState::Running);

        assert!(sm.state_contains(TestState::TempA)); // current
        assert!(sm.state_contains(TestState::Running)); // caller
        assert!(!sm.state_contains(TestState::Idle));
    }

    #[test]
    fn state_contains_any() {
        let mut sm = make_sm();
        sm.set_state(TestState::Running);
        sm.push_state(TestState::TempA, TestState::Running);

        assert!(sm.state_contains_any(&[TestState::Idle, TestState::Running]));
        assert!(!sm.state_contains_any(&[TestState::Idle, TestState::Error]));
    }

    // --- C# パターン翻訳テスト ---

    #[test]
    fn ewm_call_pattern_translation() {
        // C#: PushState(() => { this.state = TempA; }, () => { this.state = callbackState; });
        let mut sm = make_sm();
        sm.set_state(TestState::Running);

        let callback_state = sm.state();
        sm.push_action_cb(
            |sm| sm.set_state(TestState::TempA),
            move |sm| sm.set_state(callback_state),
        );

        assert_eq!(sm.state(), TestState::TempA);
        sm.pop_state();
        assert_eq!(sm.state(), TestState::Running);
    }
}
