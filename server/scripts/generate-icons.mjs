import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background: dark OLED
  ctx.fillStyle = '#0a0a0a';
  ctx.roundRect(0, 0, size, size, size * 0.15);
  ctx.fill();

  // Border: subtle green
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = size * 0.04;
  ctx.roundRect(size*0.04, size*0.04, size*0.92, size*0.92, size * 0.12);
  ctx.stroke();

  // Medical cross in green
  const crossW = size * 0.18;
  const crossH = size * 0.52;
  const cx = size / 2;
  const cy = size / 2;

  ctx.fillStyle = '#10b981';
  // Vertical bar
  ctx.fillRect(cx - crossW/2, cy - crossH/2, crossW, crossH);
  // Horizontal bar
  ctx.fillRect(cx - crossH/2, cy - crossW/2, crossH, crossW);

  return canvas.toBuffer('image/png');
}

mkdirSync('icons', { recursive: true });

const sizes = [16, 32, 48, 128];
for (const size of sizes) {
  const buf = generateIcon(size);
  writeFileSync(`icons/icon${size}.png`, buf);
  console.log(`Generated icon${size}.png (${buf.length} bytes)`);
}
