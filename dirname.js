// import.meta.dirname 要到 Node 20.11 才有，而移动版内嵌的 nodejs-mobile 内核停在 Node 18
// （见 mobile/README）：统一从 import.meta.url 推目录，桌面端行为不变。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const moduleDir = (meta) => path.dirname(fileURLToPath(meta));
