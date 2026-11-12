const SCREENSHOT_MAX_BYTES = 25 * 1024 * 1024, SCREENSHOT_MAX_PIXELS = 25_000_000;

export type AcquisitionImageMime = 'image/png' | 'image/jpeg';
export interface CheckedAcquisitionImage { mimeType: AcquisitionImageMime; width: number; height: number }
const reject = (): never => { throw new Error('MATERIALS_IMAGE_REJECTED'); };
/** Header admission precedes all native decoding. The decoder still verifies the complete raster. */
export function checkAcquisitionImage(input: Uint8Array, declared?: AcquisitionImageMime): CheckedAcquisitionImage {
  if (!(input instanceof Uint8Array) || input.byteLength < 20 || input.byteLength > SCREENSHOT_MAX_BYTES) reject();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let mimeType: AcquisitionImageMime, width = 0, height = 0;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') reject();
    mimeType = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = 'image/jpeg'; let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) reject();
      while (bytes[offset] === 0xff) offset++;
      const nextMarker = bytes[offset++]; if (nextMarker === undefined || nextMarker === 0x00) return reject();
      const marker: number = nextMarker;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) reject(); const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) reject();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) reject(); height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else return reject();
  if (declared && declared !== mimeType || !width || !height || width > 10000 || height > 10000 || width * height > SCREENSHOT_MAX_PIXELS) reject();
  return { mimeType, width, height };
}

export function decodeAcquisitionImage(image: { mimeType: AcquisitionImageMime; base64: string }): Uint8Array {
  if (typeof image.base64 !== 'string' || image.base64.length > Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4
    || image.base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.base64)) reject();
  const bytes = Buffer.from(image.base64, 'base64'); if (bytes.toString('base64') !== image.base64) reject();
  checkAcquisitionImage(bytes, image.mimeType); return bytes;
}

export function isAcquisitionVerificationPage(url: string | null, title: string | null, text = ''): boolean {
  let pathname = ''; try { pathname = url ? new URL(url).pathname : ''; } catch { return true; }
  return /(?:^|\/)(?:captcha|verify|verification|security-check|login|signin|passport)(?:[/.\-_]|$)|\/wapi\/zppassport\//iu.test(pathname)
    || /安全验证|人机验证|访问验证|请先登录|账号登录|帐号登录|扫码登录|验证码登录/u.test(title ?? '')
    || /请完成(?:安全|人机)?验证|拖动滑块|滑动(?:滑块|验证)|请(?:输入|填写)(?:短信)?验证码|请先登录后(?:查看|继续)|扫码登录|账号密码登录|帐号密码登录/u.test(text);
}
