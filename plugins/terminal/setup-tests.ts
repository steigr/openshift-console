import { TextDecoder, TextEncoder } from 'util';
import { configure } from '@testing-library/dom';

// jsdom does not expose the text encoding globals that browsers (and this
// plugin's error-channel decoding) rely on.
Object.assign(globalThis, { TextDecoder, TextEncoder });

// Console's own convention for test hooks, so queries match the markup.
configure({ testIdAttribute: 'data-test' });
