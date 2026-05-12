import pkg from '@napi-rs/canvas';
const { createCanvas, Canvas, Image: NapiImage } = pkg;

// Map DOM-named globals to napi-rs classes — same setup as render.js.
globalThis.HTMLCanvasElement = Canvas;
globalThis.CanvasRenderingContext2D = pkg.CanvasRenderingContext2D;

const c = createCanvas(100, 100);
const ctx = c.getContext('2d');

console.log('createCanvas() returned constructor:', c.constructor.name);
console.log('  c instanceof Canvas:                ', c instanceof Canvas);
console.log('  c instanceof HTMLCanvasElement:     ', c instanceof globalThis.HTMLCanvasElement);
console.log('ctx constructor:                     ', ctx.constructor.name);
console.log('  ctx instanceof CanvasRenderingCtx2D:', ctx instanceof globalThis.CanvasRenderingContext2D);
console.log('ctx.canvas is c?                     ', ctx.canvas === c);
console.log('Canvas === pkg.Canvas?               ', Canvas === pkg.Canvas);
console.log('keys of pkg:                          ', Object.keys(pkg).join(', '));
