// Word search for the plugin's pickers. Kept free of Obsidian so it can be tested.

/** Items whose text holds every word of the query (any case), in their original order; all of them for an empty query. */
export function filterWords<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((item) => {
    const haystack = text(item).toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
