-- Chat mode: one user's threads inside a space, the messages in each thread,
-- and the canvas stack that thread restores.
--
-- Threads are per user. A turn_status of 'running' means an agent turn is still
-- writing; 'idle' means the next message may start. active_stack_item_id is the
-- canvas tab to reopen.

CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    turn_status TEXT NOT NULL DEFAULT 'idle' CHECK (turn_status IN ('idle', 'running')),
    active_stack_item_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_user_space
    ON chat_threads (user_id, space_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT NOT NULL DEFAULT '[]',
    batch TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
    ON chat_messages (thread_id, created_at ASC);

CREATE TABLE IF NOT EXISTS chat_stack_items (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_stack_thread
    ON chat_stack_items (thread_id, position ASC);
