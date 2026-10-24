/**
 * The panel's one way to replace a file: write a fresh, exclusively created temp file next to it
 * (nothing already there, a leftover or a planted link, is reused or followed), sync it, rename it
 * over the target. The temp file never outlives a failure, since it may hold secrets.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export function writeFileAtomic(file: string, content: string | Buffer, mode: number): void {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    );
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
