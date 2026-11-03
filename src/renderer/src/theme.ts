import { createTheme, type MantineColorsTuple } from '@mantine/core';

/**
 * Calm clinical palette: teal and blue with neutral grays. Shade 7 of each is used for text and
 * filled controls in light mode and meets WCAG 2.1 AA contrast (at least 4.5:1) on white.
 */

const clinical: MantineColorsTuple = [
  '#e7f6f6',
  '#cdeceb',
  '#9ed9d7',
  '#6cc5c2',
  '#43b3b0',
  '#26a19e',
  '#138784',
  '#0b6e6c',
  '#075755',
  '#03413f',
];

const calmBlue: MantineColorsTuple = [
  '#e8f1fb',
  '#cfe1f6',
  '#a0c2ec',
  '#6ea1e2',
  '#4585d9',
  '#2b73d3',
  '#1d62bd',
  '#14529f',
  '#0d4280',
  '#073263',
];

export const theme = createTheme({
  primaryColor: 'clinical',
  primaryShade: { light: 7, dark: 4 },
  autoContrast: true,
  luminanceThreshold: 0.4,
  colors: { clinical, calmBlue },
  fontFamily: "'Inter Variable', 'Segoe UI', system-ui, -apple-system, sans-serif",
  headings: {
    fontFamily: "'Inter Variable', 'Segoe UI', system-ui, sans-serif",
    fontWeight: '650',
  },
  defaultRadius: 'md',
  focusRing: 'always',
  cursorType: 'pointer',
  components: {
    Button: { defaultProps: { radius: 'md' } },
    Paper: { defaultProps: { radius: 'md' } },
    Card: { defaultProps: { radius: 'md', withBorder: true } },
  },
});
