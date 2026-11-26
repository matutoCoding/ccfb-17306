import type { Project, RunRecord } from './domain/types';
import { createSampleProject } from './data/sampleProject';
import { ensureSeedProject, projectDb, runDb } from './data/db';

class AppStore {
  project: Project = createSampleProject();
  currentRun: RunRecord | null = null;
  compareRunA: RunRecord | null = null;
  compareRunB: RunRecord | null = null;
  runs: RunRecord[] = [];
  ready = false;
  listeners = new Set<() => void>();

  async init() {
    if (this.ready) return;
    try {
      this.project = await ensureSeedProject(createSampleProject);
      this.runs = await runDb.byProject(this.project.id);
      this.currentRun = this.runs[0] ?? null;
    } catch (e) {
      console.warn('IndexedDB 不可用，使用内存样例', e);
      this.project = createSampleProject();
    } finally {
      this.ready = true;
      this.emit();
    }
  }

  emit() {
    for (const l of this.listeners) l();
  }

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async saveProject(p: Project) {
    this.project = p;
    this.project.updatedAt = Date.now();
    try { await projectDb.put(p); } catch (e) { console.warn(e); }
    this.emit();
  }

  async saveRun(r: RunRecord) {
    this.currentRun = r;
    try {
      await runDb.put(r);
      this.runs = await runDb.byProject(this.project.id);
    } catch (e) {
      console.warn('推演结果无法写入 IndexedDB（可能空间不足），本次会话仍可回放', e);
      this.runs = [r, ...this.runs];
    }
    this.emit();
  }
}

export const store = new AppStore();
