import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useState, useMemo, useCallback } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Types ────────────────────────────────────────────────────────────

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  cost: number;
}

interface StepTimestamps {
  llm_call_start?: string;
  llm_call_end?: string;
  execution_start?: string;
  execution_end?: string;
}

interface LogEntry {
  level: number;
  time: string;
  run_id: string;
  parent_run_id?: string;
  depth: number;
  step?: number;
  event_type: "execution_result" | "code_generated" | "final_result" | "agent_start" | "agent_end";
  code?: string;
  output?: string;
  hasError?: boolean;
  reasoning?: string;
  usage?: Usage;
  result?: unknown;
  timestamps?: StepTimestamps;
}

interface RunTree {
  run_id: string;
  parent_run_id?: string;
  depth: number;
  steps: LogEntry[];
  children: RunTree[];
  finalResult?: unknown;
  agentStartTime?: string;
  agentEndTime?: string;
}

// ── Log Parsing ──────────────────────────────────────────────────────

function parseLogFile(content: string): { rootRuns: RunTree[]; runs: Map<string, RunTree>; hasTimestamps: boolean } {
  const lines = content.trim().split("\n");
  const entries: LogEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // skip malformed lines
    }
  }

  const runs = new Map<string, RunTree>();
  let hasTimestamps = false;

  for (const entry of entries) {
    if (!runs.has(entry.run_id)) {
      runs.set(entry.run_id, {
        run_id: entry.run_id,
        parent_run_id: entry.parent_run_id,
        depth: entry.depth,
        steps: [],
        children: [],
      });
    }
    const run = runs.get(entry.run_id)!;
    // Backfill parent_run_id if the first entry lacked it (e.g. final_result
    // entries written before step entries due to async pino buffering)
    if (!run.parent_run_id && entry.parent_run_id) {
      run.parent_run_id = entry.parent_run_id;
    }
    if (entry.event_type === "agent_start") {
      run.agentStartTime = entry.time;
      hasTimestamps = true;
    } else if (entry.event_type === "agent_end") {
      run.agentEndTime = entry.time;
    } else if (entry.event_type === "final_result") {
      run.finalResult = entry.result;
    } else {
      run.steps.push(entry);
      if (entry.timestamps) hasTimestamps = true;
    }
  }

  const rootRuns: RunTree[] = [];
  for (const run of runs.values()) {
    if (run.parent_run_id) {
      const parent = runs.get(run.parent_run_id);
      if (parent) {
        parent.children.push(run);
      } else {
        rootRuns.push(run);
      }
    } else {
      rootRuns.push(run);
    }
  }

  for (const run of runs.values()) {
    run.steps.sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  }

  return { rootRuns, runs, hasTimestamps };
}

// ── Helpers ──────────────────────────────────────────────────────────

function shortId(id: string): string {
  const parts = id.split("-");
  return parts.length > 1 ? parts[1]!.slice(0, 6) : id.slice(0, 6);
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > width) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    lines.push(remaining);
  }
  return lines;
}

// Find which children of a run were spawned near which step
function getChildrenAtStep(run: RunTree, stepIndex: number): RunTree[] {
  if (run.children.length === 0) return [];
  // Each step is logged AFTER its code runs (including any subagent calls).
  // So subagents spawned during step[i] finish and log themselves BEFORE
  // step[i]'s own log entry, meaning their timestamps fall in
  // [step[i-1].time, step[i].time). Show them after step[i].
  const stepTime = run.steps[stepIndex]?.time;
  const prevStepTime = stepIndex > 0 ? run.steps[stepIndex - 1]?.time : undefined;
  if (!stepTime) return [];

  return run.children.filter((child) => {
    const childTime = child.steps[0]?.time;
    if (!childTime) return false;
    if (prevStepTime) {
      return childTime >= prevStepTime && childTime < stepTime;
    }
    // Step 0: show any child that started before step 0 (edge case)
    return childTime < stepTime;
  });
}

// Get total usage for a run (last step's usage or sum)
function getRunTotalUsage(run: RunTree): Usage {
  const zero: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, cost: 0 };
  return run.steps.reduce((acc, s) => {
    const u = s.usage;
    if (!u) return acc;
    return {
      prompt_tokens: acc.prompt_tokens + u.prompt_tokens,
      completion_tokens: acc.completion_tokens + u.completion_tokens,
      total_tokens: acc.total_tokens + u.total_tokens,
      cached_tokens: acc.cached_tokens + u.cached_tokens,
      reasoning_tokens: acc.reasoning_tokens + u.reasoning_tokens,
      cost: acc.cost + u.cost,
    };
  }, zero);
}

// Get the root final result
function getRootFinalResult(rootRuns: RunTree[]): unknown {
  for (const r of rootRuns) {
    if (r.finalResult !== undefined) return r.finalResult;
  }
  return undefined;
}

// ── Timeline Data ────────────────────────────────────────────────────

interface StepPhases {
  llmStart?: number;
  llmEnd?: number;
  execStart?: number;
  execEnd?: number;
}

interface TimelineAgent {
  run_id: string;
  shortId: string;
  depth: number;
  parentRunId?: string;
  startTime: number;
  endTime: number;
  numSteps: number;
  isLastChild: boolean;
  stepPhases: StepPhases[];
}

interface TimelineData {
  agents: TimelineAgent[];
  globalStart: number;
  globalEnd: number;
}

function buildTimelineData(runs: Map<string, RunTree>, rootRuns: RunTree[]): TimelineData {
  const agents: TimelineAgent[] = [];

  function getRunTimeRange(run: RunTree): { start: number; end: number } | null {
    // Prefer agent_start/agent_end timestamps when available
    const agentStart = run.agentStartTime ? new Date(run.agentStartTime).getTime() : null;
    const agentEnd = run.agentEndTime ? new Date(run.agentEndTime).getTime() : null;

    // Gather all known timestamps from steps for fallback/bounds
    const stepTimes: number[] = [];
    for (const s of run.steps) {
      stepTimes.push(new Date(s.time).getTime());
      if (s.timestamps?.llm_call_start) stepTimes.push(new Date(s.timestamps.llm_call_start).getTime());
      if (s.timestamps?.execution_end) stepTimes.push(new Date(s.timestamps.execution_end).getTime());
    }

    if (stepTimes.length === 0 && agentStart === null) return null;

    const start = agentStart ?? (stepTimes.length > 0 ? Math.min(...stepTimes) : 0);
    const end = agentEnd ?? (stepTimes.length > 0 ? Math.max(...stepTimes) : start);

    return { start, end };
  }

  function walk(run: RunTree, isLastChild: boolean) {
    const range = getRunTimeRange(run);
    if (!range) return;

    // Build per-step phases with detailed timestamps
    const stepPhases: StepPhases[] = [];
    for (let i = 0; i < run.steps.length; i++) {
      const step = run.steps[i]!;
      const ts = step.timestamps;

      if (ts) {
        stepPhases.push({
          llmStart: ts.llm_call_start ? new Date(ts.llm_call_start).getTime() : undefined,
          llmEnd: ts.llm_call_end ? new Date(ts.llm_call_end).getTime() : undefined,
          execStart: ts.execution_start ? new Date(ts.execution_start).getTime() : undefined,
          execEnd: ts.execution_end ? new Date(ts.execution_end).getTime() : undefined,
        });
      } else {
        // Legacy fallback: treat entire step as a single block
        const stepStart = i > 0
          ? new Date(run.steps[i - 1]!.time).getTime()
          : range.start;
        const stepEnd = new Date(step.time).getTime();
        stepPhases.push({ llmStart: stepStart, execEnd: stepEnd });
      }
    }

    agents.push({
      run_id: run.run_id,
      shortId: shortId(run.run_id),
      depth: run.depth,
      parentRunId: run.parent_run_id,
      startTime: range.start,
      endTime: range.end,
      numSteps: run.steps.length,
      isLastChild,
      stepPhases,
    });

    // Sort children by start time
    const sortedChildren = [...run.children].sort((a, b) => {
      const aRange = getRunTimeRange(a);
      const bRange = getRunTimeRange(b);
      return (aRange?.start ?? 0) - (bRange?.start ?? 0);
    });

    for (let i = 0; i < sortedChildren.length; i++) {
      walk(sortedChildren[i]!, i === sortedChildren.length - 1);
    }
  }

  for (let i = 0; i < rootRuns.length; i++) {
    walk(rootRuns[i]!, i === rootRuns.length - 1);
  }

  let globalStart = Infinity;
  let globalEnd = -Infinity;
  for (const a of agents) {
    if (a.startTime < globalStart) globalStart = a.startTime;
    if (a.endTime > globalEnd) globalEnd = a.endTime;
  }

  if (!isFinite(globalStart)) {
    globalStart = 0;
    globalEnd = 0;
  }

  return { agents, globalStart, globalEnd };
}

// ── Tree Item type for left panel ────────────────────────────────────

interface TreeItem {
  type: "run-header" | "step" | "collapsed-children";
  run: RunTree;
  stepIndex?: number;
  indent: number;
  children?: RunTree[];
}

function buildTreeItems(
  rootRuns: RunTree[],
  activeRunId: string,
  expandedRuns: Set<string>,
): TreeItem[] {
  const items: TreeItem[] = [];

  function walk(run: RunTree, indent: number) {
    const isExpanded = expandedRuns.has(run.run_id);

    items.push({ type: "run-header", run, indent });

    if (isExpanded) {
      for (let i = 0; i < run.steps.length; i++) {
        items.push({ type: "step", run, stepIndex: i, indent: indent + 2 });
        // Show children spawned at this step
        const childrenHere = getChildrenAtStep(run, i);
        for (const child of childrenHere) {
          if (expandedRuns.has(child.run_id)) {
            walk(child, indent + 4);
          } else {
            items.push({ type: "collapsed-children", run: child, indent: indent + 4, children: [child] });
          }
        }
      }
      // Children that don't map to any specific step
      const mappedChildren = new Set<string>();
      for (let i = 0; i < run.steps.length; i++) {
        for (const c of getChildrenAtStep(run, i)) {
          mappedChildren.add(c.run_id);
        }
      }
      const unmapped = run.children.filter((c) => !mappedChildren.has(c.run_id));
      for (const child of unmapped) {
        if (expandedRuns.has(child.run_id)) {
          walk(child, indent + 4);
        } else {
          items.push({ type: "collapsed-children", run: child, indent: indent + 4, children: [child] });
        }
      }
    } else if (run.run_id !== activeRunId && run.children.length > 0) {
      // Show collapsed indicator
      items.push({
        type: "collapsed-children",
        run,
        indent: indent + 2,
        children: run.children,
      });
    }
  }

  for (const root of rootRuns) {
    walk(root, 0);
  }

  return items;
}

// ── Components ───────────────────────────────────────────────────────

function LeftPanel({
  treeItems,
  cursorIndex,
  activeRunId,
  activeStepIndex,
  height,
  width,
}: {
  treeItems: TreeItem[];
  cursorIndex: number;
  activeRunId: string;
  activeStepIndex: number;
  height: number;
  width: number;
}) {
  // Calculate visible window
  const visibleCount = Math.max(1, height - 2); // account for borders
  const scrollOffset = Math.max(0, Math.min(cursorIndex - Math.floor(visibleCount / 2), treeItems.length - visibleCount));
  const visibleItems = treeItems.slice(scrollOffset, scrollOffset + visibleCount);

  return (
    <box
      border
      borderStyle="rounded"
      borderColor="#555555"
      title="  Runs  "
      titleAlignment="center"
      flexDirection="column"
      width={width}
      height={height}
    >
      {visibleItems.map((item, vi) => {
        const globalIndex = scrollOffset + vi;
        const isCursor = globalIndex === cursorIndex;
        const pad = " ".repeat(item.indent);

        if (item.type === "run-header") {
          const isActive = item.run.run_id === activeRunId;
          const label = `${pad}${isActive ? "▸" : "▹"} ${shortId(item.run.run_id)} (d${item.run.depth})`;
          return (
            <text key={`rh-${globalIndex}`} fg={isCursor ? "#000000" : isActive ? "#7aa2f7" : "#888888"} bg={isCursor ? "#7aa2f7" : undefined}>
              {truncate(label, width - 4)}
            </text>
          );
        }

        if (item.type === "step") {
          const isActiveStep = item.run.run_id === activeRunId && item.stepIndex === activeStepIndex;
          const hasErr = item.run.steps[item.stepIndex!]?.hasError;
          const icon = isActiveStep ? "[●]" : "[ ]";
          const stepLabel = `${pad}${icon} Step ${item.stepIndex}`;
          let fg = isCursor ? "#000000" : "#cccccc";
          if (hasErr && !isCursor) fg = "#ff5555";
          if (isActiveStep && !isCursor) fg = "#50fa7b";
          return (
            <text key={`st-${globalIndex}`} fg={fg} bg={isCursor ? "#7aa2f7" : undefined}>
              {truncate(stepLabel, width - 4)}
            </text>
          );
        }

        // collapsed-children
        const count = item.children?.length ?? 0;
        const dot = `${pad}  ● ${count} subagent${count !== 1 ? "s" : ""}`;
        return (
          <text key={`cc-${globalIndex}`} fg={isCursor ? "#000000" : "#666666"} bg={isCursor ? "#7aa2f7" : undefined}>
            {truncate(dot, width - 4)}
          </text>
        );
      })}
    </box>
  );
}

function UsageLine({ label, usage, costColor }: { label: string; usage: Usage | undefined; costColor: string }) {
  if (!usage || usage.total_tokens === 0) {
    return (
      <text>
        <span fg="#888888">{label} </span>
        <span fg="#666666">no usage</span>
      </text>
    );
  }
  return (
    <text>
      <span fg="#888888">{label} </span>
      <span fg="#8be9fd">{formatTokens(usage.total_tokens)}</span>
      <span fg="#888888"> tok p:</span>
      <span fg="#e2e2e2">{formatTokens(usage.prompt_tokens)}</span>
      <span fg="#888888"> c:</span>
      <span fg="#e2e2e2">{formatTokens(usage.completion_tokens)}</span>
      <span fg="#888888"> cached:</span>
      <span fg="#e2e2e2">{formatTokens(usage.cached_tokens)}</span>
      <span fg="#888888"> think:</span>
      <span fg="#e2e2e2">{formatTokens(usage.reasoning_tokens)}</span>
      <span fg="#888888"> cost:</span>
      <span fg={costColor}>{formatCost(usage.cost)}</span>
    </text>
  );
}

// ── Python syntax highlighting via React <span> ─────────────────────

interface Token {
  text: string;
  color?: string;
}

const PY_KEYWORDS = new Set([
  "def", "class", "if", "else", "elif", "for", "while", "return", "import",
  "from", "as", "async", "await", "try", "except", "finally", "with", "in",
  "is", "not", "and", "or", "lambda", "yield", "raise", "pass", "break",
  "continue", "del", "global", "nonlocal", "assert",
]);
const PY_BUILTINS = new Set([
  "None", "True", "False", "print", "len", "range", "int", "str", "float",
  "list", "dict", "set", "tuple", "type", "isinstance", "enumerate", "zip",
  "map", "filter", "sorted", "reversed", "open", "hasattr", "getattr",
  "setattr", "repr", "dir", "vars", "sum", "min", "max", "abs", "round",
]);

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < line.length) {
    // Comment
    if (line[i] === "#") {
      tokens.push({ text: line.slice(i), color: "#6272a4" });
      break;
    }

    // Strings (single/double, including triple quotes)
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i]!;
      const triple = line.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const endIdx = line.indexOf(triple, i + 3);
        if (endIdx !== -1) {
          tokens.push({ text: line.slice(i, endIdx + 3), color: "#f1fa8c" });
          i = endIdx + 3;
        } else {
          tokens.push({ text: line.slice(i), color: "#f1fa8c" });
          break;
        }
      } else {
        let j = i + 1;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === "\\") j++;
          j++;
        }
        tokens.push({ text: line.slice(i, j + 1), color: "#f1fa8c" });
        i = j + 1;
      }
      continue;
    }

    // f/r/b string prefix
    if ((line[i] === "f" || line[i] === "r" || line[i] === "b") &&
        (line[i + 1] === '"' || line[i + 1] === "'")) {
      const quote = line[i + 1]!;
      let j = i + 2;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === "\\") j++;
        j++;
      }
      tokens.push({ text: line.slice(i, j + 1), color: "#f1fa8c" });
      i = j + 1;
      continue;
    }

    // Numbers
    if (/\d/.test(line[i]!) && (i === 0 || !/\w/.test(line[i - 1] ?? ""))) {
      let j = i;
      while (j < line.length && /[\d._xXoObBeE]/.test(line[j]!)) j++;
      tokens.push({ text: line.slice(i, j), color: "#bd93f9" });
      i = j;
      continue;
    }

    // Identifiers / keywords
    if (/[a-zA-Z_]/.test(line[i]!)) {
      let j = i;
      while (j < line.length && /\w/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      if (PY_KEYWORDS.has(word)) {
        tokens.push({ text: word, color: "#ff79c6" });
      } else if (PY_BUILTINS.has(word)) {
        tokens.push({ text: word, color: "#8be9fd" });
      } else if (j < line.length && line[j] === "(") {
        tokens.push({ text: word, color: "#50fa7b" });
      } else {
        tokens.push({ text: word });
      }
      i = j;
      continue;
    }

    // Operators / punctuation
    tokens.push({ text: line[i]! });
    i++;
  }

  return tokens;
}

function HighlightedCodeLine({ line }: { line: string }) {
  const tokens = tokenizeLine(line);
  if (tokens.length === 0) return <text> </text>;

  return (
    <text fg="#f8f8f2">
      {tokens.map((tok, i) =>
        tok.color ? (
          <span key={i} fg={tok.color}>{tok.text}</span>
        ) : (
          <span key={i}>{tok.text}</span>
        )
      )}
    </text>
  );
}

function CodeOutputPanel({
  code,
  output,
  codeScroll,
  outputScroll,
  width,
  height,
}: {
  code: string;
  output: string;
  codeScroll: number;
  outputScroll: number;
  width: number;
  height: number;
}) {
  const halfWidth = Math.floor((width - 2) / 2); // -2 for gap
  const visibleLines = Math.max(1, height - 2); // subtract 2 for borders

  const codeLines = wrapText(code || "(no code)", halfWidth - 4);
  const outputLines = wrapText(output || "(no output)", halfWidth - 4);

  const visibleCodeLines = codeLines.slice(codeScroll, codeScroll + visibleLines);
  const visibleOutputLines = outputLines.slice(outputScroll, outputScroll + visibleLines);

  return (
    <box flexDirection="row" gap={1} width={width} height={height}>
      {/* Code panel */}
      <box
        border
        borderStyle="rounded"
        borderColor="#444444"
        title="  Code [H/J]  "
        titleAlignment="center"
        flexDirection="column"
        width={halfWidth}
        height={height}
      >
        {visibleCodeLines.map((line, i) => (
          <HighlightedCodeLine key={`c-${codeScroll + i}`} line={line || " "} />
        ))}
        {visibleCodeLines.length === 0 && <text fg="#666666">(empty)</text>}
        {codeLines.length > visibleLines && (
          <text fg="#555555">
            {" "}↕ {codeScroll + 1}-{Math.min(codeScroll + visibleLines, codeLines.length)}/{codeLines.length}
          </text>
        )}
      </box>

      {/* Output panel */}
      <box
        border
        borderStyle="rounded"
        borderColor="#444444"
        title="  Output [K/L]  "
        titleAlignment="center"
        flexDirection="column"
        width={halfWidth}
        height={height}
      >
        {visibleOutputLines.map((line, i) => (
          <text key={`o-${outputScroll + i}`} fg="#a8e6a3">
            {line || " "}
          </text>
        ))}
        {visibleOutputLines.length === 0 && <text fg="#666666">(empty)</text>}
        {outputLines.length > visibleLines && (
          <text fg="#555555">
            {" "}↕ {outputScroll + 1}-{Math.min(outputScroll + visibleLines, outputLines.length)}/{outputLines.length}
          </text>
        )}
      </box>
    </box>
  );
}

function ScrollableModal({
  content,
  title,
  scroll,
  width,
  height,
  borderColor,
}: {
  content: string;
  title: string;
  scroll: number;
  width: number;
  height: number;
  borderColor: string;
}) {
  const modalW = Math.min(width - 6, 100);
  const modalH = Math.min(height - 4, 40);
  const innerW = modalW - 4;
  const innerH = modalH - 3;

  const lines = wrapText(content || "(empty)", innerW);
  const visible = lines.slice(scroll, scroll + innerH);

  return (
    <box
      position="absolute"
      left={Math.floor((width - modalW) / 2)}
      top={Math.floor((height - modalH) / 2)}
      width={modalW}
      height={modalH}
      border
      borderStyle="double"
      borderColor={borderColor}
      title={title}
      titleAlignment="center"
      backgroundColor="#1a1a2e"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {visible.map((line, i) => (
        <text key={`m-${scroll + i}`} fg="#e2e2e2">
          {line || " "}
        </text>
      ))}
      {lines.length > innerH && (
        <text fg="#555555">
          {" "}↕ {scroll + 1}-{Math.min(scroll + innerH, lines.length)}/{lines.length}
        </text>
      )}
    </box>
  );
}

// ── Timeline View ────────────────────────────────────────────────────

// Bright = execution, Dim = LLM call, label color
const DEPTH_COLORS = ["#7aa2f7", "#50fa7b", "#f1fa8c", "#ff79c6", "#bd93f9", "#8be9fd", "#ffb86c"];
// Dimmer shade for LLM call phase (thinking/waiting for API)
const DEPTH_LLM_COLORS = ["#3d5179", "#287d3d", "#79804e", "#804060", "#5e4a7d", "#456575", "#805c36"];

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m${rem}s`;
}

function TimelineView({
  data,
  vScroll,
  width,
  height,
}: {
  data: TimelineData;
  vScroll: number;
  width: number;
  height: number;
}) {
  const { agents, globalStart, globalEnd } = data;
  const totalDuration = globalEnd - globalStart;

  // Budget: label | bar | suffix — all must fit in width minus border padding
  const innerWidth = width - 2; // border left + right
  const suffixWidth = 22; // " (NN steps, NNmNNs)"
  const labelWidth = Math.min(28, Math.floor(innerWidth * 0.25));
  const chartWidth = Math.max(1, innerWidth - labelWidth - suffixWidth);

  const headerLines = 2; // axis + separator
  const footerLines = 1;
  const availableRows = Math.max(1, height - headerLines - footerLines - 2); // -2 for border

  const visibleAgents = agents.slice(vScroll, vScroll + availableRows);

  // Map time (ms offset from globalStart) to character column [0, chartWidth)
  function timeToChar(ms: number): number {
    if (totalDuration === 0) return 0;
    return Math.round((ms / totalDuration) * (chartWidth - 1));
  }

  // Build time axis header — a few evenly spaced tick labels
  function buildTimeAxis(): string {
    const axis = new Array(chartWidth).fill(" ");
    // Aim for ~5-7 ticks across the width
    const numTicks = Math.max(2, Math.min(7, Math.floor(chartWidth / 12)));
    for (let ti = 0; ti <= numTicks; ti++) {
      const frac = ti / numTicks;
      const charPos = Math.round(frac * (chartWidth - 1));
      const timeMs = frac * totalDuration;
      const label = `+${formatDuration(timeMs)}`;
      for (let c = 0; c < label.length && charPos + c < chartWidth; c++) {
        axis[charPos + c] = label[c]!;
      }
    }
    return axis.join("");
  }

  // Build a bar for an agent — LLM call phases shown as dim shade,
  // execution phases as bright shade, gaps left as empty (black)
  function buildBar(agent: TimelineAgent): { chars: string[]; colors: string[] } {
    const chars = new Array(chartWidth).fill(" ");
    const colors = new Array(chartWidth).fill("");

    const llmColor = DEPTH_COLORS[agent.depth % DEPTH_COLORS.length]!;
    const execColor = DEPTH_LLM_COLORS[agent.depth % DEPTH_LLM_COLORS.length]!;

    function fillRange(fromMs: number, toMs: number, color: string) {
      const c0 = Math.max(0, timeToChar(fromMs - globalStart));
      const c1 = Math.min(chartWidth - 1, timeToChar(toMs - globalStart));
      for (let c = c0; c <= c1; c++) {
        chars[c] = "█";
        colors[c] = color;
      }
    }

    for (const phase of agent.stepPhases) {
      // LLM call phase (dim)
      if (phase.llmStart != null && phase.llmEnd != null) {
        fillRange(phase.llmStart, phase.llmEnd, llmColor);
      }
      // Execution phase (bright)
      if (phase.execStart != null && phase.execEnd != null) {
        fillRange(phase.execStart, phase.execEnd, execColor);
      }
      // Legacy fallback: if only llmStart+execEnd (no split), draw as bright
      if (phase.llmEnd == null && phase.execStart == null && phase.llmStart != null && phase.execEnd != null) {
        fillRange(phase.llmStart, phase.execEnd, execColor);
      }
    }

    // Ensure at least 1 char visible for very short agents
    const startChar = timeToChar(agent.startTime - globalStart);
    if (startChar >= 0 && startChar < chartWidth && chars[startChar] === " ") {
      chars[startChar] = "▪";
      colors[startChar] = execColor;
    }

    return { chars, colors };
  }

  // Build label with tree connectors
  function buildLabel(agent: TimelineAgent): string {
    const indent = agent.depth * 2;
    let prefix = "";
    if (agent.depth > 0) {
      prefix = " ".repeat(Math.max(0, indent - 2));
      prefix += agent.isLastChild ? "└─" : "├─";
    }
    const id = `${agent.shortId} d${agent.depth}`;
    const label = `${prefix}${prefix ? " " : ""}${id}`;
    return truncate(label, labelWidth).padEnd(labelWidth);
  }

  const timeAxis = buildTimeAxis();

  // Detect parallel groups: agents sharing a parent whose time ranges overlap
  const countedParents = new Set<string>();
  let parallelCount = 0;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    if (!a.parentRunId || countedParents.has(a.parentRunId)) continue;
    for (let j = i + 1; j < agents.length; j++) {
      const b = agents[j]!;
      if (
        b.parentRunId === a.parentRunId &&
        a.startTime < b.endTime &&
        b.startTime < a.endTime
      ) {
        parallelCount++;
        countedParents.add(a.parentRunId);
        break;
      }
    }
  }

  return (
    <box
      border
      borderStyle="rounded"
      borderColor="#7aa2f7"
      title="  TIMELINE (T to close, ↑↓ scroll)  "
      titleAlignment="center"
      flexDirection="column"
      width={width}
      height={height}
    >
      {/* Time axis */}
      <text fg="#555555">{" ".repeat(labelWidth)}{timeAxis}</text>
      <text fg="#444444">{" ".repeat(labelWidth)}{"─".repeat(chartWidth)}</text>

      {/* Agent rows */}
      {visibleAgents.map((agent, vi) => {
        const label = buildLabel(agent);
        const { chars, colors } = buildBar(agent);
        const duration = formatDuration(agent.endTime - agent.startTime);
        const suffix = ` (${agent.numSteps}st, ${duration})`;

        return (
          <text key={`tl-${vScroll + vi}`}>
            <span fg={DEPTH_COLORS[agent.depth % DEPTH_COLORS.length]}>{label}</span>
            {chars.map((ch, ci) => (
              <span key={ci} fg={colors[ci]}>{ch}</span>
            ))}
            <span fg="#666666">{truncate(suffix, suffixWidth)}</span>
          </text>
        );
      })}

      {/* Fill empty rows */}
      {visibleAgents.length < availableRows &&
        Array.from({ length: availableRows - visibleAgents.length }, (_, i) => (
          <text key={`empty-${i}`}> </text>
        ))}

      {/* Footer */}
      <text>
        <span fg="#555555">{"  "}</span>
        <span fg={DEPTH_COLORS[0]}>{"██"}</span><span fg="#555555">{" LLM  "}</span>
        <span fg={DEPTH_LLM_COLORS[0]}>{"██"}</span><span fg="#555555">{" Exec  "}</span>
        <span fg="#555555">{"   "}blank=idle | {agents.length} agents | {formatDuration(totalDuration)} total | {parallelCount} parallel group{parallelCount !== 1 ? "s" : ""}</span>
        {agents.length > availableRows && <span fg="#555555"> | rows {vScroll + 1}-{Math.min(vScroll + availableRows, agents.length)}/{agents.length}</span>}
      </text>
    </box>
  );
}

function HelpBar({ width, showTimeline, hasTimestamps }: { width: number; showTimeline?: boolean; hasTimestamps?: boolean }) {
  if (showTimeline) {
    return (
      <box width={width} flexDirection="row" gap={1}>
        <text fg="#888888">
          <span fg="#7aa2f7">↑↓</span>:scroll  <span fg="#7aa2f7">T/Esc</span>:close  <span fg="#7aa2f7">q/^C</span>:quit
        </text>
      </box>
    );
  }
  return (
    <box width={width} flexDirection="row" gap={1}>
      <text fg="#888888">
        <span fg="#7aa2f7">↑↓</span>:steps  <span fg="#7aa2f7">←→</span>:parent/child  <span fg="#7aa2f7">Tab/S-Tab</span>:siblings  <span fg="#7aa2f7">H/J</span>:code  <span fg="#7aa2f7">K/L</span>:output  <span fg="#7aa2f7">R</span>:reasoning  <span fg="#7aa2f7">O</span>:final output  {hasTimestamps && <><span fg="#7aa2f7">T</span>:timeline  </>}<span fg="#7aa2f7">q/^C</span>:quit
      </text>
    </box>
  );
}

function App({ logData }: { logData: { rootRuns: RunTree[]; runs: Map<string, RunTree>; hasTimestamps: boolean } }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const { rootRuns, runs, hasTimestamps } = logData;

  const firstRun = rootRuns[0];
  if (!firstRun) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg="#ff5555">No runs found in log file.</text>
      </box>
    );
  }

  // Navigation state
  const [activeRunId, setActiveRunId] = useState(firstRun.run_id);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [codeScroll, setCodeScroll] = useState(0);
  const [outputScroll, setOutputScroll] = useState(0);
  const [showReasoning, setShowReasoning] = useState(false);
  const [reasoningScroll, setReasoningScroll] = useState(0);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const [fullOutputScroll, setFullOutputScroll] = useState(0);
  const [showTimeline, setShowTimeline] = useState(false);
  const [timelineVScroll, setTimelineVScroll] = useState(0);

  // Timeline data
  const timelineData = useMemo(() => buildTimelineData(runs, rootRuns), [runs, rootRuns]);

  // Track which runs are expanded (active run + its ancestors)
  const expandedRuns = useMemo(() => {
    const expanded = new Set<string>();
    // Always expand the active run
    expanded.add(activeRunId);
    // Expand ancestors
    let current = runs.get(activeRunId);
    while (current?.parent_run_id) {
      expanded.add(current.parent_run_id);
      current = runs.get(current.parent_run_id);
    }
    // Always expand root
    for (const r of rootRuns) {
      expanded.add(r.run_id);
    }
    return expanded;
  }, [activeRunId]);

  // Build tree items for left panel
  const treeItems = useMemo(() => buildTreeItems(rootRuns, activeRunId, expandedRuns), [activeRunId, expandedRuns]);

  // Find cursor position in tree
  const cursorIndex = useMemo(() => {
    return treeItems.findIndex(
      (item) => item.type === "step" && item.run.run_id === activeRunId && item.stepIndex === activeStepIndex,
    );
  }, [treeItems, activeRunId, activeStepIndex]);

  const activeRun = runs.get(activeRunId) ?? firstRun;
  const activeStep = activeRun.steps[activeStepIndex];
  const rootFinalResult = getRootFinalResult(rootRuns);

  // Compute global usage across ALL runs
  const globalUsage = useMemo(() => {
    const zero: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, cost: 0 };
    let total = zero;
    for (const run of runs.values()) {
      const u = getRunTotalUsage(run);
      total = {
        prompt_tokens: total.prompt_tokens + u.prompt_tokens,
        completion_tokens: total.completion_tokens + u.completion_tokens,
        total_tokens: total.total_tokens + u.total_tokens,
        cached_tokens: total.cached_tokens + u.cached_tokens,
        reasoning_tokens: total.reasoning_tokens + u.reasoning_tokens,
        cost: total.cost + u.cost,
      };
    }
    return total;
  }, [runs]);

  // On the last step of a run, append the final result to the output
  const isLastStep = activeStepIndex === activeRun.steps.length - 1;
  const effectiveOutput = useMemo(() => {
    let out = activeStep?.output ?? "";
    if (isLastStep && activeRun.finalResult !== undefined) {
      const resultStr = typeof activeRun.finalResult === "object" ? JSON.stringify(activeRun.finalResult, null, 2) : String(activeRun.finalResult);
      out += `\n\n━━━ FINAL RESULT ━━━\n${resultStr}`;
    }
    return out;
  }, [activeStep, isLastStep, activeRun]);

  const leftPanelWidth = Math.min(30, Math.floor(width * 0.25));
  const rightPanelWidth = width - leftPanelWidth;
  const infoHeight = 6; // 3 content lines + 2 borders + 1 padding
  const helpHeight = 1;
  const mainHeight = height - helpHeight;
  const codeOutputHeight = Math.max(5, mainHeight - infoHeight);

  useKeyboard(
    useCallback(
      (key) => {
        // Quit
        if (key.name === "q" || (key.ctrl && key.name === "c")) {
          if (showTimeline) { setShowTimeline(false); return; }
          if (showReasoning) { setShowReasoning(false); return; }
          if (showFullOutput) { setShowFullOutput(false); return; }
          renderer.destroy();
          return;
        }

        // Esc - close any modal/timeline
        if (key.name === "escape") {
          if (showTimeline) { setShowTimeline(false); return; }
          if (showReasoning) { setShowReasoning(false); return; }
          if (showFullOutput) { setShowFullOutput(false); return; }
        }

        // T - toggle timeline view (only when timestamp data is present)
        if (key.name === "t" && hasTimestamps) {
          setShowTimeline((v) => !v);
          setShowReasoning(false);
          setShowFullOutput(false);
          setTimelineVScroll(0);
          return;
        }

        // Timeline mode: Up/Down vertical scroll only
        if (showTimeline) {
          if (key.name === "up") {
            setTimelineVScroll((s) => Math.max(0, s - 1));
          } else if (key.name === "down") {
            setTimelineVScroll((s) => Math.min(timelineData.agents.length - 1, s + 1));
          }
          return;
        }

        // R - toggle reasoning modal
        if (key.name === "r") {
          if (showReasoning) { setShowReasoning(false); }
          else { setShowReasoning(true); setReasoningScroll(0); setShowFullOutput(false); }
          return;
        }

        // O - toggle final output modal
        if (key.name === "o") {
          const out = activeStep?.output ?? "";
          if (showFullOutput) { setShowFullOutput(false); }
          else { setShowFullOutput(true); setFullOutputScroll(0); setShowReasoning(false); }
          return;
        }

        // When a modal is open, H/J scroll it, block everything else
        if (showReasoning) {
          if (key.name === "h" || key.name === "up") setReasoningScroll((s) => Math.max(0, s - 3));
          else if (key.name === "j" || key.name === "down") setReasoningScroll((s) => s + 3);
          return;
        }
        if (showFullOutput) {
          if (key.name === "h" || key.name === "up") setFullOutputScroll((s) => Math.max(0, s - 3));
          else if (key.name === "j" || key.name === "down") setFullOutputScroll((s) => s + 3);
          return;
        }

        // UP - previous step in current run
        if (key.name === "up") {
          setActiveStepIndex((i) => Math.max(0, i - 1));
          setCodeScroll(0);
          setOutputScroll(0);
          return;
        }

        // DOWN - next step in current run
        if (key.name === "down") {
          setActiveStepIndex((i) => Math.min(activeRun.steps.length - 1, i + 1));
          setCodeScroll(0);
          setOutputScroll(0);
          return;
        }

        // RIGHT - enter first child subagent at/after current step
        if (key.name === "right") {
          for (let s = activeStepIndex; s < activeRun.steps.length; s++) {
            const children = getChildrenAtStep(activeRun, s);
            if (children.length > 0) {
              setActiveRunId(children[0]!.run_id);
              setActiveStepIndex(0);
              setCodeScroll(0);
              setOutputScroll(0);
              return;
            }
          }
          if (activeRun.children.length > 0) {
            setActiveRunId(activeRun.children[0]!.run_id);
            setActiveStepIndex(0);
            setCodeScroll(0);
            setOutputScroll(0);
          }
          return;
        }

        // LEFT - go to parent run
        if (key.name === "left") {
          if (activeRun.parent_run_id) {
            const parent = runs.get(activeRun.parent_run_id);
            if (parent) {
              setActiveRunId(parent.run_id);
              const childFirstTime = activeRun.steps[0]?.time;
              let bestStep = 0;
              if (childFirstTime) {
                for (let i = 0; i < parent.steps.length; i++) {
                  if (parent.steps[i]!.time <= childFirstTime) bestStep = i;
                }
              }
              setActiveStepIndex(bestStep);
              setCodeScroll(0);
              setOutputScroll(0);
            }
          }
          return;
        }

        // TAB - next sibling subagent
        if (key.name === "tab" && !key.shift) {
          if (activeRun.parent_run_id) {
            const parent = runs.get(activeRun.parent_run_id);
            if (parent) {
              const siblingIndex = parent.children.indexOf(activeRun);
              if (siblingIndex >= 0 && siblingIndex < parent.children.length - 1) {
                setActiveRunId(parent.children[siblingIndex + 1]!.run_id);
                setActiveStepIndex(0);
                setCodeScroll(0);
                setOutputScroll(0);
              }
            }
          }
          return;
        }

        // SHIFT+TAB - previous sibling subagent
        if (key.name === "tab" && key.shift) {
          if (activeRun.parent_run_id) {
            const parent = runs.get(activeRun.parent_run_id);
            if (parent) {
              const siblingIndex = parent.children.indexOf(activeRun);
              if (siblingIndex > 0) {
                setActiveRunId(parent.children[siblingIndex - 1]!.run_id);
                setActiveStepIndex(0);
                setCodeScroll(0);
                setOutputScroll(0);
              }
            }
          }
          return;
        }

        // H - scroll code up
        if (key.name === "h") {
          setCodeScroll((s) => Math.max(0, s - 3));
          return;
        }

        // J - scroll code down
        if (key.name === "j") {
          setCodeScroll((s) => s + 3);
          return;
        }

        // K - scroll output up
        if (key.name === "k") {
          setOutputScroll((s) => Math.max(0, s - 3));
          return;
        }

        // L - scroll output down
        if (key.name === "l") {
          setOutputScroll((s) => s + 3);
          return;
        }
      },
      [activeRun, activeStepIndex, runs, showReasoning, showFullOutput, showTimeline, timelineData, hasTimestamps],
    ),
  );

  return (
    <box position="relative" flexDirection="column" width="100%" height="100%">
      {/* Timeline view replaces main content when active */}
      {showTimeline ? (
        <TimelineView
          data={timelineData}
          vScroll={timelineVScroll}
          width={width}
          height={mainHeight}
        />
      ) : (
        /* Main content */
        <box flexDirection="row" width="100%" height={mainHeight}>
          {/* Left Panel - Tree */}
          <LeftPanel
            treeItems={treeItems}
            cursorIndex={cursorIndex}
            activeRunId={activeRunId}
            activeStepIndex={activeStepIndex}
            height={mainHeight}
            width={leftPanelWidth}
          />

          {/* Right Panel */}
          <box flexDirection="column" width={rightPanelWidth} height={mainHeight}>
            {/* Info section - fixed height, clipped */}
            <box
              border
              borderStyle="rounded"
              borderColor="#555555"
              title="  Info  "
              titleAlignment="center"
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              height={infoHeight}
              overflow="hidden"
            >
              <text>
                <span fg="#888888">Result: </span>
                <span fg="#bd93f9">{truncate(rootFinalResult !== undefined ? (typeof rootFinalResult === "object" ? JSON.stringify(rootFinalResult) : String(rootFinalResult)) : "N/A", rightPanelWidth - 14)}</span>
                {activeStep?.hasError && <span fg="#ff5555"> ERROR</span>}
              </text>
              <UsageLine label="Step:" usage={activeStep?.usage} costColor="#f1fa8c" />
              <UsageLine label="Total:" usage={globalUsage} costColor="#50fa7b" />
            </box>

            {/* Code + Output - fills remaining space */}
            <CodeOutputPanel
              code={activeStep?.code ?? ""}
              output={effectiveOutput}
              codeScroll={codeScroll}
              outputScroll={outputScroll}
              width={rightPanelWidth}
              height={codeOutputHeight}
            />
          </box>
        </box>
      )}

      {/* Help bar */}
      <HelpBar width={width} showTimeline={showTimeline} hasTimestamps={hasTimestamps} />

      {/* Reasoning modal */}
      {showReasoning && (
        <ScrollableModal
          content={activeStep?.reasoning ?? "(no reasoning trace)"}
          title="  Reasoning [H/J scroll, Esc/R close]  "
          scroll={reasoningScroll}
          width={width}
          height={height}
          borderColor="#bd93f9"
        />
      )}

      {/* Final output modal */}
      {showFullOutput && (
        <ScrollableModal
          content={rootFinalResult !== undefined ? (typeof rootFinalResult === "object" ? JSON.stringify(rootFinalResult, null, 2) : String(rootFinalResult)) : "(no final result)"}
          title="  Final Output [H/J scroll, Esc/O close]  "
          scroll={fullOutputScroll}
          width={width}
          height={height}
          borderColor="#f1fa8c"
        />
      )}
    </box>
  );
}

// ── Entry Point ──────────────────────────────────────────────────────

const logPath = process.argv[2];

if (!logPath) {
  console.error("Usage: bun run src/index.tsx <path-to-log.jsonl>");
  process.exit(1);
}

const resolvedPath = resolve(logPath);
let fileContent: string;
try {
  fileContent = readFileSync(resolvedPath, "utf-8");
} catch (err) {
  console.error(`Failed to read file: ${resolvedPath}`);
  process.exit(1);
}

const logData = parseLogFile(fileContent);

if (logData.rootRuns.length === 0) {
  console.error("No log entries found in file.");
  process.exit(1);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App logData={logData} />);
