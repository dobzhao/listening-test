//! 数据结构模块：定义所有跨前后端共享的数据类型

pub mod config;
pub mod pregen;
pub mod question;
pub mod result;

pub use config::*;
pub use pregen::*;
pub use question::*;
pub use result::*;
