import type { ContentKind } from './models.ts';

export function contentId(providerId: string, kind: ContentKind | 'category', sourceId: string | number): string {
  return `${providerId}:${kind}:${sourceId}`;
}

export interface ParsedId {
  providerId: string;
  kind: ContentKind | 'category';
  sourceId: string;
}

export function parseContentId(id: string): ParsedId | null {
  const first = id.indexOf(':');
  const second = id.indexOf(':', first + 1);
  if (first <= 0 || second <= first) return null;
  const kind = id.slice(first + 1, second) as ParsedId['kind'];
  if (!['live', 'movie', 'series', 'episode', 'category'].includes(kind)) return null;
  return { providerId: id.slice(0, first), kind, sourceId: id.slice(second + 1) };
}
