import { describe, expect, it } from 'vitest';
import { stripPrefix, withPrefix } from '../../src/shared/names';

describe('Dr. name prefix', () => {
  it('adds the prefix once, whatever the user typed', () => {
    expect(withPrefix('Sara Khan')).toBe('Dr. Sara Khan');
    expect(withPrefix('  dr sara khan ')).toBe('Dr. sara khan');
    expect(withPrefix('Dr. Sara Khan')).toBe('Dr. Sara Khan');
    expect(withPrefix('DR.Sara')).toBe('Dr. Sara');
  });

  it('treats a bare title as empty and keeps names that only start with "dr"', () => {
    expect(withPrefix('Dr.')).toBe('');
    expect(withPrefix('  ')).toBe('');
    expect(stripPrefix('Drew Smith')).toBe('Drew Smith');
  });
});
