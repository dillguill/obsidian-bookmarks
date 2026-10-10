// Small helpers for frontmatter values, shared by updates and merges.

/** Null, undefined, "" or a list of only empty values. */
export function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.every(isEmpty));
}

/** Values compared by their full content, so objects and lists compare by value. */
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A value as a list: lists as they are, an empty value as [], anything else wrapped. */
export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : isEmpty(value) ? [] : [value];
}
