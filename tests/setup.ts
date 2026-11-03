// UI tests opt into jsdom per file with `// @vitest-environment jsdom`.
if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}
