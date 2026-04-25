import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const PANEL_HTML_PATH = path.join(__dirname, '..', 'src', 'web-map', 'public', 'panel.html');
const PACKAGE_CDN_PREFIXES = ['https://unpkg.com/', 'https://cdn.jsdelivr.net/npm/'];

interface PackageCdnAsset {
  tag: string;
  url: string;
}

function getAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*(['"])(.*?)\\1`, 'i').exec(tag);
  return match?.[2];
}

function isPackageCdnUrl(url: string): boolean {
  return PACKAGE_CDN_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function isStylesheetLink(tag: string): boolean {
  const rel = getAttribute(tag, 'rel') ?? '';
  return /\bstylesheet\b/i.test(rel);
}

function extractPackageCdnAssets(html: string): PackageCdnAsset[] {
  const tags =
    html.match(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*><\/script>|<link\b[^>]*\bhref=["'][^"']+["'][^>]*>/gi) ?? [];
  const assets: PackageCdnAsset[] = [];

  for (const tag of tags) {
    const isScript = /^<script\b/i.test(tag);
    if (!isScript && !isStylesheetLink(tag)) {
      continue;
    }

    const url = getAttribute(tag, isScript ? 'src' : 'href');
    if (url && isPackageCdnUrl(url)) {
      assets.push({ tag, url });
    }
  }

  return assets;
}

function packageVersionFromUrl(url: string): string | undefined {
  const parsed = new URL(url);
  const packagePath =
    parsed.hostname === 'cdn.jsdelivr.net'
      ? parsed.pathname.replace(/^\/npm\//, '')
      : parsed.pathname.replace(/^\//, '');
  const match = /^(@[^/]+\/[^@/]+|[^@/]+)@([^/]+)/.exec(packagePath);
  return match?.[2];
}

describe('web map package CDN SRI', () => {
  const html = fs.readFileSync(PANEL_HTML_PATH, 'utf8');
  const assets = extractPackageCdnAssets(html);

  it('covers every unpkg/jsdelivr package script or stylesheet', () => {
    assert.ok(assets.length > 0, 'expected package CDN assets in panel.html');

    for (const asset of assets) {
      const integrity = getAttribute(asset.tag, 'integrity');
      assert.match(integrity ?? '', /^sha384-[A-Za-z0-9+/=]+$/, `${asset.url} must have sha384 SRI`);

      const crossorigin = getAttribute(asset.tag, 'crossorigin');
      assert.equal(crossorigin, 'anonymous', `${asset.url} must use anonymous CORS for SRI`);
    }
  });

  it('uses exact package versions instead of floating major tags', () => {
    for (const asset of assets) {
      assert.doesNotMatch(asset.url, /@\d+(?=[/?#]|$)/, `${asset.url} must not use a floating major version`);

      const version = packageVersionFromUrl(asset.url);
      assert.match(version ?? '', /^\d+\.\d+\.\d+(?:[-+][^/]+)?$/, `${asset.url} must include an exact version`);
    }
  });

  it('leaves local assets and Google Fonts outside the package-CDN policy', () => {
    assert.match(html, /https:\/\/fonts\.googleapis\.com/, 'Google Fonts remains a PR5 non-goal');
    assert.equal(
      assets.some((asset) => asset.url.includes('fonts.googleapis.com')),
      false,
    );
    assert.equal(
      assets.some((asset) => asset.url.startsWith('/js/')),
      false,
    );
    assert.equal(
      assets.some((asset) => asset.url === 'tailwind.css' || asset.url === 'panel.css'),
      false,
    );
  });
});
