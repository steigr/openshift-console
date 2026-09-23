import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

configure({ testIdAttribute: 'data-test' });

// jsdom does not expose TextDecoder/TextEncoder, which the browser always has.
// The log stream decodes response chunks with one, and journald's byte-array
// MESSAGE form is decoded with one too.
import { TextDecoder, TextEncoder } from 'node:util';

Object.assign(globalThis, {
  TextDecoder: globalThis.TextDecoder ?? TextDecoder,
  TextEncoder: globalThis.TextEncoder ?? TextEncoder,
});
