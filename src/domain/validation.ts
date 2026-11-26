import type { NetworkNode, PipeSegment, Project, ValidationIssue } from './types';

export function validateNetwork(nodes: NetworkNode[], pipes: PipeSegment[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const adjacency = new Map<string, Set<string>>();
  const componentPipes = new Map<string, PipeSegment[]>();

  for (const n of nodes) adjacency.set(n.id, new Set());

  for (const p of pipes) {
    if (!nodeById.has(p.fromNodeId)) {
      issues.push({ level: 'error', type: 'invert-mismatch', entityId: p.id, message: `管段 ${p.code} 的上游节点 ${p.fromNodeId} 不存在` });
    }
    if (!nodeById.has(p.toNodeId)) {
      issues.push({ level: 'error', type: 'invert-mismatch', entityId: p.id, message: `管段 ${p.code} 的下游节点 ${p.toNodeId} 不存在` });
    }
    if (nodeById.has(p.fromNodeId) && nodeById.has(p.toNodeId)) {
      adjacency.get(p.fromNodeId)!.add(p.toNodeId);
      adjacency.get(p.toNodeId)!.add(p.fromNodeId);
    }

    const drop = p.upstreamInvert - p.downstreamInvert;
    const slope = drop / Math.max(1, p.length);
    if (drop < -0.05) {
      issues.push({
        level: 'error',
        type: 'reverse-slope',
        entityId: p.id,
        message: `${p.code} 倒坡：上游管底 ${p.upstreamInvert.toFixed(2)}m，下游 ${p.downstreamInvert.toFixed(2)}m，坡度 ${(slope * 1000).toFixed(2)}‰`
      });
    } else if (slope < 0.0008) {
      issues.push({
        level: 'warning',
        type: 'reverse-slope',
        entityId: p.id,
        message: `${p.code} 坡度过缓：${(slope * 1000).toFixed(2)}‰，需关注淤积`
      });
    }

    const d = p.diameter ?? p.height ?? 1;
    if (p.sedimentDepth > d * 0.25) {
      issues.push({
        level: p.sedimentDepth >= d / 3 ? 'error' : 'warning',
        type: 'sediment',
        entityId: p.id,
        message: `${p.code} CCTV 淤积深度 ${p.sedimentDepth.toFixed(2)}m，占管径 ${(p.sedimentDepth / d * 100).toFixed(0)}%，过水断面已直接折减`
      });
    }
    if (p.defectLevel >= 3) {
      issues.push({
        level: p.defectLevel >= 4 ? 'error' : 'warning',
        type: 'defect',
        entityId: p.id,
        message: `${p.code} 结构性缺陷 ${p.defectLevel} 级${p.defectNote ? `：${p.defectNote}` : ''}`
      });
    }

    const upNode = nodeById.get(p.fromNodeId);
    const downNode = nodeById.get(p.toNodeId);
    for (const [node, invert, end] of [[upNode, p.upstreamInvert, '上游'], [downNode, p.downstreamInvert, '下游']] as const) {
      if (node && Number.isFinite(node.invert)) {
        // 检查井小室底允许比管底低 0.1~0.8m 作为沉泥槽；超出范围视为标高对不上
        const diff = invert - node.invert;
        if (diff < -0.05 || diff > 0.9) {
          issues.push({
            level: 'error',
            type: 'invert-mismatch',
            entityId: p.id,
            message: `${p.code} ${end}管底 ${invert.toFixed(2)}m 与 ${node.code} 井底 ${node.invert.toFixed(2)}m 关系异常（差 ${diff.toFixed(2)}m）`
          });
        }
      }
    }
  }

  // 连通分量：没有排口/泵站等外排通道的分量按孤立管段列出
  const visited = new Set<string>();
  for (const n of nodes) {
    if (visited.has(n.id)) continue;
    const stack = [n.id];
    const compNodes: string[] = [];
    visited.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      compNodes.push(id);
      for (const nb of adjacency.get(id) ?? []) {
        if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
      }
    }
    const hasExit = compNodes.some(id => {
      const k = nodeById.get(id)?.kind;
      return k === 'outfall' || k === 'pump';
    });
    if (!hasExit) {
      const ids = new Set(compNodes);
      const ps = pipes.filter(p => ids.has(p.fromNodeId) && ids.has(p.toNodeId));
      for (const p of ps) {
        if (!issues.some(i => i.entityId === p.id && i.type === 'isolated')) {
          issues.push({ level: 'warning', type: 'isolated', entityId: p.id, message: `${p.code} 位于未连接排口/泵站的孤立片区（${compNodes.length} 个节点、${ps.length} 段管）` });
        }
      }
      componentPipes.set(n.id, ps);
    }
  }

  const codes = new Map<string, number>();
  for (const p of pipes) codes.set(p.code, (codes.get(p.code) ?? 0) + 1);
  for (const [code, count] of codes) {
    if (count > 1) issues.push({ level: 'error', type: 'duplicate', entityId: code, message: `管段编号 ${code} 重复 ${count} 次` });
  }

  return issues;
}

export function validationSummary(issues: ValidationIssue[]) {
  return {
    errors: issues.filter(i => i.level === 'error').length,
    warnings: issues.filter(i => i.level === 'warning').length,
    reverse: issues.filter(i => i.type === 'reverse-slope').length,
    mismatch: issues.filter(i => i.type === 'invert-mismatch').length,
    isolated: issues.filter(i => i.type === 'isolated').length
  };
}

export function projectValidation(project: Project): ValidationIssue[] {
  return validateNetwork(project.nodes, project.pipes);
}
