import { TextDecoder, TextEncoder } from 'util';
import { configure } from '@testing-library/dom';

// jsdom exposes neither the text encoding globals the protobuf runtime needs
// nor the ones this plugin's own byte handling uses.
Object.assign(globalThis, { TextDecoder, TextEncoder });

// Console's own convention for test hooks, so queries match the markup.
configure({ testIdAttribute: 'data-test' });

// jsdom's Blob has no arrayBuffer(); every browser that can run this plugin
// does, and the upload path slices a File into chunks with it.
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
