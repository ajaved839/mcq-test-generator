/**
 * Staff names are always shown and recorded with a "Dr." prefix. Any title the user typed is
 * stripped first so "dr sara", "Dr. Sara" and "Sara" all become "Dr. Sara".
 */

export const NAME_PREFIX = 'Dr.';

/** The name without a leading Dr / Dr. title. */
export function stripPrefix(name: string): string {
  return name
    .trim()
    .replace(/^dr(\.\s*|\s+|$)/i, '')
    .trim();
}

/** "Dr. <name>", or '' when nothing is left after removing the title. */
export function withPrefix(name: string): string {
  const bare = stripPrefix(name);
  return bare ? `${NAME_PREFIX} ${bare}` : '';
}
