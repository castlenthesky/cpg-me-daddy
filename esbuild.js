const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

async function main() {
	const ctx = await esbuild.context({
		entryPoints: ['src/webview/graphApp.ts'],
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		outfile: 'out/webview/graph.js',
		minify: production,
		sourcemap: !production,
		logLevel: 'info',
	});

	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
