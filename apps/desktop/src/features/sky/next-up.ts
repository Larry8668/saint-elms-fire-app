import type { GraphNode, GraphResponse } from '@sef/shared';

export interface NextUpItem {
  node: GraphNode;
  reason: 'shaky' | 'next';
}

const MAX_SHAKY = 3;
const MAX_TOTAL = 5;

/**
 * What the sky should point at: open misconceptions first, then the next unseen concepts
 * in teaching order — in courses already started, or the first lessons if nothing is lit yet.
 */
export function nextUp(graph: GraphResponse): NextUpItem[] {
  const shaky = graph.nodes.filter((n) => n.kind === 'concept' && n.status === 'shaky').slice(0, MAX_SHAKY);
  const items: NextUpItem[] = shaky.map((node) => ({ node, reason: 'shaky' }));

  const byCourse = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) if (n.kind === 'concept') byCourse.set(n.courseId, [...(byCourse.get(n.courseId) ?? []), n]);

  const inTeachingOrder = (nodes: GraphNode[]) => [...nodes].sort((a, b) => (a.lessonId ?? '').localeCompare(b.lessonId ?? '', undefined, { numeric: true }));
  const courses = [...byCourse.values()].sort((a, b) => a[0]!.semesterNumber - b[0]!.semesterNumber);
  const started = courses.filter((c) => c.some((n) => n.status !== 'unseen'));
  const pool = started.length ? started : courses.filter((c) => c[0]!.semesterNumber === courses[0]?.[0]?.semesterNumber);

  // Round-robin across courses so one course does not crowd out the rest.
  const queues = pool.map((c) => inTeachingOrder(c).filter((n) => n.status === 'unseen'));
  while (items.length < MAX_TOTAL && queues.some((q) => q.length)) {
    for (const q of queues) {
      const node = q.shift();
      if (node && items.length < MAX_TOTAL) items.push({ node, reason: 'next' });
    }
  }
  return items;
}
