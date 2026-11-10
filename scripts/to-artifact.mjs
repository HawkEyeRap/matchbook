// Converts dist-single/index.html into a fragment for claude.ai Artifact hosting
// (the host supplies <!doctype>, <html>, <head>, <body>).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const html = readFileSync('dist-single/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const keep = (re) => (head.match(re) || []).join('\n');
const out = [
  keep(/<title>[\s\S]*?<\/title>/g),
  '<meta name="claude:viewport-fit-sides" content="cover">',
  keep(/<link[^>]+fonts\.(googleapis|gstatic)[^>]*>/g),
  keep(/<style[\s\S]*?<\/style>/g),
  body.trim(),
  keep(/<script[\s\S]*?<\/script>/g),
].join('\n');
mkdirSync('artifact', { recursive: true });
writeFileSync('artifact/matchbook.html', out);
console.log('artifact/matchbook.html', (out.length / 1024).toFixed(0), 'KB');
