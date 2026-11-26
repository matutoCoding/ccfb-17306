import type { Project, RunRecord, SimulationOptions } from '../domain/types';
import { CoupledEngine, type CoupledCheckpoint, type CoupledRunResult } from './coupled';

export interface RunTaskHandle {
  engine: CoupledEngine;
  record: RunRecord;
  checkpoint?: CoupledCheckpoint;
}

export function buildRunRecord(
  project: Project,
  options: SimulationOptions,
  schemeId: string,
  result: CoupledRunResult,
  startedAt = Date.now()
): RunRecord {
  const { engine } = result;
  return {
    id: `run-${schemeId}-${startedAt}`,
    projectId: project.id,
    schemeId,
    startedAt,
    options,
    ledger: result.ledger,
    spots: engine.buildFloodSpots(),
    maxDepthM: Math.max(...engine.maxDepth),
    elapsedMs: result.elapsedMs,
    engineInfo: options.engine === 'webgpu'
      ? 'WebGPU WGSL 二维有限体积 + TypeScript 一维动力波（当前编排使用 CPU 耦合参考核）'
      : 'TypeScript CPU 参考核：Rusanov 有限体积 + Preissmann 窄缝动力波',
    frameCount: result.frames.length,
    frames: result.frames,
    hydrographs: engine.hydrographs
  };
}

export async function runSimulationTask(
  project: Project,
  options: SimulationOptions,
  schemeId: string,
  onProgress?: (pct: number, message: string) => void,
  yieldEvery = 20,
  checkpointMin?: number
): Promise<RunTaskHandle> {
  const engine = new CoupledEngine(project, options, schemeId);
  const endSec = options.durationMin * 60;
  const dt = options.couplingDtSec ?? 2;
  const startedAt = Date.now();
  const t0 = performance.now();

  engine.frames.push(engine.takeFrame());
  engine.nextRecordSec = engine.recordIntervalSec;
  let count = 0;
  let checkpoint: CoupledCheckpoint | undefined;
  while (engine.timeSec < endSec - 1e-6) {
    const h = Math.min(dt, endSec - engine.timeSec);
    engine.step(h);
    if (checkpointMin !== undefined && !checkpoint && engine.timeSec >= checkpointMin * 60) {
      checkpoint = engine.createCheckpoint();
    }
    count++;
    if (count % yieldEvery === 0) {
      onProgress?.(engine.timeSec / endSec, `正在耦合推演：${(engine.timeSec / 60).toFixed(1)} / ${options.durationMin} min`);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  if (engine.frames[engine.frames.length - 1]?.tSec < endSec - 1) engine.frames.push(engine.takeFrame());
  onProgress?.(1, '正在统计易涝点与水量平衡');
  const ledger = engine.buildLedger();
  const result: CoupledRunResult = {
    frames: engine.frames,
    ledger,
    maxDepth: engine.maxDepth,
    maxTimeSec: engine.maxTimeSec,
    exceedDurationSec: engine.exceedDurationSec,
    lastExceedSec: engine.lastExceedSec,
    rainEndSec: engine.rainEndSec,
    elapsedMs: performance.now() - t0,
    engine
  };
  const record = buildRunRecord(project, options, schemeId, result, startedAt);
  return { engine, record, checkpoint };
}
