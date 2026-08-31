//! 内部服务层
//!
//! 把 LLM/TTS/STT 调用、音频处理、Prompt 渲染、题目生成、测试流程等通用逻辑
//! 封装在 services，Tauri commands 只负责参数解析与权限/事件发射。

pub mod adaptive;
pub mod audio_pipeline;
pub mod audio_player;
pub mod audio_processor;
pub mod http_client;
pub mod llm_service;
pub mod pregen;
pub mod prompt_engine_service;
pub mod question_generator;
pub mod recorder;
pub mod scenario_picker;
pub mod scoring;
pub mod stt_service;
pub mod test_flow;
pub mod test_session;
pub mod timer;
pub mod tts_service;
