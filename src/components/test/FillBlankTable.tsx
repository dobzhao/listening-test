// 15-18 题挖空表格：把 details 中的 ___NN___ 替换为 input

import { useRef, useEffect } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { SummaryTable } from "@/types/question";
import { useTestFlowStore } from "@/store/testFlow";
import { submitAnswer } from "@/lib/tauri";

interface Props {
  table: SummaryTable;
  enabled: boolean;
}

const BLANK_REGEX = /___(\d{1,2})___/g;

export function FillBlankTable({ table, enabled }: Props) {
  const answers = useTestFlowStore((s) => s.answers);
  const setAnswer = useTestFlowStore((s) => s.setAnswer);

  const handleChange = async (blankId: number, value: string) => {
    setAnswer(blankId, value);
    try {
      await submitAnswer(blankId, value);
    } catch (e) {
      // 不要静默吞错 — 否则后端落库失败时前端看起来"已填"但判分全 0
      console.error("submit_answer 失败", e);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">听力材料总-分结构（填写 15-18 挖空）</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-muted">
                <th className="border px-3 py-2 text-left text-sm font-semibold w-1/3">
                  总述 (Overview)
                </th>
                <th className="border px-3 py-2 text-left text-sm font-semibold">
                  分述 (Details)
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  <td className="border px-3 py-2 align-top text-sm font-medium">
                    {row.overview}
                  </td>
                  <td className="border px-3 py-2 text-sm">
                    <ul className="list-disc list-inside space-y-1">
                      {row.details.map((d, i) => (
                        <li key={i}>
                          <DetailLine
                            line={d}
                            enabled={enabled}
                            answers={answers}
                            onChange={handleChange}
                          />
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          {enabled
            ? "请使用键盘在空格中输入答案，限时 90 秒"
            : ""}
        </p>
      </CardContent>
    </Card>
  );
}

interface DetailProps {
  line: string;
  enabled: boolean;
  answers: Record<number, string | null>;
  onChange: (blankId: number, value: string) => void;
}

function DetailLine({ line, enabled, answers, onChange }: DetailProps) {
  const parts: Array<{ kind: "text" | "blank"; value: string }> = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(BLANK_REGEX.source, "g");
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIdx) {
      parts.push({ kind: "text", value: line.slice(lastIdx, match.index) });
    }
    parts.push({ kind: "blank", value: match[1] });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < line.length) {
    parts.push({ kind: "text", value: line.slice(lastIdx) });
  }

  return (
    <span className="leading-relaxed">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.value}</span>
        ) : (
          <BlankInput
            key={i}
            blankId={Number(p.value)}
            enabled={enabled}
            value={answers[Number(p.value)] ?? ""}
            onChange={onChange}
          />
        )
      )}
    </span>
  );
}

function BlankInput({
  blankId,
  enabled,
  value,
  onChange,
}: {
  blankId: number;
  enabled: boolean;
  value: string;
  onChange: (id: number, v: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (enabled && inputRef.current) {
      // 自动 focus 第一个空（仅启用时）
    }
  }, [enabled]);

  return (
    <span className="inline-flex items-center gap-1 mx-0.5 align-middle">
      <Badge variant="outline" className="font-mono text-xs px-1.5">
        {blankId}
      </Badge>
      <Input
        ref={inputRef}
        value={value}
        disabled={!enabled}
        onChange={(e) => onChange(blankId, e.target.value)}
        className="inline-block w-24 h-7 px-2 py-0 text-xs"
        placeholder="?"
      />
    </span>
  );
}
