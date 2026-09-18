import { createReader } from './reader.js';
import type { Reader } from './types.js';

export { createReader } from './reader.js';
export { SpreadsheetError } from './errors.js';
export type * from './types.js';

const defaultReader = createReader();
export const read: Reader['read'] = defaultReader.read;
export const openFile: Reader['openFile'] = defaultReader.openFile;
export const openBuffer: Reader['openBuffer'] = defaultReader.openBuffer;
export const openStream: Reader['openStream'] = defaultReader.openStream;
