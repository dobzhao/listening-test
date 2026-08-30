// 麦克风与扬声器设备测试：
// - 列出所有输入/输出设备，可单选
// - 输入设备测试：录制 5 秒并保存 wav，前端可播放回放
// - 输出设备测试：通过后端播放 440Hz 测试音

import { useEffect, useState, useRef } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  Mic,
  Volume2,
  Play,
  Square,
  RefreshCw,
} from "lucide-react";
import {
  listInputDevices,
  listOutputDevices,
  testInputDevice,
  testOutputDevice,
  playAudioBackground,
  type DeviceInfo,
} from "@/lib/tauri";

/**
 * 取推荐设备列表。Linux 下后端会把同一块声卡的十余个 ALSA 插件入口折叠成一项，
 * 只有代表项与 `default` 会被标记 recommended。
 * 后端已保证列表非空时至少有一项 recommended，这里的兜底仅作防御。
 */
function recommendedOf(list: DeviceInfo[]): DeviceInfo[] {
  const pool = list.filter((d) => d.recommended);
  return pool.length > 0 ? pool : list;
}

/** 自动选中项：始终从推荐列表里挑，即使用户勾选了「显示全部设备」 */
function pickDefault(list: DeviceInfo[]): DeviceInfo | undefined {
  const pool = recommendedOf(list);
  return pool.find((d) => d.is_default) ?? pool[0];
}

export function MicTest() {
  const [inputs, setInputs] = useState<DeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<DeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>("");
  const [selectedOutput, setSelectedOutput] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 录音测试状态
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [recordedPath, setRecordedPath] = useState<string | null>(null);
  const recordTimerRef = useRef<number | null>(null);

  // 播放测试音状态
  const [testingOutput, setTestingOutput] = useState(false);
  const [testOutputResult, setTestOutputResult] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [inp, out] = await Promise.all([
        listInputDevices(),
        listOutputDevices(),
      ]);
      setInputs(inp);
      setOutputs(out);
      // 默认选中系统默认设备（Linux 下即 ALSA 的 `default`）
      const defIn = pickDefault(inp);
      const defOut = pickDefault(out);
      if (defIn) setSelectedInput(defIn.name);
      if (defOut) setSelectedOutput(defOut.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  // 卸载时清理
  useEffect(() => {
    return () => {
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
      }
    };
  }, []);

  const handleTestInput = async () => {
    if (!selectedInput) {
      setError("请先选择一个输入设备");
      return;
    }
    setRecording(true);
    setRecordProgress(0);
    setRecordedPath(null);
    setError(null);

    // 进度条模拟（实际时长由后端决定）
    const start = Date.now();
    recordTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.min(100, (elapsed / 5000) * 100);
      setRecordProgress(pct);
    }, 50);

    try {
      const resp = await testInputDevice({
        deviceName: selectedInput,
        durationMs: 5000,
      });
      setRecordedPath(resp.outputPath);
    } catch (e) {
      setError(`录音失败: ${e}`);
    } finally {
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setRecording(false);
      setRecordProgress(100);
    }
  };

  const handlePlayRecording = () => {
    if (!recordedPath) return;
    playAudioBackground(recordedPath).catch((e) => {
      console.error("回放录音失败", e);
    });
  };

  const handleTestOutput = async () => {
    if (!selectedOutput) {
      setError("请先选择一个输出设备");
      return;
    }
    setTestingOutput(true);
    setTestOutputResult(null);
    setError(null);
    try {
      const msg = await testOutputDevice({
        deviceName: selectedOutput,
        durationMs: 1500,
      });
      setTestOutputResult(msg);
    } catch (e) {
      setError(`播放失败: ${e}`);
    } finally {
      setTestingOutput(false);
    }
  };

  const visible = (list: DeviceInfo[]) =>
    showAll ? list : recommendedOf(list);
  const visibleInputs = visible(inputs);
  const visibleOutputs = visible(outputs);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Mic className="w-5 h-5" />
            麦克风与扬声器设备测试
          </CardTitle>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="accent-primary"
              />
              显示全部设备
            </label>
            <Button variant="ghost" size="sm" onClick={refresh}>
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-1" />
                  刷新
                </>
              )}
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          选择一个输入设备测试录音，选择一个输出设备测试播放。
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded p-2">
            {error}
          </p>
        )}

        {/* 输入设备 */}
        <div className="space-y-3">
          <p className="text-sm font-medium flex items-center gap-1.5">
            <Mic className="w-4 h-4" /> 输入设备（麦克风）
          </p>
          {visibleInputs.length === 0 ? (
            <p className="text-sm text-muted-foreground">未检测到输入设备</p>
          ) : (
            <div className="space-y-1.5">
              {visibleInputs.map((d) => {
                const checked = selectedInput === d.name;
                return (
                  <label
                    key={d.name}
                    title={d.name}
                    className={`flex items-center justify-between p-2.5 rounded border cursor-pointer transition-colors ${
                      checked
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted/30"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="input-device"
                        value={d.name}
                        checked={checked}
                        onChange={() => setSelectedInput(d.name)}
                        className="accent-primary"
                      />
                      <div className="flex flex-col">
                        <span className="text-sm">{d.display_name}</span>
                        {d.display_name !== d.name && (
                          <span className="text-[11px] text-muted-foreground font-mono">
                            {d.name}
                          </span>
                        )}
                      </div>
                    </div>
                    {d.is_default && <Badge variant="success">默认</Badge>}
                  </label>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              onClick={handleTestInput}
              disabled={recording || !selectedInput}
              size="sm"
            >
              {recording ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  录音中…
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 mr-2" />
                  录音 5 秒
                </>
              )}
            </Button>
            {recordedPath && (
              <Button
                onClick={handlePlayRecording}
                variant="outline"
                size="sm"
              >
                <Play className="w-4 h-4 mr-2" />
                回放录音
              </Button>
            )}
          </div>

          {recording && (
            <Progress value={recordProgress} className="h-1.5" />
          )}

          {recordedPath && !recording && (
            <p className="text-xs text-muted-foreground font-mono break-all">
              录音已保存: {recordedPath}
            </p>
          )}
        </div>

        <div className="border-t" />

        {/* 输出设备 */}
        <div className="space-y-3">
          <p className="text-sm font-medium flex items-center gap-1.5">
            <Volume2 className="w-4 h-4" /> 输出设备（扬声器）
          </p>
          {visibleOutputs.length === 0 ? (
            <p className="text-sm text-muted-foreground">未检测到输出设备</p>
          ) : (
            <div className="space-y-1.5">
              {visibleOutputs.map((d) => {
                const checked = selectedOutput === d.name;
                return (
                  <label
                    key={d.name}
                    title={d.name}
                    className={`flex items-center justify-between p-2.5 rounded border cursor-pointer transition-colors ${
                      checked
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted/30"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="output-device"
                        value={d.name}
                        checked={checked}
                        onChange={() => setSelectedOutput(d.name)}
                        className="accent-primary"
                      />
                      <div className="flex flex-col">
                        <span className="text-sm">{d.display_name}</span>
                        {d.display_name !== d.name && (
                          <span className="text-[11px] text-muted-foreground font-mono">
                            {d.name}
                          </span>
                        )}
                      </div>
                    </div>
                    {d.is_default && <Badge variant="success">默认</Badge>}
                  </label>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              onClick={handleTestOutput}
              disabled={testingOutput || !selectedOutput}
              size="sm"
            >
              {testingOutput ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  播放中…
                </>
              ) : (
                <>
                  <Volume2 className="w-4 h-4 mr-2" />
                  播放测试音
                </>
              )}
            </Button>
          </div>

          {testOutputResult && (
            <p className="text-xs text-muted-foreground">{testOutputResult}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
