import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Passphrase-encrypted container for backups and merge files.
 *
 * Layout: "MCQTGEN1" | uint32 header length (BE) | header JSON | ciphertext | 16-byte GCM tag
 * The header (kind, dates, counts, KDF parameters, IV) is authenticated as GCM additional data,
 * so it can be shown before decrypting but any tampering is detected on decrypt.
 * Key derivation: scrypt (N=2^17, r=8, p=1) to a 256-bit AES-GCM key.
 */

const MAGIC = Buffer.from('MCQTGEN1', 'ascii');
const KDF = { N: 2 ** 17, r: 8, p: 1, keyLength: 32 };
const MIN_PASSPHRASE = 8;

export interface ContainerHeader {
  format: 1;
  kind: 'backup' | 'merge';
  createdAt: string;
  appVersion: string;
  workspaceId: string;
  counts: Record<string, number>;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('The passphrase is wrong, or the file was changed or damaged.');
    this.name = 'WrongPassphraseError';
  }
}

function scrypt(
  passphrase: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  };
  return new Promise((resolve, reject) =>
    scryptCb(passphrase.normalize('NFC'), salt, KDF.keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

export function checkPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  }
}

export async function encryptContainer(
  payload: Uint8Array,
  passphrase: string,
  meta: Omit<ContainerHeader, 'format' | 'kdf' | 'iv'>,
  kdf: { N: number; r: number; p: number } = KDF,
): Promise<Buffer> {
  checkPassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, kdf);
  const header: ContainerHeader = {
    format: 1,
    ...meta,
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(headerBytes);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  key.fill(0);
  return Buffer.concat([MAGIC, length, headerBytes, ciphertext, cipher.getAuthTag()]);
}

export function readHeader(file: Uint8Array): {
  header: ContainerHeader;
  headerBytes: Buffer;
  body: Buffer;
} {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buf.length < MAGIC.length + 4 + 16 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('This is not an MCQ Shuffler backup or merge file.');
  }
  const length = buf.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  if (length > 64 * 1024 || start + length + 16 > buf.length)
    throw new Error('The file is damaged.');
  const headerBytes = buf.subarray(start, start + length);
  let header: ContainerHeader;
  try {
    header = JSON.parse(headerBytes.toString('utf8')) as ContainerHeader;
  } catch {
    throw new Error('The file is damaged.');
  }
  if (header.format !== 1 || header.kdf?.name !== 'scrypt')
    throw new Error('This file was made by a newer version of the app.');
  if (header.kdf.N > 2 ** 20 || header.kdf.r > 16 || header.kdf.p > 4)
    throw new Error('The file has unsafe settings.');
  return { header, headerBytes, body: buf.subarray(start + length) };
}

export async function decryptContainer(
  file: Uint8Array,
  passphrase: string,
): Promise<{ header: ContainerHeader; payload: Buffer }> {
  const { header, headerBytes, body } = readHeader(file);
  const key = await scrypt(passphrase, Buffer.from(header.kdf.salt, 'base64'), header.kdf);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(body.subarray(body.length - 16));
    const payload = Buffer.concat([
      decipher.update(body.subarray(0, body.length - 16)),
      decipher.final(),
    ]);
    return { header, payload };
  } catch {
    throw new WrongPassphraseError();
  } finally {
    key.fill(0);
  }
}
