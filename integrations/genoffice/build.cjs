// GenOffice editor main code is bundled from the pinned source. Renderers and
// native engines come from the matching, checksum-verified upstream release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const esbuild = require('../../node_modules/esbuild');
const root = __dirname;
const upstream = path.join(root, 'upstream');
const cache = path.join(root, 'cache');
const desktop = path.resolve(root, '../../clients/desktop');
const resources = path.join(desktop, 'resources/genoffice');
const version = '0.11.0';
const revision = '21111196b40a01e70760602729fbac16f1b86008';
const digest = '8982828d87c515ee18cdf7b3c5a86109bc0c97e16f9019288191929e1c4e416c';

async function build() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('This GenOffice resource pack currently targets Linux x64.');
  }
  if (!fs.existsSync(path.join(upstream, 'package.json'))) {
    execFileSync('git', ['submodule', 'update', '--init', '--', 'integrations/genoffice/upstream'],
      { cwd: path.resolve(root, '../..'), stdio: 'inherit' });
  }
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
  if (actual !== revision) throw new Error('GenOffice source must match the pinned v0.11.0 release.');
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(path.join(upstream, 'node_modules/@genoffice/docx-engine'))) {
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: upstream, stdio: 'inherit' });
  }
  const image = path.join(cache, `GenOffice-${version}.AppImage`);
  if (!fs.existsSync(image)) {
    const response = await fetch(`https://github.com/genspark-ai/genoffice/releases/download/v${version}/GenOffice-${version}.AppImage`);
    if (!response.ok || !response.body) throw new Error(`GenOffice download failed: ${response.status}`);
    const temporary = image + '.partial';
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
    fs.renameSync(temporary, image);
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(image)) hash.update(chunk);
  if (hash.digest('hex') !== digest) throw new Error('GenOffice release checksum does not match.');
  const unpacked = path.join(cache, 'squashfs-root');
  if (!fs.existsSync(path.join(unpacked, 'resources/modules/docs'))) {
    fs.chmodSync(image, 0o755);
    execFileSync(image, ['--appimage-extract'], { cwd: cache, stdio: 'ignore' });
  }
  fs.mkdirSync(resources, { recursive: true });
  const released = path.join(unpacked, 'resources');
  for (const name of ['modules', 'native', 'wasm', 'ocr', 'cli', 'THIRD-PARTY-NOTICES.txt']) {
    const source = path.join(released, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(resources, name), { recursive: true });
  }
  // jsdom is intentionally external: its lazy XHR worker resolves a real file.
  fs.cpSync(path.join(released, 'cli/node_modules'), path.join(resources, 'node_modules'), { recursive: true });
  for (const name of ['LICENSE', 'NOTICE', 'LICENSE-UNICODE.txt']) {
    fs.copyFileSync(path.join(upstream, name), path.join(resources, name));
  }
  await esbuild.build({
    entryPoints: [path.join(root, 'host.ts')],
    outfile: path.join(resources, 'genoffice-host.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    define: { 'import.meta.url': 'GENOFFICE_IMPORT_URL' },
    banner: { js: 'const GENOFFICE_IMPORT_URL = require("node:url").pathToFileURL(__filename).href;' },
    external: ['electron', 'node:sqlite', 'jsdom', '*.node'],
    loader: { '.png': 'file', '.jpg': 'file', '.woff2': 'file' },
    plugins: [{ name: 'uao-local-gateway', setup(builder) {
      const bridge = JSON.stringify(path.join(root, 'local-gateway.ts'));
      builder.onLoad({ filter: /packages\/ai-provider\/src\/(stream|chat|custom-models)\.ts$/ }, args => {
        let source = fs.readFileSync(args.path, 'utf8');
        const name = path.basename(args.path);
        let needle, insert;
        if (name === 'stream.ts') {
          needle = '  const endpoint = getProviderAdapter(provider).resolveEndpoint(config)';
          insert = '  if (isGatewayConfig(provider, config)) return streamGateway(config, system, messages, tools, cb)\n';
        } else if (name === 'chat.ts') {
          needle = '  // non-streaming: the server generates';
          insert = '  if (isGatewayConfig(provider, config)) return chatGateway(config, system, user, signal)\n';
        } else {
          needle = "  const base = baseUrl.trim().replace(/\\/+$/, '')";
          insert = '  if (apiKey === GATEWAY_MARKER) return gatewayModels()\n';
        }
        if (!source.includes(needle)) throw new Error(`GenOffice gateway integration anchor missing: ${name}`);
        source = `import { isGatewayConfig, streamGateway, chatGateway, GATEWAY_MARKER, gatewayModels } from ${bridge};\n` + source.replace(needle, insert + needle);
        return { contents: source, loader: 'ts', resolveDir: path.dirname(args.path) };
      });
    } }, { name: 'genoffice-assets', setup(builder) {
      builder.onResolve({ filter: /\?(raw|asset)$/ }, async args => {
        const [specifier, kind] = args.path.split('?');
        const resolved = await builder.resolve(specifier, { resolveDir: args.resolveDir, kind: args.kind });
        if (resolved.errors.length) return { errors: resolved.errors };
        return { path: resolved.path, namespace: `genoffice-${kind}` };
      });
      builder.onLoad({ filter: /.*/, namespace: 'genoffice-raw' }, args =>
        ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }));
      builder.onLoad({ filter: /.*/, namespace: 'genoffice-asset' }, args => {
        const name = crypto.createHash('sha256').update(fs.readFileSync(args.path)).digest('hex').slice(0, 16) + path.extname(args.path);
        fs.mkdirSync(path.join(resources, 'assets'), { recursive: true });
        fs.copyFileSync(args.path, path.join(resources, 'assets', name));
        return { contents: `module.exports = require('node:path').join(__dirname, 'assets', ${JSON.stringify(name)});`, loader: 'js' };
      });
    } }, { name: 'uao-office-viewport', setup(builder) {
      builder.onLoad({ filter: /apps\/shell\/src\/main\/tab-manager\.ts$/ }, args => {
        let source = fs.readFileSync(args.path, 'utf8');
        source = source.replace('  private activeId: string = HOME_ID', `  private activeId: string = HOME_ID
  private uaoViewport: Rectangle | null | undefined = undefined
  setViewport(bounds: Rectangle | null): void {
    this.uaoViewport = bounds
    for (const tab of this.tabs) tab.view?.setVisible(bounds !== null && tab.id === this.activeId)
    this.layout()
  }`);
        source = source.replace('  private contentBounds(): Rectangle {', `  private contentBounds(): Rectangle {
    if (this.uaoViewport !== undefined) return this.uaoViewport ?? { x: 0, y: 0, width: 0, height: 0 }`);
        source = source.replace('t.view?.setVisible(t.id === id)', 't.view?.setVisible(this.uaoViewport !== null && t.id === id)');
        source = source.replace('  focusActiveView(): void {', '  focusActiveView(): void {\n    if (this.uaoViewport === null) return');
        return { contents: source, loader: 'ts', resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  fs.writeFileSync(path.join(resources, 'integration.json'), JSON.stringify({ version, revision, sha256: digest }));
  console.log(`[uao] GenOffice ${version} editors and native engines staged`);
}
build().catch(error => { console.error(error); process.exitCode = 1; });
