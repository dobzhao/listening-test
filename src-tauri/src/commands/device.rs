//! 设备相关 Tauri commands
//!
//! - `list_input_devices` / `list_output_devices`：列出系统中可用的麦克风/扬声器
//! - `test_input_device`：使用指定设备录制 N 秒音频并保存为 wav，返回路径
//! - `test_output_device`：使用指定输出设备播放 440Hz 测试音（基于 rodio）

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat as CpalSampleFormat;
use hound::{SampleFormat as HoundSampleFormat, WavSpec, WavWriter};
use rodio::source::SineWave;
use rodio::{OutputStream, Sink, Source};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tracing::{debug, error, info};

#[derive(Debug, Serialize, Clone)]
pub struct DeviceInfo {
    /// cpal 原始设备名，同时是 `find_input_device` / `find_output_device` 的查找键
    pub name: String,
    pub is_default: bool,
    /// 界面展示用的友好名称
    pub display_name: String,
    /// false 表示该项只是 ALSA 插件噪音，前端默认折叠
    pub recommended: bool,
}

fn find_input_device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(target_name) = name {
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if let Ok(n) = d.name() {
                    if n == target_name {
                        return Ok(d);
                    }
                }
            }
        }
        return Err(format!("找不到输入设备: {target_name}"));
    }
    host.default_input_device()
        .ok_or_else(|| "系统没有可用的默认输入设备".to_string())
}

fn find_output_device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(target_name) = name {
        if let Ok(devices) = host.output_devices() {
            for d in devices {
                if let Ok(n) = d.name() {
                    if n == target_name {
                        return Ok(d);
                    }
                }
            }
        }
        return Err(format!("找不到输出设备: {target_name}"));
    }
    host.default_output_device()
        .ok_or_else(|| "系统没有可用的默认输出设备".to_string())
}

/// 从 ALSA hint 名中解析 `(CARD, DEV)`，例如 `sysdefault:CARD=Intel,DEV=0` → `("Intel", 0)`。
/// DEV 缺省视作 0。非 ALSA 名（Windows / macOS 的真实设备名）返回 `None`。
fn parse_card_dev(name: &str) -> Option<(&str, u32)> {
    let card = name
        .split("CARD=")
        .nth(1)?
        .split([',', ':'])
        .next()
        .filter(|s| !s.is_empty())?;
    let dev = name
        .split("DEV=")
        .nth(1)
        .and_then(|s| s.split([',', ':']).next())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    Some((card, dev))
}

/// 生成界面展示用的友好名称。cpal 0.15 的 ALSA 后端只读 hint 的 `NAME` 字段、
/// 从不读 `DESC`，所以拿不到「HDA Intel, Generic Analog」这类描述，只能从
/// `CARD=` token 推导。
fn display_name_for(name: &str) -> String {
    match name {
        "default" => return "系统默认".to_string(),
        "pipewire" => return "PipeWire 音频服务".to_string(),
        "pulse" => return "PulseAudio 音频服务".to_string(),
        _ => {}
    }
    match parse_card_dev(name) {
        // DEV≠0 时带上编号，避免同一张声卡的多个口重名
        Some((card, 0)) => card.replace('_', " "),
        Some((card, dev)) => format!("{} (设备 {dev})", card.replace('_', " ")),
        None => name.to_string(),
    }
}

/// ALSA hint 前缀在同一 `(CARD, DEV)` 分组内的优先级，数字越小越优先。
/// 返回 `None` 表示该前缀是纯路由插件（surround* / dmix / iec958 / spdif 等），
/// 永远不参与竞选。
///
/// `hw:` 排最后：它拒绝任何格式与采样率转换，cpal 请求非原生参数时会直接打开失败。
#[cfg(target_os = "linux")]
fn card_plugin_rank(name: &str) -> Option<u8> {
    match name.split(':').next().unwrap_or("") {
        "sysdefault" => Some(0),
        "plughw" => Some(1),
        "front" => Some(2),
        "dsnoop" => Some(3),
        "hw" => Some(4),
        _ => None,
    }
}

/// Linux：ALSA 枚举的是 PCM hint 名而非物理设备，同一块声卡会被
/// sysdefault / plughw / hw / front / surround* / dmix … 十余个入口重复暴露，
/// 需要按声卡去重。
#[cfg(target_os = "linux")]
fn mark_recommended(devices: &mut [DeviceInfo]) {
    use std::collections::HashMap;

    // 顶层名（无 CARD=）只保留 `default`。cpal 的 ALSA 后端把默认设备名硬编码为
    // "default"（见 cpal/src/host/alsa/enumerate.rs），过滤掉它会连带干掉前端的
    // 「默认」badge 与自动选中。pipewire / pulse 实践中与 default 是同一条链路，折叠。
    for d in devices.iter_mut() {
        if d.name == "default" {
            d.recommended = true;
        }
    }

    // 其余按 (CARD, DEV) 分组，每组只留一个代表。分组键必须带上 DEV：
    // Intel HDA 会把模拟口(DEV=0)与 HDMI 口(DEV=3/7/8)挂在同一张 CARD 下，
    // 只按 CARD 分组会误合并掉 HDMI 这个真实可选输出。
    let mut winners: HashMap<(String, u32), (u8, usize)> = HashMap::new();
    for (idx, d) in devices.iter().enumerate() {
        let Some((card, dev)) = parse_card_dev(&d.name) else {
            continue;
        };
        let Some(rank) = card_plugin_rank(&d.name) else {
            continue;
        };
        let key = (card.to_string(), dev);
        let better = match winners.get(&key) {
            Some(&(best, _)) => rank < best,
            None => true,
        };
        if better {
            winners.insert(key, (rank, idx));
        }
    }
    for (_, idx) in winners.into_values() {
        devices[idx].recommended = true;
    }
}

/// Windows(WASAPI) / macOS(CoreAudio) 返回的本就是真实设备列表，无需过滤。
#[cfg(not(target_os = "linux"))]
fn mark_recommended(devices: &mut [DeviceInfo]) {
    for d in devices.iter_mut() {
        d.recommended = true;
    }
}

/// 标记 `recommended`，并保证列表非空时至少有一项被推荐。
fn apply_recommendation(devices: &mut [DeviceInfo], kind: &str) {
    mark_recommended(devices);

    // 兜底：若规则把所有条目都判掉，退回全部展示 —— 空列表比不过滤更糟。
    if !devices.is_empty() && devices.iter().all(|d| !d.recommended) {
        tracing::warn!(
            kind,
            total = devices.len(),
            "设备过滤规则未匹配到任何条目，回退为展示全部"
        );
        for d in devices.iter_mut() {
            d.recommended = true;
        }
    }
}

/// 把 cpal 设备迭代器收集为 `DeviceInfo` 列表，并标记 `recommended`。
fn collect_devices<I>(iter: I, default_name: &str, kind: &str) -> Vec<DeviceInfo>
where
    I: Iterator<Item = cpal::Device>,
{
    let mut devices: Vec<DeviceInfo> = iter
        .map(|device| {
            let name = device.name().unwrap_or_else(|_| "<未知设备>".to_string());
            DeviceInfo {
                is_default: name == default_name,
                display_name: display_name_for(&name),
                recommended: false,
                name,
            }
        })
        .collect();

    apply_recommendation(&mut devices, kind);

    debug!(
        kind,
        total = devices.len(),
        recommended = devices.iter().filter(|d| d.recommended).count(),
        names = ?devices.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
        "枚举音频设备"
    );
    devices
}

#[tauri::command]
pub fn list_input_devices() -> Result<Vec<DeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();
    match host.input_devices() {
        Ok(iter) => Ok(collect_devices(iter, &default_name, "input")),
        Err(err) => {
            error!(error = ?err, "枚举输入设备失败");
            Ok(Vec::new())
        }
    }
}

#[tauri::command]
pub fn list_output_devices() -> Result<Vec<DeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();
    match host.output_devices() {
        Ok(iter) => Ok(collect_devices(iter, &default_name, "output")),
        Err(err) => {
            error!(error = ?err, "枚举输出设备失败");
            Ok(Vec::new())
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct TestInputArgs {
    pub device_name: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestInputResponse {
    pub output_path: String,
    pub duration_ms: u64,
    pub sample_count: usize,
}

/// 使用指定输入设备录制 N 秒音频并保存为 wav
///
/// 命令本身是 `async`，内部通过 `spawn_blocking` 把阻塞循环放到 tokio 阻塞线程池，
/// 避免 Tauri 主线程 / UI 线程被卡死（否则 Windows 会弹出"程序未响应"对话框）。
#[tauri::command]
pub async fn test_input_device(
    app: AppHandle,
    args: TestInputArgs,
) -> Result<TestInputResponse, String> {
    tauri::async_runtime::spawn_blocking(move || test_input_device_blocking(app, args))
        .await
        .map_err(|e| format!("录音线程被取消或发生 panic: {e}"))?
}

fn test_input_device_blocking(
    app: AppHandle,
    args: TestInputArgs,
) -> Result<TestInputResponse, String> {
    let duration_ms = args.duration_ms.unwrap_or(5000);
    let device = find_input_device(args.device_name.as_deref())?;
    let device_name = device.name().unwrap_or_else(|_| "<未知>".to_string());
    info!(device = %device_name, duration_ms, "测试输入设备：开始录音");

    let config = device
        .default_input_config()
        .map_err(|e| format!("无法获取输入流配置: {e}"))?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let stream_config: cpal::StreamConfig = config.clone().into();

    let stream = match config.sample_format() {
        CpalSampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(data.to_vec());
                },
                |err| error!(error = ?err, "测试输入设备：麦克风流错误"),
                None,
            )
            .map_err(|e| format!("无法构建输入流: {e}"))?,
        CpalSampleFormat::I16 => {
            let tx2 = tx.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let f: Vec<f32> =
                            data.iter().map(|&v| v as f32 / i16::MAX as f32).collect();
                        let _ = tx2.send(f);
                    },
                    |err| error!(error = ?err, "测试输入设备：麦克风流错误"),
                    None,
                )
                .map_err(|e| format!("无法构建输入流: {e}"))?
        }
        CpalSampleFormat::U16 => {
            let tx2 = tx.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let f: Vec<f32> = data
                            .iter()
                            .map(|&v| (v as f32 - 32768.0) / 32768.0)
                            .collect();
                        let _ = tx2.send(f);
                    },
                    |err| error!(error = ?err, "测试输入设备：麦克风流错误"),
                    None,
                )
                .map_err(|e| format!("无法构建输入流: {e}"))?
        }
        other => return Err(format!("不支持的采样格式: {other:?}")),
    };

    stream.play().map_err(|e| format!("无法启动输入流: {e}"))?;

    // 在主线程上收集采样，到时长后跳出循环
    let mut samples = Vec::new();
    let collect_start = std::time::Instant::now();
    let target_samples = (sample_rate as u64 * duration_ms / 1000) as usize * channels as usize;
    while collect_start.elapsed() < Duration::from_millis(duration_ms) {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(chunk) => samples.extend(chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // 保险：如果采集到的样本量已超过目标，提前结束
        if samples.len() >= target_samples {
            break;
        }
    }
    drop(stream); // 停止录音

    if samples.is_empty() {
        return Err("录音数据为空（请检查麦克风权限与设备是否被占用）".into());
    }

    // 转 mono
    let mono: Vec<i16> = if channels == 1 {
        samples
            .iter()
            .map(|&v| (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .collect()
    } else {
        let ch = channels as usize;
        samples
            .chunks(ch)
            .map(|c| {
                let avg = c.iter().copied().sum::<f32>() / ch as f32;
                (avg.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
            })
            .collect()
    };

    // 写入 wav 到应用缓存目录
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法解析应用数据目录: {e}"))?;
    let cache_dir = data_dir.join("device-tests");
    std::fs::create_dir_all(&cache_dir).ok();
    let output_path: PathBuf = cache_dir.join(format!(
        "input-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: HoundSampleFormat::Int,
    };
    let mut writer = WavWriter::create(&output_path, spec)
        .map_err(|e| format!("无法创建 wav 文件: {e}"))?;
    for s in &mono {
        writer
            .write_sample(*s)
            .map_err(|e| format!("写入 wav 失败: {e}"))?;
    }
    writer.finalize().map_err(|e| format!("finalize wav 失败: {e}"))?;

    info!(path = ?output_path, samples = mono.len(), "测试输入设备：录音完成");
    Ok(TestInputResponse {
        output_path: output_path.to_string_lossy().to_string(),
        duration_ms,
        sample_count: mono.len(),
    })
}

#[derive(Debug, serde::Deserialize)]
pub struct TestOutputArgs {
    pub device_name: Option<String>,
    pub duration_ms: Option<u64>,
}

/// 使用指定输出设备播放 440Hz 测试音（基于 rodio）
#[tauri::command]
pub fn test_output_device(args: TestOutputArgs) -> Result<String, String> {
    let duration_ms = args.duration_ms.unwrap_or(1500);
    let device = find_output_device(args.device_name.as_deref())?;
    let device_name = device.name().unwrap_or_else(|_| "<未知>".to_string());
    info!(device = %device_name, duration_ms, "测试输出设备：开始播放");

    // rodio 0.19：基于指定 cpal 设备创建 OutputStream
    let (_stream, handle) = OutputStream::try_from_device(&device)
        .map_err(|e| format!("无法打开输出设备 {device_name}: {e}"))?;
    let sink = Sink::try_new(&handle).map_err(|e| format!("无法创建音频 sink: {e}"))?;

    let source = SineWave::new(440.0)
        .take_duration(Duration::from_millis(duration_ms))
        .amplify(0.5);

    sink.append(source);
    sink.sleep_until_end();

    info!("测试输出设备：播放完成");
    Ok(format!(
        "已通过 {device_name} 播放 {duration_ms}ms 440Hz 测试音"
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn build(names: &[&str]) -> Vec<DeviceInfo> {
        names
            .iter()
            .map(|n| DeviceInfo {
                name: (*n).to_string(),
                is_default: *n == "default",
                display_name: display_name_for(n),
                recommended: false,
            })
            .collect()
    }

    fn recommended(names: &[&str]) -> Vec<String> {
        let mut devices = build(names);
        apply_recommendation(&mut devices, "test");
        devices
            .iter()
            .filter(|d| d.recommended)
            .map(|d| d.name.clone())
            .collect()
    }

    #[test]
    fn parses_card_and_dev() {
        assert_eq!(parse_card_dev("sysdefault:CARD=Intel"), Some(("Intel", 0)));
        assert_eq!(parse_card_dev("hw:CARD=Intel,DEV=0"), Some(("Intel", 0)));
        assert_eq!(parse_card_dev("hdmi:CARD=Intel,DEV=3"), Some(("Intel", 3)));
        // 非 ALSA 名（Windows / macOS 真实设备名）不应被误解析
        assert_eq!(parse_card_dev("MacBook Pro Microphone"), None);
        assert_eq!(parse_card_dev("default"), None);
    }

    #[test]
    fn derives_friendly_display_names() {
        assert_eq!(display_name_for("default"), "系统默认");
        assert_eq!(display_name_for("sysdefault:CARD=Intel"), "Intel");
        assert_eq!(display_name_for("front:CARD=USB_Audio,DEV=0"), "USB Audio");
        // DEV≠0 带编号，避免同卡多口重名
        assert_eq!(display_name_for("hdmi:CARD=Intel,DEV=3"), "Intel (设备 3)");
        // 解析不出 CARD 时回退原名
        assert_eq!(display_name_for("Some USB Mic"), "Some USB Mic");
    }

    /// 开发机 `arecord -L` 的真实输入列表：8 项塌缩为 2 项
    #[test]
    fn collapses_real_input_list() {
        let got = recommended(&[
            "pipewire",
            "default",
            "hw:CARD=Intel,DEV=0",
            "plughw:CARD=Intel,DEV=0",
            "sysdefault:CARD=Intel",
            "front:CARD=Intel,DEV=0",
            "dsnoop:CARD=Intel,DEV=0",
        ]);
        assert_eq!(got, vec!["default", "sysdefault:CARD=Intel"]);
    }

    /// 开发机 `aplay -L` 的真实输出列表：surround*/dmix 全部折叠
    #[test]
    fn collapses_real_output_list() {
        let got = recommended(&[
            "pipewire",
            "default",
            "hw:CARD=Intel,DEV=0",
            "plughw:CARD=Intel,DEV=0",
            "sysdefault:CARD=Intel",
            "front:CARD=Intel,DEV=0",
            "surround21:CARD=Intel,DEV=0",
            "surround40:CARD=Intel,DEV=0",
            "surround51:CARD=Intel,DEV=0",
            "surround71:CARD=Intel,DEV=0",
            "dmix:CARD=Intel,DEV=0",
        ]);
        assert_eq!(got, vec!["default", "sysdefault:CARD=Intel"]);
    }

    /// 同一张 CARD 下的不同 DEV（模拟口 vs HDMI）必须各留一项，不能被合并
    #[test]
    fn keeps_distinct_dev_on_same_card() {
        let got = recommended(&[
            "default",
            "sysdefault:CARD=Intel",
            "hw:CARD=Intel,DEV=0",
            "hdmi:CARD=Intel,DEV=3",
            "plughw:CARD=Intel,DEV=3",
        ]);
        assert_eq!(
            got,
            vec!["default", "sysdefault:CARD=Intel", "plughw:CARD=Intel,DEV=3"]
        );
    }

    /// 多张声卡各留一项
    #[test]
    fn keeps_one_entry_per_card() {
        let got = recommended(&[
            "default",
            "sysdefault:CARD=Intel",
            "plughw:CARD=Intel,DEV=0",
            "sysdefault:CARD=Headset",
            "plughw:CARD=Headset,DEV=0",
            "dsnoop:CARD=Headset,DEV=0",
        ]);
        assert_eq!(
            got,
            vec![
                "default",
                "sysdefault:CARD=Intel",
                "sysdefault:CARD=Headset"
            ]
        );
    }

    /// 只有 hw:/plughw: 的声卡（部分 USB 设备）不能被整卡丢弃
    #[test]
    fn falls_back_within_card_when_no_sysdefault() {
        let got = recommended(&["hw:CARD=USB,DEV=0", "plughw:CARD=USB,DEV=0"]);
        assert_eq!(got, vec!["plughw:CARD=USB,DEV=0"]);
    }

    /// 兜底：规则一项都没匹配上时，退回全部展示而不是给出空列表
    #[test]
    fn falls_back_to_all_when_nothing_matches() {
        let got = recommended(&["dmix:CARD=Weird,DEV=0", "surround51:CARD=Weird,DEV=0"]);
        assert_eq!(got, vec!["dmix:CARD=Weird,DEV=0", "surround51:CARD=Weird,DEV=0"]);
    }

    #[test]
    fn empty_list_stays_empty() {
        let mut devices: Vec<DeviceInfo> = Vec::new();
        apply_recommendation(&mut devices, "test");
        assert!(devices.is_empty());
    }
}
