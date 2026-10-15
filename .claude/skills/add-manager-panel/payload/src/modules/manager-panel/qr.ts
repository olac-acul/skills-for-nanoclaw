/**
 * A QR code as rows of '0' and '1', for the browser to draw on a canvas: no image, no markup, nothing to inject.
 * The only place that uses the `qrcode` library.
 */
import QRCode from 'qrcode';

export interface QrMatrix {
  size: number;
  rows: string[];
}

export function qrMatrix(text: string): QrMatrix {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) row += data[y * size + x] ? '1' : '0';
    rows.push(row);
  }
  return { size, rows };
}
