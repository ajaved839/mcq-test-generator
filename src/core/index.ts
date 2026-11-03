/**
 * Core engine: the UI-independent rules that protect exam integrity. No Electron, Node or DOM
 * imports are allowed here, so the same code can back an iPad app later.
 */
export * from './types';
export * from './richtext';
export * from './rng';
export * from './overlap';
export * from './blueprint';
export * from './generator';
export * from './shuffle';
export * from './duplicates';
export * from './mcq-parser';
export * from './tabular';
export * from './capacity';
