/** "Projectile motion (setup)" and "projectile motions" are the same star. */
export function conceptKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 4 && word.endsWith('s') && !/(ss|is|us)$/.test(word) ? word.slice(0, -1) : word))
    .join('-');
}

export function conceptLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim() || label.trim();
}
