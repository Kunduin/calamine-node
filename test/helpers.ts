import { resolve } from 'node:path';

export const fixture = (name = 'cells.xlsx'): string => resolve('test', 'fixtures', name);
