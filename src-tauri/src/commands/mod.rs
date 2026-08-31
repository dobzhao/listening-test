//! Tauri commands 模块
//!
//! 前端通过 `invoke('command_name', args)` 调用这里的函数。

pub mod adaptive;
pub mod audio;
pub mod config;
pub mod device;
pub mod llm;
pub mod pregen;
pub mod recorder;
pub mod scoring;
pub mod stt;
pub mod test_flow;
pub mod test_session;
pub mod tts;
